# flotilla

The ubiquitous language of flotilla — a Claude-Code-native wave-orchestration toolkit. This file is a glossary, not a spec; it captures what each term *is*, not how it works.

## Language

### Identity

**IssueView**:
The engine's canonical, tracker-agnostic view of one issue. The adapter's whole job is `read(id) → IssueView`; the engine never knows where the issue came from.
_Avoid_: ticket, card, task, HeaderBlock (the narrower term the Ur used for it).

**wave Header-Block**:
The wave-orchestration metadata flotilla authors on an issue so the engine can plan it — `Files` (the conflict-map globs), `Risk`, `Worker`, the optional `Parent` backlink (to the **PRD** a slice came from), plus `Blocked-by` and the acceptance criteria. It lives on the tracker issue (body `## Files` + `risk/*`/`worker/*` labels), round-tripping through `IssueView`. `to-issues` writes it (create-mode) or adds it to an existing triage-ready issue (decorate-mode) — ADR-0010.
_Avoid_: frontmatter, metadata (unqualified).

**id**:
The opaque, tracker-native, human-visible identifier of an issue (`"412"` on GitHub, `"ENG-123"` on Linear, `"<slug>#NN"` on MarkdownFs). The engine treats it as an opaque key and never parses, orders, or assumes a format for it (ADR-0001).
_Avoid_: number, key, uuid, nodeId.

**slug**:
A human-readable, cosmetic name component of an issue, used only to decorate branch and sidecar filenames; it is sourced from the spine row and is never a key.
_Avoid_: identifier, name (as a key).

**Risk**:
An issue's risk class (`mechanical · isolated-refactor · cross-feature-refactor · public-API-change`) — a **load-bearing routing key**, not just a validated enum: its string drives the dor-gate file-count heuristics and the `public-API-change` hard-STOP (ADR-0007). It does **not** select a reviewer profile — flotilla's **Reviewer** is universal, so the spine's `Reviewer` column is a uniform, vestigial decoration (a deliberate de-coupling from the Ur's `quick-verify`/`full-review` tiers).
_Avoid_: severity, priority.

**worker (assignment)**:
The `IssueView.worker` field — which kind of agent an issue is dispatched to. **Autonomy-first and brand-free** (ADR-0012): `background · background-heavy · foreground · HITL-required`. The load-bearing axis is **autonomy** (background = autonomous AFK · foreground = human co-pilots in chat · HITL-required = no agent until a human acts); the secondary **model tier** is the abstract `-heavy` marker only — `heavy → <concrete model id>` binds in the driver config, never in the tracker label. `HITL-required` is still an eligible wave candidate (a *work step*, unlike a **PRD** which is a *document*), human-gated and surfaced by `wave-plan`. Distinct from the **Worker** runtime agent it selects (see "Flagged ambiguities").
_Avoid_: model-brand worker names (`background-sonnet` etc. — the frozen predecessor set from the Ur, ADR-0012).

### Planning

**PRD (Planning Document)**:
A planning artifact published to the tracker but deliberately **not** a wave issue — it carries no wave Header-Block, no Risk/Worker/Files, and no **Eligibility** marker, so it never enters `listOpen('wave-ready')`. It is the durable reference point a wave is sliced *from*, not a grabbable unit; "a PRD is a PRD" — the slices are where the wave work begins. The store mints and reads it through a separate **Document facet** (`publishDocument` / `readDocument` / `listDocuments`), identified by a `prd` label (GitHub) or a `prd.md` beside the slug's `issues/` dir (MarkdownFs), or a native **Document** (Linear — categorically not an issue, so the no-`listOpen` constraint holds structurally; ADR-0017). Published by `to-prd`, sliced by `to-issues`, surfaced by `wave-plan` in a separate panel (never as a candidate).
_Avoid_: issue, slice, ticket (a PRD is none of these — those are grabbable wave units); spec (a PRD is the published artifact, not the discussion).

