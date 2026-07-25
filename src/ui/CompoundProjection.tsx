import { useMemo } from 'react'
import {
  projectSimple,
  projectManual,
  projectAgentOptimal,
  projectionCurve,
  type CompoundingConfig,
} from '../lib/compounding'
import { IconRepeat, IconGas } from './icons'
import { Segmented, PreviewRow } from './form'

// Rough per-chain estimate of a compound (collect + increaseLiquidity) tx cost in
// USD, for the PROJECTION only — L2s are cents, mainnet is gas-heavy. This is a
// forecast assumption, not a quote: the agent reads the real live gas at execution
// and only compounds when it clears the benefit.
const COMPOUND_GAS_USD_BY_CHAIN: Record<number, number> = {
  1: 12, // Ethereum mainnet
  8453: 0.15, // Base
  84532: 0.15, // Base Sepolia
  11155111: 0.05, // Ethereum Sepolia
  10: 0.15, // Optimism
  42161: 0.2, // Arbitrum
  137: 0.05, // Polygon
  130: 0.15, // Unichain
}
const DEFAULT_COMPOUND_GAS_USD = 0.5

function estimateCompoundGasUsd(chainId: number): number {
  return COMPOUND_GAS_USD_BY_CHAIN[chainId] ?? DEFAULT_COMPOUND_GAS_USD
}

// The projection always looks a year ahead — a standard forecast window. It is not
// a schedule; the only schedule input is the Manual interval below.
const PROJECTION_DAYS = 365

type Mode = 'agent' | 'manual'

const INTERVALS: { key: string; label: string }[] = [
  { key: '7', label: 'Weekly' },
  { key: '30', label: 'Monthly' },
  { key: '90', label: 'Quarterly' },
]

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function humanDays(d: number): string {
  if (!Number.isFinite(d)) return '—'
  if (d < 1) return 'today'
  if (d < 2) return '~1 day'
  if (d < 45) return `~${Math.round(d)} days`
  if (d < 365) return `~${Math.round(d / 30)} months`
  return `~${(d / 365).toFixed(1)} years`
}

/**
 * Auto-compound projection card for the Yield flow, bound to the selected pool.
 * Two cadence modes: "agent" lets the gas-aware gate decide when to compound;
 * "manual" compounds on a fixed schedule the operator picks. The projection always
 * looks a year ahead. The toggle records the operator's intent; the compound
 * delegation it will add to the plan is wired separately.
 */
