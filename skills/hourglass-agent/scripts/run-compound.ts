/**
 * Hourglass compound agent — self-contained runner (no repo imports).
 *
 * Harvests a Uniswap v3 LP position's fees and reinvests them into the SAME
 * position, under the standing compound mandate the Safe signed in the Yield tab.
 * The mandate is a functionCall delegation over the PositionManager, methods
 * `collect` + `increaseLiquidity` only, redeemer-locked to this agent — so the
 * agent can harvest and re-add, never withdraw principal.
 *
 * Flow: load the signed mandate from the yield-plan JSON (the file the Yield tab
 * downloads; compound mandates are not published on Intuition — the plan file is
 * their transport, same as scripts/yield-agent.ts), discover the Safe's position
 * tokenId in the PositionManager, read live economics (position value, accrued
 * fees, gas), gate the compound with the same optimizer the app card shows, then
 * redeem collect + increaseLiquidity in one atomic redeemDelegations — executed
 * AS THE SAFE.
 *
 * Economics assumptions (all decision-only, never execution amounts):
 *   - Everything is valued in the pool's token1 ("quote units") via the pool's
 *     own spot price — units cancel in the compound-vs-gas comparison.
 *   - APR is observed from the position's own fee accrual between polls (accrued
 *     fees / principal, annualized). No subgraph dependency. First poll only
 *     observes; override with APR_OVERRIDE (annual fraction, e.g. 0.05) to skip.
 *   - Gas = live gasPrice x a fixed unit estimate, converted ETH -> quote via the
 *     pool price when one side is WETH, else via ETH_PRICE_IN_QUOTE.
 *
 * One-time setup the mandate cannot do for you: `collect` pays the fees to the
 * Safe, and `increaseLiquidity` pulls them back FROM the Safe — so the Safe must
 * hold a standing ERC20 approval to the PositionManager for BOTH pool tokens.
 * (The yield plan's approve steps are sized for the mint and are consumed by it.)
 * The runner preflights the allowances every cycle and refuses to redeem, with
 * instructions, until they are in place.
 *
 * Mode and (for manual) the compound interval are read from the plan's
 * salt-verified `compound.terms` — no env var. The salt binds them to the
 * signature, so a tampered plan file is rejected at startup.
 *
 * Env: AGENT_PRIVATE_KEY, optional RPC_URL, optional POLL_SECONDS (default 3600),
 *      optional MAX_POLLS (0 = run forever), optional MAX_REVERTS (default 5),
 *      optional APR_OVERRIDE, ETH_PRICE_IN_QUOTE (required only when neither pool
 *      token is WETH). Usage: bun run-compound.ts <yield-plan.json>
 *
 * Dependency: viem, @metamask/smart-accounts-kit. Node >= 20 (global fetch).
 */
import { readFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, erc20Abi, isAddress,
  encodeFunctionData, keccak256, encodePacked, encodeAbiParameters, toHex, toBytes,
  type Address, type Hex, type Chain, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { mainnet, base, baseSepolia, sepolia } from 'viem/chains'
import { createExecution, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit'
import { encodePermissionContexts, encodeExecutionCalldatas } from '@metamask/smart-accounts-kit/utils'

// --- constants (verified against the Hourglass repo) --------------------------

const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

const CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [sepolia.id]: sepolia,
}

const WETH: Record<number, Address> = {
  [mainnet.id]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  [base.id]: '0x4200000000000000000000000000000000000006',
  [baseSepolia.id]: '0x4200000000000000000000000000000000000006',
  [sepolia.id]: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
}

const MAX_UINT128 = (1n << 128n) - 1n
// Ballpark units for one redeem (DelegationManager -> module -> Safe -> collect +
// increaseLiquidity). Decision-only: it prices the compound-vs-gas gate; the actual
// tx is estimated by the node at send time.
const COMPOUND_GAS_UNITS = 750_000n
const HORIZON_DAYS = 365
const DAYS_PER_YEAR = 365
const MS_PER_DAY = 86_400_000
// Minimum fee-accrual observation window before trusting an APR estimate.
const MIN_APR_WINDOW_MS = 5 * 60_000
const INCREASE_DEADLINE_SECONDS = 900

// --- types --------------------------------------------------------------------

interface Caveat { enforcer: Address; terms: Hex }
interface DelegationStruct {
  delegate: Address; delegator: Address; authority: Hex
  caveats: Caveat[]; salt: Hex; signature: Hex
}

type CompoundMode = 'agent' | 'manual'

/** The salt-verifiable terms exported next to the delegation (see
 * src/lib/compoundDelegation.ts CompoundTerms). `hashCompoundTerms(terms)` must
 * equal the signed delegation salt — that binding is what lets the runner trust
 * `mode`/`intervalDays` from the plan file instead of an out-of-band env var. */
interface CompoundTermsExport {
  schema: string
  chainId: number
  agent: Address
  module: Address
  safe: Address
  positionManager: Address
  pool: Address
  mode: CompoundMode
  intervalDays: number | null
}

/** The `compound` entry of the yield-plan JSON (StoredCompoundDelegation in the app). */
interface StoredCompoundMandate {
  delegation: DelegationStruct
  meta: { label: string; delegationHash?: Hex; targetAddress?: Address }
  terms?: CompoundTermsExport
}

interface PlanPool { address: Address; token0: Address; token1: Address; fee: number }

/** The yield-plan JSON the Yield tab downloads (StoredYieldPlan + compound). */
interface YieldPlan {
  chainId: number
  safeAddress: Address
  agentAddress: Address
  pool: PlanPool
  compound?: StoredCompoundMandate
}

// --- delegation hash (must match the repo exactly) ----------------------------

const DELEGATION_TYPEHASH = keccak256(
  toHex('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'),
)
const CAVEAT_TYPEHASH = keccak256(toHex('Caveat(address enforcer,bytes terms)'))

function computeDelegationHash(d: DelegationStruct): Hex {
  const caveatHashes = d.caveats.map((c) =>
    keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)],
    )),
  )
  const caveatsHash = keccak256(encodePacked(caveatHashes.map(() => 'bytes32'), caveatHashes))
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, caveatsHash, BigInt(d.salt)],
  ))
}

// --- terms hash (must match src/lib/subscriptionTerms.ts canonicalize exactly) --

/** Recursively sort object keys (arrays keep order), so the JSON is deterministic. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** Salt of a compound mandate: keccak256 of the canonical (sorted-key) terms JSON.
 * Mirrors hashCompoundTerms in src/lib/compoundDelegation.ts — must stay in sync. */
function hashCompoundTerms(terms: CompoundTermsExport): Hex {
  return keccak256(toBytes(JSON.stringify(sortDeep(terms))))
}

// --- ABIs (inlined — only what this runner calls) -----------------------------

const POSITION_MANAGER_ABI = [
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'positions', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function', name: 'collect', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'amount0Max', type: 'uint128' },
        { name: 'amount1Max', type: 'uint128' },
      ],
    }],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
  },
  {
    type: 'function', name: 'increaseLiquidity', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'amount0Desired', type: 'uint256' },
        { name: 'amount1Desired', type: 'uint256' },
        { name: 'amount0Min', type: 'uint256' },
        { name: 'amount1Min', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
] as const

