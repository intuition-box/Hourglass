import { useState, type ComponentType } from 'react'
import Home from './pages/Home'
import CreateDelegation from './pages/CreateDelegation'
import CreateStream from './pages/CreateStream'
import Charge from './pages/Charge'
import Yield from './pages/Yield'
import Strategy from './pages/Strategy'
import LimitOrder from './pages/LimitOrder'
import Aqua from './pages/Aqua'
import { useFinalizePending } from './hooks/useFinalizePending'
import { Logo, Card } from './ui/components'
import { IconGrid, IconPlus, IconBolt, IconRepeat, IconLock, IconArrowR, IconTrend, IconStop, IconCube } from './ui/icons'

type Page = 'home' | 'create' | 'redeem' | 'yield' | 'strategy' | 'limit' | 'aqua'
type CreateMode = 'choose' | 'subscription' | 'stream'

const NAV: { key: Page; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { key: 'home', label: 'Overview', icon: IconGrid },
  { key: 'create', label: 'Create', icon: IconPlus },
  { key: 'redeem', label: 'Charge', icon: IconBolt },
  { key: 'yield', label: 'Yield', icon: IconTrend },
  // Strategy (DCA) tab hidden from nav for the demo — the rail isn't functional yet
  // (needs the Permit2 setup the limit order got). Code kept; re-add when it works.
  // { key: 'strategy', label: 'Strategy', icon: IconRepeat },
  { key: 'limit', label: 'Limit order', icon: IconStop },
  { key: 'aqua', label: 'Aqua', icon: IconCube },
]

function ChoiceCard({
  icon: Icon,
  tint,
  title,
  tagline,
  example,
  audience,
  onSelect,
}: {
  icon: ComponentType<{ size?: number }>
  tint: string
  title: string
  tagline: string
  example: string
  audience: string
  onSelect: () => void
}) {
  return (
    <Card hover onClick={onSelect} className="p-6 cursor-pointer flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="grid place-items-center w-10 h-10 rounded-xl shrink-0" style={{ background: `${tint}22`, color: tint }}>
            <Icon size={20} />
          </div>
          <h2 className="text-lg font-bold text-ink truncate">{title}</h2>
        </div>
        <IconArrowR size={18} className="text-faint shrink-0" />
      </div>
      <p className="text-sm text-dim -mt-1">{tagline}</p>
      <div className="rounded-xl bg-raised ring-1 ring-line p-3 text-[13px] text-dim leading-relaxed">{example}</div>
      <div className="mt-auto flex items-center gap-1.5 text-[11px] font-medium text-faint uppercase tracking-wide">
        <IconLock size={12} /> {audience}
      </div>
    </Card>
  )
}

function CreateChoice({ onPick }: { onPick: (mode: CreateMode) => void }) {
  return (
    <div className="rise">
      <h1 className="text-2xl font-extrabold tracking-tight text-ink">What are you setting up?</h1>
      <p className="text-dim text-sm mt-1">Two ways to pay on a schedule. The difference is what happens to an unclaimed period.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
        <ChoiceCard
          icon={IconBolt}
          tint="#3B82F6"
          title="Subscription"
          tagline="A cap per period, claimed each period. Does not accumulate."
          example="10 USDC/month. If the org doesn't charge January, those 10 are gone. February resets to 10 max. No debt piles up. Best for paying a service."
          audience="DAO ↔ service"
          onSelect={() => onPick('subscription')}
        />
        <ChoiceCard
          icon={IconRepeat}
          tint="#22D3EE"
          title="Stream"
          tagline="Accrues continuously, claimable anytime. Nothing is lost if you wait."
          example="1000 USDC/month flowing by the second. After 15 days ~500 USDC are available. Don't claim for 2 months and ~2000 wait for you. Best for a salary."
          audience="Contributor / payroll"
          onSelect={() => onPick('stream')}
        />
      </div>
    </div>
  )
}

function AppInner() {
  const [page, setPage] = useState<Page>('home')
  const [createMode, setCreateMode] = useState<CreateMode>('choose')

  // Finalize-on-open (ADR 0005): poke the publisher for any finalized mandate the
  // Safe signed, from ANY tab — not only Overview. A strategy / limit-order
  // operator signs on that tab and stays there; mounting this at the app root means
  // the poke fires as soon as the message reaches its signing threshold, without
  // having to navigate back to Home.
  useFinalizePending()

  function navigate(key: Page) {
    if (key === 'create') setCreateMode('choose')
    setPage(key)
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-[1440px] mx-auto px-6 py-6 grid grid-cols-[240px_1fr] gap-8">
        {/* Sidebar */}
        <aside className="flex flex-col gap-5 glass-strong rounded-2xl ring-1 ring-line p-4">
          <Logo size={30} />
          <nav className="flex flex-col gap-1">
            {NAV.map(({ key, label, icon: Icon }) => {
              const active = page === key
              return (
                <button
                  key={key}
                  onClick={() => navigate(key)}
                  className={`group flex items-center gap-3 rounded-xl px-3 h-10 text-sm font-medium transition-colors ${
                    active ? 'glass-soft text-ink ring-1 ring-line2' : 'text-dim hover:text-ink hover:bg-raised'
                  }`}
                >
                  <span style={{ color: active ? 'var(--accent)' : undefined }}>
                    <Icon size={18} />
                  </span>
                  {label}
                </button>
              )
            })}
          </nav>

          <div className="mt-auto rounded-2xl p-4 ring-1 ring-line glass-soft" style={{ background: 'linear-gradient(160deg,rgba(88,230,184,.12),rgba(28,28,31,.5))' }}>
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <IconBolt size={14} style={{ color: 'var(--accent)' }} /> Sign once.
            </div>
            <p className="text-[11px] text-dim leading-relaxed mt-1.5">Charged every period. Capped on-chain. Revocable.</p>
          </div>
        </aside>

        {/* Content. px/pb give the cards' 1px ring (a box-shadow) room so it
            isn't clipped by this scroll container — overflow-y:auto forces
            overflow-x to clip too, which otherwise cuts the hairline border. */}
        <main className="app-scroll overflow-y-auto rise px-1 pt-1 pb-3" style={{ maxHeight: 'calc(100vh - 48px)' }}>
          {page === 'home' && <Home onNavigate={navigate} />}
          {page === 'create' && createMode === 'choose' && <CreateChoice onPick={setCreateMode} />}
          {page === 'create' && createMode === 'subscription' && <CreateDelegation />}
          {page === 'create' && createMode === 'stream' && <CreateStream />}
          {page === 'redeem' && <Charge />}
          {page === 'yield' && <Yield />}
          {page === 'strategy' && <Strategy />}
          {page === 'limit' && <LimitOrder />}
          {page === 'aqua' && <Aqua />}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return <AppInner />
}
