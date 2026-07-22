---
name: wave-create
description: Use when materializing an approved wave from a chosen set of issue ids — run DoR + cross-wave (file conflicts AND intra-wave Blocked-by pairs, both surface+ask default-abort), render the WAVE.md spine, and set the queued soft-claim. Spine-first (WAL). Triggers on "create the wave", "materialize wave <slug>", "build the spine for these issues".
---

# wave-create

Materialize one approved wave from a slug and a set of chosen issue ids (the human picked them via `wave-plan`): assemble the roster, run DoR + cross-wave, render the durable `WAVE.md` spine, create sidecar dirs, and set the `queued` soft-claim on each issue. **Does not dispatch** — that is `wave-start` (P7.4). **Does not author the `WAVE.md` markdown** — the engine `renderSpine`/`spine create` owns every parser-consumed section (ADR-0016); this skill supplies only the structured inputs and the opaque `## DOR-check` prose.

Your job is the **judgment** — assembling the roster, deciding whether DoR failures and cross-wave conflicts warrant proceeding or aborting, composing the payload, and setting the soft-claim in the right order. The CLI plumbing (the full worked sequence, the exact payload shape, a worked `payload.json`) lives in [reference/create-mechanics.md](reference/create-mechanics.md) — reach for it once the gate checks pass. You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

## When to Use

- The human has approved a set of issue ids from `wave-plan` and is ready to materialize the wave.
- You have a slug (e.g. `2026-06-18-triage-engine`) and a list of ids.

Do **not** use this for planning (that is `wave-plan`), for slicing work into issues (`to-issues`), or for dispatching workers (`wave-start`). wave-create is the materialization step; wave-plan is the advisory pass that precedes it.

## THE FLOTILLA BOUNDARY — spine-first always

**The spine is authority (ADR-0002 WAL).** Order is: render and flush the spine **first**, then transition each issue → `queued`. A crash between step 5 (spine flush) and step 6 (claim) leaves the spine intact and the claims re-assertable from it; claim-first would orphan a claim with no spine to reconcile against. Never invert this order.

## Procedure

### 1. Pre-flight

Abort (never overwrite) if `.flotilla/waves/<slug>.md` already exists. Slug shape: `YYYY-MM-DD-<topic>`.

### 2. Roster

Per chosen id, call two engine verbs:
- `issue-store read <id>` → `IssueView` (worker, risk, files)
- `issue-store triage-read <id>` → `TriageView` (.title)

Build each roster row as `{ id, title, worker, risk }`. The title comes from the **Triage facet** (`triage-read`) because `IssueView` carries no title — it is wave-header-only (ADR-0015). `triage-read` returns the native tracker title whether or not the issue was ever explicitly triaged.

### 3. DoR

Run `dor --id <id> --repo-root <consumer-root>` per chosen id. The `--repo-root` flag lets the engine run working-tree gates (glob resolution, literal-file existence) against the coordinator's checkout — without it, those gates defer.

**Self-content FAIL stance — surface + ask, default abort.** A self-content FAIL (header not parseable, missing AC, risk-file-count mismatch) means the issue is not currently grabbable. Surface the failing issue and failing gate, then ask: drop the issue and continue with N−1, or fix the issue first? Do **not** silently fix or silently drop. `deferred` and `warn` outcomes never block — they show in the `## DOR-check` narrative but do not gate proceeding.

Capture the per-issue results — the full narrative becomes the spine's `## DOR-check` section (the one opaque, skill-side section; the engine never parses it).

### 4. Cross-wave

Write the chosen `IssueView`s to a temp file as the candidates array; run `issue-store listClaimed` for the claimed set; run `cross-wave --candidates … --claimed … --repo-root <consumer-root>` — **`--repo-root` is required here, never omit it** (FOR-38: without it, glob `Files` patterns cannot be expanded and the conflict check silently under-reports — the dangerous direction for a gate that defaults to proceeding when clean).

The result is `CrossWaveResult { parallelSafe, crossWaveConflicts, intraWaveConflicts, intraWaveBlockedByPairs, warnings? }`.

**Split the three result kinds — they have different destinations:**

