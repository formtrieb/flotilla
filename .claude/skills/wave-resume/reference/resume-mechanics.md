# wave-resume — resume mechanics

The engine-CLI plumbing for the resume reconcile. The skill body owns the **judgment** (spine-first, reconcile-before-dispatch, the done-reconcile, the fatal-flag decision); this file owns the **invocations**, the `ResumeResult` shape, and exit codes.

> **The CLI is the source of truth for shapes.** The JSON below are worked examples — if one disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution + the `resume` subcommand

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before reconciling anything. Used here for `spine read` and the `issue-store` verbs (`read-closing`/`transition`/`flag`). `issue-store` verbs need the store config: append `--config <path>` **after** the op, or run from a dir with `wave.config.json`. The store (`markdown` or `github`) is selected there — you never name a tracker.

**The reconciler is a `{{wave-cli}} resume` subcommand** — issue #77 folded the once-separate `resume-cli.ts` entrypoint into the router (same disk-backed reconciler, same JSON on stdout, same exit codes; only the invocation spelling changed). It is store-free — it reads only the spine + worktrees + sidecars, never the tracker.

## Commands

| Call | Purpose / shape |
|---|---|
| `{{wave-cli}} spine read <spine-path>` | the WAL authority — read FIRST (raw spine markdown on stdout) |
| `{{wave-cli}} resume --spine <p> --reports <d> --verdicts <d> [--repo-root <d>] [--marker <m>] [--force]` | `{ rows, fatals, cleanup }` JSON |
| `{{wave-cli}} worktree-cleanup --orphans --detached` | (step 4b) the general orphan-directory / orphan-branch / detached-scratch / Scribe-scratch sweep — the SAME verb and flag pair `wave-close` phase 3 and `wave-start`'s dispatch preflight run. Reports `{ removed, skipped, errors, branchesDeleted, branchHygieneSkipped, orphans: { removed, skipped, errors, scratch: { dir, present, removed, skipped, errors } }, detached: { removed, skipped, errors } }`. `orphans.scratch` is the Scribe scratch sweep (issue #355) — full reading guide: [wave-close phase 3](../../wave-close/reference/phase-3-worktree-cleanup.md#the-scribe-scratch-sweep--a-repo-internal-location-that-had-no-lifecycle-issue-355). Row-unscoped by design (no `--wave` flag here — this call sweeps repo-wide, exactly like the close and dispatch-preflight calls it mirrors); it never touches the tracker. |
| `{{wave-cli}} issue-store read-closing <id>` | `ClosingState` — the 4th, skill-only done-reconcile input (tracker-attachment tier of the evidence hierarchy) |
| `{{wave-cli}} host-pr status --branch <b>` | host-evidence tier (ADR-0023): `{ state: "open"\|"merged"\|"closed-unmerged"\|"none", url? }` — consulted when `read-closing` cannot see a merge on a no-integration workspace. No `--config` (talks to the code host, not the tracker). |
| `{{wave-cli}} verdict-acked <verdictsDir> <id>` | (FOR-17) the single-owner derivation of `close`'s `--acked` indexes: `{ "acked": [0, 2], "iter": 2\|null, "corrupt": 0 }`. Reads the MAX-iter valid ReviewerVerdict sidecar for `<id>` out of `<verdictsDir>` and returns the 0-based `acVerification` indexes marked `met` — partial/not-met/deferred excluded. Max-iter means a changes-requested → re-dispatch cycle's answer is always the LATEST verdict. No verdict sidecar (or only a corrupt one) → `{ acked: [], iter: null, corrupt: N }`, never a failure — the tick is cosmetic (ADR-0004). |
| `{{wave-cli}} issue-store close <id> <prUrl> [--acked 0,2,3]` | the done-reconcile: land a `merged` row `done` + the cosmetic AC tick from `--acked` (source it from `verdict-acked`, above — never hand-parse a verdict) — idempotent no-op-or-reconcile; FOR-13 fallback on a no-integration `states.doneState` store, fired the moment the host supplies the merge evidence. The existing `IssueStore.close()` verb — never re-implemented. |
| `{{wave-cli}} issue-store transition <id> <queued\|in-flight\|in-review>` | idempotent coarse re-projection |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>"]` | flag a fatal / closed-unmerged → needs-attention |

## `{{wave-cli}} resume` flags

