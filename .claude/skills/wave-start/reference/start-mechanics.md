# wave-start — start mechanics

The engine-CLI plumbing for the dispatch loop. `SKILL.md` owns the judgment (gate stances, STOP handling, WAL ordering rationale); this file owns the exact invocations + exit codes. The Workflow script itself is in [workflow-driver.md](workflow-driver.md).

> **The CLI is the source of truth for shapes.** Every command prints usage with no args and validates input on every call. Run store-touching verbs from a dir containing `wave.config.json`, or append `--config <path>` **after** the subcommand + op. The routing verbs (`route-outcome`/`route-verdict`/`validate-report`/`validate-verdict`) are **top-level** — no `--config` (they wrap pure adapters, no store).

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — the Coordinator reads it host-side at compose time, the driver's `WAVE_CLI` constant is filled from it ([workflow-driver.md](workflow-driver.md)), and every dispatched role inherits that one string. There is no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP before the flip, never something to guess at: it means `wave-setup` has not finished in this repo. Step 4b below reads the same field to scope the plugin/engine lockstep gate. Store-touching verbs (`spine`, `issue-store`, `dor`, `cross-wave`, `detect-host`) read the store config; the routing/validation verbs do not.

## Phase sequence

```bash
SLUG=<2026-06-18-topic>; REPO=<consumer-root>; SPINE=".flotilla/waves/$SLUG.md"
# Operator-held constants: values you already know and RETYPE in each Bash call.
# That is what makes them safe to name below, and it is the property a captured
# value lacks — not the `$` sigil (Convention 12). The scratch dir is a literal
# path for the same reason, never `T=$(mktemp -d)`: nothing to capture, nothing
# to guard, nothing that has to survive a call boundary. Outside the repo, so it
# never dirties the tree the working-tree gates read. `-m 700` makes it
# owner-only, matching what `mktemp -d` gave — plain `mkdir -p` defaults to
# 0755, which would leave the wave roster world-readable at a predictable path
# inside world-writable /tmp.
mkdir -p -m 700 "/tmp/flotilla-start-$SLUG"

# 0. THE CALL BOUNDARY (wave-shared Convention 12, half two). There is no setup
#    step here — deliberately. This file used to define a `require_capture()`
#    helper "once per wave-start shell session" and invoke it at steps 4b and 7c;
#    that helper is RETIRED, because a shell function is session state and shell
#    state does not survive from one Bash call to the next. A guard defined in one
#    call and invoked in another was never in scope for the value it named.
#
#    The rule that replaces it, applied at every capture below:
#      * verify a captured value IN THE SAME Bash call that produced it —
#        inline, with `if`, never `case`/`esac` (Convention 13, Catalog entry 1);
#      * or better, do not capture it at all: re-query its source in the call
#        that needs it. Step 7c does exactly that — `host-pr status --branch`
#        instead of a PR URL carried forward from `host-pr create`.
#    Refuse `null` and `undefined` alongside `''` (jq -r on a missing key prints
#    the four characters `null`), and print only the NAME, never the value — a
#    capture may be a credential (Convention 8).
#
#    Not every capture below is in the class. `HELD_IDS` (step 3) is empty on the
#    ordinary "no held rows" wave — a legitimate ANSWER, not a did-not-run — and
#    is deliberately left unguarded; guarding it would be a false alarm, and
#    false alarms are how guards get deleted (Convention 12's own rule).

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
{{wave-cli}} dor --id "$ID" --repo-root "$REPO" --config "$REPO/wave.config.json"   # overall MUST stay PASS
#   --config here is not the same convenience as line 5's "run from a dir
#   containing wave.config.json, or append --config" — that equivalence does
#   NOT hold for Gate 8 (verify-profile-coverage): it only sees the consumer's
#   verify block when THIS call names --config explicitly, regardless of cwd.
#   Two outcomes share the `deferred` status text but are not the same fact —
#   RESOLVABLE (--config passed, wave.config.json loaded, verify.profiles
#   actually weighed against this row's files → a real pass/warn) vs
#   GENUINELY ABSENT (no --config reached this call, so the gate never had a
#   verify block to check — the defer says nothing about the row's coverage,
#   only that this invocation didn't ask). Passing --config as shown lands
#   this re-check in the resolvable state on every ordinary run.
#   --repo-root ALSO turns on `files-touched-since-tracker-update` (the
#   staleness advisory, ADR-0034's born-structural case): git is asked whether
#   the default branch touched this row's declared Files since the row's last
#   tracker update, and a `warn` NAMES the touching commits and the ref it
#   compared against. It is ADVISORY in every path — it has no FAIL, so it can
#   never be the reason `overall` leaves PASS, and it must never be treated as
#   a STOP. The response it asks for is a RE-READ, and it is the Coordinator's:
#   open the row body and check its acceptance criteria against main before you
#   dispatch it. This re-check is the LAST gate before fan-out, so it is the
#   last place a premise that went stale between wave-create and now can still
#   be caught — wave-create ran the same gate, but main may have moved since.
#   A `deferred` here is an unknown, never a clean bill: it means no checkout,
#   no tracker-update timestamp from the store, or no readable default-branch
#   history. Judgment stance in full: the wave-create SKILL body, step 3.
{{wave-cli}} issue-store listClaimed > "/tmp/flotilla-start-$SLUG/claimed.json"
{{wave-cli}} cross-wave --candidates "/tmp/flotilla-start-$SLUG/cands.json" --claimed "/tmp/flotilla-start-$SLUG/claimed.json" --repo-root "$REPO" \
  > "/tmp/flotilla-start-$SLUG/cross-wave-result.json"
#   cands.json is this wave's roster IssueViews, written out the same way
#   create-mechanics builds its own (accumulate the `issue-store read` outputs).
#   compare result.intraWaveConflicts vs spine ## Conflict-Map — any NEW cell → STOP
#   result.intraWaveBlockedByPairs: { blocked, blocker, resolved }[] — engine-resolved
#   (cross-wave.ts findIntraWaveBlockedByPairs). Any pair with resolved==false marks
#   its `blocked` id HELD — collect the HELD id set from this file, e.g.:
HELD_IDS=$(node -e '
  const r = require("'"/tmp/flotilla-start-$SLUG"'/cross-wave-result.json");
  const held = new Set(r.intraWaveBlockedByPairs.filter(p => !p.resolved).map(p => p.blocked));
  console.log([...held].join(" "));
')
#   HELD_IDS is NOT a STOP condition — skip these ids in steps 5 and 6, report them
#   plainly in step 9. A row leaves HELD_IDS once its blocker's IssueView.status
#   reaches in-review/done — re-run wave-start to pick it up.
#   It is also deliberately NOT guarded, and this
#   is the line that says so: an empty HELD_IDS is the ordinary "nothing is held"
#   ANSWER, not a did-not-run. Guarding it here would be a false alarm, and false
#   alarms are how guards get deleted — wave-shared Convention 12's "guard the
#   capture whose emptiness means *did not run*, not the one whose emptiness is
#   an answer" half.

# 3b. The HUMAN gate — the second, independent hold, on the WORKER axis. Needs no
#     store call and no cross-wave result: both facts are already in the spine you
#     read at step 1. A row is HUMAN-HELD iff its Worker cell names a human-gated
#     value AND its State is still `planned`. The mechanical cross-check over the
#     raw markdown, shaped exactly like the step-2 in-flight detector (the State
#     cell is pipe-delimited and space-padded; so is the Worker cell):
{{wave-cli}} spine read "$SPINE" | grep -E '\|[[:space:]]*HITL-required[[:space:]]*\|'
#   Each matching line IS a Plan-Table row — its first cell is the id, its State
#   cell tells you whether it is still held. `HITL-required` is the DEFAULT token
#   (HUMAN_GATED_WORKER in tools/wave/src/wave-md-rw.ts, whose `humanHeldRowIds`
#   is the engine-side owner of this same conjunction); a consumer that trimmed or
#   re-spelled its Worker vocabulary substitutes its own token here.
#   Exit 1 (no match) is the ordinary "no human-gated row" answer — like HELD_IDS
#   above, it is an ANSWER, not a did-not-run, so it takes no capture guard and no
#   `|| exit`. Same padding-tolerance caveat as step 2's detector: a Title cell
#   containing the pipe-padded token would be a theoretical false positive only.
#   RELEASE IS AN EXPLICIT HUMAN "yes, it is done", asked per pass. Unattended =>
#   nobody to answer => HOLD. Skip every HUMAN-HELD id in steps 5 and 6 exactly as
#   you skip HELD_IDS, and report it in step 9 WITH the action it waits on.

# 3c. OPTIONAL Coordinator disposition — park a HUMAN-HELD row instead of waiting.
#     Identical to 3a below (a HUMAN-HELD row is `planned` for the same reason and
#     has never been dispatched); reach for it when the human action is not coming
#     in a useful timeframe. Never automatic.

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

# 4a. Worktree-count advisory — the E2BIG preflight (issue #238). One sandbox
#     filesystem-deny entry per REGISTERED worktree, profile cached per session:
#     past the exec argument limit every Bash spawn dies with E2BIG, subagents
#     included. ADVISORY, never a STOP (see the dedicated section below for why,
#     and for the recovery sequence — which requires a harness RESTART).
#     TWO TERMS, NOT ONE: this count proxies only the harness-injected half of
#     the exec argument budget. The command line a spawn carries (argv + env) is
#     the OTHER, independent term, and a measured occurrence blew the budget on
#     that term alone with a pristine population — so a count under the
#     threshold is NOT an E2BIG all-clear. See the section below.
WORKTREE_COUNT=$(git -C "$REPO" worktree list --porcelain | grep -c '^worktree ')
#   >12 → print the advisory and sweep before the flip; <=12 → silent, proceed.
#   12 == WORKTREE_COUNT_ADVISORY_THRESHOLD in tools/wave/src/worktree-cleanup.ts
#   (the engine owns the number, its rationale, and the advisory text). Every
#   literal `12` in this file is DRIFT-PINNED to that constant by
#   tools/wave/src/skill-schema-drift.spec.ts — change the constant without
#   changing these lines (or vice versa) and the engine test suite fails.
#   NARROWER THAN IT SOUNDS: that pin matches COMPARISON-SHAPED occurrences
#   only (`>12`, `<=12`, `≤ 12`, …) — the identical number written in prose is
#   not caught. The command-line-advisory block below (bytes, not worktrees)
#   is a SEPARATE, carved-out region in that spec file for exactly this
#   reason — it names its two byte constants but never restates either as a
#   literal, so nothing there is ever pinned against THIS 12.
#   The engine surfaces the same verdict machine-readably: every
#   `worktree-cleanup` run (--dry-run included) prints
#   worktreeCount { count, threshold, level, advisory } AND, for the second
#   term, commandLine { bytes, argvBytes, envBytes, argCount, envCount,
#   threshold, maxEntryBytes, maxEntryThreshold, level, advisory } from the
#   engine's checkCommandLineSizeAdvisory.
#   That one call checks TWO independent execve conditions and owns a NAMED
#   threshold constant for each, both in the same engine file:
#   COMMAND_LINE_ADVISORY_THRESHOLD_BYTES for the argv+env TOTAL (printed as
#   `threshold`, alongside the measured `bytes`), and its sibling
#   MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES for the PER-STRING cap on any ONE
#   argv/env entry (printed as `maxEntryThreshold`, alongside the largest
#   single entry's own size as `maxEntryBytes`). Read all four numbers there,
#   never restate any of them here.
#   `level` is `advisory` when EITHER trips, so a printed `level: ok` is a
#   two-condition all-clear — but `threshold` and `maxEntryThreshold` are two
#   DIFFERENT fields carrying two DIFFERENT budgets, so never read `threshold`
#   as the per-string budget: `maxEntryThreshold` is the field for that. THIS
#   step keeps the raw git form because the preflight runs before any
#   config/store resolution.
#   Deliberately NOT guarded: `grep -c` prints `0`
#   on no match, so this capture is never empty on a did-not-run — and a repo
#   with zero registered worktrees is impossible anyway (the primary checkout
#   always counts). Guarding it would be the false alarm Convention 12 warns
#   about, exactly like HELD_IDS above.

# 4b. Plugin/engine lockstep gate — the LAST gate before the flip, and a STOP
#     (ADR-0032). SCOPE FIRST: it bites only where it can mean something — a
#     repo whose `engine.cli` binding is the INSTALLED package form. On the
#     SOURCE form (this repo binds `engine.cli` to the vendored
#     `tools/wave/src/cli.ts` invocation) the skills and the engine come from
#     ONE SHA by construction, so the comparison is vacuous and the gate is
#     SKIPPED. Decide from the binding itself, never by feel.
#   ONE Bash call — the capture, its guard and the branch it decides all live
#   together, because a shell variable exists only in the call that set it
#   (Convention 12, half two, Form 2). `case`/`esac` is gone with the same
#   change: Convention 13's Catalog entry 1 has it refused outright from a
#   worktree-isolated dispatch, and one dialect across the skill surface is
#   worth more than the pattern-match's brevity here.
WAVE_CONFIG="$REPO/wave.config.json"   # or wherever this consumer keeps it
ENGINE_CLI=$(node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String((c.engine||{}).cli||""))' "$WAVE_CONFIG")
#   An empty ENGINE_CLI is never "unbound, carry on": every {{wave-cli}} call in
#   the steps above already used the binding, so nothing here could have run
#   without one. Empty means the config could not be read — a did-not-run.
if [ -z "$ENGINE_CLI" ] || [ "$ENGINE_CLI" = "null" ] || [ "$ENGINE_CLI" = "undefined" ]; then
  echo "STOP: ENGINE_CLI came back empty — wave.config.json could not be read (no such file? no engine.cli key?). Refusing to run the lockstep gate on nothing." >&2
  exit 1
fi
if echo "$ENGINE_CLI" | grep -q 'tools/wave/src/cli\.ts'; then
  : "source form — skills and engine share one SHA; lockstep vacuous, gate skipped"
else
  #   The EXPECTATION is the PLUGIN's version, read from the plugin manifest at
  #   THIS skill's own resolution anchor: the plugin clone is a full-repo clone
  #   and ships `.claude-plugin/plugin.json` (ADR-0031's premise). The engine
  #   never goes looking for it — it cannot know which clone the running skills
  #   came from — so it is TOLD. That division of labour IS the design: the
  #   engine knows only its own version and how to compare.
  PLUGIN_MANIFEST="<plugin-clone-root>/.claude-plugin/plugin.json"
  PLUGIN_VERSION=$(node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version||""))' "$PLUGIN_MANIFEST")
  if [ -z "$PLUGIN_VERSION" ] || [ "$PLUGIN_VERSION" = "null" ] || [ "$PLUGIN_VERSION" = "undefined" ]; then
    echo "STOP: PLUGIN_VERSION came back empty — the plugin manifest could not be read. Refusing to pass a value-less --expect." >&2
    exit 1
  fi
  {{wave-cli}} version --expect "$PLUGIN_VERSION"
  #   exit 0 → in lockstep; proceed to step 5
  #   exit 1 → STOP THE WAVE HERE, before the flip. Nothing is dispatched. The
  #            printed JSON carries `.repair` — the one-line fix, e.g.
  #            `npm i -D @formtrieb/flotilla-engine@<plugin-version>` — quote
  #            it verbatim in the STOP so the operator copy-pastes rather than
  #            derives. exit 2 is a malformed invocation of the gate itself
  #            (a value-less --expect), not a verdict: fix the call and re-run.
fi

# 4c. Anchor resolvability gate — a well-formed but FABRICATED anchorSha
#     (workflow-driver.md's own compose-time assertion only checks
#     presence/non-emptiness, not resolvability — see "The anchor-
#     resolvability gate" below) fails once here, host-side, instead of
#     reaching every Worker + Reviewer brief individually. Per row, before
#     ISSUES is composed:
git -C "$REPO" rev-parse --verify "${ANCHOR_SHA}^{commit}" > /dev/null
#   exit 0    → resolves to a real commit in this checkout; proceed.
#   non-zero  → STOP `(blocking) anchorSha for row $ID does not resolve — re-
#   derive it (git rev-parse HEAD at dispatch time) before composing ISSUES.

