# Hourglass — arbitrage rail via delegation

> Research / design. How to let an autonomous agent run **intra-Uniswap
> arbitrage** on a treasury through the MetaMask Delegation Framework — with no
> custody and no shared private key. The agent finds the opportunity; the caveat
> guarantees the vault can only end **richer**.
>
> Scope of this doc: **intra-Uniswap arbitrage** (both legs route through the
> Universal Router in a single atomic `execute`). Cross-DEX / multi-venue arb is
> explicitly out of scope here (see §9).
>
> Companion docs: [`HOURGLASS_STRATEGIES.md`](HOURGLASS_STRATEGIES.md) (verified
> enforcer semantics), [`STRATEGY_IMPLEMENTATION_PLAN.md`](STRATEGY_IMPLEMENTATION_PLAN.md)
> (the build map for the Strategy rail this reuses).
>
> **Repo note:** the arbitrage rail's real home is the strategy repo (the one with
> `src/config/uniswap.ts` and the yield/strategy rail), where this doc does **not**
> exist yet and Permit2 is absent. The claims below were reconciled against that
> codebase and the installed SDK; anything about the local OurGlass base repo is
> called out inline.
>
> **Status of claims:** enforcer semantics are inherited from the verified work in
> `HOURGLASS_STRATEGIES.md` (checked against on-chain Solidity in
> `metamask/delegation-framework`, `pragma 0.8.23`, and SDK
> `@metamask/smart-accounts-kit@0.3.0`). Points marked ✅ carry over from there;
> points marked ⚠️ are arbitrage-specific and still to verify on testnet (§9).

## 1. Thesis

Arbitrage is the cleanest possible fit for the delegation model, cleaner than
DCA. A DCA swap is bounded by a **loss cap** (`BalanceChange` *Decrease*): "don't
spend more than X." An arbitrage is bounded by a **profit floor**
(`BalanceChange` *Increase*): "end with at least X **more** of the base token than
you started."

That single change — `Decrease → Increase` — turns the caveat from a spend limit
into a **no-loss guarantee**. The enforcer does not care *how* the agent routed
the trade; it only checks that the vault's base-token balance rose by at least the
floor. If the round-trip is not profitable, the `afterHook` reverts and nothing
happens.

> The operator signs *one* delegation that says "this agent may run swaps through
> the Uniswap router, and any redemption that does not leave the vault at least
> `minProfit` richer in the base token reverts." The agent runs the price-watching
> logic; the vault is protected by consensus.

Same tagline as the rest of Hourglass: **strategies are software, guardrails are
consensus.** For arbitrage the guardrail is unusually strong — it is not a cap on
downside, it is a *floor on the outcome*.

### What the mandate guarantees / does not guarantee
- **Guarantees**: the vault cannot lose base token on a redemption (the floor is
  `≥ start + minProfit`, with `minProfit` **strictly positive** — see §3); funds
  can only move through the whitelisted Uniswap router; no drain to an arbitrary
  address (a drain fails the floor). The guarantee rests on two things **together**:
  the strictly-positive `Increase` floor *and* the reduced call surface (only
  `execute`, no `approve`, in scope — §3). Neither alone is sufficient.
- **Does not guarantee**: that an arbitrage opportunity *exists*. The mandate
  bounds operational risk (no loss), not market reality. A run with no real edge
  simply reverts and costs the agent gas.

## 2. Why intra-Uniswap = one atomic `execute`

An arbitrage is at least two legs (buy in pool A, sell in pool B). For the caveat
to bound it, the whole round-trip must be **one execution** — otherwise the vault
sits in an intermediate token between two transactions, exposed.

The Universal Router's `execute(bytes commands, bytes[] inputs, uint256 deadline)`
chains **multiple swaps in a single call**. A triangular route
(`USDC → WETH → USDC` across two pools / fee tiers) or a two-pool round-trip is
encoded as one `execute`. Net effect on the vault: base-token balance goes from
`S` to `S + Δ`, atomically. One execution ⟹ one `BalanceChange(Increase)` snapshot
(before) and check (after).

