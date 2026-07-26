/**
 * Hourglass yield agent — self-contained runner (no repo imports).
 *
 * A yield plan is three single-use delegations the Safe signed in one sitting:
 * [approve token0, approve token1, mint]. Each pins its exact execution
 * (`exactExecution`), so the agent decides nothing about target, amount or recipient —
 * it only resubmits what was already approved, in the one order that works.
 *
 * Unlike the limit order there is no price to watch and no trigger: discovery, then
 * three redemptions, then done. What it does have is state to respect. Each step is
 * capped by `limitedCalls(1)`, so replaying a landed step reverts — which is the
 * guarantee, but reads as breakage. The runner reads each step's on-chain state first
 * and skips what is already consumed, so a resumed run finishes a half-done plan
 * instead of concluding it is broken.
 *
 * Env: AGENT_PRIVATE_KEY, INTUITION_NETWORK (mainnet|testnet), optional RPC_URL.
 * Usage: bun run-yield.ts <instruction.json>
 *
 * Dependency: viem, @metamask/smart-accounts-kit. Node >= 20 (global fetch).
 */
import { readFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, isAddress, parseAbi,
  getAddress, hexToBigInt, sliceHex, keccak256, encodePacked, encodeAbiParameters, toHex,
  type Address, type Hex, type Chain, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, base, baseSepolia, sepolia } from 'viem/chains'
import { createExecution, ExecutionMode, redeemDelegations, type Delegation } from '@metamask/smart-accounts-kit'

type Redemption = { permissionContext: Delegation[]; executions: ReturnType<typeof createExecution>[]; mode: ExecutionMode }

// --- constants (verified against the Hourglass repo) --------------------------

const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

// Match both: mandates signed before ExactExecutionEnforcer was routed through the
// HourGlass block carry the canonical SDK address, and they must stay redeemable.
const CANONICAL_EXACT_EXECUTION: Address = '0x146713078D39eCC1F5338309c28405ccf85Abfbb'
const HOURGLASS_EXACT_EXECUTION: Address = '0xb0deD8b9f02f8D100078F1AA75Ab9FCDB0D5e729'
const HOURGLASS_LIMITED_CALLS: Address = '0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8'

const CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [sepolia.id]: sepolia,
}

interface ReadConfig { graphqlUrl: string; delegateTo: Hex; inContextOf: Hex }
const INTUITION: Record<'mainnet' | 'testnet', ReadConfig> = {
  testnet: {
    graphqlUrl: 'https://testnet.intuition.sh/v1/graphql',
    delegateTo: '0xb56980d42a3b03455bf41ea20fe04ae223fca0b9e688994dc661414e81e6433b',
    inContextOf: '0x61a88b9c372c0d164d2caf66947b67ed0fcb4c457178a271b6b3dc39fb1f8862',
  },
  mainnet: {
    graphqlUrl: 'https://mainnet.intuition.sh/v1/graphql',
    delegateTo: '0xc587d8f586380d2252d01784a3b6b889a50f960af80cc0d8acb4dbd3e2c2c1f5',
    inContextOf: '0x892054b01d389bfe566166120470f572a56e3d4cd88c599b52c4708949625390',
  },
}

const APPROVE_SELECTOR = '0x095ea7b3'
const MINT_SELECTOR = '0x88316456'

// --- types --------------------------------------------------------------------

interface Caveat { enforcer: Address; terms: Hex }
interface DelegationStruct {
  delegate: Address; delegator: Address; authority: Hex
  caveats: Caveat[]; salt: Hex; signature: Hex
}
interface DelegationDocument { name?: string; description?: string; delegation: DelegationStruct }

/** The operator's instruction from the Yield tab. */
interface Instruction {
  hourglassStrategy: 'yield'
  chainId: number
  safe: Address
  agent: Address
}

interface Step {
  delegation: DelegationStruct
  delegationHash: Hex
  target: Address
  value: bigint
  callData: Hex
  selector: Hex
}

// --- delegation hash (must match the repo exactly) ----------------------------

const DELEGATION_TYPEHASH = keccak256(
  toHex('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'),
)
const CAVEAT_TYPEHASH = keccak256(toHex('Caveat(address enforcer,bytes terms)'))

function computeDelegationHash(d: DelegationStruct): Hex {
  const caveatHashes = d.caveats.map((c) =>
    keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)],
    )),
  )
  const caveatsHash = keccak256(encodePacked(caveatHashes.map(() => 'bytes32'), caveatHashes))
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, caveatsHash, BigInt(d.salt)],
  ))
}

