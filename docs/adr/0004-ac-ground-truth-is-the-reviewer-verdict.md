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
