/**
 * Deploy HourGlass's own contracts to a network, or check them.
 *
 *   bun scripts/deploy-network.ts check                    # every network, no key needed
 *   bun scripts/deploy-network.ts deploy <chainId> [...]   # needs DEPLOYER_PRIVATE_KEY
 *
 * RPC_URL overrides the target network's RPC for a single-chain deploy (e.g. a keyed
 * endpoint, or an anvil fork to rehearse a deployment). `check` always uses the registry.
 *
 * What gets deployed: the four enforcers the payment rails sign against
 * (ERC20PeriodTransfer, Timestamp, ERC20Streaming, ValueLte) and the
 * DeleGatorModuleFactory. Each goes through the deterministic CREATE2 deployer under
 * the OURGLASS salt, with the exact creation code recovered from the Ethereum
 * deployment (scripts/deployments/hourglass-initcode.json). The address depends only
 * on salt + initcode, so any funded wallet produces the same addresses on every chain.
 *
 * Safety: a contract whose address already holds code is skipped; after deploying, the
 * runtime bytecode is compared to the Ethereum instance and the factory's
 * DelegationManager is read back. Any mismatch stops the run.
 *
 * When `deploy` succeeds, set the network to `live('payment')` in src/config/networks.ts.
 */
import {
  createPublicClient,
  createWalletClient,
  concatHex,
  getContractAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { NETWORKS, findNetwork, type Network } from '../src/config/networks'
import initcodeFile from './deployments/hourglass-initcode.json'

const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
const CREATE2_DEPLOYER = initcodeFile.create2Deployer as Address // checked below against the canonical deployer
const SALT = initcodeFile.salt as Hex // a 32-byte hex literal in the JSON

interface Artifact {
  name: string
  address: Address
  initcode: Hex
}

// JSON values are plain strings; the hex shape is asserted in verifyArtifacts().
const ARTIFACTS: Artifact[] = Object.entries(initcodeFile.contracts).map(([name, c]) => ({
  name,
  address: c.address as Address,
  initcode: c.initcode as Hex,
}))

function verifyArtifacts(): void {
  if (CREATE2_DEPLOYER !== '0x4e59b44847b379578588920cA78FbF26c0B4956C') throw new Error('unexpected CREATE2 deployer')
  for (const a of ARTIFACTS) {
    const predicted = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: SALT, bytecode: a.initcode })
    if (predicted !== a.address) throw new Error(`${a.name}: initcode predicts ${predicted}, file says ${a.address}`)
  }
}

/** RPC_URL overrides the registry RPC for the network being deployed (a keyed endpoint, or a local fork). */
let rpcOverride: string | undefined

function rpcFor(n: Network): string {
  return n === ethereum ? n.rpcUrl : rpcOverride ?? n.rpcUrl
}

function clientFor(n: Network): PublicClient {
  return createPublicClient({ chain: n.chain, transport: http(rpcFor(n), { timeout: 20_000 }) })
}

const ethereum = findNetwork(1)! // Ethereum is always in the registry: it is the bytecode reference
const FACTORY = 'delegatorModuleFactory'
/** The factory on Ethereum, at its original CREATE address: the reference for every other one. */
const ETHEREUM_FACTORY: Address = '0xbDDE43bCf6Db9DBeB1127E6574CCF70BFb1c2DC3'
const factoryAbi = parseAbi([
  'function implementation() view returns (address)',
  'function delegationManager() view returns (address)',
])

const codeCache = new Map<string, Hex>()
async function codeAt(client: PublicClient, address: Address): Promise<Hex | undefined> {
  const key = `${client.chain!.id}:${address}` // every client here is built with a chain
  if (!codeCache.has(key)) {
    const code = await client.getCode({ address })
    if (code && code !== '0x') codeCache.set(key, code)
  }
  return codeCache.get(key)
}

type Status = 'missing' | 'ok' | 'mismatch'

/**
 * Whether the contract at `address` is byte-identical to its Ethereum counterpart.
 *
 * Enforcers compare as-is. A factory deploys its module implementation in its
 * constructor and keeps that address as an immutable, so its runtime code embeds an
 * instance-specific address: compare with that address normalized, compare the
 * implementations the same way, and check the factory's DelegationManager.
 */
async function matchesEthereum(client: PublicClient, name: string, address: Address): Promise<Status> {
  const ref = clientFor(ethereum)
  const code = await codeAt(client, address)
  if (!code) return 'missing'
  if (name !== FACTORY) return code === (await codeAt(ref, address)) ? 'ok' : 'mismatch'

  const [impl, refImpl, dm] = await Promise.all([
    client.readContract({ address, abi: factoryAbi, functionName: 'implementation' }),
    ref.readContract({ address: ETHEREUM_FACTORY, abi: factoryAbi, functionName: 'implementation' }),
    client.readContract({ address, abi: factoryAbi, functionName: 'delegationManager' }),
  ])
  const normalize = (c: Hex | undefined) => c?.toLowerCase().replaceAll(impl.slice(2).toLowerCase(), refImpl.slice(2).toLowerCase())
  const sameFactory = normalize(code) === (await codeAt(ref, ETHEREUM_FACTORY))?.toLowerCase()
  const sameImpl = normalize(await codeAt(client, impl)) === (await codeAt(ref, refImpl))?.toLowerCase()
  return sameFactory && sameImpl && dm === DELEGATION_MANAGER ? 'ok' : 'mismatch'
}

