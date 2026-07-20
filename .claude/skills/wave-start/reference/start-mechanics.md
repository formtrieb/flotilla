# wave-start — start mechanics

The engine-CLI plumbing for the dispatch loop. `SKILL.md` owns the judgment (gate stances, STOP handling, WAL ordering rationale); this file owns the exact invocations + exit codes. The Workflow script itself is in [workflow-driver.md](workflow-driver.md).

> **The CLI is the source of truth for shapes.** Every command prints usage with no args and validates input on every call. Run store-touching verbs from a dir containing `wave.config.json`, or append `--config <path>` **after** the subcommand + op. The routing verbs (`route-outcome`/`route-verdict`/`validate-report`/`validate-verdict`) are **top-level** — no `--config` (they wrap pure adapters, no store).

## `{{wave-cli}}` resolution

The wave engine CLI; in-repo `npx tsx tools/wave/src/cli.ts`. Store-touching verbs (`spine`, `issue-store`, `dor`, `cross-wave`, `detect-host`) read the store config; the routing/validation verbs do not.

## Phase sequence

```bash
SLUG=<2026-06-18-topic>; REPO=<consumer-root>; SPINE=".flotilla/waves/$SLUG.md"

# 1. Load + status-gate (spine read prints RAW MARKDOWN)
{{wave-cli}} spine read "$SPINE"          # read the **Status:** line + rows + Conflict-Map
#   frontmatter **Status:** is a markdown bold line (NOT yaml `status:`)
#   draft  → auto-flip to ready:
{{wave-cli}} spine set-status "$SPINE" ready   # idempotent no-op if already ready; exit 1 if no Status field
#   ready  → proceed; in-flight or anything else → STOP

# 2. Concurrency invariant — count running rows in every OTHER spine
for s in .flotilla/waves/*.md; do
  [ "$s" = "$SPINE" ] && continue
  {{wave-cli}} spine read "$s" | grep -cE '\|[[:space:]]*(dispatched|re-dispatched)[[:space:]]*\|'
done   # sum MUST be 0; >0 → STOP (another wave is in-flight)

# 3. Drift gate (per row) + Blocked-by membership resolution (FOR-8)
{{wave-cli}} dor --id "$ID" --repo-root "$REPO"           # overall MUST stay PASS
{{wave-cli}} issue-store listClaimed > "$T/claimed.json"
{{wave-cli}} cross-wave --candidates "$T/cands.json" --claimed "$T/claimed.json" --repo-root "$REPO" \
  > "$T/cross-wave-result.json"
#   compare result.intraWaveConflicts vs spine ## Conflict-Map — any NEW cell → STOP
#   result.intraWaveBlockedByPairs: { blocked, blocker, resolved }[] — engine-resolved
#   (cross-wave.ts findIntraWaveBlockedByPairs). Any pair with resolved==false marks
#   its `blocked` id HELD — collect the HELD id set from this file, e.g.:
HELD_IDS=$(node -e '
  const r = require("'"$T"'/cross-wave-result.json");
  const held = new Set(r.intraWaveBlockedByPairs.filter(p => !p.resolved).map(p => p.blocked));
  console.log([...held].join(" "));
')
#   HELD_IDS is NOT a STOP condition — skip these ids in steps 5 and 6, report them
#   plainly in step 9. A row leaves HELD_IDS once its blocker's IssueView.status
#   reaches in-review/done — re-run wave-start to pick it up.

# 3a. OPTIONAL Coordinator disposition — park a HELD row instead of waiting
#     (ADR-0022 §Consequences). A HELD id is still `planned` (never dispatched),
#     one of the two legal entry states into `parked` — park it directly, spine
#     first (WAL). Never automatic: only run this for an id you have decided to
#     park; every other HELD id just waits (no CLI call at all).
{{wave-cli}} spine set-row-state "$SPINE" "$ID" parked   # fine state, FIRST — from planned
{{wave-cli}} issue-store unclaim "$ID"                    # releases the claim → available
#   Terminal, no un-park: the id is out of THIS wave for good. Do not flag it —
#   parked is silent. Report it in step 9 same as a HELD row, without the
#   "waiting on <blocker>" clause.

# 4. Host auth-preflight (one-shot)
{{wave-cli}} detect-host "$(git -C "$REPO" remote get-url origin)"   # → { host, workspace, repo }
#   then gh auth status (GitHub) — fail → STOP before the flip

# 5. Mark each NON-HELD row in-flight (WAL: spine first, then rung, in row order).
#    Skip any id present in HELD_IDS (step 3) — its State stays `planned`.
#    Per row, bind $ID / $ROW_SLUG / $MODEL from the roster — the SAME id+slug+model
#    that go into the Workflow ISSUES array (workflow-driver.md), NOT the wave-level
#    $SLUG. Both spine writes precede the coarse rung (spine-first WAL).
{{wave-cli}} spine set-row-state "$SPINE" "$ID" dispatched              # fine state, FIRST (WAL)
{{wave-cli}} spine set-branch    "$SPINE" "$ID" "wave/$ID-$ROW_SLUG" --model "$MODEL"
#   ^ durable branch home (ADR-0021): resume() joins worktrees to rows by this
#     branch via branchesByIssueId. WITHOUT it, resume redispatches committed
#     rows and discards their work. Record it BEFORE the worktree/Worker exists,
#     and it MUST byte-match wave/${issue.id}-${issue.slug} in workflow-driver.md
#     (line 99/118) or the join fails.
{{wave-cli}} issue-store transition "$ID" in-flight                     # coarse rung, second

# 6. Dispatch — compose + run the Workflow script (workflow-driver.md), ISSUES
#    built from the non-HELD rows only (HELD_IDS excluded from the array).
#    The driver's Scribe stages persist each sidecar AT AGENT-RETURN via
#    write-report/write-verdict (ADR-0024) — nothing is written bundled in step 9.

# 7. Route each returned tuple (see below) — incl. the sidecar existence check (7.0)

# 9. Report-only. Sidecars are ALREADY on disk (Scribe stages in step 6; any
#    missing one written at 7.0). No bundled write here — that was the P-1 kill
#    window and is removed. Just print the spine path + per-row final state + PRs.
```

