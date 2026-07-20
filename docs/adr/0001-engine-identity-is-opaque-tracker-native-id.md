# Engine issue-identity is the opaque tracker-native identifier

`IssueView.id` is whatever the tracker's primary human-visible identifier is — `"412"` (GitHub issue number), `"ENG-123"` (Linear identifier, *not* its UUID), `"<slug>#NN"` (MarkdownFs) — returned by `IssueStore.create(view) → id`, and the engine treats it as a **fully opaque string**: it never parses it, orders it numerically, or assumes a format. We chose this over a flotilla-minted stable id (a UUID or `<slug>-<uuid>` owned by `to-issues`) because the coarse-state projection's whole purpose is shared visibility *in the tracker's own terms* — an internal id invisible in the GitHub/Linear UI would undercut that, force a `floID → trackerID` map that is a new resume-drift source, and would *not* avoid two-pass create anyway (native blocked-by relations require the target to exist first regardless).

## Considered Options

- **Tracker-native opaque id** (chosen) — direct `read(id)`, human-visible, no extra mapping layer.
- **flotilla-minted composite/UUID** (rejected) — uniform format across trackers, but double identity (internal vs tracker-shown), an extra durable map to maintain and reconcile on resume, and no saving on ordered creation.

## Consequences

- The engine must be made **format-blind**: the Ur's modules that mint ids by parsing filesystem paths (`merge-order.ts`, `conflict-map.ts`, `dor-gate.ts` Gate 5 `checkBlockedByChain`) must take path-free signatures fed by `IssueView[]` / `IssueStore`, not `issuePaths` / `readdirSync`. This is added to the M1-PRD §2a keystone lift list.
- The **2-digit `NN` assumption** for branch (`wave-orch/<NN>-<slug>`) and sidecar (`reports/<NN>-<iter>.md`) names is dropped; names derive from `sanitize(id)` + the cosmetic `slug` from the spine row.
- The **merge-order tiebreak** must key on `fileCount` (+ a stable secondary such as tracker `createdAt` or spine row-order), **not** `id`-as-ordinal — tracker ids are not wave-local monotonic.
- **`create()` is two-pass**: blockers are created first and a plan-local-id → real-id map is threaded through a dependency-ordered publish loop so intra-batch `blockedBy` resolves to assigned ids.
- The **spine** durably stores `IssueView.id` as the plan-table row key; all loaders join `spine → IssueStore.read(id)` rather than `readFileSync`.
- The adapter MAY keep an immutable low-level handle (Linear UUID, GitHub node-id) privately for API calls; it is never the canonical `IssueView.id`.
- **Opacity extends to the skill layer via an `issue-store parse-ref <id> → IssueRef` seam (M1).** The engine staying format-blind is not enough: the `to-issues` two-pass currently has the *skill* convert a captured opaque id into the `IssueRef` shape `blockedBy`/`parent` need (markdown `<slug>#NN` → `{slug, issue}`, github `NN` → `{issue}`) — i.e. the skill parses the id, the exact id-surgery this ADR forbids the engine, leaked one layer up. The store that **minted** the id owns its format, so it owns the inverse: `parseRef(id) → IssueRef`. The skill calls the CLI seam and hard-codes **no** id shape, so opacity holds end-to-end. The earlier "deferred until a third store with a new id format" framing under-sold this — the coupling is already live at two stores in M1 (markdown self-check + github wave), so the seam is M1 scope, not a future-store concern.