export function CompoundProjection({
  positionValueUsd,
  apr,
  aprIsEstimate = false,
  poolLabel,
  chainId,
  mode,
  onModeChange,
  intervalDays,
  onIntervalChange,
  enabled,
  onToggle,
}: {
  positionValueUsd: number
  apr: number
  aprIsEstimate?: boolean
  poolLabel?: string
  chainId: number
  mode: Mode
  onModeChange: (m: Mode) => void
  intervalDays: number
  onIntervalChange: (d: number) => void
  enabled: boolean
  onToggle: (v: boolean) => void
}) {
  const gasUsd = estimateCompoundGasUsd(chainId)

  const config = useMemo<CompoundingConfig>(
    () => ({ principal: positionValueUsd, apr, gasCost: gasUsd }),
    [positionValueUsd, apr, gasUsd],
  )

  const hasValue = positionValueUsd > 0 && apr > 0
  const simple = useMemo(() => projectSimple(config, PROJECTION_DAYS), [config])
  // Agent = the optimal compound schedule (always >= any manual interval).
  const agentProj = useMemo(() => projectAgentOptimal(config, PROJECTION_DAYS), [config])
  const comp = useMemo(
    () => (mode === 'agent' ? agentProj : projectManual(config, PROJECTION_DAYS, intervalDays)),
    [mode, agentProj, config, intervalDays],
  )
  // Interval driving the "next compound" line and the curve — the agent uses its
  // own optimal interval.
  const activeInterval = mode === 'agent' ? agentProj.intervalDays : intervalDays
  const curveInterval = Number.isFinite(activeInterval) ? activeInterval : PROJECTION_DAYS + 1
  const curve = useMemo(() => projectionCurve(config, PROJECTION_DAYS, 32, curveInterval), [config, curveInterval])
  // Best of the manual intervals → flagged "best" in the Manual selector.
  const bestManualKey = useMemo(() => {
    let key = INTERVALS[0].key
    let fv = -Infinity
    for (const i of INTERVALS) {
      const v = projectManual(config, PROJECTION_DAYS, Number(i.key)).finalValue
      if (v > fv) {
        fv = v
        key = i.key
      }
    }
    return key
  }, [config])
  const extra = comp.finalValue - simple
  const extraPositive = extra >= -1e-6
  // Compounding's ceiling is ~(apr*T)^2/2 of principal, so at low APR the gain is
  // small no matter the size — surface that so the operator understands the number.
  const upliftPct = positionValueUsd > 0 ? extra / positionValueUsd : 0
  const marginalUplift = extraPositive && upliftPct < 0.005

  // Sparkline geometry: normalise both lines to the same band.
  const W = 100
  const H = 40
  const maxV = Math.max(config.principal, ...curve.map((p) => Math.max(p.compounded, p.simple)))
  const minV = Math.min(config.principal, ...curve.map((p) => Math.min(p.compounded, p.simple)))
  const span = maxV - minV || 1
  const px = (i: number) => (curve.length > 1 ? (i / (curve.length - 1)) * W : 0)
  const py = (v: number) => H - ((v - minV) / span) * H
  const path = (key: 'simple' | 'compounded') =>
    curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(p[key]).toFixed(1)}`).join(' ')

  return (
    <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent)' }}>
            <IconRepeat size={16} />
          </span>
          <div>
            <div className="text-sm font-semibold text-ink">Auto-compound</div>
            <div className="text-[11px] text-faint">
              Reinvest fees{poolLabel ? ` into ${poolLabel}` : ''} — only when it beats the gas.
            </div>
          </div>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <span className="text-xs text-dim">{enabled ? 'On' : 'Off'}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label="Enable auto-compound"
          />
        </label>
      </div>

      {!enabled ? (
        <p className="text-xs text-faint">Turn on to project compounding for this position.</p>
      ) : !hasValue ? (
        <p className="text-xs text-faint">Enter amounts to see the projection.</p>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <Segmented
              options={[
                { key: 'agent', label: 'Agent' },
                { key: 'manual', label: 'Manual' },
              ]}
              value={mode}
              onChange={(v) => onModeChange(v)}
            />
            {mode === 'manual' && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-faint">every</span>
                <Segmented
                  options={INTERVALS.map((i) => ({
                    key: i.key,
                    label:
                      i.key === bestManualKey ? (
                        <>
                          {i.label} <span style={{ color: 'var(--accent)' }}>· best</span>
                        </>
                      ) : (
                        i.label
                      ),
                  }))}
                  value={String(intervalDays)}
                  onChange={(v) => onIntervalChange(Number(v))}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg glass ring-1 ring-line p-3">
              <div className="text-[11px] text-faint uppercase tracking-wide">Hold</div>
              <div className="font-mono text-lg text-dim tnum mt-1">{usd(simple)}</div>
              <div className="text-[11px] text-faint mt-0.5">no compounding · 1y</div>
            </div>
            <div
              className="rounded-lg ring-1 p-3"
              style={{
                background: extraPositive ? 'var(--accent-soft)' : 'transparent',
                borderColor: extraPositive ? 'var(--accent-line)' : 'var(--color-danger)',
              }}
            >
              <div
                className="text-[11px] uppercase tracking-wide"
                style={{ color: extraPositive ? 'var(--accent)' : 'var(--color-danger)' }}
              >
                {mode === 'agent' ? 'Auto-compound' : 'Manual'} · 1y
              </div>
              <div className="font-mono text-lg text-ink tnum mt-1">{usd(comp.finalValue)}</div>
              <div
                className="text-[11px] mt-0.5"
                style={{ color: extraPositive ? 'var(--accent)' : 'var(--color-danger)' }}
              >
                {extraPositive ? '+' : '−'}
                {usd(Math.abs(extra))} {extraPositive ? 'extra' : 'lost to gas'}
              </div>
            </div>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none" aria-hidden="true">
            <path d={path('simple')} fill="none" stroke="var(--color-dim)" strokeWidth="1" opacity="0.5" />
            <path
              d={path('compounded')}
              fill="none"
              stroke={extraPositive ? 'var(--accent)' : 'var(--color-danger)'}
              strokeWidth="1.5"
            />
          </svg>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <PreviewRow label="Effective APY">
              <span className="font-mono text-ink tnum text-xs">
                {pct(comp.effectiveApr)}
                {aprIsEstimate && <span className="text-faint"> · est.</span>}
              </span>
            </PreviewRow>
            <PreviewRow label="Compounds / yr">
              <span className="font-mono text-ink tnum text-xs">{comp.compounds}×</span>
            </PreviewRow>
            <PreviewRow label={mode === 'agent' ? 'Optimal every' : 'Every'}>
              <span className="text-ink text-xs">{humanDays(activeInterval)}</span>
            </PreviewRow>
          </div>

          {marginalUplift && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--accent)' }}>
              Compounding rewards higher-yield positions — at ~{pct(apr)} APR the extra stays small no matter the size;
              it scales up sharply as the pool's APR rises.
            </p>
          )}

          <p className="text-[11px] text-faint leading-relaxed flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0">
              <IconGas size={12} />
            </span>
            <span>
              {mode === 'agent'
                ? 'The agent picks the compound frequency that maximises return after gas — at least as good as any fixed schedule, never at a loss.'
                : 'Compounds on your fixed schedule regardless of gas — switch to Agent to let it optimise the frequency for you.'}{' '}
              Figures are estimates.
            </span>
          </p>
        </>
      )}
    </div>
  )
}
