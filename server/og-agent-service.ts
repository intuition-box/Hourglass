/**
 * Agent provisioning + execution service.
 *
 * Carries the "Execute with an agent" flow the Limit order tab triggers, in the order
 * the chain forces:
 *
 *   POST /provision            -> a wallet is created, its address returned
 *   (operator signs the mandate to that address, from the Safe)
 *   (operator funds that address with gas, a separate Safe transaction — ADR 0007)
 *   POST /runs/:id/start       -> the 0G agent drives the order to a fill
 *   GET  /runs/:id             -> state and log tail
 *
 * Provision must come first: the mandate's delegate IS the agent address, so it has to
 * exist before there is anything to sign. Funding must come after signing, so gas is
 * only committed to a mandate that exists.
 *
 * The model creates its own wallet, in its own shell, as the skill describes. What it
 * cannot be trusted with is the quality of that key: a model that writes a key it composed
 * itself, or copies one out of documentation, produces an address anyone can spend from —
 * and the mandate gets signed to that address. So the key is verified here before the run
 * is ever handed out: the private key must actually derive the address it claims, and must
 * not be a small integer. A model that fails this does not get a fallback, it fails.
 *
 * Hourglass holds these keys. That is a deliberate reversal of the skill's non-custodial
 * stance, taken to remove friction for the DAO, and it is bounded: the mandate's caveats
 * cap what any of them can do. Give each run only enough ETH for one redeem.
 *
 * Run: OG_ROUTER_API_KEY=sk-... UNISWAP_API_KEY=... bun server/og-agent-service.ts
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, cpSync, symlinkSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from 'viem'
import { base, mainnet } from 'viem/chains'
import { isOriginAllowed, parseAllowedOrigins } from './cors'

const RUNS_DIR = resolve(process.env.AGENT_RUNS_DIR ?? '.agent-runs')
const SCRIPTS_DIR = resolve(process.env.AGENT_SCRIPTS_DIR ?? 'skills/hourglass-agent/scripts')
const port = Number(process.env.OG_AGENT_PORT ?? '8789')
const allowedOriginPatterns = parseAllowedOrigins(process.env.ALLOWED_ORIGIN)

const routerKey = process.env.OG_ROUTER_API_KEY
const uniswapKey = process.env.UNISWAP_API_KEY

const CHAINS = { [base.id]: base, [mainnet.id]: mainnet } as const

type RunState = 'provisioned' | 'running' | 'filled' | 'blocked' | 'failed'

interface Run {
  id: string
  address: Address
  privateKey: Hex
  state: RunState
  detail: string | null
  startedAt: string | null
  chainId: number | null
}

const runs = new Map<string, Run>()

function runDir(id: string): string {
  return join(RUNS_DIR, id)
}

/** Per-run working directory, so two runs never share an instruction.json. */
function prepareRunDir(id: string): string {
  const dir = runDir(id)
  mkdirSync(dir, { recursive: true })
  for (const file of ['run-limit-order.ts', 'run-yield.ts', 'run-dca.ts', 'package.json']) {
    const src = join(SCRIPTS_DIR, file)
    if (existsSync(src)) cpSync(src, join(dir, file))
  }
  // Reuse the already-installed dependencies rather than reinstalling per run.
  const modules = join(dir, 'node_modules')
  if (!existsSync(modules) && existsSync(join(SCRIPTS_DIR, 'node_modules'))) {
    symlinkSync(join(SCRIPTS_DIR, 'node_modules'), modules, 'dir')
  }
  return dir
}

/**
 * Accept the model's keypair only if it holds up. A key the model invented rather than
 * generated would still parse — it just would not derive its own address, or it would be
 * a small integer someone else can guess. Both are fatal: the mandate is signed to this
 * address, so a guessable key hands the fill to anyone watching.
 */
function verifyWallet(raw: unknown): { address: Address; privateKey: Hex } {
  if (typeof raw !== 'object' || raw === null) throw new Error('agent-wallet.json is not an object')
  const w = raw as Record<string, unknown>
  if (typeof w.privateKey !== 'string' || !isHex(w.privateKey) || w.privateKey.length !== 66) {
    throw new Error('agent-wallet.json: privateKey must be 0x + 64 hex chars')
  }
  if (typeof w.address !== 'string' || !isAddress(w.address)) {
    throw new Error('agent-wallet.json: address is not an address')
  }
  const privateKey = w.privateKey as Hex
  const derived = privateKeyToAccount(privateKey).address
  if (derived.toLowerCase() !== w.address.toLowerCase()) {
    throw new Error(`agent-wallet.json: privateKey derives ${derived}, not the claimed ${w.address}`)
  }
  // A composed key is overwhelmingly likely to be small, patterned, or a doc example.
  const value = BigInt(privateKey)
  if (value < 2n ** 128n) throw new Error('agent-wallet.json: privateKey is far too small to be random')
  return { address: derived, privateKey }
}

