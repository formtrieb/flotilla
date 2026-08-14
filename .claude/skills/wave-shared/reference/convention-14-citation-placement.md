## Convention 14 — citation placement: operational text carries the *why*, citations live in provenance positions

**flotilla's skills are an agent-executed protocol, not a manual.** That cuts two ways at once, and mistaking either half for the whole produces a different defect:

- **The *why* behind a hard rule is load-bearing.** An executing agent that meets an unexplained invariant does not obey it — it *improves* it. Stripping rationale out of instruction text is not tightening; it is removing the only thing standing between a rule and an agent's good intentions.
- **The *evidence* behind that why is not load-bearing at the point of instruction.** Which wave, which finding id, which retro slug, which date — none of it changes what the executing agent does next. Piled into the instruction paragraph it does one measurable thing: it makes shipped skill prose read as somebody's internal diary to a plugin consumer who was never in the room.

**So the fix is a placement discipline, not a purge.** Nothing gets deleted. The rule keeps its one-line *why* exactly where the reader meets the rule; the citation that backs the *why* moves one position over.

### The rule

1. **Operational instruction text names the rule plus its one-line why, in place.** Not the history of the why — the why itself, compressed to the sentence an executing agent needs in order to not route around the rule.
2. **The evidence citation sits in a provenance position.** Three of them, in ascending weight:
   - **a compact trailing pointer** — a parenthetical at the edge of the sentence it backs: `(ADR-0022)`, `(live: W5-F1, docs/retros/2026-07-19-hardening-w5.md)`, `(ADR-0023, Convention 7)`;
   - **a provenance block** — a section that exists to hold evidence, named as such: `### Live occurrences (evidence)`, `### Provenance`, `### Background`, `### References`;
   - **a reference file** — the whole discussion lifted out of the SKILL.md body entirely, which is where a multi-paragraph evidence argument belongs.
3. **Never as a narrative paragraph inside an instruction.** A paragraph that walks through which wave hit this, what the Worker did, what the Reviewer said, and what the retro concluded is provenance wearing an instruction's clothes. It goes in a provenance block or a reference file, and the instruction keeps a pointer to it.
4. **SKILL.md bodies carry judgment and rules; deep provenance lives in reference files.** That is the same split the loader already assumes: `SKILL.md` is what a reader must hold to act, `reference/` is what they read when they want to know why it is that way. Convention 14 only makes the split explicit for citations.

### What counts as a provenance position (the guarded half)

The guard (`tools/wave/src/skill-reference-guard.spec.ts`) enforces the **placement** half of this rule over SKILL.md bodies, because placement is the part a machine can see. A citation — an `ADR-NNNN` token, a `docs/adr/…` or `docs/retros/…` path, or a retro finding id like `W5-F1` / `DA-F3` — passes when it sits in one of:

- **a parenthetical** `( … )` on its line — the compact-trailing-pointer form;
- **a section under a provenance heading** — the heading text names provenance, evidence, live occurrences, background, references, see-also, or history;
- **a fenced code block** — a command or a sample naming a path is not narrative prose.

Anything else is a citation in bare running prose, and the guard calls it a violation.

**What the guard cannot judge, and you must:** whether a parenthetical is genuinely *compact*. `(ADR-0022)` is a pointer; a three-sentence parenthetical recounting a wave is a narrative paragraph that happens to be wrapped in brackets, and it satisfies the guard while defeating the convention. Placement is checked; compression is yours.

### Worked example

```md
✗ narrative citation inside an instruction
   Record a held row as `parked`, never `abandoned`. In wave 26 a Coordinator
   recorded a row it intended to re-plan as `abandoned`; the claim stuck on the
   board and the next planner never saw the row, which is the live-gate defect
   ADR-0022 was written to close after the W26-F1 finding.

✓ rule + one-line why in place, citation as a trailing pointer
   Record a held row as `parked`, never `abandoned` — `abandoned` means *never*,
   so it lies to the next planner and leaves the claim stuck on the board
   (ADR-0022).
```

The executing agent loses nothing: it still learns the rule, and still learns why obeying it matters. What moved is the part that only a maintainer reading backwards needs.

### The legacy allowlist shrinks opportunistically — there is no mass-rewrite pass

The guard seeds the SKILL.md bodies that were already in violation when this convention landed into a **named legacy allowlist**, one entry per file, each carrying its own one-line justification and the occurrence count measured at seeding. Two properties make that a ratchet rather than a hole:

- **an allowlisted file may shrink, never grow** — the seeded count is a ceiling, so a new violation lands red even in a file that already had some;
- **an entry that reaches zero must be deleted** — the guard fails on an allowlist entry whose file is clean, so the list cannot outlive its reason.

Clean a file up when you are already editing it for another reason, drop its entry in the same diff, and the list gets shorter on its own. A dedicated rewrite wave for prose placement would buy a conflict against every open row declaring those files, for a defect that costs nothing while it sits.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader reads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so a `Convention 14` citation resolves for every back-half skill with zero loader edits (ADR-0028).
- **The guard predicate** in `tools/wave/src/skill-reference-guard.spec.ts` — the machine-checkable half, alongside the three reference-resolution classes that spec already owns (ADR-0031).
- **`wave-shared/SKILL.md`** — the number-allocation register and one Common-Mistakes bullet, so a reader who never opens `reference/` still meets the rule.

### Common Mistakes

- **Reading this as "strip the why out of skill prose."** The opposite. The one-line why stays in place; only the evidence pointer moves. A rule with no why is a rule an agent will try to improve.
- **Wrapping a narrative paragraph in parentheses and calling it a pointer.** It satisfies the guard and defeats the convention. If it takes a paragraph, it belongs in a provenance block or a reference file.
- **Deleting a citation instead of relocating it.** The rename/deletion protection those bare paths buy is real (ADR-0031) — a deleted citation is a lost audit trail, not a tidied one.
- **Opening a mass-rewrite pass over the legacy allowlist.** It conflicts with every open row declaring those files. Clean up opportunistically and drop the entry in the same diff.
- **Adding a new violation to an already-allowlisted file because "it's already on the list."** The seeded count is a ceiling; growth fails the guard.

### Live occurrences (evidence)

The grill session behind ADR-0032 settled this convention's shape, and a same-date seeding measurement over the 12 shipped SKILL.md bodies is the load-bearing figure `CITATION_PLACEMENT_LEGACY`'s seeded ceilings sum to (history: `../evidence/convention-14-citation-placement.md`, read via the sibling-path read when actually wanted, ADR-0040).
