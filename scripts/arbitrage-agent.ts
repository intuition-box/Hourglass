/**
 * Arbitrage agent runner (SCAFFOLD) — intra-Uniswap arbitrage under a signed
 * Hourglass mandate. See docs/HOURGLASS_ARBITRAGE.md.
 *
 * The agent is redeem-only and non-custodial: it composes ONE Universal Router
 * `execute` for the whole round-trip and redeems the mandate. The on-chain
 * `erc20BalanceChange(Increase)` floor guarantees the Safe can only end richer, or
 * the redemption reverts. Detection (when there is an edge) is 100% off-chain here.
 *
 * Status: scaffold. The redeem wiring mirrors src/lib/redeemDirect.ts and is
 * concrete. Two parts are marked TODO and must be closed before running against a
 * live chain:
 *   - the multi-command `execute` composition (needs @uniswap/universal-router-sdk
 *     — a new dependency — and the CONTRACT_BALANCE sentinel confirmed);
 *   - the Increase-enforcer instance choice (docs §9.2).
 *
 * Run with: bun run scripts/arbitrage-agent.ts   (after wiring the env below)
 */
import {
  createExecution,
  ExecutionMode,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { encodePermissionContexts, encodeExecutionCalldatas } from '@metamask/smart-accounts-kit/utils'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getAddresses } from '../src/config/addresses'
import type { StoredDelegation } from '../src/lib/storage'

// --- Config (fail loud, no silent fallbacks) -------------------------------

interface AgentConfig {
  rpcUrl: string
  agentPrivateKey: Hex
  tradingApiKey: string
  chainId: number
  universalRouter: Address
  baseToken: Address
  interToken: Address
  amountInRaw: bigint
  minProfitRaw: bigint
  feeTierA: number
  feeTierB: number
  maxConsecutiveReverts: number
  pollMs: number
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function loadConfig(): AgentConfig {
  return {
    rpcUrl: requireEnv('ARB_RPC_URL'),
    agentPrivateKey: requireEnv('ARB_AGENT_PRIVATE_KEY') as Hex,
    tradingApiKey: requireEnv('ARB_TRADING_API_KEY'),
    chainId: Number(requireEnv('ARB_CHAIN_ID')),
    // The Universal Router lives in src/config/uniswap.ts (mainnet + Base only);
    // pass it explicitly here rather than coupling the runner to that config.
    universalRouter: requireEnv('ARB_UNIVERSAL_ROUTER') as Address,
    baseToken: requireEnv('ARB_BASE_TOKEN') as Address,
    interToken: requireEnv('ARB_INTER_TOKEN') as Address,
    amountInRaw: BigInt(requireEnv('ARB_AMOUNT_IN_RAW')),
    minProfitRaw: BigInt(requireEnv('ARB_MIN_PROFIT_RAW')),
    feeTierA: Number(process.env.ARB_FEE_TIER_A ?? '500'),
    feeTierB: Number(process.env.ARB_FEE_TIER_B ?? '3000'),
    maxConsecutiveReverts: Number(process.env.ARB_MAX_REVERTS ?? '5'),
    pollMs: Number(process.env.ARB_POLL_MS ?? '12000'),
  }
}

// --- Trading API (CLASSIC quotes only) -------------------------------------

const TRADING_API = 'https://trade-api.gateway.uniswap.org/v1'

interface ClassicQuote {
  outputRaw: bigint
  gasFeeUSD: string
}

/**
 * One directional CLASSIC quote. CLASSIC is mandatory: UniswapX returns an
 * off-chain signed order with no `execute` tx, which the mandate cannot bound.
 */
async function fetchClassicQuote(
  cfg: AgentConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountRaw: bigint,
  swapper: Address,
): Promise<ClassicQuote> {
  const res = await fetch(`${TRADING_API}/quote`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.tradingApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      swapper,
      tokenIn,
      tokenOut,
      tokenInChainId: String(cfg.chainId),
      tokenOutChainId: String(cfg.chainId),
      amount: amountRaw.toString(),
      type: 'EXACT_INPUT',
      routingPreference: 'CLASSIC',
      protocols: ['V2', 'V3', 'V4'],
      slippageTolerance: 0.5,
    }),
  })
  const body = (await res.json()) as {
    routing?: string
    quote?: { output?: { amount?: string }; gasFeeUSD?: string }
    detail?: string
  }
  if (!res.ok) throw new Error(`quote failed (${res.status}): ${body.detail ?? 'unknown'}`)
  if (body.routing !== 'CLASSIC' || !body.quote?.output?.amount) {
    throw new Error(`non-CLASSIC quote returned (routing=${body.routing})`)
  }
  return { outputRaw: BigInt(body.quote.output.amount), gasFeeUSD: body.quote.gasFeeUSD ?? '0' }
}

