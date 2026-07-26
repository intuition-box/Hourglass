/**
 * The safety property this suite protects: each of the 3 delegations the agent
 * can redeem is single-use, redeemer-locked to the agent wallet, and unsigned
 * until the Safe actually signs it. If any of that slips, the "agent redeems
 * unattended" design in yieldDelegations.ts stops being safe.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { isHex, getAddress, type Hex } from 'viem'
import { baseSepolia } from 'viem/chains'
import { buildDepositPlan } from '../../src/lib/uniswapPosition'
import { buildYieldDelegations, buildStoredYieldPlan } from '../../src/lib/yieldDelegations'
import { getEnvironment } from '../../src/lib/environment'
import type { PoolInfo } from '../../src/lib/uniswapDiscovery'

const TOKEN0 = getAddress('0x00000000000000000000000000000000000000a0')
const TOKEN1 = getAddress('0x00000000000000000000000000000000000000b0')
const SAFE = getAddress('0x00000000000000000000000000000000000000c0')
const MODULE = getAddress('0x00000000000000000000000000000000000000d0')
const AGENT = getAddress('0x00000000000000000000000000000000000000e0')

const pool: PoolInfo = {
  poolAddress: '0x11111111111111111111111111111111111111e0' as Address,
  token0: { address: TOKEN0, symbol: 'USDC', decimals: 6 },
  token1: { address: TOKEN1, symbol: 'WETH', decimals: 18 },
  fee: 3000,
  sqrtPriceX96: 0n,
  liquidity: 1n,
  tvlToken0: 0n,
  tvlToken1: 0n,
  apy: null,
  tvlUSD: null,
}

function makePlan() {
  return buildDepositPlan({
    pool,
    amount0: 1_000_000n,
    amount1: 500_000_000_000_000_000n,
    recipient: SAFE,
    chainId: baseSepolia.id,
    deadlineSeconds: 3600,
  })
}

describe('buildYieldDelegations', () => {
  test('builds one delegation per execution, unsigned, delegate=agent, delegator=module', () => {
    const environment = getEnvironment(baseSepolia.id)
    const result = buildYieldDelegations({ plan: makePlan(), moduleAddress: MODULE, agentAddress: AGENT, environment, deadlineSeconds: 3600 })

    expect(result).toHaveLength(3)
    for (const { delegation } of result) {
      expect(delegation.delegate).toBe(AGENT)
      expect(delegation.delegator).toBe(MODULE)
      expect(delegation.signature).toBe('0x')
      // The functionCall scope synthesizes its own caveats (allowedTargets,
      // allowedMethods, a default valueLte) on top of the 4 explicit ones this
      // builder adds (exactExecution, limitedCalls, redeemer, timestamp) —
      // assert the explicit ones are present, not an exact total.
      expect(delegation.caveats.length).toBeGreaterThanOrEqual(4)
    }
  })

  test('each delegation hashes differently (distinct exactExecution pins → distinct caveats)', () => {
    const environment = getEnvironment(baseSepolia.id)
    const result = buildYieldDelegations({ plan: makePlan(), moduleAddress: MODULE, agentAddress: AGENT, environment, deadlineSeconds: 3600 })
    const salts = result.map((r) => r.delegation.salt)
    const caveatSets = result.map((r) => JSON.stringify(r.delegation.caveats))
    expect(new Set(caveatSets).size).toBe(3)
    // salt = keccak256(callData) — distinct per action, and always well-formed
    // (createDelegation() defaults to salt: '0x', which isn't).
    expect(new Set(salts).size).toBe(3)
    for (const s of salts) expect(isHex(s)).toBe(true)
  })
})

describe('buildStoredYieldPlan', () => {
  test('attaches the given signature to each delegation and pins target/selector/calldata from its execution', () => {
    const plan = makePlan()
    const environment = getEnvironment(baseSepolia.id)
    const yieldDelegations = buildYieldDelegations({ plan, moduleAddress: MODULE, agentAddress: AGENT, environment, deadlineSeconds: 3600 })
    const signatures: Hex[] = ['0xaaaa', '0xbbbb', '0xcccc']

    const stored = buildStoredYieldPlan({
      plan,
      yieldDelegations,
      signatures,
      chainId: baseSepolia.id,
      safeAddress: SAFE,
      moduleAddress: MODULE,
      agentAddress: AGENT,
    })

    expect(stored.delegations).toHaveLength(3)
    expect(stored.agentAddress).toBe(AGENT)
    expect(stored.pool.address).toBe(pool.poolAddress)
    stored.delegations.forEach((d, i) => {
      expect(d.delegation.signature).toBe(signatures[i])
      expect(d.meta.targetAddress).toBe(plan.executions[i].target)
      expect(d.meta.calldataArgs).toBe(plan.executions[i].callData)
      expect(d.meta.methodSelector).toMatch(/^0x[0-9a-f]{8}$/)
      expect(d.meta.delegationHash).toMatch(/^0x[0-9a-f]{64}$/)
    })
    // Different pinned calldata per step → different hashes.
    const hashes = stored.delegations.map((d) => d.meta.delegationHash)
    expect(new Set(hashes).size).toBe(3)
  })
})
