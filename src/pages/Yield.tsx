import { useEffect, useState, useMemo } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, formatUnits, erc20Abi, type Address, type Hex } from 'viem'
import { useUniswapPools } from '../hooks/useUniswapPools'
import { buildDepositPlan } from '../lib/uniswapPosition'
import { buildYieldDelegations, buildStoredYieldPlan, type StoredYieldPlan } from '../lib/yieldDelegations'
import { buildDelegationTypedData } from '../lib/delegations'
import { getEnvironment } from '../lib/environment'
import { getAddresses } from '../config/addresses'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { DEFAULT_SALT } from '../lib/module'
import { findChain, rpcUrl } from '../config/supported-chains'
import type { PoolInfo } from '../lib/uniswapDiscovery'
import { Card, Btn, Mono, CopyChip } from '../ui/components'
import { Block, Field } from '../ui/form'
import { CompoundProjection } from '../ui/CompoundProjection'
import { IconTrend, IconAlert, IconCheck } from '../ui/icons'

const feeLabel = (fee: number) => `${(fee / 10_000).toFixed(2)}%`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// Display-only estimate used to value a non-stable leg in the projection card.
const ETH_PRICE_USD_ESTIMATE = 3000
// Fallback APR for the projection when the pool reports insufficient data.
const DEFAULT_PROJECTION_APR = 0.05

/** Rough USD value of the deposit for the projection: stable legs count 1:1, a
 * non-stable leg is valued at a fixed estimate. Illustrative, not a quote. */
function estimatePositionValueUsd(
  token0Symbol: string,
  token1Symbol: string,
  amount0: string,
  amount1: string,
): number {
  const legUsd = (symbol: string, human: string) => {
    const n = Number(human)
    if (!Number.isFinite(n) || n <= 0) return 0
    return /usd|dai/i.test(symbol) ? n : n * ETH_PRICE_USD_ESTIMATE
  }
  return legUsd(token0Symbol, amount0) + legUsd(token1Symbol, amount1)
}

// A signed delegation grants a real permission; keep the window it stays
// redeemable short rather than open-ended.
const DEADLINE_SECONDS = 3600

type DelegateStep = 'idle' | 'preparing' | 'signing' | 'done'

