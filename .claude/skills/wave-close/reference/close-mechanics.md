# wave-close — close mechanics

The engine-CLI plumbing for the operational close. The skill body owns the **judgment** (terminality gate, auth-preflight stop, the flag decision, archive-only-when-terminal); this file owns the **invocations**, JSON shapes, and exit codes.

> **The CLI is the source of truth for shapes.** Every command prints usage with no args and validates its input. The JSON below are worked examples — if one disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution

In-repo: `npx tsx tools/wave/src/cli.ts <verb> …` for top-level verbs; `npx tsx tools/wave/src/cli.ts issue-store <op> …` for issue-store verbs; `npx tsx tools/wave/src/spine-cli.ts <op> …` for spine verbs (or via the top-level CLI relay `npx tsx tools/wave/src/cli.ts spine <op> …`). Run from a directory with `wave.config.json`, or append `--config <path>` **after** the subcommand + op. The store (`markdown` or `github`) is selected there — you never name a tracker.

## Commands

| Call | Purpose / shape |
|---|---|
| `{{wave-cli}} spine read <wave-file>` | print the spine source (raw markdown) |
| `{{wave-cli}} issue-store read-closing <id>` | `ClosingState` JSON: `{ "state": "open"\|"merged"\|"closed-unmerged"\|"closed-unknown", "prUrl": "…" }` — `closed-unmerged` = a PR was found and did NOT merge (a real rejection → flag); `closed-unknown` = closed with NO PR evidence either way (→ report + ask, never auto-flag) |
| `{{wave-cli}} verdict-acked <verdictsDir> <id>` | (FOR-17) the single-owner derivation of `close`'s `--acked` indexes: `{ "acked": [0, 2], "iter": 2\|null, "corrupt": 0 }`. Reads the MAX-iter valid ReviewerVerdict sidecar for `<id>` out of `<verdictsDir>` and returns the 0-based `acVerification` indexes marked `met` (`metAcIndexes()`, reviewer-verdict-schema.ts) — partial/not-met/deferred excluded. Max-iter means a changes-requested → re-dispatch cycle's answer is always the LATEST verdict. No verdict sidecar (or only a corrupt one) → `{ acked: [], iter: null, corrupt: N }`, never a failure — the tick is cosmetic (ADR-0004). |
| `{{wave-cli}} issue-store close <id> <prUrl> [--acked 0,2,3]` | the done-reconcile: records the closing PR + cosmetic AC tick from `--acked` (source it from `verdict-acked`, above — never hand-parse a verdict). Idempotent no-op-or-reconcile; on a `states.doneState` store with no integration it forces the mapped done-state transition + a loud advisory (FOR-13). The existing `IssueStore.close()` verb — never re-implemented. |
| `{{wave-cli}} closed-by "<closed-by-line>"` | `{ "class": "real-pr"\|"pre-fill"\|"placeholder"\|"sha"\|"prose"\|"empty", "needsPin": true\|false }` |
| `{{wave-cli}} detect-host "<remote-url>"` | `{ "host": "github"\|"bitbucket"\|"unknown", "workspace": "…", "repo": "…" }` |
| `{{wave-cli}} merge-order <wave-file>` | `{ "algorithmic": [branch, …], "override": [branch, …]\|null, "hasOverride": boolean, "reason": "…" }` |
| `{{wave-cli}} worktree-cleanup [--dry-run] --wave <wave-file>` | `{ "removed": [], "skipped": [], "errors": [] }` |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>"]` | set needs-attention (orthogonal to the rung) |
| `{{wave-cli}} issue-store clear-flag <id>` | clear needs-attention |
| `{{wave-cli}} host-pr arm --branch <b> [--remote <url>] [--method <squash\|merge\|rebase>]` | `--auto` landing (ADR-0023): `{ ok, verb:"arm", host, branch, method, outcome:"armed"\|"merged"\|"already-merged"\|"refused"\|"no-pr", prNumber?, prUrl?, reason }`. Decides per PR: checks pending → enable auto-merge (GraphQL); already clean → direct merge (REST). Idempotent. Detect-host-routed; **no `--config`** (talks to the code host, not the tracker). |
| `{{wave-cli}} host-pr status --branch <b> [--remote <url>]` | done-reconcile host-evidence probe: `{ ok, verb:"status", host, branch, state:"open"\|"merged"\|"closed-unmerged"\|"none", url?, number? }`. `none` is a valid answer (no PR), not a failure. |
| `{{wave-cli}} host-pr merge --branch <b> [--method …] [--delete-branch]` | merge now, no arm intent (caller already decided). Idempotent. Same shape as `arm`, plus — with `--delete-branch` (consumer KW-F6) — it deletes the PR's **remote** head branch through the host API after a successful merge and reports the outcome under `branchDeletion:{ branch, deleted, error? }`. A failed delete is a reported degradation (`deleted:false`), **never** a merge failure (exit stays 0). Merge-only: `arm` defers the merge to the host, so it deletes nothing. |
| `{{wave-cli}} host-pr preflight [--remote <url>]` | code-host posture probe for the `--auto` confirm (ADR-0023 amendment): `{ ok, verb:"preflight", host, checks:[{name,status,detail}] }` for `pr-merge-token` / `allow-auto-merge` / `required-checks`. **Store-blind** — detect-host-routed, **no `--config`**, **no `--branch`** (required checks read against the default branch) — so it answers on **every** store kind, unlike the store-preflight it replaced here. `status` may be `pass`/`fail`/`advisory`/`unknown`; only `fail` blocks. |
| any command, no args | usage |

