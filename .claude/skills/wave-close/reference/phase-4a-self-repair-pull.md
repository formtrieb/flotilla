# Phase 4a — Self-repair check + pull to completion before you reconcile (W4-F1 / W5-F3)

**Phase 5 probes with whatever engine is on disk right now.** `issue-store read-closing`, `issue-store close`, `merge-order`, `worktree-cleanup`, and the `host-pr` routing verbs all run against the **local checkout** — and that checkout sits at the wave anchor (the code from BEFORE the wave), not at whatever `main` becomes once this wave's PRs merge. If *this wave's own rows* changed any of that machinery, the fix is not live in phase 5 until the just-merged `main` has been pulled locally.

**Detect it — mechanical, before phase 5 (not a retro operating note to remember).** Once the dispatch-log branches are in hand (phase 4), diff each against `main` and grep for the engine surface wave-close depends on:

```bash
# The files behind read-closing / close / flag / clear-flag (per-adapter +
# CLI wiring), merge-order, worktree-cleanup, the host-pr routing verbs, and
# the top-level CLI dispatch that routes to all of them. This also covers the
# transport/factory/wiring layer one level below the store wrappers —
# real-github-api.ts, github-api-factory.ts, real-linear-api.ts,
# linear-api-factory.ts, cli-store.ts — because a probe-logic fix confined to
# that layer (the FOR-23 / real-linear-api.ts precedent) would otherwise
# evade this check. Bitbucket has no issues-store / api-factory layer of its
# own — it is a host-only (PR-landing) adapter, not an IssueStore, so its
# entire transport lives in the one file host-pr's arm/merge/status/preflight
# /create verbs call through directly: adapters/bitbucket/bitbucket-api.ts.
# That file gained its entry here after the row-495 miss recorded under
# MAINTENANCE DUTY below — the same defect class the FOR-23 precedent above
# already names, now confirmed against the third shipped host. Also widened
# to cover the closed-by classifier
# (closed-by.ts, behind the `closed-by` verb), the credential-probe CLI
# (credential-probe-cli.ts, behind `credential-probe --all`), the sidecar
# reader `verdict-acked` reads through (sidecar.ts), the spine CLI
# (spine-cli.ts) plus the WAVE.md reader/writer it reads through
# (wave-md-rw.ts), and the spine store module (spine-store.ts). Phase 6's two
# fail-closed archive gates do NOT share a module — that shared-module
# assumption is exactly what produced the original gap here: `check-awaiting-human`
# goes through the shared WAVE.md reader/writer (wave-md-rw.ts: readSpine /
# humanHeldRowIds), while `check-disclosures` goes through the spine store
# module (spine-store.ts: createSpineStore / openDisclosures), which owns the
# `## Disclosures` section parsing OUTRIGHT with its own private line model. A
# fix confined to either gate's own module needs its own entry here — do not
# assume one entry covers both gates.
#
# the credential resolver every host write in phases 2, 4b and 5 goes
# through (credential-resolver.ts).
#
# MAINTENANCE DUTY: this list must gain an entry whenever wave-close starts
# calling a new verb — it is a hand-maintained enumeration with nothing
# checking it against the CLI's actual dispatch, the same defect class as
# the credential-discovery list. Whether an automated guard can hold this
# list to that duty is an OPEN QUESTION: an equivalent guard would have to
# parse this prose and derive verb-to-module from the CLI's own dispatch,
# which is a materially larger design question than this comment can settle
# — deliberately deferred at triage, not decided against. If you're about to
# build one, or to argue one away, that argument belongs at THIS pointer,
# not re-derived from scratch.
#
# OCCURRENCE (this duty coming due, not in the abstract): row 495 changed
# adapters/bitbucket/bitbucket-api.ts — the deleteBranch status handling
# reached by host-pr --delete-branch — and this list, before the
# bitbucket/(bitbucket-api) entry below existed, named no file under
# adapters/bitbucket/** at all. The pattern covered the GitHub and Linear
# transport/factory layers, so it read as adapter-aware while actually being
# adapter-aware for only two of the three shipped hosts; phase 4a reported
# that branch clean. Harmless on this repo (remote is GitHub — the landing
# verbs never route through the Bitbucket adapter); load-bearing on a
# Bitbucket consumer, where host-pr arm|merge|status|preflight are all
# detect-host-routed and reach this file for every host write. Adding the
# entry below is the narrow fix; it does NOT settle the OPEN QUESTION above
# — that question stays open.
ENGINE_SURFACE='^tools/wave/src/(adapters/(issue-store|markdown-fs-store|github/(github-issues-store|real-github-api|github-api-factory)|linear/(linear-issues-store|real-linear-api|linear-api-factory)|bitbucket/(bitbucket-api))\.ts|issue-store-cli\.ts|cli-store\.ts|merge-order\.ts|worktree-cleanup\.ts|host-pr(-cli)?\.ts|cli\.ts|closed-by\.ts|credential-probe-cli\.ts|credential-resolver\.ts|sidecar\.ts|spine-cli\.ts|wave-md-rw\.ts|spine-store\.ts)$'

