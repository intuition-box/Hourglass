# Agent-side operation — theoretical design, not a build target right now

Scope decision (this doc's reason to exist): the **manual** redeem path (operator, from
the Safe App — see `DELEGATION_OPERATIONS.md` §3) is what we're building and proving
end-to-end. The **agent** path — a bot holding a funded key, discovering and redeeming
unattended — stays a **documented design**, not something this phase funds an agent
wallet and runs on Base Sepolia to prove. Where an agent runner already exists in the
repo (deposit, compound), it's real, working code — just not something we're re-verifying
live right now. Where one doesn't exist (withdraw; register-based discovery), this is the
plan for building it later, not a promise it's coming this phase.

Read `DELEGATION_OPERATIONS.md` first — this doc assumes its mental model (delegate,
non-custody, the redemption primitive) and only adds the agent-specific detail.

Status legend: **[built]** real code in this repo, agent-executable today · **[design]**
specified, not built.

---

## 1. Deposit — agent **[built]**

- **Code:** `scripts/yield-agent.ts`.
- **How it works:** takes the plan JSON the Yield tab downloads, reads its 3 pinned
  delegations (`approve token0`, `approve token1`, `mint`), and replays each through
  `DelegationManager.redeemDelegations` in order, from the agent's own wallet
  (`AGENT_PRIVATE_KEY`). Every execution is `exactExecution`-pinned — the agent decides
  nothing, it only submits what the Safe already signed. Stops at the first revert rather
  than leaving a half-funded position.
- **Transport:** the plan JSON only. No Intuition register publish/discovery for this
  type today (see §4).
- **To actually prove this agent-executed** (not just manual, which we did): fund an
  agent wallet with a little Base Sepolia ETH, run `bun scripts/yield-agent.ts
  <plan.json>` against a plan signed with that wallet as delegate, confirm the position
  NFT lands in the Safe.

## 2. Compound — agent **[built]**

- **Code:** `skills/hourglass-agent/scripts/run-compound.ts` (~730 lines — the most
  complete runner in the repo).
