# The Linear Document facet maps a PRD to a native Linear Document, not an issue-with-a-label

When the Linear adapter is built (M2), the **Document facet** (ADR-0011 — `publishDocument` / `readDocument` / `listDocuments`) maps a PRD to a **native Linear Document**, *not* to a Linear issue carrying a `prd` label. GitHub's adapter labels an issue `prd` ([github-issues-store.ts](../../tools/wave/src/adapters/github/github-issues-store.ts) L217) only because GitHub has no document primitive; Linear has a first-class Document type, so the PRD gets its natural home. The optional richer binding — a wave maps to a Linear **Project** and the PRD-Document hangs off that Project (`projectId`) — is the recommended way to recover the human-visible "this PRD was sliced into these issues" grouping that GitHub gets for free from the `Parent` cross-reference; it is **not** required for the facet to be correct and stays a wave-modelling decision, not a Document-facet one.

## Why

The hard constraint ADR-0011 places on every Document-facet implementation is: a PRD **must never enter `listOpen('wave-ready')`** (the eligibility-pollution this avoids was the original `to-prd` bug). On GitHub that constraint is upheld by *label discipline* — the PRD issue must carry `prd` and **not** the eligibility token, and a human editing labels can break it. On Linear a native Document satisfies the constraint **structurally and for free**: `listOpen` maps to the issue-space (`list_issues`), and a Document is categorically not an issue, so it cannot be drawn into the candidate pool no matter how it is labelled. The safer mapping is also the more faithful one — ADR-0011's own words are "a PRD is a tracker *document*, not an issue," and Linear is the first shipped target where that can be taken literally.

This was **verified against the server pilot's live Linear workspace** (2026-06-19) with a real test document (id `prd-test-a6779f778106`):

- `get_document` and `list_documents` both resolve it; its shape is `{ id (uuid) · slugId · title · content (markdown body) · url · project · initiative · issue · team }`.
- `issue: null`, `project: null`, `initiative: null` — it is a standalone Document attached only to a **team**, confirming it lives outside the issue-space entirely.
- `content` is the markdown body — exactly `DocumentView.body`'s home — so the round-trip needs no overloading of issue fields.

## Considered Options

- **PRD as a native Linear Document** (chosen) — upholds the no-`listOpen` constraint structurally; matches ADR-0011 literally; `content` is a clean body home.
- **PRD as a Linear issue with a `prd` label** (rejected, mirrors GitHub) — works, and keeps the two adapters symmetric, but re-introduces the label-discipline fragility on a tracker that doesn't need it. Note Linear models state as **workflow-state**, not labels (ADR-0015), so even this path would lean on a label purely as a not-an-eligibility-token marker — an unnatural fit.
- **PRD as a Linear Project description / overview** (rejected as the *primary* mapping, retained as an *optional binding*) — a Project is Linear's natural container for "a batch of issues + its planning doc," so a wave ≈ a Project with the PRD-Document attached gives the sliced-from grouping for free. But coupling the Document facet's identity to a Project is more than the facet needs and forces a Project to exist before a PRD can be published. Keep the facet's home a plain Document; let `projectId` be an optional attachment decided by how waves map to Projects.

## Consequences

- **Facet mapping (M2 Linear adapter):** `publishDocument({title, bodySections})` → `save_document` with `content` = the `bodySections` joined as markdown → returns the Document id. `readDocument(id)` → `get_document` → `{ id, title, body: content }`. `listDocuments()` → `list_documents` (filtered by team/workspace) → `DocumentView[]` for `wave-plan`'s PRD panel.
- **Opaque id (ADR-0001/0013):** the id the facet mints is the Document **uuid** (stable); slices reference it verbatim as their `Parent` backlink, and *consumed* derives by exact id match over those backlinks — identical to every other store, because `Parent` is read from the explicit Header-Block field, never inferred.
- **Open point — the forward cross-reference:** GitHub renders "PRD referenced by #N" for free from the `Parent` issue→issue cross-ref. Linear has no automatic Document←Issue back-reference, so the human-visible "this PRD was sliced" signal needs a Linear-specific mechanism. The **wave ≈ Project** binding above is the cleanest answer (slices and PRD share a Project); a mention/link from each slice is the fallback. This is a wave-modelling decision deferred to the M2 Linear adapter build, not settled here.
- **No engine change.** The Document-facet contract ([issue-store.ts](../../tools/wave/src/adapters/issue-store.ts) L118-141) already expresses everything; this ADR only fixes the Linear adapter's *implementation* choice ahead of the M2 build so it isn't re-litigated. GitHub and MarkdownFs are unaffected.

