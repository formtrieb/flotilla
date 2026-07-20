# The wave-execution skills run on a single Workflow-driver, with a shared invocable `wave-shared` skill

The four wave-execution skills (`wave-shared`, `wave-start`, `wave-reviewer`, `wave-close`) are driven by **one dispatch mechanism — the Claude-Code Workflow tool** — not the Ur's dual *Workflow-driver-vs-prose-loop* selector. `wave-start` authors and runs a Workflow script that fans out Worker and Reviewer subagents via `agent({ schema, isolation: 'worktree' })`: each return is **schema-validated structurally at the tool boundary**, each Worker runs in its **own isolated worktree**, and the rows run **in parallel** under the tool's concurrency cap. The **deterministic routing** (`verdictToEvent` / `outcomeToEvent` → `transition` → spine write) stays in the **Coordinator skill** via engine CLI verbs, because a Workflow script can neither import nor shell the engine. Shared material lives in a dedicated **`wave-shared` skill** with `disable-model-invocation: true` (invoked by name, never auto-triggered), and a **`skill-schema-drift`** vitest guard checks the inlined schema literals against the engine consts.

## The routing / fan-out split (the load-bearing constraint)

A Workflow script is plain JavaScript with **no filesystem, Node, or shell access** — it can only call `agent()` / `parallel()` / `pipeline()`. So:

- **Fan-out** (run N Workers/Reviewers, isolated + parallel + schema-validated) is what the Workflow tool does, and is delegated to it.
- **Routing** (`verdictToEvent` / `outcomeToEvent` → the `transition` state machine → the atomic spine write, then the one-way coarse projection) is pure engine code. It **cannot** live in the Workflow script (no import, no shell); inlining it would duplicate the whole state machine — a far larger drift surface than the schema literals. So routing stays in the **Coordinator skill**, which shells the engine CLI between fan-out rounds.

A round is therefore: Coordinator reads the spine → runs a Workflow that returns the compact, schema-bounded `WorkerReport[]` / `ReviewerVerdict[]` → Coordinator routes each via CLI and writes the spine (WAL) → cap=1 re-dispatch loops back. The Coordinator never ingests full subagent transcripts.

## Why a single Workflow-driver, not the Ur's selector

- **ADR-0009 names the schema-validated-subagent-return as the anti-fabrication (G3) guarantee.** `agent({ schema })` is the *structural* form of it — the model is forced to retry on a schema mismatch at the tool boundary. A prose-loop recovers the guarantee only *procedurally* (capture prose → post-hoc CLI validate → manual re-dispatch), re-opening exactly the G3 gap the `WorkerReport` / `ReviewerVerdict` schemas were built to close.
- **Worktree isolation + parallel fan-out is the product.** CHARTER: "dispatch parallel AFK agents in isolated worktrees." The Workflow tool does this natively (`isolation: 'worktree'`, concurrency cap). A prose-loop would orchestrate `git worktree add` by hand — the most fragile thing to get right in an unattended run.
- **Coordinator offload — the Ur's actual reason for its Workflow-driver — favours making it the default, not keeping a selector.** The Workflow runs in the background and returns only compact structured results, so the Coordinator's context never fills with Worker transcripts. That offload helps at *every* wave size. The Ur gated the Workflow-driver behind an `n≥4 + disjoint + low-risk` heuristic only because it bolted the driver onto a pre-existing prose-loop; flotilla is greenfield and makes the offloading mechanism the sole path. A second code-path + a selector heuristic + the Ur's dogfood-unsafe carve-outs are precisely the complexity [ADR-0016](0016-spine-creation-is-an-engine-owned-renderspine.md) is reducing (it already dropped the express variant and simplified dispatch-order).

## `wave-shared` is an invocable skill, not a references folder

The two schema literals (`WORKER_REPORT_JSON_SCHEMA`, `REVIEWER_VERDICT_JSON_SCHEMA`) must be **inlined as text** into the Workflow script, because the tool cannot import the engine. They live **once**, in `wave-shared` (the canonical inlined copy), alongside the host/auth-preflight convention, the routing chain, and the atomic-spine-write-per-flip discipline. `wave-start` / `wave-reviewer` / `wave-close` each open by invoking `/wave-shared` (project-local; `/flotilla:wave-shared` once packaged as a plugin) to load the shared contract.

