import { useEffect, useState, useMemo, useRef } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, parseEther, formatUnits, erc20Abi, type Address, type Hex } from 'viem'
import { useUniswapPools } from '../hooks/useUniswapPools'
import { buildDepositPlan, type DepositPlan } from '../lib/uniswapPosition'
import { buildYieldDelegations, buildStoredYieldPlan, type YieldDelegation, type StoredYieldPlan } from '../lib/yieldDelegations'
import { useAgentRun } from '../hooks/useAgentRun'
import { finalizePending } from '../hooks/useFinalizePending'
import { discoverIncomingDelegations } from '../lib/intuition/discover'
import { buildCompoundMandate, buildStoredCompoundDelegation, type CompoundMandate, type CompoundMode, type StoredCompoundDelegation } from '../lib/compoundDelegation'
import { readCompoundAllowances, buildCompoundApprovalTxs, type TokenAllowance } from '../lib/compoundApproval'
import { buildDelegationTypedData } from '../lib/delegations'
import { getEnvironment } from '../lib/environment'
import { getAddresses } from '../config/addresses'
import { UNISWAP_V3_POSITION_MANAGER } from '../config/uniswap'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { DEFAULT_SALT } from '../lib/module'
import { findChain, rpcUrl, chainName } from '../config/supported-chains'
import { poolValueShare, priceOf0In1, type PoolInfo } from '../lib/uniswapDiscovery'

/** The signed yield plan, optionally carrying the auto-compound mandate (with its
 * salt-verifiable terms, so the agent needs no out-of-band interval config). */
type YieldPlanWithCompound = StoredYieldPlan & { compound?: StoredCompoundDelegation }
import { buildYieldRedeemTxs } from '../lib/redeemYield'
import { findCompoundablePosition, buildCompoundRedeemTx } from '../lib/redeemCompound'
import { Card, Btn, Mono, CopyChip } from '../ui/components'
import { Block, Field, Segmented } from '../ui/form'
import { dec } from '../lib/numeric-input'
import { CompoundProjection } from '../ui/CompoundProjection'
import { IconTrend, IconAlert, IconCheck } from '../ui/icons'

const feeLabel = (fee: number) => `${(fee / 10_000).toFixed(2)}%`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

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

// 'ready-for-next' = one signature done, more remain. Firing the next
// signTypedMessage automatically (even after a delay) can race Safe's own
// confirmation screen — click "Continue" there and the app can look like it
// dropped out, only to resurface once whatever Safe was doing settles. Pacing
// the next request on the operator's own button click instead removes the race
// entirely: nothing fires until they're done with Safe's UI.
type DelegateStep = 'idle' | 'preparing' | 'signing' | 'ready-for-next' | 'done'

