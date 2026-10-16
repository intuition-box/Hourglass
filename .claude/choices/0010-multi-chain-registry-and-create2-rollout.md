# 0010 — One network registry; CREATE2 rollout of HourGlass contracts

**Status:** Accepted
**Date:** 2026-10-16
**Triggered by:** user request ("extend HourGlass to as many chains as possible")

## Context

Per-chain data was spread over `supported-chains.ts` (RPC, USDC, display meta),
`addresses.ts` (factory, enforcers), `chains.ts` (wagmi), `safe-messages.ts`
(tx-service URLs, Ethereum missing) and hand-copied duplicates under
`website/src/redeem/config`. Adding a chain meant editing five places.

A network is usable when three things exist on it: MetaMask's Delegation Framework
v1.3.0, Safe{Wallet} with a Transaction Service, and HourGlass's own
DeleGatorModuleFactory. 18 networks satisfy the first two (13 mainnets, 5 testnets).
The factory was deployed with plain CREATE on the first four chains, so each one has
a different address.

## Decision

- `src/config/networks.ts` is the only place per-chain data lives. Every network
  carries a discriminated `deployment`: `live` (factory + which enforcer set) or
  `pending`. Only live networks are offered by the app. `supported-chains.ts`,
  `addresses.ts`, both wagmi configs and the tx-service lookup derive from it.
- New networks get the four payment enforcers and the factory through the
  deterministic CREATE2 deployer under the existing `OURGLASS` salt.
  `scripts/deployments/hourglass-initcode.json` holds the creation code, recovered
  byte for byte from the Ethereum deployment txs. The enforcers therefore land at
  the same addresses as on Ethereum and Base, and the factory at one address
  (`0x30eA…c0d8`) on every new network, whichever wallet sends the transaction.
- `scripts/deploy-network.ts` deploys only what is missing, then compares runtime
  bytecode to Ethereum. For the factory it normalizes the implementation immutable
  and also checks the implementation and the DelegationManager. Its `check` mode
  audits every network.
- `scripts/e2e-fork.ts` replays the full payment flow on an anvil fork through the
  app's own code: Safe → module → subscription + stream → over-cap refusals →
  revoke.
- The website `/redeem` console keeps byte-identical copies of the three config
  files. `test/unit/website-sync.test.ts` fails on any drift.

## Alternatives considered

- **Plain CREATE per chain, like `deploy-factory.mjs`** — a different factory
  address on every chain, and the deployer nonce decides it. Superseded.
- **Canonical MetaMask enforcers on new chains** — no deployment, but charges there
  would not be attributable in analytics (user choice: HourGlass instances).
- **Point the website at the app's sources** — the Turbopack root is pinned to
  `website/`; widening it is a build change outside this task. Copies + a sync test
  instead.

## Consequences

**Positive:**
- Adding a network is one registry entry plus one script run.
- Ethereum gains its tx-service URL. It was missing, which broke finalize-on-open
  there.
- `test/unit/payment-delegations.test.ts` keeps the existing four networks' signed
  payloads byte-identical.

**Negative:**
- A `pending` network becomes usable only after someone funds a wallet and runs
  the deploy script, then flips the entry to `live('payment')`.

**Neutral (worth knowing):**
- The tx-service base URLs moved to `api.safe.global/tx-service/<shortName>`. The
  old `safe-transaction-*.safe.global` hosts already redirect there.
- Base Sepolia and Sepolia stay on canonical enforcers. Moving them would change
  what testnet Safes sign.

## References

- Related ADR: `spec/hourglass-enforcer-suite.md`, `spec/ourglass-enforcer-instances.md`
- Related rule: `.claude/rules/metamask-delegation.md`, `.claude/rules/security.md`
