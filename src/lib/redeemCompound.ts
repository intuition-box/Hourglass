import { createExecution, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit'
import { encodePermissionContexts, encodeExecutionCalldatas } from '@metamask/smart-accounts-kit/utils'
import { encodeFunctionData, type Address, type PublicClient } from 'viem'
import { UniswapV3PositionManagerABI } from '../config/abis'
import { getAddresses } from '../config/addresses'
import type { DelegationStruct } from './delegations'
import type { SafeTx } from './permit2'

// Same bound as skills/hourglass-agent/scripts/run-compound.ts's MAX_UINT128 — passing
// the max to `collect` means "take everything owed", the standard PositionManager idiom.
const MAX_UINT128 = (1n << 128n) - 1n

export interface CompoundablePosition {
  tokenId: bigint
  /** Fees owed right now — what `increaseLiquidity` will reinvest. */
  fees0: bigint
  fees1: bigint
}

/**
 * Finds the Safe's live position for this mandate's pool and simulates `collect` to read
 * the fees actually owed right now. Unlike the deposit mandate (byte-pinned at signing),
 * a compound's `increaseLiquidity` amounts can't be known until redeem time — this mirrors
 * the read logic already proven in `run-compound.ts`'s `findPosition` + collect-simulation,
 * lifted here so the Yield tab's manual "Compound now" button can call it directly instead
 * of shelling out to the script.
 */
export async function findCompoundablePosition(
  client: PublicClient,
  positionManager: Address,
  safeAddress: Address,
  pool: { token0: Address; token1: Address; fee: number },
): Promise<CompoundablePosition> {
  const balance = await client.readContract({
    address: positionManager,
    abi: UniswapV3PositionManagerABI,
    functionName: 'balanceOf',
    args: [safeAddress],
  })

  const matches: bigint[] = []
  for (let i = 0n; i < balance; i += 1n) {
    const tokenId = await client.readContract({
      address: positionManager,
      abi: UniswapV3PositionManagerABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [safeAddress, i],
    })
    const position = await client.readContract({
      address: positionManager,
      abi: UniswapV3PositionManagerABI,
      functionName: 'positions',
      args: [tokenId],
    })
    const [, , token0, token1, fee, , , liquidity] = position
    if (
      token0.toLowerCase() === pool.token0.toLowerCase() &&
      token1.toLowerCase() === pool.token1.toLowerCase() &&
      fee === pool.fee &&
      liquidity > 0n
    ) {
      matches.push(tokenId)
    }
  }
  if (matches.length === 0) {
    throw new Error(`The Safe holds no active position for this pool yet — deposit before compounding.`)
  }
  // Not pinned to one tokenId (the mandate is signed before the mint exists) — compound
  // the newest active position in the mandate's pool, same tie-break as run-compound.ts.
  matches.sort((a, b) => (a < b ? 1 : -1))
  const tokenId = matches[0]

  // A static call as the owner returns the true owed amount, including fee growth not
  // yet flushed into tokensOwed — the same simulate-before-send run-compound.ts does.
  const { result } = await client.simulateContract({
    address: positionManager,
    abi: UniswapV3PositionManagerABI,
    functionName: 'collect',
    args: [{ tokenId, recipient: safeAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    account: safeAddress,
  })
  const [fees0, fees1] = result

  return { tokenId, fees0, fees1 }
}

/**
 * Build the one `redeemDelegations` Safe tx that harvests + reinvests a compound mandate —
 * `collect` and `increaseLiquidity`, two `SingleDefault` executions redeeming the SAME
 * delegation atomically (both succeed or both revert; see DELEGATION_OPERATIONS.md §2). The
 * mandate must have been signed with the Safe as delegate (Manual mode) — an agent-delegated
 * mandate can only be redeemed by the agent, per `redeemer`.
 */
export function buildCompoundRedeemTx(
  chainId: number,
  delegation: DelegationStruct,
  positionManager: Address,
  safeAddress: Address,
  position: CompoundablePosition,
): SafeTx {
  const { delegationManager } = getAddresses(chainId)

  if (!delegation.signature || delegation.signature === '0x') {
    throw new Error('The compound mandate is unsigned')
  }

  const collectData = encodeFunctionData({
    abi: UniswapV3PositionManagerABI,
    functionName: 'collect',
    args: [{ tokenId: position.tokenId, recipient: safeAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  })
  // Desired = the fees just simulated; mins = 0 because collect and increase run in the
  // SAME tx (no inter-tx drift) — same reasoning as run-compound.ts's buildCompoundExecutions.
  const increaseData = encodeFunctionData({
    abi: UniswapV3PositionManagerABI,
    functionName: 'increaseLiquidity',
    args: [{
      tokenId: position.tokenId,
      amount0Desired: position.fees0,
      amount1Desired: position.fees1,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
    }],
  })

  const executions = [
    createExecution({ target: positionManager, value: 0n, callData: collectData }),
    createExecution({ target: positionManager, value: 0n, callData: increaseData }),
  ]

  // The SDK Delegation type carries a per-caveat `args` field the stored shape doesn't
  // (same conversion as redeemYield.ts / scripts/yield-agent.ts) — '0x' because none of
  // this mandate's caveats consume per-redemption args.
  const sdkDelegation: Delegation = {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' })),
    salt: delegation.salt,
    signature: delegation.signature,
  }

  const data = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'redeemDelegations',
        stateMutability: 'nonpayable',
        inputs: [
          { name: '_permissionContexts', type: 'bytes[]' },
          { name: '_modes', type: 'bytes32[]' },
          { name: '_executionCallDatas', type: 'bytes[]' },
        ],
        outputs: [],
      },
    ] as const,
    functionName: 'redeemDelegations',
    args: [
      encodePermissionContexts(executions.map(() => [sdkDelegation])),
      executions.map(() => ExecutionMode.SingleDefault),
      encodeExecutionCalldatas(executions.map((e) => [e])),
    ],
  })

  return { to: delegationManager, value: '0', data }
}
