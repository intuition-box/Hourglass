# Execution — auto-compound (harvest an LP position and reinvest)

Auto-compound is **not a swap**. It operates an existing Uniswap v3 position the Safe
already holds: harvest the position's accrued fees and add them straight back into the
**same** position. The agent decides *when* it pays to do this (gas vs. the extra yield
the reinvested fees earn), then redeems two calls as the Safe. It never withdraws
principal.

## What the mandate authorises

The compound mandate is **one delegation** with a `functionCall` scope over the Uniswap
v3 **PositionManager**, whitelisting exactly two methods:

- `collect((uint256,address,uint128,uint128))` — harvest the position's fees to the Safe.
- `increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))` — add the
  harvested tokens back into the same position.

Plus a **`redeemer`** caveat locking redemption to your agent wallet, and an optional
**`timestamp`** caveat (validity window). There is **no** `decreaseLiquidity`/`burn` in
scope, so the agent **cannot withdraw the principal** — only harvest and re-add. Unlike
a DCA/limit-order swap there is no `erc20BalanceChange` bound and no `limitedCalls`:
compounding is a repeatable, standing mandate.

## Where the mandate comes from (differs from DCA/limit orders)

Compound mandates are **not published on Intuition**. They travel inside the **yield
plan JSON** the Safe downloads from the Yield tab (the same file `scripts/yield-agent.ts`
consumes), under a `compound` field. So you do **not** run the Intuition discovery step
here — you pass the plan file directly. The runner:

- verifies the mandate signature and recomputes its `delegationHash`;
- reads `mode` (agent | manual) and, for manual, `intervalDays` from the plan's
  **salt-verified `compound.terms`** — `hashCompoundTerms(terms)` must equal the signed
  delegation salt, so a tampered plan is rejected. No env var configures the interval.

## Prerequisite — "Enable compounding" is set up on the Safe (one-time, not your job)

`increaseLiquidity` pulls both pool tokens **from the Safe** via `transferFrom`, so the
Safe must already hold a standing ERC-20 allowance to the PositionManager for both
tokens. The **operator** does this once via the Yield tab's **"Enable compounding"**
button (a single batched Safe tx). It is **bounded** (capped at the deposit, not
infinite), so it may need topping up over a long-running position — the runner reports a
`blocked` outcome with instructions when the allowance is short. It is **not** part of
your redeem; the mandate authorises the calls, the allowance lets them move tokens.

## The decision (the valuable part)

Compounding only pays when the extra yield the reinvested fees earn over the remaining
horizon beats the gas of doing it. The runner uses the **same optimizer the app card
shows** (`projectAgentOptimal`): it targets the compound interval that maximises return
after gas — never greedily, never at a loss, and at least as good as any fixed schedule.
In **manual** mode it follows the operator's interval from the terms instead. Gas is
read **live** at run time (unlike the card's forecast estimate).

## The loop

1. **Load** the mandate + terms from the plan JSON (no Intuition step). Verify the
   signature and the terms↔salt binding.
2. **Find the position**: enumerate the Safe's PositionManager tokens
   (`balanceOf` + `tokenOfOwnerByIndex`), match the plan's pool (token0/token1/fee) with
   `liquidity > 0`. "No position yet" is a logged retry, not a failure — the yield agent
   may not have minted it.
3. **Read economics**: position value, accrued fees (a simulated `collect`), observed
   APR, live gas.
4. **Decide** with `projectAgentOptimal` (agent) or the operator interval (manual). If
   not due, wait and re-poll.
5. **Compound**: `collect(tokenId, recipient = Safe, max, max)` then
   `increaseLiquidity(tokenId, fees0, fees1, 0, 0, deadline)` — two `SingleDefault`
   entries in **one** `redeemDelegations`, executed as the Safe. Preflight with a
   `call` before sending; a revert is retried under a circuit breaker.
6. **Repeat.** The mandate is standing; a second compound in the same period simply
   harvests less. Stop conditions are `MAX_POLLS` / the circuit breaker.

## The bundled runner

`scripts/run-compound.ts` does load + find + decide + compound end to end. It takes the
**yield plan JSON** (not an Intuition recap):

```bash
MAX_POLLS=1 bun scripts/run-compound.ts <path-to-yield-plan.json>
```

Env: `AGENT_PRIVATE_KEY`, optional `RPC_URL`, optional `POLL_SECONDS` (default 3600),
optional `MAX_POLLS` (0 = run forever), optional `MAX_REVERTS` (default 5), optional
`APR_OVERRIDE` (annual fraction, skips the observed-APR warm-up), and
`ETH_PRICE_IN_QUOTE` (required only when neither pool token is WETH — used to price gas
in the pool's quote token). Mode and interval come from the plan's salt-verified terms,
so there is **no** `COMPOUND_INTERVAL_DAYS`.

```
Example (freshly minted position, no fees yet):
  position 12345 found — 0 fees accrued
  waiting: nothing to compound yet
Example (fees accrued, due):
  compounding: collected 4.12 USDC + 0.0011 WETH — reinvesting
  redeemed: 0x9f2c… — liquidity increased
```
