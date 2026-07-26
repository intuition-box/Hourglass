import { useEffect } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import type { Address, Hex } from 'viem'
import { listSafeMessages, isMessageComplete } from '../lib/safe-messages'
import { delegationFromMessage } from '../lib/intuition/from-message'
import { intuitionPublisherUrl, pokePublish } from '../lib/intuitionPublisher'
import type { OrganizationInput } from '../lib/intuition'
import { getDelegations, setDelegationIntuition } from '../lib/storage'

/**
 * Finalize-on-open (ADR 0005). Whenever the app opens inside a Safe, list that
 * Safe's off-chain messages, keep the ones that are finalized (threshold reached)
 * AND are OurGlass delegations, and poke the publisher backend with references
 * only — the backend verifies EIP-1271 and reconstructs the signed struct. This
 * recovers indexing independently of the session that proposed the delegation, so
 * a co-signer who signs the next day no longer loses it.
 *
 * The poke carries no payload; the backend cannot be made to index anything the
 * Safe did not sign. Successful pokes are remembered locally to avoid re-poking on
 * every open (the backend's isTermCreated guard makes a repeat a harmless no-op).
 */

const POKED_KEY = 'og-finalize-poked'

function pokedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(POKED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function markPoked(hash: string): void {
  try {
    const set = pokedSet()
    set.add(hash)
    localStorage.setItem(POKED_KEY, JSON.stringify([...set]))
  } catch {
    // best-effort — a failed write only means a harmless re-poke next open
  }
}

/** The proposer's org selection + delegationHash for a message, from localStorage (if this device proposed it). */
function localRecordFor(messageHash: Hex): { organization?: OrganizationInput; delegationHash?: Hex } {
  const stored = getDelegations().find((d) => d.meta.safeMessageHash?.toLowerCase() === messageHash.toLowerCase())
  if (!stored) return {}
  const sel = stored.meta.orgSelection
  const organization: OrganizationInput | undefined = sel?.atomId
    ? { atomId: sel.atomId }
    : sel?.name
      ? { name: sel.name }
      : undefined
  return { organization, delegationHash: stored.meta.delegationHash }
}

/**
 * The finalize pass itself, callable outside the mount effect. Extracted so the Limit
 * order tab can run it on demand: the agent discovers its mandate on Intuition, so
 * starting one before this has run would fail on a mandate that is merely unindexed.
 *
 * Returns the atom id published per delegationHash. The pin is deterministic (ADR 0005),
 * so a caller that knows its own hash learns exactly which atom to expect — and an empty
 * result for a hash it just signed means the poke did not take.
 */
export async function finalizePending(
  chainId: number,
  safeAddress: Address,
  isCancelled: () => boolean = () => false,
): Promise<Map<string, string>> {
  const published = new Map<string, string>()
  if (!intuitionPublisherUrl()) return published
  const messages = await listSafeMessages(chainId, safeAddress)
  const poked = pokedSet()
  for (const msg of messages) {
    if (isCancelled()) return published
    if (!isMessageComplete(msg)) continue
    if (poked.has(msg.messageHash.toLowerCase())) continue
    if (!delegationFromMessage(msg, chainId)) continue // not an OurGlass delegation

    const { organization, delegationHash } = localRecordFor(msg.messageHash)
    try {
      const res = await pokePublish({ chainId, safeAddress, messageHash: msg.messageHash, organization })
      markPoked(msg.messageHash.toLowerCase())
      if (delegationHash) {
        published.set(delegationHash.toLowerCase(), res.result.atoms.delegationJson)
        setDelegationIntuition(delegationHash, {
          atomId: res.result.atoms.delegationJson,
          network: res.result.network,
        })
      }
    } catch {
      // transient (tx-service / backend) — retried on the next app open
    }
  }
  return published
}

export function useFinalizePending(): void {
  const { safe } = useSafeAppsSDK()
  const safeAddress = safe?.safeAddress as Address | undefined
  const chainId = safe?.chainId

  useEffect(() => {
    if (!safeAddress || !chainId) return
    let cancelled = false

    void finalizePending(chainId, safeAddress, () => cancelled)

    return () => {
      cancelled = true
    }
  }, [safeAddress, chainId])
}