# 4d. Driver compose-currency gate — confirm the Workflow script about to be
#     dispatched is either freshly extracted from workflow-driver.md's current
#     `## The script` fence, or (if reused) has passed its seeded currency-
#     assertion checklist — see "The driver compose-currency gate" below and
#     workflow-driver.md's "The compose-fresh-or-verify rule". No engine verb
#     backs this one; it is a Coordinator discipline, run before ANY row is
#     composed into ISSUES.

# 5. Mark each NON-HELD row in-flight (WAL: spine first, then rung, in row order).
#    Skip any id present in HELD_IDS (step 3) — its State stays `planned`. Skip
#    every HUMAN-HELD id (step 3b) for the identical reason and by the identical
#    means: nothing is flipped, nothing is transitioned, the row is simply not
#    part of this pass. (The heading above says NON-HELD; both holds are HELD in
#    that sense — one on a sibling row, one on a human.)
#    Per row, bind $ID / $ROW_SLUG / $MODEL from the roster — the SAME id+slug+model
#    that go into the Workflow ISSUES array (workflow-driver.md), NOT the wave-level
#    $SLUG. Both spine writes precede the coarse rung (spine-first WAL).
{{wave-cli}} spine set-row-state "$SPINE" "$ID" dispatched              # fine state, FIRST (WAL)
{{wave-cli}} spine set-branch    "$SPINE" "$ID" "wave/$ID-$ROW_SLUG" --model "$MODEL"
#   ^ durable branch home (ADR-0021): resume() joins worktrees to rows by this
#     branch via branchesByIssueId. WITHOUT it, resume redispatches committed
#     rows and discards their work. Record it BEFORE the worktree/Worker exists,
#     and it MUST byte-match `issue.branch` in workflow-driver.md — NOT a line
#     number (those go stale the moment the script is edited; FOR-139 dropped
#     the last such reference for exactly that reason). workflow-driver.md
#     derives issue.branch exactly ONCE, immediately after ISSUES, from the
#     SAME formula (`wave/<id>-<slug>`) applied to the SAME id+slug this step
#     binds as $ID/$ROW_SLUG — see that derivation's own comment for the full
#     rationale. The two values are demonstrably the same because both read
#     off one roster row, not because the two files happen to agree today;
#     workflow-driver.md's REQUIRED_ROW_FIELDS additionally refuses to let
#     either half of that row be missing/blank/"undefined" before any brief
#     is composed.
{{wave-cli}} issue-store transition "$ID" in-flight                     # coarse rung, second