**Parent**:
A slice's backlink to the **PRD** it was sliced from — the PRD's **opaque id string** (ADR-0013), a **single** value in the wave **Header-Block**, written by `to-issues` on each slice (in create- *and* decorate-mode — ADR-0011/0012). Unlike **Blocked-by** (a structured `IssueRef` the engine must *resolve*), `Parent` references a *document's identity*, so it is the raw opaque id — never parsed, never an `IssueRef` (a markdown PRD's `<slug>#prd` id isn't `IssueRef`-representable anyway). It is the single source from which a PRD's *consumed* status is **derived** (consumed iff ≥1 issue's `Parent` equals the PRD id — exact string match, never a written state); on GitHub the backlink also renders the forward cross-reference for free. The slice→PRD graph is a **forest** (one parent per slice); a PRD is **never** a `Blocked-by` entry — `Parent` is the only slice→PRD relationship.
_Avoid_: epic-link, forward-link (we never write PRD→issue links — they are derived), consumed-state (there is no written state); parent-as-blocker; parent-as-IssueRef (it is an opaque id string, ADR-0013).

### Orchestration

**Wave**:
One batch of independently-grabbable issues dispatched as parallel workers in isolated worktrees, reviewed, and landed via PRs.

**Spine**:
The durable, repo-local `WAVE.md` markdown that holds the wave's orchestration state (plan-table, conflict-map, dispatch-log, PR-log). It is branch-local and the source of truth for resume; it never lands on `main`.
_Avoid_: manifest, state file, ledger.

**Coordinator**:
The (mostly-idle) foreground session that plans a wave and spawns/supervises its workers. Human-in-the-loop STOPs pause it.

**Worker**:
A background agent that executes one issue in its own isolated `/tmp` worktree and reports back via a schema-validated return.

**Reviewer**:
The independent agent that re-runs the verify gate and judges a worker's output, returning a schema-validated verdict.

**Sidecar**:
A worker's durable on-disk artifact (its report, the reviewer's verdict). The spine is the flat file `.flotilla/waves/<slug>.md`; the sidecars live in the sibling subdir `.flotilla/waves/<slug>/reports/` and `.flotilla/waves/<slug>/verdicts/`. The resume flow derives those dirs from the spine path **by convention** (no stored `sidecarRoot` field). Filename and format are engine-owned (written and read by paired engine verbs, never hand-formatted); a sidecar is written by a **Scribe** the moment the work it records exists. Together with the worktree's committed work it is authoritative for resume — "disk beats a non-landed spine flip".
_Avoid_: log, output file.

**Scribe**:
The cheap dispatch-loop stage that persists an agent's schema-validated return as a **Sidecar** immediately at agent-return — before any Coordinator routing — by invoking the engine's write verb with the already-validated payload. A Scribe writes the durable record; it never re-derives, re-types, or judges content. Its failure is loud but never discards the in-band return.
_Avoid_: logger, archiver.

**Amend**:
The intent-shaped change of an issue's *authored content* — its title and its free-prose body sections — through the **IssueStore**, upsert-by-heading, everything unmodeled preserved. Deliberately narrow: the modeled surfaces each keep their own verb (the wave Header-Block fields → decorate/annotate, triage state and comments → the Triage facet, claims → the ledger), so an amend can never silently clobber a managed list. A full re-scope is the *composition* amend + annotate, not one call.
_Avoid_: update/edit (say which surface), body replace (never whole-body).

