/**
 * Gas-aware auto-compounding economics — pure, side-effect-free.
 *
 * Shared core for both the agent's compound gate and the app's projection card.
 * The rule that makes it "never at a loss": reinvest accrued fees only when the
 * marginal benefit — the extra yield those fees earn over the remaining horizon —
 * exceeds the gas of doing it. So a small / low-APR position compounds rarely (or
 * never) and a large / high-APR one compounds often. The cadence falls out of the
 * numbers, it is never hardcoded.
 *
 * All amounts are in base-token units (e.g. USD); `apr` is an annual fraction
 * (0.05 = 5%).
 */

const DAYS_PER_YEAR = 365
const DEFAULT_HORIZON_DAYS = 365

export interface CompoundingConfig {
  /** Position size in base-token units. */
  principal: number
  /** Annual rate as a fraction, e.g. 0.05 for 5%. */
  apr: number
  /** Cost of one compound transaction (gas) in base-token units. */
  gasCost: number
  /** Fixed protocol/relayer fee per compound, base-token units. Default 0. */
  fixedFee?: number
  /**
   * Reference horizon (days) the live gate assumes when deciding whether a compound
   * pays off — the mandate window, say. The projection uses the actual remaining
   * horizon instead. Default 365.
   */
  horizonDays?: number
}

function validate(config: CompoundingConfig): void {
  if (config.principal < 0) throw new Error('principal must be >= 0')
  if (config.apr < 0) throw new Error('apr must be >= 0')
  if (config.gasCost < 0) throw new Error('gasCost must be >= 0')
}

/** Daily yield accrued on the current principal (linear within a day). */
export function dailyAccrual(config: CompoundingConfig): number {
  validate(config)
  return (config.principal * config.apr) / DAYS_PER_YEAR
}

/** Absolute cost of one compound: gas + fixed fee. */
export function costPerCompound(config: CompoundingConfig): number {
  validate(config)
  return config.gasCost + (config.fixedFee ?? 0)
}

/**
 * The marginal benefit of compounding: extra value earned by reinvesting `accrued`
 * now and letting it work for `remainingDays` at `apr`. This is the yield-on-yield
 * that compounding adds — the thing that must beat the gas.
 */
export function compoundBenefit(accrued: number, remainingDays: number, config: CompoundingConfig): number {
  return accrued * config.apr * (remainingDays / DAYS_PER_YEAR)
}

/**
 * The gate. True only when the marginal benefit over the remaining horizon exceeds
 * the cost — i.e. reinvesting these fees will earn back more than the gas spent.
 * This is what guarantees a compound never loses money versus simply holding.
 */
export function shouldCompound(accrued: number, remainingDays: number, config: CompoundingConfig): boolean {
  if (accrued <= 0 || config.apr <= 0) return false
  return compoundBenefit(accrued, remainingDays, config) > costPerCompound(config)
}

/** Accrued fees needed before a compound pays for itself over `remainingDays`. */
export function compoundThreshold(config: CompoundingConfig, remainingDays: number): number {
  validate(config)
  const denom = config.apr * (remainingDays / DAYS_PER_YEAR)
  if (denom <= 0) return Infinity
  return costPerCompound(config) / denom
}

/**
 * Days until the next compound: how long until accrued fees reach the threshold that
 * justifies the gas over `remainingDays`. Inversely related to size and APR — for
 * the app's "next compound ~in X days".
 */
export function nextCompoundEstimateDays(
  config: CompoundingConfig,
  remainingDays: number = config.horizonDays ?? DEFAULT_HORIZON_DAYS,
  accruedSoFar = 0,
): number {
  const perDay = dailyAccrual(config)
  if (perDay <= 0) return Infinity
  const remaining = compoundThreshold(config, remainingDays) - accruedSoFar
  return remaining <= 0 ? 0 : remaining / perDay
}

/** Value of holding without ever compounding: linear yield, no gas spent. */
export function projectSimple(config: CompoundingConfig, horizonDays: number): number {
  validate(config)
  if (horizonDays < 0) throw new Error('horizonDays must be >= 0')
  return config.principal * (1 + (config.apr * horizonDays) / DAYS_PER_YEAR)
}

export interface CompoundedProjection {
  /** User's value at the horizon (grown principal + un-harvested accrual). */
  finalValue: number
  /** Number of compounds performed. */
  compounds: number
  /** Total gas + fixed fee spent across all compounds. */
  totalGas: number
  /** Annualised effective rate implied by finalValue vs principal. */
  effectiveApr: number
}

/**
 * Realistic compounded projection: a daily simulation that accrues yield on the live
 * principal and compounds only when the marginal benefit over the *remaining*
 * horizon beats the gas. Because each compound clears that bar, the result is always
 * >= holding. Gas is modelled as coming out of the harvested fees (conservative).
 */