## Advisory merge-order write-back (ADR-0016 boundary)

`merge-order` prints `{ algorithmic, override, reason }` to stdout. **The result is printed advisory-only — not written into the spine.** Specifically:

- The `## Conflict-Map` section is **parser-consumed** (ADR-0016): it is rendered by `renderSpine`/`renderConflictMap` at wave creation and consumed by the merge-order engine. A skill must not hand-author content in a parser-consumed section.
- `spine replace-closed-by` targets **`## Closed-by`**, not `## Conflict-Map` — it cannot be used as a merge-order write-back path.
- No CLI verb exists to update the `## Conflict-Map` block with a recomputed advisory order (that would require a new `spine replace-conflict-map` verb, deferred to a later hardening slice if needed).

**Consequence:** the Coordinator follows the printed advisory order manually. When an override is present (stacked branches / fall-behind detected), note it explicitly and instruct the human to rebase before merging if needed. Rebase-train automation is M2 — wave-close only advises the order.

## Worked sequence (default advisory path — human merges)

```bash
# Variables
WAVE=.flotilla/waves/2026-06-19-foo.md
SLUG=2026-06-19-foo
VERDICTS=".flotilla/waves/$SLUG/verdicts"   # the same sidecar dir wave-start's Reviewer stage writes to
T=$(mktemp -d)

# ─────────────────────────────────────────────────────────────
# 1. Load + gate (confirm all rows terminal before proceeding)
# ─────────────────────────────────────────────────────────────
{{wave-cli}} spine read "$WAVE"
# Scan Plan-Table rows — none may be dispatched|re-dispatched|reviewing|report-in|verdict-in.
# Terminal = pr-created|approved|failed|abandoned|parked  (parked: ADR-0022).
# If any non-terminal: STOP "wave not yet terminal — N row(s) still in flight"

# ─────────────────────────────────────────────────────────────
# 2. Auth preflight (skip when no row needsPin)
# ─────────────────────────────────────────────────────────────
{{wave-cli}} closed-by "$CLOSED_BY_LINE"   # exit 1 → needsPin true → host auth needed
{{wave-cli}} detect-host "$(git remote get-url origin)"   # exit 1 → unknown → print advisory
# GitHub auth: gh auth status (if host=github and a row needsPin)

# ─────────────────────────────────────────────────────────────
# 3. Worktree cleanup — BEFORE the merge (W3-F3 / W4-F11)
# ─────────────────────────────────────────────────────────────
# Runs ahead of the advisory merge-order print, to remove the agent worktrees
# this wave created. NB: step 4's wired `host-pr merge --delete-branch` deletes
# the REMOTE head ref through the host API, so it does NOT depend on local branch
# state — the old `gh pr merge --delete-branch` footgun (a worktree or the
# current checkout holding the branch locally made the LOCAL delete fail, which
# silently aborted the remote delete too — W3-F3 / W4-F11) no longer applies on
# the wired path. Cleanup still runs here for the worktrees themselves; the
# remote-branch hygiene is now the merge step's own job (`branchDeletion`).
{{wave-cli}} worktree-cleanup --dry-run --wave "$WAVE"   # preview
{{wave-cli}} worktree-cleanup --wave "$WAVE"             # execute
# { "removed": [...], "skipped": [...], "errors": [...] }
#
# A clean `git worktree list` afterwards is NOT proof the directories are gone:
# git can deregister a worktree from its list while still failing to delete the
# on-disk directory (`Directory not empty` / `Operation not permitted`) — that
# worktree then shows up in `errors` here AND is absent from `git worktree list`.
# Verify on disk, e.g.:
ls .claude/worktrees/ 2>/dev/null   # (or wherever this repo's worktrees live)
# Cross-check any survivor against the `errors` array; remove confirmed orphans
# by hand (`rm -rf`, sandbox disabled if the harness denies the path).

# ─────────────────────────────────────────────────────────────
# 4. Advisory merge-order (print only — not written to spine) — the merge
#    happens here; branch deletion is WIRED into the merge (not a manual step)
# ─────────────────────────────────────────────────────────────
{{wave-cli}} merge-order "$WAVE"
# Example output:
# { "algorithmic": ["wave-orch/42-foo", "wave-orch/43-bar"], "override": null, "hasOverride": false, "reason": "no stacking detected" }
#
# Print advisory block:
# --- Advisory Merge Order ---
# Reason : no stacking detected
# Order  : wave-orch/42-foo → wave-orch/43-bar
# Override: none
# ---
#
# Merge each PR in this order (default path) through the engine host seam — gh is
# off the landing path (ADR-0023). Merge AND delete the remote head branch in one
# wired step (consumer KW-F6), so branch hygiene is the default, not an advisory
# afterthought:
{{wave-cli}} host-pr merge --branch <branch> --delete-branch
# { ok, verb:"merge", outcome:"merged"|"already-merged"|..., prNumber?, prUrl?,
#   branchDeletion:{ branch, deleted, error? } }
# (Under --auto, do NOT hand-merge the order-free rows — arm them in 4b below.)
#
# --delete-branch deletes the PR's REMOTE head branch through the host API
# (GitHub DELETE .../git/refs/heads/<branch>) — there is NO local git delete, so
# the worktree/checked-out footgun that used to silently abort `gh pr merge
# --delete-branch` (W3-F3 / W4-F11) does not apply on this path. Read the outcome
# from `branchDeletion.deleted`, never the exit code: a failed delete is
# `deleted:false` (+ `error`) and NEVER turns the merge into a failure — the
# merge already landed. Only when `deleted:false` (or on a legacy hand-merge)
# sweep for strays and delete by hand:
gh api "repos/<owner>/<repo>/branches" --jq '.[].name' | grep '^wave/'
# (or: git ls-remote --heads origin 'wave/*')
git push origin --delete <branch>

