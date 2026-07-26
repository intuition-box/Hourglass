export const appName = 'HourGlass';
export const siteUrl = 'https://hourglass.box';
export const docsRoute = '/docs';
/** Where the one CTA points: how to add the app to a Safe. */
export const safeAppGuideRoute = `${docsRoute}/guides/safe-app`;
export const blogRoute = '/blog';
export const analyticsRoute = '/analytics';

// The Vite Safe App is served on the same domain under /safe-app (Caddy routing).
export const appRoute = '/safe-app';
// The redeem console is a public, wallet-only page served by the website itself.
export const redeemRoute = '/redeem';
export const safeGlobalUrl = 'https://app.safe.global';

export const twitterUrl = 'https://x.com/intuition_box';
export const umbrellaUrl = 'https://intuition.box';

export const gitConfig = {
  user: 'intuition-box',
  repo: 'Hourglass',
  branch: 'main',
};
export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
