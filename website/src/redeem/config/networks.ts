import { type Address, type Chain } from 'viem'
import {
  arbitrum,
  base,
  baseSepolia,
  berachain,
  berachainBepolia,
  bsc,
  foundry,
  gnosis,
  gnosisChiado,
  ink,
  linea,
  mainnet,
  monad,
  monadTestnet,
  optimism,
  polygon,
  sepolia,
  sonic,
  unichain,
} from 'viem/chains'

/**
 * Every network HourGlass knows about, and the single source of truth for per-chain
 * data: RPC, explorer, Safe Transaction Service, and where HourGlass's own contracts
 * stand. `supported-chains.ts`, `addresses.ts` and the wagmi configs all derive from
 * this list.
 *
 * A network is listed only if both prerequisites exist on it: MetaMask's Delegation
 * Framework v1.3.0 (deterministic DelegationManager + enforcers) and Safe{Wallet} with
 * a Transaction Service. HourGlass then needs its own DeleGatorModuleFactory there
 * before a Safe can use it — until `scripts/deploy-network.ts` has run, a network is
 * `pending` and the app does not offer it.
 *
 * Kept byte-identical with `website/src/redeem/config/networks.ts`
 * (test/unit/website-sync.test.ts enforces it).
 */

/** Which HourGlass-owned enforcer instances a live network's delegations reference. */
export type EnforcerSet =
  /** The full 37-enforcer suite (Ethereum, Base). */
  | 'suite'
  /** The four the payment rails sign against: period, timestamp, streaming, valueLte. */
  | 'payment'
  /** None: delegations reference MetaMask's canonical enforcers (testnets deployed before the suite). */
  | 'canonical'

export type Deployment =
  | { status: 'live'; moduleFactory: Address; enforcers: EnforcerSet }
  | { status: 'pending' }

export interface Network {
  chain: Chain
  name: string
  /** CORS-enabled public RPC, reachable from the Safe App iframe. */
  rpcUrl: string
  explorer: string
  /** Safe Transaction Service base URL (no trailing slash). */
  txService: string
  testnet: boolean
  deployment: Deployment
}

/**
 * The DeleGatorModuleFactory address on every network deployed through
 * `scripts/deploy-network.ts`: CREATE2 under the OURGLASS salt, so it is the same
 * everywhere. Ethereum, Base and the two Sepolias predate it and keep their own.
 */
export const CREATE2_MODULE_FACTORY: Address = '0x30eA334e6cBE550c4FD90d4558B776078f05c0d8'

const TX_SERVICE = 'https://api.safe.global/tx-service'

const live = (enforcers: EnforcerSet, moduleFactory: Address = CREATE2_MODULE_FACTORY): Deployment => ({
  status: 'live',
  moduleFactory,
  enforcers,
})
const pending: Deployment = { status: 'pending' }

export const NETWORKS: readonly Network[] = [
  {
    chain: mainnet,
    name: 'Ethereum',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
    txService: `${TX_SERVICE}/eth`,
    testnet: false,
    deployment: live('suite', '0xbDDE43bCf6Db9DBeB1127E6574CCF70BFb1c2DC3'),
  },
  {
    chain: base,
    name: 'Base',
    rpcUrl: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    txService: `${TX_SERVICE}/base`,
    testnet: false,
    deployment: live('suite', '0x0D0421e43057bf850e243EcDA2AD8966C8D5877B'),
  },
  {
    chain: optimism,
    name: 'OP Mainnet',
    rpcUrl: 'https://optimism-rpc.publicnode.com',
    explorer: 'https://optimistic.etherscan.io',
    txService: `${TX_SERVICE}/oeth`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: arbitrum,
    name: 'Arbitrum',
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com',
    explorer: 'https://arbiscan.io',
    txService: `${TX_SERVICE}/arb1`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: polygon,
    name: 'Polygon',
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com',
    txService: `${TX_SERVICE}/pol`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: bsc,
    name: 'BNB Chain',
    rpcUrl: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
    txService: `${TX_SERVICE}/bnb`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: gnosis,
    name: 'Gnosis',
    rpcUrl: 'https://gnosis-rpc.publicnode.com',
    explorer: 'https://gnosisscan.io',
    txService: `${TX_SERVICE}/gno`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: linea,
    name: 'Linea',
    rpcUrl: 'https://linea-rpc.publicnode.com',
    explorer: 'https://lineascan.build',
    txService: `${TX_SERVICE}/linea`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: unichain,
    name: 'Unichain',
    rpcUrl: 'https://unichain-rpc.publicnode.com',
    explorer: 'https://uniscan.xyz',
    txService: `${TX_SERVICE}/unichain`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: ink,
    name: 'Ink',
    rpcUrl: 'https://ink-rpc.publicnode.com',
    explorer: 'https://explorer.inkonchain.com',
    txService: `${TX_SERVICE}/ink`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: sonic,
    name: 'Sonic',
    rpcUrl: 'https://sonic-rpc.publicnode.com',
    explorer: 'https://sonicscan.org',
    txService: `${TX_SERVICE}/sonic`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: berachain,
    name: 'Berachain',
    rpcUrl: 'https://berachain-rpc.publicnode.com',
    explorer: 'https://berascan.com',
    txService: `${TX_SERVICE}/berachain`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: monad,
    name: 'Monad',
    rpcUrl: 'https://rpc.monad.xyz',
    explorer: 'https://monadvision.com',
    txService: `${TX_SERVICE}/monad`,
    testnet: false,
    deployment: pending,
  },
  {
    chain: baseSepolia,
    name: 'Base Sepolia',
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.basescan.org',
    txService: `${TX_SERVICE}/basesep`,
    testnet: true,
    deployment: live('canonical', '0xE64ea779033131583cDE1c8862685051E09C4b78'),
  },
  {
    chain: sepolia,
    name: 'Ethereum Sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    txService: `${TX_SERVICE}/sep`,
    testnet: true,
    deployment: live('canonical', '0x250435c7D339F03050c847c85f0108f44e876058'),
  },
  {
    chain: gnosisChiado,
    name: 'Gnosis Chiado',
    rpcUrl: 'https://gnosis-chiado-rpc.publicnode.com',
    explorer: 'https://blockscout.chiadochain.net',
    txService: `${TX_SERVICE}/chi`,
    testnet: true,
    deployment: pending,
  },
  {
    chain: berachainBepolia,
    name: 'Berachain Bepolia',
    rpcUrl: 'https://bepolia.rpc.berachain.com',
    explorer: 'https://bepolia.beratrail.io',
    txService: `${TX_SERVICE}/bep`,
    testnet: true,
    deployment: pending,
  },
  {
    chain: monadTestnet,
    name: 'Monad Testnet',
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadexplorer.com',
    txService: `${TX_SERVICE}/monad-testnet`,
    testnet: true,
    deployment: pending,
  },
]

/** Anvil (a forked Base Sepolia) for local end-to-end tests. Dev-only, never selectable. */
export const anvilLocal: Chain = {
  ...foundry,
  id: 31337,
  name: 'Anvil (Local)',
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
}

/** Networks where HourGlass is deployed and a Safe can use it. */
export const LIVE_NETWORKS: readonly Network[] = NETWORKS.filter((n) => n.deployment.status === 'live')

export function findNetwork(chainId: number): Network | undefined {
  return NETWORKS.find((n) => n.chain.id === chainId)
}