/** What a network should hold: a canonical network references no HourGlass enforcer. */
function expected(n: Network): { name: string; address: Address }[] {
  const live = n.deployment.status === 'live' ? n.deployment : null
  return ARTIFACTS.filter((a) => a.name === FACTORY || live?.enforcers !== 'canonical').map((a) => ({
    name: a.name,
    // A live network may predate the CREATE2 factory and run its own.
    address: a.name === FACTORY && live ? live.moduleFactory : a.address,
  }))
}

async function inspect(n: Network): Promise<Record<string, Status>> {
  const client = clientFor(n)
  const out: Record<string, Status> = {}
  for (const { name, address } of expected(n)) out[name] = await matchesEthereum(client, name, address)
  return out
}

async function check(): Promise<void> {
  let failed = false
  for (const n of NETWORKS) {
    try {
      const status = await inspect(n)
      const problems = Object.entries(status).filter(([, s]) => s !== 'ok')
      // A live network must hold everything it references; a pending one is allowed to be empty.
      const bad = problems.some(([, s]) => s === 'mismatch') || (n.deployment.status === 'live' && problems.length > 0)
      if (bad) failed = true
      const summary = problems.length === 0 ? 'all contracts match Ethereum' : problems.map(([k, s]) => `${k}:${s}`).join(' ')
      console.log(`${bad ? 'FAIL' : '    '} ${String(n.chain.id).padEnd(9)} ${n.name.padEnd(18)} ${n.deployment.status.padEnd(8)} ${summary}`)
    } catch (err) {
      failed = true
      console.log(`FAIL ${String(n.chain.id).padEnd(9)} ${n.name.padEnd(18)} ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }
  if (failed) process.exit(1)
}

async function deploy(chainIds: number[]): Promise<void> {
  const raw = process.env.DEPLOYER_PRIVATE_KEY
  if (!raw) throw new Error('DEPLOYER_PRIVATE_KEY is not set (a wallet funded with native gas on each target chain).')
  const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex) // validated by viem

  for (const id of chainIds) {
    const n = findNetwork(id)
    if (!n) throw new Error(`chain ${id} is not in src/config/networks.ts`)
    const client = clientFor(n)
    const wallet = createWalletClient({ account, chain: n.chain, transport: http(rpcFor(n), { timeout: 60_000 }) })
    console.log(`\n${n.name} (${id}) — deployer ${account.address}, balance ${await client.getBalance({ address: account.address })} wei`)

    const deployerCode = await client.getCode({ address: CREATE2_DEPLOYER })
    if (!deployerCode || deployerCode === '0x') throw new Error(`${n.name}: no CREATE2 deployer at ${CREATE2_DEPLOYER}`)
    const dmCode = await client.getCode({ address: DELEGATION_MANAGER })
    if (!dmCode || dmCode === '0x') throw new Error(`${n.name}: no DelegationManager at ${DELEGATION_MANAGER}`)

    for (const a of ARTIFACTS) {
      const existing = await client.getCode({ address: a.address })
      if (existing && existing !== '0x') {
        console.log(`  ${a.name.padEnd(30)} already at ${a.address}`)
      } else {
        const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concatHex([SALT, a.initcode]) })
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`${a.name}: tx ${hash} reverted`)
        console.log(`  ${a.name.padEnd(30)} deployed at ${a.address} (tx ${hash})`)
      }
      if ((await matchesEthereum(client, a.name, a.address)) !== 'ok') throw new Error(`${a.name}: does not match the Ethereum instance`)
    }

    console.log(`  verified: every contract matches its Ethereum instance`)
    console.log(`  next: set ${n.name} to live('payment') in src/config/networks.ts`)
  }
}

verifyArtifacts()
const [mode, ...args] = process.argv.slice(2)
if (mode === 'check') await check()
else if (mode === 'deploy' && args.length > 0) {
  // One endpoint cannot serve several chains, so the override only applies to a single-chain deploy.
  if (process.env.RPC_URL && args.length > 1) throw new Error('RPC_URL can only be used when deploying a single chain')
  rpcOverride = process.env.RPC_URL
  await deploy(args.map(Number))
}
else {
  console.error('usage: bun scripts/deploy-network.ts check | deploy <chainId> [...]')
  process.exit(1)
}
