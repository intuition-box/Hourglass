---
name: 0g-agent-reference
description: Reference patterns for building on 0G (Zero Gravity) — network configs and chain IDs, 0G Storage upload/download and Merkle verification, 0G Compute inference and fine-tuning, contract deployment on 0G Chain, and cross-layer flows. Use when writing code against 0G Storage (@0glabs/0g-ts-sdk), 0G Compute (0g-serving-broker), or 0G Chain, or when you need 0G network parameters, RPC endpoints, or SDK call shapes.
---

# 0G agent reference

Vendored from [0gfoundation/0g-agent-skills](https://github.com/0gfoundation/0g-agent-skills)
(snapshot 2026-07-26). The upstream files carry no YAML frontmatter, so they are not
loadable as skills on their own — they are reference documents, wrapped here.

**Do not follow the upstream INSTALL.md.** It copies its own `CLAUDE.md` and `skills/`
to the project root, which would overwrite this repo's project context and its
`skills/hourglass-agent/`.

## Scope check before using any of this

Hourglass mandates execute on **Base mainnet (8453)** and Ethereum mainnet — that is
where the HourGlass enforcers and the Uniswap liquidity live. 0G Chain (16661) is not a
target and nothing in this repo deploys there. Treat these references as guidance for
talking to 0G *services* (Compute, Storage), not as a reason to move any contract.

## References

**Patterns** — `references/patterns/`

| File | Covers |
|---|---|
| `NETWORK_CONFIG.md` | chain IDs, RPC endpoints, explorers, faucet |
| `STORAGE.md` | 0G Storage SDK shapes |
| `COMPUTE.md` | 0G Compute broker shapes |
| `CHAIN.md` | EVM deployment on 0G Chain |
| `SECURITY.md` | key handling, env, common pitfalls |
| `TESTING.md` | test patterns |

**Task guides** — `references/skills/<category>/<name>/SKILL.md`

- `storage/` — upload-file, download-file, merkle-verification
- `compute/` — account-management, provider-discovery, streaming-chat, fine-tuning,
  text-to-image, speech-to-text
- `chain/` — scaffold-project, deploy-contract, interact-contract
- `cross-layer/` — compute-plus-storage, storage-plus-chain

For 0G Compute specifically, prefer the `0g-compute` skill in this repo — it is the
upstream's own maintained skill, with proper frontmatter and deeper references.

## SDK naming

These docs use the `@0glabs/*` package names (`@0glabs/0g-ts-sdk`,
`@0glabs/0g-serving-broker`). The current 0G documentation publishes
`@0gfoundation/0g-storage-ts-sdk` and `@0gfoundation/0g-compute-ts-sdk`. Check which
resolves before installing — the snapshot may lag the registry.
