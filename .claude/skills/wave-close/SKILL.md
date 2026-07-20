---
name: wave-close
description: Use when finishing a wave's host-side work — recompute the advisory merge order, clean up agent worktrees, flag stuck rows, and archive the spine. Re-entrant + idempotent; opt-in --auto enables auto-merge (P8). Triggers on "close the wave <slug>", "finalise wave <slug>", "archive wave <slug>".
---

# wave-close

The operational terminator for a wave: confirm every row has reached `in-review`, clean up the wave's agent worktrees **before** anything merges (a worktree or a plain branch-checkout both silently break `--delete-branch`), recompute and **print** the advisory merge order (read-only — no parser-consumed section is mutated) so the human merges each PR and then verifies branch deletion as its own checked step, **land each merged row `done`** via the done-reconcile (the existing `issue-store close` verb), flag any closed-unmerged or stuck rows, and archive the spine to `_archive/`.

Load **wave-shared** by name first — it owns the auth-preflight / atomic-spine conventions this skill obeys.

Your job is the **judgment** — the terminality gate, deciding when a closed-unmerged PR or a stuck row becomes a `needs-attention` flag (and when a row with *no* merge evidence is merely reported, not flagged), and calling the archive at the right moment. The CLI plumbing (exact invocations, JSON shapes, exit codes, the worked sequence) lives in [reference/close-mechanics.md](reference/close-mechanics.md). You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

## When to Use

- Every Plan-Table row has reached `in-review` (the terminality gate below) and the Coordinator is ready to land.
- A prior `wave-close` run was interrupted (token outage mid-flight) — every phase is a guarded no-op when its work is already done; run as many times as needed.