## The in-flight row detector (step 2, verified)

`spine read` prints raw markdown — the Plan-Table `State` column is pipe-delimited and **space-padded** to the column width. Match it padding-tolerantly:

```bash
{{wave-cli}} spine read "$s" | grep -cE '\|[[:space:]]*(dispatched|re-dispatched)[[:space:]]*\|'
```

- `dispatched` / `re-dispatched` are the two *running* states (a Worker is out). `planned`/`pr-created`/`approved`/`failed`/`abandoned`/etc. are not running → not counted.
- Run it over every **other** spine; this wave's own spine is exempt (idempotent re-entry may already carry running rows).
- A Title cell containing the literal word `dispatched` padded by pipes is a theoretical false-positive only; real titles do not carry pipe-padded state tokens.

## Routing a tuple `{ id, risk, iteration, report, verdict }`

```bash
# 7.0. Sidecar existence check (recovery path, not the default). The Scribe stages
#      (step 6) already wrote these at agent-return; confirm, and write any missing
#      one through the SAME verb — never hand-format, never bundle.
REPORTS=".flotilla/waves/$SLUG/reports"; VERDICTS=".flotilla/waves/$SLUG/verdicts"
[ -f "$REPORTS/$ID-$ITER.md" ] || \
  {{wave-cli}} write-report  "$T/report-$ID.json"  --dir "$REPORTS"  --id "$ID" --iter "$ITER"
[ -f "$VERDICTS/$ID-$ITER.md" ] || \
  {{wave-cli}} write-verdict "$T/verdict-$ID.json" --dir "$VERDICTS" --id "$ID" --iter "$ITER"
#   write-* validates-then-writes: exit 1 = invalid payload / report.issue↔--id
#   mismatch → NOTHING written (re-collect); exit 0 prints the absolute path.

# 7a. Worker-phase gate (state = dispatched on iter 1, re-dispatched on iter 2)
WSTATE=$([ "$ITER" -gt 1 ] && echo re-dispatched || echo dispatched)
{{wave-cli}} route-outcome --outcome "$OUTCOME" --state "$WSTATE"
#   a clean worker-done →  {"event":"worker-done","outcome":{"type":"transition","nextState":"report-in"}}
#   outcome.type=='transition' && nextState 'report-in' → proceed to 7b
#   else apply outcome directly (transition→re-dispatched: step 7d; stop: step 8)

# 7b. Reviewer-phase routing (state = reviewing)
{{wave-cli}} route-verdict --verdict "$VERDICT" --iteration "$ITER" --risk "$RISKCLASS" --state reviewing
#   → { "event": "...", "outcome": { "type": "...", ... } }

# 7c. Apply (WAL — spine first, then rung)
# transition → approved:  render the verdict, then open the PR through the
#   engine (NEVER gh pr create). find-before-create is idempotent: the Worker
#   already opened it (report.prUrl); this re-pins the same open PR — no
#   duplicate. --body carries the rendered `## Reviewer verdict` section
#   (wave-shared "the reviewer-verdict render") ABOVE the store-kind close
#   phrase (Convention 4), the ONLY tracker id the title/body may name.
#   github-only in M1 (bitbucket/unknown fail loud + typed); reads GITHUB_TOKEN.
VERDICT_SECTION=$({{wave-cli}} render-verdict "$VERDICTS" "$ID" --anchor "$ANCHOR_SHA")
#   $ANCHOR_SHA is the row's roster-bound anchor — the SAME value threaded into
#   this row's Worker/Reviewer briefs as `issue.anchorSha` (workflow-driver.md).
#   render-verdict reads the MAX-iter valid verdict sidecar — the LATEST
#   iteration's verdict, never a stale one from a changes-requested →
#   re-dispatch cycle.
PR_URL=$({{wave-cli}} host-pr create --branch "wave/$ID-$SLUG" \
  --title "$PR_TITLE" --body "$PR_BODY_WITH_CLOSE_PHRASE_AND_VERDICT" | \
  jq -r '.url')   # or reuse report.prUrl — both resolve to the one open PR
