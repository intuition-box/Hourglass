import { getAddress, toHex, formatUnits, hashTypedData, type Address, type Hex } from 'viem'
import type { DelegationStruct } from '../delegations'
import { getAddresses } from '../../config/addresses'
import type { SafeMessage } from '../safe-messages'
import {
  findPeriodTransferCaveat,
  decodePeriodTransferTerms,
  findStreamingCaveat,
  decodeStreamingTerms,
  periodFromSeconds,
} from './discover'
import type { DelegationDetails } from './delegation-document'

/**
 * Recover an OurGlass delegation from a finalized Safe message. The message's
 * EIP-712 typed data IS the delegation struct (see `buildDelegationTypedData`);
 * the aggregated `preparedSignature` is its signature. So the full signed
 * delegation — the thing we index — is reconstructible from public tx-service
 * data, with no dependency on the session that proposed it (ADR 0005).
 *
 * These functions are pure: the message + the resolved token metadata in, the
 * struct / details out. Fetching the message (safe-messages.ts) and the token
 * metadata (erc20.ts) is the caller's job.
 */

interface DelegationTypedData {
  domain?: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string }
  types?: Record<string, { name: string; type: string }[]>
  primaryType?: string
  message?: {
    delegate?: string
    delegator?: string
    authority?: string
    caveats?: { enforcer?: string; terms?: string }[]
    salt?: string | number
  }
}

function parseTypedData(message: unknown): DelegationTypedData | null {
  if (typeof message === 'string') {
    try {
      return JSON.parse(message) as DelegationTypedData
    } catch {
      return null
    }
  }
  if (message && typeof message === 'object') return message as DelegationTypedData
  return null
}

/** Normalize the salt (uint256 in the typed data — decimal or hex) to a bytes32 hex. */
function normalizeSalt(salt: string | number): Hex {
  return toHex(BigInt(salt), { size: 32 })
}

/**
 * Extract the signed `DelegationStruct` from a finalized Safe message, or null if
 * the message is not an OurGlass delegation on `chainId` (wrong domain /
 * verifying contract) or is not finalized (no `preparedSignature`).
 */
export function delegationFromMessage(msg: SafeMessage, chainId: number): DelegationStruct | null {
  if (!msg.preparedSignature) return null
  const typed = parseTypedData(msg.message)
  const m = typed?.message
  if (!typed?.domain || !m) return null

  // Must be a Delegation signed under this chain's DelegationManager domain.
  const expected = getAddresses(chainId).delegationManager.toLowerCase()
  const verifying = typed.domain.verifyingContract?.toLowerCase()
  if (verifying !== expected) return null
  if (typed.domain.chainId !== undefined && Number(typed.domain.chainId) !== chainId) return null

  if (!m.delegate || !m.delegator || !m.authority || !m.caveats || m.salt === undefined) return null

  return {
    delegate: getAddress(m.delegate),
    delegator: getAddress(m.delegator),
    authority: m.authority as Hex,
    caveats: m.caveats.map((c) => ({
      enforcer: getAddress(c.enforcer as string),
      terms: c.terms as Hex,
    })),
    salt: normalizeSalt(m.salt),
    signature: msg.preparedSignature,
  }
}

/**
 * The EIP-712 hash of the delegation typed data (DelegationManager domain) — i.e.
 * the value the Safe treated as "the message" and wrapped into `SafeMessage`
 * before its owners signed.
 *
 * This is what EIP-1271 `isValidSignature(bytes32 _dataHash, bytes)` expects: the
 * Safe's fallback handler re-wraps `_dataHash` into `SafeMessage` itself. Passing
 * the tx-service's `messageHash` (which is ALREADY the wrapped SafeMessage hash)
 * double-wraps it and the check always fails.
 */
export function typedDataHashFromMessage(msg: SafeMessage): Hex | null {
  const typed = parseTypedData(msg.message)
  if (!typed?.domain || !typed.message || !typed.types) return null
  // viem derives the domain separator from `domain`; EIP712Domain must not be in `types`.
  const { EIP712Domain: _domainType, ...types } = typed.types
  try {
    return hashTypedData({
      domain: typed.domain,
      types,
      primaryType: typed.primaryType ?? 'Delegation',
      message: typed.message,
    } as Parameters<typeof hashTypedData>[0])
  } catch {
    return null
  }
}

export interface ResolvedTokenMeta {
  symbol: string
  decimals: number
}

/**
 * Build the display `DelegationDetails` from a delegation and its resolved token
 * metadata. Returns null if the delegation carries neither known caveat. The
 * token symbol is sanitized downstream by `describeDelegation`.
 */
export function detailsFromDelegation(
  delegation: DelegationStruct,
  chainId: number,
  token: ResolvedTokenMeta,
): DelegationDetails | null {
  const sub = findPeriodTransferCaveat(delegation, chainId)
  if (sub) {
    const { periodAmount, periodDuration } = decodePeriodTransferTerms(sub.terms)
    return {
      kind: 'subscription',
      amount: formatUnits(periodAmount, token.decimals),
      tokenSymbol: token.symbol,
      period: periodFromSeconds(periodDuration),
    }
  }
  const stream = findStreamingCaveat(delegation, chainId)
  if (stream) {
    const { amountPerSecond } = decodeStreamingTerms(stream.terms)
    // Display the accrual as a monthly rate, matching the create flow.
    const MONTH = 2_592_000n
    return {
      kind: 'stream',
      amount: formatUnits(amountPerSecond * MONTH, token.decimals),
      tokenSymbol: token.symbol,
      period: 'month',
    }
  }
  return null
}

/** The token address a delegation's caveat targets (for resolving symbol/decimals). */
export function tokenFromDelegation(delegation: DelegationStruct, chainId: number): Address | null {
  const sub = findPeriodTransferCaveat(delegation, chainId)
  if (sub) return decodePeriodTransferTerms(sub.terms).token
  const stream = findStreamingCaveat(delegation, chainId)
  if (stream) return decodeStreamingTerms(stream.terms).token
  return null
}
