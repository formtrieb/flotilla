# The spine stays repo-local markdown, not tracker-native

The `WAVE.md` orchestration spine (frontmatter, plan-table, conflict-map, dispatch-log, PR-log — the engine's 10 fine states) stays **repo-local, git-versioned markdown** for *all* consumers, tracker-agnostic by design. It rides the wave branch as a branch-local archive and does not merge to `main` (ADR-0005). It is durable — which is what makes resume possible (ADR-0002, where the spine is the authority).

## Why

The spine is transient coordinator scaffolding with a bespoke grammar (footnotes, conflict-lists, a 10-state plan-table) that no tracker models natively. Keeping it local makes it (a) tracker-agnostic — the same `SpineStore`/`SpineSchema` serves GitHub, MarkdownFs, and a future Linear consumer unchanged; (b) durable and synchronously writable — the write-ahead-log discipline of ADR-0002 needs a local commit, not a remote API round-trip per tick; (c) free of a remote dependency on the resume path.

## Considered Options

- **Repo-local markdown** (chosen).
- **Spine in GitHub Projects** (rejected) — couples orchestration to a UI surface that varies wildly across trackers, has no representation for the bespoke footnote/conflict grammar, and would tie resume (a hard M1 requirement) to a remote, rate-limited, tracker-specific API. The *coarse* projection already gives humans tracker-native visibility (ADR-0002/0003); the spine does not need to live there too.

## Consequences

- `wave-md-rw` becomes the shared `SpineStore`; section names + column indices lift to a `SpineSchema` config, the bespoke grammar stays inside the markdown impl, and the engine only ever sees the parsed object.
- The two-scope split (ADR-0002) is exactly this: fine engine-state in the local spine, a coarse projection to the tracker.