# Worked example (the row-495 evidence case this entry closes, walked against
# the pattern above — run these two probes yourself if you touch this list):
#   $ echo 'tools/wave/src/adapters/bitbucket/bitbucket-api.ts' | grep -E "$ENGINE_SURFACE"
#   tools/wave/src/adapters/bitbucket/bitbucket-api.ts
#   → MATCH. The changed Bitbucket transport path (deleteBranch, reached by
#     host-pr --delete-branch) is now inside the surface — the row-495 miss
#     is closed.
# The check has to be able to fail too, or the entry above is broad enough to
# rubber-stamp everything under adapters/bitbucket/** — which would defeat
# the purpose as completely as matching nothing did. A path outside the
# surface still misses:
#   $ echo 'tools/wave/src/adapters/bitbucket/bitbucket-api.spec.ts' | grep -E "$ENGINE_SURFACE"
#   (no output)
#   → NO MATCH. The spec file is deliberately not part of the engine
#     surface — the pattern anchors on the exact `bitbucket-api.ts` filename
#     ($ after `\.ts`), so `bitbucket-api.spec.ts` cannot satisfy it.

# WRITE THE BRANCHES OUT, or iterate a real array — never `for BRANCH in $BRANCHES`
# (wave-shared Convention 12: zsh does not word-split, so a space-separated
# variable is ONE token and the loop silently runs once against a name that does
# not exist). ENGINE_SURFACE above is a PATTERN, not a command, and it is quoted
# at its point of use — that is the safe shape; the unsafe one is a variable in
# a loop head or in command position.
WAVE_BRANCHES=(wave/<id>-<slug> wave/<id>-<slug>)   # every branch from the dispatch-log
for BRANCH in "${WAVE_BRANCHES[@]}"; do
  HIT=$(git diff --name-only main...origin/"$BRANCH" | grep -E "$ENGINE_SURFACE")
  # NOT guarded on purpose: an empty HIT is the GOOD answer (no hazard on this
  # branch), not evidence the command failed to run — Convention 12's
  # "guard the capture whose emptiness means *did not run*" rule.
  [ -n "$HIT" ] && echo "SELF-REPAIR HAZARD: $BRANCH changes wave-close's own engine surface — $HIT"
