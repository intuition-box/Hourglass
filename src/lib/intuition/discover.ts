import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  hexToBigInt,
  http,
  sliceHex,
  type Address,
  type Hex,
} from 'viem'
import { getAddresses } from '../../config/addresses'
import { findChain, rpcUrl } from '../../config/supported-chains'
import { computeDelegationHash, type DelegationStruct } from '../delegations'
import { ipfsToHttp } from '../subscriptionTerms'
import type { StoredDelegation } from '../storage'
import { resolveIntuitionNetwork, type IntuitionNetwork } from './network'

/**
 * Read side of the Intuition integration for the Safe App: discover delegations
 * made TO an account (the account is the object of a `delegate to` triple),
 * traverse the nested `in context of` triple to the DelegationJson atom, and
 * recover the signed delegation from IPFS as a StoredDelegation. Enabled/revoked
 * is confirmed separately on-chain (see enabled.ts).
 *
 * Self-contained read config (graphql + predicate term_ids) so it doesn't couple
 * to the write-path predicate resolution. term_ids are per network (ADR 0003).
 */

interface ReadConfig {
  graphqlUrl: string
  delegateTo: Hex | null
  inContextOf: Hex | null
}

const READ: Record<IntuitionNetwork, ReadConfig> = {
  testnet: {
    graphqlUrl: 'https://testnet.intuition.sh/v1/graphql',
    delegateTo: '0xb56980d42a3b03455bf41ea20fe04ae223fca0b9e688994dc661414e81e6433b',
    inContextOf: '0x61a88b9c372c0d164d2caf66947b67ed0fcb4c457178a271b6b3dc39fb1f8862',
  },
  mainnet: {
    graphqlUrl: 'https://mainnet.intuition.sh/v1/graphql',
    // The mainnet "delegate to" atom differs from testnet's: the write path pins it
    // (network.ts, termId null) and the resulting atom is this id — verified against
    // the live graph. The testnet id 0xb569… returns zero triples on mainnet, which
    // silently broke read-path discovery of every mainnet mandate.
    delegateTo: '0xc587d8f586380d2252d01784a3b6b889a50f960af80cc0d8acb4dbd3e2c2c1f5',
    inContextOf: '0x892054b01d389bfe566166120470f572a56e3d4cd88c599b52c4708949625390',
  },
}

export function caip10Uri(chainId: number, address: Address): string {
  return `caip10:eip155:${chainId}:${getAddress(address)}`
}

export function chainIdFromCaip10(data: string): number | null {
  const match = /^caip10:eip155:(\d+):/.exec(data)
  return match ? Number(match[1]) : null
}

export interface PeriodTransferTerms {
  token: Address
  periodAmount: bigint
  periodDuration: bigint
  startDate: bigint
}

/** Decode the erc20PeriodTransfer caveat terms: token(20) + 3×uint256. */
export function decodePeriodTransferTerms(terms: Hex): PeriodTransferTerms {
  return {
    token: getAddress(sliceHex(terms, 0, 20)),
    periodAmount: hexToBigInt(sliceHex(terms, 20, 52)),
    periodDuration: hexToBigInt(sliceHex(terms, 52, 84)),
    startDate: hexToBigInt(sliceHex(terms, 84, 116)),
  }
}

export function findPeriodTransferCaveat(
  delegation: DelegationStruct,
  chainId: number,
): { enforcer: Address; terms: Hex } | null {
  const addrs = getAddresses(chainId)
  const enforcers = [addrs.erc20PeriodTransferEnforcer, addrs.hourglass?.erc20PeriodTransferEnforcer]
    .filter((a): a is Address => Boolean(a))
    .map((a) => a.toLowerCase())
  return delegation.caveats.find((c) => enforcers.includes(c.enforcer.toLowerCase())) ?? null
}

export interface StreamingTerms {
  token: Address
  initialAmount: bigint
  maxAmount: bigint
  amountPerSecond: bigint
  startTime: bigint
}

/** Decode the erc20Streaming caveat terms: token(20) + 4×uint256 (148 bytes). */
export function decodeStreamingTerms(terms: Hex): StreamingTerms {
  return {
    token: getAddress(sliceHex(terms, 0, 20)),
    initialAmount: hexToBigInt(sliceHex(terms, 20, 52)),
    maxAmount: hexToBigInt(sliceHex(terms, 52, 84)),
    amountPerSecond: hexToBigInt(sliceHex(terms, 84, 116)),
    startTime: hexToBigInt(sliceHex(terms, 116, 148)),
  }
}

// Canonical ERC20StreamingEnforcer (deterministic across chains) from the SDK.
const CANONICAL_STREAMING_ENFORCER = '0x56c97aE02f233B29fa03502Ecc0457266d9be00e'

export function findStreamingCaveat(
  delegation: DelegationStruct,
  chainId: number,
): { enforcer: Address; terms: Hex } | null {
  const enforcers = [CANONICAL_STREAMING_ENFORCER, getAddresses(chainId).hourglass?.erc20StreamingEnforcer]
    .filter((a): a is Address => Boolean(a))
    .map((a) => a.toLowerCase())
  return delegation.caveats.find((c) => enforcers.includes(c.enforcer.toLowerCase())) ?? null
}

