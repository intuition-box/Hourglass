# 0007 — Agent gas is self-funded, topped up from the Safe after mandate signature

**Status:** Accepted
**Date:** 2026-07-25
**Triggered by:** user request (agent execution layer — stack selection)

## Context

A strategy mandate is redeemed by an agent wallet sending a real `redeemDelegations`
transaction to the `DelegationManager` on Base / Ethereum mainnet. That transaction
costs native gas, and the agent must hold it. `skills/hourglass-agent/SKILL.md` states
the constraint plainly: *"Your one job the chain can't do for you: hold a funded key."*

Two ways out of that constraint were on the table.

The repo carried a vendored `public-relayer` skill (1Shot, ERC-7710 gas abstraction,
fees paid in USDC) referenced from `metamask-delegation.md`, `code.md`, `00-INDEX.md`
and two planning docs. It would have removed the funding step entirely: the relayer
submits the transaction, so the agent sends nothing on-chain and needs no gas at all.

It carries two structural costs against this repo's architecture. The relayer requires
the delegation to be signed **to its own `targetAddress`**, not to the agent — which
changes who the delegate is and therefore who controls timing. And it is documented
against a `7702StatelessDelegator` smart account, whereas the delegator here is a Safe
with a DeleGator module; support is unverified. A third, smaller cost: the mandate's
`functionCall` enforcers accept a single call per redeem entry, so the fee leg cannot
ride inside the mandate and would need a second sponsor delegation.

Separately, 0G was evaluated as the host for the agent runtime (see
`docs/0G-INTEGRATION-MAP.md`). 0G's payment layer settles 0G services on 0G Chain and
does nothing for Base gas — it is not an answer to this question either way.

## Decision

**Relayers and gas abstraction are out of scope.** Every redemption is a direct
transaction to the `DelegationManager`, paid in native gas by the redeeming party. The
`public-relayer` skill is deleted and `metamask-delegation.md` carries an explicit
stop-and-ask guard so the option does not silently return.

**The agent wallet is funded manually from the Safe, in its own transaction, after the
mandate is signed and before the runner starts.** The signature is the commitment
point: the mandate exists, is published, and the agent address is frozen inside it.
A non-zero agent balance is the precondition for entering the "running" state — the
balance check that `hourglass-agent` performs locally today moves into the app.

## Alternatives considered

- **Route redemptions through the 1Shot relayer** — removes the funding step, but
  reassigns the delegate to the relayer's `targetAddress`, is unverified against the
  Safe + module delegator, and needs a second sponsor delegation for the fee leg. Cost
  is architectural, benefit is one manual step. Rejected.
- **Fund the agent before the mandate is signed**, as soon as the wallet address
  exists — strands ETH on an enclave-controlled address if the multisig threshold is
  never reached and the mandate never comes into being.
- **Fund lazily, at fill time** — capital-efficient, but a limit order fills whenever
  the dip hits. Requiring a human signature at that moment reproduces the manual flow
  the agent rail exists to remove. Disqualified by the product.
- **Bundle the funding transfer into the existing Permit2 "Enable trading" batched Safe
  transaction** — saves a signature, but merges two unrelated consents (authorise the
  router to pull a token / send ETH to a third-party address) into one opaque approval.
  Rejected on legibility grounds: the signer must be able to read what they approve.

## Consequences

**Positive:**
- One redemption path in the repo. No relayer availability, quote expiry, fee-drift or
  webhook-verification surface to carry.
- The delegate stays the agent. Timing control and the `limitedCalls(1)` guarantee stay
  where the mandate puts them.
- Funding only ever happens for mandates that actually exist.
- Each Safe transaction carries exactly one consent.

**Negative:**
- One manual operator step per mandate remains, and it is irreducible under this
  decision.
- **Unspent gas is stranded — knowingly accepted for now.** It sits on an address whose
  key only the agent runtime holds, and `ModuleTransfer` sweeps the DeleGator module,
  not the agent wallet. Under the current limit-order-only scope: a limit order fires
  **once** (`limitedCalls(1)`), so the operator funds for one redeem and everything
  above the actual gas cost is stuck. An order whose trigger price never hits strands
  **the entire funding**, indefinitely.

  The user accepted this loss explicitly (2026-07-25) as the cost of shipping the first
  version. It is bounded by what the operator chooses to send, so the exposure is a
  funding-size decision, not an open-ended one — keep the top-up sized to one redeem
  plus a modest margin, not to a round number. A return-to-Safe sweep (fill /
  revocation / abandonment) is deferred to `FUTURE.md`.

**Neutral (worth knowing):**
- **Scope at the time of writing: limit order only.** The DCA rail is disconnected, so
  the recurring-strategy failure mode this decision would otherwise create — an agent
  exhausting its gas mid-plan and stopping silently, needing a refill cadence and a
  low-balance signal — is deferred, not solved. Revisit this ADR when DCA is
  reconnected; a single post-signature top-up does not cover a recurring strategy.
- The **EIP-7702** signing path was removed from the `metamask-delegation.md` table: it
  was defined solely by relayer-paid gas (*"fee + amount both paid in USDC via 1Shot"*)
  and describes nothing once the relayer is gone. Hybrid DeleGator and ERC-7715 remain.
- Two "no relayer in the middle" statements were deliberately kept (`README.md:11`,
  `website/src/redeem/lib/redeemDirect.ts:34`) — they are product claims this decision
  makes more true, not stale references.
- Where the agent *runtime* lives (0G Tapp enclave vs. operator-run) is a separate,
  still-open decision. This ADR binds only the gas model, and holds either way.

## References

- Related rule: `.claude/rules/metamask-delegation.md` (out-of-scope guard added)
- Related doc: `docs/0G-INTEGRATION-MAP.md`, `docs/COMPOUNDING_STRATEGY_PLAN.md`, `docs/doc-0G.md`
- Related skill: `skills/hourglass-agent/SKILL.md`
- Deleted: `.agents/skills/public-relayer/` (1Shot relayer JSON-RPC reference)
