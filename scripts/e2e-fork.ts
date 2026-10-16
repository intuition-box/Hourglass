/**
 * End-to-end rehearsal of both payment rails on an anvil fork of a live network,
 * through the app's own code paths (getEnvironment, buildDelegationTypedData,
 * buildModuleInstallTxs, buildRedeemTx, buildRevokeTxs).
 *
 *   anvil --fork-url <rpc> --chain-id <id> --port 8546
 *   RPC_URL=http://127.0.0.1:8546 TOKEN=<erc20> TOKEN_HOLDER=<address holding it> \
 *     bun scripts/e2e-fork.ts <chainId>
 *
 * Flow: deploy a 1/1 Safe → install the HourGlass module → sign a subscription and a
 * stream as Safe messages (EIP-1271, as Safe{Wallet} does) → the payee redeems each →
 * the caveats refuse an over-cap pull → the Safe revokes → a later pull reverts.
 * Uses anvil's default funded accounts; never point it at a real network.
 */
import Safe from '@safe-global/protocol-kit'
import { SigningMethod } from '@safe-global/types-kit'
import { createDelegation } from '@metamask/smart-accounts-kit'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  parseUnits,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getAddresses } from '../src/config/addresses'
import { findNetwork } from '../src/config/networks'
import { DeleGatorModuleFactoryABI } from '../src/config/abis'
import { getEnvironment } from '../src/lib/environment'
import { buildDelegationTypedData, computeDelegationHash, type DelegationStruct } from '../src/lib/delegations'
import { buildModuleInstallTxs, DEFAULT_SALT } from '../src/lib/module'
import { buildRedeemTx } from '../src/lib/redeemDirect'
import { buildRevokeTxs } from '../src/lib/revoke'
import type { StoredDelegation } from '../src/lib/storage'

// anvil's well-known dev keys (accounts 0 and 1). Only ever valid on a local fork.
const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PAYEE_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const RECIPIENT: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'

const chainId = Number(process.argv[2])
const rpc = process.env.RPC_URL
const token = process.env.TOKEN as Address | undefined // checked below
const holder = process.env.TOKEN_HOLDER as Address | undefined // checked below
const network = findNetwork(chainId)
if (!network || !rpc || !token || !holder) {
  console.error('usage: RPC_URL=<fork> TOKEN=<erc20> TOKEN_HOLDER=<addr> bun scripts/e2e-fork.ts <chainId>')
  process.exit(1)
}
if ((await createPublicClient({ transport: http(rpc) }).getChainId()) !== chainId) throw new Error('RPC chain id mismatch')

const client = createPublicClient({ chain: network.chain, transport: http(rpc) })
const owner = privateKeyToAccount(OWNER_KEY)
const payee = privateKeyToAccount(PAYEE_KEY)
const payeeWallet = createWalletClient({ account: payee, chain: network.chain, transport: http(rpc) })
const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
const units = (n: string) => parseUnits(n, decimals)
const balanceOf = (a: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const now = async () => Number((await client.getBlock()).timestamp)
// anvil_* / evm_* cheat methods are not in viem's typed RPC schema.
const anvil = (method: string, params: unknown[]) => client.request({ method, params } as never)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

async function expectRevert(label: string, send: () => Promise<Hex>, reason?: string): Promise<void> {
  try {
    await client.waitForTransactionReceipt({ hash: await send() })
    check(label, false, 'did not revert')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // viem names the error only when it knows the ABI; otherwise it shows the selector.
    const matched = !reason || msg.includes(reason) || msg.includes(toFunctionSelector(`${reason}()`))
    check(label, matched, matched ? `reverted${reason ? `: ${reason}` : ''}` : msg.split('\n')[0])
  }
}

// 1. A 1/1 Safe, owned by anvil account 0.
let safe = await Safe.init({ provider: rpc, signer: OWNER_KEY, predictedSafe: { safeAccountConfig: { owners: [owner.address], threshold: 1 } } })
const deployTx = await safe.createSafeDeploymentTransaction()
const ownerWallet = createWalletClient({ account: owner, chain: network.chain, transport: http(rpc) })
// protocol-kit returns the deployment tx as plain strings; they are 0x-prefixed by construction.
await client.waitForTransactionReceipt({ hash: await ownerWallet.sendTransaction({ to: getAddress(deployTx.to), data: deployTx.data as Hex, value: BigInt(deployTx.value) }) })
const safeAddress = getAddress(await safe.getAddress())
safe = await safe.connect({ safeAddress })
check('Safe deployed', await safe.isSafeDeployed(), safeAddress)

async function execAsSafe(txs: { to: string; value: string; data: Hex }[]): Promise<void> {
  const tx = await safe.createTransaction({ transactions: txs })
  const signed = await safe.signTransaction(tx)
  const res = await safe.executeTransaction(signed)
  await client.waitForTransactionReceipt({ hash: res.hash as Hex }) // protocol-kit types the tx hash as string
}

// 2. Fund the Safe from a holder.
await anvil('anvil_impersonateAccount', [holder])
await anvil('anvil_setBalance', [holder, '0x56BC75E2D63100000'])
const holderWallet = createWalletClient({ account: holder, chain: network.chain, transport: http(rpc) })
await client.waitForTransactionReceipt({
  hash: await holderWallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [safeAddress, units('500')] }),
})
check('Safe funded', (await balanceOf(safeAddress)) === units('500'))

