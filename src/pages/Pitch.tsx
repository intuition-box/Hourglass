import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Logo, Mono } from '../ui/components'
import {
  IconSign,
  IconShield,
  IconWallet,
  IconDoc,
  IconStop,
  IconArrowR,
  IconArrowL,
  IconExt,
  IconBolt,
  IconRepeat,
  IconUser,
} from '../ui/icons'

/**
 * /pitch — 10-minute deck for the "Design for Builders" workshop:
 * pitch the product, cue the live demo, hand off the branding to a designer.
 * Navigate with arrow keys, space, or the on-screen controls.
 */

const Kicker = ({ children }: { children: ReactNode }) => (
  <div className="text-[11px] font-bold tracking-[0.25em] uppercase" style={{ color: 'var(--accent)' }}>
    {children}
  </div>
)

const Title = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <h2 className={`mt-3 text-4xl md:text-5xl font-extrabold tracking-tight text-ink leading-[1.05] ${className}`}>
    {children}
  </h2>
)

const Point = ({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) => (
  <div className="flex items-start gap-4">
    <div
      className="grid place-items-center w-9 h-9 rounded-xl shrink-0 ring-1 ring-line glass-soft"
      style={{ color: 'var(--accent)' }}
    >
      {icon}
    </div>
    <div className="min-w-0">
      <div className="text-base font-semibold text-ink">{title}</div>
      <p className="text-sm text-dim leading-relaxed mt-0.5">{desc}</p>
    </div>
  </div>
)

const Swatch = ({ hex, name }: { hex: string; name: string }) => (
  <div>
    <div className="h-14 rounded-xl ring-1 ring-line" style={{ background: hex }} />
    <div className="text-xs text-dim mt-2">{name}</div>
    <Mono className="text-[11px] text-faint">{hex}</Mono>
  </div>
)

const Compare = ({ left, right }: { left: string; right: string }) => (
  <>
    <div className="py-3 pr-6 text-sm text-dim border-t border-line">{left}</div>
    <div className="py-3 text-sm text-ink border-t border-line">{right}</div>
  </>
)

function SlideTitle() {
  return (
    <div className="flex flex-col items-center text-center">
      <Logo size={64} />
      <h1 className="mt-8 text-6xl md:text-7xl font-extrabold tracking-tight leading-none">
        <span className="text-ink">Our</span>
        <span style={{ color: 'var(--accent)' }}>Glass</span>
      </h1>
      <p className="mt-5 text-xl text-ink font-semibold">Sign once. Charged every period.</p>
      <p className="mt-2 text-sm text-dim max-w-md leading-relaxed">
        Recurring payment agreements for Safe treasuries — capped on-chain, documented on IPFS, revocable anytime.
      </p>
      <p className="mt-10 text-[11px] tracking-[0.2em] uppercase text-faint">
        Design for Builders · Fireside Chat · 10 minutes
      </p>
    </div>
  )
}

function SlideProblem() {
  return (
    <div>
      <Kicker>The problem</Kicker>
      <Title>DAO treasuries run on recurring obligations.</Title>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { icon: <IconUser size={18} />, t: 'Payroll', d: 'Contributors paid every month, by a multisig.' },
          { icon: <IconRepeat size={18} />, t: 'Retainers', d: 'DAO-to-DAO service contracts, invoiced per period.' },
          { icon: <IconBolt size={18} />, t: 'Subscriptions', d: 'Infra and tooling, billed again and again.' },
        ].map(({ icon, t, d }) => (
          <div key={t} className="rounded-2xl p-5 ring-1 ring-line glass-soft">
            <div className="flex items-center gap-2 text-ink font-semibold" style={{ color: 'var(--accent)' }}>
              {icon}
              <span className="text-ink">{t}</span>
            </div>
            <p className="text-sm text-dim leading-relaxed mt-2">{d}</p>
          </div>
        ))}
      </div>
      <p className="mt-10 text-lg text-ink font-medium max-w-2xl leading-relaxed">
        Every cycle: a proposal, a signature round, a payment that lands late or not at all.{' '}
        <span className="text-dim">Multisig coordination is the bottleneck — and the treasury team carries it every month.</span>
      </p>
    </div>
  )
}

function SlideProduct() {
  return (
    <div>
      <Kicker>The product</Kicker>
      <Title>The payer signs once. The payee charges itself.</Title>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-7 max-w-4xl">
        <Point
          icon={<IconSign size={18} />}
          title="One signature"
          desc="A single EIP-712 signature from the Safe is the whole authorization. No more proposals per payment."
        />
        <Point
          icon={<IconShield size={18} />}
          title="Capped on-chain"
          desc="Never above the agreed amount, never twice in the same period. Enforced by the protocol, not by trust."
        />
        <Point
          icon={<IconWallet size={18} />}
          title="No escrow"
          desc="Funds stay in the treasury until the moment they are charged. A capability, not a balance."
        />
        <Point
          icon={<IconDoc size={18} />}
          title="Readable terms"
          desc="A human-readable agreement pinned to IPFS, cryptographically bound to the signature."
        />
        <Point
          icon={<IconStop size={18} />}
          title="Revocable"
          desc="The payer disables the agreement on-chain, unilaterally, anytime. The next charge reverts."
        />
      </div>
    </div>
  )
}

