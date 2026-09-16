# The wave-shared barrel splits into self-registering reference files; the driver template deliberately does not

By 2026-07-28 the dominant planning constraint was a 7-row clique: `#81 · #116 · #120 · #123 · #125 · #129 · #138` all declare `.claude/skills/wave-shared/SKILL.md` (seven of seven — the single file that makes the clique a clique; `wave-close/SKILL.md` sits in four, `workflow-driver.md` in three), so at most one could ride any wave — seven close ceremonies for seven small fixes, more expensive than the work itself. The barrel is not accidental: `wave-shared` is *designed* as the one place the back half reads conventions, and most of these issues add or sharpen one. The fix is to make the file layout match the concern layout, so the conflict-map's file-level granularity stops serializing independent concerns.

## Decision

- **`wave-shared/SKILL.md` becomes a thin, stable loader.** Each Convention lives in its own file under `wave-shared/reference/`; `SKILL.md` instructs the reader to load **every file in that directory** — deliberately no enumerated index, because an index line per convention would re-create the disease in miniature (every add = a one-line conflict on the shared file). A new convention is a new file: zero touches to existing files.
- **The inlined schema copies stay in `SKILL.md`** at their fence anchors — `skill-schema-drift.spec.ts` extracts them from that exact path, and they are the stable, engine-pinned part of the file. Conventions keep their numbers, so sibling skills' "Convention N" references stay valid.
- **Staged, by measured leverage:** `wave-shared` first (7/7, biggest lever per effort — the clique falls from 7 minimum waves to ~4). `wave-close/SKILL.md` second (4/7): phase *content* moves to reference files, the rarely-touched phase *sequence* stays in `SKILL.md`. **`workflow-driver.md` deliberately not now** — it is the file every plugin consumer copies verbatim (DA-F1), so a split changes the consumer copy surface and forces resyncs; revisit after the `engine.command` configurability from #122 has proven itself on the next companion run.
- **The split slice lands first, alone.** It naturally conflicts with all seven clique rows, so it is a single-row wave ahead of them; afterwards the seven get a cheap `to-issues` decorate pass re-pointing their Files at the new per-concern targets. The ADR-0027/ADR-0004-amendment build slices are filed only after the split lands, targeting the new layout instead of the barrel.

## Considered Options

- **Index with per-add line appends** (rejected) — same split, but `SKILL.md` enumerates the references; every convention add is again a shared-file conflict, merely smaller.
- **Section-aware conflict map** (rejected) — an engine remodel with a new drift definition, solving with machinery what a file layout solves for free; `files-drift`'s file-level guarantee stays simple. *(2026-09-16 amendment: that guarantee is held at runtime by the Reviewer's own diff-against-declared-globs check, run by hand — `files-drift` computes the identical arithmetic but is invoked by no skill, agent definition, or driver; issue #754.)*
- **Serial single-row waves, no split** (rejected) — buys seven close ceremonies now and leaves every future convention change in the same trap.

## Consequences

- Sibling skills that quote a convention's *location* (rather than its number) need their references swept once in the split slice.
- The seven clique issues' Files lists are stale after the split until re-decorated — re-decoration is part of the plan, not an afterthought.
- `wave-close`'s split (stage 2) repeats the same pattern and inherits this ADR; the remaining known overlap after both stages is `#81 ∩ #129` on `wave-start/SKILL.md` (~2 minimum waves for the current backlog). *(Corrected by the 2026-07-28 amendment below: this prediction missed the `close-mechanics.md` residual.)*

## Amendment (2026-07-28) — stage 3: the mechanics file folds into the phase files it duplicates

**The stage-2 Consequence under-predicted the residual.** The re-decorated conflict map measured a four-issue group on `wave-close/reference/close-mechanics.md` where this ADR predicted only `#81 ∩ #129` would remain. The cause is structural, not accidental co-location: `close-mechanics.md`'s "worked sequence" is itself phase-numbered (banner comments `1 … 6`, `4a`, `4b`) and **duplicates the phase files' content under a second roof** — the stage-2 split moved each phase's body (worked commands included) into `phase-N-*.md` while the walkthrough restated the same guidance per phase. Live-proven twice in one night: one issue had to declare three files for one sandbox-prose concern (phase-3 + phase-4a + the mechanics duplicate), and a Convention-9 disclosure hit the same stale dry-run note on both roofs.

