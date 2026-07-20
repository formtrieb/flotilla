# wave-reviewer — check mechanics

The exact verification commands the Wave Reviewer agent runs. The agent definition (`.claude/agents/wave-reviewer.md`) owns the dispatch contract + the verdict-pick rules; this file is the runnable detail.

> **Read-only.** Every command here is read-only verification — `git diff`, `git show <SHA>`, re-running tests, grep. Never `git checkout`/`add`/`commit`/`push` against the Coordinator tree.

## The diff base — the wave-anchor SHA, never `main`

```bash
ANCHOR=<wave-anchor SHA, from the dispatch brief>
BRANCH=wave/<id>-<slug>
git diff --name-only "$ANCHOR".."$BRANCH"     # the Worker's actual changed files
git diff "$ANCHOR".."$BRANCH"                 # the actual change
```
`main..branch` would surface the full feature delta and hide the Worker's change. Always anchor.

## Check 1 — verify re-run

Run the same verify commands the VerifyGate selected for the changed files (the consumer's `wave.config.json` `verify` profile — e.g. `composer install` + `vendor/bin/phpunit` for a PHP CMS consumer, or `npm test` + `npm run lint` for a node consumer). Report exact counts; a disagreement with the Worker report is `changes-requested`. Capture into `lintTestSummary`.

**If `wave.config.verify` is absent (no verify profile), this step is empty.** Note `"no verify profile"` in `lintTestSummary` and proceed — a verify-less config is valid.

## Check 2 — git-state sanity (against `$ANCHOR`)
```bash
# Files-glob match — every changed file covered by the issue Files: globs
git diff --name-only "$ANCHOR".."$BRANCH"

# Conflict-marker floor (the engine FLOOR_CHECK)
git diff --name-only "$ANCHOR".."$BRANCH" \
  | xargs -I{} git show "$BRANCH:{}" 2>/dev/null \
  | grep -nE '^(<<<<<<<|=======|>>>>>>>)' | head
#   any hit → hard changes-requested; quote file:line

# AC-ticks consistent — spot-check the diff carries evidence per ticked AC
git show "$BRANCH" -- <relevant file>

# Closed-by well-formed — if the Worker report includes a Closed-by line,
# verify it is a well-formed STORE-KIND close phrase (wave-shared Convention 4:
# github -> "Closes #N", linear -> "Fixes <TEAM-NN>") referencing the correct
# issue id — not a literal "Closes #N" regardless of store kind.
```
Set `gitStateSane` true iff all four hold.

## Check 3 — per-AC verification
One `acVerification` row per AC: `{ ac, met, evidence }` where `met ∈ met|partial|not-met|deferred` and `evidence` is `file:line` / `commit-sha` / "deferred per marker". Ticked-without-evidence → `changes-requested`; `partial` without a deferred marker → `questions-blocking`.

## Check 4 — focus-hints sweep
One directed check per hint (Coordinator hints ++ Worker `reviewerFocusItems`). Non-mechanical → `reviewerFocusItems` entry tagged `(needs human eyes)`; never `changes-requested` those.

## Check 5 — sibling merge-tree (only when sibling list non-empty)
```bash
for SIB in <sibling-branches>; do
  git fetch origin "$SIB" 2>&1 | tail -3
  git merge-tree "$BRANCH" "origin/$SIB"     # <<<<<<< → predicted conflict
done
```
**Always `(advisory)`.** Surface as `reviewerFocusItems`: `(advisory) Predicted merge conflict with <SIB> at <file> — rebase whichever PR lands second.` Never escalate to `changes-requested`/`questions-blocking`.

## The return shape (post-P7.4 — NO briefProfile)

| Field | Required | Notes |
|---|---|---|
| `verdict` | yes | `approve \| changes-requested \| questions-blocking` |
| `branchReviewed` | yes | the branch you diffed |
| `riskClass` | yes | reported verbatim — the load-bearing G3 routing input |
| `workerReportDigest` | yes | one-line digest of the Worker report |
| `acVerification` | yes | `[]` only when the issue has no ACs |
| `reviewerFocusItems` | yes | `[]` when none; sibling/advisory/needs-human items here |
| `lintTestSummary` | no | the re-run result (or `"no verify profile"` when absent) |
| `gitStateSane` | no | conjunction of the Check-2 sub-checks |

`briefProfile` is **gone** (the reviewer is uniform). The schema's `additionalProperties: false` rejects it — never emit it. The `agent({ schema })` boundary validates this object before `wave-start`'s `route-verdict` reads `verdict` + `riskClass`.

## Dropped from the Ur
- **Check #11 (axe-a11y)** — Angular/Storybook-specific; not in flotilla.
- **Risk→brief-profile branching** — the contract is uniform (ADR-0016).
- **`gate-runner` JSON must-cite (Ur input #8)** — flotilla's floor is the engine `FLOOR_CHECKS` (conflict-marker + AC-coverage) run inline above, not a separate gate-runner.
