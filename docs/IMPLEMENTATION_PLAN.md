# Hourglass — implementation plan & handoff

Yield delegations: **deposit · compound · withdraw**, operated **manually** (operator, from
the Safe App) and **agentically** (an autonomous agent), discoverable via the **Intuition
register**.

## 0. How to use this doc

You are an AI agent (Claude) with access to this repo, the `hourglass-agent` skill, and the
`intuition` skill (`.agents/skills/intuition`). Before writing any code:

1. Read **`docs/DELEGATION_OPERATIONS.md`** — the operating model (deposit/compound/withdraw,
   agent vs manual, the Intuition register). This plan assumes it.
2. Load the rules for the surface you touch: `.claude/rules/workflow.md` (every task, start &
   end), `code.md`, `ui.md` (web), `security.md` + `metamask-delegation.md` (any delegation/
   caveat work). They **override** default behaviour.
3. Check `FUTURE.md` for deferred decisions before "improving" anything.

Do not start broad. Pick the current phase, do the smallest correct slice, verify, hand back.

## 1. Where we are (built + verified, on `feat/yield-combined`)

- **Deposit** — 3 single-use `exactExecution` delegations (approve, approve, mint). Build:
  `src/lib/yieldDelegations.ts`. Agent redeem: `scripts/yield-agent.ts`.
- **Compound** — standing `functionCall` mandate (`collect` + `increaseLiquidity` only, no
  principal withdrawal), salt-verified terms in the plan JSON, gas-aware optimizer. Build:
  `src/lib/compoundDelegation.ts`. Economics: `src/lib/compounding.ts` (+ tests). Card:
  `src/ui/CompoundProjection.tsx`. Agent runner: `skills/hourglass-agent/scripts/run-compound.ts`.
- **Manual redeem (deposit)** — the operator redeems from the Safe App with the **Safe as the
  delegate**. Service: `src/lib/redeemYield.ts` (`buildYieldRedeemTxs` → `sdk.txs.send`). UI:
  the Agent/Manual toggle + Redeem button in `src/pages/Yield.tsx`.
- **Skills** — `hourglass-agent` (discovery + redeem runners, `references/`), and `intuition`
  (0xIntuition register knowledge: `operations/create-atoms.md`, `create-triples.md`,
  `reference/graphql-queries.md`; produces **unsigned** tx params — signing/broadcast is ours).

Green bar: `bunx tsc -b` (or `node_modules/.bin/tsc -b`) exit 0; `eslint` clean; `bun test
test/unit` passing (1 pre-existing unrelated failure in `stream-amounts.test.ts`).

## 2. The end goal

The full **meter y sacar** cycle under bounded delegations: deposit → compound (add) →
withdraw (remove), each redeemable **manually** (Safe-delegate) or **agentically** (agent
runner), discoverable via the **Intuition register** with the **plan JSON as fallback**.
Money only ever ends up in the Safe.

## 3. Work, in phases (order matters)

### Phase 1 — Manual redeem for compound + withdraw

Extend the deposit manual redeem (`redeemYield.ts` + Yield tab) to the standing mandates. Unlike
deposit (byte-pinned, no reads), compound/withdraw need **on-chain reads at redeem time**
(position `tokenId`, accrued fees, liquidity), because the executions aren't fully known at sign
time. Reuse the read logic already written in `run-compound.ts` (tokenId discovery, `collect`
simulation) — lift it into a small service the UI can call, then build the `collect` +
`increaseLiquidity` (compound) or `decreaseLiquidity` + `collect` (withdraw) executions and send
via `sdk.txs.send`.

- New: `src/lib/redeemCompound.ts` (build the compound redeem Safe txs from a live position).
- Wire a "Compound now" / "Withdraw" button in the Yield tab, Manual mode only.
- The mandate must have been signed with **delegate = Safe** (Manual mode) — same rule as deposit.

### Phase 2 — Withdraw delegation (`buildWithdrawMandate`)

The missing *sacar* mandate. See `docs/DELEGATION_OPERATIONS.md` §4.3.

- New: `src/lib/withdrawDelegation.ts` — mirror `compoundDelegation.ts`. `functionCall` over the
  PositionManager, methods **`decreaseLiquidity` + `collect`**, `redeemer`-locked, salt-verified
  terms.
- **Recipient pinned to the Safe** on `collect` via `allowedCalldata` — the non-custody guarantee.
  Because a single `allowedCalldata` over a two-method scope collides, model it as **two
  delegations** (`decreaseLiquidity` unpinned; `collect` recipient-pinned). **Validate the
  `allowedCalldata` offset against the SDK builder before shipping** — same way the compound scope
  was validated. If the SDK can't express it, stop and ask; do not weaken the pin.
- Sign it in the Yield tab alongside the plan (a toggle), and add `run-withdraw.ts` mirroring
  `run-compound.ts`.

### Phase 3 — Register / discovery via the `intuition` skill (don't rewrite `src/lib/intuition`)

See `docs/DELEGATION_OPERATIONS.md` §4.4–4.5. Goal: the agent discovers our mandates from the
Intuition register like the DCA/limit-order rail, **plan JSON stays the fallback**.

