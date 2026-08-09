# A rule earns its enforcement tier: prose is draft mode, structure is production mode

Every doctrine clause is enforced somewhere, and every enforcement rung has a token price that somebody pays on every use: an ADR pointer in a brief is re-read by every dispatched agent, a reference doc by every session. The repeated maintainer question "our ADR/doc references are tokens too, consumed at every read" turned out to have a measurable shape — and the repo's own history shows rules drifting up the ladder only after failing in prose, with no stated trigger for when that move is owed. This ADR names the ladder, the promotion trigger, and the measurement duty.

## Decision

**The ladder — Enforcement Tiers ordered by rent per use:**

| Enforcement Tier | Rent |
|---|---|
| engine refusal / schema boundary | ≈ 0 (runs, is never read) |
| drift-spec / test | ≈ 0 (runs, is never read) |
| hook / config / settings-deny | ≈ 0 |
| brief prose | per agent per dispatch (~6–8k fixed text per Worker brief) |
| reference doc | per session (~100k+ on a heavy day) |

ADRs themselves are the cheapest text: planning-time reading, never runtime freight. The expensive front is brief prose — and on the installed form the consumer pays it, on their bill.

- **Prose is a rule's draft mode, structure its production mode — tokens are the rent a rule pays until it earns structure.** A rule is born as prose legitimately; keeping it there is a budget decision, not a default.
- **The trigger governs Promotion, not birth.** A new rule whose failure mode is already known-silent at occurrence one and whose mechanical form is cheap may be born structural, skipping the draft mode — waiting for a second silent failure to license a check the engine can already run is trigger-worship, not budgeting.
- **The Promotion trigger is failure-mode-gated, not count-gated:** a rule whose violation fails **silently** (plausible wrong result, no-op with a success echo) becomes a Promotion candidate at its **second live occurrence** — the second occurrence is the proof that prose does not hold it. A **loudly**-failing rule may stay prose until recurrence is chronic, because loud failures self-correct in-session. This matches the record: every rule that actually got promoted (#372 → config/profile, #376 → drift-spec) failed silently first; the one that recurred six times unpromoted (Convention 12 on the Coordinator surface, ten silent no-ops behind a false success echo) is the overdue case this trigger exists to catch.
- **Occurrences are counted from Disclosures — the spine archive is the ledger.** No new bookkeeping: a live occurrence that never became a Disclosure was not captured, and that is a capture gap, not a counting gap.
- **The measurement duty lives at the retro station.** When PRD #124 is sliced, the retro carries a per-wave field naming which doctrine clauses had Disclosure-referenced occurrences. Until then, aggregation across waves is hand-work over the archived spines — acceptable, because the trigger needs ordinal evidence (first vs second occurrence), not statistics. Zero-occurrence clauses over many waves are the demotion/cut candidates; finding them is the same aggregation read the other way.
- **This is placement, not austerity.** One averted bad wave (~500k tokens; premise-currency catching two dead ACs) pays a full day's doctrine rent. The doctrine budget optimizes *where* a rule is enforced, never *whether* correctness is enforced — a cut is legitimate only for a clause the measurement shows idle, not for one that merely reads expensive.

## Considered Options

- **A fixed occurrence count regardless of failure mode** (rejected) — promotes loud rules prose holds fine, and waits one occurrence too long on silent ones; the failure mode is the load-bearing variable in every observed case.
- **Measure first, decide triggers later** (rejected) — the data source (Disclosures) already exists and the known-overdue case is already at occurrence six; deferring the trigger re-defers exactly the decision this session was convened to take.
- **Keep the ladder as session memory, unwritten** (rejected) — the next session re-derives the tier question from scratch, and the individual promotion decisions taken today lose their common rationale.

## Consequences

- `CONTEXT.md` gains **Enforcement Tier** and **Promotion** under a new Doctrine group, plus the flagged ambiguity resolving "tier": unqualified = model tier (ADR-0007/0012), the doctrine concept is always written out as Enforcement Tier.
- The open tier questions on the doctrine agenda (#371 Coordinator-lane gates, #407 reviewer-contract clauses, and successors) are decided *by applying this trigger*, and their resolutions cite this ADR rather than re-arguing the frame.
- PRD #124's slicing inherits the per-wave clause-occurrence retro field as a requirement.
- No engine, schema, or spine change. This ADR closes no issue and lands Coordinator-direct (ADR-0033).
