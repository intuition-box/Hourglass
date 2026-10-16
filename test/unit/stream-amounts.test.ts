/**
 * Robust unit tests for the stream amount math. The security property under test:
 * what the UI enters/displays must equal exactly what the erc20Streaming caveat
 * enforces — no drift, over any duration or magnitude. All math is bigint, so
 * equality is exact by construction; these tests pin that down.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { parseUnits, formatUnits } from 'viem'
import {
  rateToPerSecond,
  perSecondForTotal,
  perSecondToRate,
  rateBreakdown,
  secondsToBudget,
  budgetByEndTime,
  humanDuration,
  unitSeconds,
  MAX_UINT256,
  RATE_UNITS,
  type RateUnitKey,
} from '../../src/lib/streamRate'
import { streamedAvailable } from '../../src/lib/streamTerms'

const DP6 = 6 // USDC / USDT
const DP18 = 18 // most ERC-20s
const MONTH = 2_592_000
const YEAR = 31_557_600 // 365.25 days

const usdc = (v: string) => parseUnits(v, DP6)

/** Thin wrapper over the on-chain availability formula. */
function available(aps: bigint, initial: bigint, max: bigint, start: number, now: number): bigint {
  return streamedAvailable({
    amountPerSecondRaw: aps.toString(),
    initialAmountRaw: initial.toString(),
    maxAmountRaw: max.toString(),
    startTime: start,
    nowSeconds: now,
  })
}

const abs = (x: bigint) => (x < 0n ? -x : x)

describe('rateToPerSecond — entered amount → per-second wei (ceil: never short)', () => {
  test('USDC 300/month ceils to 116 wei/s (115.74 rounds up)', () => {
    expect(rateToPerSecond('300', 'month', DP6)).toBe(116n)
  })

  test('USDC 10/month ceils to 4 wei/s (3.86 rounds up)', () => {
    expect(rateToPerSecond('10', 'month', DP6)).toBe(4n)
  })

  test('always rounds UP so the flow is never below the intended rate', () => {
    // any fraction of a wei/s rounds up to the next whole wei/s
    expect(rateToPerSecond(formatUnits(BigInt(Math.round(1.01 * MONTH)), DP6), 'month', DP6)).toBe(2n)
    expect(rateToPerSecond(formatUnits(BigInt(Math.round(1.99 * MONTH)), DP6), 'month', DP6)).toBe(2n)
    // an exact whole wei/s does NOT get a needless +1
    expect(rateToPerSecond(formatUnits(2n * BigInt(MONTH), DP6), 'month', DP6)).toBe(2n)
  })

  test('the effective rate is always ≥ the entered amount (never short)', () => {
    for (const a of ['1', '200', '300', '1000', '12345.67']) {
      const aps = rateToPerSecond(a, 'month', DP6)
      expect(aps * BigInt(MONTH)).toBeGreaterThanOrEqual(usdc(a))
    }
  })

  test('never produces a negative or absurd value for zero', () => {
    expect(rateToPerSecond('0', 'month', DP6)).toBe(0n)
  })
})

describe('snap (perSecondToRate ∘ rateToPerSecond) — WYSIWYG, idempotent, no drift', () => {
  const amounts = ['0.000001', '1', '2.6', '10', '300', '1000.5', '123456.789', '1000000']

  test('snapping is idempotent across all units and both decimals', () => {
    for (const dp of [DP6, DP18]) {
      for (const u of RATE_UNITS) {
        for (const a of amounts) {
          const aps = rateToPerSecond(a, u.key, dp)
          const snapped = perSecondToRate(aps, u.key, dp)
          // Re-deriving the per-second flow from the snapped value gives the SAME integer.
          expect(rateToPerSecond(snapped, u.key, dp)).toBe(aps)
        }
      }
    }
  })

  test('switching units never drifts: any unit round-trips back to the same wei/s', () => {
    // Fix a flow, express it at every unit, derive back — must be identical.
    const aps0 = rateToPerSecond('2083.333', 'month', DP6)
    for (const u of RATE_UNITS) {
      const shown = perSecondToRate(aps0, u.key, DP6)
      expect(rateToPerSecond(shown, u.key, DP6)).toBe(aps0)
    }
  })

  test('displayed value equals exactly aps × unitSeconds / 10^dp (the real enforced flow)', () => {
    const aps = rateToPerSecond('300', 'month', DP6)
    expect(perSecondToRate(aps, 'month', DP6)).toBe(formatUnits(aps * BigInt(MONTH), DP6))
    expect(perSecondToRate(aps, 'month', DP6)).toBe('300.672')
  })
})