**Definition of Ready (DoR)**:
The pre-dispatch gate that proves a wave-eligible issue is grabbable *now* — header valid, files-scope sound, acceptance criteria coherent, dependencies resolvable. Its checks fall into three classes by what each one needs: **self-content** (only the issue's own fields), **working-tree** (a repo checkout), and **cross-issue** (the *other* issues in play). It runs both on a markdown file and on a bare tracker id, store-blind (ADR-0014).
_Avoid_: validate (overloaded with the reviewer's verify gate).

**Deferred (gate outcome)**:
A DoR check whose data source is absent in the current context — neither pass nor fail, and not a warning. A bare tracker id has no checkout, so the working-tree checks defer; they are re-run later (at wave-create, where a worktree exists). Deferral is keyed on the missing *capability*, never on which tracker the issue came from (ADR-0014).

**Arming**:
Delegating an approved wave PR's completion to the code host: flotilla enables the host's server-side auto-merge (or merges an already-clean PR directly, after the same confirm) through the engine host seam — it never pushes `main` itself, and it does not wait (**arm-and-exit**); `done` reconciles on the next wave-close/resume touch (ADR-0023).
_Avoid_: auto-merge (the host feature is the mechanism; arming is flotilla's act), merging main (flotilla never does that).

**Partial-arm**:
The `--auto` confirm's shape: exactly the rows in **no** Conflict-Map pair are armed; the overlapping tail keeps the recomputed advisory merge-order as the human playbook. One confirm per wave; a headless run requires explicit pre-authorization (ADR-0023).
_Avoid_: arm-all (rejected — converts predicted overlaps into needs-attention noise), hard disjointness gate (rejected — forfeits the mixed wave).

### Triage

The issue's pre-wave lifecycle, owned by the triage role. A **durable classification dimension**, orthogonal to the claim ledger — `ready-for-agent` stays attached even after the issue is closed, recording "this was an AFK-agent task". Its **shape** (a single-select state-machine with eligibility-marking terminal states) is flotilla's; its **vocabulary** is the consumer's — shipped as an overridable `DEFAULT_TRIAGE_SCHEMA` (the 5 states below + `bug`/`enhancement` categories), mirroring `DEFAULT_WAVE_SCHEMA` (ADR-0015). The states are written and read through the **Triage facet**, tracker-agnostically.

**Triage facet**:
The tracker-agnostic seam the `triage` skill writes through — `readTriage · applyTriage · closeUnplanned` on the `IssueStore`, parallel to the **Document facet** (ADR-0011/0015). **Single-select and intent-shaped**: the skill passes canonical roles, the adapter computes the native realization (GitHub label add/remove · Linear label add/remove — state only for `unplanned`→`Canceled` and the Triage-inbox cosmetic, ADR-0020 · MarkdownFs status line), so no tracker mechanic leaks into the contract. It replaces triage's former raw-`gh` coupling and gives it the conformance-suite guardrail `to-issues` already had. The wave-routing core stays **eligibility-blind** — it reasons over the triage states *only* through the opaque Eligibility OR-set; the full vocabulary is known/typed so **analytics** (triage-funnel, automation-rate, cycle-time) can read it via the facet — never via `IssueView.status`. The AI-provenance disclaimer is prepended by the facet, not the skill prose (structural, not forgettable).
_Avoid_: triage-store (it is a facet of `IssueStore`, not a separate adapter); gh-edit (the raw coupling it replaces).

**needs-triage**:
A filed issue still awaiting a maintainer's evaluation.

**needs-info**:
Blocked pending clarification from the reporter.

**ready-for-agent**:
Fully specified and wave-eligible — the durable stamp that an issue is an AFK-agent task; it is the gate that lets an issue enter a wave.

**ready-for-human**:
Triaged and actionable, but to be done by a human *entirely outside* flotilla's wave system — **never enters a wave**. Distinct from the `HITL-required` **worker** (ADR-0012), which *is* wave work (surfaced by `wave-plan`), merely human-gated. The separating test: *does the wave system track/surface this work at all?* No → `ready-for-human`; yes (even if human-gated) → `ready-for-agent` + a human-in-loop worker. See "Flagged ambiguities".

**wontfix**:
Will not be actioned.

### State

**Fine state**:
One of the engine's 11 coordinator-internal issue states (`planned → dispatched → report-in → reviewing → verdict-in → re-dispatched → approved → pr-created → failed → abandoned`, plus the claim-releasing terminal `parked` — ADR-0022), held in the spine.

**parked**:
A terminal fine state meaning "deliberately taken out of *this* wave — will be re-planned into a future one". Entered only from `planned` (held before dispatch) or `failed` (STOP disposition); releases the claim immediately so the issue returns to `available`; passes wave-close silently (no needs-attention flag — the deliberate counterpart to the alarm terminals); has no un-park — re-entry is a fresh row drawn by a future wave (ADR-0022). Distinct from `abandoned` ("will never be done in this line" — keeps its claim until a human dispositions it, flagged at close).
_Avoid_: deferred (that is the per-gate DoR result, ADR-0014), held (implies the claim is retained — it is released).

**Coarse state**:
The kanban projection written to the tracker so humans and concurrent waves can see what is claimed: the ledger `queued → in-flight → in-review`, bookended by the derived `available` and `done`.
_Avoid_: status (overloaded — see "Flagged ambiguities").

**needs-attention**:
An orthogonal attention flag (not a ledger rung) meaning "a human must look at this"; set on a STOP or terminal failure (a re-dispatch-cap-exhausted verdict, a PR closed without merge, a corrupt/orphan sidecar at resume), cleared on resolution, and carrying a kind+options payload — the bridge to headless-async resolution (ADR-0006). Written through the **IssueStore** (a needs-attention facet, parallel to the Triage/Document facets), so the flag and its payload are tracker-visible to humans and concurrent waves.
_Avoid_: blocked, failed (those are fine states or triage outcomes).

**Claim**:
A coarse-state write to the tracker that reserves an issue for a wave: `queued` is a soft claim (do not re-plan), `in-flight` is a hard claim (do not double-dispatch). The native realization is the adapter's: GitHub = `wave/*` labels; Linear = the workflow state itself (`Todo / In Progress / In Review`, config-mapped — the board is the ledger, ADR-0020). flotilla **writes only `queued / in-flight / in-review` (+`needs-attention`)**; `available` (eligible & unclaimed) and `done` (natively closed — `Closes #N` on GitHub, merged-PR attachment/state on Linear) are **derived bookends**, never written (ADR-0003/0005).

**Eligibility OR-set**:
The consumer-configured set of issue labels that make an issue wave-grabbable — an issue is wave-eligible iff it carries **at least one** of them. flotilla treats them as opaque membership tokens (default `{ready-for-agent}`); the issue taxonomy itself is the consumer's, the `wave/*` ledger is flotilla's product (ADR-0003).
_Avoid_: ready-label (singular — it is a set, OR semantics).

### Provenance

**Ur**:
The frozen predecessor system flotilla was seeded from and generalized against. It keeps its own bindings (markdown-as-tracker, unprotected-`main` rituals, harness couplings) and is *not* a model to copy — reaching for an Ur habit is the signal to reach for the generic seam instead. The engine (`tools/wave`) is the only surface kept in sync with it.
_Avoid_: the predecessor's clear name (client-confidential; it lives only in the private archive and the gitignored de-client denylist).

**wiki pilot**:
The consumer candidate M1 originally targeted (a GitHub + GitHub-Issues repo); retargeted away before the live gate ran. Survives in ADR narratives as the historical first target.
_Avoid_: the consumer's clear name (client-confidential).

**server pilot**:
The consumer the M1 §6 live gate actually ran on (a Linear team + GitHub server repo — one real wave, end-to-end to merged PRs). Distinct from flotilla's own self-consumption: the subsequent hardening waves ran on flotilla itself.
_Avoid_: the consumer's clear name (client-confidential).

## Relationships

- An **IssueView** is keyed by its **id**; its **slug** decorates derived names but is never a key.
- A **Wave** plans many **IssueView**s into a **Spine**; the **Coordinator** dispatches one **Worker** per issue and one **Reviewer** per worker.
- Every **Fine state** projects to exactly one **Coarse state** rung — except the claim-releasing `parked`, which projects to *no claim* (executed as an idempotent unclaim; ADR-0022); the **Spine** holds fine state, the tracker holds the coarse projection.
- The **Coarse state** projection is **one-way**: the **Spine** (+ **Sidecar**s + worktree) is authoritative and the tracker is healed *from* it, never read *into* it (ADR-0002).
- An issue's acceptance criteria are verified by the **Reviewer**'s schema-validated `acVerification[]` (per-AC met/partial/not-met + evidence) — that is the AC ground-truth; the tracker checklist is cosmetic (ADR-0004).
- A **PRD** is sliced by `to-issues` into many grabbable **IssueView**s, each carrying a **Parent** backlink to it; the PRD's *consumed* status is derived from those backlinks, never written — the same derive-don't-write discipline as the **Coarse state** bookends.
- **Arming** hands an approved row's merge to the code host; landing evidence flows back through the done-reconcile hierarchy **tracker attachment > host PR state > nothing** (ADR-0023).

## Flagged ambiguities

- **"status"** was overloaded across the triage lifecycle and the kanban **Coarse state**. **Resolved (ADR-0003):** two label worlds at two homes — issue-side **Triage** labels are the consumer's; the **`wave/*`** ledger is flotilla's. They are coupled only by the **Eligibility OR-set**. The engine's `IssueView.status` is `CoarseState` only; triage labels never enter it.
- **"worker"** is overloaded: the **`IssueView.worker`** field (an *assignment* — which agent type) vs the **Worker** runtime agent it spawns. Keep "worker (assignment)" for the field, "Worker" for the agent.
- **"human"** is overloaded across two pipeline stages with **opposite** wave outcomes. **Resolved (ADR-0015):** `ready-for-human` (triage eligibility axis) = *not* wave work, a human handles it entirely outside flotilla, never enters a wave; `HITL-required` (Worker axis, ADR-0012) = wave work that *does* enter a wave, merely human-gated. The separating test is "does the wave system track/surface this work at all?". A `public-API-change` is `ready-for-agent` + `background-heavy` (AFK-implementable, landing-gated), **never** `ready-for-human`.

## Example dialogue

> **Coordinator:** "Slice #3 is blocked by #1 — but on GitHub #1 has no number until I create it. What do I write in `blockedBy`?"
> **Engine:** "Create blockers first; `create()` returns the real **id**; thread a plan-local-id → real-id map so #3's `blockedBy` resolves to #1's assigned **id**. The **slug** never enters this — it's cosmetic."
