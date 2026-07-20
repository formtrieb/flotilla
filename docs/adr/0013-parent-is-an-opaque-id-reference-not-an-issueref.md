# Parent is an opaque PRD-id reference, not a structured IssueRef

A slice's `parent` backlink to its source **PRD** is the PRD's **opaque id string** (`CreateInput.parent`, `AnnotatePatch.parent`, `IssueView.parent` are all `string`), **not** an `IssueRef`. This corrects ADR-0011, which modelled `parent` as an `IssueRef` by mirroring `blockedBy` — a mirror that breaks: a markdown PRD's id is the non-numeric sentinel `<slug>#prd`, and `IssueRef.issue` is a `number`, so a markdown PRD is **not representable** as an `IssueRef`. The derivation ADR-0011 promised ("identical across stores") was therefore impossible on MarkdownFs.

## Why

`parent` and `blockedBy` look alike but are different relationships, and the difference is exactly the type:

- **`blockedBy` points at a wave issue** — the `blocked-by-chain` gate must *resolve* it (does the blocker exist? is it done?), so it needs the structured `{slug?, issue}` form.
- **`parent` points at a document** — it needs only the PRD's **identity**, and an issue's identity is, per ADR-0001, its **opaque id**, which the engine never parses. Modelling `parent` as a string is simply honouring ADR-0001 one field further: don't decompose an id you only need to carry and compare.

This is the architecturally cheap break: the PRD issue still exists and is fully usable; only the *backlink* is a looser, identity-only reference rather than a resolvable structured one — which is all a "consumed" signal needs.

The string makes everything uniform and simpler:

- **Cross-store:** `"<slug>#prd"` (markdown) and `"412"` (github) are both just the id `publishDocument` printed. No `NaN`, no special case.
- **`consumed` derivation is exact string equality:** an issue references a PRD iff `issue.parent === prd.id`. No ref-shape matching.
- **`parse-ref` stays clean:** `parent` no longer flows through the id→IssueRef inversion seam, so that seam only ever inverts **wave-issue** ids (always numeric) for the `blockedBy` two-pass. The `#prd` case it could not represent simply never reaches it.
- **GitHub cross-reference is preserved:** the GitHub adapter renders the stored id as `**Parent:** #412` (the `#` lights up the forward cross-reference on the PRD) and strips the `#` back to the opaque `"412"` on read — an adapter rendering detail, not a contract concern. MarkdownFs writes the id verbatim (its ids legitimately contain `#` as a separator).

## Considered Options

- **`parent: string` — the opaque PRD id** (chosen) — uniform, ADR-0001-honest, collapses the `#prd` problem and removes `parent` from `parse-ref`.
- **`parent: IssueRef`, give markdown PRDs a numeric id** (rejected) — collides with the `issues/` numbering space and undoes ADR-0011's deliberate choice to keep the PRD out of `issues/` (so `listOpen` never scans it).
- **`parent: IssueRef`, widen `IssueRef.issue` to `number | string`** (rejected) — large blast radius (`refToString`, the ref regex, `blocked-by-chain`) and it pollutes a type that is otherwise cleanly numeric, to carry a single sentinel.
- **`parent` on GitHub only; MarkdownFs derives consumed folder-based** (rejected) — contradicts ADR-0011 ("read from the explicit field, **not inferred from the folder path**") and breaks the cross-store uniformity that is the whole point.

## Consequences

- **Contract:** `CreateInput.parent`, `AnnotatePatch.parent`, `IssueView.parent`, and `HeaderBlock.parent` become `string`. `IssueRef` is unchanged — it remains the type of `blockedBy` / `unblocks`, which genuinely need structured resolution.
- **Adapters:** MarkdownFs writes/reads the `**Parent:**` line verbatim; GitHub renders `#<id>` and strips it on read. `refToString` reverts to module-private in both codecs (it was briefly exported for the IssueRef-parent annotate path in the prior commit; `parent` no longer uses it).
- **Skills:** `to-issues` sets `parent` to the captured PRD id **string** — no `{slug?, issue}` construction, and (notably) **no `parse-ref` call for the parent**; `parse-ref` is for `blockedBy` ids only.
- **Supersedes** ADR-0011's "`parent` is an `IssueRef` (same mechanics as `blockedBy`)" wording. ADR-0011's substance (a PRD is a document; consumed is derived from backlinks, never written; `parent` belongs in both create and decorate) stands.