describe('streamedAvailable — claimable / enforced amount', () => {
  test('unlocks nothing before start, then the upfront amount at start', () => {
    // ERC20StreamingEnforcer returns 0 while block.timestamp < startTime.
    expect(available(1000n, usdc('5'), MAX_UINT256, 100, 50)).toBe(0n)
    expect(available(1000n, usdc('5'), MAX_UINT256, 100, 100)).toBe(usdc('5'))
  })

  test('accrues linearly and exactly (bigint, no rounding)', () => {
    const aps = 1000n
    expect(available(aps, 0n, MAX_UINT256, 0, 3600)).toBe(aps * 3600n)
    expect(available(aps, usdc('1'), MAX_UINT256, 0, 3600)).toBe(usdc('1') + aps * 3600n)
  })

  test('caps at maxAmount EXACTLY and never exceeds it (the enforced ceiling)', () => {
    const max = usdc('300')
    const aps = rateToPerSecond('300', 'month', DP6) // 116
    // far past the cap → exactly max, not a wei more
    expect(available(aps, 0n, max, 0, 10 ** 9)).toBe(max)
    // monotonic and bounded across the whole life of the stream
    let prev = 0n
    for (let t = 0; t <= 4 * MONTH; t += MONTH / 4) {
      const a = available(aps, 0n, max, 0, t)
      expect(a).toBeLessThanOrEqual(max)
      expect(a).toBeGreaterThanOrEqual(prev) // non-decreasing
      prev = a
    }
  })
})

describe('perSecondForTotal — the vesting rate (total over duration, ceil)', () => {
  test('ceils so total/duration is never under-streamed; cap=total then lands exactly', () => {
    const total = usdc('100000')
    const duration = 4 * YEAR
    const aps = perSecondForTotal(total, duration)
    // never short over the duration
    expect(aps * BigInt(duration)).toBeGreaterThanOrEqual(total)
    // with the cap, the exact total is reached on/just before the deadline and held
    expect(available(aps, 0n, total, 0, duration)).toBe(total)
    expect(available(aps, 0n, total, 0, 10 * YEAR)).toBe(total)
  })

  test('reaches the total at or BEFORE the deadline (ceil), never after', () => {
    for (const [amount, duration] of [['100000', 4 * YEAR], ['12345.67', 17 * MONTH], ['500', 2 * YEAR]] as [string, number][]) {
      const total = usdc(amount)
      const aps = perSecondForTotal(total, duration)
      expect(available(aps, 0n, total, 0, duration)).toBe(total) // fully vested by the deadline
    }
  })

  test('zero duration yields zero (guarded, no divide-by-zero)', () => {
    expect(perSecondForTotal(usdc('100'), 0)).toBe(0n)
  })
})

describe('exact total over a long cycle — the vesting guarantee', () => {
  test('100k USDC over 4 years is claimable to the exact wei (cap = total)', () => {
    const total = usdc('100000') // 100_000_000_000 wei
    const duration = 4 * YEAR
    const aps = (total + BigInt(duration) / 2n) / BigInt(duration) // round to nearest
    // The cap guarantees the total, independent of the rounded rate.
    expect(available(aps, 0n, total, 0, 10 * YEAR)).toBe(total)
    // Never over-pays at any point in the 4 years.
    for (let t = 0; t <= duration; t += YEAR) {
      expect(available(aps, 0n, total, 0, t)).toBeLessThanOrEqual(total)
    }
  })

  test('rate rounding only shifts the finish time slightly, never the total', () => {
    const total = usdc('100000')
    const duration = 4 * YEAR
    const aps = (total + BigInt(duration) / 2n) / BigInt(duration)
    // time to reach the full total
    const finish = Number((total + aps - 1n) / aps) // ceil(total/aps)
    // overshoot vs the nominal 4-year deadline is under a day over a 4-year span
    expect(Math.abs(finish - duration)).toBeLessThan(86_400)
  })
})

describe('no cent lost — the cap delivers the exact total whatever the rate rounding', () => {
  // Awkward totals/durations where total is NOT divisible by the duration.
  const cases: [string, number][] = [
    ['100000', 4 * YEAR],
    ['12345.67', 3 * YEAR],
    ['500', 2 * YEAR],
    ['7777.777777', YEAR + 12345],
    ['250000', 18 * MONTH],
  ]

  test('maxAmount = total ⇒ eventual claimable is exactly total, to the wei', () => {
    for (const [amount, duration] of cases) {
      const total = usdc(amount)
      const aps = total / BigInt(duration) // floor: streams a touch slower than the target
      // total is recovered exactly once the linear term fills the cap
      expect(available(aps, 0n, total, 0, 50 * YEAR)).toBe(total)
      // and is never exceeded on the way there
      for (let t = 0; t <= duration; t += Math.floor(duration / 5)) {
        expect(available(aps, 0n, total, 0, t)).toBeLessThanOrEqual(total)
      }
    }
  })

  test('the remainder is delivered (not lost), just slightly after the nominal end', () => {
    const total = usdc('100000')
    const duration = 4 * YEAR
    const aps = total / BigInt(duration) // floor
    const atDeadline = available(aps, 0n, total, 0, duration)
    const remainder = total - atDeadline // not yet delivered at the deadline...
    expect(remainder).toBeGreaterThan(0n)
    // ...but fully delivered a bit later, total intact
    const lateBy = Number((remainder + aps - 1n) / aps) // seconds to finish filling
    expect(available(aps, 0n, total, 0, duration + lateBy)).toBe(total)
    expect(lateBy).toBeLessThan(86_400) // under a day of slop on a 4-year vest
  })
})

