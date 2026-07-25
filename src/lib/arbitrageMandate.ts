import { createDelegation, BalanceChangeType } from '@metamask/smart-accounts-kit'
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { getEnvironment } from './environment'
import { type DelegationStruct } from './delegations'
import { canonicalize } from './subscriptionTerms'

/**
 * Arbitrage mandate builder — the Strategy rail applied to intra-Uniswap arbitrage.
 *
 * One delegation grants a redeem-only agent the right to call the Universal
 * Router's `execute`, bounded by an `erc20BalanceChange(Increase)` PROFIT FLOOR on
 * the base token: any redemption that does not leave the Safe at least `minProfit`
 * richer reverts. No custody, no per-swap signature. See docs/HOURGLASS_ARBITRAGE.md.
 *
 * The base-token approval is TWO one-time Safe multisig SETUP transactions using
 * Permit2 — OUTSIDE the mandate but inside the Safe. The Universal Router pulls
 * funds ONLY via Permit2, so a legacy `approve(router, x)` is dead allowance
 * (verified in Dispatcher.sol; see docs/APPROVAL_RAILS.md §2):
 *     baseToken.approve(PERMIT2, cap)
 *     Permit2.approve(baseToken, UNIVERSAL_ROUTER, cap, expiration)
 * An approve leg cannot pass the Increase floor and would widen the attack surface,
 * so it stays out of the mandate.
 *
 * Everything lives inside the Safe and the swap runs AS the Safe, which shapes the
 * guarantees (docs §3.3-3.5):
 *   - The Permit2 `amount` is the per-run size lever — the floor is size-agnostic,
 *     so the bounded allowance (not any caveat) limits how much the agent can route;
 *     `expiration` is a free time bound. Grant an allowance only for the base token;
 *     tokens without one are unreachable.
 *   - Treasury protection is the approval surface, NOT a caveat: the SDK's
 *     `erc20BalanceChange` builder rejects `balance <= 0n` ("Invalid balance"), so a
 *     "must not decrease" `Decrease(0)` guard is unencodable. Minimal allowances are
 *     the guard.
 *   - The same rule makes `minProfit = 0` unencodable, so the positive floor is
 *     enforced at build time by the SDK (the check below is defence-in-depth).
 *   - The output returns to the Safe for free (MSG_SENDER === the executing Safe),
 *     so no recipient-pinning caveat is needed.
 */

/** The only swap entrypoint the mandate exposes. */
export const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = 'execute(bytes,bytes[],uint256)' as const

export interface ArbitrageTerms {
  schema: 'hourglass/arbitrage-mandate@1'
  chainId: number
  agent: Address
  module: Address
  safe: Address
  baseToken: Address
  minProfitRaw: string
  swapRouter: Address
}

/** Deterministic hash of the terms — used as the delegation salt (binds the
 * signature to the exact mandate, mirroring the subscription rail). */
export function hashArbitrageTerms(terms: ArbitrageTerms): Hex {
  return keccak256(toBytes(canonicalize(terms)))
}

export interface ArbitrageMandateParams {
  chainId: number
  /** Delegate — the agent that redeems. Holds no funds. */
  agentAddress: Address
  /** Delegator — the Safe's DeleGator module. */
  moduleAddress: Address
  /** The Safe, whose base-token balance the floor is measured on. */
  safeAddress: Address
  /** Base token the profit floor is denominated in (e.g. USDC). */
  baseToken: Address
  /** Universal Router address (from src/config/uniswap.ts). */
  swapRouter: Address
  /** Minimum net rise in base token per redemption, raw units. MUST be > 0. */
  minProfitRaw: bigint
}

export interface ArbitrageMandate {
  delegation: DelegationStruct
  terms: ArbitrageTerms
  salt: Hex
}

/**
 * Build the unsigned arbitrage delegation. Sign it with the Safe via
 * `buildDelegationTypedData` + `sdk.txs.signTypedMessage`, exactly like the
 * subscription rail.
 */
export function buildArbitrageMandate(params: ArbitrageMandateParams): ArbitrageMandate {
  const { chainId, agentAddress, moduleAddress, safeAddress, baseToken, swapRouter } = params

  if (params.minProfitRaw <= 0n) {
    // A zero floor makes a balance-neutral redemption valid — a drain vector
    // (docs §3.2). The SDK builder also rejects balance <= 0n; this is the earlier,
    // clearer guard.
    throw new Error('minProfitRaw must be strictly positive')
  }

  const terms: ArbitrageTerms = {
    schema: 'hourglass/arbitrage-mandate@1',
    chainId,
    agent: agentAddress,
    module: moduleAddress,
    safe: safeAddress,
    baseToken,
    minProfitRaw: params.minProfitRaw.toString(),
    swapRouter,
  }
  const salt = hashArbitrageTerms(terms)

  const environment = getEnvironment(chainId)

  // The single profit floor. Treasury protection is the approval surface, not a
  // caveat (Decrease(0) is unencodable — see the file header).
  const caveats = [
    {
      type: 'erc20BalanceChange',
      tokenAddress: baseToken,
      recipient: safeAddress,
      changeType: BalanceChangeType.Increase,
      balance: params.minProfitRaw,
    },
  ]

  // The SDK's scope/caveat generics are looser than our concrete inputs; the repo
  // casts to `never` here (see CreateDelegation.tsx) — the runtime shape is correct.
  const sdkDelegation = createDelegation({
    to: agentAddress,
    from: moduleAddress,
    environment: environment as never,
    scope: {
      type: 'functionCall',
      targets: [swapRouter],
      selectors: [UNIVERSAL_ROUTER_EXECUTE_SELECTOR],
    } as never,
    caveats: caveats as never,
    salt,
  }) as { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex }[]; salt: Hex }

  const delegation: DelegationStruct = {
    delegate: sdkDelegation.delegate,
    delegator: sdkDelegation.delegator,
    authority: sdkDelegation.authority,
    caveats: sdkDelegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: sdkDelegation.salt,
    signature: '0x',
  }

  return { delegation, terms, salt }
}
