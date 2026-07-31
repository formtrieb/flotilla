# wave-create — create mechanics

The engine-CLI plumbing for materializing a wave. The skill body owns the **judgment** (DoR FAIL stance, cross-wave gate, spine-first ordering, abort conditions); this file owns the **invocation**, the exact payload shape, and the worked example. Reach for it once the gate checks pass and you are ready to render.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker. Place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

## Commands

| Call | Purpose |
|---|---|
| `issue-store read <id>` | `IssueView` — worker, risk, files |
| `issue-store triage-read <id>` | `TriageView` — `.title` (tracker-native title, triaged or not) and `.body` (the sanctioned source for embedding the issue spec into a Worker brief at compose time) |
| `issue-store listClaimed` | `IssueView[]` — all currently queued + in-flight issues |
| `dor --id <id> --repo-root <dir> --config <path>` | DoR gate; working-tree gates run against the coordinator's checkout, and `--config` is what lets Gate 8 (`verify-profile-coverage`) resolve against the consumer's `verify` profiles instead of deferring |
| `cross-wave --candidates <f.json> --claimed <f.json> --repo-root <dir>` | `CrossWaveResult` — parallel-safety check |
| `spine create <out-path> <payload.json>` | render and write the `WAVE.md` spine |
| `issue-store transition <id> queued` | set the soft claim |
| any command, no args | usage |

## Exact sequence

```bash
# A LITERAL scratch dir, deliberately NOT `T=$(mktemp -d)` — see the note below.
mkdir -p "/tmp/flotilla-create-$SLUG"
# SLUG  = e.g. "2026-06-18-triage-engine"
# REPO  = consumer repo root (dir containing wave.config.json)
# IDS   = space-separated list of chosen issue ids

# 1. Pre-flight: abort if spine already exists
[ -f ".flotilla/waves/$SLUG.md" ] && echo "spine exists — abort" && exit 1

# 2. Roster (per id)
{{wave-cli}} issue-store read "$ID"          # IssueView → worker, risk, files
{{wave-cli}} issue-store triage-read "$ID"   # TriageView → .title (roster) + .body (sanctioned brief-composition source)

# 2a. Human-gate surface (surface + ask). No CLI call of its own: the answer is
#     already in the `issue-store read` output from step 2 — `.worker`. Compare it
#     against the consumer's human-gated Worker token(s); the engine's default is
#     `HITL-required` (HUMAN_GATED_WORKER, tools/wave/src/wave-md-rw.ts).
#     Surface every match, ask, and record the answer in the DOR-check narrative.
#     Default = include-and-hold (NOT abort): the row is materialized and claimed
#     like any other, and wave-start holds it in the human lane at dispatch.

# 3. DoR (per id) — working-tree gates run with --repo-root; --config is what
#    lets Gate 8 (verify-profile-coverage) see the consumer's verify block at
#    all, on THIS call, regardless of cwd (see note below the sequence)
{{wave-cli}} dor --id "$ID" --repo-root "$REPO" --config "$REPO/wave.config.json"

# 4. Cross-wave
#   Write chosen IssueViews (id+files suffice; extra fields ignored) as candidates
{{wave-cli}} issue-store listClaimed > "/tmp/flotilla-create-$SLUG/claimed.json"
{{wave-cli}} cross-wave \
  --candidates "/tmp/flotilla-create-$SLUG/candidates.json" \
  --claimed    "/tmp/flotilla-create-$SLUG/claimed.json" \
  --repo-root  "$REPO"

# 5. Render the spine (WAL — authority first). Create the sidecar dirs FIRST so
#    `.flotilla/waves/` exists: `spine create` does NOT mkdir its parent (ENOENT otherwise).
mkdir -p ".flotilla/waves/$SLUG/reports" ".flotilla/waves/$SLUG/verdicts"
{{wave-cli}} spine create ".flotilla/waves/$SLUG.md" "/tmp/flotilla-create-$SLUG/payload.json"
touch    ".flotilla/waves/$SLUG/reports/.gitkeep" ".flotilla/waves/$SLUG/verdicts/.gitkeep"

# 6. Claim (per id — after spine is flushed)
{{wave-cli}} issue-store transition "$ID" queued
```

`/tmp/flotilla-create-$SLUG` is a scratch dir scoped to this wave by its slug. `candidates.json` is the array of chosen `IssueView`s — built in step 2 by accumulating the `issue-store read` outputs. You can pipe them directly; `IssueView` is a structural superset of `ScopedIssue` (`{id, files}`), so extra fields are ignored by `cross-wave`.

**Why that path is written out rather than captured (Convention 12, Form 1).** This sequence used to open with `T=$(mktemp -d)`. That capture is in the **guarded** class, not the legitimate-empty one — `mktemp -d` either prints a path or fails, so an empty `T` means the command did not run, and `> "$T/claimed.json"` with `T` unset writes to `/claimed.json`, at the filesystem root.

Here, though, an inline guard was never even *available*. The value has to reach steps 4, 5 and beyond, and this sequence provably spans many Bash calls: step 2 loops per id, **step 2a stops and asks a human**, and step 4's `candidates.json` is composed by hand between calls. Shell state does not survive any of those boundaries, so `T` would be unset at every point it is used no matter what step 0 checked. A capture whose scope cannot reach its consumers is not a capture to guard — it is one to **remove**, which is the form the convention prefers anyway.

`$SLUG` and `$REPO` remain variables, and that is not an inconsistency: they are **operator-held constants** you already know and retype in each call — the file names `$SLUG` literally in `.flotilla/waves/$SLUG.md` two steps later for exactly that reason. A `mktemp` output is the opposite: a value nobody can retype, because it only ever existed in one shell's memory. The convention is about that difference, not about the `$` sigil.

