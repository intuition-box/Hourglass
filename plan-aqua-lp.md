# Plan — Aqua page (create + ship a SwapVM order from the Safe)

Status: proposed, not started.
Date: 2026-07-25.

## Goal

A new page in the Safe App that lets a Safe build a 1inch Aqua liquidity
strategy and `ship()` it, from inside Safe, in one batched transaction.

## Non-goals (explicit)

- **Order activation.** Making a shipped order tradable by 1inch requires
  submitting it to the 1inch API, which requires KYC/KYB. Out of scope for the
  hackathon. The page ships the order on-chain and stops there.
- **Taker side.** We never execute swaps against anyone's order.
- **Custom AquaApp.** We do not write or deploy Solidity. We ship to 1inch's
  already-deployed `AquaSwapVMRouter`.
- **Yield claims in the UI.** The page must not imply the position earns
  anything (see "Honest empty state" below).

## Verified ground truth

Everything here was checked against deployed contracts, not the README.

| Thing | Value |
|---|---|
| Aqua core (`AquaRouter`) | `0x499943e74fb0ce105688beee8ef2abec5d936d31` |
| SwapVM app (`AquaSwapVMRouter`) | `0x8fDD04Dbf6111437B44bbca99C28882434e0958f` |
| Chains | 12 mainnets incl. Base. **No testnets.** |

- `ship()` credits `_balances[msg.sender]`. **The maker is the caller** — so the
  Safe calls `ship()`, and the Safe holds the tokens and the approval.
- `ship()` and `dock()` move **zero tokens**. They are pure accounting. Tokens
  never leave the Safe; Aqua only gains the right to `transferFrom` up to the
  shipped virtual balance, and only via the app it was shipped to.
- Exposure is bounded by what we ship. `pull()` is callable only by the app the
  balance belongs to, and decrements the balance (underflow reverts). No third
  party can credit a balance against our Safe.
- Strategy identity: for SwapVM with the Aqua bit set,
  `strategyHash = keccak256(abi.encode(order))`, which is exactly what Aqua
  hashes from the `bytes strategy` we pass. Verified in `SwapVM.hash()`.
- `Order` is `(address maker, uint256 traits, bytes data)`.
- Aqua's events are **not indexed** (`event Shipped(address maker, address app,
  bytes32 strategyHash, bytes strategy)`). We cannot filter logs by maker —
  see "Position discovery".

### Why shipping on Base mainnet is cheap and safe

Because `ship()` moves no tokens, a real demo on Base mainnet costs gas plus an
ERC-20 approval, nothing more. `dock()` unwinds it and also moves nothing. There
is no testnet alternative, so Base mainnet is the target, with an Anvil Base
fork for automated tests.

## RESOLVED — the opcode risk is closed

Task 0 ran on 2026-07-25 against an Anvil fork of Base. Full findings and a
reproduction script: `spec/aqua-swapvm-encoding.md`, `scripts/aqua-spike.sh`.

Outcome: **the Blockscout-verified deployed source is authoritative**
(`0x11` = `xycSwapXD`, `0x16` = `flatFeeAmountInXD`, `0x0d` = deadline,
`0x15` = salt). Proven by execution, not inference — a 0.3%-fee constant-product
program quoted to the unit against an independent calculation, and a real taker
swap pulled tokens straight out of the maker's wallet. The orders shipped on
Base in Nov 2025 use an older table and are not executable; they were a red
herring.

One finding changes the design (see "Salt is mandatory" below).

## Original risk analysis: opcode numbering

The strategy `program` is SwapVM bytecode: `[opcode:1][argsLen:1][args:N]`,
confirmed in the deployed `ContextLib.runLoop`.

Opcode numbers are **positions in a function table**, not a stable enum, and
they have shifted between builds:

- The deployed contract is an older build than repo HEAD (its constructor is
  `(aqua, name, version)`; HEAD's is `(aqua, weth, owner, name, version)`).
- Repo HEAD has an `Opcode` enum that the deployed source does not have.
- The Blockscout-verified deployed source yields, after the
  `_opcodes()` array trick (`result[i] == instructions[i+1]`):
  `0x0d` deadline, `0x11` xycSwapXD, `0x15` salt, `0x16` flatFeeAmountInXD.
- But the four orders actually shipped on Base in Nov 2025 decode as
  `0x12 / 0x26 / 0x25 / 0x16` — consistent with a table shifted by 5
  (balances, fee, deadline, swap). Those orders are either from an older build
  or are simply not executable.

Two candidate tables, and Aqua validates nothing on `ship()` — it stores opaque
bytes. So a wrong program ships successfully and only fails later at swap time.
**This must be resolved empirically before any UI work.**

### Task 0 — encoder spike (DONE, 2026-07-25)

On an Anvil fork of Base:

1. `deal` USDC + WETH to a test EOA, approve Aqua.
2. Ship a minimal order: `traits = 1n << 254n` (Aqua bit only, receiver 0,
   no hooks, program slice at 0), `data = program`.
3. Call `AquaSwapVMRouter.quote()` against it.
4. Try program `[0x16][0x00]` (fee-table candidate) vs `[0x11][0x00]`
   (verified-source candidate) and see which reaches `_xycSwapXD` — the
   distinguishing signal is `XYCSwapRequiresBothBalancesNonZero` /
   a real quote versus an out-of-range or arg-parse revert.
5. Then add the fee instruction and confirm the quote changes by the fee.

Cross-check: recompile the Blockscout-verified sources with solc 0.8.30 and
compare against `eth_getCode`. A match makes the verified table authoritative
and settles it without probing.

Exit criterion: a non-reverting `quote()` on a self-shipped order, with the
opcode table written down. **If this fails, stop and re-scope** — do not build
UI on an unproven encoder.

## Architecture

Layered per `.claude/rules/code.md`. No chain calls in components.

```
src/config/aqua.ts          addresses per chain, opcode table (pinned + commented
                            with the spike evidence), fee presets
