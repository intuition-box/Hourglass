/**
 * `buildDepositPlan` produces the exact calldata that later gets pinned
 * byte-for-byte into a delegation caveat — any drift here is a security bug,
 * not just a display bug. These tests decode the built calldata back and
 * check it matches what was asked for.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { decodeFunctionData, erc20Abi, getAddress, type Address } from 'viem'
import { baseSepolia } from 'viem/chains'
import { fullRangeTicks, buildDepositPlan } from '../../src/lib/uniswapPosition'
import { UniswapV3PositionManagerABI } from '../../src/config/abis'
import { UNISWAP_V3_POSITION_MANAGER, TICK_SPACING } from '../../src/config/uniswap'
import type { PoolInfo } from '../../src/lib/uniswapDiscovery'

const TOKEN0 = getAddress('0x00000000000000000000000000000000000000a0')
const TOKEN1 = getAddress('0x00000000000000000000000000000000000000b0')
const RECIPIENT = getAddress('0x00000000000000000000000000000000000000c0')
const POSITION_MANAGER = UNISWAP_V3_POSITION_MANAGER[baseSepolia.id]

function pool(fee: number): PoolInfo {
  return {
    poolAddress: '0x11111111111111111111111111111111111111e0' as Address,
    token0: { address: TOKEN0, symbol: 'USDC', decimals: 6 },
    token1: { address: TOKEN1, symbol: 'WETH', decimals: 18 },
    fee,
    sqrtPriceX96: 0n,
    liquidity: 1n,
    tvlToken0: 0n,
    tvlToken1: 0n,
    apy: null,
    tvlUSD: null,
  }
}

describe('fullRangeTicks', () => {
  test('bounds are multiples of the fee tier tick spacing', () => {
    for (const fee of [500, 3000, 10000]) {
      const { tickLower, tickUpper } = fullRangeTicks(fee)
      const spacing = TICK_SPACING[fee]
      expect(tickLower % spacing === 0).toBe(true)
      expect(tickUpper % spacing === 0).toBe(true)
      expect(tickLower).toBeLessThan(0)
      expect(tickUpper).toBeGreaterThan(0)
    }
  })

  test('throws on an unknown fee tier', () => {
    expect(() => fullRangeTicks(1234)).toThrow()
  })
})

describe('buildDepositPlan', () => {
  test('rejects zero or negative amounts', () => {
    expect(() =>
      buildDepositPlan({ pool: pool(3000), amount0: 0n, amount1: 100n, recipient: RECIPIENT, chainId: baseSepolia.id, deadlineSeconds: 3600 }),
    ).toThrow()
  })

  test('builds approve(token0), approve(token1), mint — in that order, targeting the right contracts', () => {
    const plan = buildDepositPlan({
      pool: pool(3000),
      amount0: 1_000_000n,
      amount1: 500_000_000_000_000_000n,
      recipient: RECIPIENT,
      chainId: baseSepolia.id,
      deadlineSeconds: 3600,
    })
    const [approve0, approve1, mint] = plan.executions
    expect(approve0.target).toBe(TOKEN0)
    expect(approve1.target).toBe(TOKEN1)
    expect(mint.target).toBe(POSITION_MANAGER)
    expect(plan.executions.every((e) => e.value === 0n)).toBe(true)
  })

  test('approve calldata spends exactly the requested amount, spender is the PositionManager', () => {
    const amount0 = 1_000_000n
    const plan = buildDepositPlan({
      pool: pool(3000),
      amount0,
      amount1: 1n,
      recipient: RECIPIENT,
      chainId: baseSepolia.id,
      deadlineSeconds: 3600,
    })
    const decoded = decodeFunctionData({ abi: erc20Abi, data: plan.executions[0].callData })
    expect(decoded.functionName).toBe('approve')
    expect(decoded.args?.[0]).toBe(POSITION_MANAGER)
    expect(decoded.args?.[1]).toBe(amount0)
  })

  test('mint calldata pins recipient, pool identity, full-range ticks, and desired amounts exactly', () => {
    const amount0 = 1_000_000n
    const amount1 = 500_000_000_000_000_000n
    const fee = 500
    const plan = buildDepositPlan({
      pool: pool(fee),
      amount0,
      amount1,
      recipient: RECIPIENT,
      chainId: baseSepolia.id,
      deadlineSeconds: 3600,
    })
    const decoded = decodeFunctionData({ abi: UniswapV3PositionManagerABI, data: plan.executions[2].callData })
    const params = decoded.args?.[0] as {
      token0: Address
      token1: Address
      fee: number
      tickLower: number
      tickUpper: number
      amount0Desired: bigint
      amount1Desired: bigint
      amount0Min: bigint
      amount1Min: bigint
      recipient: Address
      deadline: bigint
    }
    const { tickLower, tickUpper } = fullRangeTicks(fee)

    expect(params.token0).toBe(TOKEN0)
    expect(params.token1).toBe(TOKEN1)
    expect(params.fee).toBe(fee)
    expect(params.tickLower).toBe(tickLower)
    expect(params.tickUpper).toBe(tickUpper)
    expect(params.amount0Desired).toBe(amount0)
    expect(params.amount1Desired).toBe(amount1)
    expect(params.recipient).toBe(RECIPIENT)
    // 5% slippage tolerance, exact bigint math (no rounding drift to test for).
    expect(params.amount0Min).toBe(amount0 - (amount0 * 500n) / 10_000n)
    expect(params.amount1Min).toBe(amount1 - (amount1 * 500n) / 10_000n)
    expect(params.amount0Min).toBeLessThan(amount0)
    expect(params.amount1Min).toBeLessThan(amount1)
  })
})