# Reconciled-merge verify (KW-F4) — the checked step before a serialized lane's
# TAIL PR merges. File-level conflict prediction is blind to SEMANTIC cross-suite
# conflicts: two rows with ZERO Files overlap broke 27 test assertions on the
# reconciled merge of the first Linear consumer wave (a new test file meeting an
# API-wide change; a success-path test decoding a changed response envelope) —
# past a green conflict-map. For each serialized lane (a chain of 2+ branches
# that must merge in order — the overlapping tail, NEVER the order-free rows),
# after the lane's earlier PRs merged and `main` is pulled (4a below), reconcile
# the tail locally and run the CONSUMER VERIFY PROFILE (wave.config.json — the
# same commands the Worker/Reviewer ran per row) BEFORE merging the tail PR:
git fetch origin main
git checkout <tail-branch> && git rebase origin/main       # reconcile the tail onto the merged head(s)
<consumer verify profile from wave.config.json>            # e.g. (cd tools/wave && npx vitest run && npx tsc --noEmit)
# green → merge the tail PR. red → a real landing conflict the file-level map
# could not predict; fix it (rebase/patch the tail) BEFORE the tail merges.

# ─────────────────────────────────────────────────────────────
# 4a. Self-repair check + pull to completion — sandbox reality (W4-F1 / W5-F3)
# ─────────────────────────────────────────────────────────────
# Phase 5 probes with whatever engine is on disk right now. read-closing /
# close / merge-order / worktree-cleanup / the host-pr routing verbs all run
# from the LOCAL CHECKOUT, which sits at the wave anchor (pre-wave code). If
# this wave's own rows changed any of that machinery, the fix is not live in
# phase 5 until the just-merged main is pulled locally — the self-repair trap
# (W4-F1: had phase 5 run before the pull, read-closing would have reported
# closed-unmerged for all FOUR of that wave's already-merged rows, and the
# skill's own prescription would have flagged four correctly-landed rows
# recoverable-stop).
#
# Detect it mechanically BEFORE phase 5 (not from memory of this comment) —
# diff each dispatch-log branch against main and grep the engine surface.
# This also covers the transport/factory/wiring layer one level below the
# store wrappers -- real-github-api.ts, github-api-factory.ts,
# real-linear-api.ts, linear-api-factory.ts, cli-store.ts -- because a
# probe-logic fix confined to that layer (the FOR-23 / real-linear-api.ts
# precedent) would otherwise evade this check:
ENGINE_SURFACE='^tools/wave/src/(adapters/(issue-store|markdown-fs-store|github/(github-issues-store|real-github-api|github-api-factory)|linear/(linear-issues-store|real-linear-api|linear-api-factory))\.ts|issue-store-cli\.ts|cli-store\.ts|merge-order\.ts|worktree-cleanup\.ts|host-pr(-cli)?\.ts|cli\.ts)$'
for BRANCH in <every wave branch from the dispatch-log>; do
  HIT=$(git diff --name-only main...origin/"$BRANCH" | grep -E "$ENGINE_SURFACE")
  [ -n "$HIT" ] && echo "SELF-REPAIR HAZARD: $BRANCH touches $HIT"
