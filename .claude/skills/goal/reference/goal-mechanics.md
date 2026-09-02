# goal — station mechanics

The engine-CLI plumbing behind the four passes. The skill body owns the **judgment** (what the finish line is, what its frontier contains, what the report means); this file owns the **invocation**. Reach for it once a pass is confirmed.

> **The CLI is the source of truth for shapes.** Every op validates its input on each call and prints its own contract section on a usage error. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; read its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store is selected there — you never name a tracker, and you never write a native container name.

## The container binding — `store.goal.container`

A Goal is realized as one native container role, and the role is read from the consumer's own config at the CLI edge. Four roles are declared, and **the role decides not only where the goal lives but what KIND its direct members are** (ADR-0045 decision 1) — issues for three of the four roles, projects for the fourth:

| Role | Realized by | Member kind | Update surface (mirror) | Notes |
|---|---|---|---|---|
| `milestone` | github | issue | none | the store's **default** — the only native GitHub container with direct issue membership |
| `goal-file` | markdown | issue | none | the store's **default**; the facet *is* the realization there |
| `project` | linear | issue | native Project Update | must be declared explicitly |
| `initiative` | linear | **project** | native Initiative Update | must be declared explicitly — the only role whose direct members are not issues. An initiative holds projects, so every member id under this binding is a project id, minted under `store.team`, and `goal-assign`/`goal-create-member` refuse an issue-shaped id here before any write (ADR-0045 decision 3) |

**The update surface is a Linear shape only** (ADR-0046 decision 5) — the mirror pass (Pass 4, below) publishes to it and refuses typed on the two roles that have none, naming the same `store.goal.container` key every other refusal here does. Every OTHER goal verb works identically on all four roles; only the mirror pass cares about this column.

**Linear binds no default even though it now realizes both its roles.** One shipped consumer runs Initiative-as-Epic / Project-as-User-Story while an older decision record once sketched "wave ≈ Linear project", so any built-in assumption collides with a live convention — declaring `project` vs. `initiative` is a real choice with a real consequence (what kind of thing a member is), not a formality. A goal op against a linear store with nothing declared fails with a typed refusal naming `store.goal.container` — that is the design, not a bug to route around.

```json
{
  "store": {
    "kind": "linear",
    "goal": { "container": "project" }
  }
}
```

Four refusal shapes, each naming the same config key (exit 1, the store threw):

| Refusal | Cause | Fix |
|---|---|---|
| `unbound` | nothing declared, and this store has no default | declare `store.goal.container` |
| `unknown-container` | the declared value is not a role at all (a typo, an invented name) | spell one of the four roles |
| `unrealized-container` | a real role this store does not ship — `initiative` on the github or markdown store (only linear realizes it); `project` on github; `milestone`/`goal-file` on linear | pick a role the store realizes |
| `unrealized-update-surface` | the role IS realized and every other goal verb works on it — but its container has no native UPDATE surface to mirror onto (`milestone` on github, `goal-file` on markdown; ADR-0046 decision 5). **Mirror-only**: `goal-publish-update` is the only op this refusal applies to | mirror only from a linear store bound to `project` or `initiative`; every other goal verb here is unaffected and keeps working |

