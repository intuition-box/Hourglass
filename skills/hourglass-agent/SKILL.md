---
name: hourglass-agent
description: Set up and run an autonomous agent for a Hourglass strategy mandate — a recurring DCA buy, a single price-triggered limit order (buy-the-dip), or auto-compounding a yield position (harvest fees and reinvest). Use this whenever a user wants to operate the agent side of a Hourglass Safe strategy — creating the agent wallet, funding its gas, discovering the delegation the Safe signed (or loading the yield plan), and executing the swap or compound. Trigger it whenever the user mentions Hourglass, a strategy mandate, a limit order, a yield/LP position to compound, a Safe delegation to redeem, "run my DCA agent", "run my limit order", "run my compound agent", "auto-compound my position", "set up the agent for my Safe", an agent address to paste into Hourglass, or executing a delegated swap or compound on behalf of a Safe — even if they don't name Hourglass explicitly but describe an agent redeeming a Safe's delegation to DCA, buy a dip, or harvest-and-reinvest LP fees.
compatibility: bun or node ≥ 20, foundry (cast), the uniswap swap-integration skill, network access to the Intuition graph and the Uniswap Trading API.
---

# Hourglass agent

Run the agent side of a Hourglass strategy. A Safe (a DAO/company treasury) signs
**one** delegation — the *mandate* — that lets a named agent swap on the Safe's
behalf, bounded on-chain by a per-swap cap. **You operate that agent.** Hourglass
never holds your keys and never runs the agent for you: you create a wallet, give
its address to the Safe operator, and this skill drives the recurring buy.

Mental model — read `references/context.md` first if any of this is unclear:

- **Non-custodial.** The agent holds nothing. Funds never leave the Safe except
  into the swap; the bought token returns to the Safe. The agent only *triggers*
  the swap (and pays the gas), executing it *as the Safe* via the delegation.
- **Bounded by consensus.** The mandate's `erc20BalanceChange` caveat caps the
  loss per swap. Even a buggy or compromised agent cannot spend more than the cap,
  touch another contract, or drain the Safe. The strategy (amount, cadence) is your
  instruction; the cap is the on-chain guarantee.
- **Your one job the chain can't do for you: hold a funded key.** Redeeming a
  delegation is a real transaction that costs gas. So the agent needs a wallet with
  a little native ETH. That is the *only* value the agent custodies — gas, not the
  treasury.

## The handoff (agent ⇄ operator)

This skill drives the agent, but signing the mandate is the operator's job in the Safe
App — so the flow hands back and forth once. The whole loop, from the operator's seat:

1. **Load this skill.** The agent sets up its wallet and reports back its **address**
   (steps 1–3 below). You fund that address with a little gas.
2. **You open the Safe App**, paste the agent address, create the delegation (Strategy
   or Limit order tab), and sign it — a multisig Safe needs its threshold of signers.
   The publisher backend then publishes the finalized mandate on Intuition. For a limit
   order, the tab first asks you to **Enable trading** for the funding token — a one-time
   Permit2 setup (one batched Safe tx) the router needs to pull the token; without it the
   agent's swap reverts with `AllowanceExpired`. Signed once per token, reused forever.
3. **You come back to this skill** with the recap JSON the tab emitted. The agent
   discovers the mandate on Intuition and executes it (steps 5–6).

The agent does **not** run unattended between sessions — there is no built-in
scheduler. A limit order polls the price for as long as the run is alive and fills once
the dip hits; a DCA fires once per invocation. To keep watching, keep the run alive or
wire it to a scheduler you own (cron, a runtime wake). Re-loading the skill resumes from
discovery — the mandate lives on Intuition, not in this session.

## Quick start checklist

You (the agent) run every step here yourself, via the shell — steps 4 and the funding
in 3 are the only human actions. Everything the runner needs is bundled in `scripts/`.

1. **Install dependencies.** The runners are a self-contained package in `scripts/`:
   ```bash
   cd scripts && bun install    # or: npm install
   ```
   You also need a **Uniswap Trading API key** (`UNISWAP_API_KEY`) — the operator gives
   it to you, or get one from **https://hub.uniswap.org/** (walkthrough in
   `references/setup.md`). It is agent-side only; never ship it to a browser.
2. **Create the agent wallet.** Generate a fresh keypair, write the private key to a
   local `.env` (`AGENT_PRIVATE_KEY=…`, never commit it), and record the **address**.
   `cast wallet new`, or the viem snippet in `references/setup.md`.
3. **Report the address and ask the operator to fund it.** Print the agent address and
   ask the human to send a little ETH for gas on the mandate's chain (Base / Ethereum
   mainnet) — the agent does not self-fund. Verify the balance is non-zero before running.
4. **Operator creates the mandate (their only app step).** They paste your address into
   Hourglass (Strategy tab for a DCA, Limit order tab for a limit order). For a limit
   order they first click **Enable trading** (a one-time Permit2 setup, one Safe tx),
   then sign the mandate — a multisig Safe needs its signing threshold. Once finalized it
   publishes to Intuition. They hand you back the **recap JSON** (names the mandate by
   `delegationHash`). Save it as `scripts/instruction.json`.
