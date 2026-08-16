# goal — station mechanics

The engine-CLI plumbing behind the three passes. The skill body owns the **judgment** (what the finish line is, what its frontier contains, what the report means); this file owns the **invocation**. Reach for it once a pass is confirmed.

> **The CLI is the source of truth for shapes.** Every op validates its input on each call and prints its own contract section on a usage error. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; read its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store is selected there — you never name a tracker, and you never write a native container name.

## The container binding — `store.goal.container`

A Goal is realized as one native container role, and the role is read from the consumer's own config at the CLI edge. Four roles are declared, and **the role decides not only where the goal lives but what KIND its direct members are** (ADR-0045 decision 1) — issues for three of the four roles, projects for the fourth:

| Role | Realized by | Member kind | Notes |
|---|---|---|---|
| `milestone` | github | issue | the store's **default** — the only native GitHub container with direct issue membership |
| `goal-file` | markdown | issue | the store's **default**; the facet *is* the realization there |
| `project` | linear | issue | must be declared explicitly |
| `initiative` | linear | **project** | must be declared explicitly — the only role whose direct members are not issues. An initiative holds projects, so every member id under this binding is a project id, minted under `store.team`, and `goal-assign`/`goal-create-member` refuse an issue-shaped id here before any write (ADR-0045 decision 3) |

**Linear binds no default even though it now realizes both its roles.** One shipped consumer runs Initiative-as-Epic / Project-as-User-Story while an older decision record once sketched "wave ≈ Linear project", so any built-in assumption collides with a live convention — declaring `project` vs. `initiative` is a real choice with a real consequence (what kind of thing a member is), not a formality. A goal op against a linear store with nothing declared fails with a typed refusal naming `store.goal.container` — that is the design, not a bug to route around.

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
| `unrealized-container` | a real role this store does not ship — `initiative` on the github or markdown store (only linear realizes it); `project` on github; `milestone`/`goal-file` on linear | pick a role the store realizes |

A configured binding is authoritative: a malformed declaration fails here rather than being quietly read as unbound and defaulted past.

There is a fourth, narrower refusal at the MEMBER level rather than the container level: `GoalMemberKindError` (exit 1), thrown by `goal-assign` when the passed member id is issue-shaped but the binding wants a project (`initiative`). It names `expected`, `container`, and the offending id — see [Pass 2 — curation](#pass-2--curation) below.

## Commands

| Call | Purpose |
|---|---|
| `issue-store goal-create --input <f.json>` | mint the container → prints the opaque goal id (text, not JSON) |
| `issue-store goal-read <goalId>` | the `GoalView` → `{ id, title, description, container, memberIds }` (JSON) |
| `issue-store goal-list` | every goal in the bound role → `GoalView[]` (JSON) |
| `issue-store goal-create-member <goalId> --input <f.json>` | mint a **bare direct member** and join it, in ONE act → prints the opaque new member id (text, not JSON) — the cut pass's whole write surface |
| `issue-store goal-assign <goalId> <memberId>` | join one **existing** member by curation; nothing on stdout |
| `issue-store goal-frontier <goalId>` | the derived frontier (JSON) — see [frontier-report.md](frontier-report.md) |
| `issue-store create --input <f.json>` | file one **bare issue**, goal-less — `to-issues`' own path, not this station's cut (see note below) |
| `issue-store parse-ref <id>` | invert an opaque ISSUE id into the `{slug?, issue}` reference shape (JSON) — issue-space only, never a project id |
| any command, no args | usage |

`goal-create-member`'s member KIND follows the binding (ADR-0045 decision 3): a bare **issue** under `milestone`/`project`/`goal-file`, a bare **project** under `initiative`. Plain `create` still exists and is still what `to-issues` uses to file a goal-less issue — but for THIS station's cut pass, `goal-create-member` replaced the older two-call "`create` then `goal-assign`" sequence, because under `initiative` there is no two-call route at all (`create` mints issues; an initiative holds projects). There is deliberately **no** goal-close op and **no** goal-dispatch op. The facet exposes neither, so neither has a runner — sight, never permission. There is no leave/unassign op either: a member leaves by being removed from the container in the tracker.

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

### 2. File each member bare AND join it, in one act — `CreateGoalMemberInput`

`goal-create-member` mints a bare **direct** member of the goal and joins it, in ONE call (ADR-0045 decision 3). It carries a title, a filing hint, and its authored prose — the WHOLE authored body, the same shape whatever the member kind:

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

```bash
{{wave-cli}} issue-store goal-create-member <goalId> --input <member.json>   # prints the opaque new member id
```

What "bare" means differs by member kind, and so does the invariant it protects:

- **Under `milestone`/`project`/`goal-file`** the member mints as a bare **issue** — ADR-0027's shape verbatim: `bodySections` verbatim as the body, **no** planning header, **no** eligibility marker, so nothing this call mints can be drawn into a wave until `to-issues` decorate-mode sharpens it. The rules the CLI enforces before any write, so a rejected input files nothing: `bodySections` must be present and non-blank (a bare issue has no header to fall back on, so an empty body is a usage error, exit 2, not a silently-completed filing); a **half-written** planning header (some of `risk`/`worker`/`files`/`acceptanceCriteria` present, some absent) is a usage error naming the missing fields; a bare input carrying `unblocks`, `parent`, or `estimatedWallclock` is rejected the same way — those only make sense beside a planning header.
- **Under `initiative`** the member mints as a bare **project**, under `store.team` — the api's own config-bound team, never a choice this call makes. `bodySections` is woven into the project's description, its only prose surface. A Linear project is *born* bare (a name, prose, a `backlog` status carry no eligibility semantics at all), so there is no half-written-header case to reject here at all — the bare-invariant burden the issue arm protects simply does not exist at project granularity.

Ordering is the contract, not an implementation detail: the goal id and the container binding resolve BEFORE anything is minted — a typo'd goal id fails before a member is filed nobody asked for. If either half of the act fails after a successful mint, `GoalMemberJoinError` names the minted member id AND which half failed (`stage: 'membership' | 'blocked-by'`): the residue is **reported, never silently rolled back** — this facet has no delete verb and no right to invent one. A `membership` failure recovers with `goal-assign <goalId> <mintedMemberId>` — the same call the join half already makes internally. A `blocked-by` failure under `initiative` has no equivalent retry verb: the member is already joined, and the missing edge has to be drawn some other way (a tracker-UI act, or noted for the next time this member's dependencies are reviewed) — there is no "add a blockedBy edge to an existing member" op on this facet.

