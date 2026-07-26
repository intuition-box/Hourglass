import { Logo } from '../ui/components'

const REPO_URL = 'https://github.com/intuition-box/Hourglass'

/**
 * Shown when the app is opened top-level (not inside a Safe iframe). The Safe
 * App itself needs the iframe to connect; here we offer the biller's standalone
 * charge console instead of spinning on "Connecting to Safe…" forever.
 *
 * Faithful port of the designer's `desing.html` hero: a live stream runs down
 * the right edge, a light-streaks video fills the right half, both gated on
 * prefers-reduced-motion.
 */
export default function Landing() {
  return (
    <section className="relative flex min-h-screen flex-col overflow-hidden px-6 pb-14 pt-10 sm:px-12">
      {/* signature: a thin live stream down the right edge */}
      <div className="stream-edge absolute right-0 top-0 z-20 h-full w-1" aria-hidden="true" />

      {/* background video — right half, full height, faded into the base */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 right-0 z-0 overflow-hidden" aria-hidden="true">
        <video
          className="hero-video h-full w-full object-cover"
          src="/hero.mp4"
          autoPlay
          muted
          loop
          playsInline
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, var(--color-base) 0%, rgba(10,10,11,0) 45%), linear-gradient(180deg, var(--color-base) 0%, rgba(10,10,11,0) 18%), linear-gradient(0deg, var(--color-base) 0%, rgba(10,10,11,0) 22%)',
          }}
        />
      </div>

      <nav className="relative z-10 flex items-center justify-between">
        <Logo size={52} />
        <div className="flex items-center gap-7">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm text-[15px] font-medium text-ink transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-base"
          >
            GitHub
          </a>
          <a
            href="https://app.safe.global"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[42px] items-center rounded-full bg-[#f5f5f7] px-[22px] text-[15px] font-semibold text-[#111] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-base"
          >
            Add to your Safe
          </a>
        </div>
      </nav>

      <div className="relative z-10 mt-16 max-w-[880px]">
        <h1 className="text-[clamp(40px,5.2vw,64px)] font-semibold leading-[1.12] tracking-[-1.5px]">
          Recurring payments<br />for DAO treasuries.
        </h1>

        <div className="mt-10 flex items-center gap-[18px]">
          <a
            href="/redeem"
            className="group inline-flex items-stretch gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-base"
          >
            <span className="inline-flex h-12 items-center rounded-full bg-[#f5f5f7] px-7 text-base font-semibold text-[#111] transition-opacity group-hover:opacity-90">
              Claim your payment
            </span>
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-[14px] bg-[#f5f5f7] text-[#111] transition-[border-radius,opacity] duration-200 group-hover:rounded-full group-hover:opacity-90">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M4 12h16" />
                <path d="M13 5l7 7-7 7" />
              </svg>
            </span>
          </a>
        </div>

      </div>

      <div className="relative z-10 mt-auto flex flex-col gap-3.5 pt-[120px]">
        <p className="text-[17px] text-faint"><b className="mr-1.5 font-semibold text-ink">Sign once</b>remove the monthly signing burden from your signers</p>
        <p className="text-[17px] text-faint"><b className="mr-1.5 font-semibold text-ink">Capped on-chain</b>never above the agreed amount, never twice</p>
        <p className="text-[17px] text-faint"><b className="mr-1.5 font-semibold text-ink">Non-custodial</b>funds stay in your Safe until the moment of charge</p>
        <p className="text-[17px] text-faint"><b className="mr-1.5 font-semibold text-ink">Charged every period</b>by the receiver, no subsequent signers needed</p>
        <p className="text-[17px] text-faint"><b className="mr-1.5 font-semibold text-ink">Revocable</b>cancel any agreement on-chain, at any time</p>
      </div>
    </section>
  )
}
