import { type Address } from 'viem'
import { NETWORKS, anvilLocal, findNetwork } from './networks'

export interface ChainAddresses {
  delegationManager: Address
  delegatorModuleFactory: Address
  nativeTokenPeriodTransferEnforcer: Address
  erc20PeriodTransferEnforcer: Address
  nativeTokenTransferAmountEnforcer: Address
  erc20TransferAmountEnforcer: Address
  erc20MultiOperationIncreaseBalanceEnforcer: Address
  valueLteEnforcer: Address
  timestampEnforcer: Address
  allowedTargetsEnforcer: Address
  allowedMethodsEnforcer: Address
  limitedCallsEnforcer: Address
  argsEqualityCheckEnforcer: Address
  exactCalldataEnforcer: Address
  allowedCalldataEnforcer: Address
  redeemerEnforcer: Address
  delegationMetaSwapAdapter: Address
  // HourGlass-owned instances of the enforcers the payment rails sign against
  // (unmodified bytecode, deployed under the HourGlass CREATE2 salt). Present only on
  // networks where they are deployed. The period enforcer doubles as the on-chain
  // analytics marker — its TransferredInPeriod events are attributable to HourGlass by
  // emitter address (see spec/plan-analytics.md and spec/hourglass-enforcer-suite.md).
  hourglass?: HourGlassPaymentEnforcers
}

/**
 * The complete Delegation Framework caveat enforcer set, deployed under the HourGlass
 * CREATE2 salt on Ethereum and Base. Registry only: `getEnvironment()` decides which
 * instances actually override the SDK defaults.
 */
export interface HourGlassEnforcers {
  allowedCalldataEnforcer: Address
  allowedMethodsEnforcer: Address
  allowedTargetsEnforcer: Address
  approvalRevocationEnforcer: Address
  argsEqualityCheckEnforcer: Address
  blockNumberEnforcer: Address
  deployedEnforcer: Address
  erc1155BalanceChangeEnforcer: Address
  erc1155MultiOperationIncreaseBalanceEnforcer: Address
  erc20BalanceChangeEnforcer: Address
  erc20MultiOperationIncreaseBalanceEnforcer: Address
  erc20PeriodTransferEnforcer: Address
  erc20StreamingEnforcer: Address
  erc20TransferAmountEnforcer: Address
  erc721BalanceChangeEnforcer: Address
  erc721MultiOperationIncreaseBalanceEnforcer: Address
  erc721TransferEnforcer: Address
  exactCalldataBatchEnforcer: Address
  exactCalldataEnforcer: Address
  exactExecutionBatchEnforcer: Address
  exactExecutionEnforcer: Address
  idEnforcer: Address
  limitedCallsEnforcer: Address
  logicalOrWrapperEnforcer: Address
  multiTokenPeriodEnforcer: Address
  nativeBalanceChangeEnforcer: Address
  nativeTokenMultiOperationIncreaseBalanceEnforcer: Address
  nativeTokenPaymentEnforcer: Address
  nativeTokenPeriodTransferEnforcer: Address
  nativeTokenStreamingEnforcer: Address
  nativeTokenTransferAmountEnforcer: Address
  nonceEnforcer: Address
  ownershipTransferEnforcer: Address
  redeemerEnforcer: Address
  specificActionERC20TransferBatchEnforcer: Address
  timestampEnforcer: Address
  valueLteEnforcer: Address
}

// DelegationManager from the Delegation Framework v1.3.0
// Same across all chains (deterministic deployment)
const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

