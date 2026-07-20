# flotilla

> **Portable, Claude-Code-native wave-orchestration toolkit.** Plan a batch of independently-grabbable issues, dispatch parallel AFK agents in isolated worktrees, review each with a schema-validated verdict, land via PRs — with cross-wave **conflict/parallelism reasoning** as the universal core.

## What flotilla is

flotilla turns a backlog of tracker issues into a **wave**: a batch of independently-grabbable work items that a Coordinator plans, then dispatches to parallel AFK (away-from-keyboard) agents, each isolated in its own git worktree. Every agent's work is reviewed by a second, universal Reviewer agent before anything lands — the review returns a schema-validated verdict, not free prose, so routing to approve / request-changes / stop is deterministic rather than inferred. Landing happens via pull requests against a protected default branch; nothing is ever pushed directly to it.

The pipeline end to end:

```
triage → to-prd → to-issues → wave-plan → wave-create → wave-start → wave-close
```

Planning tools (`triage` / `to-prd` / `to-issues`) turn a raw idea or bug report into wave-eligible issues carrying a declared file scope. `wave-plan` draws the eligible candidate set and checks it against everything another wave already has claimed. `wave-create` materializes an approved batch into a durable orchestration spine. `wave-start` dispatches Workers and Reviewers and ends every row in-review — it never merges. `wave-close` computes an advisory merge order, cleans up worktrees, and archives the spine. If a Coordinator dies mid-wave, `wave-resume` reconstructs state from the spine, the live worktrees, and on-disk sidecars, and picks up where it left off.

The thing that stays true regardless of stack or tracker is the **conflict/parallelism reasoning**: every issue declares the file globs it touches, and a pure set-intersection over those globs answers *"how much work goes into one wave, and can two waves run side by side?"* Everything else — which tracker, which verify commands, which code host — is an adapter around that core.

## Architecture in one screen

flotilla is two layers: a pure engine that is already harness-agnostic, and adapters that diverge freely per consumer.

- **Engine** (`tools/wave/`) — plain TypeScript importing only `node:*` + `fast-glob` + `micromatch`. It ships as raw source with no build step (`tsc --noEmit` is the type gate). It owns the state machine, the conflict-map math, the merge-order algorithm, the DoR (definition-of-ready) validator, and the schemas that a Worker's report and a Reviewer's verdict must satisfy.
- **Canonical contract: `IssueView`.** The engine never knows where an issue comes from — every adapter's whole job is `read(id) → IssueView` (id, risk, worker, declared files, blocked-by, acceptance criteria, coarse status). Field-mapping to a tracker's native shape (labels, body sections, custom fields) is entirely the adapter's business.
- **`IssueStore`** — `create · read · transition · close · listOpen`, plus facets for triage state, needs-attention flagging, closing-probe reads, and minimal authored-content amends. Shipped implementations: `MarkdownFsStore` (local dev/dogfood), `GitHubIssuesStore`, and `LinearIssuesStore` — the same conformance suite passes unchanged across all three.
- **`SpineStore`** — the per-wave orchestration spine, kept as durable local markdown rather than tracker-native state. It is the write-ahead log a killed Coordinator resumes from.
- **Two-scope state.** The engine's fine-grained states (planned → dispatched → reviewed → approved → …) live only in the spine. A coarse projection — `available → queued → in-flight → in-review → done`, plus an orthogonal `needs-attention` flag — is written to the tracker so humans and concurrent waves can see what is claimed, without the tracker ever needing to understand the full state machine.
- **No dispatch-host abstraction.** The engine calls no agent-harness primitives; the Claude Code skills *are* the dispatch driver, and the schema-validated-subagent-return guarantee (agents cannot silently fabricate a result) is a property of that driver, deliberately kept out of the engine.
- **Cross-wave reasoning is the value.** `computeConflictMap` is wave-agnostic pure glob-set math — feed it `(candidate wave) ∪ (everything already queued or in-flight)` and it answers directly whether two waves can run side by side.

## Getting started

Adopting flotilla in your own repo (or your own project inside this one) starts with **[docs/ONBOARDING.md](docs/ONBOARDING.md)** — the vendor-copy adoption path, the preconditions checklist (tracker choice, host integration, protected-main, env keys), and what's on the roadmap versus what's built today.

Contributing to flotilla itself? Start with [CLAUDE.md](CLAUDE.md).

## License & provenance

flotilla is licensed under [Apache-2.0](LICENSE). Parts of it were seeded from other sources under their own terms — see [PROVENANCE.md](PROVENANCE.md) for the seed points and the retained upstream notices.
