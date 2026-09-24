# Reviewer checks evidence: measurements and live occurrences (opened 2026-09-25)

The Evidence reading class for [`reference/reviewer-checks.md`](../reference/reviewer-checks.md) (ADR-0050): read by no skill at runtime and excluded from the loaded-corpus measure. The rules stay in the reference file; what they rest on lives here, one pointer sentence left behind.

## Check 5 — why a merge-tree result is read by its exit status

### The defect

Every copy of the sibling-prediction recipe (the reference's Check 5, the packaged driver's Reviewer brief, the landed-sibling paragraph) used to say that a conflict marker in the `git merge-tree` output marks a conflict, and that its absence marks a clean prediction. The two-argument form `git merge-tree <branch1> <branch2>` runs in `--write-tree` mode, and in that mode the markers never reach stdout: they go into the tree the command writes, whose id is the first line it prints. On a conflict the command exits 1 and prints the conflicted-file stages plus `CONFLICT (…)` messages. A Reviewer who scanned stdout for markers therefore recorded every real conflict as predicted-clean.

### The documented contract

From `git help merge-tree` (git 2.54.0, the version installed where this was measured). The four passages quoted below read the same on git-scm.com/docs/git-merge-tree, which documents git 2.52.0; both were read on 2026-09-25.

- **Modes:** "This command has a modern `--write-tree` mode and a deprecated `--trivial-merge` mode." The two-argument synopsis is the `--write-tree` one; only the deprecated form takes three arguments.
- **Output, conflicted merge:** `<OID of toplevel tree>`, `<Conflicted file info>`, `<Informational messages>`. Of the tree: "If there were conflicts, then files within this tree may have embedded conflict markers."
- **Exit status:** "For a successful, non-conflicted merge, the exit status is 0. When the merge has conflicts, the exit status is 1. If the merge is not able to complete (or start) due to some kind of error, the exit status is something other than 0 or 1 (and the output is unspecified)."
- **Messages:** the non-`-z` informational messages are "non-stable strings that should not be parsed by scripts, and are just meant for human consumption". That is why the rule has a Reviewer *read* the `CONFLICT (` lines to name the files, not parse them as the verdict: the verdict is the exit status.

### The measurement (2026-09-25, git 2.54.0, throwaway repository)

Two branches editing the same line of `a.txt`, a third editing only `b.txt`, a fourth left at the base commit:

| Case | Exit | stdout |
|---|---|---|
| conflict (same line, both sides) | 1 | the tree id, three stage lines for `a.txt`, a blank line, `Auto-merging a.txt`, `CONFLICT (content): Merge conflict in a.txt` — **no marker line** |
| clean (disjoint files) | 0 | one line: the tree id |
| at-anchor (second side still at the base) | 0 | one line: the tree id — the same shape as clean, which is why the `at-anchor` rule compares tips before reading the result |
| unresolvable ref (`refs/review/sib/nope`) | **1** | nothing; stderr `merge-tree: refs/review/sib/nope - not something we can merge` |
| a tree instead of a commit | **1** | nothing; stderr `… expected commit type, but the object dereferences to tree type` |
| unrelated histories | 128 | nothing; stderr `fatal: refusing to merge unrelated histories` |
| one argument only | 129 | the usage text |

`git cat-file -p <tree>:a.txt` on the conflict case's printed tree shows the markers (`<<<<<<< left`, the separator, `>>>>>>> right`) — they exist, in the written tree, exactly where the documentation says, and nowhere in stdout.

**Two findings the rule is built on.** First, the conflict signal is the exit status, with the files named by the `CONFLICT (` lines. Second, **exit 1 is not only a conflict**: an argument that does not resolve to a commit also exits 1 (measured above; the documentation's "something other than 0 or 1" does not hold for it). So an exit 1 that prints no `CONFLICT (` line is an error and the sibling is not covered. In the recipe both refs are confirmed by `rev-parse` before the merge-tree runs, so this should not arise there; the rule still says what to do if it does.

Pinned against real git by `tools/wave/src/merge-tree-conflict-signal.spec.ts`; the wording in all four copies is pinned by the merge-tree exit-status block of `tools/wave/src/skill-schema-drift.spec.ts`.

### Live occurrences

In the wave that rewrote the sibling prediction (2026-09-23), the round-1 Reviewer of the sibling-prediction row probed a known conflict and saw no markers on stdout and exit 1. Even with an explicit hint in their brief, the Reviewers of rounds 2, 3 and 5 still judged the merge-tree clean because they saw a single tree hash and no `<<<<<<<` on stdout; only the round-6 Reviewer checked the exit status. The prediction stays advisory, so no verdict was wrong, but every predicted-clean in the recipe's history before this correction rests on the stdout-marker criterion.