5. **Run the bundled runner — it discovers and executes autonomously.** From `scripts/`,
   with the env set (`AGENT_PRIVATE_KEY`, `UNISWAP_API_KEY`, `INTUITION_NETWORK=mainnet`,
   optional `RPC_URL`):
   ```bash
   bun run-limit-order.ts instruction.json      # limit order: polls, fills once at the dip
   bun run-dca.ts instruction.json              # DCA: buys once per invocation
   ```
   The runner matches the mandate by `delegationHash`, polls the Uniswap quote against
   the enforced `minReceived`, and redeems the swap as the Safe when the trigger hits —
   then exits (a limit order fires once; `limitedCalls(1)`). If it prints *"not found on
   Intuition yet"*, the mandate isn't published (threshold/indexing lag) — wait and retry.
   If a fill reverts with `AllowanceExpired`, the operator skipped the Permit2 **Enable
   trading** step — ask them to run it. Details: `references/execution-limit-order.md`
   (limit order) and `references/execution-dca.md` (DCA).

To keep watching after a session ends, keep the runner process alive or wire it to a
scheduler you own (cron, a runtime wake) — the skill does not run one. Re-running the
runner with the same `instruction.json` resumes from discovery; the mandate lives on
Intuition, not in this session.

## What you need from the operator / environment

| Value | Where it comes from | Notes |
|---|---|---|
| `AGENT_PRIVATE_KEY` | the wallet you created in step 2 | secret, gas only, never commit |
| `UNISWAP_API_KEY` | Uniswap developer portal | agent-side only |
| chain id | the mandate's chain (Base 8453 / Ethereum 1) | mainnet — the router + liquidity live there |
| `INTUITION_NETWORK` | `mainnet` for a mainnet mandate | which graph to discover on |
| `RPC_URL` (optional) | your RPC provider | defaults to a public RPC |

## Hard rules (the chain enforces the last two — respect the first two so you don't waste gas)

- **CLASSIC routing only.** Request `routingPreference: "CLASSIC"` from the Trading
  API so the swap is a router `execute(...)` tx the delegation can redeem. A gasless
  UniswapX order has no on-chain tx to redeem and cannot be bounded — reject it.
- **Legacy approval, never Permit2.** Approve the funding token directly to the
  Universal Router. The mandate whitelists `approve` on the token + `execute` on the
  router; a Permit2 flow targets a contract the mandate does not allow and needs a
  signature the Safe can't give — it reverts.
- **One swap per redeem entry.** The mandate's `functionCall` enforcers only accept
  a single-call execution, so approve and swap are two `SingleDefault` entries in one
  `redeemDelegations` call — not a batch execution (which reverts).
- **The cap is the ceiling.** Never try to swap more than the per-swap cap; the
  `erc20BalanceChange` enforcer reverts the redeem if you do. Simulate before sending.

## Strategy variants

Discovery is **type-agnostic**: it returns every delegation addressed to the agent,
each tagged with a `scopeType`, and strategy mandates carry a `strategyKind`. This
skill details two:

- **DCA** (`strategyKind: 'dca'`) — a recurring buy. One Decrease bound (the per-swap
  spend cap); the agent re-runs on the operator's cadence. See `references/execution-dca.md`
  and `scripts/run-dca.ts`.
- **Limit order** (`strategyKind: 'limitOrder'`) — a single price-triggered buy. Two
  bounds (Decrease spend + Increase min-received = the price trigger) plus a
  `limitedCalls(1)` cap. The agent polls the price and fills once. See
  `references/execution-limit-order.md` and `scripts/run-limit-order.ts`.

**The `limitedCalls` caveat is the discriminator** between the two swap strategies: a
mandate that has one is a limit order, otherwise a DCA. Both discover and redeem the
same way — the only differences are when the agent fires and whether it repeats.

There is also a non-swap variant:

- **Auto-compound** (`compound.terms.mode`: `agent | manual`) — harvest an LP position's
  fees and reinvest them into the **same** position. Not a swap: a `functionCall` mandate
  over the Uniswap v3 PositionManager (`collect` + `increaseLiquidity` only — no principal
  withdrawal), redeemer-locked. It does **not** come from Intuition — it rides inside the
  **yield plan JSON** (like `scripts/yield-agent.ts`), with salt-verified `terms` carrying
  the mode/interval. Needs a one-time **Enable compounding** approval on the Safe. The
  agent compounds only when the extra yield beats the gas (`projectAgentOptimal`). See
  `references/execution-compound.md` and `scripts/run-compound.ts`.

Hourglass supports further delegation types: the **yield mint** itself
(`exactExecution`, a fixed-calldata replay) is driven by `scripts/yield-agent.ts`;
subscriptions and streams (`erc20PeriodTransfer` / `erc20Streaming`, a `transfer`
redeem) are not yet wired into this skill. They follow the same shape: **discover (or
load the plan) → route on `scopeType` / `strategyKind` → execute**. When those are
stabilized, add a branch here and a matching `references/<type>.md`; the discover and
redeem layers are already generic.

## Reference files

- `references/context.md` — the Safe + delegation model, non-custodial guarantees,
  what the agent can and cannot do. Read first.
- `references/setup.md` — wallet creation, funding, the one-time dependencies.
- `references/discovery.md` — reading the mandate from the Intuition graph.
- `references/execution-dca.md` — building the swap and redeeming it atomically for a
  DCA, plus configuring and running `scripts/run-dca.ts`.
- `references/execution-limit-order.md` — the same, for a single price-triggered limit
  order (poll → fill once), plus `scripts/run-limit-order.ts`.
- `references/execution-compound.md` — harvesting an LP position's fees and reinvesting
  them (gas-aware, agent | manual), driven from the yield plan JSON, plus
  `scripts/run-compound.ts`.
