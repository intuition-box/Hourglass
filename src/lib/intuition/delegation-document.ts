import type { DelegationStruct } from '../delegations'
import { cleanDisplayText } from '../sanitize-text'
import { SYMBOL_MAX_CHARS } from '../token-meta'

/**
 * The IPFS document behind a `DelegationJson` atom: a schema.org Thing (so the
 * Intuition indexer parses name/description into `atom.value.thing`) carrying the
 * atomic signed delegation under `delegation`. Relationship semantics live in the
 * triples; the Thing fields are display-only. See ADR 0004.
 *
 * The title is intentionally generic ("Hourglass delegation"); the human-readable
 * specifics (kind, enforcer, amount/period) go in the description, composed from
 * the delegation details the caller already has at signing time. The on-chain
 * caveat remains the source of truth — the description is display.
 */
export interface DelegationDocument {
  '@context': 'https://schema.org'
  '@type': 'Thing'
  name: string
  description: string
  image: string
  url: string
  delegation: DelegationStruct
}

/**
 * A periodic-cap subscription (erc20PeriodTransfer), an accruing stream
 * (erc20Streaming), or a strategy mandate (erc20BalanceChange — a per-swap spend
 * cap for an agent, e.g. DCA / range).
 */
export type DelegationKind = 'subscription' | 'stream' | 'dca' | 'approve' | 'yield'

export interface DelegationDetails {
  kind: DelegationKind
  /** Human amount — per period for subscription/stream, per swap for dca. e.g. "300". */
  amount: string
  /** Token ticker, e.g. "USDC". */
  tokenSymbol: string
  /** Human period noun, e.g. "month"; "swap" for a per-swap dca cap. */
  period: string
}

/** The canonical atom title. Intentionally generic — no amount/period. */
export const DELEGATION_DOCUMENT_NAME = 'Hourglass delegation'

const DEFAULT_URL = 'https://hourglass.box/'

const KIND_LABEL: Record<DelegationKind, string> = {
  subscription: 'Subscription',
  stream: 'Stream',
  dca: 'Strategy',
  approve: 'Approve',
  yield: 'Yield',
}

const KIND_ENFORCER: Record<DelegationKind, string> = {
  subscription: 'erc20PeriodTransfer',
  stream: 'erc20Streaming',
  dca: 'erc20BalanceChange',
  approve: 'exactCalldata',
  yield: 'exactExecution',
}

/** Cap on the derived amount string — a token with absurd `decimals` can make
 * `formatUnits` produce a very long string; bound it before it enters the doc. */
const AMOUNT_MAX_CHARS = 40

/**
 * One human-readable sentence describing what the delegation authorizes.
 *
 * `tokenSymbol` and `amount` originate from an attacker-deployable ERC-20 (an
 * arbitrary-bytes `symbol`, an absurd `decimals`), so they are sanitized before
 * they enter the pinned document — which any UI that renders the graph displays.
 */
export function describeDelegation(details: DelegationDetails): string {
  const symbol = cleanDisplayText(details.tokenSymbol, SYMBOL_MAX_CHARS)
  const amount = cleanDisplayText(details.amount, AMOUNT_MAX_CHARS)
  const enforcer = KIND_ENFORCER[details.kind]
  if (details.kind === 'approve') {
    // The limit-order companion: it grants the router an allowance on the funding
    // token so the paired swap can run. No amount/period in the display.
    return `${KIND_LABEL[details.kind]} delegation using the ${enforcer} enforcer, granting a ${symbol} allowance for a paired limit-order swap.`
  }
  if (details.kind === 'yield') {
    // One step of a yield deposit plan. The caveat pins target, method and calldata, so
    // there is no amount or period to state — what it authorises IS that one execution.
    return `${KIND_LABEL[details.kind]} delegation using the ${enforcer} enforcer, pinned to one exact pre-approved call of a liquidity deposit plan.`
  }
  if (details.kind === 'dca') {
    // A strategy mandate bounds the loss per swap, not an amount per period.
    return `${KIND_LABEL[details.kind]} delegation using the ${enforcer} enforcer with a cap of ${amount} ${symbol} per ${details.period}.`
  }
  return `${KIND_LABEL[details.kind]} delegation using the ${enforcer} enforcer for an amount of ${amount} ${symbol} / ${details.period}.`
}

export function buildDelegationDocument(params: {
  delegation: DelegationStruct
  details: DelegationDetails
  url?: string
  image?: string
}): DelegationDocument {
  return {
    '@context': 'https://schema.org',
    '@type': 'Thing',
    name: DELEGATION_DOCUMENT_NAME,
    description: describeDelegation(params.details),
    image: params.image ?? '',
    url: params.url ?? DEFAULT_URL,
    delegation: params.delegation,
  }
}
