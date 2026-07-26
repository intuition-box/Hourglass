/**
 * rankPools is the only decision logic in the discovery path — everything else
 * is on-chain reads. Pin its ordering: real APY beats no-data, and liquidity is
 * the fallback signal (and the floor) when no APY exists.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import type { Address } from 'viem'
import { rankPools, type PoolInfo } from '../../src/lib/uniswapDiscovery'

const token = (symbol: string, address: string) => ({ address: address as Address, symbol, decimals: symbol === 'USDC' ? 6 : 18 })

function pool(overrides: Partial<PoolInfo>): PoolInfo {
  return {
    poolAddress: '0x11111111111111111111111111111111111111e0' as Address,
    token0: token('USDC', '0x00000000000000000000000000000000000000a0'),
    token1: token('WETH', '0x00000000000000000000000000000000000000b0'),
    fee: 3000,
    sqrtPriceX96: 0n,
    liquidity: 1000n,
    tvlToken0: 1000n,
    tvlToken1: 1000n,
    apy: null,
    tvlUSD: null,
    ...overrides,
  }
}

describe('rankPools', () => {
  test('drops pools with zero liquidity', () => {
    const ranked = rankPools([pool({ liquidity: 0n }), pool({ liquidity: 1n })])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].liquidity).toBe(1n)
  })

  test('pools with a real APY rank above pools with none, regardless of liquidity', () => {
    const noApyButHuge = pool({ liquidity: 1_000_000n, apy: null })
    const smallApy = pool({ liquidity: 1n, apy: 0.01 })
    const ranked = rankPools([noApyButHuge, smallApy])
    expect(ranked[0]).toBe(smallApy)
    expect(ranked[1]).toBe(noApyButHuge)
  })

  test('among pools with APY, higher APY ranks first', () => {
    const low = pool({ apy: 0.02 })
    const high = pool({ apy: 0.2 })
    const ranked = rankPools([low, high])
    expect(ranked[0]).toBe(high)
    expect(ranked[1]).toBe(low)
  })

  test('among pools with no APY, deeper liquidity ranks first', () => {
    const shallow = pool({ liquidity: 10n, apy: null })
    const deep = pool({ liquidity: 10_000n, apy: null })
    const ranked = rankPools([shallow, deep])
    expect(ranked[0]).toBe(deep)
    expect(ranked[1]).toBe(shallow)
  })
})
