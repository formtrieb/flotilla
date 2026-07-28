# Phase 4 — Advisory merge-order (print-only) — the merge happens here, verify branch deletion separately

Recompute the order and print it as a clear advisory block. The engine sources each issue's branch from the spine's dispatch-log (exact branches, not guesses):

```bash
{{wave-cli}} merge-order "$WAVE"
# { "algorithmic": ["wave-orch/42-foo", "wave-orch/43-bar"], "override": null, "hasOverride": false, "reason": "no stacking detected" }
```

```
--- Advisory Merge Order ---
Reason : <reason>
Order  : <branch-1> → <branch-2> → <branch-3>
Override: none
---
```

`parked` rows are **excluded** from the order (ADR-0022) — no branch, no PR, nothing to merge. They fall out naturally (a parked row has no dispatch-log branch to source), so expect them absent; do not hand-add them.

**Advisory-only, by design — never written into the spine (ADR-0016 boundary).** The `## Conflict-Map` section is **parser-consumed**: it is rendered by `renderSpine`/`renderConflictMap` at wave creation and read back by the merge-order engine itself, so a skill must never hand-author content there. `spine replace-closed-by` targets `## Closed-by`, not `## Conflict-Map`, and no CLI verb exists to write a recomputed advisory order into the parser-consumed section (that would need a new `spine replace-conflict-map` verb, deferred to a later hardening slice if it's ever needed) — writing into it by hand risks corrupting the conflict-pair data the merge-order engine itself reads back. **Consequence:** the Coordinator follows the printed order manually. On the **default** path the human follows it directly; under **`--auto`** the order-free rows arm themselves in phase 4b and this printed order becomes only the overlapping tail's human playbook (never hand-merge those rows before checking phase 4b). When a fall-behind / stacked override is present, note it explicitly — the human decides whether to rebase before merging; rebase-train automation is M2, wave-close only ever advises the order.

Merge each PR in this order (default path) through the engine host seam — `gh` is off the landing path entirely (ADR-0023). Merge AND delete the remote head branch in one wired step (consumer KW-F6), so branch hygiene is the default, not an advisory afterthought:

```bash
{{wave-cli}} host-pr merge --branch <branch> --delete-branch
# { ok, verb:"merge", outcome:"merged"|"already-merged"|…, prNumber?, prUrl?,
#   branchDeletion:{ branch, deleted, error? } }
# (Under --auto, do NOT hand-merge the order-free rows — arm them in 4b below.)
```

**Read `branchDeletion.deleted` — never the exit code — as the evidence a branch is gone.** `host-pr merge --branch <branch> --delete-branch` (and `arm`'s identical flag) deletes the PR's REMOTE head branch through the host API directly (GitHub `DELETE .../git/refs/heads/<branch>`) as part of the SAME wired call — there is no local git delete on this path, so the historical W3-F3 / W4-F11 footgun (a worktree, or the current checkout itself, holding the branch locally caused a silent LOCAL-then-REMOTE delete failure under the old `gh pr merge --delete-branch`, with the merge command still exiting 0) does not apply here. A failed delete on the wired path is reported as `deleted:false` (+ `error`) in the SAME JSON the merge call returns and **never** turns the merge itself into a failure — the merge already landed regardless. Only when `deleted:false` (or on a legacy hand-merge that bypassed `host-pr` entirely, reintroducing the retired footgun) sweep for strays and delete by hand:

```bash
gh api "repos/<owner>/<repo>/branches" --jq '.[].name' | grep '^wave/'
# (or: git ls-remote --heads origin 'wave/*')
git push origin --delete <branch>
```

Do this regardless of whether phase 3's cleanup ran cleanly — cleanup only removes the worktree cause of the retired footgun, not this fallback sweep.

**Reconciled-merge verify — the checked step before a serialized lane's tail PR merges (KW-F4).** File-level conflict prediction is structurally blind to *semantic* cross-suite conflicts: two rows with **zero `Files` overlap** can still collide on the reconciled merge — a new test file meeting an API-wide change one row made, a success-path test decoding a response envelope another row changed. This is not hypothetical: it broke **27 test assertions** on the first Linear consumer wave's reconciled merge, past a green file-level conflict-map, and what caught all 27 was a human running the **consumer's full verify profile** on the reconciled merge before the tail PR landed — luck this step replaces with a gate. For every **serialized lane** in the advisory order — any chain of two or more branches that must merge in sequence (the overlapping tail; never the order-free rows) — after the lane's earlier PRs have merged and you have pulled `main` to reconcile (4a below), reconcile the tail branch locally onto that `main` and run the **consumer verify profile** against it:

```bash
git fetch origin main
git checkout <tail-branch> && git rebase origin/main       # reconcile the tail onto the merged head(s)
<consumer verify profile from wave.config.json>            # e.g. (cd tools/wave && npx vitest run && npx tsc --noEmit)
# green → merge the tail PR. red → a real landing conflict the file-level map
# could not predict; fix it (rebase/patch the tail) BEFORE the tail merges.
```

**Merge the tail PR only once that verify is green.** A red run is a real landing conflict the file-level map could not see: fix it (rebase the tail, patch the break) *before* the tail merges, never after. Surface the reconciled-merge verify result (which lanes were re-verified, green/red) in the phase-6 close summary's next-human-steps.

## Common Mistakes

- **Writing the advisory order into `## Conflict-Map`.** The `## Conflict-Map` section is parser-consumed (ADR-0016); `spine replace-closed-by` targets `## Closed-by`, not this section. Print the merge-order advisory to stdout — do NOT edit the spine to record it.
- **Trusting the merge command's exit code (or a bare `armed`/`merged` outcome) as proof the branch is gone.** `host-pr merge`/`arm --delete-branch` report deletion under `branchDeletion.deleted` in the SAME JSON — a failed delete is `deleted:false` and never fails the merge itself, so the exit code alone proves nothing about the branch. This replaces the historical W3-F3 / W4-F11 exposure (`gh pr merge --delete-branch`'s silent local-delete failure) for the wired path; that footgun only resurfaces if someone bypasses `host-pr` and hand-merges with raw `gh`. Verify by reading `branchDeletion`, and fall back to querying the host for surviving `wave/*` branches when it reports `deleted:false`.
- **Merging a serialized lane's tail PR without the reconciled-merge verify (KW-F4).** File-level conflict prediction cannot see semantic cross-suite conflicts — two zero-`Files`-overlap rows broke 27 test assertions on a reconciled merge, past a green conflict-map. Run the consumer verify profile on the reconciled tail (the same commands the Worker/Reviewer ran) before the tail PR merges; a green file-level conflict-map is never evidence the reconciled merge is green.
