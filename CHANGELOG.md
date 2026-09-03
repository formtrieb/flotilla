# Changelog

All notable changes to flotilla are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two artifacts are versioned together and released as one unit — the npm package
`@formtrieb/flotilla-engine` (`tools/wave/package.json`) and the Claude Code plugin
(`.claude-plugin/plugin.json`). A single entry below covers both. How a release is cut
is documented separately in [docs/RELEASING.md](docs/RELEASING.md).

## [2.2.0] — 2026-09-03

**The release the public step lands on.** No new station ships here: this is the version
a stranger meets, so the work went into the seams a stranger actually hits. Two
merge-order defects — both found by reading a real consumer's spine, not by a test — are
fixed. An unknown engine verb now answers with the whole roster and a reason to pick each
entry, instead of a bare name to re-guess from. `wave-setup` closes by offering the
consumer's own agent a standing orientation block. And the reading a visitor lands on — a
dated capability matrix, the second-audience README sections, the community files — is
here rather than promised. One widening earns the implementer heads-up below; it is the
whole reason this is not a patch.

### Added

- **An unknown verb or op prints the verb list, one line each** (issue #650). An unknown
  top-level subcommand — and an unknown op under `issue-store`, `spine`, or `host-pr` —
  now prints the full roster one entry per line, each with a one-line purpose sourced
  from that group's own parser-paired usage table, instead of a single joined name list.
  The pre-existing summary line, the exit code (`2`), and every *known* op's own
  usage-error contract survive **byte-for-byte**; only the unknown path's text grows. The
  top-level purpose table is typed `Record<Subcommand, string>` over the very union the
  router dispatches on, so a verb added to one without the other is a compile error — the
  roster cannot drift from the dispatcher it documents.
- **`wave-setup` offers the consumer a standing orientation block** (plugin side, issue
  #653). Setup's last step previews a short, plain-language block for the consumer's
  `CLAUDE.md` (or `AGENTS.md`) and writes it **only on an explicit yes**: the one binding
  config file, the skills by name, the protected-branch / PR-only rule, the claim labels
  and states as engine-owned, the triage state as the readiness signal, and the `report`
  skill as the route for feedback. A marker comment makes a re-run idempotent without
  touching a block the consumer has since edited; a decline leaves every consumer file
  untouched, and setup still completes.
- **A dated capability matrix per tracker and code host**
  ([`docs/CAPABILITIES.md`](docs/CAPABILITIES.md), issue #642), summarised in the README
  and pointed at from `ONBOARDING.md` and `llms.txt`. Every cell is either a dated fact
  naming its evidence or the word `verify` naming the one read that would settle it —
  including the two footnotes a consumer has to plan around: Bitbucket Cloud has no
  arm API (BCLOUD-22062, open since 2023), and arming on GitHub requires branch
  protection, which on the Free plan exists only for public repositories.
- **The reading a visitor actually does.** README sections for the second audiences —
  using the engine on its own, the `report` skill as the upstream feedback funnel, the
  cross-repo capability named (#646); the files a public repository owes a contributor —
  `CONTRIBUTING.md`, `SECURITY.md` naming the direct advisory link, a code of conduct,
  three issue forms, a plain-language PR template, `llms.txt` (#652, #665); and
  ADR-0047 / ADR-0048 recording the headless design as `proposed` (see the first
  not-yet-proven item below).
- **Keywords on the npm package.** The package carried none, so it was unfindable by
  registry search.

### Fixed

- **`parseWaveSpine`'s Plan-Table fallback no longer numeric-tail-matches a
  tracker-backed row** (issue #635). The #84 fallback matched *any* Plan-Table row id — a
  tracker-backed `TEAM-89` included — against `.scratch/**/issues/{,done/}<NN>-*.md`. A
  coincidental digit match against a frozen predecessor `.scratch/` corpus silently
  rerouted merge-order onto foreign issue files, dropped every real row, and returned
  **"Empty wave" with zero warnings** — a wrong answer that looked like a clean one. The
  fallback now runs only when *every* Plan-Table id is fs-form (bare digits, or
  `slug/NN`): a single non-numeric-prefix id is proof by construction that the spine is
  tracker-backed, so the `.scratch/` corpus is never consulted and the existing
  spine-self-contained path is taken instead. When the fallback does legitimately rebind
  an fs-form row, that rebinding is now reported in `warnings` instead of happening
  silently. Reproduced as a failing regression spec against the pre-fix code before the
  gate was written.
- **`parked` rows leave the algorithmic merge order and the branch-recovery warning**
  (issue #636). ADR-0022 makes `parked` a claim-releasing terminal — a row deliberately
  taken out of *this* wave, held before dispatch or released at a STOP — and its own text
  already excludes it from the advisory order. But `buildSpinePrs` filtered only
  `neverDispatched`, so a parked row fell through into the branch-null "in play" arm,
  rode into `algorithmic`, and raised a "no branch could be recovered from the spine"
  warning that sent operators hunting for a dispatch-log entry that was never supposed to
  exist. Parked rows now join the existing `notInPlay` bucket unconditionally —
  `MergeOrderResult` gains no field — regardless of whether a stale branch from an
  earlier failed dispatch happens to be on file. The branch-recovery warning for a
  genuinely dispatched row is untouched, byte-for-byte.

### Changed

- **`ParsedSpine` widens by ONE required field — the implementer heads-up.**
  `warnings: string[]` is now required on `ParsedSpine`, a package-root exported type, so
  the Plan-Table fallback's rebinding notice can travel out of `parseWaveSpine` and be
  merged into `MergeOrderResult.warnings`. **Breaking for any consumer that *constructs* a
  `ParsedSpine` itself** — a hand-built fixture, a test double — and invisible to any
  consumer merely *using* the engine: `MergeOrderResult` and the CLI surface are
  unchanged, no runtime export moves, and only the type gate sees it. Minor per the house
  rule, the same shape as the widenings 1.5.0 and 2.1.0 carried and ruled on. The fix at
  a call site is one line: add `warnings: []` to the literal.

### Proven since 2.1.0

- **The installed form ran end to end on a fresh consumer, 2026-09-03 — the first
  measured stranger's arc.** Plugin `flotilla@formtrieb` and engine
  `@formtrieb/flotilla-engine`, both 2.1.0, on a throwaway GitHub-Issues repository with
  no prior flotilla state: install → `wave-setup` → `triage` → `to-issues` → `wave-plan`
  → `wave-create` → `wave-start` → `wave-close --auto`; one issue, one PR, merged and
  archived. 59 minutes wall clock, 4 agents, **0 permission prompts and 0 Coordinator
  misfires during the wave itself**, 3 operator hand steps (all three now documented
  steps rather than surprises). The credential indirection held — the token appeared in
  no output — every read-back matched its write, and `host-pr arm` on a check-less PR
  returned `merged` with a usable reason. The full measurement, its thirteen findings and
  where each one was filed:
  [`docs/retros/2026-09-03-quickstart-probe.md`](docs/retros/2026-09-03-quickstart-probe.md).
  That probe is also what corrected the README quickstart, `docs/ONBOARDING.md` and
  `wave-setup` in this release.

### Unsettled by construction, and what is not yet proven

The list below is 2.1.0's, corrected against live operation on 2026-09-02 (issue #641)
and re-read against the consumer probe of 2026-09-03. Each item lands as one of three
things: a dated proof naming its evidence, a dated *still not proven*, or `verify` naming
the one read that would settle it.

- **Headless is designed, not built.** The answer half of `needs-attention` and the
  headless run are settled as two `proposed` records — ADR-0047 (a typed **Answer** bound
  to a spine-anchored **Ask**) and ADR-0048 (a finite **Pulse** on a leased `spine/<slug>`
  branch) — grilled 2026-09-01/02 against the shipped records and the code. Four premises
  of the original sketch fell to that reading and are recorded there. No engine verb,
  skill, or branch from either record exists yet; the glossary marks each new term
  accordingly.
- **Bitbucket's write half is proven for `create` and `status`, live-proven 2026-08-17;
  `arm` and `merge` are not, and will gain no further evidence on this line.** A spine
  reading (2026-08-31) of a consumer wave run 2026-08-17 shows `host-pr create` (the
  Basic-auth path, five PRs) and `host-pr status` (mergeability reads) running live
  against Bitbucket Cloud. `arm` and `merge` have no live reading on record, and that
  consumer moves to GitHub in September 2026 — this corrects 2.1.0's line, which named
  the whole write half unproven without separating the two verbs actually exercised from
  the two that were not. `docs/CAPABILITIES.md` now carries the same split per cell.
- **The Linear attachment upsert — `verify`: the next Linear-store consumer close, read
  for the closing-PR attachment on the closed issue.** Unchanged since 2.1.0 (issue
  #511): no consumer close is on record since, and the 2026-09-03 probe ran on GitHub
  Issues, so the URL-uniqueness upsert semantics against a real workspace are still
  unread.
- **The `prUrl` notice's agent-mediated half — a completed Scribe round is now on record,
  and no notice arose in it, so the forwarding itself is still unread (2026-09-03).** The
  probe's wave completed both Scribe stages clean, with `write-report` and `write-verdict`
  validating — which is the round 2.1.0's line was waiting for. But no notice was raised
  during it, so a real notice forwarded by a real Scribe has still never been observed.
  The engine side stays live-measured; `verify` is now narrower than it was: the next wave
  in which a notice actually fires.
- **The residue-probing worktree classification is still not proven, 2026-09-03, and
  unchanged.** Measured negative twice against two different implementations, exactly as
  2.1.0 recorded; no third read is on record, and the manual sandbox-off force-removal
  remains the documented ordinary path. The 2026-09-03 probe's cleanup ran through
  `wave-close --auto`'s branch deletion and did not exercise it.
- **The grant-in-brief plugin half — still not proven, 2026-09-03, but the gap has
  narrowed to the timing.** `verify` was "a mid-wave `issue-store annotate` followed by a
  re-compose, exercised on an installed-form consumer". The installed-form consumer now
  exists and is measured — but its `annotate` ran during `to-issues` decoration, *before*
  `wave-create`, and no re-compose followed. What is still outstanding is precisely a
  mid-wave annotate on that form.
- **The uppercase-team-key assumption — `verify`: record the actual team-key casing the
  first initiative-bound live pass encounters.** `isIssueShapedId`'s
  `/^[A-Z][A-Z0-9]*-\d+$/` narrowing is unconfirmed against a live workspace; the goal
  skill's own reference still carries this as a pending-first-live-run note, unchanged
  since 1.5.0.
- **A health-less mirror publish may still move the container's own health — `verify`:
  the first live `goal-publish-update` call with `health` omitted, read against the
  container afterward.** No live mirror publish is on record since 2.1.0 shipped the
  verb; the question the engine deliberately declined to answer is still open.
- **`LINEAR_UPDATE_HEALTH_VALUES` is still schema-read, not live-proven — `verify`: the
  same first live mirror publish, cross-checked against the values Linear's workspace
  actually accepts.** Unchanged since 2.1.0.

## [2.1.0] — 2026-08-17

**The goal station learns to publish.** The mirror pass ships whole — a sixth store verb
that publishes a goal's derived frontier accounting to the bound container's own native
update surface, and the goal skill's fourth pass that drives it — on top of a frontier
whose members now each carry their native state and their own health. Additive throughout:
nothing removed, renamed, or re-typed. One widening earns the implementer heads-up below;
it is the whole reason this is not a patch.

### Added

- **`publishGoalUpdate` — the sixth `IssueStore` verb** (CLI: `issue-store
  goal-publish-update`). Publishes the goal's derived accounting — per-member state lines,
  the distribution sentence, the unresolved-blocker rendering — to the container's native
  update surface (a Linear project or initiative update). The anchor is **engine-owned and
  unsupplyable**: the caller contributes a narrative, an optional health value, and an
  optional operator note, and can neither supply, edit, nor omit the accounting itself.
  The `GoalUpdateReceipt` reports **what the engine sent** — an empty-string health is
  treated as absence at the gate, so the receipt always matches the wire. A goal with
  **zero members** publishes only the "no members yet" sentence; the finish-line sentence
  renders only for a goal that has members and has closed every one of them — empty
  membership and completion are distinguishable on the published surface, mirroring the
  status pass's own precedent. A container with no native update surface refuses loudly
  with a new, typed member of the goal-binding refusal family.
- **Every frontier member carries its native state and its own health.**
  `GoalMemberNativeState` and `GoalMemberHealth` ride each reading — one derivation, two
  consumers (the status report and the mirror anchor). Health is read the way the vendor
  actually derives it: from the container's most recent update, with an explicit null when
  none was ever reported — a roll-up, never a field a person sets on the node.
- **Seven new root runtime exports** — `GOAL_MEMBER_STATE_PROSE`,
  `GOAL_UPDATE_ANCHOR_HEADING`, `GOAL_UPDATE_EMPTY_FRONTIER_SENTENCE`,
  `GOAL_UPDATE_PROVENANCE_LINE`, `LINEAR_UPDATE_HEALTH_VALUES`,
  `refuseGoalUpdateSurface`, `renderGoalUpdateBody` — and seven new exported types:
  `PublishGoalUpdateInput`, `GoalUpdateReceipt`, `GoalUpdateMemberIdentity`,
  `GoalMemberNativeState`, `GoalMemberHealth`, `LinearUpdateInput`, `LinearUpdateResult`.
- **The goal skill teaches the mirror pass** (plugin side): a per-pass preview that shows
  the full body verbatim with an explicit confirm that inherits nothing from any earlier
  pass, a narrative drafted sentence by sentence in the consumer's own house form (flotilla
  pins no template), and a health-proposal round with exactly two sanctioned sources and
  one prohibition — transcribe an operator-supplied value, or propose a source-attributed
  aggregation of the members' own healths, and never propose from the frontier itself. The
  station's boundary is unchanged and restated where it matters most: it reports, it never
  dispatches, and it never declares the finish line reached — not even from the pass that
  writes.

### Changed

- **`LinearApi` widens by TWO required methods — the implementer heads-up.**
  `createProjectUpdate` and `createInitiativeUpdate` are now required on the seam. Breaking
  for any consumer that *implements* `LinearApi` itself — a custom transport, a recording
  double — and invisible to any consumer merely *using* the engine: no runtime export count
  moves, only the type gate sees it. Minor per the house rule, same shape as the widening
  1.5.0 carried and ruled on.
- The project-relation decision record now carries **one house lesson with a dated
  nuance** (the vendor's prose misled — only a live measurement settles a vendor value —
  with the recoverable-in-hindsight reading recorded as a dated amendment, and the record
  and the code's read-stamp pointing at each other). Both vendor-schema citations are
  pinned to the commit they were read at, and the issue arm's relation-type read filter now
  matches through the same module-local constant its create half uses.

### Unsettled by construction, and what is not yet proven

- **A health-less mirror publish may still move the container's own health.** The vendor's
  create input marks `health` optional while the created node declares it non-null, so the
  server assigns a value when the key is omitted — a fixed default, or the previous
  update's health carried forward, is a pure value question no schema read can answer. The
  engine's response is the conservative one: it omits the key entirely, and the receipt
  deliberately reports what was sent and claims nothing about what the container reads
  afterwards. The first live mirror publish is the read that settles it.
- **`LINEAR_UPDATE_HEALTH_VALUES` is schema-read, not live-proven** — but published as a
  real GraphQL enum, unlike the free-`String` pair 2.0.0 corrected, so that specific
  failure mode cannot repeat in that form. The engine authors no health value; the list is
  documentation and a validation aid, and a workspace that ever disagrees fails loudly.
- **Carried forward, still not live-proven:** the Linear attachment upsert; the `prUrl`
  notice's agent-mediated half; the residue-probing worktree classification (now measured
  negative twice, against two different implementations); the grant-in-brief plugin half;
  Bitbucket's write half; and the uppercase-team-key assumption in the issue-vs-project id
  check.

## [2.0.0] — 2026-08-16

**A live measurement falsified two constants 1.5.0 had shipped as unproven, and repairing
them removed a published export.** That removal is the whole reason for the major: one root
export is gone by name, with no alias. Everything else in this release is a repair or a
correction, and the practical blast radius is as close to zero as a breaking change gets —
but the rule is written about the *shape* of the change, not about how many people it hurts,
and this is a removal.

If you do not use the Linear goal facet's initiative binding, upgrading is a rename in one
import line, or nothing at all.

### The migration, in full

| 1.5.0 | 2.0.0 |
|---|---|
| `PROJECT_RELATION_ANCHOR_TYPE` (a `string`, `'project'`) | **`PROJECT_RELATION_ANCHOR_PAIR`** (a frozen object, `{ anchorType: 'end', relatedAnchorType: 'start' }`) |
| — | `ProjectRelationAnchorPair` (new exported type) |
| `PROJECT_BLOCKS_RELATION_TYPE === 'blocks'` | `PROJECT_BLOCKS_RELATION_TYPE === 'dependency'` (same name, new value) |

Nothing else on the package root, the `wave.config.json` schema, or the CLI surface changed.

### Removed

- **`PROJECT_RELATION_ANCHOR_TYPE` — renamed, with no alias left behind.** It named a single
  symmetric anchor value; the live API has no such thing, so the symbol had no correct value
  to hold and keeping the name would have been keeping a lie. The replacement is a **frozen
  wire-keyed pair** spread whole into the relation input, which makes the one dangerous
  mistake unspellable rather than merely discouraged: a project dependency is finish-to-start
  — the blocker's `end` anchored to the blocked project's `start` — and two loose scalars
  could be swapped silently, because both values are valid enum members in both fields and
  Linear would happily record a backwards dependency without complaint. The alias was
  considered and deliberately not shipped: the retired constant's only value was one the API
  refuses, so an alias would preserve a name whose meaning was never usable.

### Fixed

- **Both project-relation constants were wrong, and the initiative-bound `blockedBy` arm
  could not succeed against any live workspace.** 1.5.0 listed these values under *Not yet
  proven*; that was too kind. Every attempt to draw a native project dependency failed with
  `Argument Validation Error`. `type` had to be `'dependency'` — not `'blocks'` — and the two
  anchor fields had to be `'end'` and `'start'`, not `'project'`. The arm now works; before,
  it never could.
- **The `-heavy` failure underneath it is worth more than the fix, because it will recur on
  the next vendor field.** The published schema types all three fields as free `String`, so a
  schema read pins their *shape* and can say nothing about their *values* — and the API
  validates them as enums anyway, one layer behind GraphQL, surfacing only in a rejection
  payload. Worse, the vendor's own field documentation gives `blocks` as its example, which
  is precisely the value the API refuses. The read-stamp on these constants now records that
  in full, including the sharpest explanation for why the wrong guess was plausible: the
  schema *does* define an enum for the **issue** relation arm and none at all for the
  **project** arm, so a real enum member was carried across from the neighbouring arm. It
  also records where that enum actually binds — the create input only; the relation's own
  `type` field and the update input are bare `String`.

### Added

- **`ProjectRelationAnchorPair`**, the exported shape of the replacement constant. Its two
  members are literal-typed (`'end'` / `'start'`), so a symmetric collapse fails at the type
  gate before any test runs.

### Changed

- **The goal station's documentation gained the usage mode it was actually being used in.**
  The cut pass was framed as greenfield placeholder-filing; the archetypal use — a release
  cut — is a **collecting lens over a pool that already exists**, which the skill now names in
  its own right. Two questions the docs previously left open are settled rather than
  surveyed: whether one preview under one confirm may cover a combined cut-plus-curation pass,
  and whether the ship-member-with-edges shape is taught or rejected.
- **Two skill descriptions were repaired, one of which was silently truncating at runtime.**
  A space-hash inside a trigger phrase read as a YAML comment introducer, so the document
  parsed *cleanly* and the description ended 55 characters early — visible to nobody, since
  nothing errored. The other was a colon-space that failed strict parsing outright, in the
  reviewer agent file: a sixth carrier that falsified the original diagnosis's
  SKILL.md-only correlation. The in-repo guard now reaches both, which matters more than
  usual because the platform's own validator stopped reporting this class entirely between
  two releases — this guard is now its only owner.

### Not yet proven

Everything below ships tested against fakes, falsification specs, and vendors' published
schemas — and has never made the live round-trip. Unchanged from 1.5.0 except where noted.

- **The Linear attachment upsert has never run live.** First Linear-store consumer close
  after this release is the first live read.
- **The `prUrl` notice's agent-mediated half has never completed end-to-end.** The engine side
  is live-measured; no real Scribe has yet forwarded a real notice.
- **The grant-in-brief mechanism's plugin half** — exercised for the first time during this
  release's own work, but on the source form rather than an installed consumer.
- **Bitbucket's write half** (unchanged since 1.3.0; the read half is live-verified).
- **The uppercase-team-key assumption** in the issue-vs-project id check.
- **Dropped from this list, because they were measured:** the project-relation constants
  (measured, and falsified — see Fixed) and the four direction facts that came back correct
  (values round-trip verbatim with `projectMilestone: null`; `projectId` is the blocker and
  `relatedProjectId` the blocked project; the relation surfaces on the blocked project's
  `inverseRelations` and never its `relations`; and Linear's own blocking/blocked-by filters
  agree with that direction). Uniqueness is enforced per project-pair-and-type, not per
  anchor pair.

### Known issues

- **The worktree sweep's classification still needs two runs on a sandboxed harness.** A
  deterministically-denied clean worktree reads as *transient* on the first run and only
  reads *exhausted* — carrying the manual recovery commands — on the second. Two separate
  fixes have now been measured live against this, and both failed the same way; the current
  hypothesis is that the distinguishing evidence only comes into existence *as a result of*
  the first failed attempt, which no discriminator reading that attempt can see. The manual
  sandbox-off force-removal remains the documented ordinary path.
- **The mirror pass is designed but not built** (unchanged from 1.5.0).

## [1.5.0] — 2026-08-16

The **goal station** release: flotilla gains a fourth planning station, and with it the
one thing the pipeline could not previously express — a *named finish line* on the
tracker, its curated membership, and the derived remainder of work still open before it.
The station is deliberately **sight, never permission** (ADR-0044): it files placeholders
that carry no readiness marker, it has no dispatch verb, and it has no close verb, so
nothing it creates can reach a background agent unsharpened and no agent can write itself
a release authorization. Around it, the release carries the **consumer boundary** work
(the operator register, the sibling-path skill read), a worktree sweep that **accounts**
for everything it could not remove rather than staying silent about it, a credential
resolver that names a previously-mute failure mode, and a skill-description surface that
a guard now keeps honest.

**Minor per ADR-0035.** Nothing was removed, renamed, or re-meant on any of the three
frozen contracts: the package root only gains exports, the `wave.config.json` schema only
gains an optional key, and the CLI only gains verbs. Two exported *interfaces* gain
required members, which is a compile-time break for anyone **implementing** them — never
for anyone **consuming** them — and both get their own loud heads-up under Changed below,
the same treatment 1.4.0 gave the `Disclosure.iter` widening.

### Added

- **The Goal facet on `IssueStore` — a finish line bound to a native container
  (ADR-0044, issue #570).** A Goal is one container on your tracker plus its derived
  Frontier. Six verbs cross the barrel: `createGoal`, `readGoal`, `listGoals`,
  `assignToGoal`, `createGoalMember`, `readGoalFrontier`, with `goal-create`,
  `goal-read`, `goal-list`, `goal-assign`, `goal-create-member` and `goal-frontier` as
  their CLI projection. Which native container realizes a Goal is a **config fact**, not
  a call-time choice: GitHub defaults to its Milestone, the markdown store to its goal
  file, and **Linear binds no default at all** — it refuses with a typed
  `GoalBindingError` naming `store.goal.container`, because live consumer conventions
  genuinely disagree about what a Linear project means. Members are filed **bare** —
  authored prose, no planning header, no eligibility marker — so the cut records that a
  workstream exists without implying anything about whether an agent may pick it up.
- **A Goal's members are the container's direct native members (ADR-0045, issue #573).**
  The member *kind* follows the binding rather than the caller's intent: an issue under
  `milestone`/`project`/`goal-file`, a **project** under a Linear `initiative`, because
  an initiative holds projects and not issues. `createGoalMember` is one act — mint the
  bare member and join it — since under `initiative` there is no two-call route at all.
  Passing an issue-shaped id where the binding wants a project is refused with
  `GoalMemberKindError` **before any write**; a join that fails after a successful mint
  reports the residue through `GoalMemberJoinError` naming the minted id and which half
  failed, rather than inventing a rollback this facet has no right to perform.
- **The Frontier — derived on every read, never stored (ADR-0044 decision 5).**
  `computeGoalFrontier`/`classifyGoalMember` are pure and store-blind, turning what an
  adapter can see about each member into exactly one of five readings: `done`,
  `in-motion`, `actionable`, `blocked`, `unready`. Because it is derived, there is no
  durable marker anywhere for an agent to author — the structural answer to the failure
  mode this station was designed against.
- **`store.goal.container` is a typed contract field (issue #578).** The binding joins
  the `wave.config.json` schema with `config validate` coverage, three refusal shapes
  (`unbound`, `unknown-container`, `unrealized-container`), and `readGoalContainer` /
  `resolveGoalContainer` at the root for a consumer resolving it themselves. A malformed
  declaration fails loudly instead of being quietly read as unbound and defaulted past.
- **The BARE `create` form gains a `blockedBy` arm, realized as native dependencies
  (issue #572).** A placeholder may depend on another placeholder before either is
  specifiable — that is the whole reason the arm exists. Each edge becomes a real tracker
  relation (a GitHub issue dependency, a Linear issue relation, or a Linear **project**
  relation under an initiative binding) and writes **no header line**, so the member stays
  bare. The local markdown store, whose only dependency representation *is* the header
  line a bare issue does not have, **refuses** rather than faking it.
- **The sweep owes accounting, never removal (ADR-0042, issues #557 and #560).** Two
  additive report fields close the two ways the worktree sweep used to lose evidence: an
  incomplete removal now **names its survivors** (the walk already computed them; they
  were being discarded), and the report accounts for **registered worktrees the sweep
  never enumerates** — a worktree git knows about that the sweep's own globs never reach
  no longer vanishes from the accounting. Nothing new is removed; the sweep's removal
  behaviour is byte-unchanged.
- **The credential resolver detects `security(1)`'s trailing-newline hex mangling and
  refuses with guidance (issue #597).** A keychain secret retrieved through the hex path
  can come back with a mangled trailing byte — previously a mute, mystifying auth
  failure downstream. It is now caught at the resolver seam and refused with a typed
  `CredentialFailure` member and a message that says what to do about it.
- **Every CLI usage error teaches the complete first lesson (issue #505).** A usage error
  on a known op prints **that op's** contract section rather than the full op list, so a
  wrong flag teaches one shape instead of two dozen. Exit codes and JSON shapes are
  untouched.
- **The Linear store's `close()` upserts the closing PR as a native attachment
  (issue #511).** The closing pull request becomes a first-class Linear attachment on the
  issue rather than prose nobody's tooling can read.
- **User-visible engine and hook messages carry themselves (ADR-0039, issue #502).** The
  operator register reaches the engine's own output: a message a person reads explains
  itself without a decision-record number, a convention number, or an internal id in it.
- **Convention 16 — the operator register (issue #499)**, its byte-identical clause in
  every skill, and a drift guard that keeps the clause from decaying. Widened later in
  the same release to the **reference tier** (issue #514), so the register reaches one
  level down into the files skills read.
- **The close report counts the Coordinator's own misfires (issue #506).** A wave close
  now reports how often the Coordinator itself mis-stepped — the number nobody was
  keeping, and the one that says whether the driver's prose is converging.
- **A finishing report without a usable PR URL is a loud exit-0 notice at the sidecar
  write (issue #556).** The sidecar is still written; a `notice:` line on stderr names
  what is missing, so the recurring "the PR exists but the report does not know its URL"
  class stops being silent.
- **A granted scope extension travels in the brief (ADR-0041, issue #516).** A mid-wave
  scope grant rides as data on the row and every re-compose re-fetches, so an agent's
  authority is read from the row rather than remembered from a conversation.
- **Bitbucket's merge-checks refusal names the scope it needs (issue #543).**
- **The skill-description surface gets a guard that can actually fail (issues #500, #526,
  #548, #555, #602).** Descriptions read consumer-first and in third person; a
  cross-reference anchor is **verified** rather than stripped; a guard's subject path is
  declared **guard-side** so the checked text can never carry its own exemption
  (ADR-0043); and frontmatter is validated as **strict YAML** by two parsers that must
  agree — a colon-space in an unquoted description silently truncated a live skill's
  description at runtime, and the platform's own validator lost this whole class between
  two CLI releases, which makes this guard its only remaining owner.

### Changed

- **`IssueStore` gains six required members — the heads-up (ADR-0044).** The Goal facet's
  verbs are required, not optional, so a **third-party adapter implementing `IssueStore`
  no longer typechecks** until it implements them. Every *consumer* of a store handle is
  unaffected: nothing was removed, renamed, or re-typed, and all three shipped adapters
  implement the facet. The whole vocabulary an implementer needs is root-exported for
  exactly this reason — `GoalContainer`/`GOAL_CONTAINERS`, `GoalMemberKind`/
  `GOAL_MEMBER_KIND_BY_CONTAINER`/`goalMemberKind`, `CreateGoalInput`/
  `CreateGoalMemberInput`/`GoalView`, the typed failures, and the two shared rule
  implementations `requireGoalContainer` and `requireGoalMemberKind`, so a fourth adapter
  applies the same rule rather than re-deriving one that can drift.
- **`LinearApi` gains thirteen required members — the heads-up (issue #511 and
  ADR-0045).** `upsertAttachment` plus the project and initiative surface
  (`createProject`, `getProject`, `listProjects`, `setIssueProject`, `listProjectIssues`,
  `createInitiative`, `getInitiative`, `listInitiatives`, `listInitiativeProjects`,
  `addProjectToInitiative`, `getProjectBlockedBy`, `addProjectBlockedBy`). Same shape as
  above: external *implementers* of the interface break at compile time, external
  *consumers* do not. This is the first post-1.0.0 release in which an exported interface
  gains required members, and the ruling is recorded here: the three frozen contracts are
  read as contracts with their **consumers**, so an implementer-only break is Minor plus
  a loud heads-up — not a major bump.
- **`CredentialFailure` gains the member `'lookup-hex-mangled'` (issue #597).** Additive
  widening of an exported union: a consumer switching exhaustively over it gains a new
  case and finds out at compile time.
- **`CreateInputFailure` gains the member `'bare-blocked-by-unrepresentable'`
  (issue #572)** — the markdown store's refusal of a bare dependency it cannot represent.
  Same additive-union shape as above.
- **`GoalFrontier`'s `unresolvedBlockers` are `IssueRef | string`.** A project member's
  blocker is another project, and a Linear project id is a UUID with no honest `IssueRef`
  spelling — so the blocker shape carries both. New type, no existing shape changed.
- **Skills load `wave-shared` by sibling-path read, not by name (ADR-0040, issue #501).**
  This closes the known issue 1.4.0 shipped with: `wave-shared` declares
  `disable-model-invocation: true`, which removed it from what a model may load by name,
  so the by-name instruction the execution skills carried was never executable and the
  first fully-external consumer run needed a manual `/flotilla:wave-shared` invocation to
  get past it. **No release after 1.4.0 needs that workaround.**
- **The `report` skill files in English, whatever the session speaks (issue #497).** The
  artifact that reaches flotilla's maintainers is English; the operator's own language
  stays in the chat, which is where Convention 16 puts it.

### Fixed

- **The worktree sweep classifies a deterministic denial on evidence, not on an errno
  (issues #528 and #542).** A clean worktree the harness deterministically refuses to
  delete reads **exhausted on run 1** — carrying `manualRecovery` with the real
  sandbox-off commands — instead of advising a retry against an obstruction that will
  never clear. The first fix split on whether the removal error was ENOTEMPTY-family and
  missed the live shape (the denied *children* make the directory undeletable, so the
  errno is byte-indistinguishable from the transient race the retry exists for); the
  shipped classification probes the **residue** instead, which is the signal errno cannot
  carry.
- **`manualRecovery` shell-quotes every printed path (issue #515).** A copy-pasteable
  command stops being a lie for any path with a space in it — which is every path in a
  worktree under a directory a human named.
- **Bare `create` refuses a `bodySections` entry missing `heading` or `markdown`
  (issue #530)** — a usage error naming the field, instead of a crash.
- **A 404 on Bitbucket's post-merge branch delete reads as already-gone, not as a failed
  deletion (issue #495).** Landing no longer reports a failure for work that succeeded.
- **`store-preflight` stops asserting a code-host conclusion it cannot know
  (issue #493).** The tracker-host integration check now answers only the question it can
  actually answer.
- **The reviewer phase picks its state from the verdict (issues #513 and #527)** — in the
  routing itself and in the step-7 summary that reports it, which had drifted apart.
- **`wave-close`'s phase-4a engine surface covers the Bitbucket adapter (issue #517)**,
  and phase 4a now **predicts the half-applied sandboxed pull before it runs**
  (issue #531) — the failure signature where a git command under sandbox reports success
  having done only half its work.
- **The driver's report-schema copy regains its `prUrl` floor (issue #562)**, pinned
  modulo the boundary combinator so the copy cannot silently drift from the schema again.

### Docs

- **ONBOARDING teaches the goal station (issue #580)** — the fourth planning station
  reaches a consumer's first read rather than existing only in the skill.
- **`wave-setup` was re-measured against reality across five passes:** the Credentials
  section goes host-aware (issue #492), the AFK scaffold verifies its own files are
  **trackable** (issue #494), the keychain first-read prompt was **measured** and all
  three documents reconciled against the measurement (issue #544), the credential set
  gained a scan table with three corrected Bitbucket scope facts (issue #539), and the
  Bitbucket minimal scope set was re-measured against the vendor spec — pull-request
  operations move to their own scope pair (issue #559). Promoted prose pays its debt back:
  the setup read shrinks to residual forms (issue #509).
- **`wave-start`'s auth preflight checks the credential the engine actually uses
  (issue #549)** — it was checking a different one.
- **The Scribe briefs carry their payload's provenance and the filing-clerk framing
  (issue #577)**, and the classifier refusal becomes a **named, counted** failure class
  rather than an anecdote.
- **Occurrence catalogues move to evidence sidecars (issue #510)**, keeping the skills
  themselves teachable while the measurements stay addressable.
- **Nine decision records** land or are amended: ADR-0039 (operator register), ADR-0040
  (sibling-path read), ADR-0041 (granted scope extension), the ADR-0034 amendment
  (promotion pays its prose back) and its **rung split** — a schema boundary constrains an
  author, an engine check inspects an artefact, with the reason carried to all six
  boundary-conditional sites (issue #563) — ADR-0042 (the sweep owes accounting),
  ADR-0043 (the checked text never carries its own exemption), ADR-0044 (a goal binds a
  native container and derives its frontier), ADR-0045 (a goal's members are the
  container's direct native members), and ADR-0046 (the mirror pass — designed, **not
  shipped in this release**; its engine and skill halves are tracked as open work).
- **The Apache copyright holder is filled in** — Michael Helmbrecht, 2026.

### Not yet proven

Everything below ships tested against fakes, falsification specs, and the vendors' own
published schemas — and has **never made the live round-trip**. Stated so a consumer
knows which edge they are the first to walk.

- **The Goal facet's two Linear arms have never run against a live workspace.** Both the
  `project` and the `initiative` binding are hermetic-fake-backed and schema-compared. The
  weakest point is named and **exported** so a disagreeing workspace can report exactly
  which strings to change: `PROJECT_BLOCKS_RELATION_TYPE` (`"blocks"`) and
  `PROJECT_RELATION_ANCHOR_TYPE` (`"project"`) are typed `String` by Linear, not enums —
  the schema pins their *shape*, not their *values* — and `anchorType` in particular is an
  inference from the field's own prose rather than a quoted example. The first
  initiative-bound cut that draws a dependency is the confirmation; a rejected value
  surfaces loudly as a typed failure naming the minted member, never a silent drop.
- **The issue-vs-project id check assumes uppercase team keys.** `goal-assign`'s kind
  check narrows an id with `/^[A-Z][A-Z0-9]*-\d+$/`. No document states every Linear
  workspace's team keys are uppercase-only. The failure direction is benign — a
  lowercase-keyed id still refuses, just via Linear's plainer "unknown project" error
  instead of the typed `GoalMemberKindError` — so this is a confirm-on-first-contact note,
  not a blocker.
- **The Linear attachment upsert has never run live.** Fake-backed, falsification-tested,
  and schema-compared — but the live round-trip, including the URL-uniqueness upsert
  semantics on a real workspace, is unstamped. The first Linear-store consumer close after
  this release is the first live read.
- **The `prUrl` notice's agent-mediated half has never completed end-to-end.** The engine
  side is live-measured across three payload shapes including a negative control, and the
  Scribe carrier is verified by reading. What no run has exercised is a real Scribe
  forwarding a real notice: the one natural occurrence so far was **voided** because the
  session checkout still ran the pre-gate engine and the un-gated code answered.
- **The evidence-based worktree classification has no live read on record.** Its
  predecessor was measured live twice and failed both times, which is why it was replaced;
  the replacement's own first live read has not been captured. The manual sandbox-off
  force-removal remains the documented ordinary path on a sandboxed harness regardless.
- **The grant-in-brief mechanism (plugin half) has never been exercised in a live wave.**
  The first mid-wave `issue-store annotate` followed by a re-compose is the first live
  read.
- **Bitbucket's write half remains unproven** (unchanged since 1.3.0; the read half is
  live-verified).

### Known issues

- **The mirror pass is designed but not built.** ADR-0046 settles how a goal's derived
  accounting would be published to the container's native update surface — with the engine
  deriving the frontier itself at write time so a caller cannot lie about it. Neither half
  ships here; both are open work.

## [1.4.0] — 2026-08-11

Same-day follow-through on ADR-0038: the Disclosure capture window now spans the whole
wave — a Coordinator find that surfaces during a close phase is captured where it
surfaces, wave-scoped and first-class — and the chronically-manual worktree removal is
promoted from documented exception to designed path, on its doc half and its report half
alike. Minor per ADR-0035: one additive CLI input form, three new root exports, and one
public-type widening that gets its own heads-up below because a root-only consumer's
arithmetic on it breaks at compile time.

### Added

- **`spine add-disclosure --wave` — a wave-scoped Disclosure is first-class (ADR-0038).**
  A find about the wave's own machinery — the sweep, a preflight posture, the merge-order
  tool — is owned by no Plan-Table row and no iteration; the new boolean flag replaces the
  `<row-id>` positional and `--iter` on the same op. A wave-scoped entry renders as row
  `wave` with an em-dash Iter cell, round-trips byte-preserving, is addressable by
  `set-disposition` via its printed `wave.<ordinal>` ref, and is counted by the
  `check-disclosures` archive gate exactly like a row-scoped entry (open blocks, terminal
  clears). Mixing `--wave` with a `<row-id>` or `--iter` is a usage error with nothing
  written; a spine whose Plan-Table actually holds a row named `wave` gets a defensive
  refusal on the wave-scoped path only. Three new root exports carry the form:
  `addWaveDisclosureToSource`, `WAVE_SCOPE_ROW`, `WAVE_SCOPE_ITER_CELL`. The row-scoped
  form keeps byte-identical shape, validation, and output — verified at review by a
  differential probe against the pre-change tree.
- **The wave-close skill teaches the close-phase capture doctrine (ADR-0038).**
  Capture-at-discovery in the skill body's judgment layer, one backstop line ahead of the
  phase-6 disclosure gate, and the capture verb's rows — both forms — in the
  close-mechanics command table. The capture window ends hard at the archive: a
  post-archive find files directly as a bare tracker issue.
- **An exhausted `erroredStillListed` entry says a re-run cannot succeed (issue #483).**
  A worktree the engine already classified disposable, still listed after its bounded
  retry AND the scoped `--force` fallback, now carries an additive
  `manualRecovery { message, commands }`: the message states the obstruction is
  deterministic, the commands are copy-pasteable and name that worktree's actual path.
  Transient-shaped entries keep the previous reading; no existing key or exit-code
  meaning changed.

### Changed

- **`Disclosure.iter` widens `number` → `number | null` at the package root — the
  heads-up (issue #489).** `null` is the wave-scoped form's not-applicable marker. Every
  row-scoped entry still parses and renders an integer, so no runtime behaviour changed
  for the existing form — but a root-only consumer doing arithmetic on `d.iter` now fails
  at compile time rather than reading a silent `null`. That loud failure is deliberate;
  the rejected alternative was an `iter: 0` sentinel hidden inside a numeric type.
- **The phase-3 close reference prescribes the sandbox-off force-removal as the ordinary
  path (issue #483).** Three consecutive closes proved the manual step is not the
  exception on a sandboxed harness — a fourth occurred while this release's own wave
  closed. One canonical sequence: sandbox-off `git worktree remove --force` per worktree,
  then `git worktree prune`; the `prune` + `rm -rf` variant is demoted to the fallback
  when force-removal itself fails. The step stays manual and privilege-escalating by
  design — the human stays in the escalation.
- **CONTEXT.md's Disclosure entry and ADR-0038** (`docs/adr/0038-a-find-is-captured-where-it-surfaces.md`)
  carry the full window: capture where the find surfaces, from verdict-routing through
  every close phase, measurement points pre-captured at routing, archive as the hard
  boundary.

### Not yet proven

- **`manualRecovery` has never been read live.** The wave that shipped it hit its own
  trigger (`erroredStillListed`, the fourth consecutive occurrence) with the pre-merge
  engine still running the sweep. The next close on a sandboxed harness is the field's
  first live read.
- **A consumer-side wave-scoped capture has not yet occurred.** The form is exercised
  live through the real CLI on scratch spines (worker and reviewer independently), and
  this repo's own close exercised the gate half on a row-scoped entry — but no genuine
  close-phase Coordinator find has ridden the new form end-to-end yet.
- **Bitbucket's write half remains unproven** (unchanged since 1.3.0; the read half is
  live-verified).

### Known issues

- **First `wave-start` on an installed-form consumer needs one manual `/flotilla:wave-shared`
  invocation (every release ≤ 1.4.0).** `wave-shared` declares `disable-model-invocation:
  true`, which removes it from what a model may load by name in any context — so the
  by-name load instruction wave-start and wave-close carried was never actually
  executable. Project-local this stayed hidden behind a working cwd read; the first
  fully-external consumer run hit it live and the operator had to invoke
  `/flotilla:wave-shared` by hand to get past it. Fixed going forward: the execution
  skills read `wave-shared` as a sibling file instead of loading it by name, so no
  release after 1.4.0 needs the workaround.

## [1.3.1] — 2026-08-11

The night after the Bitbucket landing host shipped, this release closes its first
field-reported gap, grades its one unstated precondition at the preflight, and settles —
in an ADR with a structural guard — the import-cycle precedent that check created on its
way in. Patch per ADR-0035: no export, config, or CLI *input* changes; the one additive
*output* change (a fourth preflight check) gets its own heads-up below because an
exhaustive `switch` in a consumer breaks on it.

### Added

- **`host-pr preflight` reports a fourth check on a Bitbucket host: `create-credentials`.**
  It grades `host-pr create`'s own precondition — the account-email half of the
  Basic-auth pair — by asking the create path's own helper (the predicate is "did it
  throw?", and the advisory quotes the refusal verbatim), so the check and the verb it
  predicts cannot drift apart. Advisory-never-fail: the landing verbs authenticate with
  Bearer and keep working; what refuses without the email is `create`, on every Worker
  terminator, after the work is done — which is exactly why it is worth knowing at
  preflight. Absent on non-Bitbucket hosts. **Heads-up: the exported `HostCheckName`
  union widens from three members to four — additive, but a consumer switching
  exhaustively over it stops compiling.** Not yet proven: exercised against synthetic
  environments only, never live Bitbucket — the adapter's write half still awaits its
  pilot wave.
- **The call-time-only cycle doctrine, settled and spec-guarded (ADR-0037).** An engine
  module may import an adapter-owned canonical fact when the alternative is re-spelling
  it (the parallel-rule drift class); the edge must be call-time-only in both
  directions; a second cycle — not the first — is the named trigger for extracting a
  shared leaf module. The one accepted cycle (`host-pr` ⇄ the Bitbucket adapter) now
  carries a load-order drift-spec: both load orders, each in a genuinely fresh module
  registry, asserting all four crossing runtime bindings. Falsified during development,
  not assumed — a temporary top-level read across one edge failed only the
  adapter-first order, the silent-in-production shape the spec exists to catch.

### Fixed

- **`credential-probe --all` discovers the Bitbucket credential** — the pilot's
  field-reported gap: the discovery list now imports the adapter's own variable name
  rather than not knowing it, so `--all` probes what the adapter actually resolves;
  a call-site drift spec guards the coupling.
- **The create-credentials advisory tells the truth about an empty email:** a
  SET-but-empty `BITBUCKET_EMAIL` used to be told it "is not set" — right consequence
  (the helper refuses empty exactly like absent), wrong fact. It now reads "is not set,
  or is set to an empty string", the wording is pinned by a spec assertion, and a
  maintenance comment binds the advisory's leading sentence to the helper's precondition
  set so a future second precondition cannot make it state a wrong fact while quoting a
  right one. Grading is unchanged on every path.

### Docs (plugin half)

- All four skill-doc enumerations of the host preflight now count **four** checks,
  naming `create-credentials` with its Bitbucket-only, advisory-never-fail semantics —
  the onboarding step, both setup-mechanics surfaces, and the close-mechanics reference.
- The wave-close phase-4a self-repair detection surface caught up twice: widened by the
  archive gates, the credential seam and three more modules, then by the disclosures
  gate's own module (`spine-store.ts`) — closing the gap where a wave fixing that gate's
  parser would have run its own archive gate on the pre-fix code, undetected. The
  maintenance comment now records that the two fail-closed archive gates live in
  different modules (correcting an inaccurate shared-module claim on the way).
- ADR-0029's consumer count catches up with the shipped adapters; ADR-0037 records the
  import-cycle precedent in full.

## [1.3.0] — 2026-08-10

The third release of one day, and the fastest field-report-to-shipped-feature arc yet:
the Bitbucket+Linear pilot ADR-0023 named in July ran its first live wave on 1.2.0, filed
the landing-seam refusal as its field report the same evening, and this release ships the
adapter that answers it. The package-root export surface and the `wave.config.json`
schema are untouched; minor per ADR-0035 — `host-pr` accepts a new host, an additive
relaxation of the CLI contract.

### Added

- **`host-pr` works on Bitbucket Cloud.** The blanket non-github gate becomes per-verb
  host routing. `create` runs the cross-host find-before-create/update path that had
  been shipped behind the gate all along — over the measured credential shape: an
  Atlassian API token paired with the account email (`BITBUCKET_TOKEN` through the
  ADR-0029 lookup seam, `BITBUCKET_EMAIL` beside it; app passwords are measured dead,
  not deprecated-someday). `status`, `merge`, and branch deletion ride a real
  `LandingHost` implementation against REST v2. `arm` throws the typed
  auto-merge-unavailable refusal on the **measured** basis that Bitbucket Cloud has no
  per-pull-request arming call — so `wave-close --auto` direct-merges the ready rows and
  the pending tail keeps the advisory merge-order. `preflight` reads the posture for
  real, including the `allow_auto_merge_when_builds_pass` branch restriction (read,
  never hardcoded) with host-aware grading — a visible `off` is advisory here, not a
  fail, because the setting names a UI affordance, not an engine capability. `unknown`
  hosts keep the loud, typed refusal on every verb. Mergeability is derived from
  Atlassian's own merge-check sentence: zero reported builds against a required minimum
  reads `blocked`, never `clean` — the check-attach latency window stays closed on this
  host. The ADR-0023 amendment records every measurement.
- **A find-before-create bug died on the way in:** the Bitbucket open-PR query had been
  URL-encoding `&state=OPEN` into the BBQL `q` expression, so the host rejected the
  query, "no open PR" was inferred, and every re-run against a Bitbucket repo would have
  silently opened a duplicate PR. The query now carries `state` as the documented
  first-class parameter.

### Fixed

- **The cross-host teaching texts stop teaching the pre-adapter world** (#464): the
  create-path notes in the shipped skill references now route a Bitbucket Worker
  terminator to `BITBUCKET_TOKEN` + `BITBUCKET_EMAIL` instead of `GITHUB_TOKEN`, and
  the merge-capability posture read leaves the vendor-deprecated unscoped permissions
  endpoint for the workspace-scoped one (no-evidence semantics unchanged).

### Docs (plugin half)

- The 1.2.0 entry's first Not-yet-proven item fell the same day it shipped: the unbound
  Document arms are live-verified from the second external consumer's workspace —
  ADR-0017's "one unproven spot" now records the verification, and the `[Internal]`
  annotation is documented as a visibility marker, not a functional reservation.

### Not yet proven

- **The Bitbucket writes have never run against a live workspace.** Every request shape
  is hermetic over the injectable seam and pinned to Atlassian's documented forms
  (OpenAPI and support pages, read in-dispatch); the two residual hazards are deliberate
  and commented at their points of departure (the merge body's omitted discriminator
  field, and the unpolled 202 merge task). The pilot's first wave on this release is the
  intended live reading — create, status, merge, and the `doneState` reconcile in one
  pass.
- #418 (`npm ci --prefix` failing spuriously in dispatched contexts) stays open and
  falsifiable, unchanged from the 1.2.0 entry.

## [1.2.0] — 2026-08-10

A minor release cut the same day as 1.1.0 — the delivery half of the facet-unlock wave
that landed hours after that release was tagged. The package-root export surface and
the `wave.config.json` schema are untouched. The change the version number is chosen
against (ADR-0035) is a relaxation on an exported class: the Linear store's Document
facet stops refusing to work without a project binding.

### Added

- **The Document facet works without a project binding.** On a Linear store with no
  `project` configured, `publishDocument` now parents the PRD Document on the
  configured **team** — where it previously refused to mint an orphan — and
  `listDocuments` narrows **server-side** to that team via the schema-verified
  `DocumentFilter.team` predicate, replacing an unfiltered workspace-wide listing.
  Both with-project paths are byte-unchanged. Driven by the second external consumer's
  team-central PRD-home decision, implemented upstream the same day. One structural
  consequence is stated everywhere the facet is taught rather than left implicit:
  Linear documents `Document.team` as null for any non-team parent, so the
  team-filtered panel can never return a *project-attached* Document — deliberately
  accepted by the team-central convention.

### Fixed

- **The DoR staleness advisory stops trusting mtime for tracked markdown issues.** The
  MarkdownFs store's tracker timestamp now derives from git history for tracked issue
  files (committer date, aligned with the staleness gate's own clock), keeps mtime for
  untracked scratch files, and stays absent where neither signal is derivable — so the
  advisory defers instead of false-passing on a fresh clone. Both edges 1.1.0's entry
  put on record as #443 are closed by this.
- **`cleanup.extraRoots` reaches the detached sweep from the config.** The key
  `config validate` accepted and the docs taught was never threaded from `--config`
  into the `worktree-cleanup` CLI's `--detached` sweep — a config-declared containment
  root now takes effect with no further wiring.

### Docs (plugin half)

- **The Reviewer's sibling tips ride per-sibling named refs.** 1.1.0 left the
  per-sibling tip reads on `FETCH_HEAD` as an undecided question (#445); the answer is
  the fix: the literal leaves the last two teaching sites, and the drift pin inverts —
  it now fails on a `FETCH_HEAD` read *appearing*, not on the named-ref form missing.
- **README and ONBOARDING rebuilt consumer-first.** Live version/CI badges replace the
  hardcoded status line — the drift class that went stale after every release now has
  no number left in the file to drift. The pipeline and the two-layer architecture
  become diagrams, every skill is tabled with its phase (the `report` skill reaches
  the README for the first time), and ONBOARDING's adoption path and preconditions
  wall become tables — doctrine unchanged throughout.
- **The facet-unlock text debt is cleared.** `wave-setup` unlearns the removed
  publishDocument refusal, `cleanup.extraRoots` joins the authoring-time config table,
  the team-null consequence is stated at every teaching site, and the `save_document`
  citation names its real source (the tool description Linear's MCP server serves —
  no stable public URL, so the comment says so; re-verified verbatim,
  schema-corroborated).

### Not yet proven

- **The unbound Document arms have never run against a live Linear workspace.** Every
  spec is hermetic over the HTTP fake; the published schema read pins both shapes
  (`DocumentCreateInput.teamId`, `DocumentFilter.team`). The first live exercise
  should publish one PRD from an unbound consumer and confirm the team-filtered
  listing returns it — the second external consumer's onboarding is the intended
  first reading (ADR-0030 disclosure, carried in the row's review).
- The loud `STILL OPEN:` close line remains unread in anger — this release, too,
  resolves no still-open issue at the playbook's step-7 close.
- #418 (`npm ci --prefix` failing spuriously in dispatched contexts) stays open, now
  falsifiable: the stray `$HOME` npm project the probe matrix suspected was moved out,
  and the issue carries the prediction that the failure does not recur. A future
  dispatched context proves or refutes it.

## [1.1.0] — 2026-08-10

A minor release. The package-root export surface and the `wave.config.json` schema are
untouched; what grows is the CLI's *output* surface — and per ADR-0035 the CLI is now
the explicitly-named third semver contract, with everything here additive against it.
The theme: the engine stops keeping its judgments to itself. Pre-dispatch staleness,
close-time end-states, advisory numbers and coverage denominators are now said out loud
where an operator — human or agent — actually reads them.

### Added

- **The DoR gate learns staleness.** A row whose declared `Files` have seen `main` move
  since the issue's last tracker update now draws an advisory naming the drift — the
  premise-currency check that until now lived only in an operator's discipline.
  Advisory, never a gate-fail: the gate still passes, the operator decides. Two edges
  are on record as #443: the MarkdownFs store derives the tracker timestamp from file
  mtime (a fresh clone reads as current where a defer belongs — the GitHub and Linear
  stores read API metadata and are unaffected), and one defer path carries no
  regression spec yet.
- **`issue-store close` reports the native end-state loudly.** After recording
  `Closed-by:`, close re-probes the tracker and prints the resulting closing state; an
  issue that is natively still open earns an unmistakable `STILL OPEN:` line on stderr
  naming the id and the recorded PR. The silent exit-0 that twice let a
  release-resolved issue stay open unnoticed (#339 at 1.0.0, #397 at 1.0.1) cannot
  recur silently.
- **The CLI surfaces the advisory numbers the engine already computed** — per-string
  advisory indices and the dry-run population — instead of swallowing them.
- **The GitHub store reads `blockedBy` as the union of the body-codec and GitHub's
  native issue dependencies, and mirrors writes back natively** — the read-union the
  Linear adapter shipped with from day one, now on both tracker adapters. The mirror's
  operating envelope (secondary rate limits, per-call API cost) is documented rather
  than throttled.
- **A new consumer-side skill: `report`.** A consumer repo's agent that has fully
  analyzed a finding about flotilla itself can file it upstream at flotilla's own repo
  in the house format — prose-only, and consent-first: it never files without the
  human's explicit go.
- **Convention 12's silent half gets a structural tier.** The tarball ships a second
  PreToolUse guard beside the echo-guard (`hooks/conv12-guard.cjs`): it blocks unquoted
  `$VAR` expansions on the Coordinator surface before they run — the class where zsh's
  no-word-split turns a command held in a variable into a silent no-op behind a
  true-reading success echo.
- **The Reviewer's sibling merge-tree prediction names its coverage denominator**, so
  "no conflicts predicted" is legible as full or partial coverage. Its
  branch-under-review diff base now rides a stable named ref with a SHA assert —
  `FETCH_HEAD` is never read for it. The per-sibling tip reads deliberately remain on
  `FETCH_HEAD` at advisory-only stakes; on record as #445, undecided between fix and
  documented acceptance.

### Fixed

- **A prerelease publishes under the `beta` dist-tag instead of `latest`.** The release
  workflow derives the dist-tag from the version string, so a future beta can no longer
  shadow the stable line for every plain `npm install`.
- **A failed Scribe-payload removal reaches the worktree-cleanup exit code** instead of
  disappearing inside a green sweep.
- **Wave scratch directories are created owner-only, and the planning-pass path is
  session-scoped** rather than a fixed name in a shared tmp.
- **Shipped-text currency, three passes.** Five lines a wave's own changes had made
  false were returned to true; unlabeled canonical-spec citations left five engine
  modules; the drift-guard's command-line advisory subsection attributes its own
  failures. The resolution guard now covers the prose shape as well.
- An accidental `node:path` re-export left the DoR-gate module, together with the
  barrel-drift allowlist entry that excused it — module-local either way; the package
  root never carried it.

### Docs (plugin half)

- The doctrine grill of 2026-08-09 landed three ADRs and an amendment: the
  enforcement-tier ladder with its promotion triggers (ADR-0034), **the CLI as the
  third semver contract** (ADR-0035 — the contract this release's version number is
  chosen against), the claim-safe `awaiting-human` gate (ADR-0036), and
  simulable = executable at both Check-6 sites (ADR-0030 amendment).
- Operator docs caught up across the back half: worktree-cleanup's exit fold, scratch
  preview and dry-run discipline; the Convention-13 catalog's loop shape and
  script-file remedy; the scratch sweep in `wave-resume` and the gitignore scaffold
  route in `wave-setup`; the unified store-preflight verb; the release playbook's
  step-7 close procedure. CLAUDE.md now names the `report` skill.

### Not yet proven

- The loud `STILL OPEN:` close line has passed its specs but has not yet been read in
  anger — and this release cannot read it: no open issue is resolved by this publish,
  so the playbook's step-7 close has nothing to close this time. The first live
  reading waits for the next release that ships a fix whose issue is still open.
- One operational report stays open and unreproduced after a six-probe matrix (two
  filesystem locations × three npm versions): `npm ci --prefix` failing spuriously in
  dispatched contexts (#418). The capture playbook on the issue is the current state
  of knowledge.

## [1.0.1] — 2026-08-01

A patch release, and the **delivery half of work that was already done**: every fix below
landed on `main` before this release existed, which means a consumer installed at 1.0.0
has been running without them the whole time. The package-root export surface and the
`wave.config.json` schema are untouched — this release adds no public API and removes
none.

Most of it comes from the first external consumer's field reports.

### Fixed

- **The echo-guard's refusal no longer sends the reader to a path only this repository
  resolves.** The shipped `PreToolUse` hook rejects a credential-echo command with a
  teaching message; that message cited a source-form skills path that does not exist in
  an installed form, so the one reader it is written for could not follow it. The refusal
  now carries its reason inline instead of pointing anywhere.

- **The shipped hook module's own documentation stopped describing only the repository it
  was written in.** Its paste-ready `hooks.PreToolUse` block and the verify line beneath
  it named flotilla's vendored guard path unqualified; both now name the consumer's own
  scaffold destination, with flotilla's repo recorded as the documented exception it
  already is elsewhere. The same docstring also still announced that the consumer scaffold
  was *not* shipped, while the setup reference recorded that gate as met — the shipped
  artifact contradicted the shipped documentation about its own distribution.

- **Ten dead header pointers left the shipped engine sources.** Comment lines citing
  canonical specs, PRD sources, audit sources and playbooks under directories that have
  never existed in this repository — and that reach no consumer's tarball under any
  circumstances. A resolution guard now keeps them out. It asks *does this document
  exist* rather than matching a list of banned directories, so it does not go stale
  against the next tree that gets retired, and it now covers spec files as well as
  shipped sources.

- **`wave-plan` stopped claiming more than it can know.** Its PRD panel flagged a
  fully-shipped PRD identically to a never-sliced one; the flag now states what it
  actually derives and prescribes a *check* rather than a slice. Its `blockedBy` guidance
  now warns that the field is a union whose `'none'` sentinel has a length of four — so a
  bare `.length` reports four blockers for a row that has none, and reads as internally
  consistent beside a genuine count.

- **The awaiting-human archive gate no longer cites an ADR that does not describe it.**
  The citations now point at the reference that actually documents the gate; the many
  correct citations of that same ADR, which are about the Worker vocabulary, are
  untouched.

### Changed

- The onboarding walk-through teaches the setup-time engine binding instead of call-time
  resolution, at all three sites that taught the old model, and its allowlist guidance
  names the form the scaffold actually writes rather than the exploration-only one. The
  exploration form is still documented — with its lack of pinning and its cost — as what
  it is. The beta framing is gone.

- The charter names the conflict map's structural boundary: the dependency class where
  resolving one piece of work reshapes *what another piece even is* is invisible to the
  map, because the second piece does not exist at check time. That is the edge of the
  promise, not a defect.

### Not yet proven at release — since verified

- **The consumer-facing hop of the guard fix has been simulated, not observed.** During
  review it was exercised end to end by packing the engine, installing it into a
  throwaway repository outside this tree, and running the scaffold's copy and verify line
  verbatim — the guard refused as expected. What has *not* happened is that same path
  through a **published** install of this version: fetching 1.0.1 from the registry into
  a real consumer repository and reading the message there. That check belongs to a human
  after this release is published.

  **Verified 2026-08-01, after the publish.** That exact path was run against the
  published artifact — `npm install` of `1.0.1` from the registry into a throwaway
  repository, then the shipped header's own copy and verify lines verbatim: the guard
  refused with exit 2, and every path the shipped docstring names resolves in that
  repository. The same run against `1.0.0` reproduced the defect this release fixes and
  surfaced one more instance of it than was known: `1.0.0`'s refusal message ended by
  citing a doctrine file under `.claude/skills/`, a tree the tarball does not ship at
  all — a dead pointer in the one place a consumer meets this text at runtime rather
  than by reading a file. Both versions refuse identically, so the fix was legibility
  only, exactly as claimed. Recorded in full on issue #397.

## [1.0.0] — 2026-07-31

The first stable release. What changes with the number: **the package-root export
surface and the `wave.config.json` schema are now semver contracts** — from here,
removing or reshaping either is a major bump. What made the freeze possible is that the
surface is now *deliberate*: every engine module export is either public at the package
root or named on a reason-carrying module-local allowlist, and a drift spec fails on any
symbol that is neither.

### Added

- **The deliberate public API.** ~85 previously root-unreachable symbols are exported
  on purpose — the `IssueStore` contract itself, `GitHubIssuesStore`, `MarkdownFsStore`,
  `RealGitHubApi`, the host-pr landing family, and the route/config/DoR CLI runners among
  them. An installed-form consumer imports the engine's real seams by name instead of
  reaching through module paths.
- **Barrel-drift guard**: a spec comparing every source module's exports against the
  package root via TypeScript-compiler **symbol identity** (not name matching, which two
  real re-export/alias cases in this repo would defeat), with permanent negative
  controls. A new module with neither barrel nor allowlist coverage fails loudly, naming
  module and symbol.
- **Reuse-refusal semantics reach the caller docs** (plugin half): `host-pr create`'s
  close-phrase guard (`reuse-refused`) is documented at both PR-opening call sites, with
  the exit-code interpretation that keeps a refused rewrite from reading as success —
  the refusal payload deliberately still carries the PR URL, and a later existence
  re-query is not proof the rewrite landed.
- **Compose-currency rule** (plugin half): a composed workflow driver is coupled to the
  document it was extracted from — compose fresh, or walk the seeded currency-assertion
  checklist before reuse; the dispatch mechanics carry it as a named gate step, with
  host-side anchor-resolvability beside it (a fabricated SHA fails once at compose, not
  in every brief).

### Fixed

- **The verify-profile scaffold pins both halves of resolution** — the binary
  (lockfile-pinned local form) *and* the discovery root — with a live measurement of
  what each half's absence does (a registry-fetched runner at a different version; a
  repo-root test-file sweep failing the suite). The three-occurrence recurrence arc is
  recorded: a prose warning demonstrably does not close this class; the profile itself
  must name the pinned form.

### Not yet proven

- The stable contract covers the engine package root and the `wave.config.json` schema.
  The plugin's skill prose is versioned in lockstep but keeps evolving at minor cadence —
  it is operating guidance, not API.
- The beta line was exercised by one external consumer stack (Linear store, nested Node
  tree) across live waves; the 1.0.0 surface as frozen here has not yet been imported by
  an external consumer.

## [0.1.0-beta.2] — 2026-07-31

The release that makes the **bundled echo-guard current** — and the floor version for
the stage-2 guard scaffold. beta.1's tarball shipped `hooks/echo-guard.cjs` from before
the family-3 quote-nesting carve-outs: the scaffold's `cp` succeeded and silently
installed a materially weaker guard (present-but-stale, the failure mode the scaffold
docs only half-covered). This release ships the current guard, and the scaffold now
names the stale case and pins this version as the minimum for the guard copy.

### Fixed

- **Bundled echo-guard is current** — includes the quote-nesting state machine (an
  embedded quote inside a quoted substitution wrapper no longer re-exposes trailing
  prose) and the dead-code removal.
- **The Worker brief's PR-URL capture recipe is executable again** for dispatched
  roles: the primary form is the read-only `host-pr status` re-query whose exit
  status is the verdict; the file-based fallback survives only in its variable-free
  spelling. (Measured: shell state — variables, functions, cwd — persists for no
  dispatched role between Bash calls, and an `isolation: worktree` dispatch refuses
  any `$VAR` expansion in any position.)
- The Scribe brief no longer rests on incidental cwd safety (observe-never-set; all
  path arguments absolute and shell-quoted); the Reviewer dispatch binds to the row's
  model tier instead of inheriting the session model.
- Every worked `dor` call-site threads `--config`, so the verify-profile-coverage
  gate returns real verdicts in live waves instead of deferring.

### Added

- **Package-root surface:** the store-preflight family, the typed create rejection,
  and the command-line E2BIG advisory family are importable from the package root.
- **Command-line E2BIG advisory** beside the worktree-count advisory — models the
  exec-argument total *and* the per-string limit, reported apart.
- **Allowlist reconciliation guard:** a spec-level check diffing the tracked
  permission allowlist against the verify gates in both directions.
- **Skill-pipeline guidance** (plugin half): risk-routed reviewer model tier,
  disclosure disposition defaults (triviality predicate, thematic bundles),
  premise-currency verification at triage with pull-triggered cadence, the
  coordinator-direct boundary (Convention 15), a per-set dispatch-cost estimate in
  wave-plan with a foreground carve-out, and a measured verify-command baseline
  recorded at wave-setup.

## [0.1.0-beta.1] — 2026-07-30

The release that makes the **npm-first invocation form operational**. Every skill's
engine-CLI resolution block states the published-package form first (`npx
@formtrieb/flotilla-engine`, ADR-0031), but `0.1.0-beta.0` predates the credential
seam entirely: on a consumer using the keychain indirection it could not resolve a
credential and therefore could not execute the landing seam at all. This beta closes
that gap; the vendored in-repo form remains the documented fallback.

### Added

- **Per-project credential resolution (ADR-0029).** Credentials resolve lazily through
  a per-project lookup command — `<VAR>_CMD` environment variables
  (`GITHUB_TOKEN_CMD`, `LINEAR_API_KEY_CMD`) name a command whose stdout is the
  secret (OS keychain, any secret manager). A configured command wins over the ambient
  variable and fails loud; the ambient variable remains the fallback when no command
  is configured. One resolver module serves both tracker stores and the host seam.
- **`credential-probe` verb** — the value-free AFK preflight: probes each configured
  lookup command (exit status only, never the output) so a broken or prompting
  resolver surfaces before dispatch instead of mid-wave.
- **`hooks/` in the published tarball** — the PreToolUse Echo-Guard
  (`hooks/echo-guard.cjs`), the structural speed bump against credential-echo forms
  in Bash commands; a packaging spec now pins every runtime directory into the npm
  file set so a shipped directory cannot silently drop out again.
- **Documented-form comparison types re-exported from the package root (ADR-0030)** —
  the `documentedFormComparison` verdict types are importable without deep paths.

### Notes for consumers

- With this release the dual-form resolution blocks' npm-first ordering is
  operationally true on credential-indirection consumers. `0.1.0-beta.0`'s known
  failure shapes there — `credential-probe` as an unknown subcommand and
  `host-pr create` failing with a missing-token error despite a configured keychain
  lookup — are resolved by upgrading.

## [0.1.0-beta.0] — 2026-07-27

The first public release. flotilla has existed and been used to build itself for some
time; what is new here is that it is **installable by someone else** — the engine as a
package on the public registry, the skills as a Claude Code plugin, rather than a
directory to be copied by hand.

This is a beta because the distribution is new, not because the orchestration is. The
pipeline has been driving flotilla's own development across thirty-plus live waves; the
install path in front of it is what has not yet been walked by a stranger. See
*Not yet proven* below for exactly which parts that qualifier applies to.

### Added

**Distribution**

- `@formtrieb/flotilla-engine` on the public npm registry, published from CI through
  npm trusted publishing (OIDC) — no long-lived registry credential exists in the
  repository, and the package is configured to refuse token-based publishes entirely.
  Releases carry a provenance attestation linking the artifact to the workflow run and
  commit that produced it.
- A Claude Code plugin manifest (`.claude-plugin/plugin.json`) exposing the full skill
  set and the Reviewer agent, plus a marketplace manifest
  (`.claude-plugin/marketplace.json`) so the plugin is installable by name.
- The skills resolve the engine CLI through the published package rather than a
  relative path into a vendored checkout, which is what makes them work from an
  installed plugin at all.

**Orchestration pipeline**

- Planning skills — `triage`, `to-prd`, `to-issues` — turning a raw idea or bug report
  into wave-eligible issues that carry a declared file scope.
- Wave lifecycle skills — `wave-setup`, `wave-plan`, `wave-create`, `wave-start`,
  `wave-reviewer`, `wave-close`, `wave-resume`.
- Universal Reviewer dispatch: every row is reviewed before its PR opens, and the
  verdict is schema-validated rather than free prose, so routing to
  approve / request-changes / stop is deterministic instead of inferred.
- Worktree-isolated Worker dispatch with schema-validated reports, a cap of one
  re-dispatch per row, and `needs-attention` as the terminal state for a row that
  stopped.

**Engine**

- `computeConflictMap` — wave-agnostic glob-set math answering whether a candidate wave
  can run alongside everything already queued or in-flight. This is the part that is
  meant to outlive any particular tracker or stack.
- `files-drift` as the runtime guarantor that an issue's declared globs actually held.
- DoR (definition-of-ready) gating, advisory merge-order computation, and the coarse
  status projection (`available → queued → in-flight → in-review → done`, plus an
  orthogonal `needs-attention`) written back to the tracker.
- `SpineStore` — the per-wave orchestration spine as durable local markdown, which is
  the write-ahead log `wave-resume` reconstructs from when a Coordinator is killed
  mid-wave.

**Trackers**

- Three `IssueStore` implementations — `MarkdownFsStore` (local dev and dogfooding),
  `GitHubIssuesStore`, and `LinearIssuesStore` — with one conformance suite that passes
  unchanged across all three.

### Notes for consumers

- **The engine ships raw TypeScript and has no build step.** The `flotilla-engine`
  binary handles this for you. Importing the package programmatically does not: it
  requires a TypeScript-aware loader in the host process, and there is no compiled
  entry point to fall back on. This is a deliberate design choice, not an omission.
- Node `>=20.11.0`. Publishing a release additionally requires npm `>=11.5.1`, which is
  above what Node 22 bundles — the release workflow installs it explicitly.
- The published tarball contains only what a consumer executes: sources minus specs and
  fixtures, the binary, `LICENSE`, and `README.md`.

### Not yet proven

Stated plainly, because a beta that hides this is worth less than one that does not:

- The end-to-end live gate for the GitHub-Issues adapter **through the installed plugin
  and published package** has not been run yet ([#83](https://github.com/formtrieb/flotilla/issues/83)).
  Every wave to date drove the adapter from an in-repo checkout. The adapter itself is
  exercised; the install path in front of it is not.
- ~~`README.md` and `docs/ONBOARDING.md` still describe the vendor-copy adoption path and
  not the plugin install~~ — rewritten after this release
  ([#84](https://github.com/formtrieb/flotilla/issues/84)). Note that the published
  `0.1.0-beta.0` tarball still carries the older `README.md`; the repository does not.
- Cross-skill references are still by bare name, which is not what plugin distribution
  namespaces them to ([#81](https://github.com/formtrieb/flotilla/issues/81)).
- Automatic worktree cleanup skips any worktree the agent harness has written into,
  which is all of them in practice — cleanup currently happens by hand
  ([#111](https://github.com/formtrieb/flotilla/issues/111)).

[0.1.0-beta.1]: https://github.com/formtrieb/flotilla/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/formtrieb/flotilla/releases/tag/v0.1.0-beta.0
