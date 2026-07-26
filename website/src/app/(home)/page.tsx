import { SafeAppRedirect } from '@/components/safe-app-redirect';
import { HeroRings } from '@/components/magic-rings/HeroRings';
import { AccessShowcase } from '@/components/hourglass-die';
import Link from 'next/link';
import { safeAppGuideRoute } from '@/lib/shared';

export default function Home() {
  return (
    <>
      {/* When framed by Safe, hand off to the Vite app under /safe-app. */}
      <SafeAppRedirect />

      <section className="relative flex min-h-[calc(100vh-56px)] flex-col overflow-hidden px-6 pb-14 pt-12 sm:px-12">
        <HeroRings />

        {/* signature: a thin live stream down the right edge */}
        <div className="stream-edge absolute right-0 top-0 z-20 h-full w-1" aria-hidden="true" />

        {/* The headline spans both columns: at this size it needs the full width
            to stay on two lines. */}
        <h1 className="relative z-10 max-w-[1180px] text-[clamp(38px,4.8vw,66px)] font-semibold leading-[1.06] tracking-[-2px]">
          Delegate the flow, not the funds.
        </h1>

        <AccessShowcase>
          {/* The mark's own mint, so the one CTA belongs to the same object as
              the die and the logo rather than to the template it came from. */}
          <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4">
            <Link
              href={safeAppGuideRoute}
              className="inline-flex h-12 items-center rounded-full bg-[#7ff2cd] px-7 text-base font-semibold text-[#06231b] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-base)]"
            >
              Add Hourglass to your Safe
            </Link>
            <p className="text-[20px] text-fd-muted-foreground">No black box. Just glass.</p>
          </div>
        </AccessShowcase>
      </section>
    </>
  );
}