**Invariant, not an option:** the agent **always** composes a single `execute`
that encodes the full round-trip (see §7). The Uniswap Trading API quotes
*directional* swaps (`tokenIn → tokenOut`); it does not return a round-trip. So the
agent takes two CLASSIC quotes and composes one multi-command `execute` itself. ✅
Verified mechanism (`swap-integration` §"Low-Level Approach"): use
`@uniswap/universal-router-sdk`'s `RoutePlanner` with two commands — leg 1
`V3_SWAP_EXACT_IN(recipient=ADDRESS_THIS, …, payerIsUser=true)` swaps base→X
leaving X in the router, leg 2 `V3_SWAP_EXACT_IN(recipient=MSG_SENDER, …,
payerIsUser=false)` swaps the router's X→base back to the Safe with
`amountOutMin = amountIn + minProfit`. If a route cannot fit in one `execute`, the
opportunity is dropped. Two separate redemptions would leave the vault in the
intermediate token between txs (transient custody — forbidden) and each
intermediate leg would fail the `Increase` floor on its own.

**Single-execution redemption.** From the `DelegationManager`'s view this whole
round-trip is **one execution** (`redeemDelegations` with one
`{target: UR, callData: execute(...)}`, mode `SingleDefault`). The multi-leg is
internal to the Universal Router. So the `Increase` floor's per-execution
`beforeHook`/`afterHook` wrap the entire arb correctly, and no batch mode is
needed — which sidesteps the batch-enforcer limitation entirely.

Because both legs stay inside the Universal Router, the `functionCall` scope needs
**no external targets**. The moment a leg needs a non-Uniswap venue, this breaks
(§9).

## 3. The mandate (corrected shape)

```
one delegation. delegator = Safe (multisig). delegate = agent (redeem only).

scope: functionCall
  targets:   [UNIVERSAL_ROUTER]                   // swap only — NO token target
  selectors: ['execute(bytes,bytes[],uint256)']   // 0x3593564c — the only entrypoint

caveats:
  erc20BalanceChange
    tokenAddress: baseToken
    recipient:    Safe
    changeType:   Increase
    balance:      minProfit          // STRICTLY POSITIVE — the whole guarantee
  valueLte → 0n                       // declarative: functionCall already blocks native value in v0.3.0
  // NO Decrease(0) treasury caveat: the SDK's erc20BalanceChange builder rejects
  // balance <= 0n, so "must not decrease" is unencodable. Treasury protection is
  // the approval surface instead (§3.3).
```

**Everything lives inside the Safe.** The delegator is the Safe (via its DeleGator
module), the `execute` runs *as* the Safe, and every token — base and the rest of
the treasury — sits in the Safe. Three consequences shape the design below:
the floor is size-agnostic (§3.5), the output returns home for free (§3.4), and the
agent's reach is defined entirely by *what the Safe has approved* (§3.3).

### 3.1 Approvals live OUTSIDE the mandate (this is the crux)

The `approve` leg is **not** in the mandate scope. Two reasons it cannot be:

1. **Functional:** a redemption whose only execution is `approve` has a zero
   base-token delta, so the `Increase` floor (`balance ≥ start + minProfit`)
   **reverts**. Unlike DCA's `Decrease` cap, an approve-only redemption cannot pass
   under `Increase`. The agent therefore has no legitimate way to approve from
   inside the mandate.
2. **Security:** `functionCall` compiles to `allowedTargets` × `allowedMethods` as
   a **cartesian product** (✅ verified, companion §3) — the *spender* of an
   in-scope `approve` is unbounded. An approve in scope + a zero floor = a drain
   vector (`approve(attacker, max)` → external `transferFrom`).

**Resolution ✅ (verified against Uniswap's contracts — supersedes the earlier
legacy-approve claim):** approval is **Permit2**, done as **two Safe multisig setup
transactions** outside the delegation. A legacy `approve(UniversalRouter, cap)` is
**dead allowance** — the Universal Router never calls `ERC20.transferFrom` on itself
(verified across `Dispatcher.sol`); every user pull goes through
`Permit2Payments.permit2TransferFrom` → `PERMIT2.transferFrom(...)`. So a swap on a
direct router allowance fails. (An earlier draft followed the `swap-integration`
skill's "legacy mode for smart accounts" note; the contract source contradicts it,
and upstream wins. See `docs/APPROVAL_RAILS.md` §2.)

```
setup (multisig, not the agent) — two txs, both from the Safe:
  baseToken.approve(PERMIT2, cap)                                  // real ERC-20 allowance Permit2 needs
  Permit2.approve(baseToken, UNIVERSAL_ROUTER, cap, expiration)    // bounds what the router may pull
```