#   $PR_BODY_WITH_CLOSE_PHRASE_AND_VERDICT = "<summary>\n\n$VERDICT_SECTION\n\n<close phrase>"
{{wave-cli}} spine set-row-state "$SPINE" "$ID" pr-created
{{wave-cli}} spine set-row-pr    "$SPINE" "$ID" "$PR_URL"
{{wave-cli}} issue-store transition "$ID" in-review

# 7d. transition → re-dispatched (cap=1 — enforced by transition() itself):
{{wave-cli}} spine set-row-state "$SPINE" "$ID" re-dispatched
{{wave-cli}} spine set-row-iter  "$SPINE" "$ID" 2   # cap=1 → the new iteration is always 2;
#   bumps the Plan-Table Iter cell + re-renders the sidecar-link cell to the
#   <id>-2 reports/verdicts paths (observability-only, FOR-53 — the reconciler
#   still reads the max-iter sidecar off disk, never this cell, per ADR-0024)
#   then re-dispatch the same Worker at iteration 2 with changes-requested items appended

# 8. stop → flag needs-attention
{{wave-cli}} issue-store flag "$ID" \
  --kind <recoverable-stop|terminal-failure> \
  --question "<Coordinator decision needed>" \
  --option "<A>" --option "<B>"

# 8a. OPTIONAL Coordinator disposition of a `terminal-failure` STOP — park instead
#     of abandoning (ADR-0022 §Consequences). The stopped row is still live
#     (dispatched/re-dispatched/reviewing); `parked`'s only legal entries are
#     `planned`/`failed`, so land it in `failed` first (the existing stop path),
#     then park, then release the claim, then clear the flag set in step 8 —
#     parking answers its own question. Never automatic: only for an id you
#     have decided will be re-planned into a FUTURE wave, not this one.
{{wave-cli}} spine set-row-state "$SPINE" "$ID" failed    # from the live state
{{wave-cli}} spine set-row-state "$SPINE" "$ID" parked    # from failed
{{wave-cli}} issue-store unclaim "$ID"                     # releases the claim → available
{{wave-cli}} issue-store clear-flag "$ID"                  # parked is silent, not needs-attention
```

### Verified routing outputs (the JSON these verbs actually print)

| Invocation | Output |
|---|---|
| `route-outcome --outcome done --state dispatched` | `{"event":"worker-done","outcome":{"type":"transition","nextState":"report-in"}}` |
| `route-verdict --verdict approve --iteration 1 --risk mechanical --state reviewing` | `{"event":"reviewer-approve","outcome":{"type":"transition","nextState":"approved"}}` |
| `route-verdict --verdict approve --iteration 1 --risk public-API-change --state reviewing` | `{"event":"reviewer-approve-public-api","outcome":{"type":"stop","reason":"public-api-approval-required","severity":"blocking"}}` |
| `route-verdict --verdict changes-requested --iteration 1 --risk isolated-refactor --state reviewing` | `{"event":"reviewer-changes-requested-1st","outcome":{"type":"transition","nextState":"re-dispatched"}}` |
| `route-verdict --verdict changes-requested --iteration 2 --risk isolated-refactor --state re-dispatched` | `{"event":"reviewer-changes-requested-2nd","outcome":{"type":"stop","reason":"re-dispatch-cap-exhausted","severity":"error"}}` |

The public-API `approve` STOPs (it never silently fast-paths to the auto-PR) and the 2nd `changes-requested` STOPs (the cap=1, enforced inside `transition()`) are the two load-bearing routes — verified against the live CLI.

## `riskClass` for `route-verdict`

Read it **off the typed `ReviewerVerdict`** (`verdict.riskClass`), never from the spine row or by eye — the verb forwards it to `verdictToEvent`, which bifurcates the `approve` branch (a `public-API-change` approve STOPs for human confirm). Omitting/garbling it is the G3 bug the typed return + this verb structurally prevent.

## STOP-reason → flag kind

| `stop.reason` | `--kind` | Why |
|---|---|---|
| `reviewer-questions-blocking` | `recoverable-stop` | needs a Coordinator decision; resumable |
| `public-api-approval-required` | `recoverable-stop` | human confirm before PR; resumable |
| `re-dispatch-cap-exhausted` | `recoverable-stop` | cap hit; Coordinator decides next |
| `worker-stalled` (warn) | `recoverable-stop` | inspect; may still be running |
| `worker-failed` | `terminal-failure` | confirmed failure; re-plan |
| `same-file-conflict` | `terminal-failure` | overlap; re-plan / serialize |

A `terminal-failure` row's eventual disposition is not always `abandoned` — step 8a above (park instead of abandon, ADR-0022) is the scripted alternative when the Coordinator decides the work belongs in a future wave rather than staying flagged in this one.

## Exit codes

### `route-outcome` / `route-verdict`
| Code | Meaning |
|---|---|
| `0` | routed — JSON `{ event, outcome }` on stdout |
| `1` | domain failure (`outcomeToEvent`/`verdictToEvent`/`transition` threw — bad outcome/verdict/risk/state) |
| `2` | usage error (missing flag) |

### `validate-report` / `validate-verdict`
| Code | Meaning |
|---|---|
| `0` | `valid` |
| `1` | invalid — errors on stderr |
| `2` | usage error (missing `<file>` or unreadable JSON) |

### `write-report` / `write-verdict` (the Scribe / recovery write, ADR-0024)
| Code | Meaning |
|---|---|
| `0` | written — absolute path of `<id>-<iter>.md` on stdout (`mkdir -p`, last-writer-wins) |
| `1` | invalid payload, or `report.issue`↔`--id` mismatch — **nothing written** |
| `2` | usage error (missing `<json-file>`/`--dir`/`--id`/`--iter`, non-integer `--iter`, or unreadable/unparseable `<json-file>`) |

### `issue-store flag`
| Code | Meaning |
|---|---|
| `0` | written |
| `1` | issue not found |
| `2` | usage error / invalid `--kind` (arg-validation failure) |

### `issue-store transition`
| Code | Meaning |
|---|---|
| `0` | written |
| `1` | invalid rung / invalid transition (domain failure) |
| `2` | usage error (missing args) |

### `issue-store unclaim` / `clear-flag` (the parked-disposition release calls)
| Code | Meaning |
|---|---|
| `0` | written — claim dropped / flag cleared (idempotent: a re-run with no claim / no flag is still `0`) |
| `1` | domain failure (store threw — e.g. issue not found) |
| `2` | usage error (missing `<id>`) |

### `spine set-row-state` / `set-row-pr` / `set-branch`
| Code | Meaning |
|---|---|
| `0` | spine flushed |
| `1` | domain failure — `set-row-state`/`set-row-pr`: row id not in Plan-Table; `set-branch`: spine has no `dispatch-log:` key (`renderSpine` scaffolds it, so this means a hand-broken spine) |
| `2` | usage error (missing args) or **invalid state token** (`set-row-state` validates against `ROW_STATES` at the CLI boundary → fail loud, exit 2); `set-branch` with `--model` but no value → 2 |

## P8 hardening notes

### `spine set-status` — frontmatter Status flip

`spine set-status <spine-path> <status>` surgically flips the `**Status:**` frontmatter line to `<status>`. The valid tokens are `draft`, `ready`, `in-flight`, `closed` (validated at the CLI boundary — unknown tokens exit 2 with an error; see `SPINE_STATUSES` in `wave-md-rw.ts`).

**wave-start** calls it automatically in step 1 to flip `draft → ready`; the call is idempotent (re-running on an already-`ready` spine is a byte-identical no-op).

**Never hand-edit the `**Status:**` line** — it is parser-consumed (`readSpine` captures `Frontmatter.status` at a recorded line index); a manual edit risks the byte-preserving round-trip the `renderSpine`/`SpineStore` design exists to protect (ADR-0016).

#### Exit codes for `spine set-status`

| Code | Meaning |
|---|---|
| `0` | Status line flipped (or no-op if already that value) |
| `1` | Domain failure: spine has no `**Status:**` frontmatter field |
| `2` | Usage error: missing args, or unknown status token (not in `draft`/`ready`/`in-flight`/`closed`) |

### `splitTableRow` pipe-awareness

**`splitTableRow` is pipe-unaware** (engine-wide P8 note carried from P7.3): a tracker id/title containing a literal `|` is sanitized at render time (`|`→`｜`) but the parser's row splitter is still pipe-naive — full hardening is P8.

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `done` is the derived bookend the merged PR's store-kind close phrase (`wave-shared` Convention 4) produces out-of-band (ADR-0002). wave-start ends at `in-review` / `pr-created` — it opens PRs but **never merges**. `needs-attention` (the `flag` verb) is **orthogonal** to the rung: a flagged row keeps its rung, and `read().status` surfaces `needs-attention` with precedence in the coarse projection without losing the underlying claim.