- **`intraWaveConflicts` → the spine's Conflict-Map.** Build the payload's `conflict` field as `{ issues: <all chosen ids>, cells: result.intraWaveConflicts }`. The cells are already canonical (`a < b`, sorted). This records in-wave file overlaps so the Coordinator can plan sequencing within the wave.
- **`crossWaveConflicts` / `parallelSafe` → launch-gate, not spine state.** If `parallelSafe === false`, surface the cross-wave overlap (which ids, which files) and **ask the Coordinator, default abort**. They may override with an explicit serialization mitigation (e.g. "I know the other wave already landed; safe to proceed"). Never persist cross-wave conflicts in the spine.
- **`intraWaveBlockedByPairs` → a second, orthogonal launch-gate (FOR-8).** If non-empty, the roster contains a `Blocked by` pair where the blocker is ALSO in this same roster — surface every pair (which id blocks which) and **ask the Coordinator, default abort**, exactly like the file-conflict gate above, regardless of each pair's `resolved` flag. A blocker already `resolved` (shipped to `in-review`/`done`) is not automatically safe to wave together: `wave-start`'s own membership-resolution step (not this one) is what actually gates dispatch order, so wave-create's posture stays "surface + ask" for any intra-wave dependency — the human may confirm ("the blocker is a smoke-test row dispatched first on purpose") or drop one issue and re-plan. Never silently split the pair or reorder the roster to route around it.
- **`warnings` (FOR-38, present only when non-empty) → surface, do not treat a clean `parallelSafe` as trustworthy alongside it.** Each entry names a glob `Files` pattern that could not be expanded. This should never appear when `--repo-root` is passed correctly (the normal case here); if it does, treat it the same as a DoR self-content FAIL — surface + ask, default abort, rather than proceeding on an incomplete check.
- **No include-and-park at create time (ADR-0022).** `parked` is a real terminal row state, but it is **not** an escape hatch for this gate: do not resolve a blocked pair by admitting the blocked issue and immediately parking it. Default-abort stands. A row you already know you cannot run does not belong in the wave — **do not claim what you cannot run**. Parking is a *disposition for work already in a wave*, offered only by `wave-start` (membership resolution) and the STOP menu; at create time the equivalent move is simply to leave the issue out of the roster, where it stays `available` for a future draw. Rendering a row as `parked` in a fresh spine is always wrong.

### 5. Render (WAL — authority first)

Build the payload:
```
{
  meta: { slug, description, coordinator, model, created, lastUpdated },
  roster: [ { id, title, worker, risk }, … ],
  conflict: { issues: string[], cells: { a, b, files: string[] }[] },
  dorCheck: "<narrative from step 3>"
}
```

Stamp `created` and `lastUpdated` to today's date; set `coordinator` and `model` from this session. **Create the sidecar directories first** — `spine create` does not mkdir its parent, so `.flotilla/waves/` must exist before the spine write:

```
mkdir -p .flotilla/waves/<slug>/reports .flotilla/waves/<slug>/verdicts
spine create .flotilla/waves/<slug>.md payload.json
touch .flotilla/waves/<slug>/reports/.gitkeep .flotilla/waves/<slug>/verdicts/.gitkeep
```

`spine create` renders every parser-consumed section (frontmatter, Plan-Table with `State=planned`, `Reviewer=universal`, `PR=—`, `Iter=1`, sidecar links, `## Conflict-Map`). The `dorCheck` string is placed verbatim in the `## DOR-check` section.

### 6. Claim

Run `issue-store transition <id> queued` per issue — in the same order as the roster. A crash here leaves the spine intact; claims are re-assertable from the spine on resume. This is why the spine must be flushed first.

### 7. Report

Print the spine path. Note that Status is `draft` — left that way deliberately. There is no manual step: `wave-start` auto-flips `draft → ready` via `spine set-status` at dispatch (idempotent — a no-op if already `ready`), so the commit-to-scope decision is expressed by the act of running `wave-start`, never by manually editing the frontmatter. The next step is `wave-start` (P7.4).

## Common Mistakes

- **Calling `spine create` before its parent dir exists.** `spine create` does not mkdir `.flotilla/waves/` — create the sidecar dirs first, or it ENOENT-fails.
- **Authoring `WAVE.md` by hand.** Use `spine create` — every parser-consumed section is owned by the engine (ADR-0016). Hand-authored sections will drift from the parser and corrupt resume.
- **Claim-first.** Always flush the spine before transitioning issues to `queued`. A `queued` claim with no spine orphans the claim; a spine with no claim is recoverable.
- **Putting `crossWaveConflicts` in the spine.** The spine's `## Conflict-Map` holds **in-wave conflicts only** (`intraWaveConflicts`). Cross-wave conflicts are a launch-gate; if `parallelSafe === false`, abort (or obtain an explicit mitigation) — never write the cross-wave overlap into the spine.
- **Skipping the `intraWaveBlockedByPairs` gate because the blocker looks "already resolved".** wave-create's job is to surface + ask, default abort, for ANY intra-wave `Blocked by` pair — resolved or not. Whether a resolved blocker actually unblocks dispatch is `wave-start`'s call at dispatch-time, not this skill's.
- **Admitting a blocked issue "and just parking it" (ADR-0022).** Parking is not a create-time move. Every fresh row is `planned`; a row rendered `parked` into a new spine claims an issue only to release it. Leave it out of the roster instead.
- **Skipping the pre-flight existence check.** `spine create` overwrites silently — it does NOT reject an existing path. The skill's step-1 existence check is the *only* guard against clobbering a durable, possibly in-flight spine. Never skip it.
- **Using the `conflict-map` CLI to build the spine's Conflict-Map.** `conflict-map` now has a store-backed `--id` entrypoint for non-file stores, but the spine build still goes through `cross-wave` — it computes the same cells *plus* the claimed-set comparison and the `intraWaveBlockedByPairs` this skill's gates need. Use `cross-wave` with the `IssueView[]` arrays, then extract `intraWaveConflicts` from the `CrossWaveResult`.
- **Deriving the roster title from `IssueView`.** `IssueView` has no title — it is wave-header-only. Always use `issue-store triage-read <id>` for the title.
- **Dispatching from this skill.** wave-create ends at `queued` + `draft` spine. Dispatch is `wave-start`.
