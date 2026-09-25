---
status: accepted
---

# What lands is the reviewed commit

A wave row's PR may land only at the commit its Reviewer gave the verdict for. Nobody commits to a row's branch after the verdict; any change after it is a new iteration that gets its own review. The landing verbs enforce this with an expected-head check. This settles the core of the Files-boundary grill (#707): once nothing can change after review, a row cannot grow past its declared Files between review and landing, and nothing has to recompute the Conflict-Map for that case.

## What was measured

Grilled 2026-09-25 from #707, after a premise check against `main` 4565c48. Its input 2 and #622 were settled the same evening in ADR-0054.

- **The incident.** On 2026-09-04 a Coordinator commit on one row reached a file a sibling row also edited (the fix for a Reviewer disclosure), and nothing noticed. Nothing between the last routing and the arm re-checks the Conflict-Map. Partial-arm and `merge-order` read the planning-time map.
- **The between-rounds sequence covers only part of it.** wave-start now lands each round, re-anchors, and re-runs DoR and the Conflict-Map for the next round's rows. A widened row that lands is then inside the next round's anchor, so its overlap with rows in *later* rounds is neutralised. The sequence does not cover a pair in the *same* round, a wave that lands everything at close, or the row being armed itself. It also reads tracker-declared Files, so it cannot see a widening that exists only on the branch.
- **No skill documents a Coordinator commit after the verdict, and none forbids it.** Convention 15 (ADR-0033) requires a Reviewer verdict for an issue-closing PR. A PR whose branch moved after its verdict still carries a verdict, just for an older commit.
- **The reviewed commit is already recorded.** The driver asserts that `refs/review/<id>` equals the Worker's last commit before the Reviewer reads it, and the ref survives until the wave is terminal. `host-pr status` already reports the PR's head. GitHub can pin a merge to an expected head natively: the REST merge's `sha` and auto-merge's `expectedHeadOid`.
- **`files-drift` is invoked by nothing.** The Reviewer runs the same diff-against-declared-Files check itself.
- **Gate 6 (`ac-files-coverage`) warns and never fails.** Its false positives come from acceptance criteria that name a path as a boundary ("X stays unchanged") or as a reference. The gate cannot tell those from a path the row must change.

## Decision

1. **The reviewed head is the only commit of a row that may land.** Nobody commits to a row's branch after its verdict: not the Worker, not the Coordinator, not an Operator. A fix the Coordinator wants goes back to the Worker as a re-dispatch, a new iteration that gets its own review. So does a branch update needed to resolve a landing conflict.
2. **The landing verbs take an expected head.** `host-pr arm` and `host-pr merge` gain `--expect-head <sha>`. On GitHub the verb hands it to the host: the merge's `sha`, and `expectedHeadOid` when arming. The host refuses a PR whose head differs. On a host without such a pin, the verb compares the head from its own status read immediately before landing and refuses on a mismatch; this check-then-act window is stated, not hidden. A refusal is outcome `refused`, and its reason names both commits.
3. **The skills pass the reviewed head.** Wherever a wave lands a row (wave-start's between-rounds landing, wave-close's partial arm and `--auto`), the skill reads `refs/review/<id>` and passes it as `--expect-head`. When the ref is missing, the check cannot decide. The skill then lands without the flag and says so in its report (ADR-0052). A Coordinator-direct PR that is not a wave row carries no reviewed head and is unaffected.
4. **No Conflict-Map recompute for this case.** A row's diff cannot change after review, so the map the wave planned with, plus the Reviewer's own diff-against-declared-Files check, stays true until landing. The Conflict-Map writer that the pulse's drift degrade needs (ADR-0048) is not decided here.
5. **`files-drift` goes on the removal list; it is not wired.** It keeps working. Its help, the Catalog and the capabilities document say plainly that no skill calls it and that it is a removal candidate for a later major, which is not planned. ADR-0051 decision 1 already names it as a candidate. The word "deprecated" is not used, for the reason ADR-0051 decision 8 gives: it would promise a removal nobody has dated.
6. **Gate 6 stays a warning.** The warning reaches the person who can act on it: whoever decorates the row sees it in the `dor` run. A failing gate would punish criteria that name a path as a boundary, and abstention (ADR-0052) does not help, because the ambiguity is in the prose, not in a missing read.
7. **Required Files siblings are a slicing rule, not a gate.** A row that adds a root export declares the barrel trio: `index.ts`, `index.spec.ts` and `barrel-drift.spec.ts`. A row that adds or changes a CLI surface declares `cli.spec.ts`. to-issues states this beside the co-located-spec rule.

## Considered Options

- **Allow a Coordinator commit when it is declared and probed** (rejected). It would be disclosed as a scope extension, the Files widened with `filesAdd`, and checked with `git merge-tree` against every unlanded sibling. It is flexible, but the discipline lives in prose, and the changed code still lands unreviewed. That is the gap Convention 15 exists to close.
- **Allow it, and recompute the Conflict-Map from real branch diffs at close** (rejected). It is the most robust option but needs a map-writer verb whose shape the unbuilt pulse also constrains, and it still lands unreviewed code.
- **A skill-side head comparison only, no verb flag** (rejected). GitHub can pin the head natively and race-free; a comparison in prose is a check-then-act gap on every host.
- **Wire `files-drift` into the Reviewer** (rejected). It would first need a tracker-id input, and the Reviewer's own check already does the job.
- **Mark `files-drift` "deprecated"** (rejected). ADR-0051 decision 8 keeps that word out of every surface because it promises an undated removal; a plain statement of fact carries the same information.
- **Gate 6 fails for paths that exist in the checkout** (rejected). That still fails boundary mentions of existing files, which are the common case.

## Consequences

- `--expect-head` is an additive flag on the landing verbs: a minor release. The skills that land rows name it.
- A landing conflict on a later round's row means a re-dispatch, not a hand-resolved merge on the branch. This is the price of decision 1, and the between-rounds re-anchoring keeps it rare.
- #707 closes with this record once its rows are filed. #622 and `filesAdd` are ADR-0054's.
