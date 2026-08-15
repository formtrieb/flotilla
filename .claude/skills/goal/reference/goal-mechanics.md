# goal — station mechanics

The engine-CLI plumbing behind the three passes. The skill body owns the **judgment** (what the finish line is, what its frontier contains, what the report means); this file owns the **invocation**. Reach for it once a pass is confirmed.

> **The CLI is the source of truth for shapes.** Every op validates its input on each call and prints its own contract section on a usage error. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; read its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store is selected there — you never name a tracker, and you never write a native container name.

## The container binding — `store.goal.container`

A Goal is realized as one native container role, and the role is read from the consumer's own config at the CLI edge. Four roles are declared:

| Role | Realized by | Notes |
|---|---|---|
| `milestone` | github | the store's **default** — the only native GitHub container with direct issue membership |
| `goal-file` | markdown | the store's **default**; the facet *is* the realization there |
| `project` | linear | must be declared explicitly; the only Linear role that ships |
| `initiative` | nobody yet | declared in the vocabulary and refused **by name**, so the deferral is a named follow-up rather than a silent cap |

**Linear binds no default.** One shipped consumer runs Initiative-as-Epic / Project-as-User-Story while an older decision record once sketched "wave ≈ Linear project", so any built-in assumption collides with a live convention. A goal op against a linear store with nothing declared fails with a typed refusal naming `store.goal.container` — that is the design, not a bug to route around.

```json
{
  "store": {
    "kind": "linear",
    "goal": { "container": "project" }
  }
}
```

Three refusal shapes, each naming the same config key (exit 1, the store threw):

| Refusal | Cause | Fix |
|---|---|---|
| `unbound` | nothing declared, and this store has no default | declare `store.goal.container` |
| `unknown-container` | the declared value is not a role at all (a typo, an invented name) | spell one of the four roles |
| `unrealized-container` | a real role this store does not ship (`initiative` anywhere; `project` on github) | pick a role the store realizes |

A configured binding is authoritative: a malformed declaration fails here rather than being quietly read as unbound and defaulted past.

## Commands

| Call | Purpose |
|---|---|
| `issue-store goal-create --input <f.json>` | mint the container → prints the opaque goal id (text, not JSON) |
| `issue-store goal-read <goalId>` | the `GoalView` → `{ id, title, description, container, memberIds }` (JSON) |
| `issue-store goal-list` | every goal in the bound role → `GoalView[]` (JSON) |
| `issue-store goal-assign <goalId> <issueId>` | join one member by curation; nothing on stdout |
| `issue-store goal-frontier <goalId>` | the derived frontier (JSON) — see [frontier-report.md](frontier-report.md) |
| `issue-store create --input <f.json>` | file one **bare** member → prints the opaque issue id (text, not JSON) |
| `issue-store parse-ref <id>` | invert an opaque id into the reference shape a dependency needs (JSON) |
| any command, no args | usage |

There is deliberately **no** goal-close op and **no** goal-dispatch op. The facet exposes neither, so neither has a runner — sight, never permission. There is no leave/unassign op either: a member leaves by being removed from the container in the tracker.

## Pass 1 — cut

### 1. Mint the container — `CreateGoalInput`

```json
{
  "title": "1.0.0 — the contract freeze",
  "filingHint": "goal-1-0-0",
  "description": "Every public surface is a semver contract and the adoption path is walkable end to end."
}
```

```bash
{{wave-cli}} issue-store goal-create --input <goal.json>   # prints the opaque goal id
```

`filingHint` is store-internal — the markdown store may weave it into the goal file's path-id, GitHub and Linear ignore it entirely. **Capture the printed id; never reconstruct one** from the title or the hint.

### 2. File each member bare — `CreateInput`, bare arm

A bare member carries a title, a filing hint, and its authored prose. It carries **no** planning header and gets **no** eligibility marker, so it cannot be drawn into a wave until `to-issues` decorate-mode sharpens it:

```json
{
  "title": "The credential seam survives a second code host",
  "filingHint": "credential-seam-second-host",
  "bodySections": [
    { "heading": "What this is for", "markdown": "..." },
    { "heading": "Provenance", "markdown": "Cut for the 1.0.0 goal on 2026-08-15; the finish line's own container carries the definition of done." }
  ]
}
```

