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
| `{{wave-cli}} issue-store close <id> <prUrl> [--acked 0,2,3]` | the done-reconcile: records the closing PR + cosmetic AC tick. Idempotent no-op-or-reconcile; on a `states.doneState` store with no integration it forces the mapped done-state transition + a loud advisory (FOR-13). The existing `IssueStore.close()` verb — never re-implemented. |
| `{{wave-cli}} closed-by "<closed-by-line>"` | `{ "class": "real-pr"\|"pre-fill"\|"placeholder"\|"sha"\|"prose"\|"empty", "needsPin": true\|false }` |
| `{{wave-cli}} detect-host "<remote-url>"` | `{ "host": "github"\|"bitbucket"\|"unknown", "workspace": "…", "repo": "…" }` |
| `{{wave-cli}} merge-order <wave-file>` | `{ "algorithmic": [branch, …], "override": [branch, …]\|null, "hasOverride": boolean, "reason": "…" }` |
| `{{wave-cli}} worktree-cleanup [--dry-run] --wave <wave-file>` | `{ "removed": [], "skipped": [], "errors": [] }` |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>"]` | set needs-attention (orthogonal to the rung) |
| `{{wave-cli}} issue-store clear-flag <id>` | clear needs-attention |
| any command, no args | usage |

## Advisory merge-order write-back (ADR-0016 boundary)

`merge-order` prints `{ algorithmic, override, reason }` to stdout. **The result is printed advisory-only — not written into the spine.** Specifically:

- The `## Conflict-Map` section is **parser-consumed** (ADR-0016): it is rendered by `renderSpine`/`renderConflictMap` at wave creation and consumed by the merge-order engine. A skill must not hand-author content in a parser-consumed section.
- `spine replace-closed-by` targets **`## Closed-by`**, not `## Conflict-Map` — it cannot be used as a merge-order write-back path.
- No CLI verb exists to update the `## Conflict-Map` block with a recomputed advisory order (that would require a new `spine replace-conflict-map` verb, deferred to P8 hardening if needed).

**Consequence:** the Coordinator follows the printed advisory order manually. When an override is present (stacked branches / fall-behind detected), note it explicitly and instruct the human to rebase before merging if needed. Rebase-train automation is M2 — wave-close only advises the order.

## Worked sequence (default advisory path — P7.4)

```bash
# Variables
WAVE=.flotilla/waves/2026-06-19-foo.md
SLUG=2026-06-19-foo
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
# Runs ahead of the advisory merge-order print: whatever still holds a wave
# branch locally (a worktree, W3-F3; or the branch simply being the current
# checkout, W4-F11) makes `--delete-branch` fail locally at merge time, and a
# failed local delete silently aborts the remote delete too — with the merge
# command still exiting 0. Cleanup here removes the worktree cause before the
# human ever reaches the merge step (it does not remove the checked-out-branch
# cause — see step 4's verification, which is required regardless).
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
#    happens here; verify branch deletion as its own checked step
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
# The human (or --auto, P8) merges each PR in this order, e.g.:
#   gh pr merge <pr> --squash --delete-branch
# `--delete-branch`'s exit code is NOT evidence the branch is gone: `gh pr
# merge` exits 0 whenever the merge succeeds, even when the local delete fails
# (branch held by a worktree, OR simply checked out — W3-F3 / W4-F11) — and a
# failed local delete silently aborts the paired remote delete too, without
# changing the exit code. After every merge, verify separately:
gh api "repos/<owner>/<repo>/branches" --jq '.[].name' | grep '^wave/'
# (or: git ls-remote --heads origin 'wave/*')
# Delete by hand whatever survives:
git push origin --delete <branch>

# ─────────────────────────────────────────────────────────────
# 4a. Pull to completion before you reconcile — sandbox reality (W5-F3)
# ─────────────────────────────────────────────────────────────
# Phase 5 probes with whatever engine is on disk right now. If this wave's own
# rows changed the closing-probe machinery (or anything else phase 5 depends
# on), that fix is not live in phase 5 until the just-merged main is pulled
# locally — the self-repair trap (W4-F1; detecting/asserting it is FOR-30's
# separate territory, not duplicated here). Run this after every merge in the
# advisory order, before starting phase 5, every time — not only when you
# believe this wave touched the probe engine:
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
# If state=merged → land it DONE (the done-reconcile — the existing close verb):
{{wave-cli}} issue-store close "$ID" "$PR_URL"      # $PR_URL is read-closing's prUrl
{{wave-cli}} issue-store clear-flag "$ID"            # then clear any stale flag
# If state=closed-unmerged → a PR was FOUND and did not merge (real rejection) → flag:
{{wave-cli}} issue-store flag "$ID" --kind recoverable-stop \
  --question "PR was closed without merging — reopen, re-dispatch, or abandon?" \
  --option reopen --option re-dispatch --option abandon
