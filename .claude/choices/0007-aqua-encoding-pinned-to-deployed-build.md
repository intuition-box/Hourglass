# 0007 — Aqua strategy encoding is pinned to the deployed build, not the repo

**Status:** Superseded by 0009
**Date:** 2026-07-25
**Triggered by:** user request (Aqua LP page)

## Context

Shipping liquidity to Aqua means handing `Aqua.ship()` a `bytes strategy` that the
target app can later interpret. For 1inch's `AquaSwapVMRouter`, that payload is
`abi.encode(Order{maker, traits, data})` where `data` is a SwapVM **program**:
bytecode of `[opcode:1][argsLength:1][args]` instructions.

The opcodes are not a stable enum. They are indices into the router's
`_opcodes()` function table, which is assembled with an assembly trick that drops
the first entry (`result[i] == instructions[i+1]`). Adding or reordering an
instruction shifts every opcode after it. Three different tables were in play:

- `1inch/swap-vm` HEAD, which has an `Opcode` enum the deployed contract does not.
- The Blockscout-verified source of the deployed contract.
- Whatever the four orders shipped on Base in Nov 2025 were built against
  (`0x12 / 0x26 / 0x25 / 0x16`, apparently shifted by 5).

This matters more than a normal ABI mismatch because **`ship()` validates
nothing**. Aqua stores opaque bytes. A program built against the wrong table
ships successfully, sits there looking healthy, and only fails later — for
whoever tries to trade against it.

There is no testnet deployment, so this could not be settled by trial on a
throwaway chain.

## Decision

Pin the encoding to the **deployed build**, established empirically and captured
in `src/config/aqua.ts`:

```
0x0d deadline   0x11 xycSwap   0x15 salt   0x16 flatFeeAmountIn
```

Two independent confirmations that the verified source (not HEAD) describes the
runtime: the deployed constructor takes `(aqua, name, version)` where HEAD takes
five arguments, and the runtime bytecode contains the 5-argument `quote`
selector (`0x44aa5f14`) while HEAD's 3-argument version (`0xb7ebf0c5`) is absent.

The table is then confirmed by execution rather than inference — a 0.3%-fee
constant-product program quotes to the unit against an independent calculation
(`scripts/aqua-spike.sh`, `scripts/aqua-fork-check.ts`).

Wire **Base only**, even though the contracts share an address across twelve
mainnets, because only Base was verified.

## Alternatives considered

- **Take opcodes from `1inch/swap-vm` HEAD** — wrong for the deployed contract,
  and wrong in the worst way: it ships fine and fails invisibly later.
- **Copy the live Nov-2025 orders** — they decode against a third, older table.
  Nothing has ever traded against them, which is consistent with their being
  unexecutable.
- **Vendor the Solidity and compile our own reference** — the licences
  (`Degensoft-Aqua-Source-1.1`, `SwapVM-1.1`) are source-available, not open
  source. We integrate by ABI and encoding conventions, vendoring nothing.
- **Deploy our own AquaApp with an encoding we control** — removes the risk
  entirely, but the app would never receive order flow, and it means shipping
  Solidity for a page whose scope is explicitly create-and-ship.

## Consequences

**Positive:**
- The encoding is verified against the contract that will actually receive it,
  and reproducible on demand by two scripts.
- Fixtures from the fork pin the unit tests, so a future edit that breaks the
  encoding fails in CI rather than on-chain.

**Negative:**
- If 1inch redeploys `AquaSwapVMRouter` with a reordered table, our programs
  become silently invalid. There is no version signal on-chain to detect this,
  and no event we can watch — it would surface as strategies that ship and never
  quote.
- Base only, so the page is unusable on the other chains the app supports.

**Neutral (worth knowing):**
- Re-running `scripts/aqua-fork-check.ts` is the cheapest way to detect drift,
  and is the gate for adding another chain to `AQUA_ADDRESS`.

## References

- Encoding reference: `spec/aqua/encoding.md`
- Reproduction: `scripts/aqua-spike.sh`, `scripts/aqua-fork-check.ts`
- Plan: `plan-aqua-lp.md`
- Related rule: `.claude/rules/code.md`