const POOL_ABI = [
  {
    type: 'function', name: 'slot0', stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const

const REDEEM_DELEGATIONS_ABI = [
  {
    type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const

// --- the decision core (inlined from src/lib/compounding.ts — keep in sync) ---

interface EconomicsConfig { principal: number; apr: number; gasCost: number }

function projectSimpleValue(config: EconomicsConfig, horizonDays: number): number {
  return config.principal * (1 + (config.apr * horizonDays) / DAYS_PER_YEAR)
}

function projectManualValue(config: EconomicsConfig, days: number, intervalDays: number): number {
  const interval = Math.max(1, Math.floor(intervalDays))
  let principal = config.principal
  let accrued = 0
  for (let d = 1; d <= days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    if (d % interval === 0 && accrued > 0) {
      principal += accrued - config.gasCost
      accrued = 0
    }
  }
  return principal + accrued
}

/**
 * The agent's optimal cadence: the fixed interval whose daily simulation maximizes
 * final value against gas, with "never compound" as the baseline (Infinity). Same
 * search as the app card's projectAgentOptimal, so agent and card agree.
 */
function optimalIntervalDays(config: EconomicsConfig, horizonDays: number): number {
  const days = Math.floor(horizonDays)
  let bestValue = projectSimpleValue(config, days)
  let bestInterval = Infinity
  for (let interval = 1; interval <= days; interval += 1) {
    const value = projectManualValue(config, days, interval)
    if (value > bestValue) {
      bestValue = value
      bestInterval = interval
    }
  }
  return bestInterval
}

interface PositionEconomics extends EconomicsConfig { daysSinceLastCompound: number }

function isCompoundDue(
  econ: PositionEconomics,
  mode: CompoundMode,
  intervalDays: number | null,
): { due: boolean; targetIntervalDays: number } {
  const targetIntervalDays =
    mode === 'agent' ? optimalIntervalDays(econ, HORIZON_DAYS) : (intervalDays ?? Infinity)
  const due = Number.isFinite(targetIntervalDays) && econ.daysSinceLastCompound >= targetIntervalDays
  return { due, targetIntervalDays }
}

// --- position discovery -------------------------------------------------------

interface PositionInfo { tokenId: bigint; tickLower: number; tickUpper: number; liquidity: bigint }

/** The Safe's active LP position in the mandate's pool (balanceOf + enumeration). */
async function findPosition(
  client: PublicClient, positionManager: Address, safe: Address, pool: PlanPool,
): Promise<PositionInfo> {
  const balance = await client.readContract({
    address: positionManager, abi: POSITION_MANAGER_ABI, functionName: 'balanceOf', args: [safe],
  })
  const matches: PositionInfo[] = []
  for (let i = 0n; i < balance; i += 1n) {
    const tokenId = await client.readContract({
      address: positionManager, abi: POSITION_MANAGER_ABI, functionName: 'tokenOfOwnerByIndex', args: [safe, i],
    })
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = await client.readContract({
      address: positionManager, abi: POSITION_MANAGER_ABI, functionName: 'positions', args: [tokenId],
    })
    if (
      token0.toLowerCase() === pool.token0.toLowerCase() &&
      token1.toLowerCase() === pool.token1.toLowerCase() &&
      fee === pool.fee &&
      liquidity > 0n
    ) {
      matches.push({ tokenId, tickLower, tickUpper, liquidity })
    }
  }
  if (matches.length === 0) {
    throw new Error(`Safe ${safe} holds no active position for pool ${pool.address} yet — has the yield agent minted it?`)
  }
  // The mandate isn't pinned to a tokenId (it's signed before the mint exists), so
  // compound the newest active position in the mandate's pool — the plan's mint.
  matches.sort((a, b) => (a.tokenId < b.tokenId ? 1 : -1))
  if (matches.length > 1) {
    console.log(`  note: ${matches.length} active positions in this pool — compounding the newest (#${matches[0].tokenId})`)
  }
  return matches[0]
}

// --- live economics -----------------------------------------------------------

/**
 * Float Uniswap v3 amounts for (liquidity, range) at spot sqrt price — raw token
 * units. Decision-only: feeds the economics model, never an execution amount.
 */
function positionAmountsRaw(
  liquidity: number, tickLower: number, tickUpper: number, sqrtP: number,
): { amount0: number; amount1: number } {
  const sqrtA = Math.pow(1.0001, tickLower / 2)
  const sqrtB = Math.pow(1.0001, tickUpper / 2)
  if (sqrtP <= sqrtA) return { amount0: (liquidity * (sqrtB - sqrtA)) / (sqrtA * sqrtB), amount1: 0 }
  if (sqrtP >= sqrtB) return { amount0: 0, amount1: liquidity * (sqrtB - sqrtA) }
  return {
    amount0: (liquidity * (sqrtB - sqrtP)) / (sqrtP * sqrtB),
    amount1: liquidity * (sqrtP - sqrtA),
  }
}

/** How ETH-denominated gas is converted into the pool's quote units. */
type GasQuoteBasis =
  | { kind: 'token0-weth' }
  | { kind: 'token1-weth' }
  | { kind: 'eth-price'; ethPriceInQuote: number }

// --- execute ------------------------------------------------------------------

function buildCompoundExecutions(
  positionManager: Address, tokenId: bigint, safe: Address, fees0: bigint, fees1: bigint,
): { target: Address; value: bigint; callData: Hex }[] {
  const collect = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'collect',
    args: [{ tokenId, recipient: safe, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  })
  // Desired = the fees just simulated; mins = 0 because collect and increase run in
  // the SAME tx (no inter-tx drift) and the pool consumes fee-sized amounts at spot
  // — any in-tx price impact is bounded by fee dust, and the unconsumed side stays
  // in the Safe. A nonzero min would only add spurious reverts.
  const increase = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'increaseLiquidity',
    args: [{
      tokenId,
      amount0Desired: fees0,
      amount1Desired: fees1,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + INCREASE_DEADLINE_SECONDS),
    }],
  })
  return [
    { target: positionManager, value: 0n, callData: collect },
    { target: positionManager, value: 0n, callData: increase },
  ]
}

function buildRedeemCalldata(
  d: DelegationStruct,
  executions: { target: Address; value: bigint; callData: Hex }[],
): Hex {
  const sdkDelegation: Delegation = {
    delegate: d.delegate, delegator: d.delegator, authority: d.authority,
    // The SDK's Delegation carries a per-caveat `args` field the stored shape
    // doesn't — '0x' because none of this mandate's caveats consume redemption args.
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' as Hex })),
    salt: d.salt, signature: d.signature,
  }
  // Each compound is two calls (collect, then increaseLiquidity) redeeming the same
  // standing mandate sequentially — the delegation allows both methods and is
  // repeatable. Batch mode is avoided: functionCall caveats are per-execution.
  const sdkExecutions = executions.map((e) => createExecution({ target: e.target, value: e.value, callData: e.callData }))
  return encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [
      encodePermissionContexts(sdkExecutions.map(() => [sdkDelegation])),
      sdkExecutions.map(() => ExecutionMode.SingleDefault),
      encodeExecutionCalldatas(sdkExecutions.map((e) => [e])),
    ],
  })
}

