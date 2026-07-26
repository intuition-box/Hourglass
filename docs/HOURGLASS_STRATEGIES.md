# Hourglass — strategy execution rails via delegation

> Research / design. How to bound an autonomous agent that runs investment
> strategies (Uniswap) through the caveat enforcers of the MetaMask Delegation
> Framework — with no custody and no shared private key.
>
> Project: [intuition-box/Hourglass](https://github.com/intuition-box/Hourglass).
> Reuses OurGlass's signing / pin / salt infrastructure.
>
> **Status of claims:** the enforcer semantics below were verified against the
> installed SDK (`@metamask/smart-accounts-kit@0.3.0`) and the on-chain Solidity
> (`metamask/delegation-framework`, `pragma 0.8.23`). Verified points are marked
> ✅; residual unknowns are called out in §7.

## 1. Thesis

Caveat enforcers **do not encode** a strategy — they **bound** it. The logic
("when to buy, how much, which asset") lives in the agent (exactly like the
Uniswap DCA / copy-trade / index bots, which are just off-chain logic on top of
one shared execution engine). What the Delegation Framework adds is the layer no
one has cleanly built: **a risk envelope, verified on-chain, that an operator
grants to an agent.**

Hourglass's product is therefore not "an agent that trades" but **a composable
mandate primitive**:

> The operator signs *one* delegation that says "this agent may move these funds,
> only through these contracts, only for this effect, within this window, up to
> this cap" — and the agent runs without ever holding the keys or being able to
> overstep.

Tagline: **"Strategies are software. Guardrails are consensus."**

### What the mandate guarantees / does not guarantee

- **Guarantees** (operational downside): no drain, no unauthorized contract, no
  execution outside the window, no cap overrun.
- **Does not guarantee**: that the strategy is *good*. The mandate bounds
  operational risk, not market risk.

## 2. Non-custodial model

The agent holds nothing. It can **only** `redeem` an already-bounded delegation.
The non-custodial / no-PK property comes from there: all authority lives in the
caveats the operator signs once.

Two composable layers:

| Layer | Role | Aggregates over time? |
|---|---|---|
| **Funding rail** | How much the vault releases | Yes (`erc20PeriodTransfer` / `multiTokenPeriod`) |
| **Execution rail** | What the agent can do with those funds | No (bounded per redemption) |

## 3. Verified enforcer semantics

Source: on-chain Solidity in `metamask/delegation-framework` (verified), cross-checked against
[MetaMask docs — Caveat enforcers](https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats).

### BalanceChange — the central guardrail (an *intent* enforcer)

`BalanceChange` constrains the **result** of an action, not the means. It is a
declarative *intent* enforcer: "however you get there, the balance must have
moved by at most / at least X." This is the opposite of a means enforcer
(`allowedTargets`, `exactCalldata`), which pins *how* the call is made.

✅ Verified against `ERC20BalanceChangeEnforcer.sol`:

- **`enforceDecrease = true` (Decrease)** → `balance ≥ cached − amount` → the
  balance may not drop by more than `amount` → a **spend cap**.
- **`enforceDecrease = false` (Increase)** → `balance ≥ cached + amount` → the
  balance must rise by at least `amount` → a **slippage floor**.
- The `recipient` is an **arbitrary address** in the terms (bytes 21–40), not
  necessarily the delegator. The enforcer reads `balanceOf(recipient)`. So we can
  bound the effect on the vault *or* on the agent's operating account.
- Hooks run before/after the **same** execution (see §6), so the snapshot is
  taken just before the action and validated just after.

This is the design pivot: for a dynamically routed Uniswap swap we **cannot pin
the calldata**, so we **bound the balance delta** instead. The agent composes
whatever swap it wants; it simply cannot make the vault lose more than the cap
(nor, if we add the floor, receive less than the minimum).

### Other enforcers used in the rails

| Enforcer | Semantics | Terms |
|---|---|---|
| `erc20PeriodTransfer` ✅ | Per-period cap, **resets with no carry-over** of the surplus | `tokenAddress`, `periodAmount`, `periodDuration`, `startDate` |
| `erc20Streaming` ✅ | Releases `initialAmount` at start, then linear accrual `amountPerSecond` up to `maxAmount` | as above + `initialAmount`, `maxAmount`, `amountPerSecond`, `startTime` |
| `multiTokenPeriod` ✅ | Multi-token periodic caps in **one** enforcer; **requires `args` at redeem** = index of the token config (`uint256` hex). *Out of scope for now.* | `tokenConfigs[]` |
| `functionCall` (scope) ✅ | Compiles into `allowedTargets` + `allowedMethods` (+ optional `allowedCalldata` / `valueLte`) | `targets`, `selectors`, opt. `allowedCalldata`, `valueLte` |
| `valueLte` ✅ | Cap on native `value` per redemption. **v0.3.0: `functionCall` allows 0 value by default** — add `valueLte` to permit ETH | `maxValue` |
| `limitedCalls` ✅ | Max number of redemptions | `limit` |
| `timestamp` ✅ | Validity window | `afterThreshold`, `beforeThreshold` (0 = disabled) |
| `redeemer` ✅ | Addresses allowed to redeem. **Documented flaw** (verified in-contract): a re-delegatable delegator can bypass by re-delegating | `redeemers[]` |
| `allowedCalldata` ✅ | Pins a calldata slice. **Static types only** (dynamic ones "tedious and error-prone") | `startIndex`, `value` |

## 4. The rails

### Common chassis

The mandatory floor for **any** strategy is small:

```
scope: functionCall   → locks the call surface (which contracts + which selectors)
erc20BalanceChange    → bounds the per-redemption loss (the real drain guard)
valueLte → 0n         → no native value unless the strategy needs ETH
```

`functionCall` + `BalanceChange` together are the security core: the agent can
only call the whitelisted contracts/methods, and can never make the vault lose
more than the cap on any single redemption. Funds never leave the Safe (the swap
executes *as* the Safe), so this is non-custodial by construction.

**Optional bounds — a deliberate risk posture, not a default:**

```
timestamp    → auto-expiry kill-switch (afterThreshold, beforeThreshold)
limitedCalls → cap on the TOTAL number of redemptions
redeemer     → restrict who can redeem (⚠️ bypassable, not a trust boundary)
```

For a **reactive agent**, `limitedCalls` and `timestamp` are intentionally
**omitted** — they cap *volume* and *duration*, not latency, but an agent that
must react freely should not be throttled by a call ceiling or a short deadline.
The trade-off is explicit: with neither, the mandate is **open-ended in count and
time**, revocable only by the multisig (`disableDelegation`). The multisig *is*
the kill-switch; the per-redemption `BalanceChange` cap plus the locked call
surface remain the standing guarantees regardless.

### Rail A — spot (covers DCA + copy-trade + index-spot)

The three bots share **the same execution surface** (`UniversalRouter.execute` +
`approve`). One rail. This is the canonical Hourglass mandate.

```
one delegation. delegator = Safe (multisig). delegate = agent (redeem only).

scope: functionCall
  targets:   [fundingToken, UNIVERSAL_ROUTER]     // approve the router (legacy path, smart-account friendly)
  selectors: ['approve(address,uint256)',         // 0x095ea7b3
              'execute(bytes,bytes[],uint256)']    // 0x3593564c
caveats:
  erc20BalanceChange
    tokenAddress: fundingToken
    recipient:    Safe
    changeType:   Decrease
    balance:      cap_per_run                       // max loss per swap — the security guarantee
  valueLte → 0n
```

**Non-custodial by construction.** The agent redeems; the swap executes *as the
Safe*; USDC leaves the Safe only into the swap and the bought token returns to the
Safe. The agent never holds funds — it only moves them under the caveat.

**Why `BalanceChange` and not a period cap.** A DCA execution is a *swap*
(`approve` + `UniversalRouter.execute`), not a `transfer`. Verified in
`ERC20PeriodTransferEnforcer.sol`: the period/streaming enforcers `require` the
execution to be a literal `IERC20.transfer(address,uint256)` (`callData.length ==
68`, `target == token`, `selector == transfer.selector`) and read the amount from
`callData[36:68]` — they **revert** on a swap. Only `BalanceChange` is
execution-shape-agnostic (it measures `balanceOf` before/after), so it is the
**only** enforcer that can bound a swap. A weekly cumulative cap is therefore not
available on the swap delegation (there is no "period balance-change" enforcer,
§7); the cadence lives in the agent.

**Optional slippage floor.** A second `erc20BalanceChange` with
`changeType=Increase` on the bought token pins a minimum output. Stacking the two
is **SAFE** ✅ — the enforcer's storage key is `keccak256(msg.sender, token,
delegationHash)`, so two caveats on **different tokens** get independent slots
(see §6). The floor is an execution-quality nicety, not a security guarantee — the
agent can also set the router's `amountOutMinimum`. Ship with the single `Decrease`
caveat unless the floor is worth the extra surface.

### Rail B — LP (create / increase / decrease / claim fees)

Wider surface: PositionManager + PoolManager (v4) + Permit2, two tokens.

```
scope: functionCall
  targets:   [token0, token1, POSITION_MANAGER, PERMIT2, POOL_MANAGER(v4)]
  selectors: ['approve(address,uint256)',
              'multicall(bytes[])',                 // create / increase / decrease
              'collect(...)']                       // claim fees
