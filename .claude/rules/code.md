# Code rules

These apply to all code in the repo: Solidity, TypeScript, scripts.

## Separation of concerns

The codebase has three layers. Mixing them is a defect.

| Layer | Responsibility | Examples |
|---|---|---|
| **Domain / contracts** | On-chain state and invariants. Pure business logic. | `contracts/src/*.sol` |
| **Services** | Off-chain logic that talks to chain, the delegation toolkit, IPFS. No UI concerns. | `packages/core/src/*.ts` |
| **Presentation** | React components, hooks, pages. No business logic, no direct chain calls. | `packages/web/src/*.tsx` |

Rules:

- A component **never** calls a contract or external API directly. It calls a hook, which calls a service.
- A service **never** imports from React. Services are pure TypeScript modules, testable without a DOM.
- A hook is the only thing allowed to bridge the two: it owns lifecycle (state, effect) and calls services.
- A contract **never** knows about a UI or a service. The contract is the authority.

If a file mixes layers, split it.

## OOP, used deliberately

OOP is a tool, not a default. Use it when:

- The thing has identity + state + behavior that travel together (e.g., a `WalletConnection` service that holds a provider and exposes methods).
- You need polymorphism (e.g., multiple chain providers behind the same interface).
- A test needs to swap an implementation (constructor injection > module-level mocks).

Do **not** use OOP when:

- A pure function is enough. A `formatDomain(domain: string): string` is a function, not a `DomainFormatter` class.
- The class would have zero state and one method. That is a function in a hat.

In Solidity, OOP = contracts and libraries. Inheritance is allowed only when it reduces duplication of substantial logic. Diamond/proxy patterns are out of scope for this POC.

## TypeScript hard rules

- `strict: true` in `tsconfig.json`. Non-negotiable.
- **No `any`.** If you reach for `any`, the type is wrong or the boundary is unmodeled. Use `unknown` and narrow.
- **No `as` casts without a comment** explaining why the cast is safe. The comment is one line, factual, not an apology.
- Prefer named types over inline shapes when reused. Inline is fine for one-shot locals.
- Discriminated unions over boolean flags when state has more than two values.
- No default exports for components or services. Named exports only — easier to grep, easier to refactor.

## Naming

- Files: `kebab-case.ts` / `kebab-case.tsx` for everything except React components, which are `PascalCase.tsx`.
- Functions and variables: `camelCase`. Booleans start with `is/has/can/should`.
- Types and classes: `PascalCase`. Enums: `PascalCase` for the type, `SCREAMING_SNAKE_CASE` for members.
- Constants: `SCREAMING_SNAKE_CASE` when truly constant (config values). Module-level immutables holding computed values stay `camelCase`.

## No dead weight

- No commented-out code. Git remembers.
- No `TODO` without a ticket reference or a date. `// TODO(maxime, 2026-06): handle pagination` is acceptable. `// TODO: fix this` is not.
- No console.logs in committed code. Use a debug flag or remove.
- No unused exports, unused imports, unused parameters (use `_name` if the signature requires it).

## Comments

Default to **no comments**. The code's identifiers should explain what. Add a comment only when:

- The **why** is non-obvious and a reader would otherwise misread the intent.
- There is a hidden constraint or invariant (e.g., "this map iteration order matters because of off-chain indexer").
- A workaround exists for a specific upstream bug.

Never write a comment that restates the next line of code. Never write a multi-paragraph docstring on a function whose name and signature are self-evident.

NatSpec on Solidity public/external functions is the exception (it generates ABI docs). See `solidity.md`.

## Error handling

- Validate at boundaries (user input, contract input, external API responses). Trust internal calls.
- Surface errors as typed values when the caller is expected to handle them (`Result<T, E>` pattern in TS, custom errors in Solidity). Throw only for programmer mistakes or unrecoverable states.
- No empty `catch` blocks. If you catch, you must do something — log, retype, rethrow.

## Testing is part of the code

A function shipped without tests is not done. Coverage targets:

- Contracts: 100% line + branch coverage on the public surface. Fuzz where inputs are unbounded.
- Services: every public function has a unit test. Mock at the network boundary only.
- Hooks and components: tested behaviorally, not by checking implementation details. React Testing Library or equivalent, not enzyme-style snapshots.

A test that is hard to write usually points at a design that mixed layers. Refactor, don't bury.
