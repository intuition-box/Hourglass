import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { addresses } from '../config/addresses'

/**
 * Get the SmartAccountsEnvironment for the current chain.
 *
 * Resolves all contract addresses (DelegationManager, enforcers, etc.) from the SDK's
 * built-in deployment registry, then — on chains where HourGlass has deployed its own
 * audited enforcer instances — overrides the three enforcers HourGlass delegations use
 * so new delegations reference the HourGlass instances. The period enforcer's
 * TransferredInPeriod events are then attributable to HourGlass by emitter address (the
 * analytics marker; see spec/plan-analytics.md and
 * spec/hourglass-enforcer-suite.md).
 *
 * `addresses[chainId].hourglass` is a registry of all 37 deployed instances, but only the
 * three below are overridden. Adding a key there does not change what gets signed; routing
 * another delegation type through an HourGlass instance means adding it here, deliberately.
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
      // The strategy / limit-order rail — route every enforcer these mandates use
      // through the HourGlass instances, so the whole mandate is attributable to
      // HourGlass (measurable by emitter address), not just the balance-change one.
      ERC20BalanceChangeEnforcer: hourglass.erc20BalanceChangeEnforcer,
      AllowedTargetsEnforcer: hourglass.allowedTargetsEnforcer,
      AllowedMethodsEnforcer: hourglass.allowedMethodsEnforcer,
      ValueLteEnforcer: hourglass.valueLteEnforcer,
      LimitedCallsEnforcer: hourglass.limitedCallsEnforcer,
      // The yield rail — same reasoning as the strategy rail above. Its mandates pin
      // the exact execution and restrict who may redeem, so route both through the
      // HourGlass instances or a yield plan is attributable to nobody, and the
      // discovery side (which matches on these addresses) never finds it.
      ExactExecutionEnforcer: hourglass.exactExecutionEnforcer,
      RedeemerEnforcer: hourglass.redeemerEnforcer,
    },
  }
}
