# Execution — a limit order (single price-triggered swap)

A limit order is a **buy-the-dip**: one swap that fires only when the price is at or
below the operator's trigger, then never again. The agent watches the price off-chain
and redeems **one** swap execution as the Safe when the dip hits. Proven end-to-end on
Base mainnet.

## How the trigger is enforced

The mandate is **one delegation** scoping the Universal Router `execute` only, with
these caveats (all on the HourGlass enforcer instances):

- **`erc20BalanceChange` Decrease** on the funding token = the max spend. Its recipient
  is the **Safe** (the Safe spends), and its token IS the funding token.
- **`erc20BalanceChange` Increase** on the target token = the **min received**, the
  price trigger. The redeem reverts unless the swap returns at least this much. A
  cheaper price returns more of the target token, so a low-enough price clears the
  bound; a high price reverts. That inequality *is* "buy only at or below the trigger".
- **`limitedCalls(1)`** — redeemable exactly once. Its presence is also how discovery
  tells a limit order from a DCA (a DCA has no `limitedCalls`).

The chain guarantees you can't overpay, overspend, or fire twice. Your job: **don't
submit a guaranteed-revert redeem** (wait for the dip), then fire promptly.

## Prerequisite — Permit2 is set up on the Safe (one-time, not your job)

The Universal Router 2.0 pulls the funding token through **Permit2**, so the Safe must
already hold two allowances or the swap reverts with `AllowanceExpired`:

1. `fundingToken.approve(Permit2, ∞)` and
2. `Permit2.approve(fundingToken, router, ∞, ∞)`.

The **operator** does this once per funding token via the Safe App's "Enable trading"
button (a single batched Safe tx). It is **not** part of your redeem — the mandate
authorises the swap alone. If a fill reverts with `AllowanceExpired`, the operator has
not run the Permit2 setup; ask them to.

## The loop

1. **Discover** the mandate addressed to your agent (`discovery.md`), matched by
   `delegationHash` from the recap. A limit order has `limitedCalls` + both bounds; read
   `maxSpend` from the Decrease bound and `minReceived` from the Increase bound.
2. **Quote** `EXACT_INPUT` of the full `maxSpend`, funding → target, with
   `routingPreference: "BEST_PRICE"` (CLASSIC is deprecated as an input; the response
   `routing` must still be `CLASSIC` — reject a UniswapX route). Read the expected out at
   `quote.output.amount`.
3. **Compare** to `minReceived`:
   - `output < minReceived` → price still above the trigger. Wait and re-quote. Do
     **not** redeem — it would revert and waste gas.
   - `output >= minReceived` → the dip has hit. Go to step 4.
4. **Fill**: `/swap` with the quote, then redeem the swap as **one** `SingleDefault`
   entry in `redeemDelegations` (`target = router`, the `execute` calldata). No approve
   step — Permit2 is already set up. The Increase bound is your on-chain backstop if the
   price moves between quote and redeem: the redeem simply reverts, and you keep polling.
5. **Stop after a successful fill.** `limitedCalls(1)` means a second redeem reverts.

## The bundled runner

`scripts/run-limit-order.ts` does discovery + poll + fill end to end. It takes the
operator's instruction JSON (the recap copied from the **Limit order** tab):

```bash
POLL_SECONDS=60 bun scripts/run-limit-order.ts <path-to-instruction.json>
```

Env: `AGENT_PRIVATE_KEY`, `UNISWAP_API_KEY`, `INTUITION_NETWORK` (`mainnet` |
`testnet`), optional `RPC_URL`, optional `POLL_SECONDS` (default 60), optional
`MAX_POLLS` (default 0 = poll until it fills). It matches the mandate by
`delegationHash`, polls the quote against the enforced `minReceived`, redeems the swap
when the dip hits, and exits once filled. Wire it to a long-running process or a
scheduler you own — one invocation watches one order until it fills or `MAX_POLLS`.
```
Example success:
  dip hit: quote returns 0.000854 ≥ 0.000842 — filling
  redeemed: 0xd3be769e…
  status: success
```
