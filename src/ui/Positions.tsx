/**
 * The Safe's open liquidity positions. Shared by Overview (as a portfolio line) and by
 * the Yield tab (as the detail under the deposit form), so both read the same chain
 * state and cannot disagree.
 */
import { formatUnits } from 'viem'
import type { SafePosition } from '../hooks/useSafePositions'
import { Mono } from './components'

/** Trim to something readable without losing the magnitude of a small balance. */
function amount(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals))
  if (n === 0) return '0'
  if (n < 0.0001) return n.toExponential(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

/** A full-range position spans the whole tick space; anything else is concentrated. */
const isFullRange = (p: SafePosition): boolean => p.tickLower <= -887200 && p.tickUpper >= 887200

export function PositionRow({ position, detailed = false }: { position: SafePosition; detailed?: boolean }) {
  const { token0, token1, fee, owed0, owed1 } = position
  const hasFees = owed0 > 0n || owed1 > 0n

  return (
    <div className="rounded-lg bg-raised ring-1 ring-line p-3 space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-ink">
          {token0.symbol} / {token1.symbol}
          <span className="text-faint font-normal"> · {fee / 10000}%</span>
        </div>
        <span className="text-[11px] text-faint">{isFullRange(position) ? 'full range' : 'concentrated'}</span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-faint">Fees earned</span>
        <span className="text-[11px] text-ink">
          {hasFees
            ? `${amount(owed0, token0.decimals)} ${token0.symbol} + ${amount(owed1, token1.decimals)} ${token1.symbol}`
            : 'none collected yet'}
        </span>
      </div>

      {detailed && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[11px] text-faint">Position</span>
          <Mono className="text-[11px] text-dim">#{position.tokenId.toString()}</Mono>
        </div>
      )}
    </div>
  )
}

export function Positions({
  positions,
  loading,
  detailed = false,
}: {
  positions: SafePosition[]
  loading: boolean
  detailed?: boolean
}) {
  if (loading && positions.length === 0) {
    return <p className="text-[11px] text-faint">Reading positions…</p>
  }
  if (positions.length === 0) {
    // An empty state that says what would be here, not a pitch.
    return <p className="text-[11px] text-faint">No open liquidity positions in this Safe.</p>
  }
  return (
    <div className="space-y-2">
      {positions.map((p) => (
        <PositionRow key={p.tokenId.toString()} position={p} detailed={detailed} />
      ))}
    </div>
  )
}
