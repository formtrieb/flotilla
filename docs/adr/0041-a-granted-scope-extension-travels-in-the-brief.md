# A granted scope extension travels in the brief — and every recompose re-fetches the spec

A Coordinator can widen a row's declared Files mid-wave: the Worker discloses a forced out-of-glob touch (Convention 9), the Coordinator grants it — a Disclosure reaching the `scope-extension` disposition, an `annotate` widening the tracker header. But the briefs both agent roles work from embed the spec *by value* (the embedded-spec design: a worktree carries tracked files only, so a tracker id may be unresolvable there), and a row object is sealed at fan-out. Observed live (wave `2026-08-13-consumer-boundary-a`, row 499, both review rounds): the tracker carried the grant, the recomposed round-2 briefs still carried the pre-grant spec, and the Reviewer — correctly reading only its embedded spec — flagged a granted, in-scope file as an overrun in *both* rounds. Both halves behaved correctly and still disagreed; the Reviewer had to re-derive, twice, a decision already made. Filed as #516.

## Decision

**Two remedies, one seam.**

1. **Every recompose re-fetches, unconditionally.** Whenever a row's brief is composed again — a re-dispatch iteration, a resume's re-dispatch — the Coordinator re-reads the issue through the store and re-embeds the spec. No condition, no memory: a conditional rule ("re-fetch if you annotated") hangs on exactly the remembering whose failure is the observed gap, and is blind to third-party tracker writes. This is the tracker-currency sibling of the driver's compose-currency gate: the script copy has a staleness rule; the spec copy now has the same one, one level down.
2. **A granted scope extension travels as data in the next round's briefs.** The row gains an optional structured field — per grant: the granted paths, the stated reason, the granting iteration, the Disclosure ref — composed as a projection of the spine's `scope-extension` disclosures for that row (the spine stays the durable record; the field is never a second source of truth). It renders as its own section in **both** briefs.
3. **A grant is purpose-bound and row-scoped.** It sanctions the stated forcing reason at the granted paths for the row's remaining rounds — never a blanket pass for the file. The Worker treats the paths as sanctioned scope for that purpose, with no fresh disclosure round; the Reviewer stops flagging them as overruns and stops re-deriving the forcing, and instead verifies the change at the granted paths *against the stated reason*. Re-fetch alone cannot carry this: after (1) the widened globs are already in the spec, but a widened glob never conveys that a decision was made, by whom, or what it is bound to.
4. **The same-round boundary is by design.** Row objects are sealed at fan-out, so a grant spoken at routing time reaches the *next* compose, never the round in flight. That round's Reviewer re-derives the forcing and reports with an honest caveat — the live occurrence shows this fallback working, and it stays documented as correct behavior, not a defect.

No engine change and no return-schema change: the agent-boundary schemas (WorkerReport / ReviewerVerdict) are untouched, so the byte-identical drift guards and the plugin/engine lockstep are not in play. The whole decision lives in the driver document and the dispatch mechanics — skill tier, one reviewed wave row.

## Considered Options

- **Reviewer re-resolves the tracker at review time** (rejected) — reintroduces the dependency the embedded-spec design deliberately removed: the store config that resolves a tracker id may be gitignored and absent from a review worktree. The design is load-bearing; the fix must not undo it.
- **Runtime injection into sealed rows** (rejected) — having agent briefs read the spine at run time breaks fan-out sealing and the tracked-files-only worktree contract, an architecture rebuild for a case whose fallback (honest-caveat re-derivation) demonstrably works.
- **Conditional re-fetch** (rejected) — see Decision 1; the condition *is* the failure mode.
- **Riding the grant in `reviewerHints`** (rejected) — advisory freeform that never reaches the Worker, competes with ordinary hints for weight, and makes nothing mechanically checkable: the Reviewer's files-drift reasoning needs paths as data.

## Consequences

- One wave row (#516) lands both remedies: the recompose-re-fetch rule beside the compose-currency gate it mirrors, the grant field and its two brief sections in the driver document, the same-round boundary stated where the rule lives. The driver's excluded-with-reason list gains the new optional field (array-valued, like `reviewerHints`).
- The Reviewer's verdict semantics for granted paths change from "flag and caveat" to "verify against the stated reason" — the audit moves from re-derivation to confirmation.
- Cross-wave conflict reasoning is already correct and unchanged: the `annotate` at grant time widens the tracker header, which is what sibling waves' conflict maps read.
- This ADR lands Coordinator-direct (ADR-0033: it closes no issue); the implementation goes through #516's reviewed wave row.
