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
import type { RecoveredYieldPlan, YieldPlanStep } from '../hooks/useSafeYieldPlans'
import { Card, Btn, Mono } from './components'
import { IconCheck, IconTrend } from './icons'

const MINT_SELECTOR = '0x88316456'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function stepLabel(step: YieldPlanStep): string {
  return step.selector.toLowerCase() === MINT_SELECTOR ? 'Mint position' : 'Approve token'
}

export function PlanFolder({
  plan,
  onOpenStep,
  onRevokeStep,
  revokingHash,
}: {
  plan: RecoveredYieldPlan
  onOpenStep: (step: YieldPlanStep) => void
  onRevokeStep: (step: YieldPlanStep) => void
  revokingHash: string | null
}) {
  const [open, setOpen] = useState(false)
  const spent = plan.steps.filter((s) => s.consumed).length

  return (
    <>
      <Card hover onClick={() => setOpen(true)} className="p-5 cursor-pointer">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="grid place-items-center w-9 h-9 rounded-xl shrink-0"
              style={{ background: 'rgba(52,211,153,.14)', color: '#34D399' }}
            >
              <IconTrend size={18} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink">Liquidity deposit</div>
              <Mono className="text-[11px] text-faint">{short(plan.agentAddress)}</Mono>
            </div>
          </div>
          <span className="text-[11px] text-faint shrink-0">
            {plan.done ? 'complete' : plan.complete ? `${spent}/${plan.steps.length} done` : 'indexing'}
          </span>
        </div>
        <div className="mt-4 text-xs text-dim">
          {plan.steps.length} delegation{plan.steps.length === 1 ? '' : 's'} — open to inspect or revoke
        </div>
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
