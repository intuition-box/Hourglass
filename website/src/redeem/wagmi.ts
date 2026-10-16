import { http, createConfig } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { SUPPORTED_CHAINS, rpcUrl } from './config/supported-chains'

const [first, ...rest] = SUPPORTED_CHAINS

// The standalone redeem console lives on the public website (not the Safe iframe),
// so the biller connects MetaMask via the injected connector — no safe() connector.
export const wagmiConfig = createConfig({
  chains: [first, ...rest],
  // The config mounts at the home layout (so the navbar connect button works), which
  // is prerendered under static export — ssr:true keeps that render storage-safe.
  ssr: true,
  connectors: [injected()],
  transports: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, http(rpcUrl(c.id))])),
})