This is the Claude-Code best-practice for cross-skill shared material in a plugin — **name-based composition**, verified against the docs (2026-06-19): a dedicated skill with `disable-model-invocation: true` so it is **never auto-triggered** (no description-matching pollution), only explicitly loaded. It is deliberately **not** the Ur's `wave-shared/references/` folder read cross-skill by relative path: cross-skill relative paths couple on-disk layout and are brittle under plugin distribution, whereas a named invocation loads the skill's body as a coherent unit. The `skill-schema-drift` guard reads the literal from this **one** place.

## Considered Options

- **Single Workflow-driver + Coordinator-CLI routing** (chosen) — structural schema guarantee, native worktree isolation, always-offloaded, one code path. Cost: the inlined schemas require a `skill-schema-drift` guard.
- **Coordinator-driven prose-loop, schema validated via CLI** (rejected) — single source of truth (no inlined schema, no drift guard), but **no Coordinator offload** (every Worker/Reviewer transcript lands in the Coordinator context — the large-wave pressure the Ur's driver solved), worktree orchestration by hand, and the schema guarantee is only procedural (post-hoc), not structural.
- **The Ur's dual Workflow-driver-vs-prose-loop selector** (rejected) — two code paths + an `n≥k` heuristic + dogfood-unsafe carve-outs. The offload benefit is *why to make the Workflow-driver the default*, not why to keep a second path.

## Consequences

- **The engine gains thin routing CLI verbs** so the Coordinator routes without importing: `verdictToEvent`, `transition` (state machine), `outcomeToEvent`, and `validate-worker-report` / `validate-reviewer-verdict` — each a thin wrapper over the existing library export (which is the single source of truth and stays unit-tested).
- **A `skill-schema-drift` vitest spec** extracts the inlined literals from `wave-shared` by fence-comment anchors, parses them, and deep-equals them against `WORKER_REPORT_JSON_SCHEMA` / `REVIEWER_VERDICT_JSON_SCHEMA`; it fails loud on extraction failure or any structural diff. Pure test, zero production change — the Ur's `#78` guard, re-homed. (Distinct from the spine, which needs **no** such guard because its printer is engine-owned — ADR-0016.)
- **`wave-shared` ships with `disable-model-invocation: true`;** the other three execution skills open by invoking it.
- **`wave-start` is a stateful loop, not a one-pass dispatcher** — it routes reviewer verdicts through the cap=1 re-dispatch state machine ([ADR-0005](0005-pr-route-protected-main-merge-terminality.md) amendment), so it re-runs the fan-out for `re-dispatched` rows until each is `approved`, `pr-created`, or STOPed → `needs-attention`.
- **A prose-loop fast-path for trivial 1–2-issue waves is a clean M2 addition** if the Workflow setup overhead ever bites — deliberately not pre-built (YAGNI).
- **The mechanism is harness-bound to Claude-Code's Workflow tool.** This is consistent with ADR-0009 (the skills *are* the Claude-Code driver; the engine stays harness-agnostic). A future non-Claude-Code consumer would re-author the driver skill against its own primitive — the engine CLI surface it shells does not change.

## Amended — the driver gains a persistence duty ([ADR-0024](0024-sidecars-are-written-at-agent-return-by-scribes-through-paired-write-verbs.md), 2026-07-19)

The routing/fan-out split above left sidecar persistence with the Coordinator, *after* the Workflow returned — the M1 live gate (retro P-1) showed that makes the real WAL ≠ the assumed WAL: a Coordinator death mid-wave leaves zero durable records despite finished Workers. ADR-0024 moves the write into the driver: the pipeline gains two cheap **Scribe** `agent()` stages (`worker → scribe(report) → reviewer → scribe(verdict)`) that invoke the paired engine verbs `write-report`/`write-verdict` with the already-schema-validated payload — a Workflow script has no fs/shell, so a subagent is the only in-driver write path. Coordinator routing is unchanged; the old bundled post-routing write is forbidden.
