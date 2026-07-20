# wave-create — create mechanics

The engine-CLI plumbing for materializing a wave. The skill body owns the **judgment** (DoR FAIL stance, cross-wave gate, spine-first ordering, abort conditions); this file owns the **invocation**, the exact payload shape, and the worked example. Reach for it once the gate checks pass and you are ready to render.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. Your setup pins how it resolves; in-repo that is `npx tsx tools/wave/src/cli.ts`. Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker. Place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

## Commands

| Call | Purpose |
|---|---|
| `issue-store read <id>` | `IssueView` — worker, risk, files |
| `issue-store triage-read <id>` | `TriageView` — `.title` (tracker-native title, triaged or not) |
| `issue-store listClaimed` | `IssueView[]` — all currently queued + in-flight issues |
| `dor --id <id> --repo-root <dir>` | DoR gate; working-tree gates run against the coordinator's checkout |
| `cross-wave --candidates <f.json> --claimed <f.json> --repo-root <dir>` | `CrossWaveResult` — parallel-safety check |
| `spine create <out-path> <payload.json>` | render and write the `WAVE.md` spine |
| `issue-store transition <id> queued` | set the soft claim |
| any command, no args | usage |

## Exact sequence

```bash
T=$(mktemp -d)
# SLUG  = e.g. "2026-06-18-triage-engine"
# REPO  = consumer repo root (dir containing wave.config.json)
# IDS   = space-separated list of chosen issue ids

# 1. Pre-flight: abort if spine already exists
[ -f ".flotilla/waves/$SLUG.md" ] && echo "spine exists — abort" && exit 1

# 2. Roster (per id)
{{wave-cli}} issue-store read "$ID"          # IssueView → worker, risk, files
{{wave-cli}} issue-store triage-read "$ID"   # TriageView → .title

# 3. DoR (per id) — working-tree gates run with --repo-root
{{wave-cli}} dor --id "$ID" --repo-root "$REPO"

# 4. Cross-wave
#   Write chosen IssueViews (id+files suffice; extra fields ignored) as candidates
{{wave-cli}} issue-store listClaimed > "$T/claimed.json"
{{wave-cli}} cross-wave \
  --candidates "$T/candidates.json" \
  --claimed    "$T/claimed.json" \
  --repo-root  "$REPO"

# 5. Render the spine (WAL — authority first). Create the sidecar dirs FIRST so
#    `.flotilla/waves/` exists: `spine create` does NOT mkdir its parent (ENOENT otherwise).
mkdir -p ".flotilla/waves/$SLUG/reports" ".flotilla/waves/$SLUG/verdicts"
{{wave-cli}} spine create ".flotilla/waves/$SLUG.md" "$T/payload.json"
touch    ".flotilla/waves/$SLUG/reports/.gitkeep" ".flotilla/waves/$SLUG/verdicts/.gitkeep"

# 6. Claim (per id — after spine is flushed)
{{wave-cli}} issue-store transition "$ID" queued
```

`$T` is a temp dir scoped to this run. `candidates.json` is the array of chosen `IssueView`s — built in step 2 by accumulating the `issue-store read` outputs. You can pipe them directly; `IssueView` is a structural superset of `ScopedIssue` (`{id, files}`), so extra fields are ignored by `cross-wave`.

## Building `conflict` from `CrossWaveResult.intraWaveConflicts`

`cross-wave` returns `CrossWaveResult { parallelSafe, crossWaveConflicts, intraWaveConflicts, intraWaveBlockedByPairs, warnings? }`. `warnings` (FOR-38) is present only when a glob `Files` pattern could not be expanded — it should never appear as long as `--repo-root` is passed (required in this sequence, step 4 above); a non-empty `warnings` means the check is incomplete, not that it came back clean. The spine's `## Conflict-Map` records **in-wave file overlaps only**:

```
conflict = {
  issues: <all chosen ids as strings>,
  cells:  result.intraWaveConflicts   // already canonical: a < b, sorted
}
```

`crossWaveConflicts` and `parallelSafe` are a **launch-gate** — handled in step 4 of the skill body (surface + ask, default abort). They are **never** placed in the payload or the spine.

`intraWaveBlockedByPairs` (FOR-8) is a **second, independent launch-gate**, also handled in step 4 — surface + ask, default abort on any non-empty array. It is **not** written into the spine payload either; a `Blocked by` sequencing hint is a launch-time confirmation, not durable spine state (the spine's own `## Resume-Metadata`/Plan-Table already carries each row's declared `Blocked by` implicitly via its `IssueView`, re-read fresh by `wave-start` at dispatch time).

