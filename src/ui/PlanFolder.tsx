/**
 * A yield plan as one card that opens into its three delegations.
 *
 * The plan is the unit the operator thinks in — one deposit, one decision — while the
 * chain sees three separate mandates. Showing three cards for one deposit buries the
 * treasury's actual operations under its implementation; folding them keeps both
 * readable, with the parts one click away.
 */
import { useState } from 'react'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import type { RecoveredYieldPlan, YieldPlanStep } from '../hooks/useSafeYieldPlans'
import { Card, Btn, Mono, Payee } from './components'
import { IconCheck } from './icons'

const MINT_SELECTOR = '0x88316456'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function stepLabel(step: YieldPlanStep): string {
  return step.selector.toLowerCase() === MINT_SELECTOR ? 'Mint position' : 'Approve token'
}

/** Trim without hiding the magnitude of a small deposit. */
function amount(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals))
  if (n === 0) return '0'
  if (n < 0.0001) return n.toExponential(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function PlanFolder({
  plan,
  apy,
  onOpenStep,
  onRevokeStep,
  revokingHash,
}: {
  plan: RecoveredYieldPlan
  /** Pool APY as a fraction, when the subgraph has enough data for it. */
  apy?: number | null
  onOpenStep: (step: YieldPlanStep) => void
  onRevokeStep: (step: YieldPlanStep) => void
  revokingHash: string | null
}) {
  const [open, setOpen] = useState(false)
  const d = plan.deposit
  // Same derivation as SubCard, so a plan and a subscription look like siblings.
  const palette = ['#3B82F6', '#22D3EE', '#8B5CF6', '#34D399', '#FB7185', '#FBBF24']
  let h = 0
  for (let i = 2; i < plan.agentAddress.length; i++) h = (h * 31 + plan.agentAddress.charCodeAt(i)) >>> 0
  const tint = palette[h % palette.length]
  const logo = plan.agentAddress.slice(2, 4).toUpperCase()

  return (
    <>
      <Card hover onClick={() => setOpen(true)} className="p-5 cursor-pointer relative">
        <div className="flex items-start justify-between gap-3">
          <Payee
            logo={logo}
            tint={tint}
            name="Liquidity deposit"
            addr={d ? `${d.token0.symbol} / ${d.token1.symbol} · ${d.fee / 10000}%` : short(plan.agentAddress)}
          />
          {typeof apy === 'number' && (
            <span className="text-xs font-semibold shrink-0" style={{ color: '#34D399' }}>
              {(apy * 100).toFixed(1)}% APY
            </span>
          )}
        </div>

        {d && (
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg glass-soft ring-1 ring-line px-3 py-2">
              <div className="text-faint">{d.token0.symbol}</div>
              <div className="text-ink font-semibold mt-0.5 font-mono tnum">{amount(d.amount0, d.token0.decimals)}</div>
            </div>
            <div className="rounded-lg glass-soft ring-1 ring-line px-3 py-2">
              <div className="text-faint">{d.token1.symbol}</div>
              <div className="text-ink font-semibold mt-0.5 font-mono tnum">{amount(d.amount1, d.token1.decimals)}</div>
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-dim">Open to inspect or revoke</div>
      </Card>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center p-4"
          style={{ background: 'rgba(0,0,0,.6)' }}
          onClick={() => setOpen(false)}
        >
          <Card className="p-5 w-full max-w-lg space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-ink">Liquidity deposit</div>
                <Mono className="text-[11px] text-faint">Agent {short(plan.agentAddress)}</Mono>
              </div>
              <Btn kind="ghost" size="sm" onClick={() => setOpen(false)}>Close</Btn>
            </div>

            <div className="space-y-2">
              {plan.steps.map((step) => {
                const hash = step.delegation.meta.delegationHash
                return (
                  <div key={hash} className="rounded-lg bg-raised ring-1 ring-line p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-ink flex items-center gap-1.5">
                        {stepLabel(step)}
                        {step.consumed && <IconCheck size={12} />}
                      </div>
                      <Mono className="text-[11px] text-faint truncate">{short(hash)}</Mono>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Btn kind="ghost" size="sm" onClick={() => onOpenStep(step)}>Details</Btn>
                      {/* A consumed step cannot be redeemed again, so revoking it changes
                          nothing — the action is offered only where it still bites. */}
                      {!step.consumed && (
                        <Btn
                          kind="ghost"
                          size="sm"
                          onClick={() => onRevokeStep(step)}
                          disabled={revokingHash === hash}
                        >
                          {revokingHash === hash ? 'Revoking…' : 'Revoke'}
                        </Btn>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* The steps are only independent on-chain. As a deposit they are one thing:
                without its approvals the mint reverts, so revoking any single step ends
                the plan. Saying "the others stay valid" would be true and misleading. */}
            <p className="text-[11px] text-pending leading-relaxed">
              Revoking any one step ends the whole deposit — the mint needs both approvals to go through. The remaining
              mandates stay signed but can no longer complete.
            </p>
          </Card>
        </div>
      )}
    </>
  )
}

export type { RecoveredYieldPlan, YieldPlanStep }
export type PlanAgent = Address
