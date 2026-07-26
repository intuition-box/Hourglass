import Link from 'next/link';
import { Logo } from '@/components/logo';
import { analyticsRoute, docsRoute, githubUrl, redeemRoute, twitterUrl, umbrellaUrl } from '@/lib/shared';

export function Footer() {
  return (
    <footer className="border-t border-fd-border mt-24">
      <div className="max-w-5xl mx-auto px-6 md:px-8 py-12 flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-3 max-w-xs">
          <Logo size={22} />
          <p className="text-sm text-fd-muted-foreground m-0">
            Recurring on-chain payments for Safe — sign once, capped on-chain,
            non-custodial, revocable.
          </p>
        </div>

        <nav className="flex gap-12 text-sm">
          <div className="flex flex-col gap-2">
            <span className="text-fd-foreground font-medium">Product</span>
            <Link href={redeemRoute} className="text-fd-muted-foreground hover:text-fd-foreground">Claim a payment</Link>
            <Link href={analyticsRoute} className="text-fd-muted-foreground hover:text-fd-foreground">Analytics</Link>
            {/* Blog is unlinked while it has nothing in it; /blog still renders. */}
            <Link href={docsRoute} className="text-fd-muted-foreground hover:text-fd-foreground">Docs</Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-fd-foreground font-medium">Community</span>
            <a href={githubUrl} target="_blank" rel="noreferrer" className="text-fd-muted-foreground hover:text-fd-foreground">GitHub</a>
            <a href={twitterUrl} target="_blank" rel="noreferrer" className="text-fd-muted-foreground hover:text-fd-foreground">X</a>
          </div>
        </nav>
      </div>

      <div className="border-t border-fd-border">
        <div className="max-w-5xl mx-auto px-6 md:px-8 py-5 text-xs text-fd-muted-foreground">
          Made by{' '}
          <a href={umbrellaUrl} target="_blank" rel="noreferrer" className="underline hover:text-fd-foreground">
            intuition.box
          </a>{' '}
          contributors.
        </div>
      </div>
    </footer>
  );
}