done
# A hit or not, the merge -> pull -> reconcile order below always runs — the
# detection step is early warning (surface it in the close summary), not a
# gate that skips the pull. Run this after every merge in the advisory order,
# before starting phase 5, every time — not only when the check above hits:
git fetch origin main
git pull --ff-only origin main
git rev-parse HEAD   # MUST equal the merged main tip — trust nothing else

# Sandbox precondition: disable the sandbox for this pull whenever this wave's
# rows touch anything under `.claude/skills/`. The sandbox denies writes there,
# so a fast-forward touching skill files stops mid-apply with:
#   error: unable to unlink old '.claude/skills/<path>': Operation not permitted
# Everything outside the denied paths (e.g. tools/wave/src/**) still lands —
# only the skill files don't.
#
# Half-applied-pull symptom (nothing flags this as broken): a mixed working
# tree — some tracked files carry the merged content, skill files do not, and
# HEAD stays frozen on the pre-merge SHA. No MERGE_HEAD, no lock file, no
# non-zero exit code past the failed unlink, and a plain `git status` reads
# like ordinary pending local changes, not a corrupted pull. Do NOT infer
# success from the pull's exit code or from `git status` being quiet — the
# only reliable check is `git rev-parse HEAD` against the merged tip, above.
#
# Resolution — re-run as a hard reset with the sandbox disabled:
git reset --hard origin/main   # sandbox disabled: needs write access under .claude/skills/
# Safe here because a wave-close checkout has no local edits by design (every
# change this wave made already landed through its own PR). Confirm
# `git rev-parse HEAD` matches the merged tip before moving on to phase 5.

# ─────────────────────────────────────────────────────────────
# 5. done-reconcile + needs-attention for stuck rows
# ─────────────────────────────────────────────────────────────
# Per row — EXCEPT parked rows (ADR-0022): skip them entirely. No branch, no PR,
# claim already released at park time. Nothing for the probe to find.
# Report "parked — released for re-planning".
{{wave-cli}} issue-store read-closing "$ID"
# If state=merged → derive --acked from the FINAL verdict (FOR-17, single-owner
# engine derivation — NEVER hand-parse a verdict sidecar here), then land it
# DONE via the done-reconcile — the existing close verb:
ACKED_JSON=$({{wave-cli}} verdict-acked "$VERDICTS" "$ID")   # { acked: [...], iter, corrupt }
ACKED=$(echo "$ACKED_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf-8")).acked.join(","))')
{{wave-cli}} issue-store close "$ID" "$PR_URL" --acked "$ACKED"   # $PR_URL is read-closing's prUrl; $ACKED may be "" (nothing met / no verdict yet)
{{wave-cli}} issue-store clear-flag "$ID"            # then clear any stale flag
# If state=closed-unmerged → a PR was FOUND and did not merge (real rejection) → flag:
{{wave-cli}} issue-store flag "$ID" --kind recoverable-stop \
  --question "PR was closed without merging — reopen, re-dispatch, or abandon?" \
  --option reopen --option re-dispatch --option abandon
