import React from 'react'
import ReactDOM from 'react-dom/client'
import SafeProvider from '@safe-global/safe-apps-react-sdk'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './config/chains'
import App from './App'
import Verify from './pages/Verify'
import { Logo, Card } from './ui/components'
import './index.css'

const queryClient = new QueryClient()

// Workshop slide deck, lazy-loaded so it stays out of the app bundle.
const Pitch = React.lazy(() => import('./pages/Pitch'))

// The Safe App is served under /safe-app on the shared domain; utility pages keep
// their own routes beneath it. The redeem console now lives on the website at
// /redeem. Everything else is the in-Safe app shell.
const isPitch = window.location.pathname === '/safe-app/pitch'
const isVerify = window.location.pathname === '/safe-app/verify'
// The Safe App only works inside the Safe iframe. A top-level visitor who reaches
// the app shell (not a utility route, not framed by Safe) belongs on the website
// landing, which now lives at the domain root.
const inSafeIframe = window.self !== window.top
const isUtilityRoute = isPitch || isVerify
// Only PROD has a separate site serving '/' to redirect to. In dev there is no
// such site, so redirecting to '/' just reloads this same script and loops —
// show instructions instead of flickering forever.
const shouldRedirectToWebsite = !isUtilityRoute && !inSafeIframe && import.meta.env.PROD
const shouldShowDevInstructions = !isUtilityRoute && !inSafeIframe && import.meta.env.DEV

if (shouldRedirectToWebsite) {
  window.location.replace('/')
} else if (shouldShowDevInstructions) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <div className="min-h-screen bg-base flex items-center justify-center p-6">
        <Card className="max-w-md p-6">
          <div className="flex items-center gap-3 mb-4">
            <Logo size={28} />
            <span className="text-sm font-semibold text-ink">Dev preview</span>
          </div>
          <p className="text-sm text-dim leading-relaxed">
            This app only runs inside a Safe iframe — it reads the connected chain and
            account from the Safe Apps SDK, which requires a real Safe context.
          </p>
          <p className="text-sm text-dim leading-relaxed mt-3">
            To preview it: open your Safe → Apps → My custom apps → add{' '}
            <code className="font-mono text-ink">{window.location.origin}/safe-app/</code>.
          </p>
        </Card>
      </div>
    </React.StrictMode>,
  )
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPitch ? (
      <React.Suspense fallback={<div className="min-h-screen bg-base" />}>
        <Pitch />
      </React.Suspense>
    ) : isVerify ? (
      <Verify />
    ) : (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <SafeProvider
            loader={
              <div className="flex items-center justify-center min-h-screen bg-base">
                <div className="flex flex-col items-center gap-4">
                  <Logo size={34} />
                  <div className="flex items-center gap-2 text-sm text-dim">
                    <span className="w-4 h-4 border-2 border-line border-t-[color:var(--accent)] rounded-full animate-spin" />
                    Connecting to Safe…
                  </div>
                </div>
              </div>
            }
          >
            <App />
          </SafeProvider>
        </QueryClientProvider>
      </WagmiProvider>
    )}
  </React.StrictMode>,
  )
}