| Flag | Required | Meaning |
|---|---|---|
| `--spine <path>` | yes | the WAVE.md spine (`.flotilla/waves/<slug>.md`) |
| `--reports <dir>` | yes | sidecar reports dir — `.flotilla/waves/<slug>/reports/` by convention |
| `--verdicts <dir>` | yes | sidecar verdicts dir — `.flotilla/waves/<slug>/verdicts/` by convention |
| `--repo-root <dir>` | no | where `git worktree list` runs; defaults to `process.cwd()` |
| `--marker <m>` | no | narrow agent-worktree matching to a single marker; omit → engine's `agent-` + `wf_` allowlist. Only scopes the reconciliation read; crash-cleanup (below) always scans unscoped. |
| `--force` | no | **crash-cleanup only** (FOR-10): allow destroying a DIRTY crashed worktree found for a `redispatch` row. Omit by default — a dirty match is reported via `blockedByDirty: true` and left untouched. Never affects reconciliation itself. |

## `ResumeResult` shape (now `{ rows, fatals, cleanup }`)

```json
{
  "rows": [
    {
      "id": "42",
      "branch": "wave-orch/42-foo",
      "reconstructedState": "verdict-in",
      "decision": "adopt",
      "coarse": "in-review",
      "worktree": { "path": ".claude/worktrees/agent-42", "branch": "wave-orch/42-foo", "head": "abc123", "dirty": false },
      "latestReport": { "...": "WorkerReport" },
      "reportIter": 1,
      "latestVerdict": { "...": "ReviewerVerdict" },
      "verdictIter": 1,
      "notes": ["reconstructed dispatched → verdict-in from disk (beats non-landed spine flip)"]
    }
  ],
  "fatals": [
    { "id": "43", "reason": "corrupt sidecar(s): report@2" }
  ],
  "cleanup": [
    {
      "branch": "wave/FOR-10-resume-cleanup",
      "worktreePath": ".claude/worktrees/wf_deadbeef-10-1",
      "wasLocked": true,
      "wasDirty": false,
      "worktreeRemoved": true,
      "branchDeleted": true,
      "blockedByDirty": false,
      "notes": [
        "unlocked worktree at .claude/worktrees/wf_deadbeef-10-1",
        "removed worktree at .claude/worktrees/wf_deadbeef-10-1",
        "deleted branch wave/FOR-10-resume-cleanup (idempotent — no-op if already absent)"
      ]
    }
  ]
}
```

- `decision`: `adopt` (durable progress on disk / a landed worktree → resume in place, never redispatch), `redispatch` (nothing landed, no worktree → safe to re-create), `keep` (terminal — `approved`/`pr-created`/`failed`/`abandoned`), `needs-attention` (orphan / corrupt → fatal, **paused, never re-dispatched**).
- `coarse`: the `ClaimRung` (`queued`/`in-flight`/`in-review`) to re-project, **or `null` for a `parked` row** (ADR-0022) — "no claim to hold". Execute a `null` as `issue-store unclaim <id>`, never as a `transition`: the claim was already released at park time, so the call is a pure idempotent re-assertion. Projecting a parked row onto any rung would re-claim an issue that is back in the pool (and may already have been drawn by another wave). Never `done`/`available` — those are derived, not projected (step 5 done-reconcile handles `done`).
- `cleanup`: one entry per row whose `decision === 'redispatch'` (empty array if none). Already applied by the time you read the JSON — you do not need to act on `worktreeRemoved`/`branchDeleted` yourself. The one field that DOES need action: `blockedByDirty: true` means a dirty crashed worktree was found and left untouched — surface `worktreePath` to a human before considering `--force` (see SKILL.md step 4).

## `ClosingState` shape (the done-reconcile probe)

`read-closing` prints `{ "state": "open" | "merged" | "closed-unmerged" | "closed-unknown", "prUrl"?: string }` — the four outcomes are **evidence claims, not verdicts** (ADR-0020):