Scoping by slug keeps two waves created in the same session off each other's scratch files. Keep it **outside** the repo: step 3's `dor` runs working-tree gates against the coordinator's checkout, and in a consumer repo `.flotilla/` is *not* gitignored (the spine is branch-local committed for resume), so scratch JSON parked there would both dirty the tree that gate reads and follow the spine into a commit.

**`--config` on the step-3 `dor` call is not the same convenience as elsewhere in this sequence.** `issue-store`/`cross-wave` fall back to a `wave.config.json` in the working directory when `--config` is omitted; `dor`'s Gate 8 (`verify-profile-coverage`) does not share that fallback — it only sees the consumer's `verify` block when `--config` names it explicitly on *this* call, no matter which directory you're running from. Two outcomes share the `deferred` status text but mean different things: **resolvable** (this call passed `--config`, the file loaded, and `verify.profiles` — empty or not — were actually weighed against the row's files) versus **genuinely absent** (no `--config` reached this call, so the gate never had a `verify` block to look at, and the `defer` says nothing about the row's actual coverage). Pass `--config` as shown; the sequence above should land in the resolvable state on every ordinary run.

## Building `conflict` from `CrossWaveResult.intraWaveConflicts`

`cross-wave` returns `CrossWaveResult { parallelSafe, crossWaveConflicts, intraWaveConflicts, intraWaveBlockedByPairs, warnings? }`. `warnings` (FOR-38) is present only when a glob `Files` pattern could not be expanded — it should never appear as long as `--repo-root` is passed (required in this sequence, step 4 above); a non-empty `warnings` means the check is incomplete, not that it came back clean. The spine's `## Conflict-Map` records **in-wave file overlaps only**:

```
conflict = {
  issues: <all chosen ids as strings>,
  cells:  result.intraWaveConflicts   // already canonical: a < b, sorted
}
```

The spine's `## Conflict-Map` is built from `cross-wave`'s `intraWaveConflicts` (above) — **not** from the standalone `conflict-map` CLI. Do not reach for `conflict-map` here to build the spine. If you ever want a standalone overlap check on this roster outside the `cross-wave` flow, `conflict-map` is no longer path-only: `conflict-map --id <id> [--id <id> ...] [--repo-root <dir>] [--config <path>]` is the store-backed (non-file) entrypoint that reads each id's `Files` from the `IssueStore`, so a bare github/linear id needs neither a path export nor a tsx one-off (bare `conflict-map <path>...` stays the file form).

`crossWaveConflicts` and `parallelSafe` are a **launch-gate** — handled in step 4 of the skill body (surface + ask, default abort). They are **never** placed in the payload or the spine.

`intraWaveBlockedByPairs` (FOR-8) is a **second, independent launch-gate**, also handled in step 4 — surface + ask, default abort on any non-empty array. It is **not** written into the spine payload either; a `Blocked by` sequencing hint is a launch-time confirmation, not durable spine state (the spine's own `## Resume-Metadata`/Plan-Table already carries each row's declared `Blocked by` implicitly via its `IssueView`, re-read fresh by `wave-start` at dispatch time).

Each entry has the shape `{ blocked: string; blocker: string; resolved: boolean }` — `blocked`/`blocker` are both chosen-roster ids; `resolved` reflects the blocker's `IssueView.status` at the time of this `cross-wave` call (`true` only for `in-review`/`done`). Surface every pair regardless of `resolved`.

## The human-gate surface (step 2a) — what it costs and what it buys

No extra call: `IssueView.worker` is already in hand from step 2's `issue-store read`. The whole gate is a comparison against the consumer's human-gated Worker token(s) plus a question to the Coordinator.

The `worker` value is carried into the payload's roster verbatim (it always was — see `SpineRosterRow` below), so `spine create` renders it into the Plan-Table `Worker` cell, and that cell is what every later pass reads. **This is why no new spine state, payload field, or CLI verb is needed anywhere in the chain:** the durable record of "this row is human-gated" is the Worker column the engine already writes, and the durable record of "it has not been released yet" is the `State` column already sitting at `planned`. The engine reads exactly that conjunction (`humanHeldRowIds`, `tools/wave/src/wave-md-rw.ts`), and the seam it reuses is the HELD one `wave-start` step 3 already runs for intra-wave `Blocked by`.

**Include-and-hold is deliberately NOT include-and-park.** Both leave the row undispatched this pass, and they are opposites: `parked` releases the claim and takes the row out of the wave permanently (no un-park), while a human-gated hold keeps the claim and the row, waiting for a human who is expected to act. Parking a human-gated row at create time is the same mistake as parking a blocked one — see the ADR-0022 bullet in step 4 of the skill body. Parking stays available later, as a Coordinator disposition at `wave-start`, once waiting turns out to be the wrong call.

### Why the gate exists — read the measured constraint, not the folk version

Before you classify a row `HITL-required`, or read one that already is, know what the constraint usually turns out to be. The measurement is written up once, in [../../wave-start/reference/start-mechanics.md](../../wave-start/reference/start-mechanics.md) ("Why the human lane exists"). The short form: the observed blocker was **the Bash sandbox's write-deny on specific paths**, not an agent that cannot write files — an agent's file-editing tool wrote the target fine; it was git plumbing under the sandbox that could not unlink it. "Agents can't write here" is the over-broad reading, and it mis-classifies rows that are perfectly AFK-implementable.

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

The roster row itself only ever holds `.title` — but the same `triage-read` call already returned `.body` too, and that field (not a separate tracker fetch) is the sanctioned source `wave-start` reads from when it composes a Worker's brief.

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