// 3. Install the module, exactly as Overview does.
const addrs = getAddresses(chainId)
const moduleAddress = await client.readContract({
  address: addrs.delegatorModuleFactory,
  abi: DeleGatorModuleFactoryABI,
  functionName: 'predictAddress',
  args: [safeAddress, DEFAULT_SALT],
}) as Address // the factory ABI types the return as address
await execAsSafe(buildModuleInstallTxs(safeAddress, chainId, moduleAddress))
check('module enabled', await safe.isModuleEnabled(moduleAddress), moduleAddress)

// 4. Sign a delegation the way the Create pages + Safe{Wallet} do.
async function sign(scope: object, caveats?: object[]): Promise<DelegationStruct> {
  // Same untyped call shape as the Create pages: the SDK's scope union does not accept a
  // plain object literal, and it returns its own Delegation type with optional fields.
  const d = createDelegation({ to: payee.address, from: moduleAddress, environment: getEnvironment(chainId), scope, caveats, salt: `0x${Date.now().toString(16).padStart(64, '0')}` } as never) as Omit<DelegationStruct, 'signature'>
  const unsigned: DelegationStruct = { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: d.salt, signature: '0x' }
  const typed = buildDelegationTypedData(unsigned, chainId)
  // protocol-kit's EIP712TypedData is a mutable variant of the same shape; its signatures come back as a hex string.
  const message = await safe.signMessage(safe.createMessage(typed as never), SigningMethod.ETH_SIGN_TYPED_DATA_V4)
  return { ...unsigned, signature: message.encodedSignatures() as Hex }
}

const redeem = (d: DelegationStruct, amount: string) => {
  const tx = buildRedeemTx({ chainId, delegation: d, token: { address: token, decimals }, amount, recipient: RECIPIENT })
  return payeeWallet.sendTransaction({ to: tx.to, data: tx.data })
}

// 5. Subscription: 10 / 30 days.
const start = await now()
const sub = await sign(
  { type: 'erc20PeriodTransfer', tokenAddress: token, periodAmount: units('10'), periodDuration: 2_592_000, startDate: start },
  [{ type: 'timestamp', afterThreshold: start - 1, beforeThreshold: start + 365 * 86_400 }],
)
const hg = addrs.hourglass
check('subscription references the HourGlass period enforcer', !hg || sub.caveats.some((c) => c.enforcer === hg.erc20PeriodTransferEnforcer))
let before = await balanceOf(RECIPIENT)
await client.waitForTransactionReceipt({ hash: await redeem(sub, '10') })
check('subscription: payee charges the period amount', (await balanceOf(RECIPIENT)) - before === units('10'))
await expectRevert('subscription: a second charge in the same period is refused', () => redeem(sub, '1'))

// 6. Stream: 5 upfront + 1/s, capped at 1000.
const streamStart = await now()
const stream = await sign({ type: 'erc20Streaming', tokenAddress: token, initialAmount: units('5'), maxAmount: units('1000'), amountPerSecond: units('1'), startTime: streamStart })
check('stream references the HourGlass streaming enforcer', !hg || stream.caveats.some((c) => c.enforcer === hg.erc20StreamingEnforcer))
await anvil('evm_increaseTime', [60])
await anvil('evm_mine', [])
before = await balanceOf(RECIPIENT)
await client.waitForTransactionReceipt({ hash: await redeem(stream, '50') })
check('stream: payee claims what has accrued', (await balanceOf(RECIPIENT)) - before === units('50'))
await expectRevert('stream: claiming more than has accrued is refused', () => redeem(stream, '500'))

// 7. Revoke the subscription; the next period's charge must fail.
const stored = { delegation: sub, meta: { moduleAddress, delegationHash: computeDelegationHash(sub) } } as unknown as StoredDelegation // buildRevokeTxs reads only these fields
await execAsSafe(buildRevokeTxs(stored, chainId))
await anvil('evm_increaseTime', [2_592_000])
await anvil('evm_mine', [])
await expectRevert('subscription: after revoke, the next period is refused', () => redeem(sub, '10'), 'CannotUseADisabledDelegation')

// 8. The stream was not revoked: it keeps paying in the next period.
before = await balanceOf(RECIPIENT)
await client.waitForTransactionReceipt({ hash: await redeem(stream, '100') })
check('stream: unaffected by the subscription revoke', (await balanceOf(RECIPIENT)) - before === units('100'))

console.log(failures === 0 ? `\nAll checks passed on ${network.name}.` : `\n${failures} check(s) failed on ${network.name}.`)
process.exit(failures === 0 ? 0 : 1)
