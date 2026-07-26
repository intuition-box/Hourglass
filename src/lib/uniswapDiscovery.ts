import { erc20Abi, formatUnits, zeroAddress, type Address, type PublicClient } from 'viem'
import { UniswapV3FactoryABI, UniswapV3PoolABI } from '../config/abis'
import { UNISWAP_V3_FACTORY, UNISWAP_V3_SUBGRAPH_ID, FEE_TIERS, CANDIDATE_TOKENS, type CandidateToken } from '../config/uniswap'

export interface PoolInfo {
  poolAddress: Address
  token0: CandidateToken
  token1: CandidateToken
  fee: number
  sqrtPriceX96: bigint
  liquidity: bigint
  /** Raw balance of token0 held by the pool — a TVL proxy, not a USD figure. */
  tvlToken0: bigint
  /** Raw balance of token1 held by the pool — a TVL proxy, not a USD figure. */
  tvlToken1: bigint
  /** Annualized fee yield estimate from the subgraph, or null if unavailable. */
  apy: number | null
  /** USD-denominated TVL from the subgraph, or null if unavailable — prefer this over tvlToken0/1 when present. */
  tvlUSD: number | null
}

/**
 * Scans every candidate-token pair × fee tier for a real, already-deployed
 * Uniswap v3 pool, and reads its current on-chain state. Skips pairs the
 * factory has no pool for (a very likely outcome on testnet) rather than
 * erroring — an empty result is a valid outcome the caller must handle.
 */
export async function discoverPools(client: PublicClient, chainId: number): Promise<PoolInfo[]> {
  const factory = UNISWAP_V3_FACTORY[chainId]
  const tokens = CANDIDATE_TOKENS[chainId]
  if (!factory || !tokens || tokens.length < 2) return []

  const pairs: [CandidateToken, CandidateToken][] = []
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) pairs.push([tokens[i], tokens[j]])
  }

  const found: PoolInfo[] = []
  for (const [a, b] of pairs) {
    for (const fee of FEE_TIERS) {
      const poolAddress = await client.readContract({
        address: factory,
        abi: UniswapV3FactoryABI,
        functionName: 'getPool',
        args: [a.address, b.address, fee],
      })
      if (poolAddress === zeroAddress) continue

      const [slot0, liquidity, token0Address] = await Promise.all([
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'slot0' }),
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'liquidity' }),
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'token0' }),
      ])
      // Pools order tokens by address, not by discovery order — resolve which
      // candidate is which side so callers get the right decimals/symbol.
      const token0 = token0Address.toLowerCase() === a.address.toLowerCase() ? a : b
      const token1 = token0 === a ? b : a

      const [tvlToken0, tvlToken1] = await Promise.all([
        client.readContract({ address: token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }),
        client.readContract({ address: token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }),
      ])

      found.push({
        poolAddress,
        token0,
        token1,
        fee,
        sqrtPriceX96: slot0[0],
        liquidity,
        tvlToken0,
        tvlToken1,
        apy: null,
        tvlUSD: null,
      })
    }
  }
  return found
}

// The only stablecoin the app's candidate-token list currently includes. Its
// balance can stand in for its USD value without an external price feed —
// this is an approximation (assumes the peg holds), not an oracle-verified figure.
const STABLECOIN_SYMBOLS = new Set(['USDC'])

export interface PoolValueShare {
  pct0: number
  pct1: number
  /**
   * The whole pool's value in USD, estimated by pricing the non-stable side
   * off the pool's own rate and using the stablecoin side's balance as its $
   * value. Null when neither token0 nor token1 is a recognized stablecoin —
   * there's then no $ anchor to convert through.
   */
  usdEstimate: number | null
}

/**
 * Price of token0 in terms of token1 (human units), from the pool's own
 * `sqrtPriceX96` — no external feed. This is the exact ratio a **full-range**
 * mint must be deposited at: Uniswap can only mint liquidity proportional to
 * the current price, so a mismatched amount0:amount1 leaves one side mostly
 * unused and can trip the mint's own slippage check (`amount0Min`/`amount1Min`
 * in `uniswapPosition.ts`) — see the Yield tab's amount-matching inputs.
 */
export function priceOf0In1(pool: Pick<PoolInfo, 'sqrtPriceX96' | 'token0' | 'token1'>): number {
  const sqrtPrice = Number(pool.sqrtPriceX96) / 2 ** 96
  return sqrtPrice * sqrtPrice * 10 ** (pool.token0.decimals - pool.token1.decimals)
}

/**
 * Each token's share of the pool's value, derived only from the pool's own
 * on-chain price (`sqrtPriceX96`) and reserves — no USD price feed needed, so
 * it works even where the subgraph doesn't (e.g. Base Sepolia). Prices token0
 * in terms of token1 and compares like-for-like, so "50/50" here means equal
 * *value*, not equal raw token counts. `Number()` on the bigints loses
 * precision past 2^53, which is fine — this feeds a percentage bar, not a
 * financial calculation. Null only if the pool has no price or no balance to
 * compare (shouldn't happen for a pool with liquidity > 0).
 */