export function projectCompounded(config: CompoundingConfig, horizonDays: number): CompoundedProjection {
  validate(config)
  if (horizonDays < 0) throw new Error('horizonDays must be >= 0')

  const days = Math.floor(horizonDays)
  let principal = config.principal
  let accrued = 0
  let compounds = 0
  let totalGas = 0

  for (let d = 0; d < days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    const remaining = days - d
    const stepConfig: CompoundingConfig = { ...config, principal }
    if (shouldCompound(accrued, remaining, stepConfig)) {
      const cost = costPerCompound(stepConfig)
      principal += accrued - cost
      accrued = 0
      totalGas += cost
      compounds += 1
    }
  }

  const finalValue = principal + accrued
  const years = days / DAYS_PER_YEAR
  const effectiveApr = years > 0 && config.principal > 0
    ? Math.pow(finalValue / config.principal, 1 / years) - 1
    : 0

  return { finalValue, compounds, totalGas, effectiveApr }
}

/**
 * Fixed-schedule ("manual") compounding: compound every `intervalDays` regardless of
 * whether it beats the gas. Predictable, but a too-tight interval loses to gas — the
 * card surfaces that honestly (the resulting value can dip below holding).
 */
export function projectManual(
  config: CompoundingConfig,
  horizonDays: number,
  intervalDays: number,
): CompoundedProjection {
  validate(config)
  if (horizonDays < 0) throw new Error('horizonDays must be >= 0')

  const days = Math.floor(horizonDays)
  const interval = Math.max(1, Math.floor(intervalDays))
  let principal = config.principal
  let accrued = 0
  let compounds = 0
  let totalGas = 0

  for (let d = 1; d <= days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    if (d % interval === 0 && accrued > 0) {
      const cost = costPerCompound({ ...config, principal })
      principal += accrued - cost
      accrued = 0
      totalGas += cost
      compounds += 1
    }
  }

  const finalValue = principal + accrued
  const years = days / DAYS_PER_YEAR
  const effectiveApr = years > 0 && config.principal > 0
    ? Math.pow(finalValue / config.principal, 1 / years) - 1
    : 0

  return { finalValue, compounds, totalGas, effectiveApr }
}

export interface AgentProjection extends CompoundedProjection {
  /** Optimal compound interval the agent targets, in days (Infinity = never — hold). */
  intervalDays: number
}

/**
 * The agent's optimal plan. Searches compound intervals and picks the one that
 * maximises final value — balancing yield-on-yield against gas. By construction this
 * is at least as good as any fixed manual schedule (a manual interval is just one of
 * the candidates). The naive "compound whenever benefit > gas" rule over-compounds
 * early (long horizon makes even tiny fees clear the bar) and is NOT optimal — this
 * is the fix for "manual beats the agent".
 */
export function projectAgentOptimal(config: CompoundingConfig, horizonDays: number): AgentProjection {
  validate(config)
  if (horizonDays < 0) throw new Error('horizonDays must be >= 0')
  const days = Math.floor(horizonDays)

  // Baseline candidate: never compound (hold).
  const holdValue = projectSimple(config, days)
  const years = days / DAYS_PER_YEAR
  const holdApr = years > 0 && config.principal > 0 ? Math.pow(holdValue / config.principal, 1 / years) - 1 : 0
  let best: AgentProjection = {
    finalValue: holdValue,
    compounds: 0,
    totalGas: 0,
    effectiveApr: holdApr,
    intervalDays: Infinity,
  }

  for (let interval = 1; interval <= days; interval += 1) {
    const p = projectManual(config, days, interval)
    if (p.finalValue > best.finalValue) {
      best = { ...p, intervalDays: interval }
    }
  }
  return best
}

export interface ProjectionPoint {
  day: number
  simple: number
  compounded: number
}

/**
 * Sampled curve of simple vs compounded value over the horizon, for the app card.
 * `points` is the number of samples (inclusive of day 0 and the horizon). Pass
 * `intervalDays` to model the fixed-schedule ("manual") mode; omit it for the
 * gas-aware ("agent") gate.
 */
export function projectionCurve(
  config: CompoundingConfig,
  horizonDays: number,
  points = 24,
  intervalDays?: number,
): ProjectionPoint[] {
  validate(config)
  if (horizonDays <= 0 || points < 2) {
    return [{ day: 0, simple: config.principal, compounded: config.principal }]
  }

  const days = Math.floor(horizonDays)
  const sampleEvery = days / (points - 1)
  const interval = intervalDays ? Math.max(1, Math.floor(intervalDays)) : undefined

  let principal = config.principal
  let accrued = 0
  const out: ProjectionPoint[] = [{ day: 0, simple: config.principal, compounded: config.principal }]
  let nextSampleAt = sampleEvery

  for (let d = 1; d <= days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    const remaining = days - d
    const stepConfig: CompoundingConfig = { ...config, principal }
    const doCompound = interval
      ? d % interval === 0 && accrued > 0
      : shouldCompound(accrued, remaining, stepConfig)
    if (doCompound) {
      principal += accrued - costPerCompound(stepConfig)
      accrued = 0
    }
    if (d >= nextSampleAt || d === days) {
      out.push({
        day: d,
        simple: projectSimple(config, d),
        compounded: principal + accrued,
      })
      nextSampleAt += sampleEvery
    }
  }

  return out
}
