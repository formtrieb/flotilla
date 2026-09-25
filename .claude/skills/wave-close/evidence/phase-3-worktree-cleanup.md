# Phase 3 evidence: derivations and incident histories (opened 2026-09-16)

Moved out of `reference/phase-3-worktree-cleanup.md` per ADR-0050 (the 2026-09-16 corpus grill of #714/FOR-370): `wave-close`'s phase files are step load — read when their phase step is reached, on every run — and a mechanism an engine verb now owns keeps its invocation, its exit codes and what it refuses in the phase file; its derivation and incident history belong here instead, one pointer sentence left behind. Reachable on demand via the ADR-0040 sibling-path read; the verb sequence, exit-code reading and refusals stay in `reference/phase-3-worktree-cleanup.md` exactly as before — nothing here changes what any verb does.

## Why phase 3 moved ahead of the merge-order print (W3-F3 / W4-F11)

The merge itself is not a phase this skill runs — it is a host action the human takes once the advisory order is in hand (or, under `--auto`, one the host completes server-side after phase 4b arms the order-free rows). The reorder was originally motivated by the OLD `gh pr merge --delete-branch`: whatever still held a wave branch locally at merge time — **a worktree still checked out on it (W3-F3)**, or, separately, **the branch simply being the current checkout with no worktree involved at all (W4-F11 — reproduced merging the very retro PR that first documented W3-F3)** — made the LOCAL delete fail, and a failed local delete silently aborted the *remote* delete too, with the merge command still exiting 0. Phase 4's merge now goes through `host-pr merge --delete-branch` (or `host-pr arm --delete-branch`), which deletes the REMOTE head ref directly through the host API (GitHub `DELETE .../git/refs/heads/<branch>`) — there is **no local git delete on this path at all**, so the old footgun does not apply to it. Cleanup still belongs here, but for a narrower reason now: it removes the worktrees themselves before the human ever reaches the merge step, and remote-branch hygiene is the merge step's own job (`branchDeletion`, read from the SAME JSON the merge call returns — never the exit code; see phase 4). The one case this reorder never covered: a Coordinator (or human) who bypasses `host-pr` and merges by hand from a branch checkout reintroduces the retired footgun themselves — which is why phase 4 still treats branch deletion as a checked step regardless of phase order, not as something this reordering alone resolves.

## The `--orphans`-every-time rule: the four-consecutive-closes incident (close-review finding)

An earlier version of this phase treated the standalone orphaned-branch sweep (`sweepOrphanBranches`) as something to run only *after a manual worktree removal* — a trigger written for the ENOTEMPTY-fallback case (force-removing a worktree by hand). But the agent harness removing its own worktree **before wave-close ever starts** is the ordinary case now, not that exception. When it has already happened, `git worktree list` shows nothing for that worktree, `worktree-cleanup --spine <wave-file>` correctly reports `0/0/0` (nothing was registered for `planCleanup` to see), no manual removal is ever needed — and a sweep gated on "a manual removal happened" never runs. **Four consecutive closes reported `0/0/0` while `worktree-wf_*` and merged `wave/*` local branches piled up**, because that one documented call site was never reached — not because `sweepOrphanBranches`'s two signals (remote-ref-gone, worktree-gone) failed to recognize them. The fix is to always pass `--orphans`; it is a no-op when there is genuinely nothing to sweep.

## Per-population preview/execution-parity wiring history

The `--dry-run` preview computes the orphan-DIRECTORY plan, the orphan-BRANCH sweep (issue #148, fixed), the Scribe scratch-sweep (issue #355, previewed since issue #377), the detached-scratchpad sweep (issue #238, wired), the REVIEW-REF sweep (issue #732), and the COMPOSED-DRIVER sweep (issue #748) — each from the exact same plan function the real run executes (`planOrphanBranchSweep`/`executeOrphanBranchSweep`, `planScribeScratchSweep`/`executeScribeScratchSweep`, `planDetachedScratchpadSweep`/`executeCleanup`, `planReviewRefSweep`/`executeReviewRefSweep`), so preview and execution never independently derive a second answer for the same population.

One residual asymmetry, orphan-BRANCH only: the real run recomputes that plan AFTER physically removing orphan directories first, so a `worktree-wf_*` branch whose orphan directory this same call is about to delete can read ineligible in the preview and eligible moments later in the execute. Neither the Scribe scratch-sweep nor the detached sweep carries that asymmetry: each plan is computed once, before the `--dry-run` branch, so `orphans.scratch` and `detached.selected` in the preview are exactly what the real run removes. The COMPOSED-DRIVER sweep rides the same flag and the same discipline: `orphans.drivers: { dir, present, wavesDir, selected, skipped }` under `--dry-run`, the full result on the real run, from ONE plan object — the per-wave `<slug>/` directory `compose-driver` writes into, which the Scribe file sweep correctly refuses and therefore never removed.

## Branch hygiene: the run-1-vs-run-2 measurement

Measured at one close: run 1 deleted **zero** branches; the prescribed manual recovery removed six worktrees; an identical run 2 deleted **twelve** — six `wave/*` and six `worktree-wf_*` siblings. (This is the same incident Common Mistakes' "empty `branchesDeleted`" bullet in the reference file points back to.)

## The harness-denied-path chronicle (issue #142 → #150 → #304 → #483)

The exact set `HARNESS_DENIED_DIRS` / `HARNESS_DENIED_FILES` recognizes (issue #718) was not shipped whole: issue #142/PR #147 shipped the original set at once, then issue #150 widened it again with an editor-config directory, each time only after a LIVE denial actually reproduced the refusal, never by analogy. A hand-copied list in the reference file would drift the moment the constant grows again, and a stale doc claiming a path is covered when it is not sends an operator hunting for a bug that was fixed months ago — which is why the reference file points at the constant rather than transcribing it.

**Three consecutive wave closes proved that on a sandboxed harness this is NOT the exception — it is the ORDINARY outcome for every wave whose worktrees materialize harness-denied tracked files, which is every wave by design** (the checkout carries `.claude/skills/**` and `.claude/settings.json`). The prescribed recovery for that shape is sandbox-off `git worktree remove --force <path>` per worktree, then `git worktree prune` — the SAME command the engine's own scoped fallback already tried, now run outside the sandbox so the OS grants the delete the harness itself refused.

Separately (issue #304): a live wave close reproduced **17 of 18** such worktrees landing in `erroredStillListed` despite being correctly classified disposable, because git's own dirty check refused a call the engine never told to carry `--force`. That measurement is what added the scoped `--force` fallback the reference file now describes.

## `blockingPaths` (issue #718): the mistake it was filed to correct

Until this shipped, `dirtyAllJunk: false` said only THAT a worktree was stuck, never WHAT was stuck in it — reading it meant running `git -C <path> status --porcelain` by hand, every close, on every stuck worktree.

The mistake issue #718 itself was filed to correct: widening the `HARNESS_DENIED_DIRS`/`HARNESS_DENIED_FILES` allowlist on the strength of an entry appearing in `trackedDeleted` — without reproducing the refusal live, the way issues #142/#150 both did. A worktree carrying paths in that bucket that turn out NOT to be harness-denied is a normal, expected outcome, not a gap to close.

## `erroredStillListed`'s `--force` fallback: the 17-of-18 reproduction (issue #304)

Before this shipped, an entry the engine had already classified disposable still stopped at an unforced `git worktree remove`, because git's own dirty check refuses a plain removal on a tree with tracked deletions — even ones the engine itself just made. A live wave close reproduced **17 of 18** such worktrees landing in `erroredStillListed` despite being correctly classified, purely for want of `--force` on that one scoped call. The fix is exactly that: `--force`, but ONLY for an entry already classified disposable, ONLY as a last-resort fallback after the engine's own physical delete has already run.

## ADR-0042's 2026-09-08 amendment: what decisions 6 and 7 changed

Before the amendment, a harness-denied tree's first close read TRANSIENT, and only a second run — one run late — read EXHAUSTED. Decision 6 changed WHEN the question is asked: phase 1 now exhausts its delete permissions across the WHOLE tree before anything judges what is left, rather than stopping at the first refusal, so run 1 itself can see that everything remaining is harness-denied.

Decision 7 addressed the READ on a re-run: before the amendment, a second call on an already-exhausted tree would show up in `skipped` with `reason: 'dirty'` and a long `blockingPaths` list — reading as new, unexplained work-in-progress on a tree the engine itself had already gutted. The amendment keeps that tree selected and re-reads it EXHAUSTED with the same two commands on every subsequent run.

Also from that incident, folded into the same amendment: **three consecutive wave closes confirmed** that a bare re-run and the engine's own `--force` fallback both reproduce the identical refusal, every time, for every worktree whose only divergence is the tracked, harness-denied paths every checkout carries by design — the evidence behind calling the sandboxed-harness cause deterministic rather than transient.

## `exclusivelyDenied`: the reading before ADR-0042's amendment

`exclusivelyDenied: false` on a first-attempt harness-denied tree used to be expected, and correctly so: a delete that aborted at its first refusal had not yet exhausted its permissions when the question was asked, so ordinary content was still in the survivor set and the verdict could not fire. ADR-0042's amendment (decision 6, above) removed that cause — a first-attempt `false` on a harness-denied tree, or a run 1 that reads TRANSIENT, is now a live falsification of that decision, not the expected reading.

## Review refs: the `FETCH_HEAD` problem and the 187-ref backlog (issue #732)

A Reviewer never reads `FETCH_HEAD` — it is a single ref shared by the whole checkout, and a concurrent sibling Reviewer's own fetch can overwrite it mid-dispatch (a live occurrence handed back a plausible, wrong two-file diff, with no error). The fix was a **stable named ref per row**: `git fetch origin <branch>:refs/review/<id>` for the branch under review, `refs/review/sib/<id>` for each sibling tip the merge-tree prediction reads — and a Worker running that same sibling prediction for itself has been observed reaching for a third, ad-hoc namespace, `refs/sib/<id>`.

Those refs are exactly as durable as the fix required. They outlive the worktree, the local branch and the remote branch. **187 of them had accumulated in one shared `.git`, the oldest from six weeks earlier, and were swept by hand with `git update-ref -d`** before this sweep existed. They are harmless individually and unbounded collectively — and a stale `refs/review/<id>` from an earlier wave is exactly what a later Reviewer's own fetch silently overwrites, or, on a directory/file name clash, trips over.

## Terminal-wave refs: the one-wave lag (issue #748)

Until this landed, every ref a wave produced belonged to one of its own rows, so at that wave's close **all** of them read `live-row` and none was removed — measured at one close, ten refs spared, zero swept. They became sweepable only at the **next** wave's close, a one-wave lag on exactly the refs a later Reviewer's own fetch silently overwrites.

## The landed-sibling base ref no sweep could attribute (issue #978)

The Reviewer's landed-sibling check fetches the default branch's tip into `refs/review/base/<id>` — per row, for the same shared-ref reason every other review ref is per row. The classifier recognized only the `sib/` nesting under `refs/review/`, so `base/<id>` read as a two-segment `review` name with no row id, and the sweep skipped it `unresolvable-row` at every close — the refusal meant for names nobody can attribute, applied to a name the recipe itself creates. **Measured by a Reviewer's own probe** in wave `2026-09-23-sibling-truth-and-landing-message`: `planReviewRefSweep` on a terminal wave selected `refs/review/960` and `refs/review/sib/963` and skipped `refs/review/base/960`. The Coordinator deleted the base refs by hand in every round of that wave, and again after the next wave's round 2 (`refs/review/base/974`). The fix gave the shape a namespace of its own, `review-base`, with the liveness and terminal-wave rules `refs/review/<id>` already had; the enumeration prefix did not move, because `refs/review` already listed those refs — the classification was the only gap.

## The E2BIG incident (2026-07-30)

Live occurrence 2026-07-30, during the resume of a seven-row wave on the third dispatch run of the day; the subagent scope (every subagent inherits the same cached sandbox profile, not only the Coordinator) was confirmed with a minimal probe agent that hit the identical `E2BIG`. Verified live in the same incident: `git worktree remove` + `git worktree prune` did not restore the session; only restarting the harness did.

## Audit-between-waves: the incident it closes

The E2BIG incident above was the third dispatch run of one day, and its residue came from the first two runs of that day plus a prior session — none of which had been audited between waves.

## The Scribe scratch sweep: the repo-wide grep (issue #355)

Every population elsewhere in this phase is a worktree that some sweep could not *see*; this one accumulated because **no sweep was ever written for it**. A repo-wide grep found the `.flotilla/tmp/` path at **four driver sites and two spec sites, and in no cleanup path at all** (not wave-close, not wave-resume, not start-mechanics) before this sweep existed.

## The composed-driver directory gap: the measured close (issue #748)

The Scribe sweep's allowlist is on the payload **name** and only ever removes a **file**; a subdirectory was reported `not-a-scribe-payload` and left exactly where it was — correct classification, and the consequence was one directory per wave, swept by nothing at all. Measured at one close: **twelve payloads removed**, and the subdirectory holding that wave's three composed driver scripts **skipped**, while two wave-start references promised it was swept at close.

## The retired manual detached-worktree loop (pre-#238)

Before `--detached` was wired, the CLI had no way to reach this population at all, and the phase instructed sweeping it by hand instead:

```bash
git worktree list --porcelain | grep -B2 '^detached'   # find the detached ones
git worktree remove <path>                             # per confirmed-clean leftover
```

That manual loop is retired — `--detached` now reaches the same population through the engine's own safety invariants (dirty / locked / live-branch refusals) rather than a human eyeballing `git worktree list --porcelain` and deciding by hand what looks safe.

## Probe liveness: the `reviewing` state the spine never writes (issue #974)

The `probes` population first shipped with `live-row` meaning "the row reads `reviewing`". Nothing on the dispatch path writes that state — rows read `dispatched`, then `re-dispatched` or `pr-created` — so in wave `2026-09-23-sibling-truth-and-landing-message` a Reviewer, running `worktree-cleanup --probes-only` against a copy of the live spine, watched it select and remove a clean probe carrying its own running stamp. A close is unaffected either way (every row is terminal there, so every clean probe of the wave goes), which is why phase 3 never showed the defect; the routing call is where it bit. ADR-0042's Correction 2026-09-25 moved `live-row` to "a running state (`dispatched`, `re-dispatched`, `reviewing`) at the stamp's own iteration", with a non-numeric `Iter` cell failing closed.

The same wave also measured the stamp's spelling: a probe made at `<stamp>/probe` — the stamp as a parent directory — is not a member of the population, because the sweep matches the registered checkout's own basename, and outside every root it lands in `unaccounted` instead.
