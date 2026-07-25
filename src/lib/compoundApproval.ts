import { encodeFunctionData, erc20Abi, type Address, type PublicClient } from 'viem'
import type { SafeTx } from './permit2'

/**
 * Standing ERC-20 approvals the Safe grants the Uniswap v3 PositionManager so the
 * compound agent can reinvest harvested fees: `increaseLiquidity` pulls both pool
 * tokens from the Safe via `transferFrom`, which needs a prior allowance. A ONE-TIME
 * operator setup ("Enable compounding"), separate from the signed compound mandate —
 * the mandate lets the agent CALL `increaseLiquidity`; the allowance lets that call
 * move the tokens. Without it the agent's compound reverts (transfer fails).
 *
 * The approval is BOUNDED (a cap, not `maxUint256`). The compound mandate does not
 * cap `increaseLiquidity`'s amounts, so the allowance is the blast radius — a
 * compromised agent can never pull more than the approved cap into the position.
 * See FUTURE.md for the per-period caveat that supersedes this before production.
 */

export interface CompoundApprovalStatus {
  /** token0 → PositionManager allowance exists. */
  token0Ok: boolean
  /** token1 → PositionManager allowance exists. */
  token1Ok: boolean
  /** True when both hold — no setup needed. */
  ready: boolean
}

/**
 * Whether the Safe already has a standing allowance to the PositionManager for both
 * pool tokens. A non-zero allowance means the operator has enabled compounding; the
 * agent's runner does the exact per-compound sufficiency check at run time, so the
 * app only needs to confirm an approval exists.
 */
export async function checkCompoundApprovals(
  client: PublicClient,
  params: { safe: Address; positionManager: Address; token0: Address; token1: Address },
): Promise<CompoundApprovalStatus> {
  const { safe, positionManager, token0, token1 } = params
  const [allowance0, allowance1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20Abi, functionName: 'allowance', args: [safe, positionManager] }),
    client.readContract({ address: token1, abi: erc20Abi, functionName: 'allowance', args: [safe, positionManager] }),
  ])
  const token0Ok = allowance0 > 0n
  const token1Ok = allowance1 > 0n
  return { token0Ok, token1Ok, ready: token0Ok && token1Ok }
}

/**
 * The batch that grants the bounded PositionManager allowances (approve per pool
 * token, capped at `cap0`/`cap1`), skipping whichever token already has one. Both
 * are plain on-chain calls, so the Safe can batch them in a single transaction.
 * Empty when nothing is needed.
 */
export function buildCompoundApprovalSetup(
  params: { positionManager: Address; token0: Address; token1: Address; cap0: bigint; cap1: bigint },
  status: CompoundApprovalStatus,
): SafeTx[] {
  const { positionManager, token0, token1, cap0, cap1 } = params
  const txs: SafeTx[] = []
  if (!status.token0Ok) {
    txs.push({
      to: token0,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, cap0] }),
    })
  }
  if (!status.token1Ok) {
    txs.push({
      to: token1,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, cap1] }),
    })
  }
  return txs
}