function SlideHow() {
  const steps = [
    { n: '01', t: 'Install the module', d: 'A minimal DeleGator module is enabled on the Safe. One-time setup.' },
    { n: '02', t: 'Sign the agreement', d: 'EIP-712 delegation, salt = keccak256(terms). The signature is bound to the exact contract text.' },
    { n: '03', t: 'Charge per period', d: 'The payee redeems on-chain. An ERC-7710 caveat enforces the per-period cap.' },
    { n: '04', t: 'Revoke', d: 'disableDelegation, routed through the module. Any later charge reverts.' },
  ]
  return (
    <div>
      <Kicker>Under the hood</Kicker>
      <Title>A Safe module + an ERC-7710 delegation.</Title>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-4 gap-4">
        {steps.map(({ n, t, d }) => (
          <div key={n} className="rounded-2xl p-5 ring-1 ring-line glass-soft">
            <Mono className="text-[11px]" >
              <span style={{ color: 'var(--accent)' }}>{n}</span>
            </Mono>
            <div className="text-sm font-semibold text-ink mt-2">{t}</div>
            <p className="text-xs text-dim leading-relaxed mt-1.5">{d}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-sm text-faint">
        Built on the MetaMask Delegation Framework — audited, deterministic deployments. Live on Base, Base Sepolia and Ethereum Sepolia.
      </p>
    </div>
  )
}

function SlideDemo() {
  return (
    <div className="text-center">
      <Kicker>Live demo</Kicker>
      <a
        href="https://hourglass.box/"
        target="_blank"
        rel="noreferrer"
        className="mt-6 inline-flex items-center gap-3 text-3xl md:text-5xl font-extrabold tracking-tight text-ink hover:opacity-90 transition"
      >
        hourglass.box
        <IconExt size={28} style={{ color: 'var(--accent)' }} />
      </a>
      <ol className="mt-12 inline-flex flex-col items-start gap-4 text-left">
        {[
          'Create and sign a subscription inside the Safe',
          'Open the pinned IPFS agreement',
          'Charge it from the standalone biller console (/redeem)',
          'Revoke — and watch the next charge revert',
        ].map((s, i) => (
          <li key={s} className="flex items-center gap-4">
            <Mono className="text-xs">
              <span style={{ color: 'var(--accent)' }}>{String(i + 1).padStart(2, '0')}</span>
            </Mono>
            <span className="text-base text-ink">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function SlideHandoff() {
  return (
    <div className="text-center">
      <Kicker>Part two</Kicker>
      <Title className="md:text-6xl">Branding handoff.</Title>
      <p className="mt-5 text-lg text-dim max-w-xl mx-auto leading-relaxed">
        What we have, why it means something, and where we need a designer.
      </p>
    </div>
  )
}

function SlideSablier() {
  return (
    <div>
      <Kicker>Prior art</Kicker>
      <Title>Sablier got there first — in French.</Title>
      <div className="mt-9 max-w-3xl space-y-5">
        <p className="text-lg text-ink leading-relaxed">
          <span className="font-semibold">Sablier</span> <span className="text-dim">(French for hourglass)</span> has
          streamed tokens since 2019: money melts through time, by the second, like sand. Vesting, airdrops, payroll.
        </p>
        <p className="text-base text-dim leading-relaxed">
          Their brand commits fully to the metaphor — an orange hourglass on dark blue, and every stream minted as an
          NFT whose hourglass artwork is generated on-chain from the stream itself.
        </p>
        <p className="text-lg text-ink font-medium leading-relaxed">
          The hourglass works as a payments metaphor. We are keeping it — and answering back in English.{' '}
          <span style={{ color: 'var(--accent)' }}>Almost.</span>
        </p>
      </div>
    </div>
  )
}

function SlideName() {
  return (
    <div>
      <Kicker>The name</Kicker>
      <div className="mt-6 text-5xl md:text-7xl font-extrabold tracking-tight leading-none select-none">
        <span className="text-faint line-through decoration-2">H</span>
        <span className="text-ink">OUR</span>
        <span style={{ color: 'var(--accent)' }}>GLASS</span>
      </div>
      <div className="mt-12 max-w-3xl space-y-6">
        {[
          {
            n: '01',
            d: 'The hourglass is the most legible image of value moving through time — you watch the sand flow. Transparency of the payment stream, built into the object.',
          },
          {
            n: '02',
            d: 'Hour becomes Our. Contributors and contractors take what is rightly theirs, per agreement. The payee pulls; nobody has to push.',
          },
          {
            n: '03',
            d: "Two of the founders are French. The H was never going to survive anyway — ze 'ourglass. The accent is the brand.",
          },
        ].map(({ n, d }) => (
          <div key={n} className="flex items-start gap-5">
            <Mono className="text-xs mt-1">
              <span style={{ color: 'var(--accent)' }}>{n}</span>
            </Mono>
            <p className="text-base text-ink leading-relaxed">{d}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function SlidePositioning() {
  return (
    <div>
      <Kicker>Positioning</Kicker>
      <Title>Streaming vs. agreements.</Title>
      <div className="mt-10 grid grid-cols-2 max-w-3xl">
        <div className="pb-3 pr-6 text-sm font-bold tracking-wide uppercase text-dim">Sablier</div>
        <div className="pb-3 text-sm font-bold tracking-wide uppercase" style={{ color: 'var(--accent)' }}>
          HourGlass
        </div>
        <Compare left="Continuous streams, by the second" right="Discrete charges, per agreed period" />
        <Compare left="Funds deposited into the stream up front" right="Funds stay in the treasury — no escrow" />
        <Compare left="Recipient withdraws what has accrued" right="Payee claims the agreed amount, under an on-chain cap" />
        <Compare left="A stream is an NFT" right="An agreement is signed terms, pinned to IPFS" />
      </div>
      <p className="mt-10 text-lg text-ink font-medium">
        Sablier melts money through time. <span style={{ color: 'var(--accent)' }}>HourGlass lets you take what's yours, on time.</span>
      </p>
    </div>
  )
}

function IdentityContent() {
  return (
    <div>
      <Kicker>What exists</Kicker>
      <Title>Blue glass.</Title>
      <div className="mt-10 flex flex-col md:flex-row gap-10 items-start">
        <div className="flex flex-col items-center gap-4 rounded-2xl p-8 ring-1 ring-line glass-soft shrink-0">
          <Logo size={88} />
          <p className="text-xs text-dim text-center max-w-[180px] leading-relaxed">
            An hourglass with a token falling through — animated in product.
          </p>
        </div>
        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
            <Swatch hex="#080b12" name="base" />
            <Swatch hex="#131a2a" name="panel" />
            <Swatch hex="#3b82f6" name="primary" />
            <Swatch hex="#22d3ee" name="accent" />
            <Swatch hex="#34d399" name="active" />
            <Swatch hex="#eaeef6" name="ink" />
          </div>
          <div className="mt-8 space-y-2 text-sm text-dim leading-relaxed">
            <p>
              <span className="text-ink font-semibold">Manrope</span> for prose,{' '}
              <Mono className="text-[13px]">JetBrains Mono</Mono> for money, addresses and hashes.
            </p>
            <p>Dark-first. Glassmorphism panels, hairline borders, negative space.</p>
            <p>
              Deliberately blue — the opposite shore from Sablier's orange.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function SlideScrapIt() {
  return (
    <div className="relative">
      <div className="opacity-25 grayscale select-none" aria-hidden="true">
        <IdentityContent />
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <div
          className="text-center px-10 py-8 rounded-2xl glass-strong"
          style={{
            transform: 'rotate(-6deg)',
            boxShadow: 'inset 0 0 0 3px var(--color-danger, #fb7185)',
            animation: 'pitch-stamp .3s cubic-bezier(.2,1.6,.4,1) both .15s',
          }}
        >
          <div className="text-5xl md:text-7xl font-extrabold tracking-tight leading-none" style={{ color: 'var(--color-danger, #fb7185)' }}>
            SCRAP IT ALL.
          </div>
          <p className="mt-4 text-lg md:text-xl text-ink font-semibold">
            Start from zero. Blank canvas, no sacred cows.
          </p>
          <p className="mt-1.5 text-base text-dim">Free-for-all, Saulo. Surprise us.</p>
        </div>
      </div>
    </div>
  )
}

function SlideBrainstorm() {
  const sparks = [
    'The dropped H — an apostrophe, a turned glass, a silent letter. Is there a mark hiding in the typo?',
    'Sand as tokens — value you can watch move. How far can the metaphor go before it gets cute?',
    'The flip — an hourglass resets by turning over. Renewal, periods, rhythm. Is the rotation the gesture of the brand?',
    'Trust without a suit — this signs real treasury money. How does it look serious without looking like a bank?',
    'Five-second landing page — a DAO operator should get "sign once, charged every period" before the first scroll.',
    'Anti-Sablier — they own orange streams. What do we own?',
  ]
  return (
    <div>
      <Kicker>Not a brief</Kicker>
      <Title>Food for the brainstorm.</Title>
      <p className="mt-4 text-base text-dim max-w-2xl leading-relaxed">
        No deliverables, no checklist — just the threads we keep pulling on. Take any of them, or none.
      </p>
      <div className="mt-8 max-w-3xl space-y-4">
        {sparks.map((s, i) => (
          <div key={s} className="flex items-start gap-5 border-t border-line pt-4 first:border-t-0 first:pt-0">
            <Mono className="text-xs mt-1">
              <span style={{ color: 'var(--accent)' }}>{String(i + 1).padStart(2, '0')}</span>
            </Mono>
            <p className="text-base text-ink leading-relaxed">{s}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function SlideClose() {
  return (
    <div className="flex flex-col items-center text-center">
      <Logo size={52} />
      <h2 className="mt-7 text-4xl md:text-5xl font-extrabold tracking-tight text-ink">
        Sign once. Charged every period.
      </h2>
      <div className="mt-10 flex flex-col md:flex-row items-center gap-3 md:gap-8">
        <a
          href="https://hourglass.box/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-sm text-dim hover:text-ink transition"
        >
          <IconExt size={14} /> hourglass.box
        </a>
        <a
          href="https://github.com/intuition-box/Hourglass"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-sm text-dim hover:text-ink transition"
        >
          <IconExt size={14} /> github.com/intuition-box/Hourglass
        </a>
      </div>
      <p className="mt-12 text-sm text-faint">Merci. Questions welcome — H optional.</p>
    </div>
  )
}

const SLIDES: { key: string; el: ReactNode; center?: boolean }[] = [
  { key: 'title', el: <SlideTitle />, center: true },
  { key: 'problem', el: <SlideProblem /> },
  { key: 'product', el: <SlideProduct /> },
  { key: 'how', el: <SlideHow /> },
  { key: 'demo', el: <SlideDemo />, center: true },
  { key: 'handoff', el: <SlideHandoff />, center: true },
  { key: 'sablier', el: <SlideSablier /> },
  { key: 'name', el: <SlideName /> },
  { key: 'positioning', el: <SlidePositioning /> },
  { key: 'identity', el: <IdentityContent /> },
  { key: 'scrap', el: <SlideScrapIt /> },
  { key: 'brainstorm', el: <SlideBrainstorm /> },
  { key: 'close', el: <SlideClose />, center: true },
]

export default function Pitch() {
  const [index, setIndex] = useState(0)
  const last = SLIDES.length - 1

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta))),
    [last],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        go(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        go(-1)
      } else if (e.key === 'Home') {
        setIndex(0)
      } else if (e.key === 'End') {
        setIndex(last)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, last])

  const slide = SLIDES[index]

  return (
    <div className="min-h-screen flex flex-col">
      <style>
        {'@keyframes pitch-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
          '@keyframes pitch-stamp{from{opacity:0;transform:rotate(-6deg) scale(1.6)}to{opacity:1;transform:rotate(-6deg) scale(1)}}'}
      </style>

      <main
        key={slide.key}
        className={`flex-1 flex flex-col px-8 md:px-20 py-14 max-w-6xl w-full mx-auto ${
          slide.center ? 'items-center justify-center' : 'justify-center'
        }`}
        style={{ animation: 'pitch-in .35s ease both' }}
      >
        {slide.el}
      </main>

      <footer className="flex items-center justify-between px-8 md:px-20 pb-6 max-w-6xl w-full mx-auto">
        <div className="text-[11px] text-faint tracking-wide">HourGlass — Design for Builders</div>
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Slides">
          {SLIDES.map((s, i) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={i === index}
              aria-label={`Slide ${i + 1}: ${s.key}`}
              onClick={() => setIndex(i)}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: i === index ? 18 : 6,
                background: i === index ? 'var(--accent)' : 'var(--color-line2, #2e3a55)',
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => go(-1)}
            disabled={index === 0}
            aria-label="Previous slide"
            className="grid place-items-center w-8 h-8 rounded-lg ring-1 ring-line text-dim hover:text-ink disabled:opacity-30 transition"
          >
            <IconArrowL size={15} />
          </button>
          <Mono className="text-[11px] text-faint">
            {String(index + 1).padStart(2, '0')} / {String(SLIDES.length).padStart(2, '0')}
          </Mono>
          <button
            onClick={() => go(1)}
            disabled={index === last}
            aria-label="Next slide"
            className="grid place-items-center w-8 h-8 rounded-lg ring-1 ring-line text-dim hover:text-ink disabled:opacity-30 transition"
          >
            <IconArrowR size={15} />
          </button>
        </div>
      </footer>
    </div>
  )
}
