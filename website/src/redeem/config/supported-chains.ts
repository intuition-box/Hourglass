import { type Chain } from 'viem'
import { LIVE_NETWORKS, anvilLocal, findNetwork } from './networks'

/**
 * Chain helpers derived from `networks.ts`. Add or flip a network there; every
 * consumer — wagmi config, the per-page clients, the redeem/verify selectors, the
 * chain-name and explorer helpers — picks it up.
 */

/** The pinned RPC URL for a chain, or undefined to use viem's default. */
export function rpcUrl(chainId: number): string | undefined {
  if (chainId === anvilLocal.id) return anvilLocal.rpcUrls.default.http[0]
  return findNetwork(chainId)?.rpcUrl
}

function withRpc(chain: Chain, url: string): Chain {
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [url] } } }
}

/** Chains a Safe can use HourGlass on today (live networks + the local anvil fork). */
export const SUPPORTED_CHAINS: readonly Chain[] = [
  ...LIVE_NETWORKS.map((n) => withRpc(n.chain, n.rpcUrl)),
  anvilLocal,
]

/** The viem Chain for an id, or undefined if unsupported (callers null-check). */
export function findChain(chainId: number): Chain | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)
}

/** Display name for any known network, live or pending. */
export function chainName(chainId: number): string {
  return findNetwork(chainId)?.name ?? `Chain ${chainId}`
}

export function explorerTx(chainId: number, hash: string): string {
  const base = findNetwork(chainId)?.explorer ?? 'https://etherscan.io'
  return `${base}/tx/${hash}`
}

/** Chains offered in the redeem/verify selectors, in display order. */
export const SELECTABLE_CHAINS: { id: number; label: string; explorer: string }[] = LIVE_NETWORKS.map((n) => ({
  id: n.chain.id,
  label: n.name,
  explorer: n.explorer,
}))