Permit2 is account-agnostic — `allowance[msg.sender][token][spender]`, no
signature, no ERC-1271, no EOA check — so the Safe calls it directly and, per §1,
the Safe is `msg.sender`, so the Safe is the Permit2 owner. No per-swap signature is
needed: the router *consumes* the standing Permit2 allowance. The Permit2 address is
**not universal** (zkSync Era 324 differs) — resolve per `chainId`.

This keeps the earlier fix intact (approve is out of the mandate scope); only the
mechanism is Permit2, not a legacy router approve.

**The Permit2 allowance is the size lever (§3.5).** Because the floor is
size-agnostic, the Permit2 `amount` — not any caveat — bounds how much of the
treasury the agent can route per run, and Permit2's `expiration` gives a time bound
for free. Set `amount` to the intended per-run size × a buffer and re-approve on
top-up. **Never `maxUint160`.**

### 3.2 `minProfit` must be strictly positive

`minProfit = 0` is **forbidden — and the SDK enforces it at build time.** The
`erc20BalanceChange` builder rejects `balance <= 0n` ("Invalid balance"), so a
zero floor is literally unencodable; `buildArbitrageMandate` also throws on
`minProfitRaw <= 0n` as the earlier, clearer guard. A zero floor would make any
balance-neutral call redeemable (a drain vector), so this rejection *strengthens*
the design. Set `minProfit ≥ expected_gas_in_baseToken + margin` (and see §4). A
regression test asserts an approve-only or balance-neutral redemption reverts.

### 3.3 Treasury protection = the approval surface, not a caveat

A `Decrease(0)` "must not decrease" caveat is **unencodable**: the SDK's
`erc20BalanceChange` builder rejects `balance <= 0n`. So the guard cannot live in a
caveat — it lives in the **approval surface**, which is the stronger and cheaper
place for it anyway.

Because everything is in the Safe and the Universal Router can only pull tokens the
Safe has a **Permit2 allowance** for, the guard is simply: **grant a Permit2
allowance only for the base token.** What has no allowance is unreachable — an
`execute` that tries to pull the Safe's WETH reverts. There is no `protectedTokens`
param on `buildArbitrageMandate`; the mandate carries the single Increase floor and
nothing else. If a Safe carries **stray pre-existing Permit2 allowances** from
earlier Uniswap use, revoke them (`Permit2.approve(token, router, 0, 0)`) as part of
setup rather than trying to fence them with a caveat.

If an on-chain caveat guard is nonetheless wanted, the workable shape is
`erc20BalanceChange(Decrease, tokenX, amount: 1)` — one wei of slack, since the SDK
rejects `amount = 0`; negligible against any real balance. Distinct tokens →
independent enforcer slots → safe to stack. Minimal allowances remain the primary
guard.

### 3.4 The output returns to the Safe for free — no recipient pinning

Because the `execute` runs *as* the Safe, `MSG_SENDER` in the final swap command
resolves to the Safe itself, so the bought-back base token lands in the Safe with no
`allowedCalldata` recipient pin required. And if the agent ever set a different
recipient, the Safe's balance would not rise and the `Increase` floor would revert.
The floor + `MSG_SENDER` fully cover destination integrity.

### 3.5 The floor is size-agnostic — so the cap matters

The `Increase` floor checks `balanceOf(Safe, baseToken)` rose by ≥ `minProfit` over
the whole execution; it does not cap the amount routed in between. With everything
in the Safe, the agent could route far more than the intended `amountIn` (worst
case: the entire base-token balance) — it still cannot *lose* (a shortfall reverts),
but it exposes a larger notional to slippage/MEV. The bounded Permit2 `amount` (§3.1)
is what limits this, since Permit2 decrements the allowance per pull; its
`expiration` bounds it in time too.

The difference from `buildStrategyMandate` (DCA) is therefore a different scope (no
`approve`), a positive floor, a bounded approval cap as the size lever, and
*optional* treasury-protection caveats. Signing, salt = `keccak256(terms)`, and the
redeem-only delegate are unchanged.

## 4. Sizing the floor (the one number that matters)

`balance = minProfit` is the minimum base-token rise the enforcer accepts over the
single execution. It does **not** see gas.

- **Gas is paid from the agent's own ETH (requirement, not a demo shortcut).** Then
  `minProfit` is a **gross** floor — set it above a conservative gas estimate plus a
  margin so the trade is *net* positive. Paying gas in the base token from the Safe
  would deduct from the measured delta and muddy the floor.