- `open` — PR still open / no PR yet → keep the `in-review` rung; no action. Exception: a no-integration `states.doneState` workspace never reports `merged` — consult `host-pr status --branch <b>` (the evidence hierarchy, ADR-0023); on its `state: merged`, derive `--acked` (below), then land it with `close` (FOR-13 fallback). No out-of-band human-confirmation step.
- `merged` — the PR landed during the outage → **derive `--acked` via `verdict-acked <verdictsDir> <id>` (FOR-17), then land it `done` via `issue-store close <id> <prUrl> --acked <indexes>`** (the done-reconcile). **Do not `transition`** (no `done` rung); `close` is idempotent and records the closing facts + the cosmetic AC tick — on a native-integration tracker `read().status` also derives `done` from the merged PR's store-kind close phrase (`wave-shared` Convention 4). Carries `prUrl`.
- `closed-unmerged` — a closing PR was **found and it did not merge** (a proven rejection) → **flag `recoverable-stop`** (not auto-`available`).
- `closed-unknown` — closed with **no PR evidence either way** (a hand-close, a duplicate, or the W2-F1c foreign-id mention). *Absence of evidence, not evidence of rejection* → **never flag on the tracker probe alone**. Fall to the host (evidence hierarchy): `host-pr status --branch <b>` — `merged` lands it (derive `--acked`, then `close`, FOR-13 fallback), `closed-unmerged` is the only host answer that justifies a `recoverable-stop` flag, and `open`/`none` is **reported** (`closed-unknown — closed, no merged-PR evidence found; confirm before landing`) and left for the human, never re-dispatched.

## Worked sequence (grounded in the dogfood)