src/lib/aqua/program.ts     program bytecode builder (pure, unit-tested)
src/lib/aqua/order.ts       MakerTraits packing + Order encoding + strategyHash
                            (ported from the DEPLOYED MakerTraits.sol, not HEAD)
src/lib/aqua/ship.ts        builds the approve + ship tx batch (pure; returns
                            the tx array, sends nothing)
src/lib/aqua/positions.ts   local strategy record + on-chain reconciliation
src/hooks/useAquaPositions.ts   lifecycle: read rawBalances for stored strategies
src/pages/Aqua.tsx          the page
```

Reuses what exists: `useSafeTokens`, `useWhitelistedTokens`, `findChain`/`rpcUrl`,
`Card`/`Btn`/`Mono`, `Block`/`Field`/`Segmented`/`PreviewRow`, and the
`saveDelegation`-style localStorage pattern in `src/lib/storage.ts`.

### Order construction (verified)

```
program = [0x15][len][salt]  [0x16][04][feeBps]  [0x11][00]
                salt            flat fee          xyc swap

traits = (1n << 254n)                       // useAquaInsteadOfSignature
                                            // receiver = 0 (defaults to maker)
                                            // no hooks, no expiration
data   = program                            // Program slice index 0
order  = { maker: safeAddress, traits, data }
strategy     = encodeAbiParameters([{...Order}], [order])
strategyHash = keccak256(strategy)
```

`feeBps` is 4 bytes where `1e9 = 100%`, so 0.3% is `3_000_000` (`0x002dc6c0`).

### Salt is mandatory, not optional

A strategy hash is burned permanently once docked: `ship()` requires
`tokensCount == 0` and `dock()` leaves `255`, so re-shipping identical
parameters reverts `StrategiesMustBeImmutable` forever. Without a salt, a user
who docks a position can never re-create it.

`Controls._salt` (`0x15`) is a no-op instruction whose args exist purely to
perturb the program bytes and therefore the hash. Every ship from our UI emits
one. The builder must not expose this as a user-facing option — it is a
correctness requirement.

Constraints enforced by SwapVM for Aqua orders (both are satisfied by the above,
but assert them in the builder): `shouldUnwrapWeth` must be false, and the
receiver must equal the maker.

### The transaction batch

One Safe transaction via `sdk.txs.send({ txs })`:

1. `token0.approve(AQUA, amount0)`
2. `token1.approve(AQUA, amount1)`
3. `aqua.ship(SWAPVM, strategy, [token0, token1], [amount0, amount1])`

Approval sizing is a real decision, not a detail: as swaps run, `push()` grows a
token's virtual balance above the shipped amount, and a later `pull()` needs
allowance to cover it. Exact-amount approvals are the safest default and are
what we ship; the page states plainly that a strategy which trades may need a
re-approval to keep trading. No `type(uint256).max` default.

### Position discovery

Aqua events are unindexed, so log-filtering by maker means pulling every Aqua
log and filtering client-side. Cheap today (109 txs on Base), not durable.

Approach: record the strategy locally on ship (chainId, app, tokens, amounts,
program, traits, strategyHash), and treat **on-chain `rawBalances()` as the
truth** for each stored record — it gives balance and `tokensCount`, where
`0xff` means docked. Local storage is an index, never the source of truth. Same
posture as the existing delegation storage.

## UI surface

One page, `Aqua`, added to the `Page` union and `NAV` in `App.tsx`.

**Create** (single column, per `ui.md`):
- Pair: two tokens from the Safe's holdings (`useSafeTokens`), amounts bounded
  by balance.
- Fee: presets (0.05% / 0.3% / 1%) mapping to the 4-byte `feeBps` arg where
  `1e9 = 100%` (0.3% → `3_000_000`). Verified in the deployed `Fee.sol`.
- Preview panel: the decoded program, the `strategyHash`, and the exact three
  calls the Safe will execute. Mono for all hex.

**Positions:** shipped strategies with live balances from `rawBalances`, and a
`dock()` action (one Safe tx, moves no tokens). Docking should also offer to
revoke the approvals, since `dock()` alone leaves them standing.

A position row must distinguish *shipped* from *backed*. `ship()` checks
nothing — we verified a 1 WETH / 2000 USDC strategy shipping from an account
holding neither token. So the row shows the virtual balance next to the Safe's
actual balance and allowance, and flags a strategy that could not currently be
pulled from. Showing the virtual balance alone would overstate the position.

**Honest empty state.** The page states that a shipped order is not tradable
until it is submitted to the 1inch API, which needs KYC/KYB, and that no fees
accrue in the meantime. This is a correctness requirement, not copy polish — a
UI implying idle liquidity earns yield would be misleading.

## Task breakdown

| # | Task | Verification |
|---|---|---|
| 0 | ~~Encoder spike~~ **done** | `scripts/aqua-spike.sh` passes |
| 1 | `config/aqua.ts` + `lib/aqua/order.ts` | unit tests: our `strategyHash` equals `SwapVM.hash()` read from a fork |
| 2 | `lib/aqua/program.ts` | unit tests against fixtures captured in task 0 |
| 3 | `lib/aqua/ship.ts` | unit test on the tx array; no network |
| 4 | `lib/aqua/positions.ts` + `useAquaPositions` | fork test: ship → read → dock → read |
| 5 | `pages/Aqua.tsx` + nav | `bun run build`, `ui-reviewer` agent |
| 6 | End-to-end on an Anvil Base fork | ship + dock from a real Safe, scripted |

Per `.claude/rules/workflow.md`: `bun run build` and `bun run test:unit` green,
`ui-reviewer` on the page, and an ADR in `.claude/choices/` for the two
non-obvious calls — pinning the opcode table to a deployed build, and
exact-amount approvals over max approval.

## Open decisions

1. **Maker = the Safe.** Assumed, since the ask is a Safe App page that creates
   and ships an order. The alternative — maker = the DeleGator module, shipped
   by an agent under a mandate — would reuse the OurGlass delegation rail, but
   needs treasury funds parked on the module and a different guardrail
   (`erc20BalanceChange` cannot cap this, because `ship()` moves no tokens; it
   would have to be an `exactCalldata`-pinned approve). Deferred, not rejected.
2. **Base only** for v1, since Aqua has no testnet and Base is already in
   `SUPPORTED_CHAINS`. The page should render a clear unsupported-chain state on
   the other chains rather than being hidden.
3. ~~Relationship to the existing Yield page.~~ **Decided:** the Aqua page
   stands alongside Yield as its own page. No merge.

## Licensing note

Aqua and SwapVM are source-available (`Degensoft-Aqua-Source-1.1`,
`SwapVM-1.1`), not open source. We integrate by ABI and by encoding conventions,
and we vendor **no** Solidity from either repo. Any reference bytes captured
during the spike go in test fixtures, not in vendored source.