// --- Intuition discovery (inlined) --------------------------------------------

const ATOM_BY_DATA = `query($data: String!) { atoms(where: { data: { _eq: $data } }) { term_id } }`
const RELATIONSHIPS = `query($objectIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $objectIds } }) {
    term_id subject { data }
  }
}`
const CONTEXT = `query($relIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $relIds } }) {
    object_id subject { data value { thing { name description } } }
  }
}`

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw new Error(`Intuition GraphQL ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  if (!body.data) throw new Error('Intuition GraphQL: empty response')
  return body.data
}

const caip10Uri = (chainId: number, address: Address) => `caip10:eip155:${chainId}:${getAddress(address)}`
const ipfsToHttp = (uri: string) => uri.startsWith('ipfs://') ? 'https://gateway.pinata.cloud/ipfs/' + uri.slice(7) : uri

/** exactExecution terms: target(20) + value(32) + callData(rest). The calldata IS the mandate. */
function decodeExactExecution(terms: Hex): { target: Address; value: bigint; callData: Hex } {
  return {
    target: getAddress(sliceHex(terms, 0, 20)),
    value: hexToBigInt(sliceHex(terms, 20, 52)),
    callData: sliceHex(terms, 52),
  }
}

function findExactExecution(d: DelegationStruct): Caveat | null {
  const enforcers = [CANONICAL_EXACT_EXECUTION, HOURGLASS_EXACT_EXECUTION].map((a) => a.toLowerCase())
  return d.caveats.find((c) => enforcers.includes(c.enforcer.toLowerCase())) ?? null
}

/** Discover the yield steps addressed to `agent`. */
async function discoverSteps(agent: Address, chainId: number, network: 'mainnet' | 'testnet'): Promise<Step[]> {
  const cfg = INTUITION[network]
  const { atoms } = await gql<{ atoms: { term_id: string }[] }>(cfg.graphqlUrl, ATOM_BY_DATA, { data: caip10Uri(chainId, agent) })
  const recipientAtomIds = atoms.map((a) => a.term_id)
  if (recipientAtomIds.length === 0) return []

  const rels = await gql<{ triples: { term_id: string }[] }>(cfg.graphqlUrl, RELATIONSHIPS, { objectIds: recipientAtomIds, pred: cfg.delegateTo })
  if (rels.triples.length === 0) return []

  const ctx = await gql<{ triples: { subject: { data: string } }[] }>(cfg.graphqlUrl, CONTEXT, { relIds: rels.triples.map((t) => t.term_id), pred: cfg.inContextOf })

  const out: Step[] = []
  for (const t of ctx.triples) {
    const uri = t.subject?.data
    if (!uri || !uri.startsWith('ipfs://')) continue
    try {
      const res = await fetch(ipfsToHttp(uri))
      if (!res.ok) continue
      const doc = (await res.json()) as DelegationDocument
      const delegation = doc?.delegation
      if (!delegation?.delegate) continue
      const pinned = findExactExecution(delegation)
      if (!pinned) continue // not a yield step
      const { target, value, callData } = decodeExactExecution(pinned.terms)
      out.push({
        delegation,
        delegationHash: computeDelegationHash(delegation),
        target, value, callData,
        selector: sliceHex(callData, 0, 4),
      })
    } catch { /* skip unreadable */ }
  }
  return out
}

/**
 * Order the steps the only way that can succeed: both approvals, then the mint. The
 * selector in each pinned calldata says which is which — nothing is inferred from the
 * order they came back in, which the graph does not guarantee.
 */
function orderSteps(steps: Step[]): Step[] {
  const approves = steps.filter((s) => s.selector.toLowerCase() === APPROVE_SELECTOR)
  const mints = steps.filter((s) => s.selector.toLowerCase() === MINT_SELECTOR)
  const others = steps.filter((s) => ![APPROVE_SELECTOR, MINT_SELECTOR].includes(s.selector.toLowerCase()))
  if (others.length > 0) throw new Error(`Unexpected step selector(s): ${others.map((s) => s.selector).join(', ')}`)
  if (mints.length !== 1) throw new Error(`Expected exactly one mint step, found ${mints.length}`)
  if (approves.length !== 2) throw new Error(`Expected exactly two approve steps, found ${approves.length}`)
  return [...approves, ...mints]
}

// --- on-chain state -----------------------------------------------------------

const LIMITED_CALLS_ABI = parseAbi(['function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)'])
const MANAGER_ABI = parseAbi(['function disabledDelegations(bytes32 delegationHash) view returns (bool)'])

type StepState = 'ready' | 'consumed' | 'revoked'

/**
 * Ask before submitting. A consumed step reverts on replay — that is the cap doing its
 * job — but a bare revert reads as breakage, and an agent that retries a step it
 * already landed would abandon a plan that in fact succeeded.
 */
async function readStepState(client: PublicClient, delegationHash: Hex): Promise<StepState> {
  const disabled = await client.readContract({ address: DELEGATION_MANAGER, abi: MANAGER_ABI, functionName: 'disabledDelegations', args: [delegationHash] })
  if (disabled) return 'revoked'
  const count = await client.readContract({ address: HOURGLASS_LIMITED_CALLS, abi: LIMITED_CALLS_ABI, functionName: 'callCounts', args: [DELEGATION_MANAGER, delegationHash] })
  return count > 0n ? 'consumed' : 'ready'
}

// --- execute ------------------------------------------------------------------

function toSdkDelegation(d: DelegationStruct): Delegation {
  return {
    delegate: d.delegate, delegator: d.delegator, authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' as Hex })),
    salt: d.salt, signature: d.signature,
  }
}

function redeemStep(walletClient: WalletClient, publicClient: PublicClient, step: Step): Promise<Hex> {
  const redemptions: Redemption[] = [{
    permissionContext: [toSdkDelegation(step.delegation)],
    executions: [createExecution({ target: step.target, value: step.value, callData: step.callData })],
    mode: ExecutionMode.SingleDefault,
  }]
  return redeemDelegations(walletClient, publicClient, DELEGATION_MANAGER, redemptions)
}

// --- main ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is not set`); process.exit(1) }
  return v
}