```bash
# SLUG=2026-06-19-canary ; REPO=<consumer root>
SPINE=".flotilla/waves/$SLUG.md"
REPORTS=".flotilla/waves/$SLUG/reports"
VERDICTS=".flotilla/waves/$SLUG/verdicts"

# 0. THE CALL BOUNDARY (wave-shared Convention 12, half two). No setup step —
#    deliberately. This file used to define a `require_capture()` helper here and
#    invoke it at step 5; that helper is RETIRED, because a shell function is
#    session state and shell state does not survive from one Bash call to the
#    next, so the guard was never in scope for the value it named. Step 5's
#    capture now carries its check inline, in the same call. Refuse `null` and
#    `undefined` alongside `''`, and print only the NAME, never the value
#    (a capture may be a credential — Convention 8).

# 1. Spine first (WAL authority)
{{wave-cli}} spine read "$SPINE"

# 2-4. Reconcile ({{wave-cli}} resume — enumerates worktrees + reads sidecars itself)
#      Crash-cleanup for every redispatch row runs INSIDE this call, before it prints (FOR-10).
{{wave-cli}} resume \
  --spine "$SPINE" --reports "$REPORTS" --verdicts "$VERDICTS" --repo-root "$REPO" > result.json
# clean spine, no sidecars, no worktree → rows[0]: { decision: "redispatch", coarse: "queued" }, fatals: []
# a corrupt report sidecar → rows[0]: { decision: "needs-attention" }, fatals: [{ id, reason: "corrupt sidecar(s): report@1" }]
# a crashed, locked worktree still on the redispatch row's branch → already unlocked+removed+branch-deleted by
# the time result.json is written; cleanup[0]: { branch, worktreeRemoved: true, branchDeleted: true, blockedByDirty: false }
# that SAME worktree but dirty (uncommitted changes) → left untouched; cleanup[0].blockedByDirty: true — surface
# `worktreePath` to a human; only re-run with --force after explicit confirmation:
#   {{wave-cli}} resume --spine "$SPINE" --reports "$REPORTS" --verdicts "$VERDICTS" \
#     --repo-root "$REPO" --force > result.json

# 4b. General sweep — orphaned directories/branches, detached scratch checkouts, and
#     the Scribe scratch payloads (issue #355). Step 4's crash-cleanup only ever
#     touches a redispatch row's OWN branch/worktree; this call is what reaches
#     everything else, repo-wide, exactly like wave-close phase 3 and wave-start's
#     dispatch preflight — both of which preview before they sweep, the same
#     discipline this step follows too:

# Preview first — --dry-run shares the exact same plan the real run below
# executes (wave-close phase 3), so what this prints is exactly what the next
# call removes:
{{wave-cli}} worktree-cleanup --dry-run --orphans --detached

# Execute (only after the preview looks right) — --orphans and --detached on
# the SAME call, every time:
{{wave-cli}} worktree-cleanup --orphans --detached
# read `orphans.scratch` the same way wave-close phase 3 does: absent → the sweep
# never looked; present:false → looked, nothing there; non-empty removed → real
# payloads were cleaned. Full reading guide: ../../wave-close/reference/phase-3-worktree-cleanup.md

# 5. Done-reconcile each in-review row — evidence hierarchy (ADR-0023):
#    tracker attachment (read-closing) > host PR state (host-pr status) > nothing
{{wave-cli}} issue-store read-closing "$ID"     # merged → close (below); closed-unmerged → flag; open/closed-unknown → host fallback (closed-unknown never auto-flags)
# merged → derive --acked from the FINAL verdict (FOR-17, single-owner engine
# derivation — NEVER hand-parse a verdict sidecar here), then land it done via
# the existing close verb (NOT `transition … done`):
# ISSUE THE FOUR LINES BELOW AS ONE BASH CALL — capture, guard, derive, close.
# They share one scope because that is the only scope the variables exist in
# (wave-shared Convention 12, half two, Form 2), and the close path's
# done-reconcile carries the identical block.
ACKED_JSON=$({{wave-cli}} verdict-acked "$VERDICTS" "$ID")   # { acked: [...], iter, corrupt }

# GUARD THE CAPTURE THAT PROVES THE VERB RAN (wave-shared Convention 12). This is
# the SAME shape the close path's done-reconcile guards, and the two must not
# diverge. An empty ACKED_JSON does not mean "no ACs were met" —
# it means `verdict-acked` produced nothing, and the only ways that happens are
# ways you must not continue past: the engine CLI was never invoked (a command
# held in a shell variable, exit 127 — the five-occurrence class), or it exited
# non-zero. The next line would derive ACKED="" from that nothing, and `close`
# would accept it as a legitimate "nothing met" and tick nothing — a silent wrong
# answer written to the tracker. Resume is the path that runs AFTER something
# already went wrong, which makes it the worst place to accept a silent empty.
if [ -z "$ACKED_JSON" ] || [ "$ACKED_JSON" = "null" ] || [ "$ACKED_JSON" = "undefined" ]; then
  echo "STOP: ACKED_JSON came back empty — verdict-acked did not run. Refusing to derive an empty --acked from nothing." >&2
  exit 1
fi

ACKED=$(echo "$ACKED_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf-8")).acked.join(","))')
# ACKED itself is deliberately NOT guarded: "" is a documented, legitimate value
# here (nothing met / no verdict sidecar yet) and `close` accepts it as-is.
# Guarding it would be a false alarm on the ordinary case — Convention 12's
# "guard the capture whose emptiness means *did not run*, not the one whose
# emptiness is an answer" rule, with both halves of it live on these two lines,
# exactly as on the close path this mirrors.
{{wave-cli}} issue-store close "$ID" "$PR_URL" --acked "$ACKED"   # $PR_URL is read-closing's prUrl; $ACKED may be "" (nothing met / no verdict yet); FOR-13 fallback when no integration
# open on a no-integration states.doneState workspace → read-closing can't see the
# merge; consult the host directly (no out-of-band human confirmation):
{{wave-cli}} host-pr status --branch "$BRANCH"   # { state: open|merged|closed-unmerged|none, url? }
#   host state=merged → derive --acked the same way, then the SAME close verb lands it (FOR-13 fallback):
{{wave-cli}} issue-store close "$ID" "$PR_URL" --acked "$ACKED"
#   host state=open|none → genuinely unmerged → leave in-review for the next touch.

# 6. Idempotent coarse re-project for every non-fatal, non-done row
# $COARSE is the `coarse` field from the ResumeResult row: a ClaimRung
# ∈ {queued, in-flight, in-review}, or null for a `parked` row (ADR-0022).
{{wave-cli}} issue-store transition "$ID" "$COARSE"   # re-running with the held rung is a clean no-op (exit 0)

# coarse === null (parked) → NOT a transition. Execute the null as a release:
{{wave-cli}} issue-store unclaim "$ID"   # idempotent — already released at park time
# Never `transition <id> null`. `null` means "no claim to hold", not "unknown".

# 7. Flag the fatals (corrupt/orphan) — paused, not re-dispatched
{{wave-cli}} issue-store flag "$ID" --kind terminal-failure \
  --question "corrupt sidecar(s): report@1 — disposition required" \
  --option re-dispatch --option abandon

# 8. ONLY NOW: hand the decision==="redispatch" rows to wave-start — i.e. run
#    ITS compose step over this same spine (wave-start/reference/start-mechanics.md
#    step 6). One verb, no resume-specific wiring:
{{wave-cli}} compose-driver \
  --spine "$SPINE" --config "$WAVE_CONFIG" \
  --anchor "$ANCHOR_SHA" --out "$REPO/.flotilla/tmp/resume-$SLUG/driver.js"
#    --out sits INSIDE the repo (the gitignored .flotilla/tmp/), same as
#    wave-start's own step 6: the harness Workflow tool reads this file itself
#    and can only start from a path the session may read — outside the working
#    directory that would first need /add-dir or a Read allow rule.
#    It composes exactly the rows the spine has in a dispatchable state, so the
#    `adopt`/`keep`/`needs-attention` rows this reconciliation left alone are
#    excluded by the spine itself rather than by a second hand-kept list. Each
#    composed row's spec is re-read from the tracker on this run (ADR-0041's
#    unconditional re-fetch — it is the verb's behaviour, not a discipline to
#    remember), and a human-gated, `foreground` or branch-less row is refused
#    (exit 1) rather than dispatched. Read the receipt before handing --out to
#    the harness Workflow tool.
```

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `{{wave-cli}} resume` | `{ rows, fatals, cleanup }` on stdout | domain failure during assembly/resume | missing `--spine`/`--reports`/`--verdicts` |
| `worktree-cleanup` | clean | per-worktree removal errors | usage |
| `spine read` | spine source on stdout | bad path / parse | usage |
| `read-closing` | `ClosingState` | issue not found | usage |
| `verdict-acked` | `{ acked, iter, corrupt }` printed (found or not found — an absent/corrupt verdict is not a failure) | — | missing `<verdictsDir>`/`<id>` |
| `close` | closing facts recorded (done-reconcile / FOR-13 fallback) | issue not found (store threw) | missing `<id>`/`<prUrl>` |
| `transition` | written (idempotent) | invalid transition / not found | usage |
| `flag` | written | issue not found | bad `--kind` |