export function poolValueShare(pool: PoolInfo): PoolValueShare | null {
  const amount0 = Number(formatUnits(pool.tvlToken0, pool.token0.decimals))
  const amount1 = Number(formatUnits(pool.tvlToken1, pool.token1.decimals))
  const value0In1 = amount0 * priceOf0In1(pool)
  const totalInToken1 = value0In1 + amount1
  if (!Number.isFinite(totalInToken1) || totalInToken1 <= 0) return null
  const pct0 = value0In1 / totalInToken1

  let usdEstimate: number | null = null
  if (STABLECOIN_SYMBOLS.has(pool.token1.symbol)) usdEstimate = totalInToken1
  else if (STABLECOIN_SYMBOLS.has(pool.token0.symbol)) usdEstimate = amount0 + amount1 / priceOf0In1(pool)

  return { pct0, pct1: 1 - pct0, usdEstimate }
}

interface LiquidityPoolQueryResult {
  totalValueLockedUSD: string
  dailySnapshots: { dailySupplySideRevenueUSD: string }[]
}

export interface PoolMetrics {
  /** Annualized fee yield (last daily LP revenue / TVL × 365), or null if unavailable. */
  apy: number | null
  /** USD-denominated TVL, or null if unavailable. */
  tvlUSD: number | null
}

const NULL_METRICS: PoolMetrics = { apy: null, tvlUSD: null }

/**
 * Best-effort TVL + fee-yield read from a Messari-standard subgraph (the
 * `liquidityPool` / `dailySnapshots` schema — NOT the original Uniswap Labs
 * `pool` / `poolDayData` schema most docs show; verified live against the
 * mapped Base subgraph before wiring this). Only chains with a mapped
 * `UNISWAP_V3_SUBGRAPH_ID` (currently Base mainnet — Base Sepolia has no
 * indexer serving one) return real data. TVL and APY are reported
 * independently: a pool can have a real `totalValueLockedUSD` with no recent
 * daily snapshot (apy stays null) — this returns nulls rather than a
 * fabricated number whenever the chain has no subgraph, the key is unset, the
 * endpoint is unreachable, or the pool has no rows there.
 */
export async function fetchPoolMetrics(poolAddress: Address, chainId: number): Promise<PoolMetrics> {
  const subgraphId = UNISWAP_V3_SUBGRAPH_ID[chainId]
  if (!subgraphId) return NULL_METRICS

  const apiKey = import.meta.env.VITE_THEGRAPH_API_KEY
  if (!apiKey) return NULL_METRICS

  const url = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: `{ liquidityPool(id: "${poolAddress.toLowerCase()}") { totalValueLockedUSD dailySnapshots(first: 1, orderBy: day, orderDirection: desc) { dailySupplySideRevenueUSD } } }`,
      }),
    })
    if (!res.ok) {
      console.error('[fetchPoolMetrics] HTTP', res.status, await res.text())
      return NULL_METRICS
    }
    const json = (await res.json()) as { data?: { liquidityPool?: LiquidityPoolQueryResult }; errors?: unknown }
    if (json.errors) {
      console.error('[fetchPoolMetrics] GraphQL errors', json.errors)
      return NULL_METRICS
    }
    const lp = json.data?.liquidityPool
    if (!lp) {
      console.error('[fetchPoolMetrics] no liquidityPool for', poolAddress, json)
      return NULL_METRICS
    }
    const tvlUSD = Number(lp.totalValueLockedUSD)
    if (!Number.isFinite(tvlUSD) || tvlUSD <= 0) return NULL_METRICS
    const dailyRevenueUSD = Number(lp.dailySnapshots?.[0]?.dailySupplySideRevenueUSD)
    const apy = Number.isFinite(dailyRevenueUSD) && dailyRevenueUSD >= 0 ? (dailyRevenueUSD / tvlUSD) * 365 : null
    return { apy, tvlUSD }
  } catch (err) {
    console.error('[fetchPoolMetrics] fetch threw', err)
    return NULL_METRICS
  }
}

/**
 * Ranks pools for the recommendation: real APY first (best information wins),
 * falling back to liquidity as the safety/depth signal when no APY data
 * exists — which, on a testnet, is the common case.
 */
export function rankPools(pools: PoolInfo[]): PoolInfo[] {
  return [...pools]
    .filter((p) => p.liquidity > 0n)
    .sort((a, b) => {
      if (a.apy !== null && b.apy !== null) return b.apy - a.apy
      if (a.apy !== null) return -1
      if (b.apy !== null) return 1
      return b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0
    })
}
