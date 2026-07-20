# Amend is a minimal authored-content facet — a re-scope composes amend + annotate

W4-F5 (wave `2026-07-16-hardening-w4`): FOR-23's Worker correctly disclosed a deferral belonging to the already-open FOR-20, and no sanctioned path existed to record it — the Coordinator re-scoped FOR-20 via **raw Linear GraphQL**, bypassing the very seam flotilla is built around. FOR-33 filed the gap as "IssueStore has no update verb". The grill's first result was a **reframe**: that premise was too broad. `annotate` already *surgically replaces* the modeled `Files`/`Acceptance criteria` lists, upserts `Parent`, and appends free-prose sections — on all three adapters, through `body-codec`'s `replaceSection`/`upsertLine`; `applyTriage` already posts (disclaimer-prepended) comments; the whole-body primitives `setBody`/`setDescription` exist on both seams. What had **no path at all** was exactly two things: the **title** (no `setTitle` on any seam), and **replacing an existing free-prose section** (`appendBodySections` only appends — a same-heading write duplicates the section, and `sectionBody` reads the first, silently shadowing the new content).

## Decision

A new `IssueStore` verb **`amend(id, patch)`** with `AmendPatch = { title?, sections? }` — and nothing else:

- **`sections` is upsert-by-heading**: an existing free `## <heading>` section's content is replaced, an absent one is appended; a heading colliding with the codec's `RESERVED_SECTIONS` (`Files`, `Blocked by`, `Unblocks`, `Acceptance criteria`) **throws**, pointing the caller at `annotate`. New codec helper `upsertSection`, sibling of `replaceSection`.
- **No `files`, `acceptanceCriteria`, `blockedBy`, `risk`, `worker` in the patch.** Every modeled surface keeps its single owner: the wave Header-Block → `annotate` (decorate, ADR-0010), triage state + comments → the Triage facet (ADR-0015), claims → the ledger (ADR-0002). FOR-33's AC-clobber requirement is thereby met **structurally** — `amend` cannot touch acceptance criteria because the field does not exist — while the `to-issues` decorate rule ("never supply `acceptanceCriteria`") continues to govern the one verb that can.
- **A full re-scope is the composition `amend` + `annotate`, deliberately two calls** — new title + prose through `amend`, new Files/ACs through `annotate` under its existing loud rule.
- Seams: `GitHubApi.setTitle` + `LinearApi.setTitle` (grain parity with `setBody`/`setDescription`). MarkdownFs replaces only the title part of the `# NN — Title` H1; the `NN — ` prefix and the **filename stay** (the slug is cosmetic per CONTEXT, never a key — id opacity, ADR-0001, holds).
- CLI: `issue-store amend <id> --patch <json-file>` — the whole patch validated **before** any write (the `applyTriage` no-partial-application discipline); an empty patch is a usage error; exit 0/1/2 mirroring the other issue-store verbs.
- Concurrency: read-modify-write on GitHub/Linear stays **last-writer-wins** — the same accepted class as `annotate` today; documented, not solved.

## Considered Options

- **Minimal `amend` facet** (chosen) — closes exactly the verb-less gap; intent stays sharp; the clobber question dissolves structurally.
- **Widen `annotate`** (rejected) — merges the decorate intent ("add the wave fields it *lacks*") with the amend intent ("change authored content"); flipping `bodySections` from append to upsert silently changes semantics under every existing caller; and the decorate rule plus the amend policy would hang on one verb.
- **A full re-scope verb** (rejected) — two owners for Files/ACs, the AC protection degrades from structural to a flag, and it opens `blockedBy` writing that `AnnotatePatch` deliberately keeps out.
- **Whole-body replace** (rejected) — the clobber machine; the exact reason the surgical section toolkit exists.
- **A neutral comment verb** (out of scope) — the Triage facet owns comments; a wave-neutral comment path is its own earn-its-place ticket.

## Consequences

- **`public-API-change`**: the interface, all three adapters, both fakes, and the conformance suite move together (the ADR-0020 bar — zero suite-shape concessions to any single adapter). New conformance cases: title round-trip via `readTriage().title`; section upsert with unmodeled header fields **and** Files annotations surviving a MarkdownFs round-trip (the issue's sharpest test) and the Header-Block still parsing.
- The **Document facet** would take the identical `{title?, sections?}` shape (`amendDocument`) — checked and **deferred**: `LinearApi` has no document-update method and no trigger has surfaced (earn-its-place).
- `wave-shared` documents the sanctioned path — a Worker *discloses* in its report, the Coordinator *amends*; never raw GraphQL, never a tracker CLI (the exact W4-F5 failure).
- Section **deletion** is not in v1 — the idiom is replacing with a supersession note.
- Build: FOR-33. Spec preserved in the private archive.
