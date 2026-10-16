# 0009 — Remove the hackathon agent and liquidity rails

**Status:** Accepted
**Date:** 2026-10-16
**Triggered by:** user request ("clean the hackathon work before going multi-chain")

## Context

The hackathon added rails beyond recurring payments: Agent DeFi (Uniswap v3
liquidity plans, auto-compound, price-triggered limit orders), a hidden DCA
strategy tab, the 1inch Aqua integration, a 0G-hosted agent service, a mandate
assistant, agent runner scripts and a workshop pitch deck. Most were not
functional end to end (DCA lacked the Permit2 setup, Aqua was not tradable without
the 1inch API submission), each pinned its own chain-specific config, and the
hosted agent ran a second process holding agent keys in the production container.
The next tasks — multi-chain support, an analytics indexer, a landing redesign —
would all have had to carry them.

## Decision

Delete every agent/strategy/Aqua surface from the Safe App, the container, the
docs site and the repo docs. Keep the payment rails (subscriptions, streams,
charge, revoke, verify) and the Intuition discovery integration. The environment
overrides now route only the four enforcers the payment rails use
(`ERC20PeriodTransfer`, `Timestamp`, `ERC20Streaming`, and `ValueLte`, which the
SDK adds to both payment scopes) through the HourGlass instances; the rest of the
deployed suite stays listed as unwired. `test/unit/payment-delegations.test.ts`
pins the subscription and stream payloads to the ones the app shipped before this
change, on all four supported chains.

## Alternatives considered

- **Hide the tabs, keep the code** — the code still constrains every chain and
  build change, and dead code violates `code.md`. Git history keeps it recoverable.
- **Keep the decoders for already-published agent mandates in Intuition
  discovery** — no screen renders them any more, so discovering them would surface
  delegations the Charge page cannot act on.

## Consequences

**Positive:**
- The app, container and docs describe one product: bounded recurring payments.
- Chain support no longer depends on Uniswap, Aqua or 0G availability.

**Negative:**
- Agent mandates already signed by a Safe still exist on-chain until revoked. The
  app no longer lists them; a Safe owner revokes them by calling
  `disableDelegation` on the DelegationManager directly.
- The production container no longer starts the agent service. Any agent wallet
  keys under the old `/agent/.agent-runs` volume must be swept before the volume
  is dropped.

**Neutral (worth knowing):**
- The agent rails were only ever exercised in tests; no production Safe used them.
- Supersedes 0006, 0007 (both) and 0008 (both).
- `src/lib/storage.ts` keeps reading older localStorage entries; extra fields from
  strategy mandates are ignored.

## References

- Related rule: `.claude/rules/workflow.md` (scope discipline)
- Related ADR: `.claude/choices/0006-*.md`, `0007-*.md`, `0008-*.md`
