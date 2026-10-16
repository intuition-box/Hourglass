import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { addresses } from '../config/addresses'

/**
 * Get the SmartAccountsEnvironment for the current chain.
 *
 * Resolves all contract addresses (DelegationManager, enforcers, etc.) from the SDK's
 * built-in deployment registry, then — on chains where HourGlass has deployed its own
 * audited enforcer instances — overrides the enforcers HourGlass delegations use so new
 * delegations reference the HourGlass instances. Their events are then attributable to
 * HourGlass by emitter address (the analytics marker; see spec/plan-analytics.md and
 * spec/hourglass-enforcer-suite.md).
 *
 * Chains without an `hourglass` block fall through to the canonical SDK addresses.
 */
export function getEnvironment(chainId: number) {
  const env = getSmartAccountsEnvironment(chainId)
  const hourglass = addresses[chainId]?.hourglass
  if (!hourglass) return env

  return {
    ...env,
    caveatEnforcers: {
      ...env.caveatEnforcers,
      ERC20PeriodTransferEnforcer: hourglass.erc20PeriodTransferEnforcer,
      TimestampEnforcer: hourglass.timestampEnforcer,
      ERC20StreamingEnforcer: hourglass.erc20StreamingEnforcer,
      // The SDK's erc20PeriodTransfer / erc20Streaming scopes also add a valueLte(0)
      // caveat, so it is part of every payment delegation too.
      ValueLteEnforcer: hourglass.valueLteEnforcer,
    },
  }
}