- ⚠️ **1Shot / gasless is likely incompatible with the `Increase` floor**, not just
  ambiguous: the relayer bundle is `[fee → feeCollector, swap]`; the fee execution
  alone cannot clear the floor, and bundling fee + swap needs batch mode, which the
  enforcers typically reject (`onlySingleExecutionMode`). Until verified otherwise,
  agent-pays-ETH stands as the funding model for this rail.

**Operational bleed the floor does not cover.** Arbitrage is competitive: most
redemptions revert (someone took the edge first) and the agent pays that gas
anyway. The vault is safe, but the operator funding the agent's ETH bears a real,
unbounded-by-caveat operational cost. The runner must budget agent gas, track
hit-rate, and trip a **circuit breaker** (stop after N consecutive reverts).

## 5. Force CLASSIC routing (hard requirement)

✅ Carried from the Uniswap catalogue. The Trading API can route two ways.

- **CLASSIC** → an `execute(...)` tx on the Universal Router. **Bindable** — known
  target + selector, our caveat works.
- **UniswapX (DUTCH_V2/V3/PRIORITY)** → a signed off-chain gasless order, **no
  `execute` tx**. Our `functionCall` + `BalanceChange` caveat **cannot bound it**.

`BEST_PRICE` on Ethereum mainnet typically returns UniswapX. The agent MUST request
`routingPreference: "CLASSIC"` (optionally `protocols: ["V2","V3","V4"]`) on every
`/quote`, so `swap.to` is always the Universal Router and `swap.data` is always an
`execute(...)` calldata the caveat can bind. A UniswapX leg silently escapes the
mandate.

## 6. What to whitelist / set up

- **Mandate target:** the per-chain **Universal Router** (Trading API `/swap`
  `swap.to` under CLASSIC):
  - Ethereum (1): `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`
  - Base (8453): `0x6ff5693b99212da76ad316178a184ab56d299b43`
  - Arbitrum (42161): `0xa51afafe0263b40edaef0df8781ea9aa03e381a3`
  - Optimism (10): `0x851116d9223fabed8e56c0e6b8ad0c31d98b3507`
  - Unichain (130): `0xef740bf23acae26f6492b10de645d6b98dc8eaf3`
  - Polygon (137): `0x1095692a6237d83c6a72f3f5efedb9a670c49223`
  - Do **not** whitelist the deprecated v1 router `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD`.
  - **Config location:** these live in `src/config/uniswap.ts` (the repo's Uniswap
    config), **not** `addresses.ts`. Today `UNIVERSAL_ROUTER` is wired for mainnet +
    Base only — **no testnet entry**. **Permit2 is absent from the codebase** and is
    now **net-new work** (§3.1) — resolve its address per `chainId` (zkSync differs).
  - ⚠️ **Testnet addresses missing.** Base Sepolia / Sepolia (the repo's deploy
    targets) have no UR entry — add before the POC. Testnet also has no real arb
    edges, so the demo must **seed two pools with a price skew** (unbudgeted work).
- **Mandate selector:** `execute(bytes,bytes[],uint256)` only.
- **Approval (setup, multisig — NOT in the mandate):** **two Permit2 txs** from the
  Safe (§3.1): `baseToken.approve(PERMIT2, cap)` then
  `Permit2.approve(baseToken, UNIVERSAL_ROUTER, cap, expiration)`. A legacy approve
  to the router is dead allowance. **The Permit2 `amount` is the per-run size lever**
  (§3.5) and `expiration` is a free time bound — never `maxUint160`. **Grant an
  allowance only for the base token** — tokens without one are unreachable (§3.3).
- **`deadline` in `execute` (free, use it aggressively).** The third arg of
  `execute(...)` is a per-tx deadline the agent already controls — set it ~1–2
  blocks out so a stale tx cannot execute late. This is a calldata field, **not** a
  `timestamp` caveat, so it does not contradict the reactive posture.
- **Double floor (free operability).** Encode `amountOutMinimum = amountIn + minProfit`
  in the final Universal Router command. The caveat stays the guarantee; the router
  minimum makes an unprofitable route revert **inside** the UR (cheaper, legible
  error) instead of at the `afterHook`.
- **Keep the base token a standard ERC-20 (USDC/WETH).** No native-ETH legs (an L2
  swap to native ETH can deliver WETH + a trailing `WETH.withdraw`, muddying the
  delta). Fee-on-transfer / rebasing base tokens break the delta arithmetic — a
  precondition, not a supported case.
- **Forbid `ALLOW_REVERT`** in the agent's command composer: if leg-1 executes and
  leg-2 is allowed to fail silently, the vault could be left in the intermediate
  token. The `Increase` floor would still catch it (negative base-token delta →
  revert), but the flag must be off and tested (§8).

