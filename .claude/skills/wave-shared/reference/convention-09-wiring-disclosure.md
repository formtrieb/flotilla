## Convention 9 — wiring-disclosure (a new verb/interface names its consumer, or discloses the gap)

A Worker that introduces a new verb, subcommand, or exported interface can pass every gate — spec-covered, tests green — while the consuming flow never calls it, because the call site lives in a file outside the slice's declared Files globs. There is no structural way to catch "is this new symbol actually invoked" at the schema boundary, so the fix is a brief-level disclosure requirement, not an engine check: a slice introducing a new verb, subcommand, or exported interface must, in its `WorkerReport`, either

- name the consuming call-site(s) that now invoke it, or
- explicitly disclose under `judgmentCalls` — mirrored in `reviewerFocusItems` so the Reviewer inherits the same flag — that the wiring lies outside the declared Files globs, so the Coordinator can grant a scope extension or plan the wiring before the review round.

The clause itself lives in `workerBrief()`'s policy-clauses list (`.claude/skills/wave-start/reference/workflow-driver.md`) — the text a Worker actually receives; this section documents the convention it encodes.

A disclosure raised under this convention does not stop at the brief: `wave-start` captures it into the spine's `## Disclosures` section at verdict-routing, source-neutral, and it must reach a disposition other than `open` before the wave archives ([ADR-0027](../../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md)).

### Live occurrences (evidence)

Two consecutive cap=1 re-dispatches were caused by exactly this class, each caught only at review and each costing a full iteration-2 round (history: `../evidence/convention-09-wiring-disclosure.md`, read via the sibling-path read when actually wanted, ADR-0040).