# Evidence hierarchy (ADR-0023): tracker attachment > host PR state > nothing.
# When read-closing cannot see a merge (state=open on a no-integration workspace,
# or state=closed-unknown), fall to the HOST for the evidence the tracker lacks —
# no out-of-band human-confirmation step:
{{wave-cli}} host-pr status --branch "$BRANCH"   # { state: open|merged|closed-unmerged|none, url? }
#   host state=merged → derive --acked (same verdict-acked call as above), then
#                       land it via the SAME close verb (FOR-13 fallback fires on
#                       a states.doneState store):
{{wave-cli}} issue-store close "$ID" "$PR_URL" --acked "$ACKED"
#   host state=closed-unmerged (only for a closed-unknown row) → real rejection →
#                       the `flag ... recoverable-stop` above.
#   host state=open|none → still no merge evidence anywhere → leave in-review
#                       (open), or for closed-unknown report + ask the human:
#                       "closed-unknown — closed, but no merged-PR evidence found;
#                        confirm before landing". Never guess merged vs rejected.
#
# --acked is COSMETIC ONLY (ADR-0004): it ticks the issue's AC checklist for
# human visibility and is never re-read as gate input anywhere — acVerification[]
# on the Reviewer verdict stays the ground truth. verdict-acked's `iter` selection
# is MAX-iter-per-id, so a changes-requested → re-dispatch cycle's $ACKED always
# reflects the LATEST verdict, never a stale one.

# ─────────────────────────────────────────────────────────────
# 6. Archive (terminal-only; to _archive/, NOT done/; layout-aware — P-11)
# ─────────────────────────────────────────────────────────────
mkdir -p ".flotilla/waves/_archive"

# Idempotent re-entry: destination already populated AND source already gone
# → this is a second run after a successful archive. Skip the move (and, in
# the tracked branch, skip the commit — never create an empty one).
if [ -f ".flotilla/waves/_archive/$SLUG.md" ] && [ -d ".flotilla/waves/_archive/$SLUG/" ] \
   && [ ! -f ".flotilla/waves/$SLUG.md" ]; then
  echo "already archived (no-op)"
else
  # `.flotilla/` may or may not be git-tracked in this consumer (flotilla's own
  # dogfood repo ignores it; most consumer repos track it for resume-from-clone
  # — see wave-setup). `git mv` fails outright on an ignored/untracked path, so
  # detect the spine's ACTUAL tracked status here — do not assume from the
  # consumer type or from what the previous archive did.
  if git ls-files --error-unmatch ".flotilla/waves/$SLUG.md" >/dev/null 2>&1; then
    ARCHIVE_MODE="tracked (git mv + commit)"
    git mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
    git mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
    git commit -m "chore(wave): archive $SLUG → _archive/ (operational close)"
  else
    ARCHIVE_MODE="untracked/ignored (plain mv, no commit)"
    mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
    mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
  fi
  echo "archive mode: $ARCHIVE_MODE"   # include this line in the close summary
fi
```

## Worked sequence (4b. `--auto` — partial-arm confirm + arm-and-exit, ADR-0023)

```bash
# Runs ONLY when invoked as `wave-close --auto`. Opt-in, human-confirm default.
# It replaces phase 4's MANUAL merge for the order-free rows; the overlapping
# tail keeps the phase-4 advisory order as the human playbook. Every host write
# goes through `host-pr` — never raw gh (ADR-0023: gh left the landing path).

# ── Headless guard: the per-wave confirm is a human click. ──
# Headless AND no --pre-authorized → STOP before arming anything:
#   "--auto needs a human to confirm the per-wave arm, or explicit
#    --pre-authorized to proceed unattended"