// --- Compose ONE execute for the round-trip --------------------------------

/** v3 single-hop path encoding: tokenIn (20) · fee (3) · tokenOut (20). */
function encodeV3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut])
}

/**
 * Build the calldata for a single `execute` that swaps base→inter (output kept in
 * the router) then inter→base back to the Safe, with the final `amountOutMin`
 * pinned to `amountIn + minProfit` (the double floor, docs §6).
 *
 * TODO(arb): this composes the two commands via @uniswap/universal-router-sdk's
 * RoutePlanner. That package is a NEW dependency (add to package.json with
 * justification). The leg-2 input must be the router's inter-token balance — use
 * the Universal Router CONTRACT_BALANCE sentinel (verify the exact constant against
 * the installed SDK). `ALLOW_REVERT` must stay OFF on both commands (docs §6).
 */
function composeArbExecuteCalldata(cfg: AgentConfig, safe: Address): Hex {
  // Placeholder assembly kept explicit so the wiring is obvious. Replace the two
  // `inputs` blobs with RoutePlanner-encoded command inputs once the dep is added.
  const pathA = encodeV3Path(cfg.baseToken, cfg.feeTierA, cfg.interToken)
  const pathB = encodeV3Path(cfg.interToken, cfg.feeTierB, cfg.baseToken)
  void pathA
  void pathB
  void safe
  throw new Error(
    'composeArbExecuteCalldata: wire @uniswap/universal-router-sdk RoutePlanner ' +
      '(V3_SWAP_EXACT_IN → ADDRESS_THIS, then V3_SWAP_EXACT_IN → MSG_SENDER with ' +
      'amountOutMin = amountIn + minProfit). See docs/HOURGLASS_ARBITRAGE.md §2/§6.',
  )
}

// --- Redeem the mandate (mirrors src/lib/redeemDirect.ts) ------------------

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

function buildArbRedeemTx(
  cfg: AgentConfig,
  delegation: StoredDelegation['delegation'],
  executeCalldata: Hex,
): { to: Address; data: Hex } {
  const { delegationManager } = getAddresses(cfg.chainId)

  // Single execution: the whole round-trip is one call to the Universal Router.
  const execution = createExecution({ target: cfg.universalRouter, value: 0n, callData: executeCalldata })

  const sdkDelegation: Delegation = {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' })),
    salt: delegation.salt,
    signature: delegation.signature,
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

  return { to: delegationManager, data }
}

// --- Runner ----------------------------------------------------------------

async function runOnce(cfg: AgentConfig, mandate: StoredDelegation): Promise<'traded' | 'no-edge' | 'reverted'> {
  const safe = mandate.meta.safeAddress
  const agent = privateKeyToAccount(cfg.agentPrivateKey)

  // Two directional CLASSIC quotes make the round-trip.
  const legA = await fetchClassicQuote(cfg, cfg.baseToken, cfg.interToken, cfg.amountInRaw, safe)
  const legB = await fetchClassicQuote(cfg, cfg.interToken, cfg.baseToken, legA.outputRaw, safe)

  const grossProfit = legB.outputRaw - cfg.amountInRaw
  if (grossProfit < cfg.minProfitRaw) {
    return 'no-edge' // below the floor — don't even try; the caveat would revert.
  }

  const executeCalldata = composeArbExecuteCalldata(cfg, safe)
  const tx = buildArbRedeemTx(cfg, mandate.delegation, executeCalldata)

  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) })
  const walletClient = createWalletClient({ account: agent, transport: http(cfg.rpcUrl) })

  try {
    // The floor is the guarantee; simulate first so an evaporated edge fails cheaply.
    await publicClient.call({ account: agent.address, to: tx.to, data: tx.data })
    const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, chain: null })
    await publicClient.waitForTransactionReceipt({ hash })
    return 'traded'
  } catch {
    return 'reverted' // edge gone or floor not cleared — Safe untouched.
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const mandate = loadMandate() // TODO(arb): load the signed StoredDelegation (bundle/file).

  let consecutiveReverts = 0
  for (;;) {
    const outcome = await runOnce(cfg, mandate)
    if (outcome === 'reverted') {
      consecutiveReverts += 1
      if (consecutiveReverts >= cfg.maxConsecutiveReverts) {
        throw new Error(`Circuit breaker: ${consecutiveReverts} consecutive reverts — stopping.`)
      }
    } else {
      consecutiveReverts = 0
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs))
  }
}

/** TODO(arb): load the signed arbitrage mandate. Mirror the yield/strategy agent's
 * local bundle read, or import from the app's stored delegations. */
function loadMandate(): StoredDelegation {
  throw new Error('loadMandate: wire the signed StoredDelegation source (bundle/file).')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