// Safety net so a genuinely stuck Safe-side modal fails loudly instead of leaving
// the button on "Signing N of…" forever with no way to recover.
const SIGN_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

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
  const [storedPlan, setStoredPlan] = useState<YieldPlanWithCompound | null>(null)
  // Everything the paced signing flow needs across steps — a ref because updating
  // it must never itself trigger a render; `step`/`signingIndex` state do that.
  const pendingSignRef = useRef<{
    plan: DepositPlan
    moduleAddress: Address
    yieldDelegations: YieldDelegation[]
    compoundMandate: CompoundMandate | null
    signatures: Hex[]
  } | null>(null)
  const [autoCompound, setAutoCompound] = useState(false)
  const [compoundMode, setCompoundMode] = useState<CompoundMode>('agent')
  const [compoundIntervalDays, setCompoundIntervalDays] = useState(30)
  // Live on-chain allowances (Safe -> PositionManager); null = not checked yet.
  const [compoundAllowances, setCompoundAllowances] = useState<TokenAllowance[] | null>(null)
  // The operator's own cap per token — bounded, never maxUint256 (IMPLEMENTATION_PLAN.md:
  // "don't ship unbounded authority to mainnet"). Prefilled once per pool, editable after.
  const [compoundCap0, setCompoundCap0] = useState('')
  const [compoundCap1, setCompoundCap1] = useState('')
  const [approvingCompound, setApprovingCompound] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)
  // Who redeems: 'agent' delegates to an external agent wallet (a bot runs it);
  // 'manual' makes the Safe itself the delegate, so the operator redeems from the
  // Safe App (no bot, no key handoff). The choice sets the delegate at signing time.
  const [redeemMode, setRedeemMode] = useState<'hosted' | 'manual'>('hosted')
  const agentSvc = useAgentRun()
  const [fundingAgent, setFundingAgent] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemDone, setRedeemDone] = useState(false)
  const [compoundingNow, setCompoundingNow] = useState(false)
  const [compoundRedeemError, setCompoundRedeemError] = useState<string | null>(null)
  const [compoundResult, setCompoundResult] = useState<{ fees0: bigint; fees1: bigint } | null>(null)

  const recommended = pools[0] ?? null
  const pool = selectedPool ?? recommended
  // Pre-fill from the env var if the operator set one, but the user can always
  // paste a different agent address — the input is the source of truth.
  // The delegate is the wallet the service provisioned; manual mode delegates to the
  // Safe itself, so there is no address for the operator to supply either way.
  const effectiveAgent = agentSvc.agentAddress ?? ''
  const agentValid = isAddress(effectiveAgent)
  const agentAddress = agentValid ? (effectiveAgent as Address) : undefined
  const safeAddress = safe.safeAddress as Address
  // The delegate the plan is signed to: an external agent (Agent mode) or the Safe
  // itself (Manual mode, so the operator can redeem it from the Safe App).
  const delegateAddress: Address | undefined = redeemMode === 'manual' ? safeAddress : agentAddress
  const delegateReady = redeemMode === 'manual' || agentValid

  useEffect(() => {
    if (!pool) {
      setBalances(null)
      return
    }
    let cancelled = false
      ; (async () => {
        const chain = findChain(safe.chainId)
        if (!chain) return
        const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
        const [token0, token1] = await Promise.all([
          client.readContract({ address: pool.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
          client.readContract({ address: pool.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
        ])
        if (!cancelled) setBalances({ token0, token1 })
      })()
    return () => {
      cancelled = true
    }
  }, [pool, safe.chainId, safe.safeAddress, safeAddress])

  useEffect(() => {
    if (!pool || !autoCompound) {
      setCompoundAllowances(null)
      return
    }
    const positionManager = UNISWAP_V3_POSITION_MANAGER[safe.chainId]
    if (!positionManager) {
      setCompoundAllowances(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const chain = findChain(safe.chainId)
      if (!chain) return
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const safeAddress = safe.safeAddress as Address
      const allowances = await readCompoundAllowances(client, safeAddress, positionManager, [pool.token0.address, pool.token1.address])
      if (!cancelled) setCompoundAllowances(allowances)
    })()
    return () => {
      cancelled = true
    }
  }, [pool, autoCompound, safe.chainId, safe.safeAddress])

  const compoundCap0Raw = (() => {
    if (!pool || !compoundCap0) return 0n
    try { return parseUnits(compoundCap0, pool.token0.decimals) } catch { return 0n }
  })()
  const compoundCap1Raw = (() => {
    if (!pool || !compoundCap1) return 0n
    try { return parseUnits(compoundCap1, pool.token1.decimals) } catch { return 0n }
  })()
  // A token "needs" approving when the operator hasn't set a (positive) cap yet, or the
  // live allowance doesn't cover the cap they set — either way, nothing to send until
  // they type a number themselves (see compoundApproval.ts: no invented default).
  const compoundApprovalsNeeded =
    !autoCompound || !pool || !compoundAllowances
      ? null
      : compoundAllowances
          .filter((a) => {
            const cap = a.token === pool.token0.address ? compoundCap0Raw : compoundCap1Raw
            return cap === 0n || a.allowance < cap
          })
          .map((a) => a.token)

  async function handleApproveCompound() {
    if (!pool) return
    const positionManager = UNISWAP_V3_POSITION_MANAGER[safe.chainId]
    if (!positionManager || !compoundApprovalsNeeded || compoundApprovalsNeeded.length === 0) return
    setApproveError(null)
    setApprovingCompound(true)
    try {
      const amounts = compoundApprovalsNeeded.map((token) => ({
        token,
        amount: token === pool.token0.address ? compoundCap0Raw : compoundCap1Raw,
      }))
      const txs = buildCompoundApprovalTxs(positionManager, amounts)
      await sdk.txs.send({ txs })
      // The Safe's own multisig confirms + executes this asynchronously (it is a
      // real transaction, not an off-chain signature) — re-check rather than
      // assume success the moment the proposal is submitted.
      const chain = findChain(safe.chainId)
      if (chain) {
        const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
        const allowances = await readCompoundAllowances(client, safe.safeAddress as Address, positionManager, [pool.token0.address, pool.token1.address])
        setCompoundAllowances(allowances)
      }
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Failed to send the approval transaction')
    } finally {
      setApprovingCompound(false)
    }
  }

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

  // A full-range mint can only use token0/token1 in the pool's current price ratio —
  // anything else leaves one side mostly unused and can trip the mint's own slippage
  // check (uniswapPosition.ts's amount0Min/amount1Min). Typing one side auto-fills the
  // other at the pool's live price, so a manually-typed pair can't drift from it; the
  // operator can still edit the result afterward if they want to fine-tune it.
  function handleAmount0Change(raw: string) {
    const cleaned = dec(raw)
    setAmount0(cleaned)
    if (!pool || !cleaned) return
    const n = Number(cleaned)
    if (!Number.isFinite(n)) return
    const matched = n * priceOf0In1(pool)
    if (Number.isFinite(matched)) setAmount1(matched.toFixed(Math.min(pool.token1.decimals, 8)))
  }
  function handleAmount1Change(raw: string) {
    const cleaned = dec(raw)
    setAmount1(cleaned)
    if (!pool || !cleaned) return
    const n = Number(cleaned)
    const price = priceOf0In1(pool)
    if (!Number.isFinite(n) || price <= 0) return
    const matched = n / price
    if (Number.isFinite(matched)) setAmount0(matched.toFixed(Math.min(pool.token0.decimals, 8)))
  }
  // If auto-compound is on, the standing approval must be in place first — otherwise
  // the plan would sign fine but the compound agent would be permanently blocked
  // the moment it tried to harvest (see checkCompoundApprovals).
  const compoundReady = !autoCompound || compoundApprovalsNeeded?.length === 0
  const canDelegate = Boolean(
    pool && delegateAddress && amount0Raw > 0n && amount1Raw > 0n && hasBalance0 && hasBalance1 && compoundReady,
  )

  const positionValueUsd = useMemo(
    () => (pool ? estimatePositionValueUsd(pool.token0.symbol, pool.token1.symbol, amount0, amount1) : 0),
    [pool, amount0, amount1],
  )
  const projectionApr = pool?.apy ?? DEFAULT_PROJECTION_APR
  const aprIsEstimate = pool?.apy == null

  /** Prepares the plan + all delegations to sign, then signs the first one. Each
   * further signature is fired only when the operator clicks "Continue" (see
   * `signNextStep`) — see the DelegateStep comment for why this isn't automatic. */
  async function handleDelegate() {
    if (!pool || !delegateAddress) return
    setPlanError(null)
    setStoredPlan(null)
    setRedeemDone(false)
    setStep('preparing')
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error(`Unsupported chain: ${safe.chainId}`)
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)
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
        agentAddress: delegateAddress,
        environment,
        deadlineSeconds: DEADLINE_SECONDS,
      })

      // If the operator enabled auto-compound, one more standing delegation —
      // bounded to collect + increaseLiquidity on this pool's PositionManager —
      // joins the signing queue as its last step.
      let compoundMandate: CompoundMandate | null = null
      if (autoCompound) {
        const positionManager = UNISWAP_V3_POSITION_MANAGER[safe.chainId]
        if (!positionManager) throw new Error(`Uniswap PositionManager not configured for chain ${safe.chainId}`)
        compoundMandate = buildCompoundMandate({
          chainId: safe.chainId,
          agentAddress: delegateAddress,
          moduleAddress,
          safeAddress,
          positionManager,
          pool: pool.poolAddress,
          mode: compoundMode,
          intervalDays: compoundMode === 'manual' ? compoundIntervalDays : undefined,
        })
      }

      pendingSignRef.current = { plan, moduleAddress, yieldDelegations, compoundMandate, signatures: [] }
      setSigningIndex(0)
      await signStep(0)
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to build the delegation plan')
      setStep('idle')
    }
  }

  /** Signs one delegation (by index into yieldDelegations, then the compound
   * mandate last, if any) and either pauses for the operator's "Continue" or,
   * on the final step, assembles and stores the finished plan. */
  async function signStep(index: number) {
    const pending = pendingSignRef.current
    if (!pending || !delegateAddress) return
    const total = pending.yieldDelegations.length + (pending.compoundMandate ? 1 : 0)
    setPlanError(null)
    setStep('signing')
    try {
      const delegation =
        index < pending.yieldDelegations.length
          ? pending.yieldDelegations[index].delegation
          : pending.compoundMandate!.delegation
      const typedData = buildDelegationTypedData(delegation, safe.chainId)
      // sdk.txs.signTypedMessage's parameter type doesn't match our EIP-712 typed-data
      // shape (same cast as the existing CreateDelegation.tsx signing flow); its
      // resolved value is likewise typed loosely by the SDK, narrowed to the two
      // fields this app actually reads off it.
      const result = (await withTimeout(
        sdk.txs.signTypedMessage(typedData as never),
        SIGN_TIMEOUT_MS,
        `Timed out waiting for signature ${index + 1} of ${total}. Check your wallet extension for a pending request, or the Safe app's Messages tab, then try again.`,
      )) as { signature?: Hex; safeTxHash?: Hex }
      // Both fields are already hex strings from the SDK; '0x' is the empty-signature fallback.
      pending.signatures.push((result?.signature || result?.safeTxHash || '0x') as Hex)

      const nextIndex = index + 1
      if (nextIndex < total) {
        setSigningIndex(nextIndex)
        setStep('ready-for-next')
        return
      }

      let finalPlan: YieldPlanWithCompound = buildStoredYieldPlan({
        plan: pending.plan,
        yieldDelegations: pending.yieldDelegations,
        signatures: pending.signatures.slice(0, pending.yieldDelegations.length),
        chainId: safe.chainId,
        safeAddress,
        moduleAddress: pending.moduleAddress,
        agentAddress: delegateAddress,
      })
      if (pending.compoundMandate) {
        finalPlan = {
          ...finalPlan,
          compound: buildStoredCompoundDelegation({
            mandate: pending.compoundMandate,
            signature: pending.signatures[pending.yieldDelegations.length],
            chainId: safe.chainId,
            safeAddress,
            moduleAddress: pending.moduleAddress,
          }),
        }
      }
      setStoredPlan(finalPlan)
      setStep('done')
      pendingSignRef.current = null
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to sign')
      setStep('idle')
      pendingSignRef.current = null
    }
  }

  function handleContinueSigning() {
    void signStep(signingIndex)
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

  // Manual redeem: send the signed deposit delegations from the Safe App as one
  // batched Safe tx (the Safe is the delegate). Same redeemDelegations a bot would
  // send — the caveats still bound each call.
  async function handleRedeem() {
    if (!storedPlan) return
    setPlanError(null)
    setRedeeming(true)
    try {
      const txs = buildYieldRedeemTxs(storedPlan.chainId, storedPlan.delegations)
      await sdk.txs.send({ txs })
      setRedeemDone(true)
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to redeem the deposit')
    } finally {
      setRedeeming(false)
    }
  }

  // Manual compound: read the Safe's live position + owed fees, then redeem collect +
  // increaseLiquidity as one atomic Safe tx (Manual mode — the Safe is the delegate).
  // Unlike deposit, the amounts aren't known until this call (see redeemCompound.ts).

  const AGENT_GAS_ETH = '0.0015'

  /** Gas for the agent, its own Safe transaction — three redeems, so more than a
   *  limit order needs, and still the loss ceiling if the plan is never redeemed. */
  async function handleFundAgent() {
    if (!agentValid) return
    setFundingAgent(true)
    try {
      await sdk.txs.send({ txs: [{ to: effectiveAgent, value: parseEther(AGENT_GAS_ETH).toString(), data: '0x' }] })
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to fund the agent')
    } finally {
      setFundingAgent(false)
    }
  }

  /** Wait until the plan is discoverable, not merely published: the poke returns as
   *  soon as the backend has written, the graph indexes after, and an agent started in
   *  between finds nothing. Polls the path the runner itself uses. */
  async function waitForYieldIndexing(deadlineMs = 120_000): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < deadlineMs) {
      try {
        const found = await discoverIncomingDelegations(effectiveAgent as Address, safe.chainId)
        // A plan is three pinned steps; anything less is a partially-indexed plan.
        if (found.filter((d) => d.meta.calldataArgs).length >= 3) return true
      } catch {
        // transient graph error — keep polling until the deadline
      }
      await new Promise((r) => setTimeout(r, 4000))
    }
    return false
  }

  async function handleStartAgent() {
    if (!storedPlan) return
    setPlanError(null)
    setPublishing(true)
    try {
      await finalizePending(safe.chainId, safeAddress as Address)
      setPublishStatus('Waiting for the plan to be indexed…')
      if (!(await waitForYieldIndexing())) {
        setPlanError('The plan is not discoverable on Intuition yet — indexing can lag. Start the agent again in a moment.')
        return
      }
    } catch (err) {
      setPlanError(err instanceof Error ? `Could not publish the plan: ${err.message}` : 'Could not publish the plan')
      return
    } finally {
      setPublishing(false)
      setPublishStatus(null)
    }
    await agentSvc.start({
      hourglassStrategy: 'yield',
      chainId: safe.chainId,
      safe: safeAddress as Address,
      agent: effectiveAgent as Address,
    } as never)
  }

  async function handleCompoundNow() {
    if (!storedPlan?.compound || !pool) return
    const positionManager = storedPlan.compound.meta.targetAddress
    if (!positionManager) {
      setCompoundRedeemError('The compound mandate is missing its PositionManager target')
      return
    }
    setCompoundRedeemError(null)
    setCompoundingNow(true)
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error(`Unsupported chain: ${safe.chainId}`)
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const position = await findCompoundablePosition(client, positionManager, safeAddress, {
        token0: pool.token0.address,
        token1: pool.token1.address,
        fee: pool.fee,
      })
      const tx = buildCompoundRedeemTx(safe.chainId, storedPlan.compound.delegation, positionManager, safeAddress, position)
      await sdk.txs.send({ txs: [tx] })
      setCompoundResult({ fees0: position.fees0, fees1: position.fees1 })
    } catch (err) {
      setCompoundRedeemError(err instanceof Error ? err.message : 'Failed to compound')
    } finally {
      setCompoundingNow(false)
    }
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Yield</h1>
        <p className="text-dim text-sm mt-1">
          Real Uniswap v3 pools on {chainName(safe.chainId)}, ranked by fee APY and depth. Depositing needs both tokens
          in the Safe already and a signed delegation the agent redeems on its own.
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
            const share = poolValueShare(p)
            const tvlUsd = p.tvlUSD ?? share?.usdEstimate ?? null
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
                    <div className="text-sm font-semibold text-ink flex items-center gap-2 truncate">
                      {p.token0.symbol} / {p.token1.symbol}
                      <span className="text-faint font-normal">· {feeLabel(p.fee)}</span>
                      {isRecommended && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold shrink-0" style={{ color: 'var(--accent)' }}>
                          <IconCheck size={12} /> recommended
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-faint truncate">{short(p.poolAddress)}</div>
                  </div>
                </div>
                <div className="shrink-0 w-[220px]">
                  <div className="text-center font-mono text-sm font-bold text-ink tnum">
                    TVL:{' '}
                    {p.tvlUSD !== null
                      ? usdCompact.format(p.tvlUSD)
                      : tvlUsd !== null
                        ? `~${usdCompact.format(tvlUsd)}`
                        : 'insufficient data'}
                  </div>
                  {share && (
                    <>
                      <div className="h-1.5 rounded-full overflow-hidden flex bg-line mt-2">
                        <div className="h-full" style={{ width: `${share.pct0 * 100}%`, background: 'var(--accent)' }} />
                        <div className="h-full bg-line2" style={{ width: `${share.pct1 * 100}%` }} />
                      </div>
                      <div className="flex justify-between mt-1.5 text-[11px] text-faint">
                        <span>
                          {p.token0.symbol} <span className="text-ink font-semibold">{(share.pct0 * 100).toFixed(0)}%</span>
                        </span>
                        <span>
                          {p.token1.symbol} <span className="text-ink font-semibold">{(share.pct1 * 100).toFixed(0)}%</span>
                        </span>
                      </div>
                    </>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-sm text-ink tnum">{p.apy !== null ? `${(p.apy * 100).toFixed(1)}% APY` : 'insufficient data'}</div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {pool && (
        <Block title="Delegate">
          <p className="text-xs text-dim -mt-1 leading-relaxed">
            Signs 3 single-use delegations — approve {pool.token0.symbol}, approve {pool.token1.symbol}, mint a full-range
            position — each pinned to an exact, pre-built transaction. The delegate redeems them; it cannot change the
            target, method, amount, or recipient.
          </p>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] text-faint">Redeemed by</span>
            <Segmented
              options={[
                { key: 'hosted', label: 'Run it for me' },
                { key: 'manual', label: 'Manual' },
              ]}
              value={redeemMode}
              onChange={setRedeemMode}
            />
          </div>

          {redeemMode === 'hosted' ? (
            <>
              <p className="text-xs text-dim -mt-1 leading-relaxed">
                Hourglass runs the agent and holds its key. It only ever spends gas — every step is pinned to an exact
                transaction the Safe signed, so the agent cannot change the target, method, amount or recipient.
              </p>
              {agentSvc.agentAddress ? (
                <div className="flex items-center gap-2 mt-1">
                  <IconCheck size={14} />
                  <Mono className="text-xs text-dim">{short(agentSvc.agentAddress)}</Mono>
                </div>
              ) : (
                <Btn kind="secondary" onClick={() => void agentSvc.provision()} disabled={agentSvc.provisioning} className="mt-1">
                  {agentSvc.provisioning ? 'Creating the agent…' : 'Execute with an agent'}
                </Btn>
              )}
              {agentSvc.error && <p className="text-xs text-pending mt-2">{agentSvc.error}</p>}
            </>
          ) : (
            <p className="text-xs text-faint">
              Manual mode: this Safe is the delegate. After signing, you redeem the deposit yourself from the Safe App —
              no agent wallet, no key handoff.
            </p>
          )}

          <div className={delegateReady ? 'space-y-4' : 'space-y-4 opacity-40 pointer-events-none select-none'} aria-disabled={!delegateReady}>
            <p className="text-[11px] text-faint -mt-1">
              A full-range position only accepts the pool's current price ratio — typing one amount fills the other to
              match, so the mint can't revert on its own slippage check. Edit either side freely; they'll stay matched.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label={`${pool.token0.symbol} amount`} required missing={amount0Raw > 0n && !hasBalance0}>
                <input
                  type="text" inputMode="decimal"
                  value={amount0}
                  onChange={(e) => handleAmount0Change(e.target.value)}
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
                  type="text" inputMode="decimal"
                  value={amount1}
                  onChange={(e) => handleAmount1Change(e.target.value)}
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
              poolLabel={`${pool.token0.symbol}/${pool.token1.symbol} · ${feeLabel(pool.fee)}`}
              chainId={safe.chainId}
              mode={compoundMode}
              onModeChange={setCompoundMode}
              intervalDays={compoundIntervalDays}
              onIntervalChange={setCompoundIntervalDays}
              enabled={autoCompound}
              onToggle={setAutoCompound}
            />

            {autoCompound && compoundApprovalsNeeded && compoundApprovalsNeeded.length > 0 && (
              <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-ink">
                  <IconAlert size={16} /> One-time approval needed for auto-compound
                </div>
                <p className="text-xs text-dim leading-relaxed">
                  Harvesting fees pulls them back into the position via <Mono className="text-dim">increaseLiquidity</Mono>,
                  which needs a standing approval from the Safe — bounded to a cap you set (never unlimited), a real Safe
                  transaction, not a delegation, so it goes through your Safe's own signers.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label={`Approve up to (${pool.token0.symbol})`} required missing={compoundCap0 !== '' && compoundCap0Raw === 0n}>
                    <input
                      type="text" inputMode="decimal"
                      value={compoundCap0}
                      onChange={(e) => setCompoundCap0(dec(e.target.value))}
                      placeholder={amount0 ? (Number(amount0) * 10).toString() : '0.00'}
                      aria-label={`Approve up to, ${pool.token0.symbol}`}
                      className="font-mono"
                    />
                  </Field>
                  <Field label={`Approve up to (${pool.token1.symbol})`} required missing={compoundCap1 !== '' && compoundCap1Raw === 0n}>
                    <input
                      type="text" inputMode="decimal"
                      value={compoundCap1}
                      onChange={(e) => setCompoundCap1(dec(e.target.value))}
                      placeholder={amount1 ? (Number(amount1) * 10).toString() : '0.00'}
                      aria-label={`Approve up to, ${pool.token1.symbol}`}
                      className="font-mono"
                    />
                  </Field>
                </div>
                <p className="text-[11px] text-faint leading-relaxed">
                  This is a lifetime cap <Mono className="text-faint">increaseLiquidity</Mono> draws down as it reinvests
                  fees — not a per-cycle amount. Set it generously enough to cover many compounds; you can raise it again
                  later if it runs out.
                </p>
                {approveError && (
                  <div className="flex items-center gap-2 text-pending text-sm">
                    <IconAlert size={16} /> {approveError}
                  </div>
                )}
                <Btn
                  kind="primary"
                  onClick={handleApproveCompound}
                  disabled={approvingCompound || compoundCap0Raw === 0n || compoundCap1Raw === 0n}
                >
                  {approvingCompound ? 'Sending…' : 'Approve PositionManager'}
                </Btn>
              </div>
            )}

            {planError && (
              <div className="flex items-center gap-2 text-pending text-sm">
                <IconAlert size={16} /> {planError}
              </div>
            )}

            {step === 'done' && storedPlan ? (
              <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-active">
                  <IconCheck size={16} /> Plan signed — {storedPlan.compound ? '3 delegations + auto-compound' : '3 delegations'}
                  {redeemMode === 'manual' ? ' — redeem it below.' : ' ready for the agent.'}
                </div>
                <div className="text-xs text-dim">
                  {redeemMode === 'manual' ? (
                    <>Redeemer: <Mono>this Safe</Mono></>
                  ) : (
                    <>Agent wallet: <Mono>{short(storedPlan.agentAddress)}</Mono></>
                  )}
                </div>

                {redeemMode === 'hosted' ? (
                  <div className="space-y-3">
                    {/* Gas first, then start: the agent sends three redeems itself, and
                        the service refuses to start on an unfunded one. */}
                    <p className="text-xs text-dim leading-relaxed">
                      Send the agent gas, then start it. It redeems the three steps in order and stops at the first failure.
                    </p>
                    <Btn kind="ghost" size="sm" onClick={handleFundAgent} disabled={fundingAgent} className="w-full">
                      {fundingAgent ? 'Submitting…' : `Send ${AGENT_GAS_ETH} ETH for gas`}
                    </Btn>
                    <Btn
                      kind="primary"
                      size="sm"
                      onClick={handleStartAgent}
                      disabled={publishing || agentSvc.starting || agentSvc.run?.state === 'running'}
                      className="w-full"
                    >
                      {publishing ? (publishStatus ?? 'Publishing the plan…') : agentSvc.starting ? 'Starting…' : agentSvc.run ? 'Restart agent' : 'Start agent'}
                    </Btn>
                    {agentSvc.run && (
                      <div className="rounded-lg bg-raised ring-1 ring-line p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-faint">Agent</span>
                          <span className="text-[11px] font-medium text-ink">{agentSvc.run.state}</span>
                        </div>
                        {agentSvc.run.detail && <p className="text-[11px] text-dim leading-relaxed">{agentSvc.run.detail}</p>}
                      </div>
                    )}
                    {agentSvc.error && <p className="text-[11px] text-pending leading-relaxed">{agentSvc.error}</p>}
                  </div>
                ) : redeemMode === 'manual' ? (
                  redeemDone ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-active">
                        <IconCheck size={16} /> Deposit redeemed — position minted to the Safe.
                      </div>
                      {storedPlan.compound && (
                        <div className="rounded-lg bg-raised ring-1 ring-line p-3 space-y-2">
                          <div className="text-[11px] text-faint uppercase tracking-wide">Compound (manual)</div>
                          {compoundResult ? (
                            <div className="text-xs text-dim">
                              Harvested {formatUnits(compoundResult.fees0, pool.token0.decimals)} {pool.token0.symbol} +{' '}
                              {formatUnits(compoundResult.fees1, pool.token1.decimals)} {pool.token1.symbol}, reinvested into the position.
                            </div>
                          ) : (
                            <p className="text-xs text-faint">Collects owed fees and reinvests them into this position, right now.</p>
                          )}
                          {compoundRedeemError && (
                            <div className="flex items-center gap-2 text-pending text-sm">
                              <IconAlert size={16} /> {compoundRedeemError}
                            </div>
                          )}
                          <Btn kind="primary" onClick={handleCompoundNow} disabled={compoundingNow}>
                            {compoundingNow ? 'Compounding…' : 'Compound now'}
                          </Btn>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Btn kind="primary" onClick={handleRedeem} disabled={redeeming}>
                        {redeeming ? 'Redeeming…' : 'Redeem deposit'}
                      </Btn>
                      <CopyChip value={JSON.stringify(storedPlan)} label="Copy plan JSON" />
                    </div>
                  )
                ) : (
                  <div className="flex items-center gap-2">
                    <Btn kind="primary" onClick={downloadPlan}>
                      Download plan.json
                    </Btn>
                    <CopyChip value={JSON.stringify(storedPlan)} label="Copy plan JSON" />
                  </div>
                )}
              </div>
            ) : step === 'ready-for-next' ? (
              <div className="space-y-2">
                <p className="text-xs text-dim">
                  Signature {signingIndex} of {autoCompound ? 4 : 3} done. Finish with Safe's own confirmation screen
                  first (its "Continue" is fine to click), then come back and continue here — the next request only
                  fires when you do.
                </p>
                <Btn kind="primary" size="lg" onClick={handleContinueSigning}>
                  Continue — sign {signingIndex + 1} of {autoCompound ? 4 : 3}
                </Btn>
              </div>
            ) : (
              <Btn
                kind="primary"
                size="lg"
                onClick={handleDelegate}
                disabled={!canDelegate || step === 'preparing' || step === 'signing'}
              >
                {step === 'preparing'
                  ? 'Preparing…'
                  : step === 'signing'
                    ? `Signing ${signingIndex + 1} of ${autoCompound ? 4 : 3}…`
                    : 'Sign delegations'}
              </Btn>
            )}
          </div>
        </Block>
      )}
    </div>
  )
}
