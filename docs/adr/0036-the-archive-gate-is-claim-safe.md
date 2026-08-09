# The archive gate is claim-safe: an awaiting-human row blocks the archive, fail-closed

The awaiting-human archive gate (`spine check-awaiting-human`, wave-close phase 6) ran structurally from its first wave but carried no ADR, while its structural twin — the disclosure gate — has ADR-0027; row #373 removed a false citation of exactly that ADR from the gate's prose without pre-empting the decision this document now takes. The gate's full rationale meanwhile lived as reference-doc prose, the most expensive Enforcement Tier there is (ADR-0034: read per session), for a why that is planning-time material.

## Decision

**A wave with a human-gated row still at `planned` does not archive. The gate is structural, fail-closed in both directions, and its protected object is the claim ledger — not the finding lifecycle its twin protects.**

- **The hazard is the stranded claim.** An awaiting-human row was never dispatched, so nothing ever released its `queued` claim. Archive past it and the issue reads as *claimed* to every future `wave-plan`, with no live spine left to reconcile against — the claim has to be found and dropped by hand. There is no self-healing path from there, which is what makes the gate fail-closed rather than advisory.
- **The terminality guard structurally cannot cover this.** An awaiting-human row sits at `planned` — neither a running state nor a finalised one — so "no row is `dispatched`/`reviewing`" reads as safe when it is not. A separate predicate (*human-gated ∧ still `planned`*) is required, not a stricter reading of the existing one.
- **Fail-closed in both directions:** an unreadable or unparsable spine blocks exactly like a positive hit — unknown is blocked. Same stance as `check-disclosures`.
- **The parked exemption is load-bearing, not a gap** (ADR-0022): parking releases the claim, which is the entire hazard, so a `parked` row is precisely the shape an archive may proceed past. A gate that fired on it would refuse to archive a wave that had already taken the gate's own prescribed remedy.
- **Two exits, only these two:** the human acts (row dispatches on a later pass) or park + unclaim (row returns to the pool). Neither is a default; the Coordinator picks.

## Considered Options

- **Advisory instead of fail-closed** (rejected) — the downstream state has no self-healing path, and an advisory at archive time is how a hazard gets hand-waved; the disclosure gate's history is the precedent.
- **Fold into the terminality guard** (rejected) — different predicate over a state the guard deliberately treats as neither-running-nor-final; overloading it would hide the claim story that justifies blocking at all.
- **Block on `parked` too** (rejected) — turns the gate's own remedy into a trap; the claim-release at park time is what removes the hazard.

## Consequences

- Phase 6's reference keeps the rule, the two exits, and the parked note — operational content needed at gate-hit time — and cites this ADR for the design rationale instead of restating it (the ADR-0034 tier move: why-freight from the per-session tier to the planning tier).
- The exit-code-gated, fail-closed archive gate is now a named pattern with two instances (disclosures — ADR-0027; claims — this ADR). A third population that must not archive unresolved should take this shape, not a Common-Mistakes line.
- No engine change — the verb already behaves exactly as decided. This ADR closes no issue and lands Coordinator-direct (ADR-0033).