// The Safe parent window needs a moment to close/reset its sign-message modal
// before it reliably opens the next one — firing signTypedMessage calls back
// to back can leave that second request stuck with no visible prompt.
const SIGN_SETTLE_MS = 800
// Safety net so a genuinely stuck Safe-side modal fails loudly instead of
// leaving the button on "Signing N of 3…" forever with no way to recover.
const SIGN_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default function Yield() {
  const { sdk, safe } = useSafeAppsSDK()
  const { loading, error, pools } = useUniswapPools(safe.chainId)
  const [selectedPool, setSelectedPool] = useState<PoolInfo | null>(null)
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [balances, setBalances] = useState<{ token0: bigint; token1: bigint } | null>(null)
  const [step, setStep] = useState<DelegateStep>('idle')
  const [signingIndex, setSigningIndex] = useState(0)
  const [planError, setPlanError] = useState<string | null>(null)
  const [storedPlan, setStoredPlan] = useState<StoredYieldPlan | null>(null)
  const [autoCompound, setAutoCompound] = useState(false)

  const recommended = pools[0] ?? null
  const pool = selectedPool ?? recommended
  // Pre-fill from the env var if the operator set one, but the user can always
  // paste a different agent address — the input is the source of truth.
  const [agent, setAgent] = useState(() => (import.meta.env.VITE_YIELD_AGENT_ADDRESS as string | undefined) ?? '')
  const agentValid = isAddress(agent)
  const agentAddress = agentValid ? (agent as Address) : undefined

  useEffect(() => {
    if (!pool) {
      setBalances(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const chain = findChain(safe.chainId)
      if (!chain) return
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      // safe.safeAddress from the Safe Apps SDK is typed as a plain string, not viem's Address.
      const safeAddress = safe.safeAddress as Address
      const [token0, token1] = await Promise.all([
        client.readContract({ address: pool.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
        client.readContract({ address: pool.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
      ])
      if (!cancelled) setBalances({ token0, token1 })
    })()
    return () => {
      cancelled = true
    }
  }, [pool, safe.chainId, safe.safeAddress])

  const amount0Raw = useMemo<bigint>(() => {
    if (!pool || !amount0) return 0n
    try { return parseUnits(amount0, pool.token0.decimals) } catch { return 0n }
  }, [pool, amount0])
  const amount1Raw = useMemo<bigint>(() => {
    if (!pool || !amount1) return 0n
    try { return parseUnits(amount1, pool.token1.decimals) } catch { return 0n }
  }, [pool, amount1])
  const hasBalance0 = balances ? amount0Raw <= balances.token0 : false
  const hasBalance1 = balances ? amount1Raw <= balances.token1 : false
  const canDelegate = Boolean(pool && agentAddress && amount0Raw > 0n && amount1Raw > 0n && hasBalance0 && hasBalance1)

  const positionValueUsd = useMemo(
    () => (pool ? estimatePositionValueUsd(pool.token0.symbol, pool.token1.symbol, amount0, amount1) : 0),
    [pool, amount0, amount1],
  )
  const projectionApr = pool?.apy ?? DEFAULT_PROJECTION_APR
  const aprIsEstimate = pool?.apy == null

  async function handleDelegate() {
    if (!pool || !agentAddress) return
    setPlanError(null)
    setStoredPlan(null)
    setStep('preparing')
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error(`Unsupported chain: ${safe.chainId}`)
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)
      // safe.safeAddress from the Safe Apps SDK is typed as a plain string, not viem's Address.
      const safeAddress = safe.safeAddress as Address
      // readContract's return type is generic over the ABI; predictAddress's single
      // output is known (from DeleGatorModuleFactoryABI) to be an address.
      const moduleAddress = (await client.readContract({
        address: addrs.delegatorModuleFactory,
        abi: DeleGatorModuleFactoryABI,
        functionName: 'predictAddress',
        args: [safeAddress, DEFAULT_SALT],
      })) as Address

      const plan = buildDepositPlan({
        pool,
        amount0: amount0Raw,
        amount1: amount1Raw,
        recipient: safeAddress,
        chainId: safe.chainId,
        deadlineSeconds: DEADLINE_SECONDS,
      })

      const environment = getEnvironment(safe.chainId)
      const yieldDelegations = buildYieldDelegations({
        plan,
        moduleAddress,
        agentAddress,
        environment,
        deadlineSeconds: DEADLINE_SECONDS,
      })

      setStep('signing')
      const signatures: Hex[] = []
      for (let i = 0; i < yieldDelegations.length; i++) {
        setSigningIndex(i)
        if (i > 0) await sleep(SIGN_SETTLE_MS)
        const typedData = buildDelegationTypedData(yieldDelegations[i].delegation, safe.chainId)
        // sdk.txs.signTypedMessage's parameter type doesn't match our EIP-712 typed-data
        // shape (same cast as the existing CreateDelegation.tsx signing flow); its
        // resolved value is likewise typed loosely by the SDK, narrowed to the two
        // fields this app actually reads off it.
        const result = (await withTimeout(
          sdk.txs.signTypedMessage(typedData as never),
          SIGN_TIMEOUT_MS,
          `Timed out waiting for signature ${i + 1} of ${yieldDelegations.length}. Check your wallet extension for a pending request, or the Safe app's Messages tab, then try again.`,
        )) as { signature?: Hex; safeTxHash?: Hex }
        // Both fields are already hex strings from the SDK; '0x' is the empty-signature fallback.
        signatures.push((result?.signature || result?.safeTxHash || '0x') as Hex)
      }

      setStoredPlan(
        buildStoredYieldPlan({
          plan,
          yieldDelegations,
          signatures,
          chainId: safe.chainId,
          safeAddress,
          moduleAddress,
          agentAddress,
        }),
      )
      setStep('done')
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to build the delegation plan')
      setStep('idle')
    }
  }

  function downloadPlan() {
    if (!storedPlan) return
    const blob = new Blob([JSON.stringify(storedPlan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `yield-plan-${storedPlan.pool.address.slice(2, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Yield</h1>
        <p className="text-dim text-sm mt-1">
          Real Uniswap v3 pools on Base Sepolia, ranked by fee APY and depth. Depositing needs both tokens in the Safe
          already and a signed delegation the agent redeems on its own.
        </p>
      </div>

      {loading ? (
        <div className="text-dim text-sm mb-6 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-line border-t-[color:var(--accent)] rounded-full animate-spin" /> Scanning pools…
        </div>
      ) : error ? (
        <Card className="p-4 mb-6">
          <div className="flex items-center gap-2 text-pending text-sm font-medium">
            <IconAlert size={16} /> {error}
          </div>
        </Card>
      ) : pools.length === 0 ? (
        <Card className="p-5 mb-6">
          <div className="text-sm font-semibold text-ink">No pools found</div>
          <p className="text-xs text-dim mt-1 leading-relaxed">
            No Uniswap v3 pool exists yet on Base Sepolia for the token pairs OurGlass tracks (WETH / USDC). Nothing to
            recommend.
          </p>
        </Card>
      ) : (
        <div className="space-y-2 mb-6">
          {pools.map((p) => {
            const active = pool?.poolAddress === p.poolAddress
            const isRecommended = p.poolAddress === recommended?.poolAddress
            return (
              <Card
                key={p.poolAddress}
                hover
                onClick={() => setSelectedPool(p)}
                className={`p-4 cursor-pointer flex items-center justify-between gap-4 ${active ? 'ring-line2' : ''}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="grid place-items-center w-9 h-9 rounded-xl shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    <IconTrend size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink flex items-center gap-2">
                      {p.token0.symbol} / {p.token1.symbol}
                      <span className="text-faint font-normal">· {feeLabel(p.fee)}</span>
                      {isRecommended && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                          <IconCheck size={12} /> recommended
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-faint truncate">{short(p.poolAddress)}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-sm text-ink tnum">{p.apy !== null ? `${(p.apy * 100).toFixed(1)}% APY` : 'insufficient data'}</div>
                  <div className="text-[11px] text-faint mt-0.5">
                    {formatUnits(p.tvlToken0, p.token0.decimals)} {p.token0.symbol} + {formatUnits(p.tvlToken1, p.token1.decimals)} {p.token1.symbol}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {pool && (
        <Block title="Delegate to agent">
          <p className="text-xs text-dim -mt-1 leading-relaxed">
            Signs 3 single-use delegations — approve {pool.token0.symbol}, approve {pool.token1.symbol}, mint a full-range
            position — each pinned to an exact, pre-built transaction. The agent wallet redeems them itself; it cannot
            change the target, method, amount, or recipient.
          </p>

          <Field label="Agent address" required missing={agent !== '' && !agentValid}>
            <input
              type="text" placeholder="0x…" value={agent}
              onChange={(e) => setAgent(e.target.value)}
              aria-label="Agent address"
              className={`font-mono ${agent && !agentValid ? 'ring-1 ring-danger' : ''}`}
            />
          </Field>
          {!agentValid && (
            <p className="text-xs text-faint -mt-2">
              Run the agent yourself (see scripts/yield-agent.ts) and paste its wallet address here — everything below
              stays locked until you do.
            </p>
          )}

          <div className={agentValid ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none select-none'} aria-disabled={!agentValid}>
          <div className="grid grid-cols-2 gap-4">
            <Field label={`${pool.token0.symbol} amount`} required missing={amount0Raw > 0n && !hasBalance0}>
              <input
                value={amount0}
                onChange={(e) => setAmount0(e.target.value)}
                placeholder="0.00"
                aria-label={`${pool.token0.symbol} amount`}
                className={`font-mono ${amount0Raw > 0n && !hasBalance0 ? 'ring-1 ring-danger' : ''}`}
              />
              {balances && (
                <p className="text-xs text-faint mt-1">
                  Safe holds {formatUnits(balances.token0, pool.token0.decimals)} {pool.token0.symbol}
                </p>
              )}
            </Field>
            <Field label={`${pool.token1.symbol} amount`} required missing={amount1Raw > 0n && !hasBalance1}>
              <input
                value={amount1}
                onChange={(e) => setAmount1(e.target.value)}
                placeholder="0.00"
                aria-label={`${pool.token1.symbol} amount`}
                className={`font-mono ${amount1Raw > 0n && !hasBalance1 ? 'ring-1 ring-danger' : ''}`}
              />
              {balances && (
                <p className="text-xs text-faint mt-1">
                  Safe holds {formatUnits(balances.token1, pool.token1.decimals)} {pool.token1.symbol}
                </p>
              )}
            </Field>
          </div>

          <CompoundProjection
            positionValueUsd={positionValueUsd}
            apr={projectionApr}
            aprIsEstimate={aprIsEstimate}
            enabled={autoCompound}
            onToggle={setAutoCompound}
          />

          {planError && (
            <div className="flex items-center gap-2 text-pending text-sm">
              <IconAlert size={16} /> {planError}
            </div>
          )}

          {step === 'done' && storedPlan ? (
            <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-active">
                <IconCheck size={16} /> Plan signed — 3 delegations ready for the agent.
              </div>
              <div className="text-xs text-dim">
                Agent wallet: <Mono>{short(storedPlan.agentAddress)}</Mono>
              </div>
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={downloadPlan}>
                  Download plan.json
                </Btn>
                <CopyChip value={JSON.stringify(storedPlan)} label="Copy plan JSON" />
              </div>
            </div>
          ) : (
            <Btn kind="primary" size="lg" onClick={handleDelegate} disabled={!canDelegate || step !== 'idle'}>
              {step === 'preparing' ? 'Preparing…' : step === 'signing' ? `Signing ${signingIndex + 1} of 3…` : 'Sign delegations'}
            </Btn>
          )}
          </div>
        </Block>
      )}
    </div>
  )
}