- **Publish on signing (best-effort).** Pin the DelegationJson document (signed delegation +
  salt-verified terms) and register the `delegate to` / `in context of` triples. Use the
  `intuition` skill's `operations/create-atoms.md` + `create-triples.md` to construct the
  **unsigned** txs; sign/broadcast with our wallet layer. Gated on the Intuition pin API key
  (`FUTURE.md`) — when absent, skip silently (plan JSON still works).
- **Discovery blocker.** `src/lib/intuition/discover.ts` → `toStoredDelegation` reconstructs by
  **caveat** and returns `null` for anything it doesn't recognize — our `functionCall` mandates
  are dropped today. Prefer the **agent-side** fix: have the runner query the register with the
  `intuition` skill's `reference/graphql-queries.md` and its own filter for the compound/withdraw
  mandate, so we **do not modify `src/lib/intuition`**. Only extend `toStoredDelegation` if the app
  itself needs to list these mandates — and if so, coordinate the merge (that file is the swap
  rail's).

### Phase 4 — Agentic runners end-to-end

- Finish the on-chain wiring in `run-compound.ts` (and new `run-withdraw.ts`): real gas, APR,
  standing approvals, `redeemDelegations` as the Safe.
- Dual-source discovery: register first (Phase 3), plan JSON fallback.
- Prove the loop on Base Sepolia per `docs/DELEGATION_OPERATIONS.md` §8.

## 4. Guardrails (non-negotiable)

**Security invariants** (never regress — `security.md`, `metamask-delegation.md`):
- The agent/delegate **never custodies the treasury** — holds only gas.
- **Money only ever returns to the Safe.** Withdrawal's `collect` recipient is **pinned to the
  Safe**; the compound mandate has **no `decreaseLiquidity`/`burn`** (cannot withdraw principal).
- **`redeemer` + delegate binding** on every mandate. **Salt = `keccak256(terms)`**; terms travel
  with the delegation and are verified against the salt at redeem time — reject a tampered plan.
- **Bounded approvals**, not `maxUint256`, where an allowance is the blast radius. Per-period caps
  are deferred (`FUTURE.md`) — don't ship unbounded authority to mainnet.
- Amounts are decided at run time but **never widen a caveat**. If a task needs a new caveat or a
  custom enforcer, **stop and ask** — no custom enforcers in this repo.

**Scope discipline** (`workflow.md`): this is a focused POC. "While we're at it…" → stop. Either
the user authorizes the expansion or it goes in `FUTURE.md`.

**Skills, not rewrites:** use the `intuition` skill for register/graph work (it produces unsigned
tx params) instead of extending `src/lib/intuition`. Use the `hourglass-agent` skill's runners +
`references/` for discover→redeem. Don't reinvent what the skills already encode.

**Coordinate merges:** the Intuition files (`src/lib/intuition/*`), `SKILL.md`,
`scripts/package.json`, `uniswap.ts`, `main.tsx` are shared with the DCA/limit-order rail. Sequence
changes with the team; prefer additive changes that don't touch those files.

**Verification (a task isn't done until it's verified — `workflow.md`):**
1. `tsc -b` green, `eslint` clean, `bun test test/unit` for economics.
2. Web/UI change → the `ui-reviewer` agent; any Solidity → `contract-reviewer`.
3. Spot-check against the rules: no `any`, no `as` without a one-line reason, named exports,
   NatSpec on Solidity, no dead code.
4. On-chain flows: confirm on Base Sepolia, not just on paper.

**Git hygiene:** conventional, atomic commits (`feat(web):`, `feat(core):`, `docs:`, `chore:`).
No `--no-verify`, no force-push to `main` (feature branches fine). Record non-obvious decisions as
an ADR in `.claude/choices/`.

**Communication:** end-of-task report = *What shipped / What I decided / What's next*. No filler,
no emoji, no over-formatting.

## 5. File map

| Concern | Files |
|---|---|
| Deposit | `src/lib/yieldDelegations.ts`, `src/lib/uniswapPosition.ts`, `scripts/yield-agent.ts` |
| Compound | `src/lib/compoundDelegation.ts`, `src/lib/compounding.ts`, `src/lib/compoundApproval.ts`, `src/ui/CompoundProjection.tsx`, `skills/hourglass-agent/scripts/run-compound.ts` |
| Manual redeem | `src/lib/redeemYield.ts`, `src/lib/redeemDirect.ts`, `src/pages/Yield.tsx` |
| Withdraw [to build] | `src/lib/withdrawDelegation.ts`, `skills/hourglass-agent/scripts/run-withdraw.ts` |
| Register / discovery | `.agents/skills/intuition/` (skill), `src/lib/intuition/*` (shared — avoid), `skills/hourglass-agent/references/discovery.md` |
| Config | `src/config/uniswap.ts`, `src/config/addresses.ts`, `src/config/abis.ts` |

## 6. References

- `docs/DELEGATION_OPERATIONS.md` — the operating model (read first).
- `.claude/rules/*.md` — the binding rules (workflow, code, ui, security, metamask-delegation).
- `FUTURE.md` — deferred hardening & known gaps.
- `.agents/skills/intuition/SKILL.md` — Intuition Protocol V2 (atoms/triples/graphql).
- `skills/hourglass-agent/SKILL.md` + `references/` — agent discover→redeem.
- MetaMask Smart Accounts Kit — https://docs.metamask.io/smart-accounts-kit/
