import { createExecution, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit'
import { encodePermissionContexts, encodeExecutionCalldatas } from '@metamask/smart-accounts-kit/utils'
import { encodeFunctionData } from 'viem'
import { getAddresses } from '../config/addresses'
import type { StoredDelegation } from './storage'
import type { SafeTx } from './permit2'

/**
 * Manual redemption of a signed yield plan: the operator executes the pre-built
 * delegations themselves from the Safe App, instead of a bot. Each delegation is
 * single-use and `exactExecution`-pinned to the exact target/value/calldata the Safe
 * already signed, so this only resubmits what was approved — it decides nothing about
 * targets, amounts, or recipients.
 *
 * The returned txs must be sent BY the delegate. In Manual mode the delegate IS the
 * Safe, so these go straight into `sdk.txs.send({ txs })` — one batched Safe tx that
 * redeems the deposit as the Safe (the same `redeemDelegations` a bot would send; see
 * scripts/yield-agent.ts). Redeeming from the Safe App only works when the plan was
 * signed with the Safe as the delegate; an agent-delegated plan must use the agent
 * script.
 */

const REDEEM_DELEGATIONS_ABI = [
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
] as const

/** Build one `redeemDelegations` Safe tx per pinned delegation, in the plan's order. */
export function buildYieldRedeemTxs(chainId: number, delegations: StoredDelegation[]): SafeTx[] {
  const { delegationManager } = getAddresses(chainId)

  return delegations.map((stored, i) => {
    const { targetAddress, calldataArgs } = stored.meta
    if (!targetAddress || !calldataArgs) {
      throw new Error(`Delegation ${i} is missing its pinned execution (target/calldata)`)
    }
    if (!stored.delegation.signature || stored.delegation.signature === '0x') {
      throw new Error(`Delegation ${i} is unsigned`)
    }

    const execution = createExecution({ target: targetAddress, value: 0n, callData: calldataArgs })

    // The SDK Delegation type carries a per-caveat `args` field the stored shape does
    // not (same conversion as scripts/yield-agent.ts and src/lib/redeemDirect.ts) —
    // '0x' because none of these caveats consume per-redemption args.
    const sdkDelegation: Delegation = {
      delegate: stored.delegation.delegate,
      delegator: stored.delegation.delegator,
      authority: stored.delegation.authority,
      caveats: stored.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' })),
      salt: stored.delegation.salt,
      signature: stored.delegation.signature,
    }

    const data = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: 'redeemDelegations',
      args: [
        encodePermissionContexts([[sdkDelegation]]),
        [ExecutionMode.SingleDefault],
        encodeExecutionCalldatas([[execution]]),
      ],
    })

    return { to: delegationManager, value: '0', data }
  })
}