const LABELS = ['approve', 'approve', 'mint'] as const

async function main() {
  const [file] = process.argv.slice(2)
  if (!file) { console.error('usage: bun run-yield.ts <instruction.json>'); process.exit(1) }
  const instruction = JSON.parse(readFileSync(file, 'utf8')) as Instruction
  if (instruction.hourglassStrategy !== 'yield') throw new Error(`not a yield instruction: ${instruction.hourglassStrategy}`)
  if (!isAddress(instruction.agent)) throw new Error(`invalid agent: ${instruction.agent}`)

  const chain = CHAINS[instruction.chainId]
  if (!chain) throw new Error(`Unsupported chain: ${instruction.chainId}`)

  const privateKey = requireEnv('AGENT_PRIVATE_KEY') as Hex
  const network = process.env.INTUITION_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== instruction.agent.toLowerCase()) {
    throw new Error(`AGENT_PRIVATE_KEY (${account.address}) does not match the instruction's agent (${instruction.agent})`)
  }

  const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) }) as PublicClient
  const walletClient = createWalletClient({ account, chain, transport: http(process.env.RPC_URL) })

  console.log(`Yield agent ${account.address} on chain ${instruction.chainId} (${network})`)

  const discovered = await discoverSteps(account.address, instruction.chainId, network)
  if (discovered.length === 0) {
    console.log('No yield plan found on Intuition yet — is it signed and published?')
    return
  }
  const steps = orderSteps(discovered)
  console.log(`Plan: ${steps.length} steps for pool deposit`)

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    const label = `[${i + 1}/${steps.length}] ${LABELS[i]} -> ${step.target}`
    const state = await readStepState(publicClient, step.delegationHash)

    if (state === 'revoked') {
      console.log(`${label}: revoked by the Safe — stopping.`)
      return
    }
    if (state === 'consumed') {
      console.log(`${label}: already done, skipping.`)
      continue
    }

    console.log(label)
    try {
      const hash = await redeemStep(walletClient, publicClient, step)
      console.log('  redeemed:', hash)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      console.log('  status:', receipt.status, 'block', receipt.blockNumber)
      // Stop rather than mint against a half-approved position.
      if (receipt.status !== 'success') { console.error('  reverted — stopping, later steps not sent.'); return }
    } catch (err) {
      console.error('  failed:', err instanceof Error ? err.message : err)
      return
    }
  }

  console.log('\nDone — position minted, held by the Safe.')
}

main().catch((err) => { console.error(err); process.exit(1) })
