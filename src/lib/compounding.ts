/**
 * Gas-aware auto-compounding economics — pure, side-effect-free.
 *
 * Shared core for both the agent's compound gate and the app's projection card.
 * The agent compounds accrued yield back into principal only when it is
 * net-profitable after cost, so small treasuries compound rarely and large ones
 * often — the cadence falls out of the numbers, it is never hardcoded.
 *
 * See docs plan: "Gas-aware auto-compounding". All amounts are in base-token units
 * (e.g. USDC); `apr` is an annual fraction (0.05 = 5%).
 */

const DAYS_PER_YEAR = 365

export interface CompoundingConfig {
  /** Position size in base-token units. */
  principal: number
  /** Annual rate as a fraction, e.g. 0.05 for 5%. */
  apr: number
  /** Cost of one compound transaction (gas) in base-token units. */
  gasCost: number
  /** Fixed protocol/relayer fee per compound, base-token units. Default 0. */
  fixedFee?: number
  /** Performance fee as a fraction of net yield, taken at compound. Default 0. */
  performanceFeeRate?: number
  /** Safety multiple: compound only when accrued >= costMultiple * cost. Default 10. */
  costMultiple?: number
}

const DEFAULT_COST_MULTIPLE = 10

function validate(config: CompoundingConfig): void {
  if (config.principal < 0) throw new Error('principal must be >= 0')
  if (config.apr < 0) throw new Error('apr must be >= 0')
  if (config.gasCost < 0) throw new Error('gasCost must be >= 0')
  if ((config.costMultiple ?? DEFAULT_COST_MULTIPLE) <= 0) throw new Error('costMultiple must be > 0')
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
 * The gate. True when the accrued yield clears the cost multiple — i.e. gas + fee
 * is a small enough fraction of what is being reinvested to be worth it.
 */
export function shouldCompound(accrued: number, config: CompoundingConfig): boolean {
  const cost = costPerCompound(config)
  if (accrued <= 0) return false
  if (cost <= 0) return true
  const m = config.costMultiple ?? DEFAULT_COST_MULTIPLE
  return accrued >= m * cost
}

/**
 * Break-even interval in days: how long until accrued yield first clears the gate,
 * starting from zero. Inversely proportional to position size. Infinity if no yield.
 */
export function breakEvenIntervalDays(config: CompoundingConfig): number {
  const perDay = dailyAccrual(config)
  if (perDay <= 0) return Infinity
  const m = config.costMultiple ?? DEFAULT_COST_MULTIPLE
  return (m * costPerCompound(config)) / perDay
}

/**
 * Days until the next compound, given yield already accrued since the last one.
 * Zero if the gate is already cleared. For the app's "next compound ~in X days".
 */
export function nextCompoundEstimateDays(config: CompoundingConfig, accruedSoFar = 0): number {
  const perDay = dailyAccrual(config)
  if (perDay <= 0) return Infinity
  const m = config.costMultiple ?? DEFAULT_COST_MULTIPLE
  const remaining = m * costPerCompound(config) - accruedSoFar
  return remaining <= 0 ? 0 : remaining / perDay
}

/**
 * Amount reinvested into principal when compounding `accrued`: yield minus the
 * absolute cost, minus the performance fee on the net. Floored at 0.
 */
export function netReinvested(accrued: number, config: CompoundingConfig): number {
  const net = accrued - costPerCompound(config)
  if (net <= 0) return 0
  return net * (1 - (config.performanceFeeRate ?? 0))
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
  totalCost: number
  /** Total performance fee paid to the platform. */
  totalPerformanceFee: number
  /** Annualised effective rate implied by finalValue vs principal. */
  effectiveApr: number
}

/**
 * Realistic compounded projection: a daily simulation that accrues yield on the
 * live principal and compounds whenever the gate fires, deducting cost and fee.
 * Gas is modelled as coming out of harvested yield (conservative for display).
 */
export function projectCompounded(config: CompoundingConfig, horizonDays: number): CompoundedProjection {
  validate(config)
  if (horizonDays < 0) throw new Error('horizonDays must be >= 0')

  const days = Math.floor(horizonDays)
  const feeRate = config.performanceFeeRate ?? 0
  let principal = config.principal
  let accrued = 0
  let compounds = 0
  let totalCost = 0
  let totalPerformanceFee = 0

  for (let d = 0; d < days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    const stepConfig: CompoundingConfig = { ...config, principal }
    if (shouldCompound(accrued, stepConfig)) {
      const cost = costPerCompound(stepConfig)
      const gross = accrued - cost
      const fee = gross > 0 ? gross * feeRate : 0
      principal += netReinvested(accrued, stepConfig)
      totalCost += cost
      totalPerformanceFee += fee
      accrued = 0
      compounds += 1
    }
  }

  const finalValue = principal + accrued
  const years = days / DAYS_PER_YEAR
  const effectiveApr = years > 0 && config.principal > 0
    ? Math.pow(finalValue / config.principal, 1 / years) - 1
    : 0

  return { finalValue, compounds, totalCost, totalPerformanceFee, effectiveApr }
}

export interface ProjectionPoint {
  day: number
  simple: number
  compounded: number
}

/**
 * Sampled curve of simple vs compounded value over the horizon, for the app card.
 * `points` is the number of samples (inclusive of day 0 and the horizon).
 */
export function projectionCurve(
  config: CompoundingConfig,
  horizonDays: number,
  points = 24,
): ProjectionPoint[] {
  validate(config)
  if (horizonDays <= 0 || points < 2) {
    return [{ day: 0, simple: config.principal, compounded: config.principal }]
  }

  const days = Math.floor(horizonDays)
  const sampleEvery = days / (points - 1)

  let principal = config.principal
  let accrued = 0
  const out: ProjectionPoint[] = [{ day: 0, simple: config.principal, compounded: config.principal }]
  let nextSampleAt = sampleEvery

  for (let d = 1; d <= days; d += 1) {
    accrued += (principal * config.apr) / DAYS_PER_YEAR
    const stepConfig: CompoundingConfig = { ...config, principal }
    if (shouldCompound(accrued, stepConfig)) {
      principal += netReinvested(accrued, stepConfig)
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