# ── Code-host posture for the confirm's last column (probed, never dictated). ──
# host-pr preflight is STORE-BLIND (no --config, no --branch): detect-host-routed,
# reports the code host directly, so it answers on EVERY store kind (github,
# linear, markdown) — the W10-F1 fix (the store-preflight reported these n/a on a
# linear store). NODE_USE_ENV_PROXY=1 under a proxied sandbox.
{{wave-cli}} host-pr preflight   # { ok, verb:"preflight", host, checks:[{name,status,detail}] }
# allow-auto-merge: FAIL only when OFF *and* required checks present (can't arm
#   those rows → land via advisory order; already-clean still direct-merges);
#   ADVISORY when OFF with no CI; UNKNOWN when the token can't see it (below
#   maintain/admin) → confirm says "posture unknown — the arm outcome decides".
# required-checks: report-only. ABSENT → confirm says "no required checks —
#   confirming means immediate merge". PRESENT → armed PRs land on green.
# The probe is ADVISORY: the `host-pr arm` outcome below is the ground truth.

# ── Present ONE confirm for the wave: a table, one line per terminal PR ──
#   PR | row (id+branch) | verdict | conflict prediction | repo posture
#   conflict prediction = order-free (in NO ## Conflict-Map pair → will arm) vs
#   overlapping (named in a pair → printed with the advisory order, NEVER armed).
# On DECLINE → arm nothing; fall back to the printed advisory order.

# ── On CONFIRM: arm each ORDER-FREE, eligible row through the host seam. ──
# Eligibility is mechanical: verdict=approve, NO needs-attention flag, open PR,
# order-free. NO risk re-gate (G3 already fired at verdict routing).
{{wave-cli}} host-pr arm --branch "$BRANCH"   # detect-host-routed; NO --config
# { ok, verb:"arm", outcome, prNumber?, prUrl?, reason }
#   outcome=armed         → auto-merge enabled; lands itself when checks pass.
#   outcome=merged        → was already clean; merged immediately.
#   outcome=already-merged→ idempotent no-op (a prior run did it). Re-run-safe.
#   outcome=refused       → branch behind main / allow-auto-merge OFF / not
#                           mergeable → flag recoverable-stop with the reason:
{{wave-cli}} issue-store flag "$ID" --kind recoverable-stop \
  --question "auto-merge could not arm — <reason>; rebase then re-run wave-close --auto, or merge by hand" \
  --option rebase-and-retry --option merge-by-hand
#   outcome=no-pr         → no open PR for the branch (shouldn't reach here — an
#                           open PR is an eligibility floor) → report.

# ── Arm-and-exit: NO watch, NO poll. ──
# The host completes merges server-side (survives a dead Coordinator). A clean
# PR may have merged just now (possibly this wave's own row) → re-run the 4a
# pull before phase 5 so reconcile runs against the merged engine. Then phases
# 5-6 proceed as on the default path, and the run EXITS. Late merges (and an
# armed PR whose checks later FAIL) reconcile on the next wave-close/resume touch.

