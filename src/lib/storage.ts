import { type Address, type Hex } from 'viem'

export interface Caveat {
  enforcer: Address
  terms: Hex
}

export interface StoredDelegation {
  delegation: {
    delegate: Address
    delegator: Address
    authority: Hex
    caveats: Caveat[]
    salt: Hex
    signature: Hex
  }
  meta: {
    label: string
    scopeType: 'ethSpendingLimit' | 'erc20SpendingLimit' | 'erc20Streaming' | 'transferIntent' | 'swapIntent' | 'custom'
    createdAt: string
    chainId: number
    safeAddress: Address
    moduleAddress: Address
    status: 'pending' | 'signed' | 'revoked'
    delegationHash: Hex
    // Subscription contract pinned to IPFS, hash bound to the signature salt
    agreement?: { cid: string; uri: string; termsHash: Hex }
    // The Safe off-chain message hash for this delegation's signature. Lets
    // finalize-on-open recover the finalized message from the Safe tx-service and
    // poke the publisher — independent of when the Nth owner signs. (ADR 0005)
    safeMessageHash?: Hex
    // The org the proposer picked (owner of the payer's Safe), carried in the
    // finalize poke to build the (Organization) owns (Safe) edge. Optional.
    orgSelection?: { atomId?: Hex; name?: string }
    // Set once the delegation is recorded on Intuition — the DelegationJson atom,
    // used to deep-link to the Intuition portal. Absent until/unless published.
    intuition?: { atomId: Hex; network: 'testnet' | 'mainnet' }
    // Human-readable details
    amount?: string
    period?: string
    tokenAddress?: Address
    expiryDate?: string
    // Where the funds are paid — the payee, who is also the delegate.
    recipient?: Address
    // Streaming-specific (scopeType === 'erc20Streaming'). The erc20Streaming
    // caveat accrues linearly: balance = min(maxAmount, initialAmount +
    // amountPerSecond * (now - startTime)). All amounts are raw wei strings.
    amountPerSecond?: string
    initialAmount?: string
    maxAmount?: string
    startTime?: number
    // Display-only: the human rate the beneficiary signed up for (e.g. "1000" / "monthly").
    ratePerPeriod?: string
    ratePeriod?: string
    // Custom delegation meta
    targetAddress?: Address
    methodSelector?: Hex
    calldataArgs?: Hex
    maxValue?: string
    recipeName?: string
    customParams?: {
      name: string
      type: string
      value: string
      enforced: boolean
      locked: boolean
    }[]
  }
}

const STORAGE_KEY = 'gator-delegations'

export function getDelegations(): StoredDelegation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveDelegation(delegation: StoredDelegation): void {
  const existing = getDelegations()
  // Deduplicate by hash
  const filtered = existing.filter(
    (d) => d.meta.delegationHash !== delegation.meta.delegationHash
  )
  filtered.push(delegation)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function removeDelegation(delegationHash: Hex): void {
  const existing = getDelegations()
  const filtered = existing.filter(
    (d) => d.meta.delegationHash !== delegationHash
  )
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function updateDelegationStatus(
  delegationHash: Hex,
  status: StoredDelegation['meta']['status']
): void {
  const existing = getDelegations()
  const updated = existing.map((d) =>
    d.meta.delegationHash === delegationHash
      ? { ...d, meta: { ...d.meta, status } }
      : d
  )
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}

/** Record the Intuition DelegationJson atom once a delegation is published. */
export function setDelegationIntuition(
  delegationHash: Hex,
  intuition: NonNullable<StoredDelegation['meta']['intuition']>
): void {
  const existing = getDelegations()
  const updated = existing.map((d) =>
    d.meta.delegationHash === delegationHash
      ? { ...d, meta: { ...d.meta, intuition } }
      : d
  )
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}

export function importDelegationsJson(json: string): StoredDelegation[] {
  const parsed = JSON.parse(json)
  if (parsed.version && parsed.delegations) {
    return parsed.delegations
  }
  // Maybe it's a single delegation
  if (parsed.delegation && parsed.meta) {
    return [parsed]
  }
  throw new Error('Invalid delegation JSON format')
}