## 7. The agent loop (off-chain detection, on-chain floor)

The strategy — *when* there is an edge — lives entirely in the agent:

1. Poll `/quote` (CLASSIC) for candidate round-trips on the base-token pairs /
   fee tiers of interest.
2. Compute the net round-trip: does `baseToken → X → baseToken` return more than
   `minProfit + gas`? 100% off-chain agent logic.
3. Compose a **single** multi-command `execute` for the whole route (§2 invariant),
   with an aggressive `deadline` and `amountOutMinimum = amountIn + minProfit`, then
   `redeem`.
4. On-chain, the caveat checks the delta. If the edge evaporated between quote and
   inclusion (it usually does), the redemption **reverts**, vault untouched.

`limitedCalls` is omitted (it caps volume, not latency — wrong tool for a reactive
agent). `timestamp` is **offered as an operator risk knob**, default on: a
`beforeThreshold` at 30–90 days with periodic re-signing is cheap defense-in-depth
against a forgotten zombie mandate, and does not touch latency. The standing guards
are `BalanceChange(Increase)` + the reduced `functionCall`; the multisig
`disableDelegation` is the fast kill-switch.

**MEV (requirement on mainnet, not a suggestion).** A public arb tx reveals its
route and is front-run almost always → hit-rate near zero on the public mempool.
The agent must submit via **private orderflow / a bundle relay** on mainnet. The
caveat protects the vault regardless (revert-or-profit), but private submission is
what makes the rail actually land trades.

## 8. `buildArbitrageMandate` — the shape (corrected)

```
buildArbitrageMandate({ chainId, agentAddress, moduleAddress, safeAddress,
                        baseToken, swapRouter, minProfitRaw }) → { delegation, terms, salt }
                        // minProfitRaw > 0 (enforced here AND by the SDK builder)

  createDelegation({
    to:   agentAddress,          // delegate = the agent (redeem only)
    from: moduleAddress,         // the Safe's DeleGator module
    environment: getEnvironment(chainId),
    scope: {
      type: 'functionCall',
      targets:   [swapRouter],                        // NO baseToken target
      selectors: ['execute(bytes,bytes[],uint256)'],  // NO approve
    },
    caveats: [
      { type: 'erc20BalanceChange', tokenAddress: baseToken,
        recipient: safeAddress, changeType: Increase, balance: minProfitRaw },
      // NO Decrease(0) treasury caveats — unencodable (§3.3). Treasury protection
      // is the approval surface.
    ],
    salt: keccak256(terms),   // NOT keccak256(callData) — arb has no fixed calldata
  })
```

Approval is a separate multisig setup step (§3.1), not part of this builder. The
signing, storage (`StoredDelegation`, `scopeType: 'custom'` or a new `'arbitrage'`)
and redeem scaffolding are reused from the Strategy rail. The only net-new logic is
agent-side: `scripts/arbitrage-agent.ts` composes the multi-leg `execute` calldata
at run time from two CLASSIC quotes. `swapRouter` is passed in by the caller (read
from `src/config/uniswap.ts`), not looked up inside the builder.

Config prerequisite: the per-chain **Universal Router** already lives in
`src/config/uniswap.ts` (mainnet + Base; add a testnet entry for the POC).
**Permit2 addresses are net-new** — add them to `uniswap.ts`, resolved per `chainId`
(zkSync differs; §3.1). The Increase floor resolves to the SDK's default
`ERC20BalanceChangeEnforcer` unless the OurGlass instance is wired into
`getEnvironment` — see §9.2.

## 9. Limits & points to verify on testnet

1. ✅ **Approval shape — resolved (Permit2, two Safe txs).** The Universal Router
   pulls only via Permit2 (verified in `Dispatcher.sol` / `Permit2Payments.sol`); a
   legacy router approve is dead allowance (§3.1, §6, `docs/APPROVAL_RAILS.md` §2).
   Permit2 config is net-new (§8).
