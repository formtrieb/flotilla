# Issue-closing work lands only through a reviewed wave row

An unregulated de-facto lane existed: the Coordinator lands retro PRs and ADR PRs directly — no Worker, no Reviewer — while every wave row runs the full pipeline. With thematic disclosure bundles now first-class (ADR-0027 Amendment 2026-07-31), the obvious extension was "let mechanical doc-only bundles land Coordinator-direct too." Decided against — and the existing practice is formalized on a different axis than the obvious one.

## Decision

The boundary is **provenance, not file class**, and the test is binary:

> **Does the PR close a tracker issue?** Yes → it lands through a wave row with a Reviewer verdict. No → Coordinator-direct is permitted.

- **Coordinator-direct stays legitimate exclusively for session-authored orchestration artifacts** — retros, ADRs, glossary/CHARTER updates, config housekeeping. These have no independent verdict *because the content is the running session's own judgment output*, produced with the human in the loop; there is nothing for a Reviewer to re-derive. They close no issue and tick no AC.
- **Anything that closes a tracker issue gets a Reviewer verdict — no exceptions by file type.** The verdict is the AC ground truth (ADR-0004); a direct lane for issue-closing work would create the first issue class without ground truth, and "doc-only" as a boundary creeps ("it's just a one-liner in a skill…"). For doc-only changes CI is no content check at all — vitest/tsc pass trivially — so the Reviewer is the *only* verification such a PR gets.
- **The cheap lane for bundle-class rows is the foreground row, not a review waiver:** the Coordinator implements the change itself (`foreground` worker — ADR-0012 vocabulary, precedent since Wave 24), Worker cost drops to zero, and a Reviewer is dispatched anyway — at standard tier for a `mechanical` row (ADR-0007 Amendment 2026-07-31), so the verdict now costs the cheap-model price. Pipeline invariants intact, most of the saving realized.
- **The consumer-facing convention is written fail-closed:** stated as the prohibition ("issue-closing work never lands without a verdict; only non-issue-bound session artifacts may go direct"), not as a permission list — a consumer who half-reads the rule reads the safe half.

## Considered Options

- **Coordinator-direct lane for mechanical doc-only bundles** (rejected) — the file-class boundary erodes, and it breaks ADR-0004 exactly where CI provides zero cover.
- **Leave the practice unregulated** (rejected) — a named-but-unenforced boundary is the failure class ADR-0027 documented; the precedent was real and deserved its line.
- **Full ceremony (dispatch a Worker) for bundle rows** (rejected as a mandate) — permitted but wasteful; the foreground lane keeps the verdict while cutting the dominant cost.

## Consequences

- `wave-shared` gains a numbered convention carrying the fail-closed phrasing (number assigned at filing time — same-number-collision rule).
- No engine, schema, or spine change. The rule is tracker-agnostic by construction: "closes a tracker issue" reads identically for GitHub (`Closes #N`), Linear, and MarkdownFs.
- flotilla's own grill/retro practice is unaffected and now explicitly licensed: this very ADR lands Coordinator-direct — it closes no issue.