# 6. Dispatch — compose + run the Workflow script (workflow-driver.md), ISSUES
#    built from the DISPATCHABLE rows only (both HELD_IDS and the HUMAN-HELD ids
#    excluded from the array). The driver carries a `worker` field per row and
#    refuses at compose time if a human-gated one reached ISSUES anyway — the
#    structural backstop for this exclusion, in the same place as the
#    anchor/branch assertion (workflow-driver.md).
#    The driver's Scribe stages persist each sidecar AT AGENT-RETURN via
#    write-report/write-verdict (ADR-0024) — nothing is written bundled in step 9.
#    Per row, decide whether the slice SHIPS A NEW CHECK (wave-shared Convention
#    11) and, if so, name that check in the row's `reviewerHints` — the clause
#    itself needs no per-row wiring (it ships in every brief as workerBrief()
#    policy clause 9). See "Convention 11 at compose + routing" below.

# 7. Route each returned tuple (see below) — incl. the sidecar existence check (7.0),
#    the disclosure capture (7.0a, ADR-0027 — every tuple, before the outcome/verdict
#    branch), and, for a new-check row, the Convention 11 falsification read (below)

# 9. Report-only. Sidecars are ALREADY on disk (Scribe stages in step 6; any
#    missing one written at 7.0). No bundled write here — that was the P-1 kill
#    window and is removed. Print the spine path + per-row final state + PRs,
#    plus every disclosure this wave captured (7.0a) that is STILL open — see
#    "Listing this wave's still-open disclosures" below.
```

## The in-flight row detector (step 2, verified)

`spine read` prints raw markdown — the Plan-Table `State` column is pipe-delimited and **space-padded** to the column width. Match it padding-tolerantly:

```bash
{{wave-cli}} spine read "$s" | grep -cE '\|[[:space:]]*(dispatched|re-dispatched)[[:space:]]*\|'
```

- `dispatched` / `re-dispatched` are the two *running* states (a Worker is out). `planned`/`pr-created`/`approved`/`failed`/`abandoned`/etc. are not running → not counted.
- Run it over every **other** spine; this wave's own spine is exempt (idempotent re-entry may already carry running rows).
- A Title cell containing the literal word `dispatched` padded by pipes is a theoretical false-positive only; real titles do not carry pipe-padded state tokens.

## The human gate (step 3b) — the hold on the worker axis

**The detector.** Both facts the gate needs are already in the spine, so this step calls no store and needs no `cross-wave` result. `spine read` prints raw markdown; the `Worker` cell is pipe-delimited and space-padded exactly like the `State` cell, so it matches padding-tolerantly the same way:

```bash
{{wave-cli}} spine read "$SPINE" | grep -E '\|[[:space:]]*HITL-required[[:space:]]*\|'
```

Each matching line is a whole Plan-Table row — its first cell is the id and its `State` cell says whether it is still held. `HITL-required` is the **default** token; the authority is `HUMAN_GATED_WORKER` in `tools/wave/src/wave-md-rw.ts`, and a consumer that trimmed or re-spelled its Worker vocabulary substitutes its own. That module's `humanHeldRowIds` is the engine-side owner of the same conjunction, spec-covered with negative controls in `tools/wave/src/wave-md-rw.spec.ts`; the grep here is the operator-facing copy for a step that runs before any config resolution, exactly as step 4a keeps a raw `git` one-liner for the same reason.

**The predicate is a conjunction: human-gated `∧` still `planned`.** The Worker value alone is not the hold. A human-gated row that was released on an earlier pass has moved past `planned`, and re-holding it would mean the row could never finish — the gate would be permanent rather than a gate. `planned` is also precisely where an intra-wave-blocked HELD row waits, which is what makes this a *reuse* of that seam rather than a parallel mechanism: one held-row shape, one set of exclusions, two reasons to be in it.

**Release is an explicit human "yes, it is done", asked once per pass — and its default is hold.** The unattended case is the one this gate exists for, and in it there is nobody to answer, so the row is held. A gate whose default fires only when a human happens to be watching is not a gate. Nothing durable records the release: the row simply dispatches, moves past `planned`, and stops matching the predicate.

### Release semantics — the standing rule, not a provisional shape

The paragraph above is a **settled decision**, re-confirmed after the gate landed, and it is worth stating as a rule because its cost is real and someone will eventually propose paying it down. The rule has three parts, and they hold together:

1. **Per-pass confirmation.** The release question is asked fresh on every `wave-start` pass over the wave. It is never inherited from an earlier pass.
2. **HOLD is the unattended default.** No answer means held. This is the whole point: the gate must behave correctly when nobody is watching, which is the condition it exists for.
3. **No durable release marker.** Nothing is written when a human says yes — no state, no label, no spine field, no sidecar. Release is expressed by the row simply *dispatching*: it moves past `planned` and stops matching the predicate.

**The cost, stated plainly:** an **attended** Coordinator re-answers the same question on every pass over a wave that still holds a human-gated row. On a wave re-entered several times in a day that is a small, repeated tax on the one person who is present.

**Why we pay it anyway.** A durable "released" marker would be a second source of truth about whether a human has acted, and it would be **stale by default** — written once, then read on every later pass, including passes where the world has moved (the credential was rotated back, the sandbox policy changed, the row was re-planned). The gate's whole value is that its answer is *current*. This is the same reasoning the HELD seam already uses one level up: `wave-start` re-derives the intra-wave `resolved` set fresh on every entry rather than recording it, for exactly this reason. Two seams, one rule — and the state the gate reads (`planned`) is already durable, in the spine, which is the WAL authority. Adding a marker would not make anything more durable; it would only make one of the two records able to lie.

**What would change the decision.** Not "it was asked twice today" — that is the cost, already priced in. It would take a measured case where the *per-pass* question produced a **wrong** answer that a durable marker would have prevented: a human who said yes, and whose yes was then lost in a way that cost a wave. Until that exists, per-pass + HOLD + no marker is the rule, and a proposal to add a release marker should be read as a proposal to add a second source of truth.

**Nothing is written for a held row.** No new state, no label, no tracker call — `State` stays `planned`, the `ClaimRung` stays where `wave-create` left it, and step 9 reports the row plainly (with the human action it waits on) rather than flagging it. A held row is ordinary sequencing.

**The held row is also a close-time obligation.** Because nothing is written and the claim is never released, a row still held when the wave reaches close is carrying a **live `queued` claim** into the archive. [wave-close phase 6](../../wave-close/reference/phase-6-archive.md) blocks on exactly that (`spine check-awaiting-human`), with the same two exits — the human acts, or the row is parked and unclaimed. Holding a row is cheap during a wave and is *not* cheap past the end of one.

### Reading the lane through the engine

The grep above is the operator-facing detector, kept raw because step 3b runs before any config resolution. Once a config is in hand — at step 9's report, at close, or any time you want structured output — the same predicate is reachable as a CLI verb, so nothing downstream has to re-implement the conjunction:

```bash
{{wave-cli}} spine human-gated "$SPINE"        # JSON listing; exit 0 on a readable spine
{{wave-cli}} spine check-awaiting-human "$SPINE"  # the fail-closed gate; exit != 0 iff a row still holds a live claim
```

`human-gated` emits `rows[]` (every human-gated row with its `state` and an `awaitingHuman` flag) plus `awaitingHumanIds`. Both verbs take `--workers <a,b>` for a consumer-configured vocabulary and default to the engine's own token. Both read `humanHeldRowIds` — the same engine owner this section's grep is a copy of — so the shell form, the CLI and the archive gate cannot quietly disagree.

### Why the human lane exists — the measured constraint, not the folk version

The gate is worth having only if rows are classified `HITL-required` for real reasons, so know what the constraint actually measured out to be on the row that motivated this lane — a row whose work touched paths a dispatched agent could not update.

**Measured, end-to-end:** the blocker was the **Bash sandbox's write-deny on specific paths**. The agent's file-editing tool wrote the target file *fine*; what failed was **git plumbing under the sandbox, which could not unlink it**. Two consequences follow, and both matter when you are deciding whether a row belongs in this lane:

- **"An agent cannot write there" is the over-broad reading, and it is wrong.** Taken literally it classifies as human-gated a large set of rows an agent can in fact implement unattended, which costs exactly what this gate is supposed to save. The narrow, measured claim is about one tool path under one sandbox policy — not about agent write capability in general.
- **The remedy is therefore path- and tool-shaped, not personnel-shaped.** A row blocked this way may stop being human-gated when the sandbox policy or the write path changes, with nothing about the work itself having moved. Re-read the Worker value when that happens instead of treating it as settled.

Keep the distinction when you write a step-9 report: name the human action (`rotate the PAT in the keychain`, `approve the settings change`), never a blanket "agents can't write here".

## The worktree-count advisory (step 4a) — the E2BIG preflight

**The mechanism.** The agent harness composes its sandbox profile with one filesystem-deny entry per **registered** git worktree, and caches that profile for the whole session. Nothing about a single worktree is expensive; the *population* is. Once the profile exceeds the OS `exec` argument limit, every process spawn fails with `E2BIG` ("argument list too long") — the Coordinator's Bash calls and **every subagent's**, since a subagent inherits the same cached profile. Live occurrence 2026-07-30 during the resume of a seven-row wave, on the third dispatch run of the day; the subagent scope was confirmed with a minimal probe agent that hit the identical `E2BIG`.

**Why it belongs in the preflight, before the flip.** The failure has no partial mode. A wave dispatched into a session already past the limit does not degrade — every Worker's first shell call dies, and the wave consumes its whole agent budget on calls that could not have succeeded. Measuring costs one `git` invocation.

**The measurement.**

```bash
git -C "$REPO" worktree list --porcelain | grep -c '^worktree '
```

The count deliberately **includes the primary checkout**, because that is what `git worktree list` reports and therefore what an operator reproducing this by hand sees. The engine's `checkWorktreeCountAdvisory` (`tools/wave/src/worktree-cleanup.ts`) counts the same population against the same `WORKTREE_COUNT_ADVISORY_THRESHOLD`, so the shell form and the engine can never quietly disagree — and the engine is where the number, its rationale, and the advisory wording live. The threshold is set so one full seven-row wave plus its reviewer checkouts stays *under* it: an advisory that fires during ordinary operation is an advisory that gets ignored.

That advisory is also **CLI-reachable**, so nothing downstream has to re-implement the comparison: every `{{wave-cli}} worktree-cleanup` run — `--dry-run` included — prints `worktreeCount: { count, threshold, level, advisory }`, with `level` as `ok`/`advisory` and `advisory` carrying the engine's text verbatim (non-null exactly when `level` is `advisory`). It is read *before* any removal, so a preview and the real run report the same starting population, and it never affects the exit code. This step keeps the raw `git` one-liner because the preflight runs before any config/store resolution; the JSON field is the form to read once a sweep is already in hand. Both the literal above and the ones in the step-4a block are drift-pinned to the engine constant by `tools/wave/src/skill-schema-drift.spec.ts` — the number cannot diverge silently in either direction. **That pin is narrower than "the number is drift-pinned" sounds:** it catches COMPARISON-SHAPED occurrences of the number (`> 12`, `≤ 12`, `<=12`, …), never a prose restatement of the same value — an acceptance criterion that cites this guard as a general no-values-in-prose rule is promising more than it enforces.

**Advisory, not a gate — and this is a deliberate asymmetry with step 4.** A failed host-auth or credential probe STOPs the wave because the failure is *measured* (the token really did not authenticate). The worktree threshold is a *heuristic* about a harness-side limit nothing here can measure; converting it into a refusal would block a legitimately wide multi-wave day on a number no one can verify from inside the engine. `> 12` therefore reports and lets the Coordinator decide, and that decision is named in the step-9 report.

### Two terms, not one — the count is a proxy for only half the budget

The paragraphs above describe **one** term. A second live occurrence proved that model incomplete, and in the most expensive way available: an operator following it would have swept worktrees and fixed nothing.

**Measured** (wave `2026-07-30-arm-and-wiring`, row 250, worker disclosure 250.3): a real `E2BIG` at **~1019.5 KB of command line across just three argv entries**, with **166 sandbox deny paths of which only 15 were worktree-derived**. It was recovered by **compressing the PR body being passed as an argument** — no worktree was removed, and none needed to be. Two readings fall out of those numbers. The population term was about a *ninth* of the deny paths, and those paths' own bytes are a rounding error next to a megabyte of argv, so sweeping everything could not have brought that spawn under the limit. And three arguments is not an accumulation: a **single** oversized argument — a PR body, a composed agent brief, a file list — reaches the limit on its own, in a session whose worktree count is pristine.

So the exec argument budget is a **sum**: `(harness-injected sandbox profile, proxied by the worktree count) + (the command line this spawn carries: argv + env)`. `E2BIG` fires on the sum, and neither term alone predicts it.

**What that does to the threshold guidance above.** A count at or under the threshold means *this term* is fine; it does not mean the next spawn will succeed. Read both terms, always — the engine prints them side by side (`worktreeCount` and `commandLine`) on every `{{wave-cli}} worktree-cleanup` run, `--dry-run` included, each with its own `level` and its own verbatim `advisory` text. The second term's threshold is `COMMAND_LINE_ADVISORY_THRESHOLD_BYTES` in `tools/wave/src/worktree-cleanup.ts`, alongside the count's; as with the count, the engine owns the number, its rationale and its wording, and this file names the constant rather than restating its value.

### The command-line term is itself TWO conditions — total, and per-string

`execve` documents `E2BIG` on **two independent conditions**, not one, and a command line trips it by satisfying *either*:

- the **TOTAL** — the combined argv+envp bytes the spawn carries. This is the condition the measured occurrence above blew, and its advisory threshold is `COMMAND_LINE_ADVISORY_THRESHOLD_BYTES`.
- the **PER-STRING** cap — the kernel's `MAX_ARG_STRLEN`, a hard limit on any **single** argv or env entry. Its advisory threshold is the sibling constant `MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES`, in the same engine file.

Both constants live in `tools/wave/src/worktree-cleanup.ts`, which owns each number, its rationale and the advisory wording; this file names the two constants and deliberately restates *neither* value — a number copied into prose here is a number that can drift, which is exactly what the pin in `tools/wave/src/skill-schema-drift.spec.ts` exists to prevent for the count. Both constants are also reachable from the engine's **package root**, so a consumer can state or raise either budget without a deep import (pinned in `tools/wave/src/index.spec.ts`). That count-only pin is why this subsection (and its shell-block twin in the step-4a block above) is carved into its OWN region in that spec file, separate from the worktree-count region: a comparison-shaped byte value written here by mistake is caught and named as THIS subsection's own drift, never misattributed to the worktree-count threshold.

**Why an operator needs the second condition and not just the first.** A total safely under budget is *not* an all-clear. One oversized argument — a PR body, a composed agent brief, a pasted file list — can exceed the per-string cap on its own while the total sits nowhere near the total threshold, and the spawn dies anyway. `checkCommandLineSizeAdvisory` checks both and returns `level: advisory` when **either** trips, so reading `level` is sufficient; reading the printed `commandLine.threshold` is **not**, because that field carries the total threshold alone.

**The recovery differs per term, which is the whole point of separating them.** The population term is swept (plus the harness restart below). The command-line term is **shrunk at the caller** — compress the oversized body or brief, or pass it by file — and *no sweep and no restart move it at all*. Diagnose which term blew before reaching for either remedy: a Coordinator that answers every `E2BIG` with a worktree sweep will, on this incident's shape, restart a session and hit the identical failure on the very next call. Within the command-line term the two conditions refine that further: for the total, shrink the command line *overall*; for the per-string cap, shrink **the one oversized entry** — split it, compress it, or pass it by file. Trimming several small arguments is a real fix for the total and does nothing at all for the per-string cap.

**Recovery — the three steps, in order.** (For the *population* term; see the paragraph directly above for the command-line term, which none of these three steps touches.)

```bash
{{wave-cli}} worktree-cleanup --orphans --detached "$REPO"   # 1. sweep (wave-close phase 3 = reading guide)
git -C "$REPO" worktree prune                                # 2. clear unvalidatable administrative entries
#                                                              3. RESTART the harness — see below
```

`--detached` is what makes step 1 actually reach this incident's population. An agent's or reviewer's own hand-made detached scratch checkout is git-*registered* (so the `--orphans` directory sweep never sees it) and carries no `agent-`/`wf_` name prefix (so the name-allowlisted GC filters it out) — every other sweep structurally misses it, which is how it survives wave after wave. The sweep refuses anything where work could be staked: a branch-bearing worktree in the same root is skipped `live-branch`, a dirty one `dirty`, a locked one `locked`, and none of the three is ever removed. Prepend `--dry-run` to preview first — preview and run share one plan, so `detached.selected` names exactly what the run will remove.

Step 3 is not optional and is not intuitive: **cleanup alone does not recover a session that is already failing.** The profile is cached, so removing the worktrees fixes the population while the running session keeps the deny list it already built — every Bash spawn keeps dying. This was verified live: `git worktree remove` + `git worktree prune` did not restore the session, and only a harness restart did. Sweep *then* restart; a report that says "cleaned up, retrying" without the restart is describing a retry that cannot work.

**Between waves, not only before one.** The incident was the third dispatch run of a single day, and its residue came from the first two runs plus a previous session's leftovers. A multi-wave day wants this count re-read after every close, which is where [wave-close phase 3](../../wave-close/reference/phase-3-worktree-cleanup.md) picks it up.

## The plugin/engine lockstep gate (step 4b) — a STOP, not an advisory

**What is compared.** The version of the **plugin** the running skills came from against the version of the **engine** the configured `engine.cli` binding invokes. They are released together and carry the same version per release, so **exact equality is the whole check** — pre-1.0, no range, no major/minor-only compare. Loosening it is a post-1.0 decision, deliberately not anticipated.

**Division of labour.** The engine knows only *its own* version and how to compare it against an expectation handed to it (`{{wave-cli}} version --expect <v>`); it never goes hunting for a plugin manifest, because it has no way to know which clone the running skills came from. The **Coordinator** supplies the expectation, read from `.claude-plugin/plugin.json` at the skill's own resolution anchor — the plugin clone is a full-repo clone, so the manifest ships with it (ADR-0031's premise, paying off here).

**Why a STOP here, when step 4a is only an advisory.** The asymmetry is the same one that separates the host-auth probe from the worktree count: a lockstep skew is **measured**, not heuristic. A mismatched engine is a *different program* from the one the composed briefs describe — verbs it lacks, flags whose shape moved, exit codes that changed meaning — and the failure lands inside dispatched Workers, one per row, after the coarse ledger already says `in-flight`. There is no partial mode worth having and no cheaper moment to notice: the check costs one process spawn and runs *before* the flip.

**Scope: the installed form only.** The gate is meaningful exactly where the two halves can drift — a repo whose `engine.cli` points at the installed package binary, since the plugin and the npm package are then two independently-updatable artifacts. On the **source form** (this repo: `engine.cli` is the vendored `tools/wave/src/cli.ts` invocation) skills and engine come out of one checkout at one SHA, so the comparison cannot fail and the gate is skipped. Documented as vacuous rather than quietly always-run: a reader of a green gate should know whether it *held* or merely *could not fire* — and step 4b decides that from the binding string, not from anyone's sense of which repo they are in.

**The STOP message carries its repair.** The verb prints the fix as a field (`.repair`), so the STOP quotes it instead of deriving it:

```
STOP — plugin/engine lockstep: plugin is at <plugin-version>, engine at <engine-version>.
Repair: npm i -D @formtrieb/flotilla-engine@<plugin-version>
```

Single-owner, deliberately: the command lives in the engine (`tools/wave/src/cli-store.ts`), so the repair an operator is handed and the repair the engine believes in cannot drift.

**It cannot pass vacuously, and that is the load-bearing property.** A gate that reads green when one of its two inputs went missing is worse than no gate. So: a value-less or blank `--expect` is a **usage error** (exit 2), never "no expectation"; an engine that cannot read its own version is a **non-match** (exit 1), never a pass; and `match` is `true` only when both sides were read and are equal (`null` — never `true` — when nothing was compared).

**The same comparison, earlier and softer.** `{{wave-cli}} store-preflight --expect <plugin-version>` reports the identical check as an `advisory` entry in its `checks` array at setup/plan time. It never fails the preflight and never moves its exit code: at plan time a skew is information, and refusing there would block a `wave-plan` on a fact that only bites at dispatch. The refusal belongs *here*, where the next action is a dispatch.

## The anchor-resolvability gate (step 4c) — a fabricated SHA fails once, host-side

**What is checked, and why the existing compose-time assertion cannot catch it.** `workflow-driver.md`'s `assertRequiredRowFields` runs `isMissingField` over every row before any brief is composed — but that predicate tests presence/non-emptiness only (`undefined`, `null`, the literal string `"undefined"`, or a blank/whitespace-only value). A well-formed anchor SHA that simply does not name a real commit in this checkout — a fabricated value with a correct-looking short prefix, a copy-paste of the wrong hash, a stale value left over from an earlier session — is present and non-empty, so it passes that check exactly as a real anchor does. Nothing inside the composed script can catch the gap either: a Workflow `script` has no filesystem or git access (§Harness constraint, `workflow-driver.md`), so resolvability can only be checked host-side, by the Coordinator, before compose.

**Why this is a STOP and not left to the Reviewer.** A bad anchor reaches every row's Worker (`git reset --hard <anchorSha>`) AND every row's Reviewer (the diff base) individually — the defect is discovered N times, once per dispatched agent, instead of once. §Recovery protocol below already documents the cost of a bad anchor caught only downstream (two Reviewers returning spurious `questions-blocking` against the literal string `"undefined"`); an unresolvable-but-well-formed SHA is the same failure shape one layer earlier, and the check is one `git` invocation host-side.

```bash
git -C "$REPO" rev-parse --verify "${ANCHOR_SHA}^{commit}" > /dev/null
```

`--verify … ^{commit}` fails (non-zero) on anything that is not a real, resolvable commit object in this checkout — a fabricated hash, a real-looking prefix with no match, a SHA that belongs to a different remote/fork entirely — while passing on any resolvable commit-ish (full SHA, unique abbreviation, tag, branch). Run it per row, before `ISSUES` is composed and before step 5 flips anything.

**Live occurrence.** A fabricated anchor SHA with a correct 7-character prefix passed compose and reached four parallel Worker/Reviewer briefs; all four Workers independently caught it themselves during their own workspace-setup `git rev-parse HEAD` confirmation (workflow-driver.md's own step-2 check) — four agent budgets spent discovering, individually, a defect this one host-side check would have caught once, before any of them ran.

**Layered on top of, never a replacement for, the presence-only check.** `REQUIRED_ROW_FIELDS`/`isMissingField` in `workflow-driver.md` still catches an absent/blank/`"undefined"` `anchorSha` — that check is unchanged, and stays exactly as narrow as it was (Authoring constraint #7 there names why: it asks "is this field present enough to interpolate", not "does this value resolve"). This gate is the ONLY place that catches a well-formed value that does not exist.

## The driver compose-currency gate (step 4d) — the composed script is a copy, and copies go stale

Every dispatch composes the Workflow script from `workflow-driver.md`'s current `## The script` fence. That composition is a COPY, and — unlike a bad row (caught by step 4c above, or by `workflow-driver.md`'s own compose-time assertions) — a stale COPY of the whole driver is a defect nothing INSIDE the copy can detect: a copy's own assertions are exactly as out of date as the rest of it.