done
```

Any hit means this wave is a self-repair case: **note it in the close summary** and treat the sequence below as non-negotiable for this run, not merely advisable. A clean run (no hits) still runs the sequence — the check is early warning, not a gate that skips the pull.

**Why the order is `merge → pull → reconcile`, never `merge → reconcile`.** Reconciling before the pull probes with the un-fixed, pre-wave code — and can flag correctly-landed rows. This is not hypothetical: it is the live **W4-F1 near-miss** — had phase 5 run before the pull, `read-closing` would have reported `closed-unmerged` for **all four** of that wave's already-merged rows (the fix those same rows shipped, `read-closing` itself, was not yet live in the local checkout), and the skill's own prescription would have flagged four correctly-landed rows `recoverable-stop` — exactly the damage class the fix existed to remove, inside the wave that removed it. Pulling first is what makes phase 5 reconcile against the engine the wave actually shipped, not the one it replaced.

**merge (phase 4) → pull to completion (sandbox disabled if needed) → only then reconcile (phase 5).**

Run this after every merge in the advisory order, before starting phase 5, regardless of whether the check above found a hit. The pull is not one blind command — it is two mandatory numbered steps, because Step 2's own behavior (sandbox on or off) is decided by Step 1's answer, not chosen up front or discovered by watching Step 2 fail.

**Step 1 (mandatory) — does the incoming diff touch a harness write-denied path?** Check *before* running the pull, against all three path classes the harness's sandbox write-deny list covers unconditionally: `.claude/skills/**`, `.claude/agents/**`, and `.claude/settings.json` (the "Sandbox precondition" below explains why these three and no others):

```bash
git fetch origin main
git diff --name-only HEAD origin/main | grep -E '^\.claude/(skills/|agents/|settings\.json$)'
```

That `grep`'s exit is the branch — read it and decide before touching Step 2:

- **No output (grep found nothing) → sandbox stays ON.** Run Step 2 exactly as written.
- **Any output (grep found a hit) → sandbox goes OFF for Step 2, not only for the recovery afterward.** This pull WILL half-apply under the sandbox — every prior occurrence has, because the outcome is deterministic on the paths touched, not on chance. Running Step 2 under the sandbox anyway just manufactures the half-applied state described below; disable the sandbox before Step 2 runs, not after it fails.

**Step 2 — the pull, sandbox on/off per Step 1's answer:**

```bash
git pull --ff-only origin main
```

```bash
# Verify the fast-forward MECHANICALLY, not by eyeballing two printed SHAs — and
# refuse an EMPTY capture rather than comparing two blanks and calling it equal
# (wave-shared Convention 12: `git rev-parse` writes its error to stderr and
# leaves stdout empty, so `[ "$A" = "$B" ]` on two failed captures reads TRUE).
#
# ISSUE THIS AS ONE BASH CALL. The two captures and both checks share one scope
# on purpose: shell state does not survive between Bash calls, so a guard issued
# separately would inspect two unset variables and compare them — passing exactly
# where it is meant to stop (Convention 12, half two, Form 2). `--verify` makes
# an unresolvable ref exit non-zero as well, so the empty case is caught twice.
MERGED_TIP=$(git rev-parse --verify origin/main)
LOCAL_HEAD=$(git rev-parse --verify HEAD)
if [ -z "$MERGED_TIP" ] || [ -z "$LOCAL_HEAD" ]; then
  echo "STOP: a rev-parse came back empty — the command that should have produced a SHA did not run. Refusing to compare two blanks. Do NOT start phase 5." >&2
  exit 1
fi
if [ "$LOCAL_HEAD" != "$MERGED_TIP" ]; then
  echo "STOP: HEAD is not at the merged main tip — the fast-forward did not complete (see the half-applied-pull symptom below). Do NOT start phase 5." >&2
  exit 1
fi
```

**Sandbox precondition — this is the rule Step 1 above checks for.** Disable the sandbox for Step 2 whenever this wave's rows touch anything under `.claude/skills/**`, `.claude/agents/**`, or `.claude/settings.json`. The sandbox denies writes to all three, unconditionally: a fast-forward that includes a skill-file change, an agent-definition change, OR a `.claude/settings.json` change stops mid-apply with `error: unable to unlink old '.claude/skills/<path>': Operation not permitted` (or the same error naming `.claude/agents/<path>` or `.claude/settings.json`). Everything outside the denied paths (e.g. `tools/wave/src/**`) still lands — only the denied path doesn't. (`.claude/settings.local.json` is gitignored in this repo — never part of any commit, so it cannot itself fail a pull this way — but the identical harness rule denies writing it directly, so never hand-edit it from an agent either.)

**Why this deny exists, and why it never goes away.** This is not a rule in either file's own content, and nothing this repo's or the operator's own config declares — it is a fixed entry in the harness's OWN sandbox write-deny list, enforced underneath whatever the tracked config says. It is deliberate: an agent that could rewrite its own permission file could grant itself permissions, so the harness refuses agent-initiated writes to the file that grants permissions, full stop. An operator who greps their own `.claude/settings.json` looking for the rule behind `Operation not permitted` finds nothing — the denial is not theirs to configure or remove. And the collision is permanent, not a bug a future change removes: flotilla requires `.claude/settings.json` to be *tracked* (FOR-16/54–57 — a worktree checkout carries tracked files only, and the dispatched Worker's inherited permission allowlist has to be one of them), so the one file the toolkit must keep in git is exactly the file the harness must refuse to let an agent write. Every pull, merge, checkout, or reset across a commit that touches it walks into this, every time, by design.

**Half-applied-pull symptom — nothing flags this as broken, and it wears two faces from one cause (Occurrence 2, 2026-08-14 close, explaining the un-mechanized Occurrence 1 from the 2026-08-13 close).** The checkout underneath `git pull --ff-only` is not atomic: it stops the instant it hits a denied unlink, and what a denied path looks like afterward depends only on whether that path already existed at the frozen HEAD or is wholly new in the incoming diff — same abort, two shapes on disk:

- **Face 1 — a denied path that already existed pre-merge.** **`HEAD` stays frozen on the pre-merge SHA** (the fast-forward never gets past the failed unlink); the denied file itself is left behind on disk holding only its pre-merge content — an untracked-in-effect copy the merge could never overwrite, invisible to git's own bookkeeping since it still matches what HEAD already claims.
- **Face 2 — a denied path that is wholly new in the incoming diff.** There is no pre-merge copy to protect, so git writes the new file straight into the working tree before checkout processing reaches whatever later denied path trips the `unable to unlink` failure and aborts. `HEAD` still never advances (the same frozen-tip mechanism as Face 1), so git has no commit to credit that file to — it shows up as a plain **untracked** file, not staged, not modified. **A bare retry of `git pull --ff-only origin main` then refuses outright**: `error: The following untracked working tree files would be overwritten by merge: … Please move or remove them before you merge` — the retry is blocked by the very files the first, aborted attempt already wrote.

Either face, a plain `git status` reads like an ordinary, unremarkable set of pending local changes (Face 1: nothing, or modified files elsewhere in the diff that landed before the abort; Face 2: those, plus untracked new files) — or perfectly clean, if nothing else in the wave landed either — never as a corrupted pull. No `MERGE_HEAD`, no lock file, no exit-code signal beyond the one `unable to unlink` line already scrolled past (both faces, first attempt) or the retry's `Please move or remove them` refusal (Face 2 only, and only ON a retry — the first attempt gives no such warning). **Do not infer success from the pull's exit code or from `git status` being quiet** — the only reliable check is `git rev-parse HEAD` against the merged tip, as above.

**Resolution — the live-proven three-step recovery (Occurrence 2, 2026-08-14 close).** Before discarding anything, confirm — do not assume — what is actually on disk for each face.

Face 1's leftover, confirmed against what's already committed:

```bash
git show HEAD:.claude/settings.json | diff - .claude/settings.json
```

(Substitute the actual denied path `git status` shows as modified — `.claude/settings.json` above is the example, not the only case.) No output → byte-identical to what's already committed; nothing real is lost by resetting it away. Any output → **STOP** and hand it to a human before proceeding — something diverged that the write-deny alone does not explain.

Face 2's leftovers, confirmed by listing them rather than guessing:

```bash
git status --porcelain | grep '^??'
```

Every `??` entry under `.claude/skills/**`, `.claude/agents/**`, or `.claude/settings.json` is a Face-2 leftover the aborted checkout already wrote. A `??` entry outside those three path classes is not part of this recovery — leave it alone; it is the operator's own untracked file, not the pull's residue.

With both confirmed, run the three steps below in order, **sandbox disabled for all three** (this generalizes cleanly to a Face-1-only run too: step 1 is then a no-op since the frozen file already matches HEAD, and step 2 is a no-op since there are no untracked leftovers to remove):

1. **Hard reset to the current, frozen `HEAD`** — discards any half-applied *tracked* content the aborted checkout wrote, without touching origin/main yet:
   ```bash
   git reset --hard HEAD   # sandbox disabled: touches .claude/skills/, .claude/agents/, and/or .claude/settings.json
   ```
2. **Remove exactly the Face-2 leftovers the listing above named** — never a broad `git clean -fd`, which would also take out an operator's own untracked scratch files elsewhere in the tree:
   ```bash
   rm -rf <each Face-2 path listed above>
   ```
3. **Re-run the pull, sandbox still disabled** — the working tree is now genuinely clean, so this is a real fast-forward, not a reset-to-target:
   ```bash
   git pull --ff-only origin main   # sandbox disabled
   ```

**Verify-clean tail (mandatory, every time):**

```bash
git status --porcelain   # MUST be empty
git rev-parse HEAD       # MUST equal the merged tip (MERGED_TIP captured in Step 2's verify block above)
```

An empty `git status --porcelain` plus `HEAD` at the merged tip is what "clean" means here — not the pull's exit code, not a quiet-looking `git status` on its own (see the symptom above, either face).

**Re-run-gates tail (mandatory, every time this recovery ran):** the pull that just completed may have changed the engine itself — re-run both verify gates against the freshly-pulled code before trusting phase 5's reconciliation against it:

```bash
./tools/wave/node_modules/.bin/vitest run --root tools/wave
./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit
```

Both green is what makes the pulled stand trustworthy for phase 5 — a red gate here means the merged stand itself needs attention before reconciliation, not a rubber-stamp carried over from before the pull. Only once the tree is verified clean and both gates are green does phase 5 start.

**Re-run `{{wave-cli}} worktree-cleanup --orphans` here too, unconditionally, before phase 5.** Phase 3 ran *before* phase 4's merge, so this wave's own `wave/*` branches only became remote-ref-gone once THIS close's own merges landed — the phase-3 sweep could not have caught them yet. This second call is what does; run it every time, not only when phase 4a's self-repair check found a hit.

## Common Mistakes

- **Reconciling before the pull completes (W5-F3).** Phase 5 probes with whatever engine is on disk; if this wave's own rows touched that machinery, an un-pulled or half-pulled checkout reconciles against the *pre-merge* code — the exact conditions that would flag correctly-merged rows as `recoverable-stop` (W4-F1). Pull to the merged `main` tip (verified via `git rev-parse HEAD`, not the pull's exit code) before starting phase 5 — see "4a" above.
- **Relying on memory of the W4-F1 retro instead of running the phase-4a detection step.** Whether *this* wave is a self-repair case is not something to eyeball from having read a prior operating note — diff each dispatch-log branch against `main` and grep it against the engine-surface list in phase 4a. The pull happens either way, but the detection step is what tells you (and the close summary) whether this run was the load-bearing case.
- **Trusting a `git pull`/`git reset` that touched `.claude/skills/**`, `.claude/agents/**`, or `.claude/settings.json` without checking `HEAD`.** The sandbox can deny the denied-path half of a fast-forward while the rest applies silently — no error past the failed unlink, `git status` reads as ordinary pending changes (Face 1) or ordinary-plus-untracked (Face 2), and `HEAD` stays on the pre-merge SHA. This is a harness-level deny, not something any of the three files' own content or the operator's own config controls, and it never goes away since flotilla must keep `.claude/settings.json` tracked. Disable the sandbox for Step 2 of the pull whenever this wave's rows touch any of the three paths, and confirm `git rev-parse HEAD` against the merged tip before trusting the checkout.
- **Running the pull blind, then diagnosing the `unable to unlink` failure after the fact.** Step 1's `git diff --name-only HEAD origin/main | grep -E '^\.claude/(skills/|agents/|settings\.json$)'` against the incoming diff, run BEFORE Step 2, tells you in advance whether to disable the sandbox — don't wait for the mid-apply error to find out, and don't skip past the numbered branch as if it were a warning you could read past.
- **Retrying `git pull --ff-only` immediately after a half-applied failure, without removing Face 2's untracked leftovers first.** The retry refuses with `Please move or remove them before you merge` — that refusal is not a new problem, it is the first attempt's own untracked leftovers blocking the second attempt. Run the three-step recovery (reset to `HEAD`, remove exactly the `??` entries the aborted checkout wrote, then re-pull) rather than repeating the bare pull and reading the refusal as something new to diagnose.
- **Iterating the dispatch-log branches out of a space-separated variable (`for BRANCH in $BRANCHES`).** zsh does not word-split, so the loop runs **once**, against a branch name that does not exist, and every self-repair hazard in the wave goes unreported — with no error louder than one `unknown revision` line (wave-shared Convention 12; live: W5-F5, W18-F3). Write the branches out or iterate a real array, as above.
- **Comparing `HEAD` to the merged tip by reading two printed SHAs.** Two *failed* `git rev-parse` calls both leave stdout empty, and an eyeball comparison of two blanks — or a bare `[ "$A" = "$B" ]` over them — reads as a match. Capture both, check them for emptiness, and only then compare; the exact half-applied-pull case this step exists to catch is the one where a capture is most likely to be the thing that goes wrong.
- **Splitting that verification across two Bash calls.** Shell state does not survive between them, so a guard issued after the capture inspects two *unset* variables — and reports them equal, which is the one answer that lets phase 5 start on a half-applied pull. Capture and check in ONE call, as the block above does (wave-shared Convention 12, half two). The same rule retired the `require_capture()` helper this file used to define: a shell function is session state too.
- **Discarding a leftover without confirming which face produced it first.** A Face-1 leftover (path existed pre-merge) can only be unchanged (byte-identical to what `HEAD` already claims) or, if something else touched it, genuinely different — compare with `git show HEAD:<path> | diff - <path>` before any `reset --hard` or manual removal. A Face-2 leftover (path is new in the incoming diff) has no committed copy to diff against at all — list it with `git status --porcelain | grep '^??'` instead, and remove only the entries that fall under the three denied-path classes; a broad `git clean -fd` risks taking an operator's own untracked scratch files with it.
