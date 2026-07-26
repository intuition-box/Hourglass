import { encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from 'viem'

export interface TokenAllowance {
  token: Address
  allowance: bigint
}

/**
 * `increaseLiquidity` (the second half of a compound) pulls the harvested fees from the
 * Safe, which requires the Safe to have approved the PositionManager for both pool tokens
 * ahead of time — a plain ERC20 approval, not a delegation (the Safe grants it directly;
 * the agent never touches it). This just reads the live allowance per token; the Yield tab
 * compares it against whatever cap the operator chooses (see buildCompoundApprovalTxs) —
 * there is no fixed "enough" threshold here, since the right cap is the operator's call.
 */
export async function readCompoundAllowances(
  client: PublicClient,
  safeAddress: Address,
  positionManager: Address,
  tokens: Address[],
): Promise<TokenAllowance[]> {
  return Promise.all(
    tokens.map(async (token) => ({
      token,
      allowance: await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [safeAddress, positionManager],
      }),
    })),
  )
}

export interface ApprovalTx {
  to: Address
  value: '0'
  data: Hex
}

/**
 * One `approve(positionManager, amount)` per token, at the operator-chosen cap — bounded,
 * never `maxUint256` (IMPLEMENTATION_PLAN.md: "don't ship unbounded authority to mainnet").
 * The cap is a lifetime allowance `increaseLiquidity` consumes, not a per-period bound (the
 * correct per-period enforcer is deferred — see FUTURE.md); it can run out and need
 * re-approving. That tradeoff — how generous a cap, how often to top up — is the operator's
 * to make, not a number this app invents for them.
 */
export function buildCompoundApprovalTxs(
  positionManager: Address,
  amounts: { token: Address; amount: bigint }[],
): ApprovalTx[] {
  return amounts
    .filter(({ amount }) => amount > 0n)
    .map(({ token, amount }) => ({
      to: token,
      value: '0' as const,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, amount] }),
    }))
}
