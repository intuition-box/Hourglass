# 0008 — Aqua ships with exact-amount approvals, and a salt on every strategy

**Status:** Superseded by 0009
**Date:** 2026-07-25
**Triggered by:** user request (Aqua LP page)

## Context

Two choices in the Aqua ship batch are not obvious, and both were forced by
behaviour verified on a Base fork rather than by anything in the docs.

**Approvals.** Aqua never holds tokens. It records a virtual balance and, when a
taker swaps, calls `transferFrom` on the maker. So a live strategy requires a
standing ERC-20 allowance from the Safe to Aqua. As swaps run, `push()` can grow
a token's virtual balance *above* what was shipped, and a later `pull()` needs
allowance to cover that grown balance — which argues for approving generously.

**Strategy identity.** `ship()` requires `tokensCount == 0` for the strategy
hash, and `dock()` writes `255`. A hash is therefore burned permanently the
moment it is docked: re-shipping identical parameters reverts
`StrategiesMustBeImmutable` forever. Verified directly — see
`scripts/aqua-spike.sh` step 5.

## Amendment (2026-07-25, same day)

The first implementation treated the allowance as **per strategy**. It is not:
an ERC-20 allowance is a single value per `(owner, spender)`, and Aqua's whole
design is one approval serving many strategies. Two defects followed, both found
by a user running three strategies over the same pair:

- `buildShipTxs` called `approve(amount)`, which **overwrites**. Shipping a
  second strategy silently un-backed the first.
- `buildDockTxs` revoked to `0`, which un-backed every *other* active strategy
  over those tokens.

A third followed from the same mistake: the backed check compared one strategy
against the shared allowance, so it read green while the strategies collectively
were not covered.

Corrected: ship approves `currentAllowance + amount`, dock releases only this
strategy's share (`currentAllowance - virtual`, floored at zero), and coverage is
computed per token against the summed demand of all active strategies. There is
also a top-up action, because **every pull spends allowance** — maintenance is
expected, not exceptional.

Also corrected: shipping **above** the Safe's balance is now allowed and framed
as a strategy choice. Aqua prices against the virtual balance and pulls real
tokens at swap time, so over-subscribing quotes deeper liquidity and only reverts
on a fill large enough to outrun the wallet. Verified in the deployed `Fee.sol`:
`_feeAmountIn` prices the curve on the discounted amount but restores the taker's
full `amountIn` before the push, and there is no protocol collector in that path
— the fee lands in the maker's own wallet. So an over-subscribed position closes
its own gap as it trades. The original form blocked this outright, which was
wrong.

## Amendment 2 (2026-07-25) — headroom, on by default

The original "exact amount" rule was wrong in practice.

Measured on a Base fork (and now asserted by `scripts/aqua-fork-check.ts`): a
swap spends the maker's allowance for the token it pulls **out**, by exactly the
amount pulled, because Aqua calls `transferFrom(maker, …)` on that leg. The
incoming leg costs the maker nothing — `push()` spends the *taker's* allowance —
so tokens arriving from swaps, fees included, land outside the approval and
never replenish it.

An allowance therefore only falls, and is consumed by a token's gross outflow
rather than its net flow: in a two-way market both legs drain while the balances
hold steady. An exact approval is consumed after roughly one turnover and the
strategy silently stops filling — a bad default for a rail whose whole appeal is
unattended market-making.

### Why we do not simply follow the README

Aqua's README prescribes `token.approve(address(aqua), type(uint256).max)` and
calls it **one-time**, with "maintain a single token approval" as a headline
benefit. That claim is token-dependent, which the README does not say. Measured
on a Base fork with a max approval and a real swap through each leg:

| Token | Implementation | Max approval on pull |
|---|---|---|
| WETH `0x4200…0006` | WETH9 | **not** decremented — `if (allowance != uint(-1))` guard |
| USDC `0x8335…2913` | FiatTokenV2_2 | **decremented** by exactly the amount pulled |

So "one-time" holds for WETH-style tokens at exactly `type(uint256).max`, and
does not hold for USDC — though at max the practical difference is nil, since
exhausting 2^256 would take an absurd number of turnovers.

With a **bounded** approval, which is what this repo issues, both tokens
decrement on every pull. The depletion behaviour described above therefore
applies to our approvals regardless of token, and headroom is what makes the
bounded choice workable rather than merely safe-looking.

Approvals now carry **10× headroom by default**, exposed as a two-option toggle
(`Headroom ×10` / `Exact`) so it is one click to opt out. The multiplier is a
named constant, the exact figure is shown per token before signing, and the
value stays bounded and legible — still never `type(uint256).max`.

Each strategy's approval contribution is recorded, so `dock()` releases exactly
what it added, headroom included, rather than stranding 9× behind.

## Decision

**Approve a bounded, visible amount — by default 10× the shipped size —
accumulated across strategies, never overwritten and never unlimited.** A
strategy that outruns its approval stalls until topped up; the page shows the
shortfall and offers the transaction.

**Emit a fresh 4-byte salt instruction (`0x15`) on every ship.** `Controls._salt`
is a no-op whose only effect is to perturb the program bytes and therefore the
hash. It is not exposed as a user-facing option.

## Alternatives considered

- **Unlimited approval** — makes a strategy trade indefinitely without
  maintenance, and is what most LP UIs do. Rejected: an unlimited allowance from
  a DAO treasury to a protocol with ~109 transactions of history is a poor
  trade, and a bounded multiple buys most of the same convenience.
- **Exact amount only** — the original decision, superseded by Amendment 2. It
  reads as the safe choice but stalls the strategy after about one turnover,
  which is a worse outcome than a bounded, visible headroom.
- **No salt, and surface `StrategiesMustBeImmutable` as an error** — pushes an
  unrecoverable protocol detail onto the user for no benefit. A user who docks a
  position could never re-create it at the same terms.
- **Derive the salt from the terms plus a nonce** — deterministic and
  reproducible, but requires tracking a nonce per terms; randomness is
  sufficient across a 2^32 space for a per-Safe strategy list.

## Consequences

**Positive:**
- The Safe's exposure to Aqua is bounded by what it deliberately shipped, and
  drops to zero on dock (the dock batch also revokes).
- Docking is always reversible: the same terms can be re-shipped under a new salt.

**Negative:**
- Fills are capped by the allowance, so it needs topping up as pulls consume it.
  The Coverage panel surfaces the shortfall and offers the transaction, but the
  Safe must act on it.
- Every ship needs a fresh on-chain allowance read before the batch can be
  built, so `buildShipTxs` cannot be called from stale state.
- Two strategies with identical terms are distinct on-chain and appear as
  separate rows. That is the protocol's model, not a display artefact.

**Neutral (worth knowing):**
- `dock()` moves no tokens, so unwinding costs only gas.
- `ship()` checks neither balance nor allowance, so "shipped" never implies
  "funded" — hence the per-token coverage state in `useAquaPositions`.
- Over-subscription is a feature, not a warning state. The UI says "partially
  covered", not "not backed", and never blocks it.

## References

- Encoding reference: `spec/aqua/encoding.md`
- Reproduction: `scripts/aqua-spike.sh`, `scripts/aqua-fork-check.ts`
- Related ADR: `.claude/choices/0007-aqua-encoding-pinned-to-deployed-build.md`