export function periodFromSeconds(seconds: bigint): string {
  switch (seconds) {
    case 60n:
      return 'minute'
    case 3600n:
      return 'hour'
    case 86_400n:
      return 'day'
    case 604_800n:
      return 'week'
    case 2_592_000n:
      return 'month'
    default:
      return `${seconds.toString()}s`
  }
}

interface DelegationDocument {
  name?: string
  description?: string
  delegation: DelegationStruct
}

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Intuition GraphQL ${res.status}`)
  // Network boundary: the GraphQL envelope is { data, errors }; T is the query shape.
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  if (!body.data) throw new Error('Intuition GraphQL: empty response')
  return body.data
}

const ATOM_BY_DATA = `query($data: String!) { atoms(where: { data: { _eq: $data } }) { term_id } }`
const RELATIONSHIPS = `query($objectIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $objectIds } }) {
    term_id
    subject { data }
  }
}`
const CONTEXT = `query($relIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $relIds } }) {
    object_id
    subject { data value { thing { name description } } }
  }
}`

async function tokenDecimals(chainId: number, token: Address): Promise<number> {
  const chain = findChain(chainId)
  if (!chain) return 18
  try {
    const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) })
    return await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
  } catch {
    return 18 // display-only: the redeemed raw amount is periodAmount regardless of decimals
  }
}

const MONTH_SECONDS = 2_592_000n

async function toStoredDelegation(
  doc: DelegationDocument,
  uri: string,
  delegatorData: string,
  recipientChainId: number,
): Promise<StoredDelegation | null> {
  const delegation = doc.delegation
  const chainId = chainIdFromCaip10(delegatorData) ?? recipientChainId
  const common = {
    label: doc.name || doc.description || 'Delegation',
    createdAt: '',
    chainId,
    safeAddress: delegation.delegator,
    moduleAddress: delegation.delegator,
    delegationHash: computeDelegationHash(delegation),
    agreement: { cid: uri.replace('ipfs://', ''), uri, termsHash: delegation.salt },
    recipient: delegation.delegate,
  }

  const sub = findPeriodTransferCaveat(delegation, chainId)
  if (sub) {
    const { token, periodAmount, periodDuration } = decodePeriodTransferTerms(sub.terms)
    const decimals = await tokenDecimals(chainId, token)
    return {
      delegation,
      meta: {
        ...common,
        scopeType: 'erc20SpendingLimit',
        status: 'signed',
        amount: formatUnits(periodAmount, decimals),
        period: periodFromSeconds(periodDuration),
        tokenAddress: token,
      },
    }
  }

  const stream = findStreamingCaveat(delegation, chainId)
  if (stream) {
    const { token, initialAmount, maxAmount, amountPerSecond, startTime } = decodeStreamingTerms(stream.terms)
    const decimals = await tokenDecimals(chainId, token)
    return {
      delegation,
      meta: {
        ...common,
        scopeType: 'erc20Streaming',
        status: 'signed',
        tokenAddress: token,
        amountPerSecond: amountPerSecond.toString(),
        initialAmount: initialAmount.toString(),
        maxAmount: maxAmount.toString(),
        startTime: Number(startTime),
        ratePerPeriod: formatUnits(amountPerSecond * MONTH_SECONDS, decimals),
        ratePeriod: 'month',
      },
    }
  }

  return null
}

export async function discoverIncomingDelegations(
  recipient: Address,
  recipientChainId: number,
): Promise<StoredDelegation[]> {
  const cfg = READ[resolveIntuitionNetwork()]
  if (!cfg.delegateTo || !cfg.inContextOf) return [] // predicates not yet on this graph

  const recipientData = caip10Uri(recipientChainId, recipient)
  const { atoms } = await gql<{ atoms: { term_id: string }[] }>(cfg.graphqlUrl, ATOM_BY_DATA, {
    data: recipientData,
  })
  const recipientAtomIds = atoms.map((a) => a.term_id)
  if (recipientAtomIds.length === 0) return []

  const rels = await gql<{ triples: { term_id: string; subject: { data: string } }[] }>(
    cfg.graphqlUrl,
    RELATIONSHIPS,
    { objectIds: recipientAtomIds, pred: cfg.delegateTo },
  )
  if (rels.triples.length === 0) return []
  const delegatorByRel = new Map(rels.triples.map((t) => [t.term_id, t.subject?.data ?? '']))

  const ctx = await gql<{
    triples: { object_id: string; subject: { data: string; value?: { thing?: { name?: string; description?: string } } } }[]
  }>(cfg.graphqlUrl, CONTEXT, { relIds: [...delegatorByRel.keys()], pred: cfg.inContextOf })

  const results = await Promise.all(
    ctx.triples.map(async (t) => {
      const uri = t.subject?.data
      if (!uri || !uri.startsWith('ipfs://')) return null
      try {
        const res = await fetch(ipfsToHttp(uri))
        if (!res.ok) return null
        // Network boundary: the pinned DelegationJson document (validated below).
        const doc = (await res.json()) as DelegationDocument
        if (!doc?.delegation?.delegate) return null
        const named: DelegationDocument = {
          name: t.subject.value?.thing?.name,
          description: t.subject.value?.thing?.description,
          delegation: doc.delegation,
        }
        return toStoredDelegation(named, uri, delegatorByRel.get(t.object_id) ?? '', recipientChainId)
      } catch {
        return null
      }
    }),
  )
  return results.filter((d): d is StoredDelegation => d !== null)
}