### Decision

- **Fold, don't split further.** Each phase-numbered segment of the worked sequence (including the `--auto` 4b walkthrough) moves into its phase file and **merges with the near-duplicate prose already there** — a merge, not an append; no passage may state the same guidance twice within a file.
- **A slim `close-mechanics.md` remains, same filename** (inbound links from Convention 7 and resume-mechanics keep resolving), holding only the genuinely cross-phase material: the `{{wave-cli}}` resolution, the Commands table, the **exit-code tables (deliberately central** — verbs like `worktree-cleanup` run in two phases; per-phase code fragments would re-create the duplication this fold removes**)**, the `ClosingState` / `NeedsAttentionPayload` shapes, and the Disclaimer. The ADR-0016 advisory-write-back note is phase-4-specific and moves to `phase-4-advisory-merge-order.md`.
- **The fold follows the split.** A mechanics file folds **only** where its skill's phase content already lives in per-phase reference files — today that is `wave-close` alone. `start-mechanics`, `create-mechanics`, `resume-mechanics`, and `plan-mechanics` stay whole until their skills are ever split by the same measured-leverage rule; `workflow-driver.md` stays deliberately unsplit (consumer copy surface, DA-F1 — unchanged).
- **Landing constraint, same as stages 1–2:** the fold slice conflicts with every open issue declaring `close-mechanics.md` by design; it lands first, alone, in a single-row wave; afterwards the remaining pair (`#123`, `#158`) gets a `to-issues` decorate pass. The stale-prose sweep issue shrinks to its Convention-8 half; the two known pre-fix claims inside wave-close docs (the `host-pr create`-is-staged claim, the dry-run-preview-gap note — each present on both roofs) become explicit ACs of the fold slice, resolved in the same pass that merges the passages.

### Considered Options

- **Per-phase mechanics files** (`mechanics-4a.md`, …) (rejected) — kills the clique but doubles the file count and keeps every duplicate alive.
- **Accept the serialization** (rejected) — keeps the double-maintenance: every phase-content issue declares two files, and the stale-prose class (two roofs drifting apart) recurs indefinitely.

## Amendment (2026-09-16) — the phase directory leaves the load-everything pattern; `evidence/` is per skill

Stage 2 gave `wave-close` the same loader line as `wave-shared` — "load every file in that directory, not a subset picked by name" — on the same ground: a "phase N" citation should resolve without an index. Measured in the #714 / FOR-370 grill ([ADR-0050](0050-the-loaded-corpus-is-a-pinned-measure-and-a-rules-enforcement-tier-decides-its-reading-class.md)): the phase directory is 181 KB and its largest file (`phase-3-worktree-cleanup.md`, 65 KB) is the fastest-growing file in the corpus, read whole at every close; nothing outside `wave-close` cites a phase except by pointer (wave-resume's link to phase 3, the engine's stderr naming phase 6); and the six steps in `wave-close/SKILL.md` do not name their phase files at all — the mapping runs on the number alone.

- **The load-everything pattern stays where it buys citation resolution for a *rule set* — `wave-shared/reference/`, the standing load.** It leaves `wave-close/reference/`: phases run in sequence, each phase's file is needed exactly at its step, so each step names its file (step load, ADR-0050) and `close-mechanics.md` — the cross-phase exit-code tables and commands — is named once in step 1. A forward citation to phase 6 from phase 3 resolves when phase 6 is reached; the counter-plus-one-liner register this ADR rejected an index for is a `wave-shared` device and was never needed for phases.
- **`evidence/` generalizes from "a convention's history" to "a skill's history."** The sibling `reference/` never reaches (the 2026-08-13 loader amendment) may now sit beside any skill's `reference/` — `wave-start/evidence/`, `wave-close/evidence/`, `wave-setup/evidence/` first — reached by the same sibling-path read (ADR-0040), and it is the only destination a mechanics walk-back may use.

The split decision, the stable-loader rule for `wave-shared/SKILL.md`, and the deliberately-unsplit driver reference are unchanged.