### 3. The one field a bare member may add — `blockedBy`

A placeholder may depend on another placeholder before either is definable, and that is the whole reason the bare arm accepts this one field. **Member-space opaque ids, not `IssueRef`s** — the same space `GoalView.memberIds` lives in, because a project's blocker is another project and has no `IssueRef` spelling. Each edge is realized **natively** — a GitHub issue dependency, a Linear issue relation, or (under `initiative`) a Linear **project** relation — and writes no header line, so the member stays bare:

```json
{
  "title": "The second host's landing verbs",
  "filingHint": "second-host-landing",
  "blockedBy": ["<blockerMemberId>"],
  "bodySections": [{ "heading": "What this is for", "markdown": "..." }]
}
```

`"none"` and `[]` declare nothing and file exactly the dependency-less bare member. **Never spell a reference by hand** — under the three issue-direct bindings, ask the engine to invert the blocker's id first:

```bash
{{wave-cli}} issue-store parse-ref <blockerId>   # prints the {slug?, issue} reference shape — issue-direct bindings only
```

The store that minted the id owns its format, so use the printed shape verbatim. Under `initiative` skip this step entirely — `blockedBy` there takes the blocker's opaque project id directly, never an `IssueRef` (`parse-ref` throws on a project id; it inverts issue-space ids only). On the local **markdown** store there is no native relation to write into — its only dependency representation *is* the header line a bare issue does not have — so a bare `blockedBy` is **refused** (exit 1) naming both sanctioned routes, rather than writing a partial header or dropping the edge. File the member without the edge and record the dependency when it is sharpened, or file it decorated through `to-issues`. Under `initiative`, every declared blocker must resolve to a real project BEFORE the mint too — an unresolvable one refuses before anything is written, the same no-partial-application discipline.

