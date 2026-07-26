/**
 * 0G-driven agent harness.
 *
 * Gives a 0G Compute model a shell and the hourglass-agent skill, and lets it drive a
 * limit order to completion. The model is the brain; this file is the hands.
 *
 * Why this is safe enough to demo, and where it is not:
 *
 * The mandate's on-chain caveats bound what any redeem can do — `erc20BalanceChange`
 * Decrease caps the spend, the Increase bound is the price floor, `limitedCalls(1)`
 * allows exactly one fill. A confused or prompt-injected model cannot exceed the cap,
 * touch a different token, or drain the Safe. That is the property this harness exists
 * to demonstrate.
 *
 * Those caveats protect the SAFE. They do not protect this process. The shell is bounded
 * by nothing, and this container holds the agent key. So it must run as a throwaway with
 * nothing else in it and only enough ETH for one redeem. Never give this harness a key
 * that guards anything but the gas it spends.
 *
 * Run: OG_ROUTER_API_KEY=sk-... AGENT_PRIVATE_KEY=0x... UNISWAP_API_KEY=... \
 *      bun server/og-agent.ts <instruction.json>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROUTER_URL = process.env.OG_ROUTER_URL ?? 'https://router-api.0g.ai/v1'
const MODEL = process.env.OG_MODEL ?? '0gm-1.0-35b-a3b'
const SKILL_PATH = process.env.SKILL_PATH ?? 'skills/hourglass-agent/SKILL.md'
const WORKDIR = process.env.AGENT_WORKDIR ?? 'skills/hourglass-agent/scripts'
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? '40')
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? '900000')

const apiKey = process.env.OG_ROUTER_API_KEY

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the agent working directory and return its stdout, stderr and exit code. ' +
        'Use it to install dependencies, inspect files, create a wallet, and run the limit-order runner.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Call when the order has filled, or when you cannot proceed. Ends the run.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['filled', 'blocked'] },
          detail: { type: 'string', description: 'One sentence on what happened.' },
        },
        required: ['outcome', 'detail'],
      },
    },
  },
]

async function runBash(command: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-lc', command], {
    cwd: resolve(WORKDIR),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)
  // Truncate hard: a runaway command must not blow the context window.
  const clip = (s: string): string => (s.length > 4000 ? `${s.slice(0, 4000)}\n…[truncated]` : s)
  return `exit=${code}\n--- stdout ---\n${clip(stdout)}\n--- stderr ---\n${clip(stderr)}`
}

interface Completion {
  choices?: { message?: Message; finish_reason?: string }[]
  error?: { message?: string }
}

async function complete(key: string, messages: Message[]): Promise<Message> {
  const res = await fetch(`${ROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0 }),
  })
  if (!res.ok) throw new Error(`0G Router ${res.status}: ${(await res.text()).slice(0, 400)}`)
  const body = (await res.json()) as Completion
  const message = body.choices?.[0]?.message
  if (!message) throw new Error(`0G Router returned no message: ${JSON.stringify(body).slice(0, 300)}`)
  return message
}

const WALLET_FILE = 'agent-wallet.json'

function provisionPrompt(skill: string): string {
  return `${skill}

---

You are performing ONE step of this skill: creating the agent's wallet. Nothing else.

Your shell already starts in the runner directory. Do not cd anywhere.

Create a fresh EVM keypair and write it to ${WALLET_FILE} in that directory, as JSON with
exactly two keys: "address" (0x + 40 hex chars) and "privateKey" (0x + 64 hex chars).

Generate it with viem, which is already installed in node_modules. This one-liner does
the whole job — run it as-is:

bun -e 'import {generatePrivateKey,privateKeyToAccount} from "viem/accounts";const privateKey=generatePrivateKey();const {address}=privateKeyToAccount(privateKey);require("fs").writeFileSync("${WALLET_FILE}",JSON.stringify({address,privateKey},null,2));console.log(address)'

NEVER write a key you composed yourself, and never reuse an example key from
documentation: the mandate will be signed to this address, so a guessable key is a broken
agent. The caller verifies that the private key really derives the address and rejects
known-weak values.

Then call done(). Do not run the limit order.`
}

function systemPrompt(skill: string, instruction: string): string {
  return `${skill}

---

You are operating this skill autonomously.

Your shell ALREADY starts in the runner directory, which contains run-limit-order.ts,
run-dca.ts and package.json. Do not cd anywhere, do not search the filesystem for it, and
do not guess absolute paths — run 'ls' first and work with relative paths from there.

There is no human to hand anything back to: the wallet is already funded and the mandate
is already signed to it, so skip every step that asks the operator to act.

Your job: install dependencies if needed, then run the limit-order runner against the
instruction below and report what happened. Prefer running the bundled runner over
reimplementing its logic.

The environment already carries AGENT_PRIVATE_KEY, UNISWAP_API_KEY and INTUITION_NETWORK.
Never print, copy or transmit AGENT_PRIVATE_KEY.

Call done() when the order fills or when you are blocked. Do not loop forever.

Instruction (also on disk as instruction.json):
${instruction}`
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2)
  if (!apiKey) throw new Error('OG_ROUTER_API_KEY is not set')
  if (!existsSync(SKILL_PATH)) throw new Error(`skill not found: ${SKILL_PATH}`)
  const skill = readFileSync(SKILL_PATH, 'utf8')

  const provisioning = arg === '--provision'
  let messages: Message[]

  if (provisioning) {
    messages = [
      { role: 'system', content: provisionPrompt(skill) },
      { role: 'user', content: `Create the agent wallet and write ${WALLET_FILE}. Begin.` },
    ]
  } else {
    if (!arg) throw new Error('usage: bun server/og-agent.ts <instruction.json> | --provision')
    if (!existsSync(arg)) throw new Error(`instruction not found: ${arg}`)
    const instruction = readFileSync(arg, 'utf8')

    // Put the instruction where the runner expects it. It is also in the prompt, and the
    // model will happily rewrite it from there — but a mandate the model retyped is a
    // mandate the model can mistype.
    writeFileSync(join(resolve(WORKDIR), 'instruction.json'), instruction)

    messages = [
      { role: 'system', content: systemPrompt(skill, instruction) },
      { role: 'user', content: 'Run the limit order described in the instruction. Begin.' },
    ]
  }

  console.log(`og-agent → ${MODEL} @ ${ROUTER_URL}, cwd=${WORKDIR}, max ${MAX_STEPS} steps`)

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const message = await complete(apiKey, messages)
    messages.push(message)

    if (message.content) console.log(`\n[${step}] ${message.content}`)

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      console.log(`\n[${step}] no tool call — ending run`)
      return
    }

    for (const call of calls) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>

      if (call.function.name === 'done') {
        console.log(`\ndone: ${String(args.outcome)} — ${String(args.detail)}`)
        return
      }

      if (call.function.name !== 'bash' || typeof args.command !== 'string') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `unknown tool call` })
        continue
      }

      console.log(`\n[${step}] $ ${args.command}`)
      const output = await runBash(args.command)
      console.log(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  console.log(`\nstopped: reached ${MAX_STEPS} steps without done()`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