Rules the CLI enforces before any write, so a rejected input files nothing:

- `bodySections` must be present and non-blank. A bare issue has no planning header to fall back on, so an empty body means the filed issue carries no content at all — that is a usage error (exit 2), not a silently-completed filing.
- A **half-written** planning header — some of `risk` / `worker` / `files` / `acceptanceCriteria` present, some absent — is a usage error naming the missing fields. Absent and broken are different claims; only the first is a bare issue.
- A bare input carrying `unblocks`, `parent`, or `estimatedWallclock` is rejected the same way: those only make sense beside a planning header.

### 3. The one field a bare member may add — `blockedBy`

A placeholder may depend on another placeholder before either is definable, and that is the whole reason the bare arm accepts this one field. It is realized **natively** — a GitHub issue dependency, a Linear issue relation — and writes no header line, so the member stays bare:

```json
{
  "title": "The second host's landing verbs",
  "filingHint": "second-host-landing",
  "blockedBy": [{ "issue": 41 }],
  "bodySections": [{ "heading": "What this is for", "markdown": "..." }]
}
```

`"none"` and `[]` declare nothing and file exactly the dependency-less bare issue. **Never spell the reference by hand** — ask the engine to invert the blocker's id:

```bash
{{wave-cli}} issue-store parse-ref <blockerId>   # prints the reference shape for this store
```

The store that minted the id owns its format, so use the printed shape verbatim. On the local **markdown** store there is no native relation to write into — its only dependency representation *is* the header line a bare issue does not have — so a bare `blockedBy` is **refused** (exit 1) naming both sanctioned routes, rather than writing a partial header or dropping the edge. File the member without the edge and record the dependency when it is sharpened, or file it decorated through `to-issues`.

### 4. Order and join

File **blockers before dependents**, so a dependent can name a real id, then join every member:

```bash
{{wave-cli}} issue-store create --input <member.json>      # once per member; capture each printed id
{{wave-cli}} issue-store goal-assign <goalId> <issueId>    # once per member
```

`goal-assign` is idempotent — re-joining a member already in the container is a no-op — and touches membership only: never the claim marker, never the triage state, never eligibility, never open/closed.

### 5. Verify the round-trip

```bash
{{wave-cli}} issue-store goal-read <goalId>
```

A `GoalView` whose `memberIds` holds every id you captured confirms the cut landed. `memberIds` keeps **closed** members deliberately — the frontier derives `done` from them, and a membership list that dropped finished work would make a completed goal indistinguishable from an empty one.

## Pass 2 — curation

One call per join, previewed and confirmed as its own pass:

```bash
{{wave-cli}} issue-store goal-assign <goalId> <issueId>
```

The **slicing handoff** is the same call, applied to the slices: publish the PRD (`to-prd`), slice it (`to-issues`), then join each slice. The PRD itself never joins — it is consumed rather than finished, so it has no completion state to query. The superseded placeholder is then closed by the Operator in the tracker, or through `triage`'s won't-fix route; this station has no close verb and does not acquire one for the handoff.

## Pass 3 — status

```bash
{{wave-cli}} issue-store goal-frontier <goalId>
```

Read-only: one reading per member, the counts, the open remainder, and whether the remainder is empty. Rendering, the operator translations, and the empty-frontier wording: [frontier-report.md](frontier-report.md).

To find a goal id you do not have in hand, list them:

```bash
{{wave-cli}} issue-store goal-list
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success — the op's documented output on stdout |
| 1 | domain failure: the store threw (an unknown id, a refused container binding, a bare dependency the store cannot represent) |
| 2 | usage error, or an unreadable/malformed `--input` file — the message names the offending field and prints that op's own contract |

A usage error on a known op prints **that op's** contract section rather than the full op list, so a wrong flag teaches one shape instead of two dozen. The op list and every contract section live in `tools/wave/src/issue-store-cli.ts`.

## Where the design lives

The decisions this file implements — bare frontier tickets, the goal as an issue-set boundary orthogonal to PRDs, the facet on the store, the config-bound container role, the derived-never-written frontier, and *sight, never permission* — are recorded in [ADR-0044](../../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md). The frontier's own classification ladder is engine code, in `tools/wave/src/goal-frontier.ts`.
