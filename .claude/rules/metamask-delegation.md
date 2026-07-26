# MetaMask delegation rules

Load for any work touching the MetaMask Smart Accounts Kit, ERC-7710/7702 delegation, or the `erc20PeriodTransfer` caveat. That covers `packages/core`, `packages/web`, and `scripts/`.

**Out of scope: third-party relayers / gas abstraction.** Every redemption in this
repo is a direct transaction to the `DelegationManager`, paid in native gas by the
redeeming party. If a task proposes routing a redemption through a relayer, a
paymaster, or any gas-abstraction service, that is a scope expansion: stop and ask.

This rule supplements `code.md` for the TypeScript side and `solidity.md` for any contract side.

## What this project actually does

A recurring ERC20 subscription: the subscriber signs **one** EIP-712 delegation that lets an organization pull a capped amount **per period**. The cap is enforced on-chain by the Delegation Framework's **built-in `erc20PeriodTransfer` caveat** — there are **no custom caveat enforcers in this repo**. If a task proposes writing a custom enforcer contract, that is a scope expansion: stop and ask.

Two signing paths exist. Both charge by a direct `redeemDelegations` transaction —
the redeeming party holds native gas on the chain.

| Path | Subscriber account | Where | Notes |
|---|---|---|---|
| **Hybrid DeleGator** | Smart account deployed from an EOA (ECDSA signer) | `scripts/create.ts` + `scripts/charge.ts`, `packages/web` "hybrid" method | Org redeems via `DelegationManager`; revoke via `disableDelegation`. |
| **ERC-7715 advanced permissions** | MetaMask-native periodic permission | `packages/web` "erc7715" method | Requires MetaMask ≥13.23 / Flask ≥13.5. |

## Authoritative sources

Vendored skill references (read these first):

- **`mms-smart-accounts-kit`** — `.claude/skills/mms-smart-accounts-kit/SKILL.md` + `references/` (smart-accounts, delegations, advanced-permissions). ERC-4337 account creation, signer types (Hybrid / MultiSig / Stateless7702), delegations, ERC-7715 advanced permissions, the Delegation Framework.
- **`mms-gator-cli`** — `.claude/skills/mms-gator-cli/SKILL.md`. The `@metamask/gator-cli` for delegation operations (init, grant, redeem, revoke) and EIP-7702 EOA upgrade — useful for shell testing before wiring the UI.

Upstream sources of truth (the vendored skills are snapshots — defer here when SDK behavior is unclear):

- MetaMask Smart Accounts Kit docs — https://docs.metamask.io/smart-accounts-kit/

If a vendored skill conflicts with upstream, upstream wins. If SDK behavior conflicts with this rule file, escalate to the user — do not silently work around it.

## The `erc20PeriodTransfer` caveat

- The recurring cap is the `erc20PeriodTransfer` caveat synthesized from the delegation `scope`: `tokenAddress`, `periodAmount`, `periodDuration`, `startDate`. An optional `timestamp` caveat enforces an end date.
- The caveat is the **only** on-chain enforcement. It caps the amount per period and refuses a second pull within the same period (charging twice in one period is a no-op).
- Do not re-implement this cap off-chain or in a custom contract. Use the toolkit's scope builder.

## Account creation

Use the Smart Accounts Kit factory functions from `@metamask/smart-accounts-kit`. Do not roll a custom factory.

- **Hybrid** (CLI + web "hybrid"): deployed on-demand, deterministically derived from the controlling EOA + salt. The smart account holds the tokens and is the `delegator`. The controlling EOA is the signer — `subscriber.owner` in the terms is the **EOA**, not the smart account address.

## Delegation signing

A delegation is an EIP-712-signed message granting a delegate (the org / the agent) permission to execute on behalf of the delegator, bounded by the caveat.

Flow:

1. The UI / script builds the readable agreement JSON (the human-readable terms) and pins it to IPFS.
2. The delegation payload is constructed via the SDK with the `erc20PeriodTransfer` scope and a **salt = `keccak256(terms)`**.
3. The subscriber signs the delegation (EIP-712).
4. The signed delegation is stored client-side (`data/subscriptions.json` for CLI, `localStorage` for web).

**Hard rules**:

- The `terms` are computed once and **never modified after signing** — tampering changes the salt and invalidates the signature. The salt binds the signature to the exact pinned agreement.
- The delegate (org or agent) is set at signing time and cannot be reassigned without a new signature.
- Never reuse a delegation signature across chains or across distinct terms.

## Execution under delegation

- **Direct (the delegate redeems)**: the org EOA — or the agent wallet, for a strategy mandate — sends a plain tx to the `DelegationManager` (`redeemDelegations`) with the signed delegation + the execution. The caveat caps the pull. **This is the only redemption path in the repo.** The redeeming party must hold native gas on the chain; funding that wallet is an explicit, separate step, never bundled into another consent.
- **Revoke**: the subscriber calls `disableDelegation` (a user operation from the Hybrid smart account, needs a bundler + a little ETH). After revoke, any further charge reverts with `CannotUseADisabledDelegation`.

Where a flow has both a happy path and a revert path, demonstrate both.

## Storage

- Smart account addresses and signed delegations → `data/subscriptions.json` (CLI) or `localStorage` (web). Never in code.
- The POC does not require on-chain delegation publication. If a future task requires it, that's a new decision documented as an ADR.

## Testing

- Smart account flow: an integration path that walks create → sign → charge → (revoke) end-to-end on the target testnet.
- The web demo flow must work end-to-end without manual intervention beyond the user signing.

## Review

- Any Solidity change → `contract-reviewer` agent.
- Web / SDK usage → `ui-reviewer` agent, plus a manual check of SDK usage against the official docs.
