import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, http, type PublicClient } from 'viem'
import { findChain, rpcUrl } from '../config/supported-chains'
import { discoverPools, fetchPoolMetrics, rankPools, type PoolInfo } from '../lib/uniswapDiscovery'

export interface UniswapPools {
  loading: boolean
  error: string | null
  pools: PoolInfo[]
  refresh: () => void
}

const IDLE: Omit<UniswapPools, 'refresh'> = { loading: false, error: null, pools: [] }

/**
 * Discovers real Uniswap v3 pools on `chainId` for the app's candidate token
 * set, then ranks them. On-chain reads always resolve; the APY enrichment is
 * best-effort and never blocks the pool list from rendering.
 */
export function useUniswapPools(chainId: number): UniswapPools {
  const [state, setState] = useState(IDLE)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setState((s) => ({ ...s, loading: true, error: null }))
      const chain = findChain(chainId)
      if (!chain) {
        if (!cancelled) setState({ loading: false, error: `Unsupported chain: ${chainId}`, pools: [] })
        return
      }
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as PublicClient
      const found = await discoverPools(client, chainId)
      const withApy = await Promise.all(
        found.map(async (pool) => ({ ...pool, ...(await fetchPoolMetrics(pool.poolAddress, chainId)) })),
      )
      if (!cancelled) setState({ loading: false, error: null, pools: rankPools(withApy) })
    })().catch((e) => {
      if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to discover pools', pools: [] })
    })
    return () => {
      cancelled = true
    }
  }, [chainId, nonce])

  return { ...state, refresh }
}
