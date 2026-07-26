import { createPublicClient, createWalletClient, http, isHex, isAddress, getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildDelegationDocument,
  createGraphqlPinner,
  createViemChain,
  getIntuitionNetwork,
  publishDelegation,
  type IntuitionNetwork,
  type OrganizationInput,
} from '../src/lib/intuition'
import {
  delegationFromMessage,
  detailsFromDelegation,
  tokenFromDelegation,
  typedDataHashFromMessage,
} from '../src/lib/intuition/from-message'
import { getSafeMessage } from '../src/lib/safe-messages'
import { readErc20Meta } from '../src/lib/erc20'
import { sanitizeTokenMeta } from '../src/lib/token-meta'
import { findChain, rpcUrl } from '../src/config/supported-chains'
import { isOriginAllowed, parseAllowedOrigins } from './cors'

/**
 * Intuition publisher: a node-side service that holds the funded attestor key and
 * records a signed OurGlass delegation on the Intuition graph.
 *
 * It accepts REFERENCES ONLY ({chainId, safeAddress, messageHash, organization?}),
 * never a delegation payload: it fetches the finalized Safe message from the Safe
 * Transaction Service itself, verifies the aggregated signature ON-CHAIN via
 * EIP-1271 against the Safe (the trust gate — a spoofed tx-service cannot make it
 * index a never-signed delegation), reconstructs the signed struct, then pins the
 * document and writes the ontology. A compromised publisher can thus forge
 * nothing; it holds only a gas key. See ADR 0005.
 *
 * Env: INTUITION_ATTESTOR_PK (required), PINATA_JWT (required),
 * INTUITION_PIN_API_KEY (required — pins atom metadata via the Intuition pin
 * API), INTUITION_NETWORK (testnet|mainnet, default testnet), PORT (default
 * 8787), ALLOWED_ORIGIN (default *), PUBLISH_SECRET (optional — if set, require
 * x-publish-secret).
 */

/** EIP-1271 magic value returned by `isValidSignature(bytes32,bytes)` on success. */
const EIP1271_MAGIC = '0x1626ba7e'
const SAFE_IS_VALID_SIGNATURE_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const

const pk = process.env.INTUITION_ATTESTOR_PK
const pinataJwt = process.env.PINATA_JWT
const pinApiKey = process.env.INTUITION_PIN_API_KEY
const network = (process.env.INTUITION_NETWORK ?? 'testnet') as IntuitionNetwork
// Own port var — platforms (Coolify, etc.) inject PORT for the main listener
// (Caddy on :80 here); the publisher is internal, proxied at /intuition.
const port = Number(process.env.INTUITION_PUBLISHER_PORT ?? '8787')
const publishSecret = process.env.PUBLISH_SECRET

// The matched request origin is echoed back (never a bare `*`), so PR preview
// subdomains are accepted without per-PR config. See server/cors.ts.
const allowedOriginPatterns = parseAllowedOrigins(process.env.ALLOWED_ORIGIN)

const config = getIntuitionNetwork(network)

// Start regardless of config so /health always answers and reports what's missing
// (a misconfigured deploy must be diagnosable, not a dead process behind a 502).
const missing: string[] = []
if (!pk || !isHex(pk)) missing.push('INTUITION_ATTESTOR_PK')
if (!pinataJwt) missing.push('PINATA_JWT')
if (!pinApiKey) missing.push('INTUITION_PIN_API_KEY')

interface Runtime {
  account: ReturnType<typeof privateKeyToAccount>
  chain: ReturnType<typeof createViemChain>
  pinner: ReturnType<typeof createGraphqlPinner>
  pinataJwt: string
}

function buildRuntime(): Runtime | null {
  if (!pk || !isHex(pk) || !pinataJwt || !pinApiKey) return null
  const account = privateKeyToAccount(pk)
  const transport = http(config.rpcUrl)
  const chain = createViemChain(
    createPublicClient({ chain: config.chain, transport }),
    createWalletClient({ account, chain: config.chain, transport }),
    config.multiVault,
  )
  return { account, chain, pinner: createGraphqlPinner(pinApiKey), pinataJwt }
}

const runtime = buildRuntime()

interface PublishBody {
  chainId: number
  safeAddress: Address
  messageHash: Hex
  organization?: OrganizationInput
}

function parseOrganization(raw: unknown): OrganizationInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.atomId === 'string' && isHex(o.atomId)) return { atomId: o.atomId }
  if (typeof o.name === 'string' && o.name.trim()) {
    return { name: o.name, url: typeof o.url === 'string' ? o.url : undefined }
  }
  return undefined
}

