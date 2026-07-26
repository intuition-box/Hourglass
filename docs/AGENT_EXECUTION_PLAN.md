# Agent execution rail — implementation plan

**Scope: limit order only.** DCA is disconnected (`FUTURE.md`). Gas model is settled by
ADR 0007. This plan covers making a limit order run without the operator holding a key
or keeping a terminal open.

## What changes

Today the operator pastes an address they generated locally, then runs
`skills/hourglass-agent/scripts/run-limit-order.ts` and keeps the process alive.

After: the app provisions the agent, the operator signs and funds, the runtime polls.
and fills. The manual path stays — it becomes one of two options, not the only one.

## Flow and states

```
draft ──▶ provisioned ──▶ signed ──▶ funded ──▶ watching ──▶ filled
          (agent addr)    (mandate    (agent     (runtime     (once,
                           on graph)   has gas)   polling)     limitedCalls(1))
```

| Transition | Trigger | Who acts |
|---|---|---|
| draft → provisioned | "Execute by an agent" | app → runtime |
| provisioned → signed | mandate signed to the agent address | operator (Safe, threshold) |
| signed → funded | ETH top-up to the agent wallet | operator (Safe, separate tx) |
| funded → watching | runtime starts | runtime |
| watching → filled | quote ≥ `minReceived` | runtime |

Two hard ordering constraints:

- **Provision before signing.** The mandate's delegate is the agent address; it must
  exist first.
- **Fund after signing, before watching.** ADR 0007. Its own Safe transaction — never
  bundled with the Permit2 "Enable trading" step.

## Needs

### App (`src/`)

- Mode selector in the Limit order tab: *run it myself* (current) / *delegate to an
  agent* (new). Manual mode unchanged.
- Provisioning call returning `{ agentAddress, runtimeRef }` — blocks until an address
  exists, surfaces failure.
- Agent address feeds the existing mandate build unchanged. It is already just the
  delegate; no change to terms, salt, caveats or the signing path.
- **Fund step** after signature: a Safe ETH transfer to `agentAddress`, its own
  transaction and its own consent. Suggested amount = one redeem + margin (ADR 0007 —
  the top-up size *is* the loss ceiling).
- **Balance gate**: `watching` is unreachable while the agent balance is zero. Replaces
  the local check the skill does today.
- Status surface per mandate, driven by the states above.

### Runtime

- Long-lived process executing the logic already in `run-limit-order.ts`: discover on
  Intuition by `delegationHash`, poll the Uniswap quote, redeem once when
  `quote.output ≥ minReceived`.
- Holds `AGENT_PRIVATE_KEY` and `UNISWAP_API_KEY`. **The Uniswap key is Hourglass's own,
  supplied to the runtime** — decided 2026-07-25. One shared key across mandates; its
  cost and rate limits are a later problem, explicitly not designed for here.
- Stable agent address across restarts and redeploys — the mandate is signed to it.
- **Dies on revocation.** Each poll iteration checks the mandate's disabled state on the
  `DelegationManager` before quoting. Disabled means the instance exits — it has nothing
  left it is allowed to do, and a redeem would revert with `CannotUseADisabledDelegation`
  anyway. No new surface: the runtime already talks to that contract.
- **No status endpoint.** The runtime is *triggered*, not polled: the app starts it and
  reads progress from what already exists — the mandate on Intuition, the fill on-chain.
  Decided 2026-07-25.

### Service boundary

Per `code.md`, the runtime host sits behind one service interface so the app never
depends on which host is chosen:

```ts
provision(chainId): Promise<{ agentAddress: Address; runtimeRef: string }>
start(runtimeRef, instruction): Promise<void>
status(runtimeRef): Promise<AgentState>
```

**The host is undecided** (ADR 0008). Two candidates implement this interface —
0G Sandbox and self-hosted. Phases 1–2 build against the interface and are unaffected by
which wins.

## Phases

