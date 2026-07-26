/**
 * The Uniswap v3 positions a Safe holds, read straight from the PositionManager.
 *
 * On-chain only — no graph, no local store. A position minted by an agent, by the Safe
 * itself, or before this app existed all show up the same way, because ownership of the
 * NFT is the whole truth.
 *
 * `tokensOwed` is what the contract has already credited: it only moves on a collect or
 * a liquidity change, so a freshly minted position reads zero even while it earns. Fees
 * accrued since the last touch would have to be derived from `feeGrowthInside`, which
 * this deliberately does not do.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, http, erc20Abi, type Address } from 'viem'
import { UniswapV3PositionManagerABI } from '../config/abis'
import { UNISWAP_V3_POSITION_MANAGER } from '../config/uniswap'
import { findChain, rpcUrl } from '../config/supported-chains'

export interface PositionToken {
  address: Address
  symbol: string
  decimals: number
}

export interface SafePosition {
  tokenId: bigint
  token0: PositionToken
  token1: PositionToken
  /** Pool fee in basis-point-hundredths, e.g. 3000 for 0.3%. */
  fee: number
  liquidity: bigint
  tickLower: number
  tickUpper: number
  /** Fees credited by the contract — zero until a collect or liquidity change. */
  owed0: bigint
  owed1: bigint
}

export interface UseSafePositions {
  positions: SafePosition[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/** Positions with no liquidity left are closed; they are noise on a portfolio view. */
const isOpen = (p: SafePosition): boolean => p.liquidity > 0n

export function useSafePositions(safeAddress: Address | undefined, chainId: number): UseSafePositions {
  const [positions, setPositions] = useState<SafePosition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const chain = findChain(chainId)
    const manager = UNISWAP_V3_POSITION_MANAGER[chainId]
    if (!safeAddress || !chain || !manager) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) })
        const count = await client.readContract({
          address: manager,
          abi: UniswapV3PositionManagerABI,
          functionName: 'balanceOf',
          args: [safeAddress],
        })

        const ids = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            client.readContract({
              address: manager,
              abi: UniswapV3PositionManagerABI,
              functionName: 'tokenOfOwnerByIndex',
              args: [safeAddress, BigInt(i)],
            }),
          ),
        )

        const read = await Promise.all(
          ids.map(async (tokenId) => {
            const p = (await client.readContract({
              address: manager,
              abi: UniswapV3PositionManagerABI,
              functionName: 'positions',
              args: [tokenId],
            })) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]

            const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = p

            const meta = await Promise.all(
              [token0, token1].map(async (address) => {
                try {
                  const [symbol, decimals] = await Promise.all([
                    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
                    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
                  ])
                  return { address, symbol, decimals }
                } catch {
                  // A token that will not answer should not hide the position.
                  return { address, symbol: '???', decimals: 18 }
                }
              }),
            )

            return {
              tokenId,
              token0: meta[0],
              token1: meta[1],
              fee: Number(fee),
              liquidity,
              tickLower: Number(tickLower),
              tickUpper: Number(tickUpper),
              owed0,
              owed1,
            }
          }),
        )

        if (!cancelled) setPositions(read.filter(isOpen))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read positions')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [safeAddress, chainId, nonce])

  return { positions, loading, error, refresh }
}
