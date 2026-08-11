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
# evade this check. Also widened to cover the closed-by classifier
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
ENGINE_SURFACE='^tools/wave/src/(adapters/(issue-store|markdown-fs-store|github/(github-issues-store|real-github-api|github-api-factory)|linear/(linear-issues-store|real-linear-api|linear-api-factory))\.ts|issue-store-cli\.ts|cli-store\.ts|merge-order\.ts|worktree-cleanup\.ts|host-pr(-cli)?\.ts|cli\.ts|closed-by\.ts|credential-probe-cli\.ts|credential-resolver\.ts|sidecar\.ts|spine-cli\.ts|wave-md-rw\.ts|spine-store\.ts)$'

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

Run this after every merge in the advisory order, before starting phase 5, regardless of whether the check above found a hit:

```bash
git fetch origin main

# Know before you run it, not after: does the incoming diff touch a harness
# write-denied path? Checking first turns the mid-apply failure below into an
# advance warning instead of something to diagnose afterwards:
git diff --name-only HEAD origin/main | grep -E '^\.claude/(skills/|settings\.json$)' \
  && echo "WARNING: this pull touches a harness write-denied path — disable the sandbox for the commands below, or expect a half-applied, HEAD-frozen result"

git pull --ff-only origin main

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

**Sandbox precondition — disable the sandbox for this pull whenever this wave's rows touch anything under `.claude/skills/**`, or `.claude/settings.json`.** The sandbox denies writes to both, unconditionally: a fast-forward that includes a skill-file change OR a `.claude/settings.json` change stops mid-apply with `error: unable to unlink old '.claude/skills/<path>': Operation not permitted` (or the same error naming `.claude/settings.json`). Everything outside the denied paths (e.g. `tools/wave/src/**`) still lands — only the denied path doesn't. (`.claude/settings.local.json` is gitignored in this repo — never part of any commit, so it cannot itself fail a pull this way — but the identical harness rule denies writing it directly, so never hand-edit it from an agent either.)

**Why this deny exists, and why it never goes away.** This is not a rule in either file's own content, and nothing this repo's or the operator's own config declares — it is a fixed entry in the harness's OWN sandbox write-deny list, enforced underneath whatever the tracked config says. It is deliberate: an agent that could rewrite its own permission file could grant itself permissions, so the harness refuses agent-initiated writes to the file that grants permissions, full stop. An operator who greps their own `.claude/settings.json` looking for the rule behind `Operation not permitted` finds nothing — the denial is not theirs to configure or remove. And the collision is permanent, not a bug a future change removes: flotilla requires `.claude/settings.json` to be *tracked* (FOR-16/54–57 — a worktree checkout carries tracked files only, and the dispatched Worker's inherited permission allowlist has to be one of them), so the one file the toolkit must keep in git is exactly the file the harness must refuse to let an agent write. Every pull, merge, checkout, or reset across a commit that touches it walks into this, every time, by design.

**Half-applied-pull symptom — nothing flags this as broken.** Whichever denied path is in play, the shape is the same: **`HEAD` stays frozen on the pre-merge SHA** (the fast-forward never gets past the failed unlink); the denied file itself is left behind on disk holding only its pre-merge content — an untracked-in-effect copy the merge could never overwrite, invisible to git's own bookkeeping since it still matches what HEAD already claims; and a plain `git status` reads like an ordinary, unremarkable set of pending local changes elsewhere in the diff (or perfectly clean, if nothing else in the wave landed either) — never as a corrupted pull. No `MERGE_HEAD`, no lock file, no exit-code signal beyond the one `unable to unlink` line already scrolled past. **Do not infer success from the pull's exit code or from `git status` being quiet** — the only reliable check is `git rev-parse HEAD` against the merged tip, as above.

**Resolution:** before discarding anything, confirm — do not assume — that the leftover file really is just the untouched pre-merge content the write-deny prevented from updating:

```bash
git show HEAD:.claude/settings.json | diff - .claude/settings.json
```

No output → byte-identical to what's already committed; the reset below discards nothing real. Any output → **STOP** and hand it to a human before proceeding — something diverged that the write-deny alone does not explain.

Then re-run as a hard reset with the sandbox disabled —

```bash
git reset --hard origin/main   # sandbox disabled: needs write access under .claude/skills/ and .claude/settings.json
```

— safe here because a wave-close checkout has no local edits by design (every change this wave made already landed through its own PR) and the comparison above already confirmed nothing real would be lost. Confirm `git rev-parse HEAD` matches the merged tip, then proceed to phase 5 — it now reconciles against the same engine the wave just changed, not the one from before it.

**Re-run `{{wave-cli}} worktree-cleanup --orphans` here too, unconditionally, before phase 5.** Phase 3 ran *before* phase 4's merge, so this wave's own `wave/*` branches only became remote-ref-gone once THIS close's own merges landed — the phase-3 sweep could not have caught them yet. This second call is what does; run it every time, not only when phase 4a's self-repair check found a hit.

## Common Mistakes

- **Reconciling before the pull completes (W5-F3).** Phase 5 probes with whatever engine is on disk; if this wave's own rows touched that machinery, an un-pulled or half-pulled checkout reconciles against the *pre-merge* code — the exact conditions that would flag correctly-merged rows as `recoverable-stop` (W4-F1). Pull to the merged `main` tip (verified via `git rev-parse HEAD`, not the pull's exit code) before starting phase 5 — see "4a" above.
- **Relying on memory of the W4-F1 retro instead of running the phase-4a detection step.** Whether *this* wave is a self-repair case is not something to eyeball from having read a prior operating note — diff each dispatch-log branch against `main` and grep it against the engine-surface list in phase 4a. The pull happens either way, but the detection step is what tells you (and the close summary) whether this run was the load-bearing case.
- **Trusting a `git pull`/`git reset` that touched `.claude/skills/**` or `.claude/settings.json` without checking `HEAD`.** The sandbox can deny the denied-path half of a fast-forward while the rest applies silently — no error past the failed unlink, `git status` reads as ordinary pending changes, and `HEAD` stays on the pre-merge SHA. This is a harness-level deny, not something either file's content or the operator's own config controls, and it never goes away since flotilla must keep `.claude/settings.json` tracked. Disable the sandbox for that pull whenever this wave's rows touch `.claude/skills/**` or `.claude/settings.json`, and confirm `git rev-parse HEAD` against the merged tip before trusting the checkout.
- **Running the pull blind, then diagnosing the `unable to unlink` failure after the fact.** `git diff --name-only HEAD origin/main | grep -E '^\.claude/(skills/|settings\.json$)'` against the incoming diff, run BEFORE the pull, tells you in advance whether to disable the sandbox — don't wait for the mid-apply error to find out.
- **Iterating the dispatch-log branches out of a space-separated variable (`for BRANCH in $BRANCHES`).** zsh does not word-split, so the loop runs **once**, against a branch name that does not exist, and every self-repair hazard in the wave goes unreported — with no error louder than one `unknown revision` line (wave-shared Convention 12; live: W5-F5, W18-F3). Write the branches out or iterate a real array, as above.
- **Comparing `HEAD` to the merged tip by reading two printed SHAs.** Two *failed* `git rev-parse` calls both leave stdout empty, and an eyeball comparison of two blanks — or a bare `[ "$A" = "$B" ]` over them — reads as a match. Capture both, check them for emptiness, and only then compare; the exact half-applied-pull case this step exists to catch is the one where a capture is most likely to be the thing that goes wrong.
- **Splitting that verification across two Bash calls.** Shell state does not survive between them, so a guard issued after the capture inspects two *unset* variables — and reports them equal, which is the one answer that lets phase 5 start on a half-applied pull. Capture and check in ONE call, as the block above does (wave-shared Convention 12, half two). The same rule retired the `require_capture()` helper this file used to define: a shell function is session state too.
- **Discarding the leftover denied-path file without comparing it to what's committed first.** The write-deny can only leave the file unchanged (byte-identical to what `HEAD` already claims) or, if something else touched it, genuinely different. Compare with `git show HEAD:<path> | diff - <path>` before any `reset --hard` or manual removal — never assume the leftover copy is safe to discard.