describe('exact-to-the-second: front-load the remainder as initialAmount', () => {
  test('available equals the total EXACTLY at the deadline second, never a cent off', () => {
    const cases: [string, number][] = [
      ['100000', 4 * YEAR],
      ['12345.67', 3 * YEAR],
      ['999.999999', 17 * MONTH],
    ]
    for (const [amount, duration] of cases) {
      const total = usdc(amount)
      const aps = total / BigInt(duration) // floor
      const initial = total - aps * BigInt(duration) // the remainder, paid up front
      expect(initial).toBeGreaterThanOrEqual(0n)
      expect(initial).toBeLessThan(BigInt(duration)) // remainder is always < one duration of wei
      // lands on the total exactly at the deadline, and stays capped
      expect(available(aps, initial, total, 0, duration)).toBe(total)
      expect(available(aps, initial, total, 0, duration + 10 ** 6)).toBe(total)
      // never over the total at any earlier point
      for (let t = 0; t <= duration; t += Math.floor(duration / 7)) {
        expect(available(aps, initial, total, 0, t)).toBeLessThanOrEqual(total)
      }
    }
  })
})

describe('minimum streamable rate, and the front-load rescue', () => {
  test('a total below one wei/second over the duration floors the rate to 0 — it cannot stream', () => {
    // USDC needs total >= duration (in wei): e.g. ~126 USDC over 4 years, ~63 over 2.
    const total = usdc('1') // 1 USDC = 1e6 wei
    const duration = 2 * YEAR // 63_115_200 s > 1e6
    const aps = total / BigInt(duration)
    expect(aps).toBe(0n)
    expect(available(aps, 0n, total, 0, 100 * YEAR)).toBe(0n) // cap-only delivers nothing
  })

  test('front-loading the remainder delivers the exact total even when the rate rounds to 0', () => {
    const total = usdc('1')
    const duration = 2 * YEAR
    const aps = total / BigInt(duration) // 0
    const initial = total - aps * BigInt(duration) // = total, paid up front
    expect(available(aps, initial, total, 0, 0)).toBe(total)
  })
})

describe('4-year cycle base, and drift over 2 / 5 / 10 years', () => {
  const CYCLE_4Y = 4 * YEAR // 126_230_400 s — one leap year per cycle, fixed

  test('a 4-year cycle is a fixed second count regardless of start date', () => {
    expect(CYCLE_4Y).toBe(126_230_400)
  })

  test('calendar months are NOT equal under a constant per-second rate (inherent)', () => {
    const aps = rateToPerSecond('3000', 'month', DP6)
    const month = (days: number) => aps * BigInt(days * 86_400)
    expect(month(31)).toBeGreaterThan(month(30))
    expect(month(28)).toBeLessThan(month(30))
  })

  // Zet's model: total defined over the fixed 4-year cycle, rate rounded UP.
  test('unbounded drift grows linearly but stays under the 1 wei/s × time bound at 2/5/10y', () => {
    const total4y = usdc('100000')
    const aps = (total4y + BigInt(CYCLE_4Y) - 1n) / BigInt(CYCLE_4Y) // ceil — never shorts
    for (const years of [2, 5, 10]) {
      const elapsed = years * YEAR
      const actual = available(aps, 0n, MAX_UINT256, 0, elapsed)
      const ideal = (total4y * BigInt(elapsed)) / BigInt(CYCLE_4Y)
      const drift = actual - ideal
      expect(drift).toBeGreaterThanOrEqual(0n) // ceil never shorts the beneficiary
      expect(drift).toBeLessThanOrEqual(BigInt(elapsed)) // < 1 wei/s accumulated
    }
  })

  test('round-to-nearest drifts less than ceil (trade-off: it can briefly short)', () => {
    const total4y = usdc('100000')
    const apsCeil = (total4y + BigInt(CYCLE_4Y) - 1n) / BigInt(CYCLE_4Y)
    const apsNear = (total4y + BigInt(CYCLE_4Y) / 2n) / BigInt(CYCLE_4Y)
    const elapsed = 10 * YEAR
    const ideal = (total4y * BigInt(elapsed)) / BigInt(CYCLE_4Y)
    const driftCeil = abs(apsCeil * BigInt(elapsed) - ideal)
    const driftNear = abs(apsNear * BigInt(elapsed) - ideal)
    expect(driftNear).toBeLessThanOrEqual(driftCeil)
  })

  test('a CAPPED stream has ZERO total drift at 2/5/10y — the cap is the source of truth', () => {
    const total4y = usdc('100000')
    const aps = (total4y + BigInt(CYCLE_4Y) - 1n) / BigInt(CYCLE_4Y)
    for (const years of [2, 5, 10]) {
      const target = (total4y * BigInt(years * YEAR)) / BigInt(CYCLE_4Y) // pro-rata of the 4y total
      expect(available(aps, 0n, target, 0, 50 * YEAR)).toBe(target) // exact, no drift, any horizon
    }
  })
})