> **Pending first live run.** `ProjectRelationCreateInput`'s `type`, `anchorType`, and `relatedAnchorType` fields are `String` in Linear's schema, not enums — the schema pins their SHAPE, not their VALUES. The values this store sends (`type: "blocks"`, `anchorType`/`relatedAnchorType: "project"`) are read from the vendor's own field documentation and one prior issue-relation precedent, and are **exported** as `PROJECT_BLOCKS_RELATION_TYPE`/`PROJECT_RELATION_ANCHOR_TYPE` (`tools/wave/src/adapters/linear/linear-api.ts`) precisely so a workspace that answers differently can name exactly which strings to report. `anchorType` is the weaker of the two: an INFERENCE from the field's prose ("anchored to the project itself"), not a quoted example. The confirmation this needs — create one project dependency by hand in the Linear UI, read it back through `Project.relations`/`inverseRelations`, and diff against these two constants — is a human act against a live workspace this dispatch cannot perform; it is the **first live `goal` cut that draws a dependency on an initiative-bound goal**. A rejected value surfaces loudly (a GraphQL error `createGoalMember` reports as a typed failure naming the minted member, never a silent drop) — flip the read-stamp docblock on `PROJECT_BLOCKS_RELATION_TYPE` from inferred to live-verified there, or file the correction if the values disagree.

### 4. Verify the round-trip

```bash
{{wave-cli}} issue-store goal-read <goalId>
```

A `GoalView` whose `memberIds` holds every id you captured confirms the cut landed. `memberIds` keeps **closed** members deliberately — the frontier derives `done` from them, and a membership list that dropped finished work would make a completed goal indistinguishable from an empty one.

## Pass 2 — curation

One call per join, previewed and confirmed as its own pass:

```bash
{{wave-cli}} issue-store goal-assign <goalId> <memberId>
```

`<memberId>`'s KIND follows the binding (ADR-0045 decision 3), and the call validates it BEFORE any write: an issue id under `milestone`/`project`/`goal-file`, a **project** id under `initiative`. Passing an issue-shaped id where the binding wants a project refuses with `GoalMemberKindError` (exit 1) rather than joining the wrong kind of thing — "add this issue to the goal" is the exact transitive confusion ADR-0045 rejected, because an initiative holds the project the issue lives in, not the issue itself. `goal-assign` is idempotent — re-joining a member already in the container is a no-op — and touches membership only: never the claim marker, never the triage state, never eligibility, never open/closed.

> **Pending first live run.** The kind check narrows an id to "issue-shaped" with `/^[A-Z][A-Z0-9]*-\d+$/` — an uppercase team key followed by a number (`isIssueShapedId`, `linear-issues-store.ts`). No document states every Linear workspace's team keys are uppercase-only; a lowercase-keyed id would read as NOT issue-shaped and fall through this check. The direction is benign — under `initiative` that id then hits Linear's own "unknown project" refusal instead of `GoalMemberKindError`, still a refusal, just a less-specific one — so this is a confirm-at-first-live-run note, not a blocker: record the actual team-key casing the first initiative-bound live pass encounters.

The **slicing handoff** is the same call, applied to the slices: publish the PRD (`to-prd`), slice it (`to-issues`), then join each slice. The PRD itself never joins — it is consumed rather than finished, so it has no completion state to query. The superseded placeholder is then closed by the Operator in the tracker, or through `triage`'s won't-fix route; this station has no close verb and does not acquire one for the handoff. Under `initiative` the superseded placeholder is a project; its slices are still issues, filed inside whichever project now carries the work.

## Pass 3 — status

```bash
{{wave-cli}} issue-store goal-frontier <goalId>
```

Read-only: one reading per member, the counts, the open remainder, and whether the remainder is empty — whatever the member kind. `goal-frontier`'s JSON carries the five-state reading only; it does not carry a project member's raw native status string, so knowing WHICH native state (`backlog`/`planned`/`started`/`paused`/`completed`/`canceled`) a given project is in — beyond what the reading already implies — means reading `GoalView.container` (`goal-read`) to confirm the binding is `initiative` first, then rendering what the reading can and cannot distinguish. Rendering, the native-state mapping, the operator translations, and the empty-vs-complete wording: [frontier-report.md](frontier-report.md).

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

The decisions this file implements — bare frontier tickets, the goal as an issue-set boundary orthogonal to PRDs, the facet on the store, the config-bound container role, the derived-never-written frontier, and *sight, never permission* — are recorded in [ADR-0044](../../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md). The initiative realization — direct project members, the member-kind-generic write verbs, `createGoalMember`'s one-act mint-and-join, and the native `blockedBy` arm at project granularity — is [ADR-0045](../../../../docs/adr/0045-a-goals-members-are-the-containers-direct-native-members.md). The frontier's own classification ladder is engine code, in `tools/wave/src/goal-frontier.ts`.