- **How it works:** loads the compound mandate from the plan JSON, verifies its
  salt-verified `terms` match the signed delegation (rejects a tampered file), finds the
  Safe's live position (`tokenId`) in the mandate's pool, reads real economics (principal
  value, accrued fees, live gas price — all priced off the pool's own rate, no external
  feed), and decides whether compounding is worth it right now: `agent` mode runs a
  gas-vs-yield optimizer (`isCompoundDue` / `optimalIntervalDays`, the same simulation
  `CompoundProjection.tsx`'s card shows), `manual` mode uses the operator's fixed interval.
  When due, it preflights (`publicClient.call`) then redeems `collect` + `increaseLiquidity`
  atomically, with a circuit breaker after repeated on-chain reverts.
- **Correction to `IMPLEMENTATION_PLAN.md` §5 / §1:** it lists a skill doc
  `references/execution-compound.md` as **[live]** — that file does not exist in
  `skills/hourglass-agent/references/` (only `context.md`, `discovery.md`,
  `execution-dca.md`, `execution-limit-order.md`, `setup.md` do). The runner is real; its
  reference doc isn't written yet. Worth a follow-up fix in that plan doc.
- **Transport:** plan JSON only, same as deposit.
- **To actually prove this agent-executed:** fund an agent wallet, generate real fees
  (swap against the pool from another wallet), then
  `MAX_POLLS=1 bun skills/hourglass-agent/scripts/run-compound.ts <plan.json>` and
  confirm `liquidity` rose, fees reset, gas came from the agent — not the Safe.

## 3. Withdraw — agent **[design]**

Nothing exists yet — no mandate builder, no runner. `DELEGATION_OPERATIONS.md` §4.3
already specifies the shape; this is that design, restated as an implementation sketch
so picking it up later doesn't require re-deriving it.

- **Mandate:** `src/lib/withdrawDelegation.ts` (doesn't exist), mirroring
  `compoundDelegation.ts`'s structure almost exactly — `functionCall` over the
  PositionManager, `redeemer`-locked, salt-verified terms — swapping the method pair to
  **`decreaseLiquidity` + `collect`**.
- **The one real design wrinkle:** `collect`'s `recipient` must be pinned to the Safe (the
  non-custody guarantee for money moving *out*), but a single `allowedCalldata` offset
  constraint applied to a two-method scope would also — wrongly — constrain
  `decreaseLiquidity`'s bytes at that same offset, since the two methods don't share a
  layout. The specified fix is **two delegations**, not one: `decreaseLiquidity`
  (unpinned) and `collect` (recipient pinned to the Safe via `allowedCalldata`), redeemed
  as two `SingleDefault` entries. **This must be validated against the SDK's
  `allowedCalldata` builder before writing any code** — `DELEGATION_OPERATIONS.md` flags
  it explicitly as "not assumed." If the SDK can't express it as specified, stop and ask
  rather than shipping a weaker pin.
- **Runner:** `skills/hourglass-agent/scripts/run-withdraw.ts` (doesn't exist), same shape
  as `run-compound.ts`: load the mandate from the plan JSON, find the live `tokenId`,
  `decreaseLiquidity` for the requested amount, `collect(recipient = Safe)`, redeem
  atomically. Unlike compound, there's no "is it worth it" gas gate to design — a withdraw
  is operator-initiated (partial rebalance or full exit), not something an agent decides
  to do on its own schedule.
- **Residual risk, already named in `DELEGATION_OPERATIONS.md` §6:** `decreaseLiquidity`
  is amount-unbounded, same class of gap as compound's `increaseLiquidity`. A compromised
  agent could force an unwanted full exit — disruptive, not theft (funds still only ever
  land in the Safe). Bounding it is the same deferred per-period `erc20BalanceChange` work
  tracked in `FUTURE.md`, blocked on the SDK's `balance <= 0n` rejection.
- **UI:** a toggle in the Yield tab to sign the withdraw mandate alongside the plan —
  not built; would follow the exact pattern the auto-compound toggle already established
  (`CompoundProjection.tsx` / the `autoCompound` state in `Yield.tsx`).

## 4. Discovery via the Intuition register **[design]**

Today, both built runners (deposit, compound) only know how to read the plan JSON — the
operator has to hand the agent that file. The DCA/limit-order rail instead discovers by
querying the Intuition graph for `delegate to` triples addressed to the agent's own
address (`discoverIncomingDelegations`, `skills/hourglass-agent/references/discovery.md`).
Making our mandates discoverable the same way is `DELEGATION_OPERATIONS.md` §4.5's plan,
condensed to the two things that would actually need building:

1. **Publish on signing.** The Yield tab doesn't publish anything today — it only
   downloads the plan. Adding a best-effort publish (pin the DelegationJson + terms,
   register the triples) means the compound/withdraw mandate becomes graph-discoverable;
   gated on the Intuition pin API key being configured, degrading silently to
   plan-JSON-only when it isn't (never a hard failure).
2. **Recognize the mandate on read.** `src/lib/intuition/discover.ts`'s
   `toStoredDelegation` reconstructs a delegation by inspecting its caveats and returns
   `null` — silently dropped — for anything that isn't `erc20PeriodTransfer` /
   `erc20Streaming` / `erc20BalanceChange`. Our `functionCall`-over-PositionManager
   mandates match none of those, so **they're invisible to the register today even if
   published**. The prescribed fix avoids touching that shared file at all: teach the
   *runner* to query the register directly with the `intuition` skill's own GraphQL
   reference and its own filter for compound/withdraw, rather than extending a file the
   DCA/limit-order rail owns.
3. **Runner fallback order:** register first, plan JSON second — never remove the JSON
   path, since it's the zero-dependency case that already works.

None of this is built. It's the clearest "pick this up later" item in the whole agent
side, because it's genuinely additive — nothing here changes how deposit/compound already
work standalone.

## 5. What "proving this for real" would take, if picked up later

Not something to schedule now — recorded so it doesn't need re-deriving:

1. Fund a dedicated agent wallet with a little Base Sepolia ETH.
2. Sign a plan (deposit + auto-compound) in the Yield tab with that wallet's address as
   the Agent-mode delegate (not Manual).
3. Run `yield-agent.ts` against the plan; confirm the position lands in the Safe.
4. Generate real fees against the pool from a third wallet, then run `run-compound.ts`
   with `MAX_POLLS=1`; confirm the harvest + reinvest and that gas came from the agent.
5. Once `withdrawDelegation.ts` + `run-withdraw.ts` exist: sign a withdraw mandate, run
   it, confirm funds land back in the Safe, never the agent.
6. Once register discovery exists: repeat 3–5 with the plan JSON deleted, relying on the
   agent finding its mandates purely from the Intuition graph.

## References

- `DELEGATION_OPERATIONS.md` — the operating model this doc assumes (read first).
- `IMPLEMENTATION_PLAN.md` — the phased build plan; Phases 2–4 are this doc's "design"
  sections, phase-sequenced.
- `skills/hourglass-agent/SKILL.md` + `references/` — the agent skill's own docs (DCA and
  limit-order today; compound/withdraw would extend it the same way).
- `FUTURE.md` — the deferred per-period bound, referenced in §3.
