# Future work

Deferred ideas captured during tasks (per workflow rules — scope discipline).

- **[DCA] The DCA rail needs the same Permit2 setup the limit order got.** Proven on
  the limit order: the Uniswap Universal Router 2.0 pulls the funding token through
  Permit2 (verified — `check_approval` always returns the Permit2 spender on Base, no
  legacy toggle exposed; the `/swap` calldata is a bare `V3_SWAP_EXACT_IN` with no inline
  `PERMIT2_PERMIT`). So `run-dca.ts`'s approve+swap redeem hits `AllowanceExpired` too
  unless the Safe has a standing Permit2 allowance for the router. The fix mirrors the
  limit order: a one-time "Enable trading" setup (`src/lib/permit2.ts`) + drop the
  in-mandate approve, redeeming the swap alone. Until then the DCA docs are stale:
  `getting-started.mdx` (line ~59, "approve directly to the router, not Permit2") and
  `references/execution-dca.md` ("approve + swap in one atomic call") describe the
  pre-Permit2 flow. Deferred with the rest of DCA.

- **Multi-token redeem stats.** `StatsRow` / `sumDisplay` on the Charge page sum
  claimable/claimed across token groups under a single hardcoded "USDC" label.
  Correct for the current USDC-centric POC (amounts are grouped per token with
  per-token decimals in `useClaimTotals`), but if non-USDC redeem becomes real,
  show per-token figures and the actual symbol instead of a single USDC headline.

- **[BLOCKER-ish] Intuition gated the `pinThing`/`pinOrganization` mutations
  behind an API key.** Unauthenticated, both `testnet.intuition.sh/v1/graphql`
  and `mainnet.intuition.sh/v1/graphql` report `mutationType: null`, and a pin
  attempt returns `no mutations exist` (validation-failed). Access was restricted,
  not removed — an API key restores it (requested from Intuition 2026-07-17).

  **Impact today: none on testnet.** All three testnet predicates (`owns`,
  `in context of`, `delegate to`) are now reused by term_id, so the publish path
  never pins. What still needs the pin path:
  - **mainnet**: the `delegate to` atom now EXISTS (term_id
    `0xc587d8f586380d2252d01784a3b6b889a50f960af80cc0d8acb4dbd3e2c2c1f5`,
    verified against the live graph 2026-07-25 — the first mainnet publish created
    it). The read path pins nothing; it matches this id directly.
  - **creating a brand-new Organization atom by name** (`pinOrganization`).

  **When the key arrives:** add the auth header to `createGraphqlPinner`
  (`src/lib/intuition/atoms.ts`) + an env var; nothing else changes.

  **Plan B if the key never comes:** pin the schema.org JSON ourselves via our
  existing Pinata account (we already pin the delegation document there) — the
  mutation only ever did "serialize schema.org JSON + pin to IPFS", both of which
  we can do. Implement an `IntuitionPinner` backed by `pinJSONToIPFS` returning
  `ipfs://CID`. Caveat: our serialization may yield a different CID (hence a
  different atom id) than Intuition's canonical pin — irrelevant for atoms that do
  not exist yet, but it means we would not reuse a canonical atom they created.

- **[v2] Redeem watcher — second, trustless finalization signal.** v1 indexes
  via the browser finalize-on-open path only (any Safe owner opening OurGlass
  reconstructs the delegation from the Safe Transaction Service and pokes the
  backend). Gap: a delegation signed AND redeemed but whose Safe never reopens
  the app is not indexed. A backend watcher scanning `DelegationManager`
  `redeemDelegations` on the app chain closes it — the calldata carries the full
  signed delegation, so it feeds the same verify-then-mint path with no trust in
  any Web2 API. Deferred because it is a long-running chain scanner (dedicated
  singleton process, reorg/receipt-status handling, and a block-cursor decision:
  stateless rescan-window vs persisted cursor). Reintroduce if the "used but
  never reopened" case proves real. Design context in ADR 0005.

