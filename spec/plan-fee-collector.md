# Plan — Opt-in fee collector ("Support OurGlass")

## Goal

Add a usage-based fee for OurGlass: roughly **$1 (1 USDC) per charge** a payor's
subscriptions incur. The fee is collected through a **separate, opt-in delegation**
from the payor to a fixed OurGlass fee-collector address — completely decoupled from
the subscription delegations, which stay exactly as they are today.

## Why this design (and not the alternatives)

We evaluated three ways to take a fee. Recorded here so the choice is auditable:

1. **Bake the fee into each subscription caveat** (cap = amount + $1, two transfers
   per charge). Rejected: needs a two-transfer charge, which hits the period
   enforcer's batch-mode incompatibility, and it would force re-signing every
   existing subscription.
2. **Platform takes custody** (subscriber → OurGlass, OurGlass forwards to payee).
   Rejected for the POC: introduces fund custody and a trust/security surface the
   app does not have today (payees currently redeem straight to themselves).
3. **Separate opt-in fee delegation, OurGlass redeems it independently.** Chosen.
   The subscription charge path is untouched (no custody, no batch, no caveat
   change). The fee is a parallel, opt-in revenue stream.

Key enabling fact (verified against the SDK docs, `delegations.md:104`): the
`erc20PeriodTransfer` caveat is a **per-period allowance that resets each period**,
not a one-shot. Multiple draws within a period accumulate toward the cap. So a single
opt-in delegation can fund many `$1` draws per period, up to a ceiling.

## Decisions (locked, with rationale)

1. **Ceiling model — payor sets a flat monthly USDC ceiling.**
   The opt-in delegation's `periodAmount` is a ceiling the payor consents to (default
   suggestion shown in UI = `active subscriptions × $1 × 2` safety factor, editable;
   floor $1). `periodDuration` = 30 days. The ceiling is a hard cap: usage beyond it
   in a period cannot be collected until the next period. Simple, explicit consent,
   bounded exposure.
2. **Cadence — periodic sweep, not per-charge.**
   OurGlass draws the period's accumulated fee in one transaction, and can sweep
   **many opted-in payors in a single `redeemDelegations` call** (one `SingleDefault`
   tuple per payor). Amortizes gas; the $1 only has to beat its share of one batched
   tx. Per-charge real-time draw is possible later (the allowance allows it) but is
   not in this plan.
3. **Fee collector — one fixed address, from env.**
   `VITE_FEE_COLLECTOR` (an OurGlass-controlled EOA or Safe), documented in
   `.env.example`. Same address across chains if operationally possible. This address
   is also the **on-chain attribution marker** (see Analytics hook below).
4. **UX — separate opt-in, its own signature.**
   A dedicated "Support OurGlass" action (settings panel + an offer after a
   subscription is created). It is **not** bundled into subscription signing — keeps
   subscription terms/salt pure and makes the fee genuinely optional. One extra
   EIP-712 signature.

## Trust model (state plainly)

The caveat is a **cap, not a meter**. It bounds the maximum OurGlass can pull per
period; it does not verify the transaction count on-chain. Within the ceiling,
OurGlass draws based on its own off-chain count of charges. The payor trusts OurGlass
not to over-draw, bounded by the ceiling they signed.

Mitigations:
- The payor sets the ceiling.
- The `$1/charge` rate and the ceiling are written into the pinned agreement, so they
  are bound to the delegation salt and auditable.

## Architecture

Two components. The web app only handles **opt-in signing**. Collection runs in an
**operational script** holding the fee-collector key — never in the client.

### A. Opt-in signing (web app)

Mirrors the existing create flow in `src/pages/CreateDelegation.tsx`, but:
- `delegate` = `VITE_FEE_COLLECTOR` (not a payee).
- `from` = the payor's DeleGator module (same `predictAddress` derivation already
  used).
- scope = `erc20PeriodTransfer`, `tokenAddress` = USDC, `periodAmount` = chosen
  ceiling, `periodDuration` = 30 days, `startDate` = now.
- A small fee-agreement document is built and pinned (reuse
  `src/lib/subscriptionTerms.ts`), recording the `$1/charge` rate + ceiling; its hash
  is the salt — same pattern as subscriptions.