**Phase 0 — find a host (blocking).**
Per ADR 0008, **0G publishes no product for hosting an agent.** Tapp is the tooling to
become a GPU inference provider (H100/H200 hardware), not an application platform, and
the earlier plan built on it is withdrawn. Two candidates remain:

- **0G Sandbox** — live and reachable (endpoints below, curled not summarised), but
  absent from every official surface: 0 mentions in the docs corpus, in `0g-agent-skills`,
  in `0g-compute-skills`, or on `build.0g.ai/zero-coding`. Test whether a long-lived
  process can run in it, hold a key, and survive a restart.
- **Self-hosted** — Hourglass runs the process. Works today, but Hourglass then holds the
  agent key.

What phase 0 has to answer, for whichever candidate: can the runtime hold a signing key
the operator never sees, keep the **same address** across a restart (the mandate is
signed to it), and stay alive while a limit order waits for its price.

**Phase 1 — app surface, mocked runtime.**
Mode selector, provisioning call, fund step, balance gate, status display. Runtime
interface backed by a stub returning a local throwaway address. Ships and demos without
any host decision.

**Phase 2 — runtime process.**
Package `run-limit-order.ts` as a long-lived service against the interface. Runs locally
first.

**Phase 3 — host integration.**
Implement the interface for whichever host phase 0 selects. Deploy. End-to-end on Base
with a real mandate.

## One runtime instance per mandate

Host-independent shape. **One instance per mandate, keyed on the `delegationHash`**,
living exactly as long as its authorization: provisioned at "execute with agent", it
polls, fills once (`limitedCalls(1)`), and dies.

Why this shape:

- The runtime lifetime mirrors the mandate's on-chain authorization. Nothing outlives
  what it is allowed to do: it exits on fill, and on revocation.
- Each mandate has its own key and its own gas. No cross-mandate blast radius, and
  revocation is just letting the instance die.
- The address is read once at provisioning, signed into the mandate, used once.

**The cost this shape carries:** a limit order waits for its trigger price, possibly for
weeks, and the instance must survive that wait — so **restart stability** and **idle
cost** are properties the host must have, whichever it is. If the wait needs bounding, a
`TimestampEnforcer` on the mandate gives it a deadline (same primitive the abandonment
sweep needs, `FUTURE.md [COST]`).

Neither bites at demo scale: a demo order fills in minutes. Restart stability still gets
measured in phase 0 — cheap to check, expensive to discover later.

## Trigger, not polling

The runtime starts on an explicit trigger, and the natural one is **the end of the
"execute with agent" signing step**. A manual re-trigger must also exist, and must work
**without a page reload** — a mandate signed in an earlier session has to be startable.

The Intuition indexing race the skill warns about (*"not found on Intuition yet"*) is
absorbed by the flow itself: the fund step sits between signing and starting, and takes
longer than indexing. No retry loop needed at the trigger.

## Open decisions

**Blocking phase 3:**

- **The host itself** (ADR 0008). No 0G product hosts agents. If phase 0 lands on
  self-hosted, Hourglass holds the agent key — contradicting *"Hourglass never holds your
  keys and never runs the agent for you"* in `skills/hourglass-agent/SKILL.md`. That
  contradiction needs its own decision before shipping, and it also removes any claim
  that the agent runs in a TEE.

**Non-blocking:**

- Gas residue has no return path — accepted for v1, deferred (`FUTURE.md [COST]`).

## Out of scope

- Relayers and gas abstraction (ADR 0007).
- DCA (`FUTURE.md [DCA]`).
- Agentic ID / ERC-8004 identity for the agent (`docs/0G-INTEGRATION-MAP.md`).
- Moving IPFS pinning to 0G Storage — breaks CID-based discovery
  (`docs/0G-INTEGRATION-MAP.md §2.4`).

## Proven end to end (2026-07-26)

A 0G Compute model drove a live limit order to a fill on Base mainnet, unattended.