- **[UX] Populate Overview from Intuition, keyed by the Safe (delegator).** Now
  that signing no longer writes to `localStorage`, the Overview (`Home.tsx`, which
  reads `getDelegations()`) shows nothing for a Safe whose delegations were signed
  elsewhere. Since every mandate is discoverable on Intuition via the delegator,
  the Overview should list the connected Safe's delegations read from the graph.
  Source of truth: **Intuition only** (by the Safe) — consistent with dropping the
  local store; it shows only published mandates, not unpublished drafts.

  **Work:** the current discovery (`discoverIncomingDelegations`,
  `src/lib/intuition/discover.ts`) traverses by the **agent** (recipient / delegate
  atom → `delegate to` triples where it is the OBJECT). Overview needs the mirror:
  a `discoverBySafe(safeModuleAddress, chainId)` that starts from the delegator
  atom and finds `delegate to` triples where it is the **subject**, then the same
  `in context of` → IPFS doc → `toStoredDelegation` tail. Add a hook
  (`useSafeDelegations`) owning load/error state, and point `Home` at it instead of
  `getDelegations()`. Note the delegator atom is the Safe's **module** address
  (`delegation.delegator`), not the Safe address itself — resolve it the same way
  the create flow predicts the module (factory `predictAddress`).

- **[SECURITY] Per-period cap on the compound mandate (`increaseLiquidity` is
  amount-unbounded).** The compound mandate (`src/lib/compoundDelegation.ts`)
  scopes `collect` + `increaseLiquidity` on the PositionManager but does not cap
  the `increaseLiquidity` amounts: a compromised agent could add more of the
  Safe's own token balance into the LP than just the harvested fees (over-
  allocation into the Safe's own position — not theft, but unbounded).

  **Shipped mitigation (POC):** the "Enable compounding" setup approves a
  *bounded* amount from the Safe to the PositionManager (not `MAX_UINT256`), so
  the agent can never pull more than the approved sum — a real, non-zero blast-
  radius cap. Weakness: it is a lifetime cap that `increaseLiquidity` consumes,
  not a per-period bound, so it needs topping up.

  **Pre-prod hardening (deferred, decided 2026-07-25 with team):** add an
  on-chain per-period guard to the mandate — an `erc20BalanceChange`-style /
  period cap enforcer bounding how much the Safe balance can drop per window.
  This is the correct "Hereda" bound (periodic, not lifetime). Deferred because
  the SDK's `erc20BalanceChange` builder rejects `balance <= 0n` (the same
  `Decrease(0)` limit hit on the treasury-protection caveat), so it needs either
  an SDK-level fix or a hand-encoded caveat + tests. Revisit before any mainnet
  or real-treasury use.

- **[SECURITY] Unbounded token metadata (`symbol`/`name`/`decimals`) is a
  hostile input.** `readErc20Meta` (`src/lib/erc20.ts:43`) reads a custom
  token's `symbol`/`name`/`decimals` from the contract with no bounds, and they
  flow into the delegation terms (`CreateDelegation.tsx:239`,
  `CreateStream.tsx`) and into the pinned/indexed document. Any address can
  deploy a token that returns malicious values. Prerequisite for the
  deterministic-indexing work (ADR 0005 amendment 4): the shared sanitizer must
  exist before terms v2 ships.

  **Attack vectors (proof-of-concept run 2026-07-11, viem `formatUnits`):**
  1. **Oversized `symbol` → mint self-sabotage.** A 500 KB `symbol()` produces a
     ~977 KiB pinned document. IPFS single-block limit is 262144 bytes (256
     KiB); above it Pinata returns a multi-block DAG root CID that does NOT
     equal the single-block CIDv0 computed locally → the `CID === computed`
     assert fails → the delegation can never be indexed. Cheap, permissionless
     denial of indexing.
  2. **Stored injection.** `symbol = "<img src=x onerror=alert(document.cookie)>"`
     lands verbatim in the document `description`
     (`describeDelegation`) → `Recurring subscription: 100 <img src=x
     onerror=…>/month` → rendered by any consumer of the graph (Intuition
     portal, OurGlass showcase). Persistent XSS surface via the knowledge graph.
  3. **Absurd `decimals`.** `decimals() = 255` (readable via the `uint256`
     fallback in `readErc20Decimals`) turns `formatUnits(1e6, 255)` into a
     251-char `"0.000…"` string — a garbage `amountPerPeriod` display and a
     bloated terms field.

  **Fix (per ADR 0005):** one shared sanitizer (`src/lib/sanitize-text.ts` +
  `src/lib/token-meta.ts`, DONE) — byte-length cap on `symbol`/`name`, strip
  control + HTML-significant chars, clamp `decimals` to 0–36. Applied to the
  token metadata that enters the **Intuition document description** (commit 2),
  server-side and in any client that builds the description. This is
  Intuition-side only — it does NOT touch the salted terms or the signed struct
  (the earlier plan to sanitize inside `buildTerms` was dropped with the terms-v2
  revert). PoC (verified 2026-07-11): `formatUnits(1_000_000n, 255)` → 251-char
  string; a doc carrying `'A'.repeat(500_000)` as symbol → ~977 KiB.