/** Pool tokens whose Safe -> PositionManager allowance can't cover the harvest. */
async function missingApprovals(
  client: PublicClient, safe: Address, positionManager: Address,
  needs: { token: Address; amount: bigint }[],
): Promise<Address[]> {
  const out: Address[] = []
  for (const { token, amount } of needs) {
    if (amount === 0n) continue
    const allowance = await client.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [safe, positionManager],
    })
    if (allowance < amount) out.push(token)
  }
  return out
}

// --- runner -------------------------------------------------------------------

type Outcome = 'compounded' | 'waiting' | 'observing' | 'blocked' | 'reverted'

interface RunContext {
  publicClient: PublicClient
  walletClient: WalletClient
  chain: Chain
  account: PrivateKeyAccount
  safe: Address
  positionManager: Address
  pool: PlanPool
  delegation: DelegationStruct
  mode: CompoundMode
  intervalDays: number | null
  aprOverride: number | null
  gasBasis: GasQuoteBasis
  quoteDecimals: number
}

interface RunState {
  aprSample: { atMs: number; accruedQuote: number } | null
  apr: number | null
  lastCompoundAtMs: number | null
}

async function runOnce(ctx: RunContext, state: RunState): Promise<Outcome> {
  const { publicClient } = ctx
  const position = await findPosition(publicClient, ctx.positionManager, ctx.safe, ctx.pool)

  const [sqrtPriceX96] = await publicClient.readContract({
    address: ctx.pool.address, abi: POOL_ABI, functionName: 'slot0',
  })
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96
  const price1per0 = sqrtP * sqrtP
  const toQuote = (raw0: number, raw1: number) => (raw0 * price1per0 + raw1) / 10 ** ctx.quoteDecimals

  const { amount0, amount1 } = positionAmountsRaw(Number(position.liquidity), position.tickLower, position.tickUpper, sqrtP)
  const principal = toQuote(amount0, amount1)

  // Total collectible fees right now: a static collect(max) as the owner. This
  // includes fee growth not yet flushed into tokensOwed, unlike positions().
  const { result: feeAmounts } = await publicClient.simulateContract({
    address: ctx.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'collect',
    args: [{ tokenId: position.tokenId, recipient: ctx.safe, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    account: ctx.safe,
  })
  const [fees0, fees1] = feeAmounts
  const accrued = toQuote(Number(fees0), Number(fees1))

  if (ctx.aprOverride !== null) {
    state.apr = ctx.aprOverride
  } else {
    const nowMs = Date.now()
    if (state.aprSample === null || accrued < state.aprSample.accruedQuote) {
      // First look, or fees shrank (someone collected outside this run): re-anchor.
      state.aprSample = { atMs: nowMs, accruedQuote: accrued }
      if (state.apr === null) {
        console.log('  observing fee accrual — need a second poll to estimate APR (or set APR_OVERRIDE)')
        return 'observing'
      }
    } else {
      const elapsedMs = nowMs - state.aprSample.atMs
      if (elapsedMs >= MIN_APR_WINDOW_MS && principal > 0) {
        state.apr = ((accrued - state.aprSample.accruedQuote) / principal) * ((DAYS_PER_YEAR * MS_PER_DAY) / elapsedMs)
      } else if (state.apr === null) {
        return 'observing'
      }
    }
  }

  const apr = state.apr
  if (apr === null || principal <= 0) {
    console.log('  waiting: no usable APR / empty position')
    return 'waiting'
  }

  const gasPrice = await publicClient.getGasPrice()
  const gasWei = Number(gasPrice * COMPOUND_GAS_UNITS)
  const gasQuote =
    ctx.gasBasis.kind === 'token0-weth' ? toQuote(gasWei, 0)
    : ctx.gasBasis.kind === 'token1-weth' ? toQuote(0, gasWei)
    : (gasWei / 1e18) * ctx.gasBasis.ethPriceInQuote

  // Days since the last compound: wall clock once this run has compounded; before
  // that, implied from the fees themselves (collect zeroes them, so accrued fees
  // ARE the accrual since the last harvest).
  const dailyAccrual = (principal * apr) / DAYS_PER_YEAR
  const daysSince = state.lastCompoundAtMs !== null
    ? (Date.now() - state.lastCompoundAtMs) / MS_PER_DAY
    : dailyAccrual > 0 ? accrued / dailyAccrual : 0

  const econ: PositionEconomics = { principal, apr, gasCost: gasQuote, daysSinceLastCompound: daysSince }
  const { due, targetIntervalDays } = isCompoundDue(econ, ctx.mode, ctx.intervalDays)

  console.log(`  position #${position.tokenId}: principal ${principal.toFixed(2)}, fees ${accrued.toFixed(6)}, apr ${(apr * 100).toFixed(2)}%, gas ${gasQuote.toFixed(6)} (quote units)`)
  if (!due) {
    const target = Number.isFinite(targetIntervalDays) ? `${targetIntervalDays}d` : 'never (gas beats the yield)'
    console.log(`  waiting: ${daysSince.toFixed(2)}d of accrual < target interval ${target}`)
    return 'waiting'
  }
  if (fees0 === 0n && fees1 === 0n) {
    console.log('  waiting: nothing to harvest')
    return 'waiting'
  }

  const missing = await missingApprovals(publicClient, ctx.safe, ctx.positionManager, [
    { token: ctx.pool.token0, amount: fees0 },
    { token: ctx.pool.token1, amount: fees1 },
  ])
  if (missing.length > 0) {
    console.error(`  blocked: the Safe has not approved the PositionManager for ${missing.join(', ')}.`)
    console.error(`  One-time setup: from the Safe, approve(${ctx.positionManager}, amount) on each pool token so increaseLiquidity can pull the harvested fees.`)
    return 'blocked'
  }

  const executions = buildCompoundExecutions(ctx.positionManager, position.tokenId, ctx.safe, fees0, fees1)
  const data = buildRedeemCalldata(ctx.delegation, executions)
  try {
    // Preflight: surface a caveat/allowance/slippage revert before paying gas.
    await publicClient.call({ account: ctx.account.address, to: DELEGATION_MANAGER, data })
    const hash = await ctx.walletClient.sendTransaction({
      account: ctx.account, chain: ctx.chain, to: DELEGATION_MANAGER, data,
    })
    console.log('  redeemed:', hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      console.error('  reverted on-chain in block', receipt.blockNumber)
      return 'reverted'
    }
    console.log('  compounded in block', receipt.blockNumber)
    state.lastCompoundAtMs = Date.now()
    state.aprSample = null // fees are zeroed — start a fresh observation window
    return 'compounded'
  } catch (err) {
    console.error('  redeem failed:', err instanceof Error ? err.message : err)
    return 'reverted'
  }
}

// --- main ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is not set`); process.exit(1) }
  return v
}

function requirePositiveNumberEnv(name: string): number {
  const n = Number(requireEnv(name))
  if (!Number.isFinite(n) || n <= 0) { console.error(`${name} must be a positive number`); process.exit(1) }
  return n
}

function optionalNumberEnv(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) { console.error(`${name} is not a number: ${raw}`); process.exit(1) }
  return n
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main() {
  const [file] = process.argv.slice(2)
  if (!file) { console.error('usage: bun run-compound.ts <yield-plan.json>'); process.exit(1) }
  // Boundary parse — every field this runner uses is validated explicitly below.
  const plan = JSON.parse(readFileSync(file, 'utf8')) as YieldPlan
  if (!isAddress(plan.safeAddress ?? '')) throw new Error(`invalid safeAddress in the plan: ${plan.safeAddress}`)
  if (!plan.pool || !isAddress(plan.pool.address ?? '')) throw new Error('invalid pool in the plan')
  const compound = plan.compound
  if (!compound?.delegation) {
    console.error('This plan has no auto-compound mandate — enable auto-compound in the Yield tab and re-sign the plan.')
    process.exit(1)
  }

  const chain = CHAINS[plan.chainId]
  if (!chain) throw new Error(`Unsupported chain: ${plan.chainId}`)

  const delegation = compound.delegation
  if (!delegation.signature || delegation.signature === '0x') throw new Error('The compound mandate in this plan is unsigned')
  if (compound.meta.delegationHash) {
    const computed = computeDelegationHash(delegation)
    if (computed.toLowerCase() !== compound.meta.delegationHash.toLowerCase()) {
      throw new Error(`mandate hash mismatch (computed ${computed}, stored ${compound.meta.delegationHash}) — the plan file is corrupted`)
    }
  }
  const positionManager = compound.meta.targetAddress
  if (!positionManager || !isAddress(positionManager)) {
    throw new Error('The compound mandate is missing meta.targetAddress (the PositionManager it whitelists)')
  }

  // Mode + interval come from the salt-verified terms exported in the plan (the
  // recap pattern from the DCA/limit-order rails) — no out-of-band env var. The
  // salt binds these to the signature, so a tampered file is rejected here.
  const terms = compound.terms
  if (!terms) {
    throw new Error('The compound mandate has no exported terms — re-sign the plan in the Yield tab (older plans predate salt-verified terms).')
  }
  const termsSalt = hashCompoundTerms(terms)
  if (termsSalt.toLowerCase() !== delegation.salt.toLowerCase()) {
    throw new Error(`compound terms do not match the signed salt (terms hash ${termsSalt}, delegation salt ${delegation.salt}) — the plan file is tampered or malformed`)
  }
  if (terms.positionManager.toLowerCase() !== positionManager.toLowerCase()) {
    throw new Error(`terms.positionManager (${terms.positionManager}) disagrees with the whitelisted target (${positionManager})`)
  }
  const mode = terms.mode
  const intervalDays = mode === 'manual' ? terms.intervalDays : null
  if (mode === 'manual' && !(intervalDays && intervalDays > 0)) {
    throw new Error('manual-mode mandate is missing a positive intervalDays in its terms')
  }

  const privateKey = requireEnv('AGENT_PRIVATE_KEY') as Hex // hex-validated by privateKeyToAccount below
  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== delegation.delegate.toLowerCase()) {
    throw new Error(`AGENT_PRIVATE_KEY (${account.address}) does not match the mandate's delegate (${delegation.delegate})`)
  }

  const rpc = process.env.RPC_URL
  const pollSeconds = optionalNumberEnv('POLL_SECONDS') ?? 3600
  const maxPolls = optionalNumberEnv('MAX_POLLS') ?? 0 // 0 = run forever
  const maxReverts = optionalNumberEnv('MAX_REVERTS') ?? 5
  const aprOverride = optionalNumberEnv('APR_OVERRIDE')

  const weth = WETH[plan.chainId]
  const gasBasis: GasQuoteBasis =
    weth && plan.pool.token1.toLowerCase() === weth.toLowerCase() ? { kind: 'token1-weth' }
    : weth && plan.pool.token0.toLowerCase() === weth.toLowerCase() ? { kind: 'token0-weth' }
    : { kind: 'eth-price', ethPriceInQuote: requirePositiveNumberEnv('ETH_PRICE_IN_QUOTE') }

  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as PublicClient
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) })
  const quoteDecimals = await publicClient.readContract({
    address: plan.pool.token1, abi: erc20Abi, functionName: 'decimals',
  })

  console.log(`Compound agent ${account.address} on chain ${plan.chainId}`)
  console.log(`  mandate: ${compound.meta.label} — PositionManager ${positionManager}, pool ${plan.pool.address}`)
  console.log(mode === 'agent' ? '  mode: agent (optimizer-gated)' : `  mode: manual (every ${intervalDays}d)`)

  const ctx: RunContext = {
    publicClient, walletClient, chain, account,
    safe: plan.safeAddress, positionManager, pool: plan.pool,
    delegation, mode, intervalDays, aprOverride, gasBasis, quoteDecimals,
  }
  const state: RunState = { aprSample: null, apr: null, lastCompoundAtMs: null }

  let consecutiveReverts = 0
  let polls = 0
  for (;;) {
    polls += 1
    let outcome: Outcome
    try {
      outcome = await runOnce(ctx, state)
    } catch (err) {
      // Read-side failures (RPC hiccup, position not minted yet) — retry, not revert.
      console.error('  skipped:', err instanceof Error ? err.message : err)
      outcome = 'waiting'
    }
    if (outcome === 'reverted') {
      consecutiveReverts += 1
      if (consecutiveReverts >= maxReverts) {
        throw new Error(`Circuit breaker: ${consecutiveReverts} consecutive reverts — stopping.`)
      }
    } else {
      consecutiveReverts = 0
    }
    if (maxPolls > 0 && polls >= maxPolls) { console.log('Max polls reached — stopping.'); return }
    await sleep(pollSeconds * 1000)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
