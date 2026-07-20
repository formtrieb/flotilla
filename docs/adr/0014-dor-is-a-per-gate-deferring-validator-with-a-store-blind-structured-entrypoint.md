# dor is a per-gate-deferring validator with a store-blind structured entrypoint

The Definition-of-Ready validator gains a second, **additive** entrypoint for the non-file (tracker-id) path: `validateIssueView(view: IssueView, { schema, repoRoot? })` runs alongside the unchanged file-path `validateIssue({ repoRoot, issuePath, source })`. The structured entrypoint is **store-blind** — it receives a tracker-agnostic `IssueView`, never branches on store kind — so per-gate deferral is **capability-conditional** (keyed on whether the gate's data source is present, e.g. `repoRoot`), not store-conditional. A gate that cannot run in the current context returns a new `'deferred'` `GateStatus`, distinct from `'warn'`; like `'warn'` it does not flip `overall` to `FAIL`. The seven gates split into three honest classes — **self-content** (run anywhere), **working-tree** (run iff a checkout is present), **cross-issue** (needs the *other* issues).

## Why

`IssueView` carries no raw markdown `source` (on GitHub, risk/worker are labels, files/AC are `##` body sections — `read(id)` returns a structured projection). The existing content gates re-parse a `source` string, so they cannot run from a bare tracker id as written. Three forces shaped the resolution:

- **The engine must stay format-/store-blind (ADR-0001, ADR-0009).** A `validateIssueView` that branched on "is this GitHub?" would re-couple the engine to a tracker. The only honest discriminator available to a store-agnostic entrypoint is *capability* ("do I have a `repoRoot`?"), which is also strictly more flexible: `dor <id>` run from inside a checkout could pass `repoRoot` and get the working-tree gates for free, with no special case.

- **The 836-test regression net is load-bearing.** Refactoring the one source-string `validateIssue` into a single path-free signature would force gates 1 and 3 to carry two modes and risk the net. An additive structured twin keeps the file path **byte-identical** and reuses the already-pure gate helpers (`checkRiskFileCount`, `acFilesCoverageCheck`) verbatim — they only ever read `risk` + `files` (+ AC text), all present on `IssueView`.

- **The content/filesystem binary was wrong.** filing-mechanics.md classified `blocked-by-chain` as a "filesystem gate" that defers because it "needs the worktree." It does not — it needs the *other issues*. That is a third class (cross-issue): on markdown it reads `.scratch/<slug>/issues`, on GitHub it would need a store-membership lookup. Naming it correctly dissolves the apparent contradiction with ADR-0001 (which says Gate 5 should be *re-homed* onto `IssueStore`): "defer now, re-home in P2a" is a **sequencing**, not a conflict.

Gate dispositions on the structured path: **1 header-parseable** → `validateHeaderBlock({risk, worker}, schema)` (non-tautological — catches a label outside the configured vocab the store read raw); **3 ac-section** → `acceptanceCriteria` non-empty + no empty-text entry (warn-only, mirroring the heuristic's intent); **4 risk-file-count** & **6 ac-files-coverage** → existing helpers verbatim; **2 files-glob** & **7 literal-files** → run iff `repoRoot`, else `'deferred'`; **5 blocked-by-chain** → `'deferred'` in M1 (cross-issue; re-home is P2a).

## Considered Options

- **Additive store-blind structured twin + capability-conditional deferral** (chosen) — zero risk to the file path; honest per-gate data dependencies; reuses pure helpers; finally moves dor toward the engine's path-free idiom (`cross-wave`/`conflict-map`) without the full lift.
- **Reconstruct a synthetic markdown `source` from the `IssueView`, feed the existing `validateIssue`** (rejected) — a double round-trip (`gh body → parseBody → IssueView → render → parseHeaderBlock`), needs a faithful `IssueView → markdown` serializer, and makes Gate 1 tautological (re-parsing what we just serialized).
- **Invasively refactor `validateIssue` into one path-free signature** (rejected) — risks the regression net and forces gates 1/3 to carry both a raw-text and a structured mode in one function.
- **Store-conditional deferral** (rejected) — would require the engine entrypoint to know the tracker kind, violating store-blindness; capability-conditional is both more honest and more flexible.
- **Re-home `blocked-by-chain` onto the store now** (deferred to P2a) — proper GitHub resolution needs an async store-membership lookup; M1-PRD §2a/ADR-0001 already sequence the path-free lift of the path-coupled modules to P2a (now itemized in CANARY C3, which previously omitted `dor-gate`).

## Consequences

- **New `GateStatus` value `'deferred'`** — distinct from `'warn'` (ran, found a soft issue) so a reader can tell "couldn't run here, runs at wave-create" from "ran and warned." Does not flip `overall`. The CLI renderer gains a symbol/label; a handful of spec assertions enumerate it.
- **`validateIssueView` needs the `WaveSchema`** (for Gate 1), which the file-path `validateIssue` does not take (it re-parses with the default). Defaults to `DEFAULT_WAVE_SCHEMA`.
- **CLI:** `dor --id <id> [--config <path>]` is dispatched async in `mainAsync` (it does `store.read(id)` via `buildStore(loadWaveConfig(...))`, mirroring the `issue-store` interception) and feeds `validateIssueView`; `dor <path>...` stays synchronous and unchanged. The I/O lives in the CLI caller; the engine function is pure over `IssueView`. Exit `0` = ready (PASS / warn / deferred only), `1` = FAIL or a store-read failure.
- **No `--repo-root` flag in M1** (YAGNI). Capability-conditional deferral makes it a free future add.
- **Docs reconciled:** filing-mechanics.md's content/filesystem binary is corrected to the three-class taxonomy; CANARY C3 now itemizes the Gate-5 re-home (P2a).