A configured binding is authoritative: a malformed declaration fails here rather than being quietly read as unbound and defaulted past. There is deliberately no substitute for the fourth row — a milestone-description rewrite to hold a report was considered and rejected as a lossy write onto a field that means something else; see [Pass 4 — mirror](#pass-4--mirror) below.

There is a fifth, narrower refusal at the MEMBER level rather than the container level: `GoalMemberKindError` (exit 1), thrown by `goal-assign` when the passed member id is issue-shaped but the binding wants a project (`initiative`). It names `expected`, `container`, and the offending id — see [Pass 2 — curation](#pass-2--curation) below.

## Commands

| Call | Purpose |
|---|---|
| `issue-store goal-create --input <f.json>` | mint the container → prints the opaque goal id (text, not JSON) |
| `issue-store goal-read <goalId>` | the `GoalView` → `{ id, title, description, container, memberIds }` (JSON) |
| `issue-store goal-list` | every goal in the bound role → `GoalView[]` (JSON) |
| `issue-store goal-create-member <goalId> --input <f.json>` | mint a **bare direct member** and join it, in ONE act → prints the opaque new member id (text, not JSON) — the cut pass's whole write surface |
| `issue-store goal-assign <goalId> <memberId>` | join one **existing** member by curation; nothing on stdout |
| `issue-store goal-frontier <goalId>` | the derived frontier (JSON) — see [frontier-report.md](frontier-report.md) |
| `issue-store goal-publish-update <goalId> [--input <f.json>]` | the **mirror pass** (Pass 4): publish the frontier as derived accounting to the container's native update surface → prints the `GoalUpdateReceipt` (JSON) — see [Pass 4 — mirror](#pass-4--mirror) below |
| `issue-store create --input <f.json>` | file one **bare issue**, goal-less — `to-issues`' own path, not this station's cut (see note below) |
| `issue-store parse-ref <id>` | invert an opaque ISSUE id into the `{slug?, issue}` reference shape (JSON) — issue-space only, never a project id |
| any command, no args | usage |

`goal-create-member`'s member KIND follows the binding (ADR-0045 decision 3): a bare **issue** under `milestone`/`project`/`goal-file`, a bare **project** under `initiative`. Plain `create` still exists and is still what `to-issues` uses to file a goal-less issue — but for THIS station's cut pass, `goal-create-member` replaced the older two-call "`create` then `goal-assign`" sequence, because under `initiative` there is no two-call route at all (`create` mints issues; an initiative holds projects). There is deliberately **no** goal-close op and **no** goal-dispatch op. The facet exposes neither, so neither has a runner — sight, never permission. There is no leave/unassign op either: a member leaves by being removed from the container in the tracker. `goal-publish-update` is the one op on this facet that DOES write to the container itself (ADR-0046) — it is neither of the two verbs the paragraph above says do not exist: see [Pass 4 — mirror](#pass-4--mirror) for the guarantee that keeps it from becoming either one.

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

The store that minted the id owns its format, so use the printed shape verbatim. Under `initiative` skip this step entirely — `blockedBy` there takes the blocker's opaque project id directly, never an `IssueRef` (`parse-ref` inverts issue-space ids only, through a regex expecting a trailing `-<digits>` segment: it throws for the overwhelming majority of real project UUIDs, whose final hyphen-delimited segment carries at least one non-digit hex character, but that is not a structural guarantee — a UUID whose last segment happened to land on all-decimal digits would parse silently into a nonsense `{slug, issue}` pair instead of throwing. Skip the call under `initiative` regardless of whether this particular id would throw). On the local **markdown** store there is no native relation to write into — its only dependency representation *is* the header line a bare issue does not have — so a bare `blockedBy` is **refused** (exit 1) naming both sanctioned routes, rather than writing a partial header or dropping the edge. File the member without the edge and record the dependency when it is sharpened, or file it decorated through `to-issues`. Under `initiative`, every declared blocker must resolve to a real project BEFORE the mint too — an unresolvable one refuses before anything is written, the same no-partial-application discipline.

> **The first live `goal` cut that draws a dependency on an initiative-bound goal ran on 2026-08-16, it disproved both pinned values, and the repair has landed — read-back AND correction are both done.** `ProjectRelationCreateInput`'s `type`, `anchorType`, and `relatedAnchorType` fields are `String` in Linear's schema, not enums, so the schema only ever pinned their SHAPE; Linear validates them as enums one layer behind GraphQL, where introspection cannot see them. The live write answered what the schema could not, and neither original value held. Both were corrected in `tools/wave/src/adapters/linear/linear-api.ts` and are what this store now sends: `PROJECT_BLOCKS_RELATION_TYPE` is `"dependency"` (never the vendor's own documented example `blocks`, which its API refuses), and the anchor is not one symmetric value at all — `"project"` is not among the accepted values, and there is no symmetric value that is. It became `PROJECT_RELATION_ANCHOR_PAIR`, a frozen finish-to-start fragment spread wholesale into the relation input: the blocker's `end` anchored onto the blocked project's `start`. **A native project-relation write under an initiative binding therefore sends measured values and Linear accepts them** — the same probe created the relation, read it back verbatim (`{"type":"dependency","anchorType":"end","relatedAnchorType":"start"}`, with `projectMilestone: null`, the whole-project anchor this facet wants) and confirmed it surfaces on the blocked project's `inverseRelations`. `createGoalMember` still surfaces any rejection loudly (a GraphQL error reported as a typed failure naming the minted member, never a silent drop), so a workspace that ever disagrees is visible rather than silently lossy — but that is now the exception path, not the expected one. The read-stamp docblock on `PROJECT_BLOCKS_RELATION_TYPE` carries the full measurement, and the rule it yields for the next pinned vendor value: a sibling arm's published enum is not this arm's enum.

### 4. Verify the write

Aligned with the same step named across the other mechanics references (triage, filing, wave-start/wave-shared): some of Pass 1's calls are chatty (`goal-create`/`goal-create-member` print the minted opaque id), but `goal-assign` is one of the nine mutating `issue-store` ops that answer success with **empty stdout** by design (#648) — its exit code alone says only "did not throw," never "the member is actually in the container." Read the container back before trusting any of it landed:

```bash
{{wave-cli}} issue-store goal-read <goalId>
```

A `GoalView` whose `memberIds` holds every id you captured confirms the cut landed. `memberIds` keeps **closed** members deliberately — the frontier derives `done` from them, and a membership list that dropped finished work would make a completed goal indistinguishable from an empty one. Never pipe `goal-assign`/`goal-create-member` through another command before reading its exit code — a pipeline reports only the last command's status.

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

## Pass 4 — mirror

`goal-publish-update` is the mirror pass's whole write surface (ADR-0046) — one call, driving the engine's `publishGoalUpdate`. `--input` is **optional**: an anchor-only update (no narrative, no health, no note) is a complete, honest artifact, not a degraded one.

### Input — `PublishGoalUpdateInput`

Every field optional; nothing else is accepted:

```json
{
  "narrative": "Two of the three placeholders from the 08-15 cut have shipped; the third is now the only thing standing between this goal and done.",
  "health": "atRisk",
  "operatorNote": "read at 14:00, before the Berlin standup"
}
```

```bash
{{wave-cli}} issue-store goal-publish-update <goalId> [--input <update.json>]   # prints the GoalUpdateReceipt
```

**There is no `--body`, no `--anchor`, and no `--frontier` flag, and that absence is the point** — not even the CLI, the one surface a person types at directly, offers a way to hand the accounting in. The engine re-derives the frontier fresh inside the call and renders the anchor from ONE shared function every store calls; `narrative` and `operatorNote` are published verbatim above/inside it, and `health` is transcribed onto the write exactly as given — never defaulted, never inferred.

### Composing an exact-wording preview

The CLI has no dry-run flag for this op — there is no way to ask the engine "what would you publish" without publishing. Compose the preview yourself, from a **fresh** `goal-frontier` read plus the engine's own fixed shape, so the words match what the write will emit even though the call itself has not run yet:

1. **(if a narrative was drafted and confirmed)** the narrative text, trimmed, then a blank line.
2. `## Frontier`, then a blank line.
3. `Goal: **<goal name>** — <n> member(s).`, then a blank line.
4. **One line per member** (the whole block is skipped when the frontier has none): `- <label> — <state>[; tracker state: <nativeState>][; health: <health>][; waiting on <blockers>]`
   - `<label>` renders as a markdown link — `<name>` linking to `<url>` — when the store reported a native link, else as `**<name>**` in bold; `<name>` falls back to the raw member id when no display identity is known.
   - `<state>` is exactly one of these five words — the engine's OWN fixed vocabulary (`GOAL_MEMBER_STATE_PROSE`), **not** the operator translations [frontier-report.md](frontier-report.md) uses for the status pass; never mix the two tables:

     | reading | anchor word |
     |---|---|
     | `done` | `done` |
     | `in-motion` | `in motion` |
     | `blocked` | `blocked` |
     | `actionable` | `ready to pick up` |
     | `unready` | `awaiting sharpening` |
   - `tracker state: <nativeState>` appears only when the store reported one (an initiative-bound project's own status category); `health: <health>` only when the member has one — both ABSENT rather than a placeholder when the store has nothing to say.
   - `waiting on <blockers>` lists every unresolved edge, rendered the same way [frontier-report.md](frontier-report.md#the-five-readings-and-what-each-one-costs-the-reader) renders them for the status pass.
   - Then a blank line, once, after the whole member list.
5. **The distribution sentence**, then a blank line: `<done> of <total> member(s) [is/are] done.`, plus `Still open: <n> <anchor-word>, …` naming every non-zero open state in the engine's own ladder/precedence order — `GOAL_MEMBER_STATES` ([goal-frontier.ts](../../../../tools/wave/src/goal-frontier.ts)), which is `done`, `in-motion`, `blocked`, `actionable`, `unready` (the table above is in that same order now — a mixed frontier's clause reads `in motion` first, then `blocked`, then `ready to pick up`, then `awaiting sharpening`, never the reverse) — or, when there are zero members at all, exactly `This goal has no members yet, so there is nothing to report against it.`
6. **Whenever `frontier.complete` is true AND the goal has at least one member**, the empty-frontier sentence, verbatim, then a blank line:

   > Every member of this goal is closed. The remaining step — closing the container itself — is the Operator’s act in the tracker: this pass reports the finish line has been reached and does not declare it reached.

   A zero-member goal is `complete` too (an empty remainder is empty), but this step does not fire there — see the note below step 8.

7. **(if an operator's note was supplied)** `Operator’s note: <note>`, then a blank line.
8. The provenance line, verbatim — no trailing blank line after it:

   > Derived and published by the flotilla goal station’s mirror pass. The accounting in this section is read from the tracker at publish time and is not author-editable; any prose above it is the Operator’s own.

**Quote steps 6 and 8 exactly** in the preview — they are the engine's own fixed sentences, exported as `GOAL_UPDATE_EMPTY_FRONTIER_SENTENCE` and `GOAL_UPDATE_PROVENANCE_LINE` precisely so a preview can show the identical words the write will emit. The freshness caveat still applies: this preview is built from a READ (`goal-frontier`, taken as close to the confirm as possible), while the write derives its own frontier a second time, fresh, at the moment it runs — if the tracker moved in between, the published bytes can differ from what you just showed, in the member list and the counts, never in the two quoted sentences' own wording.

> **A genuinely empty goal (zero members) does NOT trigger step 6 — the render gates on membership.** `frontier.complete` is `open.length === 0` ([goal-frontier.ts](../../../../tools/wave/src/goal-frontier.ts)), which is true for BOTH "every member is done" and "there are no members at all" — [frontier-report.md](frontier-report.md#empty-membership-vs-completion) draws that distinction sharply for the status pass, and `renderGoalUpdateBody` carries the same distinction into the mirror's own render: step 6 fires only when the frontier is complete AND has at least one member, so a mirror run on a freshly-cut, still-empty goal publishes step 5's `This goal has no members yet, so there is nothing to report against it.` alone, never doubled up with step 6's `Every member of this goal is closed…`. **The skill's own preview guard is now belt-and-suspenders, not the only line of defense** (see "Pass 4 — mirror" in [SKILL.md](../SKILL.md#pass-4--mirror)): flagging a zero-member frontier before the confirm is still good practice — an Operator publishing an update for a goal with nothing in it yet is a judgment call worth surfacing on its own — but the anchor itself no longer contradicts the flag if it is skipped. *(Before 2026-08-16, the render carried no such gate and step 6 fired for a zero-member goal exactly as it did for a finished one — that older behaviour is what the skill-side guard above was originally written to catch; the engine fix landed alongside this row, in the mirror-pass-residue slice.)*

### Output — `GoalUpdateReceipt`

```json
{
  "goalId": "7",
  "container": "project",
  "updateId": "a1b2c3",
  "url": "https://linear.app/…/project-update/a1b2c3",
  "body": "Two of the three placeholders…\n\n## Frontier\n\nGoal: **1.0.0 — the contract freeze** — 3 members.\n\n- [The credential seam survives a second code host](https://linear.app/…) — blocked; waiting on #412\n…",
  "health": "atRisk",
  "frontier": { "goalId": "7", "readings": [ "…" ], "counts": { "…": "…" }, "open": [ "…" ], "complete": false }
}
```

`body` is the **exact** text that was published — read it back for the report rather than trusting the preview matched; `frontier` is the `GoalFrontier` this run actually derived, in the same shape `goal-frontier` prints on its own. `health` is present only when the call carried one — it reports what THIS call sent, never a claim about what the container's own health now reads as (on Linear, health is itself derived from the most recent update, so the write can move it without this field ever saying so). `url` is present only when the tracker returned one.

### The refusal

A container with no native update surface refuses before writing anything (`GoalBindingError`, `failure: 'unrealized-update-surface'`, exit 1 — the fourth row in the refusal table above), naming `store.goal.container` and the bound role. Every other goal verb keeps working on that same binding; only this one pass has nothing to publish to, and there is no substitute — a milestone-description rewrite to hold a report was considered and rejected as a lossy write onto a field that means something else.

### The retired name

The design session's working name for this pass, "health write-mirror," is retired (ADR-0046). What the pass carries is the **Frontier**; health only ever travels through it as `input.health` — a transcribed or source-attributed value, never derived — so naming the pass after health alone would misdescribe what it actually does.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success — the op's documented output on stdout |
| 1 | domain failure: the store threw (an unknown id, a refused container binding, a refused update surface — mirror only — or a bare dependency the store cannot represent) |
| 2 | usage error, or an unreadable/malformed `--input` file — the message names the offending field and prints that op's own contract |

A usage error on a known op prints **that op's** contract section rather than the full op list, so a wrong flag teaches one shape instead of two dozen. The op list and every contract section live in `tools/wave/src/issue-store-cli.ts`.

## Where the design lives

The decisions this file implements — bare frontier tickets, the goal as an issue-set boundary orthogonal to PRDs, the facet on the store, the config-bound container role, the derived-never-written frontier, and *sight, never permission* — are recorded in [ADR-0044](../../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md). The initiative realization — direct project members, the member-kind-generic write verbs, `createGoalMember`'s one-act mint-and-join, and the native `blockedBy` arm at project granularity — is [ADR-0045](../../../../docs/adr/0045-a-goals-members-are-the-containers-direct-native-members.md). The mirror pass — the fourth pass, the engine-derives-fresh guarantee, the two-layer body, and the two sanctioned health sources — is [ADR-0046](../../../../docs/adr/0046-the-mirror-pass-publishes-derived-accounting-to-the-containers-native-update-surface.md). The frontier's own classification ladder is engine code, in `tools/wave/src/goal-frontier.ts`; the mirror's renderer and its fixed wording (`renderGoalUpdateBody` and the constants beside it) are engine code too, in `tools/wave/src/adapters/issue-store.ts`, root-exported specifically so a preview can show the words the write will emit.