// MetaMask's canonical enforcers (Delegation Framework v1.3.0, deterministic: same on every network)
const SHARED_ENFORCERS = {
  nativeTokenPeriodTransferEnforcer: '0x9BC0FAf4Aca5AE429F4c06aEEaC517520CB16BD9' as Address,
  erc20PeriodTransferEnforcer: '0x474e3Ae7E169e940607cC624Da8A15Eb120139aB' as Address,
  nativeTokenTransferAmountEnforcer: '0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320' as Address,
  erc20TransferAmountEnforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc' as Address,
  erc20MultiOperationIncreaseBalanceEnforcer: '0xeaA1bE91F0ea417820a765df9C5BE542286BFfDC' as Address,
  valueLteEnforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F' as Address,
  timestampEnforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069' as Address,
  allowedTargetsEnforcer: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB' as Address,
  allowedMethodsEnforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5' as Address,
  limitedCallsEnforcer: '0x04658B29F6b82ed55274221a06Fc97D318E25416' as Address,
  argsEqualityCheckEnforcer: '0x44B8C6ae3C304213c3e298495e12497Ed3E56E41' as Address,
  exactCalldataEnforcer: '0x99F2e9bF15ce5eC84685604836F71aB835DBBdED' as Address,
  allowedCalldataEnforcer: '0xc2b0d624c1c4319760C96503BA27C347F3260f55' as Address,
  redeemerEnforcer: '0xE144b0b2618071B4E56f746313528a669c7E65c5' as Address,
  delegationMetaSwapAdapter: '0x5e4b49156D23D890e7DC264c378a443C2d22A80E' as Address,
}

// HourGlass-owned instances of the audited enforcers, deployed via CREATE2 under the
// salt bytes32("OURGLASS"). Salt + creation bytecode fully determine the address, so
// these are byte-for-byte the same on every network they are deployed to — hence one
// shared constant rather than a per-chain copy. See spec/hourglass-enforcer-suite.md.
export const HOURGLASS_SUITE: HourGlassEnforcers = {
  allowedCalldataEnforcer: '0xb418A0C7003F15EEC765D1e1c0E198cA8531fABe' as Address,
  allowedMethodsEnforcer: '0x5FFb84883543A9ED068b1D3DB428037e95C1f26A' as Address,
  allowedTargetsEnforcer: '0x71832d69693A818C7e6163e632c5e3fBedf65362' as Address,
  approvalRevocationEnforcer: '0xa92E4c2f624ac064875CA92beDa44629958A0803' as Address,
  argsEqualityCheckEnforcer: '0xAF081f825b0Fd4D1cA3b56E2766248A3689Aea4f' as Address,
  blockNumberEnforcer: '0xDaE46FC044CC9A03E0274E51c900946F52afC59A' as Address,
  deployedEnforcer: '0x0F40211A6E6B68920690f2a0619714283706E7b3' as Address,
  erc1155BalanceChangeEnforcer: '0x341CD2A57ececdAbd41D348b7B616C63D3Ba86f7' as Address,
  erc1155MultiOperationIncreaseBalanceEnforcer: '0x7a6c0065a6306b93e82E5Dc7BFD871990a0F910E' as Address,
  erc20BalanceChangeEnforcer: '0xf069a9da3987eDA46F711dC40012f3674c6Ad517' as Address,
  erc20MultiOperationIncreaseBalanceEnforcer: '0xd1f2F8b225e16A1a22E0C760e25B8da5e58fbb88' as Address,
  erc20PeriodTransferEnforcer: '0x11262E3116a50654547AB0A417BE77eB14b9F339' as Address,
  erc20StreamingEnforcer: '0xE475D14d61756D6e940B74C20d2E44EB70c71a8D' as Address,
  erc20TransferAmountEnforcer: '0xf180Ec5552f7251268540f5D0292e44e6cD37491' as Address,
  erc721BalanceChangeEnforcer: '0x3a9aF4D3089F6755f80FF5568268CC1fFd233103' as Address,
  erc721MultiOperationIncreaseBalanceEnforcer: '0xF9D8b696eb1FC8E07F17aF2b491B36e63985f814' as Address,
  erc721TransferEnforcer: '0x9ACf459b3495626a1Fb7B9e60519582c273295e7' as Address,
  exactCalldataBatchEnforcer: '0xE7dB63Ae90BF479Fd3Ca0148Eca73560DD324591' as Address,
  exactCalldataEnforcer: '0x0a1A4e45Be9183465c0f4ac7907605269B2a2573' as Address,
  exactExecutionBatchEnforcer: '0x1c0e253Ef34F05f9Bb35bc373F811A719478a4BB' as Address,
  exactExecutionEnforcer: '0xb0deD8b9f02f8D100078F1AA75Ab9FCDB0D5e729' as Address,
  idEnforcer: '0xF60958a138A885FD10418E7b0D76Ceb45AA25605' as Address,
  limitedCallsEnforcer: '0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8' as Address,
  logicalOrWrapperEnforcer: '0x3FeDC2610F558E6a0e5c5d9A591E4621C76Ea4f7' as Address,
  multiTokenPeriodEnforcer: '0xAA7E306EcBCFF5A5b37BE13d8a4655E0998D8E87' as Address,
  nativeBalanceChangeEnforcer: '0xF069FB64eFDBdA222a86952fC71E87CC6731d545' as Address,
  nativeTokenMultiOperationIncreaseBalanceEnforcer: '0x23D27CaFC7968C9C615a2CcDa9Ca80e36A0f76Ba' as Address,
  nativeTokenPaymentEnforcer: '0xD406D916bA7c155B186639f6f6783A17DFe81B1c' as Address,
  nativeTokenPeriodTransferEnforcer: '0xe96539D0aB03b9D7Dc45B2326E2FCdb598b721Dc' as Address,
  nativeTokenStreamingEnforcer: '0xC2db9C9c3fb2d15d67F4B89B61D6C7332C8B866B' as Address,
  nativeTokenTransferAmountEnforcer: '0x953AB69e4aeE3a5e311261573B826Daf29735e52' as Address,
  nonceEnforcer: '0x3266A5827F3fFED7c4BBa1a7F461F46C8D2835b6' as Address,
  ownershipTransferEnforcer: '0xcA474A11645EeCBC225B60944940f81eCd1A7DF8' as Address,
  redeemerEnforcer: '0x787308b5d74797E9FEA19cc186bcF12a19dcABB0' as Address,
  specificActionERC20TransferBatchEnforcer: '0xE9F0fb5011Db7F59763d999470af2b7f586712a0' as Address,
  timestampEnforcer: '0xF1635460548F44543366ec4453D512a7Ce85Af85' as Address,
  valueLteEnforcer: '0x9Fed2C8Bf48Af2c8C0D7E9aE089523Da78D0A076' as Address,
}