function parseBody(raw: unknown): PublishBody {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be an object')
  const b = raw as Record<string, unknown>
  const chainId = Number(b.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('chainId must be a positive integer')
  if (typeof b.safeAddress !== 'string' || !isAddress(b.safeAddress)) throw new Error('invalid safeAddress')
  if (typeof b.messageHash !== 'string' || !isHex(b.messageHash)) throw new Error('invalid messageHash')
  return {
    chainId,
    safeAddress: getAddress(b.safeAddress),
    messageHash: b.messageHash,
    organization: parseOrganization(b.organization),
  }
}

/** App-chain public clients (Base Sepolia, …) for EIP-1271 + token reads, cached per chain. */
const appClients = new Map<number, PublicClient>()
function appChainClient(chainId: number): PublicClient | null {
  const cached = appClients.get(chainId)
  if (cached) return cached
  const chain = findChain(chainId)
  const url = rpcUrl(chainId)
  if (!chain || !url) return null
  const client = createPublicClient({ chain, transport: http(url) }) as PublicClient
  appClients.set(chainId, client)
  return client
}

/** Verify the Safe signed the message: EIP-1271 `isValidSignature(hash, sig)` == magic. */
async function verifyEip1271(
  client: PublicClient,
  safe: Address,
  messageHash: Hex,
  signature: Hex,
): Promise<boolean> {
  try {
    const res = await client.readContract({
      address: safe,
      abi: SAFE_IS_VALID_SIGNATURE_ABI,
      functionName: 'isValidSignature',
      args: [messageHash, signature],
    })
    return res.toLowerCase() === EIP1271_MAGIC
  } catch {
    return false
  }
}

async function pinToPinata(jwt: string, content: unknown, name: string): Promise<string> {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
  })
  if (!res.ok) throw new Error(`Pinata pin failed (${res.status}): ${await res.text()}`)
  return `ipfs://${((await res.json()) as { IpfsHash: string }).IpfsHash}`
}

// Serialize publishes so concurrent requests don't collide on the attestor nonce.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

async function handlePublish(rt: Runtime, body: PublishBody): Promise<{ uri: string; result: unknown }> {
  const app = appChainClient(body.chainId)
  if (!app) throw new Error(`unsupported chainId: ${body.chainId}`)

  // 1. Fetch the finalized Safe message (public tx-service) and reconstruct the struct.
  const msg = await getSafeMessage(body.chainId, body.messageHash)
  if (!msg) throw new Error('message not found on the Safe Transaction Service')
  if (getAddress(msg.safe) !== body.safeAddress) throw new Error('message safe mismatch')
  const delegation = delegationFromMessage(msg, body.chainId)
  if (!delegation) throw new Error('not a finalized OurGlass delegation for this chain')

  // 2. TRUST GATE: verify the aggregated signature ON-CHAIN against the Safe.
  // Pass the DELEGATION typed-data hash, not the tx-service `messageHash`: the
  // latter is already the wrapped SafeMessage hash, and the Safe's fallback
  // handler wraps `_dataHash` into SafeMessage itself (double-wrapping fails).
  const dataHash = typedDataHashFromMessage(msg)
  if (!dataHash) throw new Error('could not hash the message typed data')
  const ok = await verifyEip1271(app, body.safeAddress, dataHash, delegation.signature)
  if (!ok) throw new Error('EIP-1271 verification failed')

  // 3. Resolve + sanitize token metadata, build display details from the caveat.
  // A yield step pins an exact execution and names no token, so an absent token is not
  // by itself a reason to refuse: only failing to describe the delegation at all is.
  const token = tokenFromDelegation(delegation, body.chainId)
  const meta = token
    ? sanitizeTokenMeta({ address: token, ...(await readErc20Meta(app, token)) })
    : { symbol: '', decimals: 18 }
  const details = detailsFromDelegation(delegation, body.chainId, { symbol: meta.symbol, decimals: meta.decimals })
  if (!details) throw new Error('no known caveat in delegation')

  // 4. Pin the document and write the ontology (isTermCreated guards dedup the mint).
  const doc = buildDelegationDocument({ delegation, details })
  const uri = await pinToPinata(rt.pinataJwt, doc, 'hourglass-delegation')
  const result = await publishDelegation(
    { chain: rt.chain, pinner: rt.pinner, config },
    {
      delegator: { address: delegation.delegator, chainId: body.chainId },
      recipient: { kind: 'caip10', address: delegation.delegate, chainId: body.chainId },
      organization: body.organization,
      agreementUri: uri,
    },
  )
  return { uri, result }
}

function cors(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-publish-secret',
    Vary: 'Origin',
  }
  if (origin && isOriginAllowed(origin, allowedOriginPatterns)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function json(payload: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  })
}

Bun.serve({
  port,
  async fetch(req) {
    const origin = req.headers.get('Origin')
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(
        { ok: true, network, ready: runtime !== null, missing, attestor: runtime?.account.address ?? null },
        200,
        origin,
      )
    }
    if (req.method === 'POST' && url.pathname === '/publish') {
      if (!runtime) {
        return json({ error: 'publisher not configured', missing }, 503, origin)
      }
      if (publishSecret && req.headers.get('x-publish-secret') !== publishSecret) {
        return json({ error: 'unauthorized' }, 401, origin)
      }
      try {
        const body = parseBody(await req.json())
        const out = await enqueue(() => handlePublish(runtime, body))
        return json(out, 200, origin)
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'publish failed' }, 400, origin)
      }
    }
    return json({ error: 'not found' }, 404, origin)
  },
})

console.log(
  runtime
    ? `intuition-publisher on :${port} → ${network} (attestor ${runtime.account.address})`
    : `intuition-publisher on :${port} → ${network} — NOT READY, missing: ${missing.join(', ')}`,
)