describe('no drift over very large durations', () => {
  test('100-year stream accrues exactly aps × elapsed (capped), bit-for-bit', () => {
    const aps = rateToPerSecond('5000', 'month', DP6)
    const elapsed = 100 * YEAR
    // unbounded → exactly the linear amount, no float drift
    expect(available(aps, 0n, MAX_UINT256, 0, elapsed)).toBe(aps * BigInt(elapsed))
  })

  test('availability is exact at the cap boundary second', () => {
    const aps = 7n
    const max = aps * 1_000_000n // reached at exactly t = 1_000_000
    expect(available(aps, 0n, max, 0, 999_999)).toBe(aps * 999_999n)
    expect(available(aps, 0n, max, 0, 1_000_000)).toBe(max)
    expect(available(aps, 0n, max, 0, 1_000_001)).toBe(max)
  })
})

describe('no drift on very large amounts', () => {
  test('1 billion USDC vested over 4 years stays exact (no overflow, no drift)', () => {
    const total = usdc('1000000000') // 1e9 USDC = 1e15 wei
    const duration = 4 * YEAR
    const aps = (total + BigInt(duration) / 2n) / BigInt(duration)
    expect(available(aps, 0n, total, 0, 10 * YEAR)).toBe(total)
  })

  test('huge per-second flow does not overflow and stays linear', () => {
    const aps = parseUnits('1000000000', DP18) // 1e9 tokens/s, absurd but must not break
    const elapsed = 10 * YEAR
    expect(available(aps, 0n, MAX_UINT256, 0, elapsed)).toBe(aps * BigInt(elapsed))
  })
})

describe('18-decimal tokens — granularity is negligible', () => {
  test('effective monthly is within one wei/s-step of the entered amount', () => {
    const entered = parseUnits('1000', DP18)
    const aps = rateToPerSecond('1000', 'month', DP18)
    const effective = aps * BigInt(MONTH)
    // one step (1 wei/s over a month) is 2_592_000 wei = 2.592e-12 token
    expect(abs(effective - entered)).toBeLessThanOrEqual(BigInt(MONTH))
  })

  test('snap is still idempotent at 18 decimals', () => {
    const aps = rateToPerSecond('1234.5678', 'month', DP18)
    expect(rateToPerSecond(perSecondToRate(aps, 'month', DP18), 'month', DP18)).toBe(aps)
  })
})

describe('bound helpers — budget ⇄ duration consistency', () => {
  test('budgetByEndTime is exactly initial + aps × elapsed', () => {
    const aps = 116n
    expect(budgetByEndTime(aps, 1000, 1000 + MONTH, usdc('5'))).toBe(usdc('5') + aps * BigInt(MONTH))
  })

  test('budgetByEndTime clamps to the upfront amount when end ≤ start', () => {
    expect(budgetByEndTime(116n, 2000, 1000, usdc('5'))).toBe(usdc('5'))
  })

  test('secondsToBudget then stream reaches the budget (within one second of flow)', () => {
    const aps = rateToPerSecond('2083', 'month', DP6)
    const max = usdc('100000')
    const secs = secondsToBudget(aps, max, 0n)
    const reached = available(aps, 0n, max, 0, secs)
    expect(max - reached).toBeLessThanOrEqual(aps) // at most one second of flow short
  })
})

describe('rateBreakdown reflects the real flow at every scale', () => {
  test('each scale equals formatUnits(aps × unitSeconds)', () => {
    const aps = rateToPerSecond('300', 'month', DP6)
    const bd = rateBreakdown(aps, DP6)
    for (const u of RATE_UNITS) {
      expect(bd[u.key as RateUnitKey]).toBe(formatUnits(aps * BigInt(unitSeconds(u.key)), DP6))
    }
  })
})

describe('humanDuration labels', () => {
  test('formats common spans', () => {
    expect(humanDuration(MONTH)).toBe('1 month')
    expect(humanDuration(2 * MONTH)).toBe('2 months')
    expect(humanDuration(86_400)).toBe('1 day')
    expect(humanDuration(0)).toBe('instantly')
  })
})