**The gate.** Before any row is composed into `ISSUES`, confirm the script about to be dispatched is either:

1. **freshly extracted** from `workflow-driver.md`'s current `## The script` fence at this compose time, or
2. **currency-checked**, if a previously-composed copy is being reused instead (a scratch file, a compose carried over from an earlier wave in the same session) — diffed against the document's CURRENT script and walked against the seeded currency-assertion checklist in `workflow-driver.md`'s "The compose-fresh-or-verify rule".

A copy that is neither is not eligible to dispatch. There is no engine verb behind this one and no exit code to read — it is a Coordinator discipline, the same shape as step 3b's per-pass human confirmation: asked fresh, every time, because the fact it checks (does this copy match the document) is exactly as perishable as that gate's own "has a human acted yet."

**Why this is a gate here and not just a note in `workflow-driver.md`.** The rule lives with its full rationale and its currency-assertion checklist in `workflow-driver.md` (where a Coordinator composing the script is already reading); this file names it as a required step in the dispatch sequence, in the same place the other pre-fan-out gates (4a, 4b, 4c) live, so a Coordinator following the phase sequence mechanically cannot skip past it the way a note living only in prose elsewhere could be skimmed over. Both motivating occurrences — a frozen template that outlived the cwd-persistence fix, and the compose-fresh anchor-diff that caught a falsified reviewer-isolation claim one wave later — are recorded as evidence in `workflow-driver.md`'s own section.

