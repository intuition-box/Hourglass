import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem'
import { getAddresses } from '../config/addresses'
import { findChain, rpcUrl, explorerTx } from '../config/supported-chains'

/**
 * A limit order is one-shot (`limitedCalls(1)`). Once the agent redeems it, the
 * HourGlass limitedCalls enforcer bumps an on-chain counter AND emits an event with
 * the `delegationHash` indexed. Reading the counter tells the UI the order has fired;
 * finding the event gives the execution transaction to link on the explorer.
 */

const limitedCallsAbi = parseAbi([
  'function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

// The HourGlass limitedCalls enforcer event fired on each redemption. Its topics are
// [sig, delegationManager, redeemer, delegationHash] — so topic[3] is the mandate.
// (Signature hash observed on the deployed enforcer; delegationHash is indexed.)
const INCREASED_COUNT_TOPIC0: Hex = '0x449da07f2c06c9d1a6b19d2454ffe749e8cf991d22f686e076a1a4844c5ff370'

// The public RPCs cap eth_getLogs to a modest block span; keep each scan within it.
const MAX_LOG_SPAN = 9000n
// Base / Ethereum block times (seconds) to turn a creation timestamp into a fromBlock.
const BLOCK_TIME_SEC: Record<number, number> = { 8453: 2, 84532: 2, 1: 12, 11155111: 12 }
// The app's default RPCs (publicnode) reject eth_getLogs (403); use the official chain
// endpoints, which honour it, for the event scan. Falls back to the configured RPC.
const LOGS_RPC: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
  1: 'https://eth.llamarpc.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
}

export interface LimitOrderExecution {
  /** The `limitedCalls` counter has reached its limit of 1. */
  executed: boolean
  /** Explorer URL of the redemption transaction, once located. */
  txUrl?: string
}

/**
 * Whether a limit order has fired, and (if so) a link to its redemption tx. The
 * boolean comes from a single `callCounts` read; the tx is located by scanning the
 * enforcer's events for the one whose indexed `delegationHash` matches, bounded to a
 * recent window derived from `createdAtISO` so the RPC never rejects the range.
 */
export async function getLimitOrderExecution(
  chainId: number,
  delegationHash: Hex,
  createdAtISO?: string,
): Promise<LimitOrderExecution> {
  const addrs = getAddresses(chainId)
  const enforcer = addrs.hourglass?.limitedCallsEnforcer
  const chain = findChain(chainId)
  if (!enforcer || !chain) return { executed: false }
  const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as PublicClient

  let executed = false
  try {
    const count = await client.readContract({
      address: enforcer,
      abi: limitedCallsAbi,
      functionName: 'callCounts',
      args: [addrs.delegationManager, delegationHash],
    })
    executed = count >= 1n
  } catch {
    return { executed: false }
  }
  if (!executed) return { executed: false }

  // Locate the redemption tx. Start from a block derived from when the mandate was
  // signed (the fill is after it); walk forward in RPC-sized spans to the tip. Uses a
  // logs-capable RPC (the app default rejects eth_getLogs).
  const logsClient = createPublicClient({ chain, transport: http(LOGS_RPC[chainId] ?? rpcUrl(chainId)) }) as PublicClient
  try {
    const latest = await logsClient.getBlockNumber()
    const blockTime = BLOCK_TIME_SEC[chainId] ?? 12
    let from = latest > MAX_LOG_SPAN ? latest - MAX_LOG_SPAN : 0n
    if (createdAtISO) {
      const createdSec = Math.floor(new Date(createdAtISO).getTime() / 1000)
      if (Number.isFinite(createdSec)) {
        const agoBlocks = BigInt(Math.max(0, Math.floor((Date.now() / 1000 - createdSec) / blockTime)) + 120)
        from = latest > agoBlocks ? latest - agoBlocks : 0n
      }
    }
    const target = delegationHash.toLowerCase()
    for (let start = from; start <= latest; start += MAX_LOG_SPAN + 1n) {
      const end = start + MAX_LOG_SPAN > latest ? latest : start + MAX_LOG_SPAN
      // Raw eth_getLogs — viem's typed getLogs has no positional-topics filter; we
      // match the enforcer event by topic0, then the mandate by its indexed topic[3].
      const logs = (await logsClient.request({
        method: 'eth_getLogs',
        params: [{ address: enforcer, topics: [INCREASED_COUNT_TOPIC0], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }],
      })) as { topics: Hex[]; transactionHash: Hex }[]
      const hit = logs.find((l) => l.topics[3]?.toLowerCase() === target)
      if (hit) return { executed, txUrl: explorerTx(chainId, hit.transactionHash) }
    }
  } catch {
    // Executed is still true; we just couldn't attach the tx link.
  }
  return { executed }
}
