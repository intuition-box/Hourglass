import type { Address, Hex } from 'viem'

/**
 * Read-only client for the Safe Transaction Service "messages" API. A delegation
 * is signed as an off-chain Safe message (`sdk.txs.signTypedMessage`); the service
 * holds the message's EIP-712 typed data, the per-owner confirmations, and — once
 * the threshold is reached — the aggregated `preparedSignature`. This lets any
 * owner recover a finalized delegation later, independently of the session that
 * proposed it. No auth, GET only.
 */

/**
 * Chain id → Safe Transaction Service base URL. Must cover every chain in
 * `SUPPORTED_CHAINS` a delegation can be signed on: a missing entry makes the
 * message unreadable, so the publisher rejects an otherwise valid delegation
 * with "message not found". The legacy per-chain hosts 308-redirect to
 * `api.safe.global/tx-service/<slug>`; `fetch` follows that, no API key needed.
 */
const TX_SERVICE_URL: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  84532: 'https://safe-transaction-base-sepolia.safe.global',
  11155111: 'https://safe-transaction-sepolia.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
}

export function txServiceUrl(chainId: number): string | null {
  return TX_SERVICE_URL[chainId] ?? null
}

/** A confirmation is one owner's signature over the message. */
export interface SafeMessageConfirmation {
  owner: Address
  signature: Hex
}

/**
 * A Safe message as returned by the tx-service. `message` is the EIP-712 typed
 * data that was signed (an object, occasionally a JSON string). `preparedSignature`
 * is non-null once the message has reached the Safe's threshold — the aggregated
 * EIP-1271 signature.
 */
export interface SafeMessage {
  messageHash: Hex
  safe: Address
  message: unknown
  proposedBy?: Address
  confirmations: SafeMessageConfirmation[]
  preparedSignature: Hex | null
}

/** A message is finalized (threshold reached) exactly when the service has assembled `preparedSignature`. */
export function isMessageComplete(msg: SafeMessage): boolean {
  return typeof msg.preparedSignature === 'string' && msg.preparedSignature.length > 2
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Fetch a single message by its hash. Null if the service is unreachable or the message is unknown. */
export async function getSafeMessage(chainId: number, messageHash: Hex): Promise<SafeMessage | null> {
  const base = txServiceUrl(chainId)
  if (!base) return null
  return getJson<SafeMessage>(`${base}/api/v1/messages/${messageHash}/`)
}

/** List a Safe's messages (paginated; first page only here — the app polls its own recent ones). */
export async function listSafeMessages(chainId: number, safe: Address): Promise<SafeMessage[]> {
  const base = txServiceUrl(chainId)
  if (!base) return []
  const body = await getJson<{ results?: SafeMessage[] }>(`${base}/api/v1/safes/${safe}/messages/`)
  return body?.results ?? []
}