Do **not** use this to dispatch (`wave-start`), to plan (`wave-plan`), or to merge `main` by hand. flotilla lands every change through a PR on protected `main` — there is **no fast-forward of `main`** here (the Ur's §7.1 branch-sync is gone). This skill opens PRs (P8 full implementation) and recommends an order; the merge itself is either a human action or, with `--auto` (P8), the host's auto-merge.

## THE FLOTILLA BOUNDARY — protected main, PR-only, spine never edits main

- **Never push to `main`.** Landing is per-PR through the protected-branch route. wave-close recomputes the advisory order and (opt-in P8) arms auto-merge; it does not merge `main` itself and never fast-forwards it.
- **Archive to `_archive/`, never to `done/`.** flotilla has no `git mv`-to-`done/` close ceremony (that is an Ur binding). The spine and its sidecar folder move together into `.flotilla/waves/_archive/`.
- **Advisory merge-order is print-only.** The recomputed merge order is printed to stdout (advisory). It is **not** written into the spine's `## Conflict-Map` — that section is parser-consumed (ADR-0016 forbids skills hand-authoring parser-consumed spine content; there is no CLI verb to write an advisory order into `## Conflict-Map` separately from the conflict pairs, and `spine replace-closed-by` targets the `## Closed-by` section, not `## Conflict-Map`).
- **Idempotent — read before mutate.** Every mutating step checks state first: skip already-flagged rows, skip already-archived spines.

## Terminality gate

wave-close runs only once the wave is **all-in-review**: every Plan-Table row's reconstructed coarse rung is `in-review` (its Worker finished and its Reviewer approved — the row reached `approved`/`pr-created`). Check by reading each row's `State` cell via `spine read`:

- A row still at `dispatched`/`re-dispatched`/`reviewing`/`verdict-in`/`report-in` means the wave isn't done → STOP: `wave not yet terminal — N row(s) still in flight; run wave-start (or resume) first`.
- `failed`/`abandoned` rows are terminal; include them in the gate check but they do not block closing — they will be flagged in phase 5.
- **`parked` rows are terminal and silent** (ADR-0022). They pass the gate and never block closing. A parked row was deliberately taken out of *this* wave and its claim is already released — it is **not** a problem to flag, has no branch and no PR, and gets its own report rubric in phase 5. It is the reason a held row no longer has to be recorded as `abandoned` (which would mean "never" for work that will be re-planned).

Do not open PRs or archive for a wave that has unfinished rows.

## Procedure

### 1. Load wave-shared + gate

Load **wave-shared** first (auth-preflight and atomic-spine conventions).

Read the spine: `{{wave-cli}} spine read <wave-file>`. Confirm the terminality gate (all rows terminal — `pr-created`, `approved`, `failed`, `abandoned`, or `parked`; none `dispatched`/`reviewing`/etc.).

If a `<wave-file>` already lives under `.flotilla/waves/_archive/`, this is a re-run on an archived wave — phases 2–4 still run as idempotent no-ops and phase 5 reports `already archived`; do not STOP.

### 2. Auth preflight (skip when no host writes pending)

**Guard:** if every row's `Closed-by:` already classifies as `real-pr` (`needsPin: false`), skip the network entirely — print `no host writes pending (no-op)`.

Detect the host: `{{wave-cli}} detect-host "$(git remote get-url origin)"`. `host: unknown` → print `(advisory) unknown host — PR-open is manual; proceed with advisory-only` (do not STOP — the advisory path continues; PR pinning is P8 `--auto`). Then verify auth before any write (GitHub: `gh auth status`). On 401 → STOP with an actionable message: refresh the token and re-run.

> **P8 note:** the find-before-create idempotency (`host-pr.ts findOpenPr/createPr/verifyAuth`) has no CLI verb in P7.4 — it requires the real `gh`/HTTP `GitHubApi`. The auth preflight and `detect-host` run now; the host PR write path is P8.

### 3. Worktree cleanup — BEFORE the merge

**Why this phase moved ahead of the merge-order print (W3-F3 / W4-F11):** the merge itself is not a phase this skill runs — it is a host action the human (or `--auto` in P8) takes once the advisory order is in hand. Whatever still holds a wave branch locally at that moment makes `--delete-branch` fail *locally*, and a failed local delete silently aborts the *remote* delete too, with the merge command still exiting 0. Two independent things have been observed holding a branch this way: **a worktree still checked out on it (W3-F3)** and, separately, **the branch simply being the current checkout with no worktree involved at all (W4-F11 — reproduced merging the very retro PR that first documented W3-F3)**. Running cleanup first removes the worktree cause before the human ever reaches the merge step. **It does not remove the other one** — a Coordinator (or human) merging from a branch checkout is still a live trap — which is why step 4 below treats branch deletion as a checked step regardless of phase order, not as something this reordering alone resolves.

**Guard:** no agent worktrees remain for this wave → skip, print `no wave worktrees found`.

```bash
# Preview first
{{wave-cli}} worktree-cleanup --dry-run --wave <wave-file>

# Execute (only after the preview looks right)
{{wave-cli}} worktree-cleanup --wave <wave-file>
```

The `--wave` flag scopes cleanup to branches in this spine's dispatch-log — a parallel sibling wave's worktrees are silently excluded (the parallel-safe path). Each removed / skipped / errored worktree is a line item in the JSON output `{ removed, skipped, errors }`. A **dirty worktree (uncommitted changes) is NEVER removed** — it appears in `skipped`. Report each line item clearly.

**A clean `git worktree list` is not evidence the directories are gone.** Git can **deregister** a worktree from its list while still failing to delete the on-disk directory (`Directory not empty` / `Operation not permitted`) — the JSON output can show `errors: N, removed: 0` for exactly the worktrees `git worktree list` no longer mentions. The result is an orphan directory **no tool reports on its own**: `worktree-cleanup` says it failed, `git worktree list` says there is nothing there, and the directory still sits in the repo (potentially still holding an editor/language-server indexing job). Verify on disk after cleanup — e.g. `ls .claude/worktrees/` (or wherever this repo's worktrees live) against the `errors` list — rather than trusting `git worktree list`'s silence. Removing a confirmed orphan may need the sandbox disabled (harness worktree paths are commonly write-denied).

### 4. Advisory merge-order (print-only) — the merge happens here, verify branch deletion separately

Recompute: `{{wave-cli}} merge-order <wave-file>` → `{ algorithmic, override, reason }`. The engine sources each issue's branch from the spine's dispatch-log (exact branches, not guesses). Print the result as a clear advisory block:

```
--- Advisory Merge Order ---
Reason: <reason>
Order : <branch-1> → <branch-2> → <branch-3>
(Override applied: yes/no)
---
```

`parked` rows are **excluded** from the order (ADR-0022) — no branch, no PR, nothing to merge. They fall out naturally (a parked row has no dispatch-log branch to source), so expect them absent; do not hand-add them.

**This is advisory-only — the order is NOT written into the spine.** The `## Conflict-Map` section is parser-consumed (ADR-0016); `spine replace-closed-by` targets `## Closed-by`, not `## Conflict-Map`; there is no CLI verb to write an advisory merge-order into the parser-consumed section without corrupting the conflict-pair data. The human (or `--auto` in P8) follows the printed order. When a fall-behind / stacked override is present, note it explicitly — the human must decide whether to rebase before merging (rebase-train automation is M2; wave-close only advises).

**`gh pr merge --delete-branch`'s exit code is not evidence the branch was deleted.** It exits **0** whenever the merge itself succeeds, even when the local branch delete fails — and a failed local delete silently aborts the paired remote delete too, without changing the exit code or printing anything past the merge success. This was observed twice for two different reasons: the branch's local ref was still checked out inside a wave worktree (W3-F3, before this phase reorder), and — reproduced live, phase reorder notwithstanding — the branch simply being the *current* checkout with no worktree at all (W4-F11). Treat branch deletion as a **separate, checked step** after every merge in the advisory order: query the host for surviving `wave/*` (or this store's branch-naming convention) branches — e.g. `gh api repos/<owner>/<repo>/branches` or `git ls-remote --heads origin 'wave/*'` — and delete by hand (`git push origin --delete <branch>`) whatever is still there. Do this **regardless of whether phase 3's cleanup ran cleanly** — cleanup only removes the worktree cause, not the checked-out-branch cause.

### 4a. Pull to completion before you reconcile — sandbox reality (W5-F3)

**Phase 5 probes with whatever engine is on disk right now.** `read-closing`/`close`/`merge-order` all run against the local checkout — if *this wave's own rows* changed the closing-probe machinery (or anything else phase 5 depends on), that fix is not live in phase 5 until you have pulled the just-merged `main` locally. Detecting that a wave is touching its own probe engine and warning about it is a separate, not-yet-built concern (FOR-30's territory — referenced here, not duplicated); this section covers the **operational fix**, which is one more step in the sequence, always:

**merge (phase 4) → pull to completion (sandbox disabled if needed) → only then reconcile (phase 5).**

Run this after every merge in the advisory order, before starting phase 5, regardless of whether you believe this wave touched the probe engine:

```bash
git fetch origin main
git pull --ff-only origin main
git rev-parse HEAD   # MUST equal the merged main tip — do not trust exit code or git status alone
```

**Sandbox precondition — disable the sandbox for this pull whenever this wave's rows touch anything under `.claude/skills/`.** The sandbox denies writes under `.claude/skills/**`; a fast-forward that includes a skill-file change stops mid-apply with `error: unable to unlink old '.claude/skills/<path>': Operation not permitted`. Everything outside the denied paths (e.g. `tools/wave/src/**`) still lands — only the skill files don't.

**Half-applied-pull symptom — nothing flags this as broken.** The result is a mixed working tree: some tracked files carry the merged content, the skill files do not, and **HEAD stays frozen on the pre-merge SHA** — no `MERGE_HEAD`, no lock file, no non-zero exit code past the failed unlink, and a plain `git status` reads like an ordinary set of pending local changes, not a corrupted pull. **Do not infer success from the pull's exit code or from `git status` being quiet** — the only reliable check is `git rev-parse HEAD` against the merged tip, as above.

**Resolution:** re-run as a hard reset with the sandbox disabled —

```bash
git reset --hard origin/main   # sandbox disabled: needs write access under .claude/skills/
```

— safe here because a wave-close checkout has no local edits by design (every change this wave made already landed through its own PR). Confirm `git rev-parse HEAD` matches the merged tip, then proceed to phase 5 — it now reconciles against the same engine the wave just changed, not the one from before it.

### 5. Done-reconcile + needs-attention for stuck rows

Probe each terminal row's closing state, then either **land it `done`** (a merged PR), **flag it** (a genuinely rejected PR / stuck row), or **report it** (no merge evidence either way).

**Read the outcome as a claim about evidence, not as a verdict.** The probe reports what it *found*, and the four outcomes are not equally alarming. Only `closed-unmerged` means "a PR was rejected" — `closed-unknown` means "nothing was found", which is not the same thing and must never be auto-flagged.

**Skip `parked` rows entirely — do not probe them** (ADR-0022). A parked row has no branch and no PR, so `read-closing` has nothing to find; its claim was already released at park time. Report it under the parked rubric below and move on.

```bash
{{wave-cli}} issue-store read-closing <id>   # → { state: "open"|"merged"|"closed-unmerged"|"closed-unknown", prUrl? }

# closed-unmerged (a PR was FOUND and it did not merge) → flag recoverable-stop
{{wave-cli}} issue-store flag <id> \
  --kind recoverable-stop \
  --question "PR was closed without merging — reopen, re-dispatch, or abandon?" \
  --option reopen --option re-dispatch --option abandon

# closed-unknown → NO flag. Report it and ask the human. See the rubric below.
```

- **`merged` → land the row `done`** via the **done-reconcile**: `{{wave-cli}} issue-store close <id> <prUrl>` (the `prUrl` is `readClosing`'s). This is the operational trigger that reaches `done` for a merged row — the wire the live gate found missing (F1). `close` is **idempotent no-op-or-reconcile**: on a native-integration tracker the merged PR already flipped the coarse projection, so `close` only records the closing PR + a cosmetic AC tick; a re-entrant wave-close re-run never double-posts. Do **not** re-implement close — it is the existing `IssueStore.close()` verb. Then clear any stale flag: `{{wave-cli}} issue-store clear-flag <id>`.
- **`closed-unmerged` → `recoverable-stop`** — the store **found a linked PR and it did not merge**: a genuinely rejected PR. It is NOT auto-moved back to `available`; doing so would let another wave re-grab the issue and redo deliberately-rejected work. The human dispositions it (reopen / re-dispatch from scratch / abandon).
- **`closed-unknown` → report, do NOT flag** — the row is closed but the store found **no PR evidence either way**. This is *absence of evidence*, not evidence of rejection: the issue may have been closed by hand, closed as a duplicate, closed by a foreign id mentioned in an unrelated PR's body, or closed on a workspace whose tracker↔host integration never attached the PR. Auto-flagging it would raise `recoverable-stop` on a legitimately-completed row — the exact false alarm this outcome exists to prevent (it flagged three genuinely-merged rows in the wave that found it). Report it as **`closed-unknown — closed, but no merged-PR evidence found; confirm before landing`**, naming the id, and let the human say what happened. Two legitimate follow-ups, both human-initiated: if the merge is confirmed out-of-band, run `{{wave-cli}} issue-store close <id> <prUrl>` (on a store with `states.doneState` this fires the FOR-13 fallback); if the human says the PR really was rejected, flag it as `closed-unmerged` above. **Never guess between those two.**
- **`open` → PR still in review; no flag** — the human merges it in the advisory order; a later re-run reconciles it. **No-integration workspace with `states.doneState` set (FOR-13):** the probe can **never** report `merged` (there is no tracker↔host integration to see the merge) — it stays `open` after the PR lands. Once the Coordinator has confirmed the merge **out-of-band** (the human merged in the advisory order, or `--auto`/`gh` confirmed it), run the SAME `{{wave-cli}} issue-store close <id> <prUrl>` — on a store with `states.doneState` this fires the FOR-13 fallback (mapped done-state transition + a loud advisory), landing the ticket even without the integration. `close` is idempotent, so re-runs stay safe. Without a confirmed merge, leave the row `in-review`.
- **`failed`/`abandoned`** rows were already flagged by `wave-start`; do not double-flag unless `readClosing` also returns `closed-unmerged`.
- **`parked` → report, never flag** (ADR-0022). Report it as **`parked — released for re-planning`**, naming the issue id so the human can see what left the wave. Do **not** flag it, do **not** `close` it, do **not** `unclaim` it again (the claim was released at park time; re-running is harmless but pointless). The question a needs-attention flag would raise — "what should happen to this row?" — is already answered: it is coming back in a future wave, drawn fresh from the pool. Flagging it would be the exact false alarm the state exists to remove.

The flag is **orthogonal to the coarse rung** — the row stays at its current rung (`in-review` / `failed` / `abandoned`); `read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged. A `done` row (closed PR) reads `done` regardless of any lingering flag (closed wins over the flag).

> **P8 note:** `--auto` (opt-in auto-merge) and fall-behind-branch flagging are P8. In P8: `gh pr merge --auto <pr-url>` (through wave-shared, never raw inline); on arm failure → flag `recoverable-stop` with `"auto-merge could not arm — branch is behind main; rebase then re-run wave-close --auto, or merge by hand"` and `--option rebase-and-retry --option merge-by-hand`. Rebase-train automation is M2.

### 6. Archive (the last phase — terminal-only, idempotent, layout-aware)

**Guard (terminal-only):** archive only when every row is finalised (no row `dispatched`/`reviewing`/etc.). If any row is still pending → do NOT archive; print `wave not yet terminal (skipped)`.

**Guard (idempotent):** `<wave-file>` already under `.flotilla/waves/_archive/` → print `already archived (no-op)`.

**A consumer's `.flotilla/` may or may not be git-tracked.** flotilla's own dogfood repo keeps it gitignored (toolkit, not consumer); most consumer repos track it (the spine is the durable WAL, so committing it enables resume from a fresh clone — see the setup convention in `wave-setup`). `git mv` fails outright on an ignored/untracked path, so the archive step **detects the spine's actual git-tracked status and picks the matching move, every time** — never assume from the consumer type or from what the last wave did. It also re-checks whether the move already happened, so a second run is a no-op rather than a failed move:

```bash
SLUG=<slug>   # e.g. 2026-06-19-foo

mkdir -p ".flotilla/waves/_archive"   # unconditional — both branches' first-ever
                                       # run needs the destination dir to exist
                                       # before the move; idempotent to re-run.

if [ -f ".flotilla/waves/_archive/$SLUG.md" ] && [ ! -f ".flotilla/waves/$SLUG.md" ]; then
  echo "already archived (no-op)"           # re-run: destination populated, source gone
elif git ls-files --error-unmatch ".flotilla/waves/$SLUG.md" >/dev/null 2>&1; then
  # Tracked: git mv preserves history and needs a commit.
  ARCHIVE_MODE="tracked (git mv + commit)"
  git mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
  git mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
  git commit -m "chore(wave): archive $SLUG → _archive/ (operational close)"
else
  # Ignored/untracked: git mv would fail here; plain mv, no commit to make.
  ARCHIVE_MODE="untracked/ignored (plain mv, no commit)"
  mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
  mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
fi
```

(See [reference/close-mechanics.md](reference/close-mechanics.md) for the full worked version of this check, including the sidecar-folder half of the idempotency test.)

Archive moves the spine **and** its sidecar folder together, side by side in `_archive/` — flat layout either way. **Never archive to `done/`** — there is no `done/` close ceremony in flotilla (that is an Ur binding). The tracked move is reversible with `git mv` back if the wave is accidentally closed early; the untracked move is reversible with a plain `mv` back (there is no commit to revert). Re-running never fails just because the move already happened — the idempotency check above runs before mode-detection, in either mode.

**Durability consequence (report, don't decide):** an **untracked/ignored `.flotilla/`** means the wave's spine, sidecars, and archive exist **only on the machine that ran the wave** — a fresh clone (a teammate, CI, a new machine) has no wave history at all, only whatever landed in the actual PRs. A **tracked `.flotilla/`** carries that history along with the repo. This slice only makes the archive mechanics honest about whichever answer a consumer has already chosen (via `.gitignore`) — it does **not** recommend one default over the other. That recommendation (should `wave.config.json` / `.flotilla/waves/` be tracked by default for a new consumer) is explicitly deferred to the publication/onboarding PRD, where the wider "what does a new consumer see on `git clone`" question is decided.

After archiving, print a close summary: wave slug, **which archive mode ran** (`tracked (git mv + commit)` or `untracked/ignored (plain mv, no commit)`), per-row final state, advisory merge order, any `needs-attention` flags, next human steps (merge PRs in the printed order).

## Common Mistakes

- **Archiving before terminal.** The terminality gate (all rows `pr-created`/`approved`/`failed`/`abandoned`/`parked`) must hold. A row still `dispatched`/`reviewing` means the wave isn't done.
- **Flagging — or probing — a `parked` row.** `parked` is terminal *and silent* (ADR-0022): the claim is already released and the disposition is already decided. Do not `read-closing` it (there is no PR to find, so the probe can say nothing useful — it reads `closed-unknown` at best), do not flag it, do not `close` it. Report `parked — released for re-planning` and move on.
- **Recording a held row as `abandoned`.** `abandoned` means "never"; a row held out of this wave for re-planning is `parked` ("later"). Recording it `abandoned` lies to the next planner and leaves the claim stuck on the board — this is the live-gate defect ADR-0022 exists to fix.
- **Writing the advisory order into `## Conflict-Map`.** The `## Conflict-Map` section is parser-consumed (ADR-0016); `spine replace-closed-by` targets `## Closed-by`, not this section. Print the merge-order advisory to stdout — do NOT edit the spine to record it.
- **Leaving a `merged` row at `in-review` (only clearing its flag).** A merged PR must be landed `done` via `{{wave-cli}} issue-store close <id> <prUrl>` — that is the done-reconcile (F1). Clearing a stale flag alone does not reach `done`, and in a no-integration `states.doneState` workspace nothing else ever will.
- **Re-implementing close.** `close` is the existing `IssueStore.close()` verb — idempotent no-op-or-reconcile, and the FOR-13 fallback lives inside it. Call the verb; never hand-roll a state transition or a "done" write in the skill.
- **Auto-moving `closed-unmerged` back to `available`.** A rejected PR re-grabbed by another wave redoes deliberately-rejected work. Flag it `recoverable-stop`; the human disposes.
- **Treating `closed-unknown` as a rejected PR.** They are different claims: `closed-unmerged` means a PR was found and it did not merge; `closed-unknown` means nothing was found. Flagging the latter raises `recoverable-stop` on rows that are simply done — the live defect this outcome exists to fix. Report it and ask; never flag it, and never `close` it on a guess.
- **Archiving to `done/`.** flotilla archives to `_archive/`; there is no `done/` close ceremony.
- **Assuming `.flotilla/` is (or isn't) git-tracked and always running `git mv`.** A gitignored/untracked spine makes `git mv` fail outright (P-11 — the first live wave hit this and hand-typed a plain `mv` as a manual workaround). Detect the actual tracked status of the spine file for *this* archive, every time — do not assume from the consumer type, and do not assume from what the previous wave's archive did.
- **Removing a dirty worktree.** A worktree with uncommitted changes is reported and skipped, never removed.
- **Trusting `gh pr merge --delete-branch`'s exit 0 as proof the branch is gone (W3-F3 / W4-F11).** It exits 0 on merge success alone; a failed local delete (branch held by a worktree, or simply checked out) silently aborts the remote delete too, with no exit-code or log signal. Verify by querying the host for surviving `wave/*` branches after every merge — never assume from the merge command's success.
- **Trusting a clean `git worktree list` as proof the directories are gone.** Git can deregister a worktree while failing to delete its on-disk directory, leaving an orphan `git worktree list` no longer reports. Verify on disk (list the worktree root) against `worktree-cleanup`'s `errors` array.
- **Merging `main` or fast-forwarding.** wave-close opens PRs (P8) and (opt-in P8) arms auto-merge — it never touches `main` directly. The Ur's §7.1 branch-sync is gone.
- **Double-flagging `failed`/`abandoned` rows.** `wave-start` already flagged these. Only re-flag if `readClosing` also shows `closed-unmerged`.
- **Running the archive before the needs-attention phase.** Flag stuck rows first; archive last.
- **Treating `needs-attention` as a rung.** It is orthogonal — the row keeps its rung; the flag is the human signal layered on top.
- **Using `host-pr` create/findOpenPr from the CLI.** These are library-only in P7.4; the CLI verb does not exist. Describe as P8.
- **Reconciling before the pull completes (W5-F3).** Phase 5 probes with whatever engine is on disk; if this wave's own rows touched that machinery, an un-pulled or half-pulled checkout reconciles against the *pre-merge* code — the exact conditions that would flag correctly-merged rows as `recoverable-stop` (W4-F1). Pull to the merged `main` tip (verified via `git rev-parse HEAD`, not the pull's exit code) before starting phase 5 — see "4a" above.
- **Trusting a `git pull`/`git reset` that touched `.claude/skills/` without checking `HEAD`.** The sandbox can deny the skill-file half of a fast-forward while the rest applies silently — no error past the failed unlink, `git status` reads as ordinary pending changes, and `HEAD` stays on the pre-merge SHA. Disable the sandbox for that pull whenever this wave's rows touch `.claude/skills/**`, and confirm `git rev-parse HEAD` against the merged tip before trusting the checkout.

## Related

- [reference/close-mechanics.md](reference/close-mechanics.md) — the worked CLI sequence, JSON shapes, exit codes.
- [../wave-shared/SKILL.md](../wave-shared/SKILL.md) — auth-preflight / atomic-spine conventions this skill inherits.
- [../wave-start/SKILL.md](../wave-start/SKILL.md) — the dispatch loop that brings rows to `in-review`, the precondition for wave-close.
- [../wave-create/SKILL.md](../wave-create/SKILL.md) — materialises the spine this skill terminates.
