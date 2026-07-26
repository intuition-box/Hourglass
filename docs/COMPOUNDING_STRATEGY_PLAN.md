# Gas-aware auto-compounding — concept + implementation plan

**For:** the team (yield/strategy rails + app).
**In one line:** an auto-compounding yield strategy where the agent decides *when*
to compound by weighing accrued yield against gas + fee, so every compound is
net-positive — infrequent for small treasuries, frequent for large ones — and the
compounding uplift is shown in the app as a first-class, opt-in strategy.

## Why this is the differentiator (path 2)

Rails 1 (idle→yield) and 4 (rebalance/DCA) are already being built; arbitrage (5) is
theory for now. Compounding is where the AI's judgment produces ROI that a naive
integration can't: reinvesting yield back into principal so the base grows, but only
at the moments where it actually pays after costs. Done right, it also aligns
monetization — the platform fee is charged per compound, and the profitability gate
guarantees a compound never runs at a loss for the user.

## Core mechanic: profitability-gated compounding

Harvesting yield and reinvesting it costs gas (and a performance fee). Compounding
adds value only when the reinvested amount will earn enough extra ("yield on yield")
to beat those costs. So the agent does not compound on a fixed schedule — it
compounds when the accrued yield clears a multiple of the cost:

```
compound when:  accrued_yield  ≥  M × (gas_cost + fee)          (M ≈ 5–20, tunable)
```

`M` sets how small a fraction of each compound is eaten by costs (M = 10 → costs are
≤ 10% of what's reinvested). The break-even interval that follows is:

```
T*  ≈  M × (gas_cost + fee) × 365  /  (P × r)
```

`P` = position size, `r` = APR. **T\* is inversely proportional to position size** —
which is exactly the behaviour you described: a big treasury hits the threshold in
minutes, a small one takes weeks.

### Worked examples (your numbers)
- **10K, ~$0.20 yield/day, $0.15 gas.** With M = 10 the threshold is ~$1.50, reached
  in ~7–8 days → **compound weekly** (or monthly). Compounding daily here would burn
  75% of the harvest in gas — the agent refuses to.
- **10M, ~$2,000 yield/day, $0.15 gas.** The threshold is cleared in well under an
  hour → **compound daily** (or intraday). Gas is a rounding error.

Same rule, opposite cadence — the agent reads live gas and current accrual each cycle
and picks the moment. No hardcoded schedule.

## How it respects the agent constraints

This is fully inside the "look and pull a pre-signed lever" model:
- **Look:** the agent reads accrued yield, live gas price, and the fee — computes the
  rule. Pure observation + arithmetic.
- **Pull:** it triggers a *pre-signed, bounded* "harvest + reinvest on venue V"
  delegation the Safe already authorised. It cannot invent the action, change the
  venue, or raise the cap.
- **Never:** it does not construct or edit the delegation, and it never holds or
  touches the funds — the compound executes as the Safe under the pre-signed
  authority. A compromised agent's worst case is triggering a compound early or not
  at all; it can't redirect anything.

## Fees / monetization (aligned by construction)

Charge the performance fee **on realized yield, at each compound**. Because the gate
requires `accrued ≥ M × (gas + fee)`, every compound is net-positive for the user
*after* gas and fee — they never pay a fee on a losing action, and Hourglass earns
only when it grew their money. The `[fee → feeCollector, amount → org]` split already
in the arb bundle is the same plumbing.

## The app UX

Show compounding as an opt-in strategy with its projected uplift made visible, so the
user sees why to enable it. A position card:

```
Your amount        4,000
Strategy 5%        → 4,200        (simple, 1 period)
Compound 5%        → 4,2xx        (auto-compounded — higher)
Next compound      ~in 6 days     (gas-aware; updates with treasury size + gas)
[ Enable auto-compound ]  (toggle)
```

- Left: principal. Middle: the simple-yield projection. Right: the compounded
  projection, always ≥ simple, with the delta highlighted as the value of enabling.
- A time axis / horizon selector (1m / 3m / 1y) so the compounding curve visibly
  pulls ahead of the flat one.
- The "next compound" estimate is the agent's `T*` for this position at current gas —
  it makes the gas-awareness legible ("we wait because your size doesn't justify daily
  gas yet").

## Implementation plan

**Components**
1. **Compound delegation (operator/rails side — colleague):** a pre-signed bounded
   "harvest + reinvest on whitelisted venue" action, built from a predefined template,
   signed by the Safe. Same shape as the yield rail, plus the reinvest leg.
2. **Agent cadence logic (our side):** each cycle read accrued yield + live gas + fee,
   apply `accrued ≥ M × (gas + fee)`, trigger the redeem when it passes. Mirrors the
   arbitrage-agent structure (read → gate → redeem), with the gate being the
   profitability rule instead of the arb floor.
3. **Projection + display (app):** the card above — simple vs compounded curve, next-
   compound estimate, enable toggle. Needs a small projection function
   (principal, APR, gas, M → curve + T\*).
4. **Fee + accounting:** performance fee taken at compound time on realized yield;
   analytics tracking realized compounds, effective APY uplift, gas spent.

**Phasing**
- **Phase 1 — backend proof:** the compound delegation + the agent gate on one venue.
  Demonstrate the 10K-waits / 10M-runs behaviour on a fork. No UI yet.
- **Phase 2 — app surface:** the projection card + enable toggle + next-compound
  estimate. Read-only projection first, then wired to a live position.
- **Phase 3 — fee + analytics:** the performance-fee split at compound time and the
  APY-uplift / gas-spent dashboard.

## Open questions
- **`M` default and whether the operator can tune it** (risk/cost appetite dial).
- **Gas top-up cadence** for the compound tx — the agent pays gas from its own ETH
  (relayers/gas abstraction are out of scope), so the open question is when and how
  the Safe refills the agent wallet.
- **Venue set** — which yield venues are pre-approved as compound targets (defines the
  reachable APR menu).
- **APR input** — read live from the venue, or a conservative estimate for the
  projection curve.
