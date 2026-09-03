# flotilla

> **Portable, Claude-Code-native wave-orchestration toolkit.** Plan a batch of independently-grabbable issues, dispatch parallel AFK agents in isolated worktrees, review each, land via PRs — with cross-wave **conflict/parallelism reasoning** as the universal core.
>
> **READ FIRST, every session:** [docs/CHARTER.md](docs/CHARTER.md) (architecture + the *why* behind every decision) and [CONTEXT.md](CONTEXT.md) (the domain glossary — read it before reaching for a term that isn't obviously self-explanatory). This file is only the standing orientation; the docs are the authority.

## Provenance — read this to avoid re-coupling to a predecessor's bindings

flotilla was **seeded by copy** from a predecessor wave-orchestration system (see [PROVENANCE.md](PROVENANCE.md) for the exact seed points) and generalized. That predecessor — referred to throughout the docs as **"the Ur"** — is frozen: it keeps its own bindings and is *not* a model to copy wholesale.

**Do not re-import Ur specifics** when working here:
- ❌ a framework-specific build toolchain, design-tokens, or a stack-specific Pure-I/O check layer
- ❌ markdown-files-as-issue-tracker plus a filesystem-move close ceremony
- ❌ an unprotected default branch with a manual fast-forward ritual

Those are the Ur's bindings. flotilla is **tracker-agnostic, protected-`main` / PR-route-default**, with GitHub Issues and Linear as its two shipped tracker adapters. If you find yourself reaching for an Ur habit, that is the signal to reach for the generic seam instead.

## Architecture in one screen (full detail: CHARTER §4–§10)

- **Two layers.** A pure TS **engine** (`tools/wave/`, imports only `node:*` + `fast-glob` + `micromatch` — already harness-agnostic; this is the only surface worth keeping in sync with a predecessor system) vs **adapters** (diverge freely per consumer). The header-parsing/body-codec logic that reads a tracker's native shape is an *adapter* concern, not engine.
- **Canonical contract:** `IssueView` — the engine never knows where an issue comes from.
- **`IssueStore`** = `create · read · transition · close · listOpen`, plus facets (triage state, needs-attention flag, closing-probe, minimal authored-content amend, and the Goal container with its derived frontier). Shipped impls: `MarkdownFsStore` (local dev/dogfood), `GitHubIssuesStore`, `LinearIssuesStore` — one conformance suite, unchanged across all three.
- **`SpineStore`** = the per-wave orchestration spine as **local markdown** (durable → enables resume). Not tracker-native.
- **Two-scope state:** the engine's fine-grained states live in the spine (Coordinator-internal); a **coarse projection** `available → queued → in-flight → in-review → done` (+ orthogonal `needs-attention`) is written to the tracker so humans / concurrent waves see what is claimed.
- **No dispatch-host abstraction.** The engine calls no agent-harness primitives; the **skills are the Claude-Code driver**. The schema-validated-subagent-return guarantee (a dispatched agent cannot silently fabricate a result) is a property of that driver — keep it there, don't fold it into the engine. *(2026-09-03 — clarification, not a change: the engine now ships that driver script as a package asset and composes it with `compose-driver`, which writes a file the harness then runs; that is file I/O, not dispatch, and the return guarantee stays a property of the script — [ADR-0009](docs/adr/0009-harness-agnostic-engine-no-dispatch-host.md).)*
- **Cross-wave reasoning is the value:** `computeConflictMap` is wave-agnostic; feed it `(candidate) ∪ (queued+in-flight)` to answer "can these waves run side-by-side?" `files-drift` is the runtime guarantor that declared globs hold.

## Conventions

- **Naming:** lowercase (`flotilla`, skill names, package). npm/CLI/cross-platform safety.
- **Branch model:** protected `main`, **PR-only landing for everything** — never direct-push to the default branch. The spine is branch-local and does not need to merge to `main`.
- **Engine ships raw TS, no build step** (`main: ./src/index.ts`, `tsc --noEmit` as the type gate). Standalone vitest; the ported spec files are the regression net and must stay green.
- **Skills are rewritten generic**, not placeholder-templated — a predecessor's skill logic is a reference to read, never a template to fill in.
- **Source form / Installed form:** this repo runs the **source form** on both distribution layers — local `.claude/skills/` (the tracked `enabledPlugins` self-disable in `.claude/settings.json` keeps its own installed plugin off, deliberately) and the vendored engine (`tools/wave`). Every consumer runs the **installed form**: the plugin plus the npm package, bound through `engine.cli` in the wave config. One form per layer per repo, statically bound, never a runtime fallback (CONTEXT.md `### Distribution`, ADR-0032).

## Verify

From `tools/wave/`:

```bash
npm ci             # install (node_modules is gitignored — a fresh checkout needs this)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

Both must be clean (all tests green, zero type errors) before any change lands.

**The same two gates run as CI and are required to merge.** Every PR (and every push to `main`) runs them via `.github/workflows/verify.yml` as the status checks **"Engine Tests (vitest)"** and **"Engine Typecheck (tsc)"** — both are required status checks on `main`'s ruleset, so a PR lands only with both green. The landing seam reflects this: `host-pr arm` on a checks-pending PR now genuinely **arms** (enables auto-merge; the PR lands itself at green) instead of always direct-merging — direct merge remains only for a PR whose checks have already completed green (repo setting "Allow auto-merge" is ON).

## Status

flotilla's build history and wave-by-wave operational status live in a private ops archive, not in this file. This file plus [docs/CHARTER.md](docs/CHARTER.md), [CONTEXT.md](CONTEXT.md), and [docs/adr/](docs/adr/) are sufficient orientation to start contributing — the ADRs are where "why does it work this way" is answered in full.

## Skill pipeline

The wave skills live in `.claude/skills/`. Front half (planning): `goal`, `triage`, `to-prd`, `to-issues` — `goal` is the destination station: it cuts a named finish line into a tracker-native container, curates its membership, and reports the derived frontier, all as **sight, never permission** (it never stamps eligibility, never dispatches, and never declares a goal reached — ADR-0044). Back half (a wave's lifecycle): `wave-setup` (one-time bootstrap), `wave-plan`, `wave-create`, `wave-start`, `wave-reviewer`, `wave-close`, `wave-resume`. `wave-shared` holds conventions and schemas common to the back half. `grill-with-docs` is the stress-testing tool for any design decision worth an ADR before it's built. `report` belongs to neither half — it is the standalone consumer-side utility: a consumer repo's agent uses it to file a fully-analyzed finding about flotilla itself upstream at flotilla's own repo, in the house format.
