import { http, createConfig } from 'wagmi'
import { safe, injected } from 'wagmi/connectors'
import { SUPPORTED_CHAINS, rpcUrl } from './supported-chains'

const [first, ...rest] = SUPPORTED_CHAINS

export const wagmiConfig = createConfig({
  chains: [first, ...rest],
  // safe() auto-connects inside the Safe App iframe; injected() lets the biller
  // (org EOA) connect MetaMask in the standalone redeem console.
  connectors: [safe(), injected()],
  transports: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, http(rpcUrl(c.id))])),
})
