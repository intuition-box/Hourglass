/**
 * On-chain state of a yield plan's steps.
 *
 * A plan is three single-use delegations — [approve token0, approve token1, mint] —
 * each capped by `limitedCalls(1)`. Replaying a consumed step reverts, which is the
 * guarantee we want, but a bare revert reads as breakage: an agent that retries a step
 * it already landed would conclude the plan is broken and give up on a plan that in
 * fact succeeded.
 *
 * So ask before submitting. `callCounts` on the LimitedCallsEnforcer is the counter the
 * cap is enforced against; non-zero means that step is spent and the agent should move
 * on, not retry.
 */
import { createPublicClient, http, parseAbi, type Hex } from 'viem'
import { getAddresses } from '../config/addresses'
import { findChain, rpcUrl } from '../config/supported-chains'
import { isDelegationEnabled } from './intuition/enabled'

const LIMITED_CALLS_ABI = parseAbi([
  'function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

export type StepState = 'ready' | 'consumed' | 'revoked'

/**
 * Whether a step can still be redeemed. `consumed` and `revoked` are both terminal but
 * mean opposite things — one is success, the other is the Safe pulling out — so they
 * stay distinct rather than collapsing into "cannot redeem".
 */
export async function readStepState(chainId: number, delegationHash: Hex): Promise<StepState> {
  if (!(await isDelegationEnabled(chainId, delegationHash))) return 'revoked'

  const chain = findChain(chainId)
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`)
  const { delegationManager, hourglass } = getAddresses(chainId)
  const enforcer = hourglass?.limitedCallsEnforcer
  // No HourGlass block on this chain means no limitedCalls cap to read; the delegation
  // being enabled is then all we know, and a replay would simply revert.
  if (!enforcer) return 'ready'

  const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) })
  const count = await client.readContract({
    address: enforcer,
    abi: LIMITED_CALLS_ABI,
    functionName: 'callCounts',
    args: [delegationManager, delegationHash],
  })
  return count > 0n ? 'consumed' : 'ready'
}
