# 0006 — Strategy rail routes through the HourGlass ERC20BalanceChange enforcer

**Status:** Superseded by 0009
**Date:** 2026-07-25
**Triggered by:** user request (DCA / strategy mandate implementation)

## Context

The strategy rail (DCA, range) bounds an agent's swap with an `erc20BalanceChange`
caveat. That enforcer exists at two addresses on-chain: the canonical SDK
deployment (`0xcdF6…`) and the HourGlass-owned instance (`0xf069…`, deployed under
the HourGlass CREATE2 salt — same audited bytecode). By default the SDK's
`getEnvironment` resolves the caveat to the canonical address; `environment.ts`
already overrides three other enforcers (period/timestamp/streaming) to the
HourGlass instances for analytics attribution. The write side (`buildStrategyMandate`
via `createDelegation`) and the read side (`findBalanceChangeCaveat` in
`discover.ts`) must agree on which address a mandate carries, or a published mandate
is never rediscovered.

## Decision

Route the strategy rail through the **HourGlass** enforcer instance: add
`ERC20BalanceChangeEnforcer: hourglass.erc20BalanceChangeEnforcer` to the
`getEnvironment` overrides, and match only that address in
`findBalanceChangeCaveat`. One address end to end.

## Alternatives considered

- **Match both addresses in discovery, leave the SDK default (canonical) at
  create** — robust, but leaves HourGlass mandates using the canonical enforcer,
  losing the HourGlass emitter attribution the other three overrides exist for, and
  keeps two addresses in play.
- **Match the canonical address only** — simplest, but diverges from the existing
  period/stream/timestamp pattern and drops HourGlass attribution for this caveat.

## Consequences

**Positive:**
- Write and read agree on one address; a mandate is always rediscoverable.
- Consistent with the existing HourGlass-instance pattern (period/stream/timestamp).
- HourGlass emitter attribution extends to the strategy caveat.

**Negative:**
- Strategy mandates only work on chains where the HourGlass block is deployed
  (chains without it fall back to canonical, and discovery would then miss them).
  Acceptable: the target prod chains carry the HourGlass suite.

**Neutral (worth knowing):**
- Both enforcer instances are byte-for-byte identical (same audited bytecode); the
  choice is about attribution/consistency, not behavior.

## References

- Related rule: `.claude/rules/metamask-delegation.md`
- Related doc: `docs/DCA_IMPLEMENTATION_PLAN.md`, `docs/HOURGLASS_STRATEGIES.md`
- Related spec: `spec/hourglass-enforcer-suite.md`
