# 0008 — 0G Tapp is not an agent-hosting product; correcting the 0G integration surface

**Status:** Accepted
**Date:** 2026-07-26
**Triggered by:** user request — "arrête d'inventer", then a review of the 0G decisions

## Context

`docs/AGENT_EXECUTION_PLAN.md` selected **0G Tapp** as the host for the agent runtime,
and described an architecture on top of it: one Tapp instance per mandate keyed on the
`delegationHash`, a signing key derived by HKDF from a deployer-assigned `app_id`, an
address stable across redeploys, and `GetEvidence` attestation binding that address to a
measured deployment.

**None of that was verified.** It was assembled from an LLM summarising the `0g-tapp`
README, relayed as fact. The user called it out. Checking the primary sources changes the
picture.

Measured against the full documentation corpus (`https://docs.0g.ai/llms-full.txt`,
603 KB, fetched 2026-07-26):

- `sandbox` — **0 occurrences**
- `tapp` — **2 occurrences**, both in the *inference provider* section under "TEE Node
  Setup", listing **NVIDIA H100 or H200 with TEE support** as the hardware requirement,
  and offering Dstack or 0G-TAPP as two ways to stand up that node.

Cross-checked against 0G's own agent tooling:

- `0gfoundation/0g-agent-skills` — 14 task guides (storage, compute, chain, cross-layer)
  and 6 pattern files. **No mention of tapp or sandbox.**
- `0gfoundation/0g-compute-skills` — inference, fine-tuning, account management.
  Same absence.
- `https://build.0g.ai/zero-coding`, 0G's own "build without writing code" landing page —
  **0 occurrences of tapp or sandbox**. The toolkit it advertises is exactly: the
  `ai-context` / `llms.txt` docs, the two skill repos above, and the
  `@0gfoundation/0g-cc` MCP server ("AI inference, file storage, and data availability"
  in your coding environment).

Three independent official surfaces, none of which offers a way to host an agent.

So Tapp is the tooling to **become a GPU inference provider on 0G Compute**. It is not a
product for deploying an arbitrary application into a TEE, and 0G publishes no such
product.

One thing does hold, verified by direct request rather than summary: the 0G Sandbox
broker at `https://private-sandbox-testnet.0g.ai` is live, returning chain 16602, a
billing contract, a `TappRegistry` address, and one registered provider with pricing. It
is real — it is simply absent from all official documentation.

## Decision

**0G Tapp is not the host for the agent runtime, and no 0G product is.** The supported
0G developer surface is **Compute, Storage, Chain and DA** — services you call, not a
place to run your agent.

The agent runtime host is therefore an open question again, with two candidates and no
0G-supported third:

- **0G Sandbox** — live and reachable, officially undocumented, onboarded through a
  Claude Code plugin. Usable, unsupported.
- **Self-hosted** — Hourglass runs the process and holds the agent key.

Every claim in the plan that rested on Tapp internals (`app_id` derivation, address
stability across redeploy, `GetSecretResource`, `GetEvidence`) is withdrawn.

## Alternatives considered

- **Keep Tapp and run our own TEE node** — the documented path needs an H100/H200 with
  TEE support. Out of proportion for a hackathon demo, and it makes us an inference
  provider, which is not the product.
- **Treat the undocumented Sandbox as the decided host** — it is live, but committing to
  a product with zero documentation and no stability guarantee is the same mistake at a
  different address. It stays a candidate to be tested, not a decision.

## Consequences

**Positive:**

- The plan no longer rests on unverified summaries. What remains — flow states, ordering
  constraints, the app surface, the service boundary, phases 1–2 — was never
  host-dependent and stands unchanged.
- The 0G integration that is real and verified (Compute: live router, 23 models,
  OpenAI-compatible, catalogue read directly) is separated from the one that was
  imagined.

**Negative:**

- The non-custodial property is at risk again. If the host ends up self-hosted, Hourglass
  holds the agent key, contradicting *"Hourglass never holds your keys and never runs the
  agent for you"* in `skills/hourglass-agent/SKILL.md`. That contradiction needs its own
  decision before shipping — it is not a detail.
- "The agent runs in a TEE" is not currently a claim this repo can make.

**Neutral (worth knowing):**

- ADR 0007 (agent gas self-funded post-signature) is unaffected. It never depended on the
  host: the agent pays its own gas wherever it runs.
- The Sandbox endpoint table in the plan stays — those values were curled, not summarised.

## Method note

The failure mode was relaying `WebFetch` summaries of a README as verified fact. Primary
sources for this repo's 0G work: `https://docs.0g.ai/llms-full.txt` and
`https://docs.0g.ai/ai-context.md` (raw markdown, not the rendered page), and the
upstream repositories read directly. Summaries are a lead, not evidence.

## References

- Related ADR: `.claude/choices/0007-agent-gas-is-self-funded-post-signature.md`
- Related doc: `docs/AGENT_EXECUTION_PLAN.md`, `docs/0G-INTEGRATION-MAP.md`, `docs/doc-0G.md`
- Vendored: `.claude/skills/0g-compute/`, `.claude/skills/0g-agent-reference/`