## Routing a tuple `{ id, risk, iteration, report, verdict }`

```bash
# 7.0. Sidecar existence check (recovery path, not the default). The Scribe stages
#      (step 6) already wrote these at agent-return; confirm, and write any missing
#      one through the SAME verb — never hand-format, never bundle.
REPORTS=".flotilla/waves/$SLUG/reports"; VERDICTS=".flotilla/waves/$SLUG/verdicts"
[ -f "$REPORTS/$ID-$ITER.md" ] || \
  {{wave-cli}} write-report  "/tmp/flotilla-start-$SLUG/report-$ID.json"  --dir "$REPORTS"  --id "$ID" --iter "$ITER"
[ -f "$VERDICTS/$ID-$ITER.md" ] || \
  {{wave-cli}} write-verdict "/tmp/flotilla-start-$SLUG/verdict-$ID.json" --dir "$VERDICTS" --id "$ID" --iter "$ITER"
#   write-* validates-then-writes: exit 1 = invalid payload / report.issue↔--id
#   mismatch → NOTHING written (re-collect); exit 0 prints the absolute path.
#   That same write also sweeps its target dir for a MISNAMED sidecar (a filename
#   id that fails the bare-id rule — present to `ls`, invisible to the `[ -f … ]`
#   probe above for the same reason a missing file is) and reports it on stderr,
#   naming the file's path, the row it belongs to, and the name it should have
#   carried — it never rewrites or deletes it.

# 7.0a. Disclosure capture (ADR-0027) — for EVERY tuple, BEFORE the outcome/
#       verdict branch below (7a-7c), source-neutral. Routing is the moment of
#       maximum context: the report/verdict sidecars from 7.0 are already open
#       to read the outcome, so read them here too — for a Convention 9 wiring
#       gap, a Convention 10 runtime residue, a Convention 11 unfalsified
#       check, or anything the Coordinator itself notices while routing. One
#       add-disclosure call per disclosed item, --source matching who raised
#       it — the verb is source-neutral, Worker/Reviewer/Coordinator land
#       identically:
{{wave-cli}} spine add-disclosure "$SPINE" "$ID" --iter "$ITER" --source worker \
  --text "$(jq -r '.judgmentCalls[0]' "/tmp/flotilla-start-$SLUG/report-$ID.json")"       # one call per disclosed item in report.judgmentCalls
{{wave-cli}} spine add-disclosure "$SPINE" "$ID" --iter "$ITER" --source reviewer \
  --text "$(jq -r '.reviewerFocusItems[0]' "/tmp/flotilla-start-$SLUG/verdict-$ID.json")" # a Reviewer-raised item the Worker didn't already flag
{{wave-cli}} spine add-disclosure "$SPINE" "$ID" --iter "$ITER" --source coordinator \
  --text "<what you, the Coordinator, noticed routing this tuple>"
#   Each call prints the created ref (`<row-id>.<ordinal>`, e.g. `01.1`) AFTER
#   the flush — every entry starts `open`. If the disposition is already known
#   AT THIS MOMENT — the gap resolved itself in-slice, or you're about to
#   grant the scope extension it's asking for — set it right here, same
#   routing pass:
{{wave-cli}} spine set-disposition "$SPINE" "01.1" resolved-in-slice
#   ^ or scope-extension | filed:<id> | dropped:<reason> — never `open` (the
#   capture default, refused as a disposition by set-disposition itself, exit 1).
#   Anything you can't dispose of now stays `open` and rides forward: step 9
#   reports it (below), and wave-close's fail-closed archive gate (its own
#   slice, ADR-0027) blocks Archive until every disclosure this wave captured
#   carries a disposition other than `open`.

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
#   duplicate — AND re-writes its title/body to the values passed here
#   (`updated: true` discloses it), so the rendered verdict reliably lands on
#   the Worker-opened PR (last-writer-wins). --body carries the rendered
#   `## Reviewer verdict` section (wave-shared "the reviewer-verdict render")
#   ABOVE the store-kind close phrase (Convention 4), the ONLY tracker id the
#   title/body may name. Because that render always carries the close phrase,
#   `create`'s reuse-refusal guard should never legitimately fire here — the
#   CREATE_EXIT check below interprets it as a compose defect if it does
#   (workflow-driver.md "PR-open reuse-refusal"), never routes around it.
#   host-routed since the Bitbucket adapter landed (ADR-0023 amendment 2026-08-10):
#   reads GITHUB_TOKEN on a github remote, BITBUCKET_TOKEN + BITBUCKET_EMAIL on a
#   bitbucket one; unknown hosts fail loud + typed.
# CALL 1 — render the verdict and open the PR. The rendered section is captured
# and CONSUMED in this same call (Convention 12, half two): it is the PR body's
# own input, so it never crosses a call boundary. An empty VERDICT_SECTION means
# `render-verdict` did not run, and the body would then be composed WITHOUT the
# verdict while still reading as complete — so it is guarded here, inline, where
# the variable actually exists.
VERDICT_SECTION=$({{wave-cli}} render-verdict "$VERDICTS" "$ID" --anchor "$ANCHOR_SHA")
if [ -z "$VERDICT_SECTION" ] || [ "$VERDICT_SECTION" = "null" ]; then
  echo "STOP: VERDICT_SECTION came back empty — render-verdict did not run. Refusing to open a PR whose body silently omits the verdict." >&2
  exit 1