# If state=closed-unknown → closed, but NO PR evidence either way. Do NOT flag and
# do NOT close: absence of evidence is not a rejection (flagging here is the live
# defect FOR-23 fixed). Report it and ask the human:
#   "closed-unknown — closed, but no merged-PR evidence found; confirm before landing"
# Then, only on the human's answer: merge confirmed → `close "$ID" "$PR_URL"`;
# PR genuinely rejected → the `flag ... recoverable-stop` above.
# If state=open in a no-integration `states.doneState` workspace AND the merge is
# confirmed out-of-band → the SAME close verb lands it via the FOR-13 fallback:
{{wave-cli}} issue-store close "$ID" "$PR_URL"

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

## Worked sequence (P8 --auto additions — not implemented in P7.4)

```bash
# P8 only: PR-open + pin (find-before-create) + auto-merge arming.
# host-pr.ts findOpenPr/createPr have no CLI verb in P7.4 — these require
# the real gh/HTTP GitHubApi. Describe as documented future capabilities.

# P8: Per row whose Closed-by needsPin — find before create:
#   findOpenPr(host, creds, branch) → existing URL or null
#   createPr(host, creds, {branch, title, body, destination: 'main'}) → real URL
#   {{wave-cli}} spine set-row-pr "$WAVE" "$ID" "[PR]($REAL_URL)"
#   {{wave-cli}} spine replace-closed-by "$WAVE" "$T/closed-by-block.md"

# P8: --auto arm in merge-order sequence:
#   gh pr merge --auto <pr-url>   (through wave-shared, never raw inline)
#   On arm failure (branch behind main) → flag recoverable-stop:
#   {{wave-cli}} issue-store flag "$ID" --kind recoverable-stop \
#     --question "auto-merge could not arm — branch is behind main; rebase then re-run wave-close --auto, or merge by hand." \
#     --option rebase-and-retry --option merge-by-hand
```

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `closed-by` | `needsPin: false` | `needsPin: true` | usage |
| `detect-host` | known host | `unknown` host | usage |
| `merge-order` | advisory result on stdout (incl. empty wave) | — | usage / unreadable spine |
| `worktree-cleanup` | clean | per-worktree removal errors | usage |
| `read-closing` | `ClosingState` on stdout | issue not found | usage |
| `close` | closing facts recorded (done-reconcile / FOR-13 fallback) | issue not found (store threw) | usage (missing `<id>`/`<prUrl>`) |
| `flag` / `clear-flag` | written | issue not found | usage (bad `--kind`) |
| `spine read` | raw source on stdout | file not found / parse error | usage |

## `ClosingState` shape

`read-closing` prints `{ "state": "open"|"merged"|"closed-unmerged", "prUrl"?: string }`.

- `open` — PR is open; no action needed (human merges in advisory order). Exception: a no-integration `states.doneState` workspace never reports `merged` — once the merge is confirmed out-of-band, land it with `close` (FOR-13 fallback).
- `merged` — PR merged; **land it `done` via `issue-store close <id> <prUrl>`** (the done-reconcile). On a native-integration tracker the row's `done` also derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), so `close` is an idempotent reconcile that records the closing facts; then clear any stale flag.
- `closed-unmerged` — PR was closed without merging; flag `recoverable-stop`.

## `NeedsAttentionPayload` shape

`flag` writes `{ kind: 'recoverable-stop' | 'terminal-failure', question: string, options: string[] }` (ADR-0006). The flag is **orthogonal to the coarse rung** — the row keeps its rung (typically `in-review`); `read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged. On GitHub: `wave/needs-attention` label + structured comment carrying the payload. On MarkdownFs: `**Needs-Attention:**` header line + payload block.

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `available` (eligible + unclaimed) and `done` are the derived bookends. On a native-integration tracker `done` derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), and the wave-close done-reconcile (`issue-store close`) is an idempotent reconcile that records the closing facts. On a **no-integration `states.doneState` workspace (FOR-13)** the tracker can never see the merge, so that same `close` verb forces the mapped done-state transition + a loud advisory — the operational trigger for `done` when nothing else can reach it. wave-close recomputes the advisory merge order (printed, not persisted), lands each merged row `done`, flags stuck rows, cleans worktrees, and archives the spine — it **never merges `main`**. Reaching `done` for a row whose PR merged is this done-reconcile, the resume done-reconcile (`wave-resume`), or the human's merge action.
