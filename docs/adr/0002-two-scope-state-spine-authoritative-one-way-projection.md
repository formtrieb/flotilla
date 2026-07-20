# Two-scope state: spine+disk is authoritative, the tracker projection is one-way

Issue lifecycle state lives in two scopes with a strict authority order. The **durable spine + on-disk sidecars (worker reports/verdicts) + the live worktree git-state** are the single source of truth; the **coarse tracker projection** (`available → queued → in-flight → in-review → done` +`needs-attention`) is written **one-way, downstream** so humans and concurrent waves can see what is claimed. On resume the tracker is **healed from** the authority (idempotently re-projected), **never read into** it as fine-state truth — the projection is lossy (`report-in`/`reviewing`/`verdict-in` all collapse to `in-flight`), so it physically cannot reconstruct fine state. This generalizes the Ur's `#52` reconciler rule ("disk = source of truth, re-derive the next stop via `transition()`") to flotilla's new remote, independently-failable claim layer.

## Decision detail

- **Spine is a write-ahead log.** Per dispatch: (1) commit the intent (`dispatched` + target branch `wave-orch/<id>`) to the spine, (2) project the `in-flight` label (downstream, retried, non-blocking), (3) create the worktree+branch, (4) spawn the worker. Authority is written *before* the irreversible side-effect.
- **Double-dispatch is prevented by an idempotent worktree/branch guard, not by label ordering.** On resume, for a row the spine says is `planned`/`dispatched`: if the `wave-orch/<id>` worktree/branch exists → **adopt it**, do not re-dispatch; if it does not exist → the spawn never landed → safe to (re)dispatch. This holds at every kill point.
- **Workers are assumed dead on a Coordinator kill.** Resume does not reattach live background agents; it reconstructs from durable artifacts — the worktree's committed work + the sidecar report. Sidecar/report present → treat as `report-in` (disk beats a non-landed spine flip); no report + dirty worktree → re-dispatch into the same worktree. (Live reattach is a purely additive future option, deliberately out of M1.)
- **Resume inputs** are: durable spine + on-disk sidecars + `git worktree list --porcelain` ⋈ spine dispatch-log(branch). The spine dispatch-log stores the branch **and** worktree path; the worktree-root marker (`agentPathMarker`) is pinned in `SpineSchema`/`wave.config`.
- **Dual-write order = spine-commit first, then project the label** (WAL: authority first), with idempotent re-projection healing any drift. A lagging/failed label is benign within one coordinator because `queued` and `in-flight` both read as "claimed" in the cross-wave union.
- **Cross-coordinator atomicity is out of M1** (CHARTER §12): the small-team "one coordinator dispatches at a time" convention holds; atomic compare-and-swap claim is M2.

## Considered Options

- **Spine+disk authoritative, tracker one-way** (chosen).
- **Tracker claim as a co-equal resume input** (rejected) — the projection is lossy and independently failable, so it can neither reconstruct fine state nor be trusted as authority; reading a stale `queued`/`in-flight` label as truth re-dispatches completed work.
- **Tracker-label-first dual-write** (rejected) — only helps if drift is *not* healed on resume; since we heal idempotently, spine-first is the principled WAL ordering.

## Consequences

- ADR-0001's stable `id` is what makes the spine↔disk↔worktree join keyable.
- M1-PRD §2d resume inputs and §2c projection points are rewritten accordingly; the adapter-conformance suite asserts the one-way property (a `read()` after a `transition()` round-trips the coarse value, but fine state is never sourced from the tracker).