fi
#   $ANCHOR_SHA is the row's roster-bound anchor — the SAME value threaded into
#   this row's Worker/Reviewer briefs as `issue.anchorSha` (workflow-driver.md).
#   render-verdict reads the MAX-iter valid verdict sidecar — the LATEST
#   iteration's verdict, never a stale one from a changes-requested →
#   re-dispatch cycle.
{{wave-cli}} host-pr create --branch "wave/$ID-$SLUG" \
  --title "$PR_TITLE" --body "<summary>

$VERDICT_SECTION

<close phrase>"
CREATE_EXIT=$?
#   Run the CALL ITSELF bare — no `| jq`, no `$( )` around it — so its JSON
#   lands directly in this session's own output; find-before-create is
#   idempotent, so this re-pins the PR the Worker already opened and re-writes
#   its body. `$?` above is the exit status of THAT bare call, read in the
#   SAME call it ran in — not a value captured across a call boundary
#   (Convention 12 governs the latter, not this).
#
#   INTERPRET THE OUTCOME BEFORE CALL 2 — a non-zero exit here is not a case
#   CALL 2's re-query papers over (workflow-driver.md "PR-open reuse-refusal"):
if [ "$CREATE_EXIT" -ne 0 ]; then
  echo "STOP: host-pr create exited $CREATE_EXIT for wave/$ID-$SLUG — read its printed JSON's .outcome before doing anything else (create-failed | reuse-refused; workflow-driver.md 'PR-open reuse-refusal'). A reuse-refused response still names the existing PR's .url — the refusal made NO write, so that URL is not evidence the rendered verdict landed. Never pass --allow-close-phrase-loss to get past this: the body composed above already carries the close phrase (Convention 4), so a refusal here means THIS body is malformed, not that the guard is wrong. Fix the composition and re-run create (idempotent) before CALL 2." >&2
  exit 1
