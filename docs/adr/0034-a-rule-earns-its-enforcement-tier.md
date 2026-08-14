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

## Amendment 2026-08-13 — Promotion pays its prose back: the residual form and the diff-twin rule

The original decision governs the way up and is silent on what happens to the prose when a rule arrives at a structural tier. The observed pattern is one-directional growth: promotions *add* a guard and leave the full prose standing as "defense-in-depth," so the system pays rent *and* mortgage — the same session that measured a coordination day logged wave-setup at ~25k words and wave-shared's per-wave load at 17 files with monotonically growing occurrence catalogues. This amendment adds the demotion half.

- **The residual form.** When a rule is promoted to a structural tier, its prose shrinks **in the same diff** to exactly three elements: the rule in one sentence, its one-line why, and a pointer to the enforcing structure ("enforced by `<spec/hook>`"). Everything the structure now enforces or carries leaves the instruction path — derivations, step-by-step guidance, occurrence catalogues — relocating to provenance positions in or beside the enforcing artifact (Convention 14's move-never-delete, applied one tier up).
- **Defense-in-depth is the residual form, not an exemption from it.** The echo-guard precedent ("sits on top of the anchors, never instead") stays true — as the sentence, not the paragraph. A promoted rule's prose never disappears entirely: the one-sentence form is what keeps an agent explainable-to when the structure blocks it.
- **The diff-twin rule.** A promotion PR contains the prose walk-back in the same diff and names the word-count delta of the affected prose (before → after). A promotion landing without its walk-back is a *silent* doctrine violation — exactly the occurrence class this ADR's own trigger escalates on recurrence; the counting channels are the wave-close coordination-misfires line (#506) and, once sliced, the retro station (PRD #124). Structural enforcement of the ritual itself is deliberately **not** bought now — it is earned the same way everything else on this ladder is.
- **The backlog: opportunistic by default, two named exceptions.** Already-promoted-but-unshrunk prose shrinks opportunistically — clean a file when touching it for another reason, same diff, the Convention-14 legacy pattern. Exactly two standing-cost outliers get dedicated rows instead, planned after the currently-filed batches land, each recording its before/after word measure: the wave-setup corpus (read by every setup) and wave-shared's occurrence catalogues (loaded by every wave; target: a sibling position outside the always-loaded `reference/` set, reachable via the ADR-0040 sibling-path read when the history is actually wanted).

**Considered and rejected:** a full-corpus diet sweep (the Convention-14 verdict — conflicts with every open row — with one correction: this class *does* cost while it sits, rent per session, which is precisely why the two named outlier rows exist); a never-grow word-count ratchet per skill file (legitimate growth exists — the Convention-16 clause rollout adds text to 13 files by design; word count is too coarse a proxy for "promoted prose not walked back"); absolute word budgets per file (arbitrary, instantly violated, a mass rewrite through the back door).

## Amendment 2026-08-14 — The top rung is two rungs: a schema boundary constrains an author, an engine check inspects an artefact

The ladder's top row reads `engine refusal / schema boundary` as one rung, on the shared ground that both cost ≈ 0 at runtime. Rent is the same; the failure surface is not, and the difference only shows up on **conditional** rules. Measured this session against the live `agent({ schema })` boundary while grilling #556 (three probes, positive and negative controls in every run):

- A root-level `anyOf`/`oneOf`/`allOf` is **rejected** — `400 tools.N.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`, reproducing W5-F1 verbatim.
- A root-level **`if`/`then` is accepted, and it is genuinely enforced** — including the conditional half correctly: the `then` branch fires only on the matching antecedent, and a non-matching outcome is exempt as written. The long-standing claim that a schema-root conditional is unavailable at this boundary is true of `anyOf` and **false of `if`**.
- `minLength: 1` and `pattern` are **enforced** too. So the shipped `minLength: 1` promises on `issue` / `branch` / `tests` / `lint` / `commitShas.items` are real, not decorative.
- **And every one of those constraints was satisfied by a degenerate value.** Cornered on content, the agent bought `minLength: 1` with `"none"` and `pattern: ^https://` with the bare string `"https://"`. Cornered on a *conditional* — told to report a finishing outcome it had no URL for — it did not invent a URL and did not fail: it **changed the antecedent**, reporting `blocked` instead of `done`.

That last move is the whole amendment. **A schema constraint is applied to an author at composition time; an engine check is applied to a finished artefact.** An author under an unsatisfiable constraint always has somewhere to go, and on a conditional rule `A ⇒ B` the antecedent `A` is *itself a field the author controls* — so the cheapest escape from "B is required" is to stop being in case A. An engine check has no one under pressure and nothing to trade away: the artefact either has the property or is reported.

- **The rung splits.** `engine refusal` and `schema boundary` are separate rungs at the same rent. Both remain above every prose tier; between them, **`engine refusal` outranks `schema boundary` for any rule whose condition references a field the constrained agent also authors.**
- **Schema boundary keeps its rung for unconditional shape.** Types, enums, `required`, `minLength`, `additionalProperties: false` on fields the author has no motive to falsify — that is what the boundary is for, it is measurably enforced, and nothing here argues for moving it. The distinction bites only where a constraint's *condition* is authored by the party being constrained.
- **A schema guarantees shape, never truth.** `required` buys presence; `minLength` buys non-emptiness; `pattern` buys a prefix. None of them buys a fact. A promotion that converts "the field is missing" into "the field is present and wrong" has moved a loud failure to a quiet one and is a **regression dressed as a promotion** — the promoting diff must name which of the two it is buying.
- **The correction this owes the corpus.** Six sites currently state, as settled fact, that a schema-root conditional is impossible at this boundary and name `anyOf`/`if` together: `.claude/agents/wave-reviewer.md`, `.claude/skills/wave-shared/SKILL.md`, `.claude/skills/wave-reviewer/SKILL.md`, `.claude/skills/wave-reviewer/reference/reviewer-checks.md`, `.claude/skills/wave-start/reference/workflow-driver.md`, and [ADR-0030](0030-deferred-core-path-requires-documented-form-comparison.md). The factual half is wrong for `if` and must be corrected — but the *conclusions* those sites reach all stand, and the correction must carry this rung split as their new reason. `documentedFormComparison` stays flat and optional; the driver copy stays free of a root conditional. They are no longer "the boundary won't take it" — they are "the boundary would take it, and an authored conditional is the wrong rung for it."

**Considered and rejected:** keeping one rung with a footnote (the merged row is what sent #556's grill at the boundary for three probes before the engine gate was even looked at — the caveat has to be structural in the ladder, not marginal to it); banning root conditionals outright (over-broad — a conditional whose antecedent is *not* author-controlled, e.g. keyed on a Coordinator-filled constant, has no escape and is a legitimate boundary constraint); demoting `schema boundary` below `drift-spec` (wrong axis — a drift-spec pins a literal's text, a boundary constrains a runtime value; neither substitutes for the other).
