# Issue labels are the consumer's; wave-lifecycle labels are flotilla's product; coupled by a configured eligibility OR-set

There are two label worlds with one narrow coupling.

- **Issue-side labels are the consumer's.** Triage roles, categories, and any custom labels a PRD-split produces are owned and configured by the consumer (e.g. via the Matt-Pocock `/setup-matt-pocock-skills` canonical-role → label-string mapping). flotilla imposes **no** issue taxonomy.
- **Wave-side labels are flotilla's fixed product.** The wave lifecycle and its `wave/*` claim ledger — `queued → in-flight → in-review → done` (+ `needs-attention`) — are flotilla's design and the value it ships. They are not consumer-configurable in the way issue labels are.
- **The only coupling is a configured eligibility OR-set.** `wave.config` declares a set of issue labels; an issue is **wave-eligible iff it carries at least one** of them (OR semantics). The consumer chooses the set freely — `{ready-for-agent}` (the wiki pilot's default), `{ready-for-agent, ready-for-human}`, a custom `{ready-for-neo}`, anything. flotilla treats these labels as **opaque membership tokens** and never interprets their meaning.

## Consequences

- `transition(id, coarse)` writes **only `wave/*`** labels; the wave skills (wave-create/start/close) drive it. **Triage never calls it** — it manages issue-side labels in its own dimension. The earlier "triage drives the coarse-state transitions" framing was a category error and is removed.
- **`available` is not a written label.** It is the condition "wave-eligible and not yet claimed" (carries a configured eligibility label, no `wave/*` label). The ledger's first write is `queued`. `available` stays only as informal shorthand and as the conceptual entry point of the coarse vocabulary.
- **No eligibility field on `IssueView`.** `listOpen(scope='wave-ready')` evaluates the OR-set over tracker labels inside the adapter; the engine only ever sees eligible issues carrying a `wave/*` status.
- The eligibility OR-set lives on the same config surface as the rest of the binding (`wave-setup` / `wave.config`), reusing the consumer's existing role→label mapping where one is present.

## Considered Options

- **Configured eligibility OR-set, opaque labels** (chosen).
- **Hard-code `ready-for-agent` as the single eligibility marker** (rejected) — different consumers and PRD-splits produce different taxonomies; the gate must be declared, not wired.
- **flotilla owns the issue taxonomy** (rejected) — couples flotilla to one tracker's label conventions and duplicates the triage skill's setup mapping.