| | |
|---|---|
| Redeem tx | `0xa55b7c5b7c6daca96feef287000904f3e36fe677c5a1d3ef00835a7560e5efb4` |
| Block / gas | 49117693, 442,519 gas, status success |
| `from` | `0x26fdbb73d95D5F62bdc9EbA78Ee33D1494C4229f` — the agent |
| `to` | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` — DelegationManager |
| Safe | `0x4f6ccab34C8dCD7722FeD01DCCd09FaBdfD391bF`, USDC 7.4050 → 6.4050, WETH +0.004575 |
| Model | `0gm-1.0-35b-a3b` via `https://router-api.0g.ai/v1` |

The model generated its own keypair (`cast wallet new`, verified to derive its address
and to carry real entropy), discovered the mandate on Intuition by `delegationHash`,
decoded the on-chain bounds, derived its own fill threshold — 0.000526 WETH for a 1900
trigger — quoted Uniswap, and redeemed once `0.000533 ≥ 0.000526`.

The `from` is the point: the transaction originates from the agent, not the Safe, and
the bought WETH landed in the Safe. The spend came to exactly the 1 USDC cap.

Three human actions, no more: sign the mandate, fund the gas, hand over the recap.

**What this demonstrates.** The same model measured elsewhere in this repo substitutes
tokens silently and obeys prompt injection (`server/mandate-assistant.ts` history). It
drove a DAO treasury anyway, and the caveats held. That is a stronger claim than running
the agent in a TEE: it needs no trust in the agent at all.

## What 0G actually offers

Verified against primary sources (ADR 0008). Two separate things, do not conflate them:

**Supported and live — services you call.** 0G Compute (router at
`https://router-api.0g.ai/v1`, 23 models, OpenAI- and Anthropic-compatible, catalogue
read directly), 0G Storage, 0G Chain, 0G DA. The official builder toolkit is the
`ai-context` / `llms.txt` docs, the two skill repos vendored under `.claude/skills/`, and
the `@0gfoundation/0g-cc` MCP server.

**Not offered — a place to run your agent.** No 0G product hosts an application. If the
demo needs a 0G integration that is defensible, it is Compute or Storage, not hosting.

## 0G Sandbox — verified endpoints (2026-07-25)

Curled directly, not summarised. Live, but officially undocumented — a phase 0 candidate,
not a decision.

| | |
|---|---|
| Broker | `https://private-sandbox-testnet.0g.ai` |
| Chain | 16602 (0G testnet), RPC `https://evmrpc-testnet.0g.ai` |
| Billing contract | `0x3490B9053AC46F7Bf71A1ceBffcB2be2C1405b41` |
| TappRegistry | `0x2Ce80374318B1d7Fb3345724457a182E0ad165c9` |
| Provider | `0xf982279B872B9a99d64C547a0faC2Dfdfc2AEE5D` — `https://provider-private-sandbox.0g.ai` |

Pricing read from `/api/providers`: create fee **0.06 0G**, then **0.001 0G per CPU per
minute** and **0.0005 0G per GB per minute**. A 1 CPU / 1 GB sandbox costs ~0.09 0G an
hour on top of the create fee.

The faucet gives 0.1 0G per wallet per day, which does not cover one hour of sandbox —
use the event promo code to top up before starting.

Onboarding is a Claude Code plugin:

```
/plugin marketplace add 0gfoundation/0g-sandbox
/plugin install 0g-private-sandbox@0g-sandbox
/0g-private-sandbox
```

Note the split: the sandbox bills on 0G testnet, while the mandate it executes lives on
Base mainnet (the HourGlass enforcers are deployed on chains 1 and 8453 only). The
sandbox is compute — it does not care which chain the workload talks to.

## References

- ADR: `.claude/choices/0007-agent-gas-is-self-funded-post-signature.md`
- `docs/0G-INTEGRATION-MAP.md` — host options, what 0G does and does not cover
- `skills/hourglass-agent/SKILL.md`, `scripts/run-limit-order.ts` — the logic being hosted
- `FUTURE.md` — `[COST]` gas residue, `[DCA]` deferred rail
