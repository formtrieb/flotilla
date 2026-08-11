# A find is captured where it surfaces — the Disclosure window ends at the archive, not at verdict-routing

ADR-0027 fixed Disclosure capture "at verdict-routing," so a find that surfaced during the close phases had no designed capture point. Three occurrences of that seam accumulated: no find was ever lost, but occurrence-counting lived in the operator's session memory and operating notes — the first two sightings of issue #483's observation were never system-visible, and the third filed post-archive as a standalone. Meanwhile the workaround was proven live (disclosure 479.2 of wave `2026-08-11-adr-0037-and-currency`): a predictable close-visible measurement pre-captured at routing, with the archive gate forcing the measured disposition. This ADR settles the seam.

## Decision

**A find is captured in the spine at the moment it surfaces, for as long as the spine is live — the Disclosure window spans verdict-routing through every close phase and ends hard at the archive.**

- **The failure class is counting outside the system.** The operator's memory discipline is not a mechanism; a consumer without it degrades straight to silent absorption. The remedy feeds the countable machinery that already exists: spine entry → archive gate forces a **Disposition** → `filed:<id>` / `dropped:<reason>` — the sub-ticket occurrence counter is the archived spine's Disclosures table, promoted to the tracker exactly when recurrence earns it (ADR-0027's triviality default, unchanged).
- **Wave-scoped Disclosures become first-class.** The #483 shape — a find about the wave's own machinery (the sweep, a preflight posture, the merge-order tool), owned by no Plan-Table row and no iteration — must fit through the capture verb; today `add-disclosure` validates its `<row-id>` against the Plan-Table and rejects it. The extension is additive on the CLI contract (ADR-0035): the row-scoped form keeps its exact shape, and the exact wave-scoped spelling is slice work, not ADR text.
- **Capture at discovery, backstopped once.** The Coordinator captures the moment a find surfaces in any close phase — the same at-the-moment figure ADR-0027 fixed for verdict-routing. One backstop line ahead of the phase-6 disclosure gate asks for still-uncaptured Coordinator finds. The gate itself is untouched: it forces dispositions of what was captured and can never force capture — you cannot gate what was never recorded, so doctrine is capture's only carrier, deliberately. ADR-0027's existence-mechanical/quality-human split does not extend to a capture-mechanical claim.
- **Both halves of the seam, one doctrine.** A close-visible measurement that is *predictable at routing* is pre-captured then, as a measurement-point Disclosure, so the archive gate forces the measurement itself to happen (the proven 479.2 figure — `dropped:` with measured evidence). The extended window covers what pre-capture cannot: genuinely new finds. The two mechanisms are complementary, not competing.
- **The archive ends the window, hard.** An archived spine is evidence, never a write target again. A find that surfaces post-archive files directly as a bare tracker issue with a provenance line (ADR-0027: existence now, decoration later) — the tracker is that find's countable home, and #483's own filing is the worked example of exactly this path.

## Considered Options

- **Pre-capture only** (rejected as the whole answer) — carries predictable measurements but nothing genuinely new; the seam's third occurrence was a surprise find, not a predicted one.
- **Row-attachment convention** (rejected) — hanging a sweep-find on an arbitrary "affected" row needs no engine change but corrupts row-scoped counting and has no answer for a find with no affected row at all (a phase-2 auth posture, the merge-order tool itself).
- **Direct-file every close find at discovery** (rejected) — puts occurrence-1 finds below the triviality bar on the tracker (the 1:1 filing anti-pattern) or leaves them uncounted; the Disclosures table exists precisely to hold sub-ticket findings countably.
- **Append late finds to archived spines** (rejected) — a second write authority with no gate over it; breaks the archive's evidentiary role.

## Consequences

- Enforcement tiers (ADR-0034): the capture rule lives at reference-doc tier — the wave-close SKILL.md body (the judgment layer), the phase-6 backstop line, and an `add-disclosure` row in close-mechanics' command table; the wave-scoped verb form lives at structural tier (engine + spec). `phase-3-worktree-cleanup.md` is deliberately untouched — the likely #483 remedy lives there, keeping the two slices wave-parallel.
- CONTEXT.md's **Disclosure** entry now names the full window (routing → archive), the measurement-point pre-capture, and the wave-scoped form; it lands with this ADR.
- The engine change (additive wave-scoped `add-disclosure` + spec) and the three wave-close doc edits land through a reviewed wave row (ADR-0033); this ADR plus the glossary land Coordinator-direct (ADR-0036 figure) and close no issue.
