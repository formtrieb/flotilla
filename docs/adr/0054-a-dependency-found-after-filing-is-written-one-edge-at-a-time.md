---
status: accepted
---

# A dependency found after filing is written one edge at a time, by its own verb

`Blocked by` could be written exactly once: at `create`. `annotate`, the owner of every other Header-Block field, keeps it out of its patch ("dependency structure is out-of-band"). `amend` refuses the heading and points at `annotate`, which refuses it too. But a dependency is usually discovered after both issues exist, while a second row is being sharpened. A dependency stated only in prose leaves `read()` reporting none, so no gate holds the dependent row: not the blocked-by pair check at plan and create time, and not the hold at dispatch. We decided that a dependency found after filing gets its own additive verb pair, `issue-store block` / `unblock`. It is not a field on `annotate`, because a dependency is an edge that arrives on its own, not a list authored as a whole. In the same grill we decided the parallel question for `Files`: `annotate` gains an additive `filesAdd`.

## What was measured

Grilled 2026-09-25 from issue #622, together with input 2 of #707 (the Files boundary grill), against the issue-store verbs, the body codec and the three stores.

- **`read()`, `listOpen` and `listClaimed` already take the union** of the body codec's `Blocked by` refs and the tracker's native blocked-by edges, on GitHub and on Linear (ADR-0020 took the read side on day one, because consumers already keep their dependencies as native relations). A native edge drawn by hand in the tracker is therefore already honoured by every gate. Live: `#992 blocked by #991`, drawn natively on 2026-09-25, made `dor` report `blocked-by-chain-resolves` as failing until #991 closes.
- **The native mirror only ever adds.** `create` and `annotate` add native edges best-effort, and a refused mirror call is swallowed. Nothing deletes a native edge. So a "replace" of the body list could never take effect on GitHub or Linear: the surviving native edge would be merged back in on the next read.
- **Nothing detects a cycle** today: not the readiness gates, not the cross-wave check, not the goal frontier. A cycle was unreachable through the engine, because every edge was drawn at birth towards an issue that already existed. It is reachable by hand through the tracker UI.
- **`annotate`'s `files` replaces the list.** Widening a row by one file means reading the list, appending and writing it all back. One stale read silently drops an entry, and a dropped entry blinds the Conflict-Map to that file.

## Decision

1. **`issue-store block <id> --by <ref>` adds exactly one dependency edge. `issue-store unblock <id> --by <ref>` removes exactly one.** Both go through the configured store, so the verbs stay tracker-agnostic. `annotate` keeps its patch free of `blockedBy`. `amend`'s refusal for the `Blocked by` heading points at `block`, and for the other reserved headings it keeps pointing at `annotate`.
2. **`block` writes the way `create` does.** The body's `Blocked by` section is the authoritative record, and it gains the ref. On a host with native edges the edge is mirrored best-effort, exactly as today. On MarkdownFs the required `**Blocked by:**` header line carries it. Adding a ref that is already present is a no-op that succeeds.
3. **`unblock` is honest.** It removes the ref from the body and deletes the native edge where the host has one; this is the mirror's first delete path. It then reads the issue back. If the union read still reports the ref, for example because the host refused the native delete or the edge sits somewhere the store cannot reach, `unblock` exits 1 and names where the ref still comes from. It never reports "removed" for a dependency every gate will still see.
4. **`block` refuses to close a cycle.** Before writing, it follows the blocker chain from the ref being added, through the store's reads. If the chain reaches the issue being blocked, it exits 1 and prints the cycle. If a read along the chain fails, the check cannot decide: it abstains with a warning and writes (ADR-0052). A cycle drawn past the verb, by hand in the tracker, is caught where rows are drawn: the blocked-by pair check at wave-plan and wave-create reports it as a cycle, naming every issue in it, instead of leaving both rows held with no reason given.
5. **`annotate` gains `filesAdd`.** It appends the given paths or globs to the Files list, drops duplicates and keeps the existing order. `files` keeps replacing, which is the path for decorating and for a deliberate narrowing. Supplying both in one patch is a usage error. Files stay with `annotate`: they are a list the planner authors, not edges between issues.

## Considered Options

- **A `blockedBy` field on `annotate`** (rejected). It would be consistent with "annotate owns the Header-Block", but `annotate` replaces the lists it writes, and on GitHub and Linear a replace is an illusion while native edges outlive the body. It would also turn a surgical decorate patch into the place where cycles and native deletes have to be handled.
- **Sanction the native tracker edge as the only post-filing writer** (rejected). It needs no engine code and works today. But only the Operator can draw it, because skills never write to a tracker directly. MarkdownFs has no native edge, and nothing would check for cycles.
- **Native-only writes where the host has edges** (rejected). The body and the tracker would disagree about the list, and the body would stop being the authoritative record `create` makes it.
- **Add-only, no `unblock`** (rejected). A wrongly drawn edge could never be withdrawn through the engine.
- **Detect cycles only at planning time** (rejected as the sole check). The error would surface only when someone plans a wave, far from the write that caused it. It stays as the second net for edges drawn by hand.
- **A receipt that lists what a Files replace dropped** (rejected as the fix). It protects only the reader who reads the receipt. Widening by one file should not need a replace at all.

## Consequences

- `block`, `unblock` and `filesAdd` are additions to the public surface: a minor release, with the verbs in the Catalog.
- The skills that currently say `blockedBy` is out-of-band, and point a post-filing dependency at a hand-drawn edge or at nothing, name `block` instead: to-issues' filing mechanics and the triage flow. A wave that discovers a dependency at close records it with `block` when it files the follow-up.
- The rest of #707 is not decided here: whether a Coordinator commit after the verdict is allowed at all, what recomputes the Conflict-Map, `files-drift`, and Gate 6. It stays a separate, smaller grill.