/**
 * Spawn a subprocess and stream both its streams into a log file. Bun.spawn will not
 * take a FileSink for stdout, so pipe and drain instead.
 */
function spawnLogged(cmd: string[], env: Record<string, string | undefined>, logPath: string) {
  const proc = Bun.spawn(cmd, { cwd: resolve('.'), env, stdout: 'pipe', stderr: 'pipe' })
  const sink = Bun.file(logPath).writer()
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      sink.write(chunk)
      sink.flush()
    }
  }
  const streams = Promise.all([drain(proc.stdout), drain(proc.stderr)])
  const finished = proc.exited.then(async (code) => {
    await streams
    await sink.end()
    return code
  })
  return { finished }
}

async function provisionByModel(): Promise<Run> {
  const stagingId = `staging-${Date.now().toString(36)}`
  const dir = prepareRunDir(stagingId)
  const logPath = join(dir, 'provision.log')

  const { finished } = spawnLogged(
    ['bun', 'server/og-agent.ts', '--provision'],
    { ...process.env, AGENT_WORKDIR: dir, AGENT_MAX_STEPS: process.env.PROVISION_MAX_STEPS ?? '12' },
    logPath,
  )
  await finished

  const walletPath = join(dir, 'agent-wallet.json')
  if (!existsSync(walletPath)) {
    throw new Error(`the agent did not produce a wallet. Log:\n${logTailAt(logPath)}`)
  }
  const { address, privateKey } = verifyWallet(JSON.parse(readFileSync(walletPath, 'utf8')) as unknown)

  const id = address.slice(2, 10).toLowerCase()
  renameSync(dir, runDir(id))

  const run: Run = { id, address, privateKey, state: 'provisioned', detail: null, startedAt: null, chainId: null }
  // The key stays on disk, not just in this process. A restart between provisioning and
  // start would otherwise destroy it — and the mandate is already signed to that address,
  // so losing it means an order nobody can fill and gas nobody can recover.
  writeFileSync(join(runDir(id), 'agent-wallet.json'), JSON.stringify({ address, privateKey }, null, 2))
  runs.set(id, run)
  return run
}

interface Instruction {
  hourglassStrategy: 'limitOrder' | 'yield'
  chainId: number
  agent: string
  /** Limit order only: the mandate the runner matches on. A yield plan is discovered
   *  whole (three pinned steps addressed to this agent), so it carries no hash. */
  delegationHash?: string
}

function parseInstruction(raw: unknown, expected: Address): Instruction {
  if (typeof raw !== 'object' || raw === null) throw new Error('instruction must be an object')
  const i = raw as Record<string, unknown>
  if (i.hourglassStrategy !== 'limitOrder' && i.hourglassStrategy !== 'yield') {
    throw new Error(`unsupported strategy: ${String(i.hourglassStrategy)}`)
  }
  if (!Number.isInteger(i.chainId) || !(i.chainId as number in CHAINS)) {
    throw new Error(`unsupported chainId (expected ${Object.keys(CHAINS).join(' or ')})`)
  }
  if (typeof i.agent !== 'string' || !isAddress(i.agent)) throw new Error('invalid agent address')
  if (i.agent.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`instruction agent ${i.agent} is not this run's address ${expected}`)
  }
  if (i.hourglassStrategy === 'limitOrder' && (typeof i.delegationHash !== 'string' || !isHex(i.delegationHash))) {
    throw new Error('invalid delegationHash')
  }
  return i as unknown as Instruction
}

/** The balance gate: a run cannot start on an unfunded agent — it would only burn steps. */
async function assertFunded(address: Address, chainId: number): Promise<bigint> {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  const client = createPublicClient({ chain, transport: http() })
  const balance = await client.getBalance({ address })
  if (balance === 0n) throw new Error(`agent ${address} holds no gas on chain ${chainId} — fund it first`)
  return balance
}

