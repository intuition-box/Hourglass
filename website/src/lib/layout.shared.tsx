import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@/components/logo';
import { XIcon } from '@/components/brand-icons';
import { analyticsRoute, docsRoute, githubUrl, redeemRoute, twitterUrl } from './shared';

/**
 * @param stackedNav true where the links render as a column at every width —
 *   the docs sidebar — so the separator can't be chosen by viewport alone.
 */
export function baseOptions({ stackedNav = false } = {}): BaseLayoutProps {
  return {
    nav: {
      title: <Logo size={22} />,
    },
    /* Blog is deliberately unlinked while it has nothing in it — /blog still
       renders and is still crawlable, it just isn't advertised. */
    links: [
      { text: 'Analytics', url: analyticsRoute, active: 'nested-url' },
      { text: 'Claim a payment', url: redeemRoute, active: 'none' },
      {
        /* Docs sits apart at the end. A pipe reads as a separator on a row but
           as nothing in a stacked menu, so the menu gets a rule instead. The
           breakpoint is lg because that is where fumadocs swaps the row for the
           stacked menu — at md the menu was showing the pipe. The docs sidebar
           stacks at every width, so it asks for the rule outright. */
        type: 'custom',
        children: stackedNav ? (
          <span aria-hidden="true" className="my-2 block h-px w-full bg-fd-border" />
        ) : (
          <>
            <span aria-hidden="true" className="mx-1.5 hidden select-none text-fd-muted-foreground/50 lg:inline">
              |
            </span>
            <span aria-hidden="true" className="my-2 block h-px w-full bg-fd-border lg:hidden" />
          </>
        ),
      },
      { text: 'Docs', url: docsRoute, active: 'nested-url' },
      {
        type: 'icon',
        text: 'X',
        label: 'Follow us on X',
        url: twitterUrl,
        external: true,
        icon: <XIcon className="size-4" />,
      },
    ],
    githubUrl,
    // Dark-first; the toggle stays hidden until a light theme is designed.
    themeSwitch: { enabled: false },
  };
}
