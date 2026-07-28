# AC-verification ground-truth is the schema-validated reviewer verdict, not the tracker checklist

The authoritative answer to "are this issue's acceptance criteria met?" is the **reviewer's schema-validated `acVerification[]`** (per-AC `{ ac, met ∈ {met, partial, not-met}, evidence }`, a required field already in the Ur's `reviewer-verdict-schema`), **not** the issue body's `- [ ]`/`- [x]` checklist. This keeps the anti-fabrication guarantee exactly where CHARTER §3 puts it — in the schema-enforced subagent return — and survives the move to GitHub, where the issue body is a remote artifact a worker's `/tmp` worktree cannot edit.

## Why

The Ur had two AC anti-fabrication signals: **(1)** worker-side `countTickedAcs(committed issue file) == claimedAcCount` (gate-runner Check 4), and **(2)** the reviewer's schema-validated `acVerification[]`. On GitHub only **(1)** breaks (no issue file in the worktree; the committed diff carries no `- [x]`); **(2)** is intact and is in fact the stronger signal — an *independent* reviewer that must produce per-AC evidence beats a self-ticking worker.

## Decision

- **AC-count gate is re-based** from `countTickedAcs(markdown) == claimedAcCount` to **"`acVerification` covers the declared ACs 1:1"**: every `IssueView.acceptanceCriteria` entry has exactly one verification row, the counts match, no invented rows, and each `met` carries evidence. This cross-checks **two independent sources** — the declared ACs (issue body, `to-issues`' artifact) against the verified ACs (the reviewer's return) — preserving the anti-fabrication property.
- **Adapter-agnostic + engine-decoupling:** the re-based gate consumes the typed reviewer return for *both* `MarkdownFsStore` and `GitHubIssuesStore`, removing the engine's markdown-file re-parse (aligns with ADR-0001's format-blind engine). The worker self-tick becomes a MarkdownFs-only cosmetic detail, not an engine gate.
- **`close(id, prUrl, ackedACs[])`** — `ackedACs[]` is produced by the **reviewer** (the `met` rows), at verdict-in.
- **`IssueView.acceptanceCriteria[].checked` read from a tracker is cosmetic/human-facing**; the engine never consumes it for the gate. At `close`, flotilla *does* tick the GitHub body (`gh issue edit`) for human visibility — a deliberate cosmetic nicety, not load-bearing.
- **GitHub worker-brief terminator re-authored:** terminate = commit + push + `gh pr create` with `Closes #N`. The Ur ceremony (tick ACs, flip Status, write Closed-by, `git mv` to `done/`, two-commit close) is deleted from the GitHub brief.

## Considered Options

- **Reviewer-verdict `acVerification[]` as ground-truth** (chosen).
- **`gh issue edit --body` tick + `read()` re-parse as ground-truth** (rejected as the *authority*) — re-introduces a remote side-effect with its own ordering/resume failure mode and is no stronger than the Ur's worktree tick; kept only as the cosmetic close step.

## Consequences

- Touches three separately-phased modules: P3 (`close` AC post-condition), P6 (the gate source), P7 (the worker brief). The P2–P3 adapter-conformance suite asserts `close`'s AC post-condition (`ackedACs[]` = reviewer-`met` set).

## Amendment 2026-07-28 — `met` on an outcome-phrased AC requires outcome-exercising evidence

Live occurrence (#142 AC1 → #150): the AC read *"a worktree … **is removable** by the engine"*; the Reviewer verified — truthfully, with exact lines and a pre-fix red run — that `planCleanup` *selects* the worktree, and marked `met`. No evidence ever removed a worktree and asserted the directory gone; the missing `--force` sat exactly in the unexercised half, and the live gate caught it minutes after merge (`erroredStillListed: 5`, byte-identical to pre-fix). The verdict was ground-truth and wrong: every cited fact true, the claimed outcome nonexistent. The fix raises the evidence bar for `met`; the verdict stays the ground truth.

- **The per-AC vocabulary is four-valued:** `met · partial · not-met · deferred` (`AC_STATUS_VALUES` gained `deferred` before this amendment; this text now matches the schema). Only an unambiguous `met` earns the cosmetic tick (`metAcIndexes`).
- **An AC phrased as an outcome is `met` only on evidence that exercises the outcome** — a slice test, or the Reviewer's own probe, that *performs* the thing and asserts the result. Evidence confined to the layer the diff touched cannot carry `met`, however precise.
- **The Reviewer holds a probe license:** it stays code-read-only, but it may execute temp-scoped experiments to exercise an outcome itself (precedent: the FOR-120 Reviewer's independent control experiment). A failing probe is `not-met` — under this rule, #142 AC1 is caught in iteration 1 (scratch worktree + deleted file + engine removal → fails without `--force`), not at the live gate.
- **An outcome unreachable from the review environment** (merge-gated, prod-gated, human-gated) is `deferred` — or `partial` when parts of the criterion are exercised — with the unexercised outcome named in `evidence` and mirrored in `reviewerFocusItems`. That mirror makes it a **Disclosure** ([ADR-0027](0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md)): captured at routing, dispositioned before archive (`dropped: <exercised live at close, green>` for the common case; `filed:<id>` on a red live probe).
- **No schema, driver, or engine change** — the rule is Reviewer-contract prose (`wave-reviewer` skill + the reviewer brief).

Rejected alternative: qualifying outcome-ACs down at slicing time so layer evidence suffices. The AC was *right* — the live gate caught #150 only because the AC promised the outcome; weakening the promise makes the same wrong verdict formally correct and hides the failure entirely.
