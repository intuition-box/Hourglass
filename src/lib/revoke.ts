import { encodeFunctionData, encodePacked, pad, parseAbi, type Hex } from 'viem'
import { DelegationManagerABI } from '../config/abis'
import { getAddresses } from '../config/addresses'
import type { StoredDelegation } from './storage'

// ERC-7579 single-call execution mode.
const SINGLE_DEFAULT_MODE: Hex = pad('0x00', { size: 32 })
const MODULE_EXECUTE_ABI = parseAbi([
  'function execute(bytes32 mode, bytes calldata executionCalldata) payable',
])

export interface SafeTx {
  to: string
  value: string
  data: Hex
}

/**
 * Build the Safe transaction that revokes a subscription via disableDelegation.
 *
 * disableDelegation must come from the delegator (the module), so the call is
 * routed through module.execute(): msg.sender at the DelegationManager is then
 * the module, satisfying its delegator == msg.sender check. Sending it straight
 * from the Safe reverts (InvalidDelegator -> GS013).
 */
export function buildRevokeTxs(d: StoredDelegation, chainId: number): SafeTx[] {
  const addrs = getAddresses(chainId)
  const disableData = encodeFunctionData({
    abi: DelegationManagerABI,
    functionName: 'disableDelegation',
    args: [
      {
        delegate: d.delegation.delegate,
        delegator: d.delegation.delegator,
        authority: d.delegation.authority,
        // The framework Caveat carries a runtime `args` field (empty for a
        // subscription); it is excluded from the EIP-712 hash, so '0x' is safe.
        caveats: d.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' as Hex })),
        salt: BigInt(d.delegation.salt),
        signature: d.delegation.signature,
      },
    ],
  })
  const executionCalldata = encodePacked(
    ['address', 'uint256', 'bytes'],
    [addrs.delegationManager, 0n, disableData],
  )
  const executeData = encodeFunctionData({
    abi: MODULE_EXECUTE_ABI,
    functionName: 'execute',
    args: [SINGLE_DEFAULT_MODE, executionCalldata],
  })
  return [{ to: d.meta.moduleAddress, value: '0', data: executeData }]
}
