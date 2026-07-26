/**
 * Agent DeFi — the entry point to the two agent-run strategies.
 *
 * Both sign a mandate an agent redeems, bounded on-chain, but they answer different
 * questions: one puts idle treasury to work, the other buys at a price you set. Two
 * cards rather than tabs, because tabs suggest two views of one thing — and because the
 * operator already knows which they came for, so the choice should be explicit rather
 * than landing on whichever happens to be first.
 */
import { useState } from 'react'
import Yield from './Yield'
import LimitOrder from './LimitOrder'
import { Card, Btn } from '../ui/components'
import { IconTrend, IconStop, IconArrowL } from '../ui/icons'

type Strategy = 'liquidity' | 'dip'

const STRATEGIES: {
  key: Strategy
  title: string
  tagline: string
  detail: string
  icon: typeof IconTrend
}[] = [
  {
    key: 'liquidity',
    title: 'Provide liquidity',
    tagline: 'Put idle treasury to work in a Uniswap pool.',
    detail:
      'Deposits two tokens into a pool and earns a share of its trading fees. The agent redeems three pre-approved steps; it cannot change the pool, the amounts, or where the position lands.',
    icon: IconTrend,
  },
  {
    key: 'dip',
    title: 'Buy the dip',
    tagline: 'Buy at a price you set, once, when the market reaches it.',
    detail:
      'The agent watches the price and fills a single swap when your trigger is hit. The spend cap and the minimum received are both enforced on-chain — it can never overspend or overpay.',
    icon: IconStop,
  },
]

export default function AgentDefi({ initial }: { initial?: Strategy }) {
  const [strategy, setStrategy] = useState<Strategy | null>(initial ?? null)

  if (strategy) {
    return (
      <div className="rise">
        <Btn kind="ghost" icon={<IconArrowL size={16} />} onClick={() => setStrategy(null)} className="mb-4">
          All strategies
        </Btn>
        {strategy === 'liquidity' ? <Yield /> : <LimitOrder />}
      </div>
    )
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Agent DeFi</h1>
        <p className="text-dim text-sm mt-1">
          Sign once, an agent executes. Every mandate is capped on-chain and revocable at any time.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {STRATEGIES.map(({ key, title, tagline, detail, icon: Icon }) => (
          <Card key={key} hover onClick={() => setStrategy(key)} className="p-5 cursor-pointer flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div
                className="grid place-items-center w-9 h-9 rounded-xl shrink-0"
                style={{ background: 'rgba(52,211,153,.14)', color: '#34D399' }}
              >
                <Icon size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink">{title}</div>
                <div className="text-xs text-dim">{tagline}</div>
              </div>
            </div>
            <p className="text-xs text-dim leading-relaxed">{detail}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}