# NOTE — PR *creation* / Closed-by pinning (find-before-create) is the STAGED
# `host-pr create` verb (ADR-0023 decision 3), not yet a CLI verb; PR creation
# still rides the Worker terminator. Only arm|merge|status ship today.
```

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `closed-by` | `needsPin: false` | `needsPin: true` | usage |
| `detect-host` | known host | `unknown` host | usage |
| `merge-order` | advisory result on stdout (incl. empty wave) | — | usage / unreadable spine |
| `worktree-cleanup` | clean | per-worktree removal errors | usage |
| `read-closing` | `ClosingState` on stdout | issue not found | usage |
| `verdict-acked` | `{ acked, iter, corrupt }` printed (found or not found — an absent/corrupt verdict is not a failure) | — | usage (missing `<verdictsDir>`/`<id>`) |
| `close` | closing facts recorded (done-reconcile / FOR-13 fallback) | issue not found (store threw) | usage (missing `<id>`/`<prUrl>`) |
| `flag` / `clear-flag` | written | issue not found | usage (bad `--kind`) |
| `spine read` | raw source on stdout | file not found / parse error | usage |
| `host-pr arm` / `merge` | landed (`armed`/`merged`/`already-merged`) — incl. a `merge --delete-branch` whose deletion FAILED (`branchDeletion.deleted:false` is a reported degradation, not a merge failure) | did not land (`no-pr`/`refused`), no adapter (`adapter-not-implemented`), or host error | usage (incl. `--delete-branch` on a non-`merge` verb) |
| `host-pr status` | probe answered (read `state`; `none` is a valid answer) | host error | usage |
| `host-pr preflight` | no check `fail`ed (checks may be `advisory`/`unknown`) | a check `fail`ed, no adapter (`adapter-not-implemented`), or host error / missing token | usage |

## `ClosingState` shape

`read-closing` prints `{ "state": "open" | "merged" | "closed-unmerged" | "closed-unknown", "prUrl"?: string }` — the four outcomes are **evidence claims, not verdicts** (ADR-0020), matching the landed engine:

- `open` — PR is open; no action needed (human merges in advisory order). Exception: a no-integration `states.doneState` workspace never reports `merged` — consult `host-pr status --branch <b>` (the evidence hierarchy, ADR-0023); on its `state: merged`, land it with `close` (FOR-13 fallback), `--acked` derived the same way as below.
- `merged` — PR merged; **derive `--acked` via `verdict-acked <verdictsDir> <id>` (FOR-17), then land it `done` via `issue-store close <id> <prUrl> --acked <indexes>`** (the done-reconcile). On a native-integration tracker the row's `done` also derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), so `close` is an idempotent reconcile that records the closing facts + the cosmetic AC tick; then clear any stale flag.
- `closed-unmerged` — a closing PR was **found and it did not merge** (a proven rejection); flag `recoverable-stop`.
- `closed-unknown` — closed with **no PR evidence either way** (a hand-close, a duplicate, or the Convention-4 mention-footgun closing the row via a stray bare-id sighting). This is *absence of evidence*, **not** evidence of rejection — never flag on it alone (that false alarm is exactly why this fourth outcome exists). Read it via the same **evidence hierarchy — tracker attachment > host PR state > nothing**: fall to `host-pr status --branch <b>`. Its `state: merged` → the PR did land, the tracker just never attached it → derive `--acked` (above), then the same `close` call (FOR-13 fallback). Its `state: closed-unmerged` → the host proves a real rejection → flag `recoverable-stop`. Its `state: open`/`none` → still no merge evidence anywhere → report `closed-unknown — closed, but no merged-PR evidence found; confirm before landing`, naming the id, and leave it for the human. **Never guess** between merged and rejected.

## `NeedsAttentionPayload` shape

`flag` writes `{ kind: 'recoverable-stop' | 'terminal-failure', question: string, options: string[] }` (ADR-0006). The flag is **orthogonal to the coarse rung** — the row keeps its rung (typically `in-review`); `read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged. On GitHub: `wave/needs-attention` label + structured comment carrying the payload. On MarkdownFs: `**Needs-Attention:**` header line + payload block.

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `available` (eligible + unclaimed) and `done` are the derived bookends. On a native-integration tracker `done` derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), and the wave-close done-reconcile (`issue-store close`) is an idempotent reconcile that records the closing facts. On a **no-integration `states.doneState` workspace (FOR-13)** the tracker can never see the merge, so the done-reconcile follows the ADR-0023 evidence hierarchy — **tracker attachment (`read-closing`) > host PR state (`host-pr status`) > nothing** — and that same `close` verb forces the mapped done-state transition + a loud advisory the moment the host supplies the merge evidence, the operational trigger for `done` when the tracker cannot reach it. Every `close` call on a merged row also carries `--acked`, derived per-row from that row's FINAL Reviewer verdict via `verdict-acked` (FOR-17, ADR-0004) — a cosmetic, human-facing tick only, never re-read as gate input. wave-close recomputes the advisory merge order (printed, not persisted), lands each merged row `done` (with its reviewer-met ACs ticked), flags stuck rows, cleans worktrees, and archives the spine; opt-in `--auto` additionally partial-arms the order-free rows through `host-pr arm` and exits (arm-and-exit) — it **never merges `main`**. Reaching `done` for a row whose PR merged is this done-reconcile, the resume done-reconcile (`wave-resume`), or the human's merge action.
