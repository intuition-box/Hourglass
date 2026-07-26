# Operating Hourglass yield delegations — deposit, compound, withdraw

How the signed delegations are **used after signing** to move a Safe's money in and out
of a Uniswap v3 liquidity position — the full *meter y sacar* cycle — in both **agent**
(automated) and **manual** (operator-driven) modes.

Status legend: **[live]** written and exercised · **[design]** specified here, not yet
built.

---

## 1. Mental model

A Safe (a company treasury) signs delegations. A delegation is a permission slip: it lets
a named **delegate** call a specific, bounded operation **as the Safe**, without ever
handing over custody. Two properties hold throughout:

- **The delegate never custodies the treasury.** It holds only gas. Every operation runs
  *as the Safe*; funds move within the Safe's own accounts (its LP position, its token
  balances) and, for withdrawals, can only ever land back **in the Safe**.
- **A delegation only grants the movement — nothing else.** The recipient of a withdrawal
  is pinned to the Safe, the target contract and methods are whitelisted, and the delegate
  is fixed. A compromised delegate can trigger the movement but cannot redirect the money,
  call another contract, or exceed the bound.

Two locks enforce this: **construction** (delegations are built and signed by the operator
in the Safe App, never by the agent) and **execution** (each redemption is bounded on-chain
by the delegation's caveats).

---

## 2. The redemption primitive

Every operation below is one call to the Delegation Framework's
`DelegationManager.redeemDelegations(permissionContexts, modes, executionCalldatas)`.

- It must be **sent by the delegate** named in the delegation (the `DelegationManager` binds
  `msg.sender` to the delegate; the `redeemer` caveat pins it too).
- Each execution is one **`SingleDefault`** entry — the `functionCall` enforcers reject batch
  executions, so a multi-call operation (e.g. `collect` + `increaseLiquidity`) is submitted as
  **several `SingleDefault` entries in one `redeemDelegations`**, not one batch.
- The stored delegation is converted to the SDK `Delegation` shape by adding a per-caveat
  `args: '0x'` (none of these caveats consume per-redemption args). See
  `src/lib/redeemDirect.ts` and `scripts/yield-agent.ts` for the exact conversion.

---

## 3. Agent vs Manual — who is the delegate

`agent` and `manual` are **not** two ways to redeem the same delegation. They differ by **who
is named as the delegate at signing**, and that choice is fixed by the signature.

| Mode | Delegate | Who sends the redeem | Gas paid by | Code |
|---|---|---|---|---|
| **Agent** | the agent wallet (address the operator pastes) | the agent, from a script/bot | the agent's ETH | `scripts/yield-agent.ts`, `skills/hourglass-agent/scripts/run-compound.ts` |
| **Manual** | the Safe itself (self-delegation) | the operator, from the Safe App | the Safe | `src/lib/redeemDirect.ts` + `sdk.txs.send` |

- **Agent mode** is for automation: the bot holds a funded key, watches state, and redeems.
  It is the only mode that can run unattended.
- **Manual mode** keeps execution in-house: the delegate is the **Safe**, so the operator
  redeems the delegation from a Safe App button (`buildRedeemTx` → `sdk.txs.send`), paying
  gas from the Safe. `redeemDirect.ts` is the reference (built for the subscription rail; the
  same `redeemDelegations` construction applies to yield/compound/withdraw executions).

Pick the delegate accordingly when signing. To offer both, the operator signs **two**
delegations (one delegate = agent, one delegate = Safe) — a delegate cannot be reassigned
without a new signature.

---

## 4. The three operations

Each is a delegation type over the Uniswap v3 **NonfungiblePositionManager** (or the pool's
ERC-20s). Together they let the treasury deposit, grow, and withdraw continuously.

### 4.1 Deposit — enter the position **[live]**

- **Delegations:** three single-use, `exactExecution`-pinned (calldata fixed byte-for-byte at
  signing): `approve(token0)`, `approve(token1)`, `mint(...)`.
- **Effect:** the Safe's tokens are approved and a full-range v3 position is minted, held by
  the Safe.
- **Bound:** `exactExecution` — the agent can only replay the exact transaction the operator
  signed; it cannot change target, method, amount, or recipient.
- **Run — agent:** `bun scripts/yield-agent.ts <yield-plan.json>` — reads the plan, redeems the
  3 delegations in order, stops at the first failure so a half-funded position isn't left.
- **Run — manual:** the same three `redeemDelegations` calls sent from the Safe App (delegate =
  Safe), via the `redeemDirect.ts` pattern.
- **Files:** `src/lib/yieldDelegations.ts` (build), `scripts/yield-agent.ts` (redeem).

### 4.2 Compound — grow the position (the *meter* side, repeatable) **[live]**

- **Delegation:** one standing, repeatable mandate — `functionCall` over the PositionManager,
  methods **`collect` + `increaseLiquidity` only**, `redeemer`-locked, optional `timestamp`
  window. No `decreaseLiquidity`/`burn` — the agent **cannot withdraw principal** here.
- **Effect:** harvest the position's fees to the Safe, then add them back into the same
  position. Repeatable — the mandate is standing.
- **Decision:** compound only when the extra yield beats the gas — `projectAgentOptimal`
  (agent) or the operator's fixed interval (manual). Mode/interval come from the plan's
  **salt-verified `compound.terms`**.
- **One-time setup:** "Enable compounding" — a **bounded** standing approval from the Safe to
  the PositionManager for both tokens, so `increaseLiquidity` can pull the harvested fees. The
  cap is the blast radius (the agent can never pull more than the approved amount).
- **Run — agent:** `bun skills/hourglass-agent/scripts/run-compound.ts <yield-plan.json>`.
- **Files:** `src/lib/compoundDelegation.ts` (build), `src/lib/compoundApproval.ts` (setup),
  `skills/hourglass-agent/scripts/run-compound.ts` (redeem),
  `skills/hourglass-agent/references/execution-compound.md` (procedure).

### 4.3 Withdraw — exit the position (the *sacar* side, repeatable) **[design]**

The missing half of *meter y sacar*. Lets the treasury pull liquidity back out — partially
(rebalance) or fully (exit) — under a delegation that **only grants the movement**, with the
destination hard-pinned to the Safe.

- **Delegation:** a standing mandate over the PositionManager, methods
  **`decreaseLiquidity` + `collect`**, `redeemer`-locked. The withdrawal target is
  **hard-pinned to the Safe** so funds can only ever return to the treasury.
- **How the pin works (and a real encoding detail):** only `collect` moves funds out;
  `decreaseLiquidity` merely converts liquidity into fees *owed inside the position* (nothing
  leaves the Safe). So the security property reduces to **pinning `collect`'s `recipient`
  argument to the Safe** via an `allowedCalldata` caveat on that byte offset.

  A single `allowedCalldata` over a two-method `functionCall` scope applies the same offset
  constraint to **both** methods, and `decreaseLiquidity`'s bytes at that offset are a
  different field — so pinning naively would break `decreaseLiquidity`. Model the withdraw as
  **two delegations**: `decreaseLiquidity` (no calldata pin) and `collect` (recipient pinned to
  the Safe). The agent redeems `decreaseLiquidity` then `collect`, both `SingleDefault`. This
  must be **validated against the SDK's `allowedCalldata` builder** the same way the compound
  scope was — flagged, not assumed.
- **Why "agent, recipient pinned" is safe:** the agent can trigger a withdrawal, but the funds
  can only land in the Safe — non-custody holds. The residual risk is a compromised agent
  forcing an *unwanted full exit back to the Safe* (`decreaseLiquidity` is amount-unbounded);
  that is disruptive, not a theft. Bound it with a per-period/amount cap before production (see
  §7 and `FUTURE.md`).
- **Run — agent:** a new `run-withdraw.ts` mirroring `run-compound.ts` (load mandate from the
  plan JSON → find `tokenId` → `decreaseLiquidity` + `collect(recipient = Safe)` →
  `redeemDelegations`).
- **Run — manual:** same executions sent from the Safe App (delegate = Safe) via the
  `redeemDirect.ts` pattern.
- **To build:** `src/lib/withdrawDelegation.ts` (`buildWithdrawMandate`, mirroring
  `compoundDelegation.ts`, adding the `allowedCalldata` recipient pin), a
  `skills/hourglass-agent/scripts/run-withdraw.ts`, and a Yield-tab toggle to sign the withdraw
  mandate alongside the plan.

---

### 4.4 Discovery — how the delegate finds the delegation (the Intuition register) **[live for swaps]**

A redeem needs the signed delegation in hand. There are **two transports**, and today the
rails split across them:

- **The Intuition register (the pinner).** How the DCA/limit-order rail works. On signing, the
  **DelegationJson document** (the full signed delegation, caveats intact) is **pinned to IPFS**
  and **registered** on the Intuition knowledge graph as a nested triple:
  `(delegator Safe) —delegate to→ (agent)` and `(DelegationJson) —in context of→ (that triple)`.
  Write path: `publishDelegation` (`src/lib/intuition/publish.ts`) via the pinner
  (`createGraphqlPinner`, `src/lib/intuition/atoms.ts`). The agent then **discovers by its own
  address** — `discoverIncomingDelegations(agent, chainId)` (`src/lib/intuition/discover.ts`)
  queries the graph for `delegate to` triples where it is the object, fetches the pinned doc from
  IPFS, and reconstructs the signed delegation. The register *is* the source of truth for "who did
  the Safe delegate what to" — nothing is passed by hand.

- **The plan JSON.** How yield + compound work **today**. The signed delegations ride in the file
  the Yield tab downloads; `yield-agent.ts` / `run-compound.ts` read them directly — no publish,
  no graph. Dependency-free, but the operator must hand the file to the agent.

The `skills/hourglass-agent` skill is the operational vehicle and already carries the register
logic (`references/discovery.md` documents it; the runners inline it). Used inside HourGlass: the
**app writes** to the register on signing, the **skill's runner reads** it and redeems — the skill
has everything it needs to discover and redeem without a hand-passed file.

### 4.5 Making yield / compound / withdraw discoverable via the register (without breaking the plan JSON) **[design]**

Goal: let the agent discover *our* mandates the same way it discovers a limit order, while keeping
the plan-JSON path working. Three concrete gaps:

1. **Publish on signing (write path).** The Yield tab doesn't publish today — it only downloads the
   plan. Add a **best-effort** publish for the compound (and future withdraw) mandate: pin its
   DelegationJson document — the signed delegation **plus** the salt-verified `terms`, so
   mode/interval survive — and call `publishDelegation` with recipient = the agent. Best-effort
   because the Intuition **pin mutations are gated behind an API key** (`FUTURE.md`); when it's
   missing the plan JSON still works, so **nothing breaks**. When available, the mandate becomes
   discoverable by address.

2. **Recognize the mandate on read (`toStoredDelegation`).** This is the blocker. Discovery
   reconstructs a delegation by inspecting its **caveats**: `erc20PeriodTransfer` → spending-limit,
   `erc20Streaming` → stream, `erc20BalanceChange` → strategy, **else `null`** (dropped). Our
   compound/withdraw mandates carry none of those — they are `functionCall` over the PositionManager
   with a `redeemer` caveat — so **discovery silently drops them today.** Add a branch to
   `toStoredDelegation` that recognizes them (target = PositionManager; methods `collect` /
   `increaseLiquidity` for compound, `decreaseLiquidity` / `collect` for withdraw), tags the
   `scopeType`/kind, and carries the terms — mirroring the existing `findBalanceChangeCaveat`
   helpers with a `findFunctionCallMandate` that reads the whitelisted target + selectors.

3. **Dual-source discovery in the runner.** `run-compound.ts` (and a future `run-withdraw.ts`) try
   the register first — `discoverIncomingDelegations(agent, chainId)`, filtered to the
   compound/withdraw kind — and **fall back to the plan JSON** when nothing is published (or the pin
   key is absent). The plan JSON stays canonical; the register is an *added* path, not a
   replacement. That is exactly the "without breaking ours" constraint — the working flow is the
   fallback.

Net: the same **discover → redeem** shape as the swap rails, our `functionCall` mandates become
first-class in the register, and the plan JSON remains a zero-dependency fallback.

## 5. The continuous meter/sacar cycle

Once the deposit is minted and the compound + withdraw mandates are signed, the position runs
as a loop the delegate drives, all bounded on-chain:

```
        ┌─────────────────────────────────────────────┐
        │                 Safe (treasury)               │
        └───▲───────────────┬───────────────────▲───────┘
   collect  │  increaseLiq   │ mint / increaseLiq │ collect(recipient=Safe)
  (fees→Safe)│  (Safe→pos)   ▼                    │ (pos→Safe)
        ┌───┴───────────────────────────────────┴───────┐
        │           Uniswap v3 position (held by Safe)   │
        └───────────────────────────────────────────────┘
     compound (4.2): add fees back        withdraw (4.3): pull liquidity out
```

- **Meter:** deposit mints the position; compound reinvests fees into it — principal grows,
  never leaves.
- **Sacar:** withdraw pulls liquidity out, always back **to the Safe**.
- The agent can add and remove continuously; the invariant "money only ever ends up in the
  Safe" holds at every step because the only outward-moving call (`collect`) is recipient-pinned
  to the Safe.

---

## 6. Security model (the invariants a reviewer checks)

- **Delegate binding + `redeemer`.** Only the named delegate can redeem; enforced twice
  (`DelegationManager` `msg.sender` + the `redeemer` caveat).
- **Method whitelist.** Each mandate's `functionCall` scope lists only the methods it needs.
  Compound cannot `decreaseLiquidity`/`burn`; withdraw cannot `mint` or move to a non-Safe
  address.
- **Recipient pin (withdraw).** `collect`'s recipient is pinned to the Safe via
  `allowedCalldata` — the non-custody guarantee for the *sacar* side.
- **`exactExecution` (deposit).** The mint path is byte-for-byte fixed at signing.
- **Bounded approval (compound).** The Enable-compounding allowance caps how much the agent can
  ever pull into the position.
- **Salt binding.** Each mandate's salt = `keccak256(terms)`; the human terms travel in the
  plan JSON and are verified against the salt at run time, so a tampered plan is rejected.
- **Known gaps → `FUTURE.md`:** `increaseLiquidity` (compound) and `decreaseLiquidity`
  (withdraw) are amount-unbounded; the pre-prod hardening is a per-period `erc20BalanceChange`
  cap on the Safe balance (deferred: the SDK builder rejects `balance <= 0n`).

---

## 7. What exists vs what's to build

| Piece | Deposit | Compound | Withdraw |
|---|---|---|---|
| Build (delegation) | `yieldDelegations.ts` **[live]** | `compoundDelegation.ts` **[live]** | `withdrawDelegation.ts` **[design]** |
| Setup approval | in the 3 delegations **[live]** | `compoundApproval.ts` **[live]** | reuse Enable-compounding / add withdraw allowance **[design]** |
| Redeem — agent | `scripts/yield-agent.ts` **[live]** | `run-compound.ts` **[live]** | `run-withdraw.ts` **[design]** |
| Redeem — manual | `redeemDirect.ts` pattern **[live]** | `redeemDirect.ts` pattern **[live]** | `redeemDirect.ts` pattern **[design]** |
| Skill doc | — | `references/execution-compound.md` **[live]** | `references/execution-withdraw.md` **[design]** |

---

## 8. End-to-end test (Base Sepolia, small amount)

Proves the loop against the chain, not just on paper.

1. **Fund** a Safe on Base Sepolia with a little of both pool tokens + ETH; fund the agent
   wallet (`AGENT_PRIVATE_KEY`) with a little ETH for gas.
2. **Sign** the plan in the Yield tab (deposit + auto-compound). Download the plan JSON.
3. **Enable compounding** (one bounded Safe tx) so `increaseLiquidity` can pull fees.
4. **Deposit:** `bun scripts/yield-agent.ts <plan.json>` → verify the position NFT is minted to
   the Safe (BaseScan).
5. **Compound:** generate fees (swaps against the pool from another wallet), then
   `MAX_POLLS=1 bun skills/hourglass-agent/scripts/run-compound.ts <plan.json>` → verify
   `liquidity` rose, `tokensOwed` reset, gas paid by the agent (not the Safe), principal
   untouched.
6. **Withdraw [design]:** once built, `run-withdraw.ts` → verify liquidity dropped and the
   tokens landed **in the Safe** (never the agent).

A fresh position with no accrued fees correctly reports **"waiting"** — that is a valid smoke
test of the whole pipeline (discover → find tokenId → decide), not a failure.

---

## 9. Open decisions

- **Withdraw authority:** confirmed **agent with recipient pinned to the Safe** — the delegation
  grants only the movement; funds can only return to the treasury.
- **Amount bound on withdraw/compound:** per-period cap deferred to pre-prod (`FUTURE.md`),
  pending the SDK `erc20BalanceChange` `<= 0n` fix.
- **`allowedCalldata` recipient pin:** validate the two-delegation split against the SDK builder
  before implementing the withdraw mandate.
- **Register vs plan JSON:** decision to make our mandates **discoverable via the Intuition
  register** (like the swap rails) while keeping the plan JSON as the zero-dependency fallback
  (§4.5). The one hard prerequisite is extending `toStoredDelegation` to recognize `functionCall`
  mandates — without it, discovery drops them silently. Publishing is gated on the Intuition pin
  API key (`FUTURE.md`); until it lands, the plan JSON is the transport.
- **Coordinate the merge:** wiring publish-on-sign + the `toStoredDelegation` branch touches shared
  Intuition files (`src/lib/intuition/*`) the DCA/limit-order rail owns — sequence it with the
  colleague, like the skill/`uniswap.ts` merges.
