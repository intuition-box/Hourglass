import { useMemo, useState } from 'react'
import {
  projectSimple,
  projectCompounded,
  projectionCurve,
  nextCompoundEstimateDays,
  type CompoundingConfig,
} from '../lib/compounding'
import { IconRepeat, IconGas } from './icons'
import { Segmented, PreviewRow } from './form'

// Display estimates — the projection is illustrative, not a quote. The real gas,
// fee and APR are resolved at run time by the agent / venue.
const COMPOUND_GAS_USD = 0.15
const COST_MULTIPLE = 10
const PERFORMANCE_FEE_RATE = 0.1

const HORIZONS: { key: string; label: string }[] = [
  { key: '30', label: '1M' },
  { key: '90', label: '3M' },
  { key: '365', label: '1Y' },
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
 * Auto-compound projection card for the Yield flow. Shows hold vs auto-compound
 * over a horizon and the gas-aware cadence, driven by the pure `compounding` core.
 * The toggle records the operator's intent; the compound delegation it will add to
 * the plan is wired separately (the agent-gate / delegation work).
 */
export function CompoundProjection({
  positionValueUsd,
  apr,
  aprIsEstimate = false,
  enabled,
  onToggle,
}: {
  positionValueUsd: number
  apr: number
  aprIsEstimate?: boolean
  enabled: boolean
  onToggle: (v: boolean) => void
}) {
  const [horizonDays, setHorizonDays] = useState(365)

  const config = useMemo<CompoundingConfig>(
    () => ({
      principal: positionValueUsd,
      apr,
      gasCost: COMPOUND_GAS_USD,
      costMultiple: COST_MULTIPLE,
      performanceFeeRate: PERFORMANCE_FEE_RATE,
    }),
    [positionValueUsd, apr],
  )

  const hasValue = positionValueUsd > 0 && apr > 0
  const simple = useMemo(() => projectSimple(config, horizonDays), [config, horizonDays])
  const comp = useMemo(() => projectCompounded(config, horizonDays), [config, horizonDays])
  const nextDays = useMemo(() => nextCompoundEstimateDays(config), [config])
  const curve = useMemo(() => projectionCurve(config, horizonDays, 32), [config, horizonDays])
  const extra = comp.finalValue - simple

  // Sparkline geometry: normalise both lines to the same [principal, max] band.
  const W = 100
  const H = 40
  const maxV = Math.max(config.principal, ...curve.map((p) => p.compounded))
  const minV = config.principal
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
            <div className="text-[11px] text-faint">Reinvest fees, but only when it beats the gas.</div>
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

      {!hasValue ? (
        <p className="text-xs text-faint">Enter amounts to see the projection.</p>
      ) : (
        <>
          <Segmented
            options={HORIZONS.map((h) => ({ key: h.key, label: h.label }))}
            value={String(horizonDays)}
            onChange={(v) => setHorizonDays(Number(v))}
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg glass ring-1 ring-line p-3">
              <div className="text-[11px] text-faint uppercase tracking-wide">Hold</div>
              <div className="font-mono text-lg text-dim tnum mt-1">{usd(simple)}</div>
              <div className="text-[11px] text-faint mt-0.5">no compounding</div>
            </div>
            <div
              className="rounded-lg ring-1 p-3"
              style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
            >
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
                Auto-compound
              </div>
              <div className="font-mono text-lg text-ink tnum mt-1">{usd(comp.finalValue)}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--accent)' }}>
                +{usd(extra)} extra
              </div>
            </div>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" preserveAspectRatio="none" aria-hidden="true">
            <path d={path('simple')} fill="none" stroke="var(--color-dim)" strokeWidth="1" opacity="0.5" />
            <path d={path('compounded')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          </svg>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <PreviewRow label="Effective APY">
              <span className="font-mono text-ink tnum text-xs">
                {pct(comp.effectiveApr)}
                {aprIsEstimate && <span className="text-faint"> · est.</span>}
              </span>
            </PreviewRow>
            <PreviewRow label="Compounds">
              <span className="font-mono text-ink tnum text-xs">{comp.compounds}×</span>
            </PreviewRow>
            <PreviewRow label="Next compound">
              <span className="text-ink text-xs">{humanDays(nextDays)}</span>
            </PreviewRow>
            <PreviewRow label="Gas / compound">
              <span className="font-mono text-dim tnum text-xs">{usd(COMPOUND_GAS_USD)}</span>
            </PreviewRow>
          </div>

          <p className="text-[11px] text-faint leading-relaxed flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0">
              <IconGas size={12} />
            </span>
            <span>
              The agent only compounds when accrued fees clear {COST_MULTIPLE}× the gas, so a small position waits and a
              large one runs often — never at a loss. Figures are estimates.
            </span>
          </p>
        </>
      )}
    </div>
  )
}
