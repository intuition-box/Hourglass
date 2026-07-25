/**
 * The properties this suite protects:
 *   1. Auto-compound is NEVER worse than holding (the gate only fires when the
 *      reinvested fees earn back more than the gas). A regression here is exactly
 *      the "-$48.91 extra" bug this replaced.
 *   2. The cadence scales: a small / low-APR position waits, a large / high-APR one
 *      compounds often.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import {
  dailyAccrual,
  costPerCompound,
  compoundBenefit,
  compoundThreshold,
  shouldCompound,
  nextCompoundEstimateDays,
  projectSimple,
  projectCompounded,
  projectManual,
  projectAgentOptimal,
  projectionCurve,
  type CompoundingConfig,
} from '../../src/lib/compounding'

const GAS = 0.15
const cfg = (principal: number, apr: number): CompoundingConfig => ({ principal, apr, gasCost: GAS })

describe('accrual and cost', () => {
  test('dailyAccrual is principal * apr / 365', () => {
    expect(dailyAccrual(cfg(6000, 0.05))).toBeCloseTo((6000 * 0.05) / 365, 6)
  })
  test('costPerCompound sums gas and fixed fee', () => {
    expect(costPerCompound(cfg(6000, 0.05))).toBeCloseTo(0.15, 6)
    expect(costPerCompound({ ...cfg(6000, 0.05), fixedFee: 0.05 })).toBeCloseTo(0.2, 6)
  })
})

describe('the benefit-aware gate', () => {
  const c = cfg(6000, 0.05) // threshold over 365d = 0.15 / (0.05 * 1) = $3

  test('marginal benefit is accrued * apr * remaining/year', () => {
    expect(compoundBenefit(100, 365, c)).toBeCloseTo(5, 6) // 100 * 0.05 * 1
    expect(compoundBenefit(100, 182.5, c)).toBeCloseTo(2.5, 6)
  })

  test('fires only when benefit beats gas over the remaining horizon', () => {
    expect(compoundThreshold(c, 365)).toBeCloseTo(3, 6)
    expect(shouldCompound(2.99, 365, c)).toBe(false)
    expect(shouldCompound(3.01, 365, c)).toBe(true)
    expect(shouldCompound(0, 365, c)).toBe(false)
  })

  test('near the end of the horizon it takes far more accrued to justify gas', () => {
    // 10 days left: threshold = 0.15 / (0.05 * 10/365) ~= $109.5
    expect(compoundThreshold(c, 10)).toBeGreaterThan(100)
    expect(shouldCompound(3, 10, c)).toBe(false) // would have fired with 365 left
  })

  test('a zero-APR position never compounds', () => {
    expect(shouldCompound(1000, 365, cfg(6000, 0))).toBe(false)
  })
})

describe('never at a loss — auto-compound >= hold', () => {
  const cases: [string, number, number][] = [
    ['user: $6000 @ 5%', 6000, 0.05],
    ['$6000 @ 20%', 6000, 0.2],
    ['$6000 @ 50%', 6000, 0.5],
    ['$1M @ 5%', 1_000_000, 0.05],
    ['tiny $200 @ 5%', 200, 0.05],
  ]
  for (const [name, principal, apr] of cases) {
    test(name, () => {
      const c = cfg(principal, apr)
      const hold = projectSimple(c, 365)
      const auto = projectCompounded(c, 365)
      expect(auto.finalValue).toBeGreaterThanOrEqual(hold - 1e-6) // never below hold
    })
  }
})

describe('cadence scales with size and APR', () => {
  test('a tiny position waits (few or no compounds)', () => {
    const { compounds } = projectCompounded(cfg(200, 0.05), 365)
    expect(compounds).toBeLessThan(5)
  })
  test('a high-APR position compounds often', () => {
    const { compounds } = projectCompounded(cfg(6000, 0.5), 365)
    expect(compounds).toBeGreaterThan(100)
  })
  test('higher APR => more uplift over hold', () => {
    const lowUplift = projectCompounded(cfg(6000, 0.05), 365).finalValue - projectSimple(cfg(6000, 0.05), 365)
    const highUplift = projectCompounded(cfg(6000, 0.5), 365).finalValue - projectSimple(cfg(6000, 0.5), 365)
    expect(highUplift).toBeGreaterThan(lowUplift)
  })
  test('effectiveApr >= nominal apr (compounding never drags it down)', () => {
    const { effectiveApr } = projectCompounded(cfg(6000, 0.2), 365)
    expect(effectiveApr).toBeGreaterThanOrEqual(0.2 - 1e-9)
  })
})

describe('manual (fixed-schedule) mode', () => {
  const c = cfg(6000, 0.05)
  test('a too-tight schedule can lose to gas (unlike the agent gate)', () => {
    const hold = projectSimple(c, 365)
    const weekly = projectManual(c, 365, 7)
    // agent never dips below hold; a fixed weekly schedule at 5% can, and that is
    // exactly what the card surfaces in red.
    expect(projectCompounded(c, 365).finalValue).toBeGreaterThanOrEqual(hold - 1e-6)
    expect(weekly.finalValue).toBeLessThan(hold)
    expect(weekly.compounds).toBe(52)
  })
  test('a sensible schedule beats hold', () => {
    expect(projectManual(c, 365, 90).finalValue).toBeGreaterThan(projectSimple(c, 365))
  })
})

describe('agent optimizer — must beat every manual schedule', () => {
  const c = cfg(34_650, 0.05) // the case where greedy compounding lost to monthly

  test('agent >= hold and >= any fixed manual interval', () => {
    const agent = projectAgentOptimal(c, 365)
    const hold = projectSimple(c, 365)
    expect(agent.finalValue).toBeGreaterThanOrEqual(hold - 1e-6)
    for (const interval of [7, 30, 90]) {
      expect(agent.finalValue).toBeGreaterThanOrEqual(projectManual(c, 365, interval).finalValue - 1e-6)
    }
  })

  test('the optimizer does NOT just compound as often as possible (that was the bug)', () => {
    const agent = projectAgentOptimal(c, 365)
    const daily = projectManual(c, 365, 1)
    expect(agent.finalValue).toBeGreaterThan(daily.finalValue) // fewer, better-timed compounds win
    expect(agent.compounds).toBeLessThan(daily.compounds)
    expect(Number.isFinite(agent.intervalDays)).toBe(true)
  })

  test('a tiny position: holding can be optimal (interval = Infinity)', () => {
    const agent = projectAgentOptimal(cfg(200, 0.05), 365)
    expect(agent.finalValue).toBeGreaterThanOrEqual(projectSimple(cfg(200, 0.05), 365) - 1e-6)
  })
})

describe('estimates for the card', () => {
  test('nextCompoundEstimate shrinks as fees accrue and is 0 past the threshold', () => {
    const c = cfg(6000, 0.05)
    const fromZero = nextCompoundEstimateDays(c, 365, 0)
    expect(fromZero).toBeGreaterThan(0)
    expect(nextCompoundEstimateDays(c, 365, 1)).toBeLessThan(fromZero)
    expect(nextCompoundEstimateDays(c, 365, 5)).toBe(0)
  })
  test('projectionCurve is monotonic, ends at the horizon, compounded >= simple', () => {
    const curve = projectionCurve(cfg(6000, 0.5), 365, 12)
    expect(curve[0].day).toBe(0)
    expect(curve[curve.length - 1].day).toBe(365)
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i].compounded).toBeGreaterThanOrEqual(curve[i - 1].compounded - 1e-6)
      expect(curve[i].compounded).toBeGreaterThanOrEqual(curve[i].simple - 1e-6)
    }
  })
})
