# The wave-shared barrel splits into self-registering reference files; the driver template deliberately does not

By 2026-07-28 the dominant planning constraint was a 7-row clique: `#81 · #116 · #120 · #123 · #125 · #129 · #138` all declare `.claude/skills/wave-shared/SKILL.md` (seven of seven — the single file that makes the clique a clique; `wave-close/SKILL.md` sits in four, `workflow-driver.md` in three), so at most one could ride any wave — seven close ceremonies for seven small fixes, more expensive than the work itself. The barrel is not accidental: `wave-shared` is *designed* as the one place the back half reads conventions, and most of these issues add or sharpen one. The fix is to make the file layout match the concern layout, so the conflict-map's file-level granularity stops serializing independent concerns.

## Decision

- **`wave-shared/SKILL.md` becomes a thin, stable loader.** Each Convention lives in its own file under `wave-shared/reference/`; `SKILL.md` instructs the reader to load **every file in that directory** — deliberately no enumerated index, because an index line per convention would re-create the disease in miniature (every add = a one-line conflict on the shared file). A new convention is a new file: zero touches to existing files.
- **The inlined schema copies stay in `SKILL.md`** at their fence anchors — `skill-schema-drift.spec.ts` extracts them from that exact path, and they are the stable, engine-pinned part of the file. Conventions keep their numbers, so sibling skills' "Convention N" references stay valid.
- **Staged, by measured leverage:** `wave-shared` first (7/7, biggest lever per effort — the clique falls from 7 minimum waves to ~4). `wave-close/SKILL.md` second (4/7): phase *content* moves to reference files, the rarely-touched phase *sequence* stays in `SKILL.md`. **`workflow-driver.md` deliberately not now** — it is the file every plugin consumer copies verbatim (DA-F1), so a split changes the consumer copy surface and forces resyncs; revisit after the `engine.command` configurability from #122 has proven itself on the next companion run.
- **The split slice lands first, alone.** It naturally conflicts with all seven clique rows, so it is a single-row wave ahead of them; afterwards the seven get a cheap `to-issues` decorate pass re-pointing their Files at the new per-concern targets. The ADR-0027/ADR-0004-amendment build slices are filed only after the split lands, targeting the new layout instead of the barrel.

## Considered Options

- **Index with per-add line appends** (rejected) — same split, but `SKILL.md` enumerates the references; every convention add is again a shared-file conflict, merely smaller.
- **Section-aware conflict map** (rejected) — an engine remodel with a new drift definition, solving with machinery what a file layout solves for free; `files-drift`'s file-level guarantee stays simple.
- **Serial single-row waves, no split** (rejected) — buys seven close ceremonies now and leaves every future convention change in the same trap.

## Consequences

- Sibling skills that quote a convention's *location* (rather than its number) need their references swept once in the split slice.
- The seven clique issues' Files lists are stale after the split until re-decorated — re-decoration is part of the plan, not an afterthought.
- `wave-close`'s split (stage 2) repeats the same pattern and inherits this ADR; the remaining known overlap after both stages is `#81 ∩ #129` on `wave-start/SKILL.md` (~2 minimum waves for the current backlog).
