# Aqua / SwapVM encoding reference

Verified against the deployed contracts on an Anvil fork of Base at block
~49,103,210 (2026-07-25). Every claim here was executed, not read off a README.
Reproduce with `scripts/aqua-spike.sh`.

## Addresses (Base, and 11 other mainnets — no testnets)

| Contract | Address |
|---|---|
| Aqua core (`AquaRouter`) | `0x499943e74fb0ce105688beee8ef2abec5d936d31` |
| SwapVM app (`AquaSwapVMRouter`) | `0x8fDD04Dbf6111437B44bbca99C28882434e0958f` |

## Which source is authoritative

**The Blockscout-verified source of the deployed contract — not the GitHub repo.**

The deployed build is older than `1inch/swap-vm` HEAD. Two independent
confirmations:

- Its constructor is `(aqua, name, version)`; HEAD's is
  `(aqua, weth, owner, name, version)`.
- The runtime bytecode contains `quote((address,uint256,bytes),address,address,uint256,bytes)`
  (`0x44aa5f14`) and **not** HEAD's 3-argument `quote` (`0xb7ebf0c5`).

The four orders shipped on Base in Nov 2025 decode against a *third*, older
opcode table (`0x12 / 0x26 / 0x25 / 0x16`, apparently shifted by 5). They are not
executable against the current contract. Do not use them as a reference.

## Opcode table (verified by execution)

Opcodes are positions in the `_opcodes()` function table, not a stable enum. The
table is built with an assembly trick that drops the first entry, so
**`opcode i` maps to `instructions[i+1]`**.

| Opcode | Instruction | Args |
|---|---|---|
| `0x0d` | `Controls._deadline` | 8 bytes |
| `0x11` | `XYCSwap._xycSwapXD` | none |
| `0x15` | `Controls._salt` | any (no-op) |
| `0x16` | `Fee._flatFeeAmountInXD` | 4 bytes, `1e9 = 100%` |

Verified negatively too: `0x16` with zero args reverts `FeeMissingFeeBPS()`,
which is what a fee instruction should do and what a swap instruction would not.

Program format is `[opcode:1][argsLen:1][args:N]`, per `ContextLib.runLoop`.

### Worked example

Constant-product AMM with a 0.3% fee: `0x16 04 002dc6c0` then `0x11 00`
(0.3% of `1e9` = `3_000_000` = `0x002dc6c0`).

```
program = 0x1604002dc6c01100
```

Shipped over `[WETH, USDC]` = `[1e18, 4000e6]`, quoting 0.1 WETH in returned
`363_636_363` with no fee and `362_644_357` with the 0.3% fee — both matching an
independent constant-product calculation to the unit.

## Order encoding

```
traits = 1n << 254n        // useAquaInsteadOfSignature
                           // receiver = 0 (defaults to maker), no hooks, no expiration
data   = program           // Program slice index 0
order  = { maker, traits, data }

strategy     = encodeAbiParameters([Order], [order])
strategyHash = keccak256(strategy)
```

Confirmed: our locally computed `keccak256(abi.encode(order))` equals on-chain
`SwapVM.hash(order)` exactly. SwapVM takes the `keccak256` shortcut precisely
when the Aqua bit is set, which is why it lines up with Aqua's own hashing of
the `bytes strategy` argument.

SwapVM rejects Aqua orders that set `shouldUnwrapWeth` or a receiver different
from the maker. The builder should assert both rather than let the ship revert.

## Taker traits (needed only to quote/simulate; we are not building a taker)

`TakerTraitsLib.parse` reads the **first 20 bytes** as `uint160`: an 18-byte
slice-index field followed by a 2-byte flag field.

| Flag | Value |
|---|---|
| `IS_EXACT_IN` | `0x0001` |
| `USE_TRANSFER_FROM_AND_AQUA_PUSH` | `0x0040` |

Minimal exact-in quote: `0x` + 36 zero hex chars + `0001`. Anything shorter
reverts `TakerTraitsMissingTraits()` — this cost a debugging cycle, note it.

## Lifecycle findings that constrain the UI

1. **`ship()` requires no tokens and no approval.** It is pure accounting. We
   shipped a 1 WETH / 4000 USDC strategy from an account holding neither. The
   approval only matters when a taker actually pulls. A shipped strategy is
   therefore not proof of backing.
2. **`dock()` moves no tokens** and sets `tokensCount = 255`. Post-dock quotes
   revert `SafeBalancesForTokenNotInActiveStrategy`.
3. **A strategy hash is burned forever.** After docking, re-shipping the
   identical strategy reverts `StrategiesMustBeImmutable` — `ship()` requires
   `tokensCount == 0` and dock leaves `255`. This is permanent.
4. **Therefore every ship from our UI must carry a unique salt.**
   `Controls._salt` (`0x15`) is a no-op whose only purpose is to perturb the
   program bytes and thus the strategy hash. Confirmed: same parameters plus a
   salt instruction ships fine and quotes correctly. This is a correctness
   requirement, not a nicety — without it, a user who docks can never re-create
   the same position.

## End-to-end proof

Maker held 1 WETH + 2000 USDC and approved Aqua. Taker swapped 100 USDC for
WETH through `AquaSwapVMRouter.swap()` (174,748 gas):

| | before | after |
|---|---|---|
| maker WETH | `1000000000000000000` | `952517026241844073` |
| maker USDC | `2000000000` | `2100000000` |
| taker WETH | `0` | `47482973758155927` |
| taker USDC | `100000000` | `0` |

Tokens moved directly out of the maker's own wallet, and Aqua's virtual
balances tracked the wallet balances exactly. The output matches the
constant-product-with-0.3%-fee calculation to the unit.

## Note on RPC

`https://base-rpc.publicnode.com` (the app's pinned Base endpoint) rejects the
archive reads Anvil makes when lazily fetching accounts, with a 403 pointing at
a paid tier. `https://mainnet.base.org` works for forking. Relevant only to
tests, not to the app.