### Amendment — the unbound half: no `project` binding is required, and an unbound listing is TEAM-scoped, never workspace-wide

The M2 build read the "optional Project binding" above as *mandatory*, and the facet ended up locked behind it. As built, `LinearStoreConfig.project` triple-dutied:

1. **candidate-pool filter** — with it set, `listOpen` draws only that project's issues (ADR-0020);
2. **mandatory Document home** — `createDocument` refused to mint a Document without it, throwing a client-side `LinearApiError` before any wire call;
3. **Document-listing filter** — `listDocuments` sent the project predicate when bound, and *no filter at all* otherwise: a workspace-wide listing, not even team-scoped.

Those three do not want the same answer. A consumer whose model is **per-member / per-feature Projects over a team-wide candidate pool** must leave `project` unset for (1), and thereby lost the whole facet to (2) and got a foreign-team-polluted PRD panel from (3). The refusal was **adapter policy, not a platform constraint** — this ADR's own live probe above observed the team-scoped shape natively (`project: null`, `initiative: null`, attached only to a **team**).

So both halves are now defined, and the project binding stays exactly what this ADR said it was — optional:

- **`createDocument`** attaches to the one parent it has: the bound project's `projectId` when a project is bound (unchanged), else `teamId` from the **already-required** `team` config. There is no orphan case in either arm — a team is always known — so the refusal has nothing left to protect.
- **`listDocuments`** is always scoped: the bound project's documents when a project is bound (unchanged), else the configured team's, narrowed **server-side** via `DocumentFilter.team`. The unbound arm pays one catalog round-trip it used to skip; a listing scoped to the wrong thing is not worth saving it.
- **No new config fields.** Both arms read `team`/`project`, which the store config already carries.

Pinned against Linear's own published GraphQL schema (`linear/linear` → `packages/sdk/src/schema.graphql`) and its agent-facing `save_document` contract, both read 2026-08-10: `DocumentCreateInput.teamId: String` exists (doc-string `[Internal] Related team for the document.`), `DocumentFilter.team: NullableTeamFilter` exists with `id: IDComparator`, and `save_document` states the governing rule — on create, "exactly one parent (`project`, `issue`, `initiative`, `cycle`, or `team`) must be specified", `team` being "Attaches the document to the team". A team parent is a first-class Document parent, not a workaround. The `[Internal]` annotation on `teamId` was the one unproven spot at merge time: a docs-visibility marker on a field the public schema publishes and the platform's own document tooling exposes as a parent — but no live `documentCreate` with `teamId` had been run from this repo. **Live-verified 2026-08-10, the same day, from the second external consumer's workspace (unbound engine CLI at 1.2.0):** `documentCreate` carrying `teamId` is accepted and yields a clean team parent — the `[Internal]` annotation is a visibility marker, not a functional reservation. The same live reading exercised the listing filter's falsifying half: a document attached to a project through the Linear UI is structurally absent from the team-filtered listing — no error, no warning, never listed — the deliberately-accepted consequence stated where the facet is taught, now observed rather than derived. Independently corroborated the same day from a second workspace via Linear's own API: project-attached documents there read `Document.team: null`.

### The `PRD: ` title prefix is a CONSUMER convention — marker recognition is deliberately deferred

`to-prd` titles its documents `PRD: <feature title>`. That prefix is a **consumer-side convention for humans reading a list**, not a contract, and no adapter parses it: `listDocuments` returns every Document in scope, and `wave-plan`'s PRD panel is convention-blind. It has to be — nothing structurally distinguishes a PRD Document from any other Document a human wrote in the same team, and the facet's real guarantee is the one this ADR is about (a Document is categorically not an issue, so it can never pollute `listOpen`), which holds whatever the title says.

Adapter-level PRD-marker recognition — a title prefix, an icon, a dedicated Linear label-equivalent — is **deliberately deferred**, not overlooked. Deciding it means deciding what a marker *is* across every store (GitHub has no Document primitive at all and models a PRD as a `prd`-labelled issue), and the unbound-facet fix does not need it: a team-scoped listing over one team's documents is already a usable panel. Revisit it when a consumer's panel is genuinely noisy with non-PRD documents — that is the evidence this decision is waiting on.