- Signed via `sdk.txs.signTypedMessage` (reuse `src/lib/delegations.ts`).
- Stored separately from subscriptions (new localStorage key
  `ourglass-fee-delegation`, or a `kind: 'fee'` discriminant on `StoredDelegation`).

### B. Fee collection (operational script — new)

`scripts/collect-fees.ts` (new), run by OurGlass on a schedule:
- Input: the set of opted-in fee delegations (exported by payors / shared with
  OurGlass — see "Open operational question" below).
- For each, compute the fee owed = `$1 × charges observed this period` (off-chain
  count), clamped to the remaining period allowance.
- Build one `redeemDelegations` call bundling all payors:
  `delegations: [[feeDelegA], [feeDelegB], …]`,
  `modes: [SingleDefault, SingleDefault, …]`,
  `executions: [[transfer feeA → collector], [transfer feeB → collector], …]`.
- Reuses the redemption shape in `src/lib/redeemDirect.ts` (extracted to a shared
  helper so the script and the app agree on encoding).

## Files to touch

| File | Change |
|---|---|
| `src/config/addresses.ts` or new `src/config/fees.ts` | `feeCollector` address from `VITE_FEE_COLLECTOR`; `FEE_PER_CHARGE = 1 USDC` constant |
| `src/lib/feeDelegation.ts` (new) | Build + sign the opt-in fee delegation (reuses createDelegation / terms / typed-data helpers) |
| `src/lib/storage.ts` | Store/read the fee delegation (new key or `kind` discriminant) |
| `src/lib/redeemDirect.ts` | Extract a shared "build redeem tuple" helper for reuse by the collection script |
| `src/pages/*` + `src/ui/components.tsx` | "Support OurGlass" opt-in card/flow (settings + post-create offer) |
| `scripts/collect-fees.ts` (new) | Operational sweep using the fee-collector key |
| `.env.example` | Document `VITE_FEE_COLLECTOR` |

## Analytics hook (free byproduct)

Every fee draw originates from the fixed `VITE_FEE_COLLECTOR` address. Because the fee
is flat ($1/charge), the count of inbound transfers to that address = the count of
charges from opted-in payors. This is the first on-chain attribution marker for
OurGlass and the seed of a Dune-style dashboard. Full volume + count analytics
(including non-opted users) is a separate, larger piece — see the analytics discussion
(candidate `plan-analytics.md`).

## Open operational question

Collection (component B) needs OurGlass to **have the opted-in delegations**. The app
is local-first (delegations live in `localStorage`). Options, to decide before
building B:
- Payor exports the signed fee delegation to OurGlass at opt-in time (a POST to an
  OurGlass endpoint, or the existing JSON-export pattern). Minimal backend.
- A subgraph/indexer reconstructs them from on-chain data (only works if delegations
  are published on-chain — ties into the analytics decision).

Component A (signing) has no such dependency and can ship first.

## Risks / notes

- **Gas vs fee.** $1 must beat the collector's share of one batched sweep. Fine on
  Base L2; size batches accordingly. Track on-chain (USDC received).
- **Opt-in = voluntary revenue.** Non-participants pay nothing. Deliberate.
- **`redeemDelegations` multi-tuple in one call** (the batched sweep) is the standard
  way to redeem multiple delegations atomically and is structurally supported by the
  ABI already in `redeemDirect.ts`. Confirm with a local two-payor redeem before
  relying on it for the sweep.
- **Period enforcer cumulative draw** confirmed via docs; confirm empirically on
  testnet that two sub-cap draws in one period both succeed.

## Verification (per `.claude/rules/workflow.md`)

1. `bun run typecheck` and `bun run build`.
2. Testnet walk-through: opt in (sign) → simulate N charges → run `collect-fees`
   sweep → confirm collector received `N × $1` and the period cap blocks over-draw.
3. `ui-reviewer` agent on the opt-in UI; manual SDK-usage check against the docs.
4. No new Solidity here (no enforcer, no registry), so no `contract-reviewer` needed
   for this plan. If the analytics work adds a contract, that is a separate ADR +
   `contract-reviewer` pass.

## Scope note

This stays inside the POC scope: no custom enforcer, no new contract, no change to the
subscription charge path. The collection script is operational tooling, not a protocol
change.
