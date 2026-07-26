import { createDelegation } from '@metamask/smart-accounts-kit'
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { computeDelegationHash, type DelegationStruct } from './delegations'
import { getEnvironment } from './environment'
import { canonicalize } from './subscriptionTerms'
import type { Caveat, StoredDelegation } from './storage'

/**
 * Compound mandate: a standing, repeatable delegation that lets the agent harvest
 * an LP position's fees and reinvest them into the SAME position.
 *
 * Scope: functionCall over the Uniswap v3 PositionManager, methods `collect` +
 * `increaseLiquidity` only. What this bounds:
 *   - No `decreaseLiquidity` / `burn` in scope, so the agent CANNOT withdraw the
 *     principal — only harvest fees and add them back.
 *   - Redeemer-locked to the agent wallet.
 *   - Runs as the Safe (the Safe owns the position and the collected fees).
 *
 * Unlike the yield mint (whose calldata is fully known, so it uses `exactExecution`),
 * a compound has amounts that are only known at run time, so it is bounded by the
 * call surface rather than pinned byte-for-byte — the same means/intent split as the
 * arbitrage rail.
 *
 * Honest limitations to close before production (see HOURGLASS docs):
 *   1. The position `tokenId` is NOT pinned: it does not exist at signing time (the
 *      agent mints it later), so this applies to any position the Safe holds in this
 *      PositionManager. Pinning to one tokenId needs a post-mint second signature.
 *   2. `increaseLiquidity` amounts are not capped, so the agent could add more of the
 *      Safe's token balance to the position than just the harvested fees (over-
 *      allocation into the Safe's own LP, not theft). Capping needs per-method
 *      calldata bounds or a balance-change guard.
 *   3. Requires a one-time standing approval from the Safe to the PositionManager for
 *      both tokens (setup tx) so `increaseLiquidity` can pull the collected fees.
 *   4. `collect`'s recipient is not pinned (an allowedCalldata pin would also
 *      constrain increaseLiquidity's bytes at that offset). Mitigate with a
 *      balance-change guard on the Safe, or accept for the demo.
 */

const COMPOUND_SELECTORS = [
  'collect((uint256,address,uint128,uint128))',
  'increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
] as const

export type CompoundMode = 'agent' | 'manual'

export interface CompoundTerms {
  schema: 'hourglass/compound-mandate@1'
  chainId: number
  agent: Address
  module: Address
  safe: Address
  positionManager: Address
  pool: Address
  /** 'agent' = gas-aware gate decides; 'manual' = fixed schedule. */
  mode: CompoundMode
  /** Manual only: days between compounds. */
  intervalDays: number | null
}

export interface CompoundMandateParams {
  chainId: number
  /** Delegate — the agent that redeems. Holds no funds. */
  agentAddress: Address
  /** Delegator — the Safe's DeleGator module. */
  moduleAddress: Address
  /** The Safe that owns the LP position. */
  safeAddress: Address
  /** Uniswap v3 PositionManager for the chain. */
  positionManager: Address
  /** The pool being compounded (for the terms record). */
  pool: Address
  mode: CompoundMode
  /** Manual only: days between compounds. */
  intervalDays?: number
  /** Optional validity window in seconds; omit for an open-ended (revocable) mandate. */
  deadlineSeconds?: number
}

export interface CompoundMandate {
  delegation: DelegationStruct
  terms: CompoundTerms
  salt: Hex
}

/** Deterministic hash of the terms — the delegation salt (binds the signature to the
 * exact mandate, mirroring the subscription/arbitrage rails). */
export function hashCompoundTerms(terms: CompoundTerms): Hex {
  return keccak256(toBytes(canonicalize(terms)))
}

/**
 * Build the unsigned compound delegation. Sign it with the Safe via
 * `buildDelegationTypedData` + `sdk.txs.signTypedMessage`, then add it to the yield
 * plan when the operator enables auto-compound.
 */
export function buildCompoundMandate(params: CompoundMandateParams): CompoundMandate {
  const { chainId, agentAddress, moduleAddress, safeAddress, positionManager, pool } = params

  if (params.mode === 'manual' && !(params.intervalDays && params.intervalDays > 0)) {
    throw new Error('manual mode requires a positive intervalDays')
  }

  const terms: CompoundTerms = {
    schema: 'hourglass/compound-mandate@1',
    chainId,
    agent: agentAddress,
    module: moduleAddress,
    safe: safeAddress,
    positionManager,
    pool,
    mode: params.mode,
    intervalDays: params.mode === 'manual' ? (params.intervalDays ?? null) : null,
  }
  const salt = hashCompoundTerms(terms)

  const environment = getEnvironment(chainId)
  const nowSec = Math.floor(Date.now() / 1000)

  const caveats = [
    { type: 'redeemer', redeemers: [agentAddress] },
    ...(params.deadlineSeconds
      ? [{ type: 'timestamp', afterThreshold: nowSec, beforeThreshold: nowSec + params.deadlineSeconds }]
      : []),
  ]

  // The SDK's scope/caveat generics are looser than our concrete inputs; the repo
  // casts to `never` here (see yieldDelegations.ts) — the runtime shape is correct.
  const sdkDelegation = createDelegation({
    to: agentAddress,
    from: moduleAddress,
    environment: environment as never,
    scope: {
      type: 'functionCall',
      targets: [positionManager],
      selectors: COMPOUND_SELECTORS,
    } as never,
    caveats: caveats as never,
    salt,
  }) as { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }

  const delegation: DelegationStruct = {
    delegate: sdkDelegation.delegate,
    delegator: sdkDelegation.delegator,
    authority: sdkDelegation.authority,
    caveats: sdkDelegation.caveats,
    salt: sdkDelegation.salt,
    signature: '0x',
  }

  return { delegation, terms, salt }
}

/**
 * A stored compound delegation carries the human-readable `terms` next to the
 * delegation, mirroring the recap/instruction export on the DCA and limit-order
 * rails. The terms are salt-verifiable — `hashCompoundTerms(terms)` equals the
 * signed delegation salt — so the agent can read `mode`/`intervalDays` from them
 * without an out-of-band env var, and reject any file where they were tampered.
 * The on-chain caveats remain the source of truth for what can be executed.
 */
export interface StoredCompoundDelegation extends StoredDelegation {
  terms: CompoundTerms
}

/** Wrap a signed compound delegation for storage/export, matching StoredDelegation. */
export function buildStoredCompoundDelegation(params: {
  mandate: CompoundMandate
  signature: Hex
  chainId: number
  safeAddress: Address
  moduleAddress: Address
}): StoredCompoundDelegation {
  const { mandate, signature, chainId, safeAddress, moduleAddress } = params
  const signed: DelegationStruct = { ...mandate.delegation, signature }
  return {
    delegation: signed,
    terms: mandate.terms,
    meta: {
      label: `Auto-compound (${mandate.terms.mode})`,
      scopeType: 'custom',
      createdAt: new Date().toISOString(),
      chainId,
      safeAddress,
      moduleAddress,
      status: 'signed',
      delegationHash: computeDelegationHash(signed),
      targetAddress: mandate.terms.positionManager,
    },
  }
}
