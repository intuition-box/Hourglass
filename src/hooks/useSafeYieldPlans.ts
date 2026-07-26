/**
 * Recovers the Safe's yield plans from Intuition and the chain, so a reload does not
 * lose them.
 *
 * Nothing is stored client-side. The graph holds the mandates, each names its own
 * delegate, and the chain says which steps are spent — that is enough to rebuild both
 * the plan list and the agent address the app had only kept in React state.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, http, parseAbi, decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { discoverBySafe } from '../lib/intuition/discover'
import { getAddresses } from '../config/addresses'
import { UniswapV3PositionManagerABI } from '../config/abis'
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

/** What the deposit actually commits, decoded from the mint the Safe signed. */
export interface PlanDeposit {
  token0: { address: Address; symbol: string; decimals: number }
  token1: { address: Address; symbol: string; decimals: number }
  amount0: bigint
  amount1: bigint
  /** Pool fee in hundredths of a bip — 3000 is 0.3%. */
  fee: number
}

export interface RecoveredYieldPlan {
  /** The delegate every step of this plan was signed to. */
  agentAddress: Address
  steps: YieldPlanStep[]
  /** A plan is three pinned steps; fewer means it is still being indexed. */
  complete: boolean
  /** Every step spent — the deposit has been made. */
  done: boolean
  /** Null while the mint step is still being indexed. */
  deposit: PlanDeposit | null
}

export interface UseSafeYieldPlans {
  plans: RecoveredYieldPlan[]
  loading: boolean
  error: string | null
  refresh: () => void
  /** Hide a plan from this view. Local only — the mandate is untouched on-chain. */
  dismiss: (agentAddress: Address) => void
}

/**
 * Plans the operator has hidden. Purely cosmetic and deliberately separate from
 * revoking: a dismissed plan is still signed and still redeemable, so this is for
 * clearing abandoned attempts out of the way, not for making them safe.
 */
const DISMISSED_KEY = 'og-dismissed-yield-plans'

function dismissedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

/**
 * Group by delegate. An agent serves one plan at a time, so its address is the plan
 * key — and it is the only grouping the mandates themselves carry: each step's salt is
 * keccak256 of its own calldata, so nothing links the three together directly.
 */
const MINT_SELECTOR = '0x88316456'

/**
 * The mint's pinned calldata carries the pair, the fee tier and both amounts — it is the
 * deposit the Safe signed, so it needs no separate record and cannot drift from it.
 */
function decodeDeposit(steps: YieldPlanStep[]): Omit<PlanDeposit, 'token0' | 'token1'> & { t0: Address; t1: Address } | null {
  const mint = steps.find((s) => s.selector.toLowerCase() === MINT_SELECTOR)
  const callData = mint?.delegation.meta.calldataArgs as Hex | undefined
  if (!callData) return null
  try {
    const { args } = decodeFunctionData({ abi: UniswapV3PositionManagerABI, data: callData })
    const p = (args as readonly [{ token0: Address; token1: Address; fee: number; amount0Desired: bigint; amount1Desired: bigint }])[0]
    return { t0: p.token0, t1: p.token1, fee: Number(p.fee), amount0: p.amount0Desired, amount1: p.amount1Desired }
  } catch {
    return null
  }
}

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

  const dismiss = useCallback((agentAddress: Address) => {
    try {
      const next = dismissedSet()
      next.add(agentAddress.toLowerCase())
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]))
    } catch {
      // best-effort — a failed write only means the plan reappears on reload
    }
    setPlans((current) => current.filter((p) => p.agentAddress.toLowerCase() !== agentAddress.toLowerCase()))
  }, [])

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
            const raw = decodeDeposit(withState)
            let deposit: PlanDeposit | null = null
            if (raw) {
              const meta = await Promise.all(
                [raw.t0, raw.t1].map(async (address) => {
                  try {
                    const [symbol, decimals] = await Promise.all([
                      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
                      client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
                    ])
                    return { address, symbol, decimals }
                  } catch {
                    // A token that will not answer should not hide the deposit.
                    return { address, symbol: '???', decimals: 18 }
                  }
                }),
              )
              deposit = { token0: meta[0], token1: meta[1], amount0: raw.amount0, amount1: raw.amount1, fee: raw.fee }
            }
            return {
              agentAddress,
              steps: withState,
              complete: withState.length >= 3,
              done: withState.length >= 3 && withState.every((s) => s.consumed),
              deposit,
            }
          }),
        )
        const hidden = dismissedSet()
        if (!cancelled) setPlans(recovered.filter((p) => !hidden.has(p.agentAddress.toLowerCase())))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read the Safe plans')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [moduleAddress, chainId, nonce])

  return { plans, loading, error, refresh, dismiss }
}