Each entry has the shape `{ blocked: string; blocker: string; resolved: boolean }` — `blocked`/`blocker` are both chosen-roster ids; `resolved` reflects the blocker's `IssueView.status` at the time of this `cross-wave` call (`true` only for `in-review`/`done`). Surface every pair regardless of `resolved`.

## Payload shape (`payload.json`)

```json
{
  "meta": {
    "slug":        "2026-06-18-triage-engine",
    "description": "Triage facet engine slice — readTriage, applyTriage, closeUnplanned",
    "coordinator": "claude-sonnet-4-5",
    "model":       "claude-sonnet-4-5",
    "created":     "2026-06-18",
    "lastUpdated": "2026-06-18"
  },
  "roster": [
    { "id": "42", "title": "Add readTriage to IssueStore interface", "worker": "background",       "risk": "isolated-refactor" },
    { "id": "43", "title": "GitHubIssuesStore: implement readTriage", "worker": "background-heavy", "risk": "cross-feature-refactor" }
  ],
  "conflict": {
    "issues": ["42", "43"],
    "cells": [
      { "a": "42", "b": "43", "files": ["tools/wave/src/contract.ts"] }
    ]
  },
  "dorCheck": "Issue 42: header valid, AC present, files declared — all self-content gates pass. Working-tree gates deferred (GitHub id). Issue 43: header valid, AC present, files declared — all self-content gates pass. Working-tree gates deferred."
}
```

**`SpineMeta` fields:**

| Field | Shape | Notes |
|---|---|---|
| `slug` | string | `YYYY-MM-DD-<topic>` |
| `description` | string | short human-readable description |
| `coordinator` | string | model id or session label for this run |
| `model` | string | same convention as coordinator |
| `created` | string | today's date (skill-stamped) |
| `lastUpdated` | string | today's date (skill-stamped) |

**`SpineRosterRow` fields:**

| Field | Shape | Source |
|---|---|---|
| `id` | string | opaque tracker id |
| `title` | string | from `triage-read` (not `IssueView`) |
| `worker` | string | from `IssueView.worker` |
| `risk` | string | from `IssueView.risk` |

## What `spine create` renders

`spine create` owns every **parser-consumed** section; the skill's only opaque contribution is `dorCheck`. The rendered WAVE.md will have:

- Frontmatter with `slug`, `description`, `coordinator`, `model`, `created`, `lastUpdated`, `status: draft`
- Plan-Table: one row per roster entry — `State=planned`, `Reviewer=universal`, `PR=—`, `Iter=1`, sidecar links auto-rendered from the slug + id
- `## Conflict-Map` section built from the `conflict` field
- `## DOR-check` section containing the `dorCheck` string verbatim

**Status starts as `draft`.** `spine create` never sets `ready`. There is no hand-flip: `wave-start` auto-flips `draft → ready` via `spine set-status` at dispatch (idempotent — a no-op if already `ready`), matching `wave-start`/SKILL.md step 1. The commit-to-scope decision is expressed by the act of running `wave-start`, not by editing the frontmatter.

## Exit codes

### `spine create`

| Code | Meaning |
|---|---|
| `0` | success (spine written) |
| `2` | usage error (missing `<out-path>` or `<payload-file>`) **or** an unreadable/unparseable payload file |

**`spine create` does not check for an existing path — it overwrites silently.** The skill-side pre-flight existence check is the only guard against clobbering a durable spine.

### `cross-wave`

| Code | Meaning |
|---|---|
| `0` | success (result on stdout) |
| `1` | domain failure (`crossWaveCheck` threw) |
| `2` | usage error (missing `--candidates`/`--claimed`) **or** an unreadable/malformed input JSON file |

### `issue-store transition`

| Code | Meaning |
|---|---|
| `0` | transition written |
| `1` | issue not found or transition invalid |
| `2` | usage error |

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `available` (eligible and unclaimed) and `done` (natively closed via the merged PR's store-kind close phrase, `wave-shared` Convention 4) are derived bookends — not written labels. The `queued` transition is a **soft claim** (do not re-plan), not a dispatch signal. Hard claims (`in-flight`) are set by `wave-start` when a Worker is actually dispatched.
