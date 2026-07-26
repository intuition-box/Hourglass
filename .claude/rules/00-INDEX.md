# Rules index

Each rule file is self-contained. Load only those relevant to the current task — see the routing table in `CLAUDE.md`.

| File | Scope | Load when |
|---|---|---|
| `code.md` | Clean code, OOP, service/logic separation, no `any`, no dead code | Any task that writes or modifies code |
| `solidity.md` | Solidity 0.8+ patterns, NatSpec, custom errors, events, gas | Any task touching `contracts/` |
| `ui.md` | Typography-driven design, dark-first, anti-template rules | Any task touching `packages/web/` |
| `security.md` | Threat model checklist, when to invoke Trail of Bits | Any contract change or value-handling code |
| `workflow.md` | Git hygiene, scope discipline, communication style, change verification | Every task — load at start and at end |
| `metamask-delegation.md` | ERC-7710/7702 delegation, the `erc20PeriodTransfer` caveat, Smart Accounts Kit | Any work touching the MetaMask delegation surface (`packages/core`, `packages/web`, `scripts/`) |

## Update protocol

If a feedback loop with the user reveals a missing or wrong rule:

1. Edit the rule file.
2. Add an ADR in `.claude/choices/` describing what changed and why.
3. If the change came from a task post-mortem, link the post-mortem in the ADR.

Do not let rules silently drift. Every rule change is a recorded decision.
