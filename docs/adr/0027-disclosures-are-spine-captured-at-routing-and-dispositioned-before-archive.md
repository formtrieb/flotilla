# Disclosures are spine-captured at routing and dispositioned before archive

Convention 9/10 make agents *disclose* gaps (a shipped capability whose call site lies outside the slice's declared Files, a surviving runtime resource), and the detection demonstrably works — on 2026-07-27 seven wiring gaps were disclosed by their Workers and confirmed by their Reviewers. What did not exist was anything that turns a detected gap into a durable artifact: whether a disclosure became a follow-up depended on a human's memory at the end of the day, and one of the seven (Gate 8 shipped inert — `runDor`/`runDorById` never thread the verify config) was still unfiled when this was decided. The knowledge exists at verdict-routing and evaporated before close. Decision: capture at routing, enforce at archive — existence mechanically, quality humanly.

## Decision

- **The Spine gains a Disclosures section.** At verdict-routing (`wave-start` step 7) the Coordinator captures every disclosure as a spine entry — source-neutral: Worker prose (Convention 9/10 `judgmentCalls`), Reviewer verdict, or the Coordinator's own observation land identically. Written through paired engine verbs (`spine add-disclosure` / `spine set-disposition`, printer paired with parser — the ADR-0016 principle); never hand-formatted, never grep-parsed.
- **Dispositions:** `open` (default at capture) → `resolved-in-slice · scope-extension · filed:<id> · dropped:<reason>`. Deliberately the row-disposition vocabulary (park, abandon): a scripted, human-decided exit — never automatic.
- **`wave-close` gains a fail-closed checked step before Archive:** an engine check lists `open` disclosures; any hit blocks the archive. The gate demands *that* a disposition exists, never judges its quality — `dropped:<reason>` passes, keeping the human override cheap and explicit.
- **`filed:` means a bare issue,** created inline by the Coordinator via `issue-store create` at disposition time: title, gap description, provenance line (wave slug, row id, iteration) — deliberately **without** an Eligibility label. Wave-readiness comes later through `to-issues` decorate-mode, with the next wave's planning context (a wiring-gap follow-up's Files are precisely the call sites outside the old slice — that wants the bias-toward-wider lens, not a 1 a.m. close ceremony). Existence and readiness are separate steps, as the tracker already models (`#112` is deliberately not `ready-for-agent`).
- **The disclosure channel is unchanged.** Convention 9/10 stay brief-level prose (`judgmentCalls` mirrored in `reviewerFocusItems`); no agent-boundary schema change.

## Considered Options

- **Auto-file every disclosure** (rejected) — one of the seven resolved in-slice (a ticket would be noise); disclosures map N:1 onto issues (DA-F5 + DA-F6 → one ticket); and a mechanically-filed issue has no Header-Block quality yet *looks* handled — the inverse failure of "ein Fund ohne Nummer ist nicht abgelegt".
- **Named-but-unenforced Coordinator duty** (rejected) — the status quo that failed seven times in one day; a duty without an enforcement point evaporates exactly when the day was long.
- **Structured `wiringGaps[]` at the agent boundary** (rejected) — capture-from-prose went 7/7; the observed hole is retention + enforcement, not recognition (Convention 9 itself records that this class is not catchable at the schema boundary). The agent-boundary schema is also the surface every plugin consumer copies and must resync (the DA-F1 driver-drift cost), while the spine has zero consumer contact; and covering the Reviewer as a source would have required a second schema change.
- **Skill-side markdown convention, `wave-close` greps** (rejected) — the #141 class: a convention-coupled spine parse-back already broke once and was fixed by routing through the real reader (#146). A counting gate measures via an engine verb's exit code; it does not read prose.
- **Full `to-issues` slicing at close** (rejected) — demands the highest-judgment work at the structurally worst hour, which is the exact failure condition being fixed.

## Consequences

- Engine: Disclosures section in `renderSpine`, the two verbs plus the engine-owned reader, specs for the write→read round-trip and the close-gate check.
- **The bare-file path needs a small engine accommodation:** `issue-store create`'s `CreateInput` requires the full Header-Block (`risk`, `worker`, `files`, `acceptanceCriteria` are mandatory), so a deliberately-undecorated issue cannot be filed through the engine today. Either those fields become optional for a bare create, or the ADR's `filed:` step names the host CLI as the interim path — measured 2026-07-28, decided at build time.
- `wave-start` step 7 gains the capture duty; `wave-close` gains the checked step before Archive; `wave-shared` Conventions 9/10 gain one pointer sentence ("routing captures this into the spine").
- Extends the ADR-0002 WAL doctrine to disclosures: written at the moment of knowledge, enforced at the terminal boundary — a Coordinator death between routing and close loses nothing.
- Amends [ADR-0018](0018-wave-execution-runs-on-a-single-workflow-driver-with-a-shared-skill.md) only on the Coordinator side (routing + close); the driver pipeline and both agent schemas are untouched.
