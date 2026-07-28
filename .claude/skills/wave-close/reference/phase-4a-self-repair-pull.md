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
# evade this check:
ENGINE_SURFACE='^tools/wave/src/(adapters/(issue-store|markdown-fs-store|github/(github-issues-store|real-github-api|github-api-factory)|linear/(linear-issues-store|real-linear-api|linear-api-factory))\.ts|issue-store-cli\.ts|cli-store\.ts|merge-order\.ts|worktree-cleanup\.ts|host-pr(-cli)?\.ts|cli\.ts)$'

for BRANCH in <every wave branch from the dispatch-log>; do
  HIT=$(git diff --name-only main...origin/"$BRANCH" | grep -E "$ENGINE_SURFACE")
  [ -n "$HIT" ] && echo "SELF-REPAIR HAZARD: $BRANCH changes wave-close's own engine surface — $HIT"
done
```

Any hit means this wave is a self-repair case: **note it in the close summary** and treat the sequence below as non-negotiable for this run, not merely advisable. A clean run (no hits) still runs the sequence — the check is early warning, not a gate that skips the pull.

**Why the order is `merge → pull → reconcile`, never `merge → reconcile`.** Reconciling before the pull probes with the un-fixed, pre-wave code — and can flag correctly-landed rows. This is not hypothetical: it is the live **W4-F1 near-miss** — had phase 5 run before the pull, `read-closing` would have reported `closed-unmerged` for **all four** of that wave's already-merged rows (the fix those same rows shipped, `read-closing` itself, was not yet live in the local checkout), and the skill's own prescription would have flagged four correctly-landed rows `recoverable-stop` — exactly the damage class the fix existed to remove, inside the wave that removed it. Pulling first is what makes phase 5 reconcile against the engine the wave actually shipped, not the one it replaced.

**merge (phase 4) → pull to completion (sandbox disabled if needed) → only then reconcile (phase 5).**

Run this after every merge in the advisory order, before starting phase 5, regardless of whether the check above found a hit:

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

**Re-run `{{wave-cli}} worktree-cleanup --orphans` here too, unconditionally, before phase 5.** Phase 3 ran *before* phase 4's merge, so this wave's own `wave/*` branches only became remote-ref-gone once THIS close's own merges landed — the phase-3 sweep could not have caught them yet. This second call is what does; run it every time, not only when phase 4a's self-repair check found a hit.

## Common Mistakes

- **Reconciling before the pull completes (W5-F3).** Phase 5 probes with whatever engine is on disk; if this wave's own rows touched that machinery, an un-pulled or half-pulled checkout reconciles against the *pre-merge* code — the exact conditions that would flag correctly-merged rows as `recoverable-stop` (W4-F1). Pull to the merged `main` tip (verified via `git rev-parse HEAD`, not the pull's exit code) before starting phase 5 — see "4a" above.
- **Relying on memory of the W4-F1 retro instead of running the phase-4a detection step.** Whether *this* wave is a self-repair case is not something to eyeball from having read a prior operating note — diff each dispatch-log branch against `main` and grep it against the engine-surface list in phase 4a. The pull happens either way, but the detection step is what tells you (and the close summary) whether this run was the load-bearing case.
- **Trusting a `git pull`/`git reset` that touched `.claude/skills/` without checking `HEAD`.** The sandbox can deny the skill-file half of a fast-forward while the rest applies silently — no error past the failed unlink, `git status` reads as ordinary pending changes, and `HEAD` stays on the pre-merge SHA. Disable the sandbox for that pull whenever this wave's rows touch `.claude/skills/**`, and confirm `git rev-parse HEAD` against the merged tip before trusting the checkout.
