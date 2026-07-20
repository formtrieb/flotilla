# Harness-agnostic engine + Claude-Code skill driver; no `DispatchHost`

flotilla is **(a)** a pure TypeScript **engine** that imports only `node:*` + `fast-glob` + `micromatch` — no Workflow/Agent/MCP primitives — plus **(b)** a Claude-Code **skill driver** that holds the entire harness coupling (the dispatch layer: `agent({schema, isolation:'worktree'})`, `pipeline()`, journal-resume). There is **no `DispatchHost` abstraction** between them.

## Why

A grep proved the engine is *already* harness-agnostic — it never reaches a dispatch primitive. The Claude-Code coupling lives entirely in the skill prose. Inserting a `DispatchHost` adapter would let a non-Claude orchestrator drive the same engine, but flotilla ships no such driver (YAGNI until a real second harness appears) and the abstraction has a concrete cost: it would **weaken the anti-fabrication guarantee** (ADR-0004), which is a property of the Claude-Code driver — the Workflow tool enforces the JSON schema at dispatch. The engine *provides* the schemas (`worker-report-schema`, `reviewer-verdict-schema`) as pure validators; the harness *enforces* them. An abstract dispatch host would move enforcement behind an interface that cannot promise it.

## Considered Options

- **Harness-agnostic engine + skills as the sole driver, no `DispatchHost`** (chosen).
- **A `DispatchHost` adapter** (rejected) — speculative generality for a non-Claude orchestrator that does not exist, at the price of weakening the schema-enforced anti-fabrication guarantee for zero present benefit.

## Consequences

- flotilla's external consumers are **other Claude Code users** — not a limitation but the value proposition (AFK-agent orchestration *under Claude Code*).
- The engine stays the only surface kept manually in sync with the Ur; the skills diverge freely (rewritten generic against GitHub + `IssueStore` + protected-main).
- The schema-validated subagent return (the fabrication-prevention guarantee, ADR-0004) is kept as a driver property and must not be abstracted away.