function launch(run: Run, instruction: Instruction): void {
  const dir = runDir(run.id)
  writeFileSync(join(dir, 'instruction.json'), JSON.stringify(instruction, null, 2))
  const logPath = join(dir, 'agent.log')

  const { finished } = spawnLogged(
    ['bun', 'server/og-agent.ts', join(dir, 'instruction.json')],
    {
      ...process.env,
      AGENT_PRIVATE_KEY: run.privateKey,
      AGENT_WORKDIR: dir,
      INTUITION_NETWORK: process.env.INTUITION_NETWORK ?? 'mainnet',
    },
    logPath,
  )

  run.state = 'running'
  run.startedAt = new Date().toISOString()
  run.chainId = instruction.chainId

  void finished.then((code) => {
    const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    if (tail.includes('done: filled')) {
      run.state = 'filled'
    } else if (tail.includes('done: blocked')) {
      run.state = 'blocked'
    } else {
      run.state = code === 0 ? 'blocked' : 'failed'
    }
    const match = tail.match(/done: \w+ — (.*)/)
    run.detail = match?.[1]?.slice(0, 400) ?? `exited with code ${code}`
  })
}

function logTailAt(path: string, lines = 40): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
}

function logTail(id: string, lines = 40): string {
  return logTailAt(join(runDir(id), 'agent.log'), lines)
}

function view(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    agentAddress: run.address,
    state: run.state,
    detail: run.detail,
    startedAt: run.startedAt,
    chainId: run.chainId,
    log: logTail(run.id),
  }
}

function cors(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (origin && isOriginAllowed(origin, allowedOriginPatterns)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) })
}

const ready = routerKey !== undefined && uniswapKey !== undefined

Bun.serve({
  port,
  async fetch(req) {
    const origin = req.headers.get('Origin')
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/health') {
      const missing = [
        routerKey ? null : 'OG_ROUTER_API_KEY',
        uniswapKey ? null : 'UNISWAP_API_KEY',
      ].filter((v): v is string => v !== null)
      return json({ ok: true, ready, missing, runs: runs.size }, 200, origin)
    }

    if (req.method === 'POST' && url.pathname === '/provision') {
      if (!ready) return json({ error: 'not configured' }, 503, origin)
      try {
        const run = await provisionByModel()
        return json({ id: run.id, agentAddress: run.address, state: run.state }, 200, origin)
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'provision failed' }, 502, origin)
      }
    }

    if (parts[0] === 'runs' && parts[1]) {
      const run = runs.get(parts[1])
      if (!run) return json({ error: 'run not found' }, 404, origin)

      if (req.method === 'GET' && parts.length === 2) return json(view(run), 200, origin)

      if (req.method === 'POST' && parts[2] === 'start') {
        if (run.state === 'running') return json({ error: 'already running' }, 409, origin)
        try {
          const body = (await req.json()) as { instruction?: unknown }
          const instruction = parseInstruction(body.instruction, run.address)
          const balance = await assertFunded(run.address, instruction.chainId)
          launch(run, instruction)
          return json({ ...view(run), balance: balance.toString() }, 200, origin)
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : 'start failed' }, 400, origin)
        }
      }
    }

    return json({ error: 'not found' }, 404, origin)
  },
})

/** Runs outlive this process: rebuild the registry from the run directories at boot. */
function restoreRuns(): void {
  if (!existsSync(RUNS_DIR)) return
  for (const entry of readdirSync(RUNS_DIR)) {
    if (entry.startsWith('staging-')) continue
    const walletPath = join(RUNS_DIR, entry, 'agent-wallet.json')
    if (!existsSync(walletPath)) continue
    try {
      const { address, privateKey } = verifyWallet(JSON.parse(readFileSync(walletPath, 'utf8')) as unknown)
      const log = logTailAt(join(RUNS_DIR, entry, 'agent.log'), 200)
      const state: RunState = log.includes('done: filled') ? 'filled' : log.includes('done: blocked') ? 'blocked' : 'provisioned'
      runs.set(entry, { id: entry, address, privateKey, state, detail: null, startedAt: null, chainId: null })
    } catch {
      // A run directory we cannot read is not a reason to refuse to boot.
    }
  }
}

mkdirSync(RUNS_DIR, { recursive: true })
restoreRuns()
console.log(
  ready
    ? `og-agent-service on :${port} — ${runs.size} run(s) restored from ${RUNS_DIR}`
    : `og-agent-service on :${port} — NOT READY (need OG_ROUTER_API_KEY and UNISWAP_API_KEY)`,
)