fi

# CALL 2 — RE-QUERY THE HOST FOR THE URL, then write the spine from that answer.
# The URL is never carried from call 1: shell state does not survive between Bash
# calls, so a PR_URL captured there would be unset here (wave-shared Convention
# 12, half two — this is the site whose cross-call `require_capture` could never
# fire, and the closest in-repo analogue of the `#83` gate failure). `host-pr
# status` asks the host again and answers with `state` as well as `url`, which
# distinguishes the two things an empty capture cannot: a PR that exists from one
# that does not. Everything below runs in THIS one call, so the guard and the two
# spine writes share the scope of the value they are about. This call ALONE only
# ever answers "does a PR exist for this branch" — it is reached at all only
# because the CREATE_EXIT check above already interpreted CALL 1's own outcome,
# so a reuse-refused rewrite can no longer flow through to a silent pr-created
# flip via this re-query's mere presence-of-a-url answer.
PR_URL=$({{wave-cli}} host-pr status --branch "wave/$ID-$SLUG" | jq -r '.url // empty')
if [ -z "$PR_URL" ] || [ "$PR_URL" = "null" ] || [ "$PR_URL" = "undefined" ]; then
  echo "STOP: host-pr status reports no URL for wave/$ID-$SLUG — no PR exists (state: none) or the verb did not run. NOT flipping the row to pr-created." >&2
  exit 1
fi
{{wave-cli}} spine set-row-state "$SPINE" "$ID" pr-created
{{wave-cli}} spine set-row-pr    "$SPINE" "$ID" "$PR_URL"   # never reached on an empty re-query
{{wave-cli}} issue-store transition "$ID" in-review
#   Without the guard above, the two writes would flip the row to `pr-created`
#   and record an EMPTY PR cell: a row that reads as landed with nothing landed
#   behind it. Both writes sit below it for that reason — the state flip is as
#   wrong as the empty cell when no PR was opened.

