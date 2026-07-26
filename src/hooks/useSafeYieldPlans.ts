/**
 * Recovers the Safe's yield plans from Intuition and the chain, so a reload does not
 * lose them.
 *
 * Nothing is stored client-side. The graph holds the mandates, each names its own
 * delegate, and the chain says which steps are spent — that is enough to rebuild both
 * the plan list and the agent address the app had only kept in React state.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem'
import { discoverBySafe } from '../lib/intuition/discover'
import { getAddresses } from '../config/addresses'
import { findChain, rpcUrl } from '../config/supported-chains'
import type { StoredDelegation } from '../lib/storage'

const LIMITED_CALLS_ABI = parseAbi([
  'function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

export interface YieldPlanStep {
  delegation: StoredDelegation
  /** The pinned call's selector — approve or mint. */
  selector: Hex
  consumed: boolean
}

export interface RecoveredYieldPlan {
  /** The delegate every step of this plan was signed to. */
  agentAddress: Address
  steps: YieldPlanStep[]
  /** A plan is three pinned steps; fewer means it is still being indexed. */
  complete: boolean
  /** Every step spent — the deposit has been made. */
  done: boolean
}

export interface UseSafeYieldPlans {
  plans: RecoveredYieldPlan[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Group by delegate. An agent serves one plan at a time, so its address is the plan
 * key — and it is the only grouping the mandates themselves carry: each step's salt is
 * keccak256 of its own calldata, so nothing links the three together directly.
 */
function groupByAgent(delegations: StoredDelegation[]): Map<Address, StoredDelegation[]> {
  const byAgent = new Map<Address, StoredDelegation[]>()
  for (const d of delegations) {
    // Yield steps are the ones carrying a pinned execution; everything else on this
    // Safe (subscriptions, limit orders) is a different rail.
    if (!d.meta.calldataArgs || !d.meta.targetAddress) continue
    const agent = d.delegation.delegate
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), d])
  }
  return byAgent
}

export function useSafeYieldPlans(moduleAddress: Address | undefined, chainId: number): UseSafeYieldPlans {
  const [plans, setPlans] = useState<RecoveredYieldPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!moduleAddress) return
    const chain = findChain(chainId)
    if (!chain) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const granted = await discoverBySafe(moduleAddress, chainId)
        const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) })
        const { delegationManager, hourglass } = getAddresses(chainId)
        const enforcer = hourglass?.limitedCallsEnforcer

        const recovered = await Promise.all(
          [...groupByAgent(granted)].map(async ([agentAddress, steps]) => {
            const withState = await Promise.all(
              steps.map(async (delegation) => {
                const hash = delegation.meta.delegationHash as Hex | undefined
                let consumed = false
                if (enforcer && hash) {
                  try {
                    const count = await client.readContract({
                      address: enforcer,
                      abi: LIMITED_CALLS_ABI,
                      functionName: 'callCounts',
                      args: [delegationManager, hash],
                    })
                    consumed = count > 0n
                  } catch {
                    // A node that will not answer is not a spent step; leave it unknown
                    // rather than reporting a plan as further along than it is.
                  }
                }
                return {
                  delegation,
                  selector: (delegation.meta.methodSelector ?? '0x') as Hex,
                  consumed,
                }
              }),
            )
            return {
              agentAddress,
              steps: withState,
              complete: withState.length >= 3,
              done: withState.length >= 3 && withState.every((s) => s.consumed),
            }
          }),
        )
        if (!cancelled) setPlans(recovered)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read the Safe plans')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [moduleAddress, chainId, nonce])

  return { plans, loading, error, refresh }
}