caveats (+ chassis):
  erc20BalanceChange × 2   → one per leg (token0 ↓ bounded, token1 ↓ bounded)
  // claim-only: a single BalanceChange changeType=Increase on the fees token
```

The two legs target **distinct tokens** (token0, token1), so the two
BalanceChange caveats are independent and safe by the same rule.

### The on-chain weekly-cap trade-off (verified)

A per-week cumulative cap on a **swapping** agent is not achievable on-chain while
keeping funds in the Safe. The reason is structural, verified in-contract:

- Every period/cumulative-cap enforcer (`erc20PeriodTransfer`, `erc20Streaming`,
  `multiTokenPeriod`) accepts **only** a literal `transfer` and reverts on a swap.
- Every balance-delta enforcer (`erc20BalanceChange` …) is **per-redemption**,
  with no time-window accumulation. There is no "period balance-change" enforcer.
- A `transfer(Safe, x)` self-transfer is a no-op that gates nothing (the agent
  could swap the Safe's balance without ever redeeming it).

So a real weekly cap forces the funds through an **intermediary account X ≠ Safe**
(a funding-rail `transfer` capped by `erc20PeriodTransfer`, then a swap whose
delegator is X). That reintroduces transient custody in X. **Weekly-cap-on-chain
and strict-non-custodial are mutually exclusive with the current enforcers.**
Hourglass chooses non-custodial: the swap rail uses `BalanceChange` only, and the
cadence lives in the agent.

## 5. Enforcer → role table (verified)

| Enforcer | Bounds | Accepted execution shape | Belongs to rail |
|---|---|---|---|
| `erc20BalanceChange` (Decrease) | max loss **per redemption** (balance delta) | **any** (swap included) — shape-agnostic | **Execution / swap** |
| `erc20BalanceChange` (Increase) | min gain per redemption (slippage floor) | any | Execution (optional) |
| `erc20PeriodTransfer` | cumulative amount **per period** | `transfer(addr,uint)` **only** — reverts on a swap | Funding (recurring transfer, not swap) |
| `erc20Streaming` | linear accrual over time | `transfer` only — reverts on a swap | Funding |
| `functionCall` (scope) | which contracts + methods are callable | defines the call surface | All (chassis) |
| `valueLte` | max native `value` per redemption | — | Chassis |
| `limitedCalls` | max number of redemptions (total) | — | Optional bound |
| `timestamp` | validity window (auto-expiry) | — | Optional bound |
| `redeemer` | who may redeem (⚠️ bypassable) | — | Optional (not a trust boundary) |

## 5b. Strategy → enforcers that match

| Strategy | On-chain enforcers | Custody |
|---|---|---|
| **DCA** (swap USDC→WETH) | `functionCall` + `BalanceChange(Decrease)` | ✅ non-custodial |
| **Copy-trade / Index spot** | same as DCA (shared Rail A) | ✅ non-custodial |
| **LP** (two tokens) | `functionCall` + `BalanceChange × 2` (one per distinct token) | ✅ non-custodial |
| **Recurring transfer** (transfer, no swap) | `erc20PeriodTransfer` alone | ✅ non-custodial (this is OurGlass) |
| **Weekly-capped DCA on-chain** | funding `erc20PeriodTransfer` + swap `BalanceChange` | ⚠️ intermediary X holds the weekly budget transiently |
| **Custom v4 hook** (yield-on-idle…) | outside the delegation model: CREATE2 deploy + admin keys | n/a |

**Two hard rules that govern the whole table:**
1. **Swap ⟹ `BalanceChange` is mandatory.** Period/streaming enforcers reject a
   swap (they require literal `transfer` calldata).
2. **Cumulative period cap ⟹ a `transfer` (funds leave the Safe).** There is no
   period-balance enforcer, so an on-chain weekly cap costs the non-custodial
   property.

## 6. Composition & authority attenuation

- Multiple enforcers attach to **one** delegation via
  `createDelegation({ scope, caveats })` or
  `createCaveatBuilder(env).addCaveat(...).build()`. **All** hooks must pass at
  redeem (verified: all `beforeHook`s run → one execution → all `afterHook`s run).
- On a **re-delegation chain**, caveats can only **tighten** (authority ≤ parent).
  This enables the **operator → chief-agent → sub-strategy-agents** model, each
  inheriting a mandate ≤ its parent. A good governance demo argument.

### BalanceChange stacking rule (verified)

The `ERC20BalanceChangeEnforcer` storage key is
`keccak256(msg.sender, token, delegationHash)` — it does **not** include
`recipient` or `amount`. Therefore:

- **Different tokens per caveat → SAFE.** Independent slots, each snapshot and
  delta validated on its own token. (This is exactly Rail A and Rail B.)
- **Two caveats on the SAME token in one delegation → UNSAFE.** They collapse to
  the same slot; the second `beforeHook` hits `require(!isLocked[...])` and
  **reverts** (`enforcer-is-locked`). It fails loudly, not silently — but it will
  not work. The contract's own Security Notice warns against tracking the same
  recipient/token across multiple enforcers.

**Rule of thumb: one BalanceChange caveat per token per delegation.**

## 7. Limits & points still to verify on testnet

1. **No "period balance-change."** There is no on-chain cumulative per-week cap on
   a swapping agent (§5). Options are: cap the loss *per swap* with `BalanceChange`
   (chosen — non-custodial, cadence in the agent), or move to a funding-rail
   `erc20PeriodTransfer` (weekly cap, but funds transit an intermediary). For a
   **reactive agent** Hourglass drops `limitedCalls`/`timestamp` entirely: the
   mandate is open-ended in count and time, the standing guards are `BalanceChange`
   + `functionCall`, and the multisig is the kill-switch (`disableDelegation`).
   Own this posture in the pitch.
2. ~~Stacking multiple `BalanceChange` is undocumented~~ → **resolved** (§6):
   safe for distinct tokens, reverts for same-token. No residual risk here.
3. **`redeemer` is bypassable** by an agent that is itself delegatable (verified
   in-contract) → do not make it the trust boundary; rely on `BalanceChange` +
   `allowedTargets`.
4. **Per-chain addresses** (Universal Router, PositionManager, PoolManager): live
   in the Uniswap parent plugin's `references/chains.md`, **not vendored** here —
   fetch before the POC. Deployed enforcers: see
   [`src/config/addresses.ts`](../src/config/addresses.ts).

## 8. Demo slice (hackathon)

Do not aim for all six strategies. Show **the mandate + one strategy** end to end:

> The operator signs a DCA mandate → the DCA agent (wired to `swap-integration`)
> redeems several times → an out-of-envelope attempt (another contract, or a delta
> over the cap) that **reverts** on-chain.

The filmed revert proves the thesis: *the strategy lives in the agent, security
lives in the caveat.*

Next action: build `buildSpotStrategyDelegation()` (Rail A) reusing the repo's
`createDelegation` call. The BalanceChange stacking question is now settled, so
Rail A can ship with the Decrease cap (and, on distinct tokens, the optional
Increase floor).

## Sources

- [Caveat enforcers — reference](https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats)
- On-chain Solidity: `metamask/delegation-framework` — `src/enforcers/ERC20BalanceChangeEnforcer.sol`,
  `RedeemerEnforcer.sol`, `src/DelegationManager.sol` (verified `pragma 0.8.23`)
- Installed SDK: `@metamask/smart-accounts-kit@0.3.0` (`CoreCaveatMap`, scope configs)
- Vendored skills: `.claude/skills/mms-smart-accounts-kit/references/delegations.md`,
  `.claude/skills/mms-gator-cli/SKILL.md`
- Uniswap skills: `swap-integration`, `lp-integration`, `v4-sdk-integration`,
  `dca-bot`, `copy-trade`, `index-bot` (in `~/.claude/skills/`)
- `erc20PeriodTransfer` usage in this repo: `src/pages/CreateDelegation.tsx`,
  `src/lib/periodState.ts`, `src/lib/redeemDirect.ts`