# 7d. transition → re-dispatched (cap=1 — enforced by transition() itself):
{{wave-cli}} spine set-row-state "$SPINE" "$ID" re-dispatched
{{wave-cli}} spine set-row-iter  "$SPINE" "$ID" 2   # cap=1 → the new iteration is always 2;
#   bumps the Plan-Table Iter cell + re-renders the sidecar-link cell to the
#   <id>-2 reports/verdicts paths (observability-only, FOR-53 — the reconciler
#   still reads the max-iter sidecar off disk, never this cell, per ADR-0024)

# MANDATORY teardown, BEFORE the iteration-2 dispatch (W26-F1, docs/retros/
# 2026-07-23-w25-followups-w26.md): the row's iteration-1 worktree still HOLDS
# the wave branch's `git worktree` registration, and a second worktree cannot
# check that branch out while the registration stands. Live occurrence: the
# iteration-2 Worker found `wave/$ID-$ROW_SLUG` still registered to its
# iteration-1 worktree and had to unregister it BY HAND before its own checkout
# could proceed. Deregister it through the existing verb instead — never by
# hand, never skipped:
{{wave-cli}} worktree-cleanup --branches "wave/$ID-$ROW_SLUG"
#   the scoped --branches escape hatch (cli.ts) — tears down ONLY this row's
#   registered worktree; sibling rows' worktrees are untouched.

#   then re-dispatch the same Worker at iteration 2 with changes-requested items
#   appended. The iteration-2 brief's workspace setup is a TRACKING-FREE
#   checkout of the now-free branch (workflow-driver.md `workerBrief()`,
#   `issue.iteration > 1` branch) — fetch + `checkout -B <branch> FETCH_HEAD`
#   (or the explicit iteration-1 head SHA), never a tracking form
#   (`checkout -B <branch> origin/<branch>`), which writes upstream-tracking
#   into the MAIN repo's shared .git/config — sandbox-write-denied for a
#   worktree-isolated agent, and the exact second edge W26-F1 hit right behind
#   the stale-registration one (recovered only by hand via `git symbolic-ref`).

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

## Convention 11 at compose + routing — a row whose slice ships a NEW check

`wave-shared` Convention 11 binds the **Worker**: a slice introducing a new check
(a test, an assertion, a guard, a smoke probe, a lint rule, a CI gate, a preflight,
a validator) demonstrates that check failing on the input it exists to catch, and
reports the demonstration — or reports, in the same channel, that it could not
falsify it and why. Two **Coordinator** duties bracket that, one at compose and one
at routing. A row whose slice ships no new check has nothing to do here — the
majority case, deliberately.

**At compose (step 6).** Decide per row whether it is in the class. The two mechanical
questions are the convention's — does a pass/fail check exist after the diff, and is
its failing condition new with this slice; *"is the falsification worth it"* is
deliberately **not** one of them (an expensive falsification belongs in the row's
disclosure, not outside the class). For an in-class row, name the check in that row's
`reviewerHints`, e.g.

```
reviewerHints: ['Confirm the new <check> was demonstrated FAILING on the input it exists to catch, not only passing.'],
```

so the Reviewer runs a directed check instead of having to infer the duty. The clause
itself is already in every brief (`workerBrief()` policy clause 9, workflow-driver.md)
— do not re-state it per row.

**At routing (step 7).** The falsification note arrives as prose in
`report.judgmentCalls`, mirrored into `report.reviewerFocusItems` — the same channel
Conventions 9 and 10 use, already rendered verbatim into the Reviewer brief and
already on disk in the report sidecar (step 6's Scribe, ADR-0024). **Read it; never
route off it** — routing reads typed fields only (Convention 2). Three cases:

| What the report carries | Coordinator action |
|---|---|
| A falsification note — check named, break named, observed failing output, restored | Nothing extra; route as usual. |
| An explicit "could not falsify, and here is why" | A **disclosure**, exactly like a Convention 9 wiring gap: capture it at 7.0a (`spine add-disclosure … --source worker --text "<the note>"`) — it needs a disposition before archive (ADR-0027). A `deferred`/`partial` on the matching AC in the verdict is the Reviewer half of the same fact (ADR-0004 Amendment). |
| An in-class row with neither | Read the verdict's `acVerification` for the matching AC first — the Reviewer's own probe (ADR-0004 Amendment) may have exercised the outcome instead. If both are silent, it is a disclosure of the same kind: capture it at 7.0a too (`--source coordinator`, since neither agent wrote it down) — the durable fact worth keeping is *"this check has never been observed failing"*, not *"a paragraph is missing"*. Do not synthesize the evidence yourself, and do not STOP the row for it. |

## Listing this wave's still-open disclosures (step 9, ADR-0027)

Step 9 is report-only (no write happens here — see Phase sequence above), but the
report must name every disclosure this wave captured at 7.0a that has not yet
reached a disposition. `check-disclosures` already prints exactly that shape, and
is non-mutating, so step 9 reads it purely for its listing — the exit code is
**advisory here, not a gate**; `wave-close` is the slice that turns this same verb
into the fail-closed archive check (ADR-0027):

```bash
{{wave-cli}} spine check-disclosures "$SPINE"
#   exit 0, "disclosures: 0 open of N — archive gate CLEAR"      → nothing to report
#   exit 1, "disclosures: M open of N — archive gate BLOCKED",
#     followed by one line per open entry: "  <ref>  row <id>  iter <n>  (<source>)  <text>"
```

Fold the BLOCKED listing verbatim into the step-9 report — this is the handover to
`wave-close`: it names precisely what that gate will block on, not a vague "some
disclosures are open."

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

### `version` (the step-4b lockstep gate, ADR-0032)
| Code | Meaning |
|---|---|
| `0` | in lockstep (`--expect` supplied and equal), or a bare `version` read with nothing to compare |
| `1` | **STOP** — mismatch, or the engine could not read its own version, or the supplied expectation was unusable. Never a silent pass on a missing side |
| `2` | usage — a value-less/blank `--expect`, an unknown flag, or a stray positional. A malformed gate call, not a verdict: fix the invocation and re-run |

Prints `{ version, expected, match, outcome, detail, repair }` on stdout in every non-usage case. `outcome` is the discriminant (`match` · `mismatch` · `no-expectation` · `engine-version-unreadable` · `expectation-unusable`); `repair` is non-null exactly when there is something to repair. The verb resolves no store and reads no wave config, so it answers on a machine where the skew is the reason nothing else works. `--version` in first position is an accepted alias.

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

### `spine add-disclosure` / `set-disposition` / `check-disclosures` (ADR-0027, step 7.0a + step 9)
| Code | Meaning |
|---|---|
| `0` | `add-disclosure`: captured, ref printed after flush. `set-disposition`: one entry updated. `check-disclosures`: 0 `open` remain (archive gate CLEAR). |
| `1` | domain failure — `add-disclosure`/`set-disposition`: unknown row id / `--source` / disclosure-ref / disposition token (including passing `open` back to `set-disposition` — refused, it is the capture default, not a decision). `check-disclosures`: at least one `open` disclosure remains (archive gate BLOCKED), or the spine could not be read/parsed (fail-closed). |
| `2` | usage error — missing `<spine-path>`/`<row-id>`/`--iter`/`--source`/`--text` (`add-disclosure`) or `<disclosure-ref>`/`<disposition>` (`set-disposition`), or a non-positive-integer `--iter` |

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