(`{{wave-cli}} resume` returns exit 0 even when `fatals[]` is non-empty — a corrupt sidecar is a *routed* outcome, not a CLI failure; the fatals surface in the JSON, not the exit code. Same for `cleanup[]`: a `blockedByDirty: true` entry is a routed outcome, not a failure — it never fails the whole run over one dirty worktree it correctly refused to touch.)

## Why disk beats the spine

`resume()` reconstructs each row's fine state from the **newest durable artifact**, not the spine's last-flushed claim. A row the spine marks `verdict-in` whose verdict sidecar is missing downgrades to `report-in` (the flip never landed before the kill); a fresh report newer than the verdict is `report-in awaiting review` (a re-dispatch restarted the cycle). This is the load-bearing ADR-0002 property: the spine is the WAL, but a non-landed flip in it loses to what the disk proves.

## Disclaimer

The reconciler is PURE and never reads the tracker — the tracker is healed FROM the reconstruction (one-way). `resume()` projects to a `ClaimRung` only; reaching `done` is the skill's done-reconcile (step 5), and reaching `available` is eligibility (not a resume concern). All reconciliation — re-projection, done-reconcile, fatal flags — completes before any re-dispatch.

Crash-cleanup (`cleanup[]`, FOR-10) is NOT part of the pure `resume()` reconciler — it is an I/O side-effect the `{{wave-cli}} resume` router subcommand runs immediately after calling `resume()`, using its own injectable `RedispatchCleanupOps` seam (`tools/wave/src/worktree-cleanup.ts`). It only ever touches a `redispatch` row's OWN branch/worktree; it never reads or writes the tracker either.

The general sweep (step 4b, `{{wave-cli}} worktree-cleanup --orphans --detached`) is a SEPARATE call through the same module, not a variant of crash-cleanup — it is the identical, repo-wide, row-unscoped sweep `wave-close` phase 3 and `wave-start`'s dispatch preflight already run, and it is what reaches the Scribe's `.flotilla/tmp/` scratch payloads (issue #355) on the resume path. Before step 4b was wired, resume was the one path this sweep never reached (a repo-wide grep found the Scribe scratch path at four driver sites and two spec sites and in every cleanup path except this one).