2. ⚠️ **The Increase enforcer instance + testnet prerequisites.** `getEnvironment`
   overrides enforcers only on chains with an `hourglass` block — mainnet (1) and
   Base (8453) in the strategy repo (only chain 1 in the local OurGlass fork). It
   overrides period/timestamp/streaming but **not** any balance-change enforcer, so
   the Increase floor resolves to the SDK's default `ERC20BalanceChangeEnforcer` on
   every chain. The OurGlass `erc20MultiOperationIncreaseBalanceEnforcer`
   (`0xeaA1…fFDC`) is declared in `addresses.ts` but **unwired**, and OurGlass
   discovery (`findBalanceChangeCaveat`, `src/lib/intuition/discover.ts`) matches
   **only** the `hourglass`-block instance → finds nothing on testnet. Consequences:
   (a) on testnet (Base Sepolia, no `hourglass` block) the OurGlass instance is
   unavailable, so the §10 validation of
   *that* instance has unmet prerequisites — validate against the SDK default there;
   (b) if the OurGlass Increase instance is wanted, add it to the `hourglass` block
   and `getEnvironment`, then verify its terms byte-layout and hook semantics
   (`beforeAllHook`/`afterAllHook` vs `before/after`) against the deployed bytecode.
   For the single-execution arb (§2) the SDK default per-execution floor suffices.
3. ✅ **Treasury guard shape — resolved.** `amount = 0` is unencodable; use
   minimal Permit2 allowances (primary) or `amount = 1` if an on-chain caveat is
   wanted (§3.3).
4. ⚠️ **Batch mode** is not needed for the happy path (single execution, §2);
   only relevant if a gasless/relayer bundle is later attempted (§4).
5. ✅ **`msg.sender` of the swap — resolved: it is the Safe.** The DeleGator module
   is a genuine Safe module; redemption runs `module.executeFromExecutor` →
   `safe.execTransactionFromModuleReturnData` → target, so `msg.sender` is the Safe
   and `recipient: safeAddress` is correct. Established from the module's runtime
   bytecode (`docs/APPROVAL_RAILS.md` §1) — control flow unambiguous, still worth one
   on-chain confirmation.
6. **Multi-leg `execute` composition is an invariant** (§2), not an open question —
   the Trading API does not quote round-trips. Validate with the fork-tests in §10.
7. **Cross-DEX arb is out of scope** and stays so: preserving §2's single-`execute`
   atomicity across venues is not possible with the current enforcers without an
   intermediary account that reintroduces transient custody — the same trade-off as
   the weekly-cap analysis in `HOURGLASS_STRATEGIES.md §4`.

**Limitations to record (not proposals — out of POC scope):** a cumulative
per-period profit/volume cap on the arb agent, or an enforcer that binds the
`approve` spender to the `execute` target, would require **custom enforcers** —
out of scope, consistent with the companion doc's weekly-cap conclusion. Every
design choice above uses out-of-the-box enforcers, multisig setup txs, or
off-chain agent logic.

## 10. Testing plan (part of the deliverable)

Fork tests on anvil (Base) with two pools seeded to a price skew:

1. Profitable route → redemption passes, delta ≥ `minProfit`.
2. Route below the floor → `afterHook` reverts, balances intact.
3. Leg-2 forced to fail (liquidity pulled between quote and execution) → the whole
   `execute` reverts.
4. `ALLOW_REVERT` set on a command → asserts the composer never emits it, and that
   the floor still catches a half-executed route (negative delta → revert).
5. Approve-only / balance-neutral redemption → reverts (documents §3.1/§3.2).
6. `minProfit = 0` + arbitrary approve → the drain vector this design closes; a
   regression test proving it is rejected.
7. A `Decrease(0)`-protected treasury token the agent tries to sell → reverts.

## 11. Demo slice

> The operator signs an arbitrage mandate (`minProfit` floor on USDC) → the arb
> agent watches CLASSIC quotes, finds a round-trip, redeems → a redemption whose
> route does **not** clear the floor **reverts** on-chain, vault untouched.

The filmed revert is even more striking than the Strategy demo: it is not "you
spent too much," it is "you tried to move the vault's money and it did not come
back with a profit, so the chain refused."

## Sources

- [Caveat enforcers — reference](https://docs.metamask.io/smart-accounts-kit/development/reference/delegation/caveats/)
- [`HOURGLASS_STRATEGIES.md`](HOURGLASS_STRATEGIES.md) — verified `ERC20BalanceChangeEnforcer`
  semantics (Increase = balance ≥ cached + amount; storage key; one-per-token rule)
- [Uniswap AI — swap-integration skill](https://developers.uniswap.org/docs/uniswap-ai/skills)
  (CLASSIC routing, Universal Router `execute` calldata)
- [Permit2](https://docs.uniswap.org/contracts/permit2/overview) — approval with `expiration`
- Universal Router per-chain addresses: Uniswap catalogue (companion research)