/** The four enforcers the payment rails sign against — the subset deployed on every live non-canonical network. */
type HourGlassPaymentEnforcers = Pick<
  HourGlassEnforcers,
  'erc20PeriodTransferEnforcer' | 'timestampEnforcer' | 'erc20StreamingEnforcer' | 'valueLteEnforcer'
>

const HOURGLASS_PAYMENT: HourGlassPaymentEnforcers = {
  erc20PeriodTransferEnforcer: HOURGLASS_SUITE.erc20PeriodTransferEnforcer,
  timestampEnforcer: HOURGLASS_SUITE.timestampEnforcer,
  erc20StreamingEnforcer: HOURGLASS_SUITE.erc20StreamingEnforcer,
  valueLteEnforcer: HOURGLASS_SUITE.valueLteEnforcer,
}

function buildAddresses(): Record<number, ChainAddresses> {
  const out: Record<number, ChainAddresses> = {
    // Anvil: the factory address comes from test/deployment.json at run time.
    [anvilLocal.id]: {
      delegationManager: DELEGATION_MANAGER,
      delegatorModuleFactory: '0x0000000000000000000000000000000000000000' as Address,
      ...SHARED_ENFORCERS,
    },
  }
  for (const n of NETWORKS) {
    if (n.deployment.status !== 'live') continue
    out[n.chain.id] = {
      delegationManager: DELEGATION_MANAGER,
      delegatorModuleFactory: n.deployment.moduleFactory,
      ...SHARED_ENFORCERS,
      ...(n.deployment.enforcers === 'canonical' ? {} : { hourglass: HOURGLASS_PAYMENT }),
    }
  }
  return out
}

/** Contract addresses per live network, derived from `networks.ts`. Pending networks are absent. */
export const addresses: Record<number, ChainAddresses> = buildAddresses()

export function getAddresses(chainId: number): ChainAddresses {
  const addrs = addresses[chainId]
  if (!addrs) throw new Error(unavailableReason(chainId))
  return addrs
}

/** Why HourGlass cannot run on a chain: not deployed there yet, or not supported at all. */
export function unavailableReason(chainId: number): string {
  const network = findNetwork(chainId)
  return network
    ? `HourGlass is not deployed on ${network.name} yet.`
    : `Unsupported chain: ${chainId}`
}
