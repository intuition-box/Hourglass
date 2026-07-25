/**
 * The property this suite protects: the compound gate is profitability-driven, so a
 * small treasury waits (gas would eat the harvest) and a large one runs often. If
 * that inverts, the agent starts compounding at a loss for small positions. The two
 * worked examples below are the ones the team signed off on.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import {
  dailyAccrual,
  costPerCompound,
  shouldCompound,
  breakEvenIntervalDays,
  nextCompoundEstimateDays,
  netReinvested,
  projectSimple,
  projectCompounded,
  projectionCurve,
  type CompoundingConfig,
} from '../../src/lib/compounding'

// 10K position yielding ~$0.20/day; gas $0.15. Threshold M=10 -> compound weekly.
const SMALL: CompoundingConfig = {
  principal: 10_000,
  apr: (0.2 * 365) / 10_000, // ~0.73% APR, i.e. $0.20/day
  gasCost: 0.15,
  costMultiple: 10,
}

// 10M position yielding ~$2,000/day; gas $0.15. Threshold cleared in minutes.
const LARGE: CompoundingConfig = {
  principal: 10_000_000,
  apr: (2000 * 365) / 10_000_000, // ~7.3% APR, i.e. $2,000/day
  gasCost: 0.15,
  costMultiple: 10,
}

describe('accrual and cost', () => {
  test('dailyAccrual matches the position economics', () => {
    expect(dailyAccrual(SMALL)).toBeCloseTo(0.2, 6)
    expect(dailyAccrual(LARGE)).toBeCloseTo(2000, 3)
  })

  test('costPerCompound sums gas and fixed fee', () => {
    expect(costPerCompound(SMALL)).toBeCloseTo(0.15, 6)
    expect(costPerCompound({ ...SMALL, fixedFee: 0.05 })).toBeCloseTo(0.2, 6)
  })
})

describe('the gate', () => {
  test('waits below the threshold, fires at or above it', () => {
    expect(shouldCompound(1.49, SMALL)).toBe(false) // 10 * 0.15 = 1.50
    expect(shouldCompound(1.5, SMALL)).toBe(true)
    expect(shouldCompound(0, SMALL)).toBe(false)
  })

  test('daily gas would eat the small harvest, so it does NOT fire daily', () => {
    expect(shouldCompound(dailyAccrual(SMALL), SMALL)).toBe(false)
  })

  test('one day of accrual on the large position clears the gate immediately', () => {
    expect(shouldCompound(dailyAccrual(LARGE), LARGE)).toBe(true)
  })
})

describe('cadence — small waits, large runs', () => {
  test('small treasury compounds about weekly', () => {
    const days = breakEvenIntervalDays(SMALL)
    expect(days).toBeCloseTo(7.5, 1) // 1.50 / 0.20
    expect(days).toBeGreaterThan(1)
  })

  test('large treasury compounds well within a day', () => {
    expect(breakEvenIntervalDays(LARGE)).toBeLessThan(1)
  })

  test('cadence is inversely proportional to position size', () => {
    expect(breakEvenIntervalDays(SMALL)).toBeGreaterThan(breakEvenIntervalDays(LARGE))
  })

  test('nextCompoundEstimate shrinks as yield accrues', () => {
    const fromZero = nextCompoundEstimateDays(SMALL, 0)
    const halfway = nextCompoundEstimateDays(SMALL, 0.75)
    expect(fromZero).toBeCloseTo(7.5, 1)
    expect(halfway).toBeLessThan(fromZero)
    expect(nextCompoundEstimateDays(SMALL, 2)).toBe(0) // already past threshold
  })
})

describe('net reinvested and fees', () => {
  test('deducts cost and performance fee from the harvest', () => {
    expect(netReinvested(2, { ...SMALL, performanceFeeRate: 0.1 })).toBeCloseTo(1.665, 6)
  })

  test('never reinvests a negative amount', () => {
    expect(netReinvested(0.1, SMALL)).toBe(0)
  })
})

describe('projections', () => {
  test('simple projection is linear yield with no gas', () => {
    expect(projectSimple(LARGE, 365)).toBeCloseTo(10_000_000 * (1 + LARGE.apr), 2)
  })

  test('compounding beats simple for a large position over a year', () => {
    const simple = projectSimple(LARGE, 365)
    const { finalValue, compounds } = projectCompounded(LARGE, 365)
    expect(finalValue).toBeGreaterThan(simple)
    expect(compounds).toBeGreaterThan(300)
  })

  test('small position compounds rarely (agent refuses to burn gas)', () => {
    const { compounds } = projectCompounded(SMALL, 365)
    expect(compounds).toBeLessThan(60)
    expect(compounds).toBeGreaterThan(0)
  })

  test('effectiveApr exceeds the nominal apr when compounding is active', () => {
    const { effectiveApr } = projectCompounded(LARGE, 365)
    expect(effectiveApr).toBeGreaterThan(LARGE.apr)
  })

  test('projectionCurve is monotonic and ends at the horizon', () => {
    const curve = projectionCurve(LARGE, 365, 12)
    expect(curve[0].day).toBe(0)
    expect(curve[curve.length - 1].day).toBe(365)
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i].compounded).toBeGreaterThanOrEqual(curve[i - 1].compounded)
      expect(curve[i].compounded).toBeGreaterThanOrEqual(curve[i].simple)
    }
  })
})
