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
An issue's risk class (`mechanical · isolated-refactor · cross-feature-refactor · public-API-change`) — a **load-bearing routing key**, not just a validated enum: its string drives the dor-gate file-count heuristics and the `public-API-change` hard-STOP (ADR-0007), and it derives the **Reviewer**'s model tier at dispatch, mirroring the worker routing (`mechanical`/`isolated-refactor` → standard, the rest → `-heavy`; tiers bind to models in the driver config, never by name — ADR-0007 Amendment 2026-07-31). It does **not** select a reviewer *scope* — flotilla's **Reviewer** is universal in dispatch, checklist, and verdict schema whatever its tier, so the spine's `Reviewer` column is a uniform, vestigial decoration (a deliberate de-coupling from the Ur's `quick-verify`/`full-review` scope tiers).
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

**Goal**:
A named finish line for a body of work, bound to one config-selected native target container (GitHub Milestone · Linear Project · Linear Initiative · MarkdownFs goal file) — the container-role binding is config-authoritative per consumer, set at setup time, fail-loud when absent, never a built-in assumption (ADR-0044). Members are the bound container's **direct native members** — issues for the issue-direct containers (Milestone · Project · goal file), projects for a Linear Initiative — joined by curation (an **Operator** act), whatever their origin; the member kind follows the binding, never a flattening query. A **PRD** is never a member (it "belongs" to a Goal only derivedly, through member slices). A Goal grants **sight, never permission**: membership informs planning and adds no execution path — an issue enters a wave because it is eligible and passes DoR, never because it is in a Goal.
_Avoid_: milestone (names one native realization, and collides with Linear's own project-scoped milestones — excluded as a binding), epic (a consumer's convention word), destination / map (Wayfinder's prose — there is deliberately no map document).

**Frontier**:
A **Goal**'s derived open remainder — the members not yet natively closed, each read as one of `in-motion · actionable · blocked · unready` (claimed · could-start-now · unresolved dependency · bare, awaiting sharpening). One vocabulary at every member granularity: a member that is an issue and a member that is a project classify into the same five readings, from facts the store maps honestly per member kind — an empty project is `unready` for exactly the reason a bare ticket is. Derived, never written — the coarse-bookend discipline; completion is literally *the frontier is empty*, and even then the `goal` station only reports it: closing the container is the Operator's act in the tracker, not a verb — the station owes accounting, never the declaration.
_Avoid_: backlog (unscoped — a frontier belongs to one Goal and is derived), checklist (prose — the frontier is a query), remaining work (vague).

**Mirror pass**:
The goal station's fourth pass: publishes the **Frontier** as derived accounting to the bound container's native update surface (a Linear Project/Initiative Update — the surface follows the binding), one update per **Goal**, never per member (ADR-0046). Two layers: a consumer-styled narrative the **Operator** approved sentence-by-sentence at the per-pass confirm, above an engine-owned anchor rendered fresh at write time — per member: native state, the member's own health, blockers, native link — which the caller can neither supply nor edit. Health is never derived from the Frontier: the station transcribes an Operator-confirmed value, or proposes a source-attributed aggregation of the members' own healths, else the update carries none. A member's health is itself a **vendor roll-up, not a field a person sets on the member node** — Linear documents `Project.health` as derived from the most recent project update, with an explicit *null* when no health has ever been reported, which travels out as an absent key rather than a coalesced word. It is still human-**authored** — someone chose that value when posting that update, one node over — and that provenance is exactly what the aggregation round rests on: it proposes over human judgments, never over the station's own classification (`blocked > 0 → atRisk` is the formula the seam exists to forbid).
_Avoid_: health write-mirror (the retired working name — the mirror carries the frontier; health only travels as a transcribed or attributed human judgment), member-set health (a member's health is the vendor's roll-up of its latest update, never a value set on the member node — and an unreported one is a documented null, never an inferred word), status push (a previewed, confirmed Operator act — never automatic, never scheduled), goal update as release marker (the anchor names closing the container as the Operator's own act — and it says so only when the Goal HAS members and every one is closed; a Goal nobody has populated yet reports an empty membership instead, distinctly, exactly as the status pass does).

### Orchestration

**Wave**:
One batch of independently-grabbable issues dispatched as parallel workers in isolated worktrees, reviewed, and landed via PRs.

**Spine**:
The durable, repo-local `WAVE.md` markdown that holds the wave's orchestration state (plan-table, conflict-map, dispatch-log, PR-log, disclosures, pulse-log). It is the source of truth for resume and lives on its own branch, `spine/<slug>` — born at `wave-create` from the wave anchor, carrying nothing but the spine and its **Sidecar**s, pushed so any authorized runner can drive the next **Pulse**. It lands on `main` exactly once, archived, at `wave-close` — a Coordinator-direct PR — and never before. Deliberately outside the `wave/*` namespace the row branches use, which `wave-close` sweeps after landing. *The branch is designed in ADR-0048 (2026-09-02), not yet built — until then the spine sits on whatever branch the Coordinator's checkout is on.*
_Avoid_: manifest, state file, ledger, wave branch (there is no such branch — rows have theirs, the spine has its own).

**Coordinator**:
The (mostly-idle) foreground session that plans a wave and spawns/supervises its workers. Human-in-the-loop STOPs pause it — in chat when a person is present, as an **Ask** it flags and moves past when it runs as a **Pulse**. The session, never the person — the human directing it is the **Operator**.

**Operator**:
The person at the live session an agent is working for — the addressee of every user-directed line an agent prints, and the decider at every human gate (a STOP, a held row's release, an arm confirm). A role, not an identity: a flotilla maintainer, a consumer developer, or a first-time adopter may each hold it, and the word means the same in every case.
_Avoid_: the Coordinator (the session, never the person), user (the harness's own overloaded term), consumer (the adopting repo/organization, not the person at the session).

**Pulse**:
A finite, triggered, unattended **Coordinator** run over one **Wave**: it reconciles from the durable homes, consumes every **Answer** to an open **Ask**, advances everything that needs no human — dispatches, routes returns, flags STOPs *and continues* (flag-and-continue: the same Ask an interactive session would ask in chat, minus the waiting), arms approved PRs under pre-authorization — and exits at **Quiescence** with a report. It selects its own wave — the one with live rows, else the oldest `ready` **Spine** — so an **Operator** plans and cuts several waves in one sitting and the pulses sequence them, one in flight at a time; it never plans, never creates, never archives. A STOP that is really a changed premise degrades instead of halting: Conflict-Map drift is rewritten and disclosed, DOR drift becomes a row **Ask**; intra-wave lanes (HELD rows) advance round by round inside one pulse. Between two pulses there is no process, only state; any authorized runner may drive the next one. A *mode* of the Coordinator, never a new agent, and never a daemon. Answers are read at the pulse's reconcile and once more at quiescence, never continuously.
_Avoid_: daemon, watcher, loop (a pulse ends), headless Coordinator (the topology — a pulse is the run), tick (the trigger's word, not the run's). *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Quiescence**:
The **Pulse**'s exit condition: every row is `in-review`, paused on an open **Ask**, HELD/HUMAN-HELD, or terminal — nothing left the run can move without a human. Reached, not declared; a pulse that exits for any other reason (a wave-level STOP, a crash) has not reached it.
_Avoid_: done/complete (the wave is neither — landing and closing are still owed), idle (a pulse is never idle; it exits). *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Pulse-Log**:
The **Spine** section that gives every **Pulse** (and every interactive dispatching pass) an identity and a durable trace: a start entry — pulse id, runner, started, and `takeover-of` when it replaced an expired **Lease** — and an end entry — ended, outcome (`quiescent` · `wave-stop:<reason>`), the **Answer**s consumed, the rows moved. A start entry with no end entry is a run that died. A wave-level STOP (a precondition that does not hold — another wave in flight, a red credential probe, an absent engine binding, a spine not ready) has no row and raises no **Ask**: it ends the run with exit ≠ 0 and its reason here, and the runner's own failure surface is the human's signal.
_Avoid_: audit log (it is a coordination record, read by the next run), heartbeat (there is none). *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Lease**:
The exclusive right to write `spine/<slug>` and to dispatch on that wave, held by exactly one run at a time. Taken by pushing the **Pulse-Log** start entry before anything is dispatched — the push *is* the compare-and-swap: a rejected push means another run holds the lease, and the run exits without touching anything. Released by the end entry. Expires at the configured maximum pulse lifetime, which is the same value as the runner's own timeout, so a run cannot outlive its lease and an expired lease is provably dead — the next run may take it over, and says so. Held by interactive passes exactly as by pulses: two Operators on one wave are serialized structurally, not by convention.
_Avoid_: lock (implies a lock service — it is a commit on a branch), claim (reserved for the tracker-side coarse-state write on an issue). *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Worker**:
A background agent that executes one issue in its own isolated worktree — created under the repo's worktree **Containment root**, never a system temp dir — and reports back via a schema-validated return.

**Reviewer**:
The independent agent that re-runs the verify gate and judges a worker's output, returning a schema-validated verdict.

**Documented-Form Comparison**:
The **Reviewer**'s required substitute evidence for a row whose core path is unreachable from the review environment: a complete divergence list against the mechanism's authoritative documented form (vendor doc, spec), from sources the Reviewer read in its own dispatch — never the Worker's restatement — reported as its own verdict outcome and never an automatic verdict flip (deliberate, commented departures survive review). Triggered by the deferred valve on the core path's ACs, or earlier by an issue AC or a Worker declaration (ADR-0030).
_Avoid_: docs check (too vague), vendor parity (a divergence is reported, not forbidden).

**Sidecar**:
A worker's durable on-disk artifact (its report, the reviewer's verdict). The spine is the flat file `.flotilla/waves/<slug>.md`; the sidecars live in the sibling subdir `.flotilla/waves/<slug>/reports/` and `.flotilla/waves/<slug>/verdicts/`. The resume flow derives those dirs from the spine path **by convention** (no stored `sidecarRoot` field). Filename and format are engine-owned (written and read by paired engine verbs, never hand-formatted); a sidecar is written by a **Scribe** the moment the work it records exists. Together with the worktree's committed work it is authoritative for resume — "disk beats a non-landed spine flip".
_Avoid_: log, output file.

**Scribe**:
The cheap dispatch-loop stage that persists an agent's schema-validated return as a **Sidecar** immediately at agent-return — before any Coordinator routing — by invoking the engine's write verb with the already-validated payload. A Scribe writes the durable record; it never re-derives, re-types, or judges content. Its failure is loud but never discards the in-band return.
_Avoid_: logger, archiver.

**Disclosure**:
A gap an agent surfaced instead of silently absorbing — a Convention-9 wiring gap, a Convention-10 runtime residue, or a same-shaped finding from the **Reviewer** or the **Coordinator** itself — recorded as an entry in the **Spine**'s Disclosures section through paired engine verbs (never hand-formatted, ADR-0027), captured where it surfaces: agent findings at verdict-routing, a predictable close-visible measurement pre-captured at routing as a measurement point, a **Coordinator** find during the close phases at discovery (ADR-0038). The window ends hard at the archive — a later find files directly as a bare tracker issue. A Disclosure is row-scoped or, when the find is about the wave's own machinery and owned by no row, wave-scoped (ADR-0038). The disclosure *channel* stays prose (`judgmentCalls`, mirrored in `reviewerFocusItems`); the spine entry is what makes the gap durable and countable. Every Disclosure carries a **Disposition**.
_Avoid_: ledger (reserved for the tracker-side claim projection), finding (the retro's word — a Disclosure lives in-wave).

**Disposition (of a Disclosure)**:
The human-decided resolution a **Disclosure** must reach before the wave archives: `resolved-in-slice · scope-extension · filed:<id> · dropped:<reason>` — `open` until decided, and `wave-close` refuses the Archive phase while any Disclosure is `open` (ADR-0027). `filed` records *existence*, not wave-readiness: a bare tracker issue with a provenance line, decorated later via `to-issues`. Several Disclosures may share one filed id — a **thematic bundle** issue; own-ticket vs bundle follows the triviality default (own ticket only for a mechanism defect with observed consequence; ADR-0027 Amendment 2026-07-31), and a bundle accepts appends only while still bare. Deliberately the same word as the row dispositions (park, abandon): a scripted, human-decided exit for an exception — never automatic.
_Avoid_: resolution (vague), auto-file (rejected — the write is human-decided; only the *enforcement* is mechanical), bundled-id (the shared filed id *is* the bundle — no second id concept).

**Scope extension (grant)**:
The **Coordinator**'s mid-wave decision that a row may touch paths outside its decorated Files — always **purpose-bound** (sanctioning a stated forcing reason at named paths, never a blanket pass for a file) and row-scoped for the wave's remaining rounds. Born as a **Disclosure** reaching the `scope-extension` **Disposition** and written to the tracker header via annotate (which is what sibling waves' conflict reasoning reads); carried into the *next* round's Worker and Reviewer briefs as an explicit grant record, because a widened glob alone never conveys that a decision was made (ADR-0041). A grant spoken at routing time cannot reach the round in flight — that round's **Reviewer** re-derives the forcing and reports with an honest caveat, by design.
_Avoid_: glob widening (only the mechanical half), waiver (a grant sanctions purpose-bound work; it waives no review).

**Coordinator-direct (PR)**:
A PR the running Coordinator session authors and lands itself — no Worker, no **Reviewer**. Legitimate **exclusively** for session-authored orchestration artifacts that close no tracker issue (retros, ADRs, glossary/CHARTER updates, config housekeeping); the test is binary: *does the PR close a tracker issue?* — yes → it goes through a wave row with a Reviewer verdict, whatever its file type (ADR-0033). The cheap lane for a bundle-class row is a Coordinator-implemented `foreground` row *with* a Reviewer, never a review waiver.
_Avoid_: doc-only lane (file class is not the boundary — provenance is), self-merge (that is a landing mechanic, not this lane's definition).

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
An orthogonal attention flag (not a ledger rung) meaning "a human must look at this"; set on a STOP or terminal failure (a re-dispatch-cap-exhausted verdict, a PR closed without merge, a corrupt/orphan sidecar at resume), cleared on resolution, and carrying an **Ask** as its payload — the bridge to headless-async resolution (ADR-0006). The flag says a human must look; only the **Answer** says what they decided, and only a later Coordinator run clears the flag. Written through the **IssueStore** (a needs-attention facet, parallel to the Triage/Document facets), so the flag and its payload are tracker-visible to humans and concurrent waves.
_Avoid_: blocked, failed (those are fine states or triage outcomes).

**Ask**:
The identified question a STOP raises for a human — a per-row, monotonically numbered record (`<row>#a<n>`) held first in the **Spine** (the WAL authority: this is what makes a paused row knowable from the spine rather than only from the tracker), then carried to the tracker as the **needs-attention** payload. It names the STOP reason and kind; its options are an engine-owned closed set per reason, each with one fixed execution meaning, so a later Coordinator run can act on the **Answer** without judgment. The question prose is the **Coordinator**'s; the option vocabulary never is.
_Avoid_: needs-attention payload (the tracker-side carrier of an Ask, not the Ask), question (unidentified prose), prompt. *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Answer**:
The typed disposition a human returns to exactly one **Ask**, citing its id: one option from that Ask's closed set, an optional note (required where the note *is* the content — a reply to a Reviewer's blocking question), the author, the time. Consumed by a later Coordinator run, never by a live chat reading: the run records the consumption in the **Spine** first, acts on the option, then clears the **needs-attention** flag. Answering and clearing are different acts by different parties — a human never clears the flag. An Answer citing a stale Ask is ignored, never applied.
_Avoid_: resolution (the whole arc — flag, answer, act, clear), comment (one native realization), reply (vague). *Designed in ADR-0047/0048 (2026-09-02), not yet built — this clause leaves with the slice that builds it.*

**Claim**:
A coarse-state write to the tracker that reserves an issue for a wave: `queued` is a soft claim (do not re-plan), `in-flight` is a hard claim (do not double-dispatch). The native realization is the adapter's: GitHub = `wave/*` labels; Linear = the workflow state itself (`Todo / In Progress / In Review`, config-mapped — the board is the ledger, ADR-0020). flotilla **writes only `queued / in-flight / in-review` (+`needs-attention`)**; `available` (eligible & unclaimed) and `done` (natively closed — `Closes #N` on GitHub, merged-PR attachment/state on Linear) are **derived bookends**, never written (ADR-0003/0005).

**Closing state**:
The `IssueStore.readClosing` probe's answer for how a closed issue was closed — the precise merge-vs-not signal the coarse `done` bookend deliberately discards (ADR-0002/0005), consumed by the `wave-close`/`wave-resume` done-reconcile. **Four outcomes, each an evidence *claim*, not a verdict** — the probe reports what it *found*, never what it inferred from an absence: `open` (not closed); `merged` (positive evidence a linked PR merged — the real done signal, carries the `prUrl`); `closed-unmerged` (positive evidence a linked PR was **found** and did **not** merge — a genuine rejection → `recoverable-stop`); and `closed-unknown` (closed but **no** PR evidence either way — a hand-close, a duplicate, or a foreign-id mention). `closed-unknown` is *absence of evidence, not evidence of rejection*: it is **reported** and falls to the host for a merge the tracker missed (the ADR-0023 evidence hierarchy), and is **never auto-flagged**. A store that structurally cannot prove a rejection (MarkdownFs) emits `closed-unknown` there, never `closed-unmerged` (W2-F1c; the widening is ADR-0020).
_Avoid_: reading `closed-unknown` as a rejected PR — the distinction from `closed-unmerged` is the whole point (only the latter is "a PR was rejected").

**Eligibility OR-set**:
The consumer-configured set of issue labels that make an issue wave-grabbable — an issue is wave-eligible iff it carries **at least one** of them. flotilla treats them as opaque membership tokens (default `{ready-for-agent}`); the issue taxonomy itself is the consumer's, the `wave/*` ledger is flotilla's product (ADR-0003).
_Avoid_: ready-label (singular — it is a set, OR semantics).

**Store-Preflight**:
The tracker-fact probe (`cli-store preflight`, config-driven): confirms the configured store's operational preconditions — tracker↔host integration installed, workflow-state catalog matches the config map. Reports `pass / fail / advisory / not-applicable / unknown`; only `fail` blocks. Code-host posture is *not* its concern (ADR-0023 Amendment 2026-07-20).
_Avoid_: using it to answer landing-posture questions — that is the Host-Preflight.

**Host-Preflight**:
The code-host posture probe (`host-pr preflight`, detect-host-routed, store-blind — no `--config`): allow-auto-merge, required-checks, merge-token capability, read through the landing seam on every store kind. `unknown` means "the token cannot see this setting" — absence of evidence, never blocking, never requiring admin rights. Advisory by design: the arm outcome remains the ground truth (ADR-0023 Amendment 2026-07-20).
_Avoid_: treating a probe result as a landing guarantee (the behind/recomputing race is not probeable); conflating `unknown` with a visible OFF.

### Cleanup

**Sweep**:
The removal pass (`worktree-cleanup`, run standalone or as wave-close phase 3) over flotilla's disposable worktree populations — registered agent worktrees, orphan dirs, scribe scratch payloads, detached scratchpad checkouts — each enumerated only inside the **Containment roots**. It removes what is disposable and *accounts* for the rest: what it cannot remove carries evidence and **Manual recovery**, what it cannot see is reported **Unaccounted**. Removal of either belongs to the **Operator** — the sweep owes accounting, never removal (ADR-0042).
_Avoid_: garbage collection (implies force), cleanup (the generic verb — the Sweep is the pass).

**Containment root**:
A directory the **Sweep** may reason about: only a worktree *strictly inside* one (equality is not containment) is ever a candidate for anything. The set is the engine's worktree-root markers plus the consumer-declared `cleanup.extraRoots` — static strings by design, so a per-session path is structurally outside every root.
_Avoid_: allowlist (it gates candidacy, not permission), root (unqualified).

**Transient / Exhausted (removal reading)**:
The two readings of an incomplete removal after the bounded retry: *transient* — consistent with the race the retry exists to clear, worth a future re-run; *exhausted* — deterministically stuck, no re-run will converge, carries **Manual recovery**. Judged on evidence (the **Survivor set**), never on an errno alone.
_Avoid_: failed (the generic thrown-error class is a separate report bucket).

**Survivor set**:
What physically remains under a worktree after a failed removal attempt — the evidence the exhausted reading is judged on, and (ADR-0042) disclosed on the report entry rather than discarded after the verdict.
_Avoid_: leftovers, residue (unqualified — residue spans both this and **Unaccounted**).

**Manual recovery**:
The exhausted removal's handoff payload on the report entry — a why-message plus the exact operator commands. The sweep's half of "accounting, never removal" for the residue it can see (ADR-0042).
_Avoid_: force fallback (that is the scoped pre-classification step for classifier-disposable entries, not this handoff).

**Unaccounted (worktree)**:
A registered worktree that is neither the primary checkout nor in any of the **Sweep**'s populations — counted but in no list, typically because it lives outside every **Containment root** (the Reviewer's out-of-repo probe checkout is the canonical case). Reported advisorily (additive field + notice line), never a failure exit: the set has legitimate inhabitants, e.g. a human's long-lived second worktree (ADR-0042).
_Avoid_: orphan (a specific in-root population), leaked (presumes it is a defect — it may be someone's workspace).

### Auth

**Lookup-Command**:
The per-credential command string — configured as the `<VAR>_CMD` environment variable (`GITHUB_TOKEN_CMD`, `LINEAR_API_KEY_CMD`) in the tracked settings env block — whose stdout *is* the secret. A command contract, not a vendor integration: anything that prints the secret qualifies (OS keychain, `op`, `pass`, a script). Configured means authoritative — a failing Lookup-Command is a loud typed failure, never a silent fallback; an empty value means "not configured" (the ambient path applies). Executing a Lookup-Command outside the engine is a Convention-8 violation (ADR-0029).
_Avoid_: token command (say which credential), credential helper (the code-host CLI's mechanism — a rejected option, not this seam).

**Credential-Resolver**:
The single engine seam that turns a credential need into a secret at construction time: the configured **Lookup-Command** first, the ambient environment variable when no command is configured — two first-class paths chosen by environment lifetime (long-lived interactive machines configure the command; ephemeral environments like CI stay ambient by design). Consumed by both tracker-store factories and the host-pr landing edge; resolves once per process; holds nothing at rest; its typed failure names the command and never carries its output (ADR-0029).
_Avoid_: auth manager, secret store (it stores nothing), fallback (as the ambient path's name — it is the ephemeral-environment path, not a legacy).

**Echo-Guard**:
The `PreToolUse` hook (`tools/wave/hooks/echo-guard.cjs`) that hard-blocks a Bash command whose *text* matches one of four secret-echo families before it runs — any `$`-expansion of a credential-shaped name outside the sanctioned presence test; any value-substituting `${NAME:-…}` / `:=` / `:?` form, whatever the name; a whole-environment dump (`printenv`, bare `env`, bare `set`); or a wrapped configured **Lookup-Command** — and rejects with a teaching message naming Convention 8 and both sanctioned alternatives. A **speed bump, not an anchor**: it reads the command, never the output, so indirect expansion (`${!VAR}`) walks past it, and it fails *open* on its own crash. It sits on top of the settings-deny anchors and the **Credential-Resolver** indirection, never instead of them; passing it is not evidence that a command is safe.
_Avoid_: secret scanner (it scans no output and no repository), permission rule (the permission layer provably cannot express this vector — that is precisely why a hook exists), lint (it blocks an invocation, it does not annotate source).

### Distribution

**Plugin clone**:
The install surface a Claude-Code plugin consumer actually receives — the **entire repository** at a pinned SHA (`marketplace.json` `"source": "./"`), skills, `docs/`, engine sources and all; only gitignored artifacts (`node_modules`) are absent. Skill references may rely on it; the reference-guard spec is the tripwire that makes narrowing it a loud, deliberate decision (ADR-0031). Distinct from the **npm package**, a narrower surface (`src` + `bin` only) that ships no skills.
_Avoid_: packaged plugin contents (implies a curated subset that does not exist), plugin package (confusable with the npm package).

**Resolution anchor**:
The context a file-path-shaped skill reference resolves against — the *skill file* for anchored markdown links, the *plugin-clone root* for bare path citations, *cwd plus installed artifacts* for command fragments. A reference is defective when written against the wrong anchor for its class, not when its target is missing from the package (ADR-0031); a consumer session's cwd is the consumer repo, never the clone.
_Avoid_: broken link (names the symptom, not the class), missing file (the file usually exists — the anchor is wrong).

**Citation**:
A path or identifier authored text *points at* — something the reader can follow — and the population the reference guards check. A citation must resolve against its **Resolution anchor**; a dead citation is a defect of the text, never of the guard.
_Avoid_: mention (may be a **Subject path**), link (one syntactic form among several).

**Subject path**:
A path authored text *talks about* rather than points at — real in the other distribution form (a consumer-scaffolded location, deliberately absent in flotilla's own clone) or deliberately unreal (a spec fixture). Never marked in the checked text: the checked text never carries its own exemption — a subject is declared guard-side in a named, self-policing class (ADR-0043).
_Avoid_: exception/ignore (the guard is not switched off — the class is a falsifiable claim about the path), dead path (that names a **Citation** defect; a subject path is not a citation).

**Source form / Installed form**:
The two forms every distribution layer exists in — the skills as local `.claude/skills/` (source) vs. the installed plugin, the engine as vendored `tools/wave` sources (source) vs. the published npm package. A repo runs exactly **one** form per layer, statically bound through tracked config: the skills layer via the `enabledPlugins` self-disable in the tracked settings, the engine layer via the `engine.cli` binding in the wave config (ADR-0032). flotilla itself is the only repo that runs source form on both layers — it builds what it runs; every consumer runs installed form. Mixed forms are the defect both bindings exist to prevent.
_Avoid_: dev mode (implies a runtime toggle — the binding is static, tracked config), dogfood mode (same problem).

**Dual-form**:
A *prose reference* stated in both its in-repo form and its installed form, so whichever context is live, the reader picks the one that resolves — retained for by-name recommendations addressed to a human (slash commands). Agent-side cross-skill loading is outside its scope entirely: that is a sibling-path read against the loading skill's own base directory, one spelling in every context (ADR-0040). Prose only: an *invocation* is never dual-form — the engine invocation is a single setup-time binding (`engine.cli`, ADR-0032) that fails loud, never a chained alternative.
_Avoid_: fallback (the resolving form is chosen by reading context, and invocations never chain at runtime), alias.

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

### Doctrine

**Enforcement Tier**:
The rung a rule is enforced on — engine refusal · schema boundary · drift-spec · hook / config · brief prose · reference doc — ordered by the token rent each enforcement costs per use: structural tiers cost ≈ 0 at runtime, prose tiers pay per dispatch (brief) or per session (reference doc) (ADR-0034). The two top rungs share that rent but not their failure surface: a **schema boundary** constrains an *author* while it composes, an **engine refusal** inspects a *finished artefact*. An author under an unsatisfiable constraint escapes through whatever field it still controls — so for a conditional rule whose condition names a field the same agent authors, engine refusal outranks schema boundary (ADR-0034 Amendment 2026-08-14). Always written qualified — an unqualified "tier" is the model tier (see Flagged ambiguities).
_Avoid_: tier (unqualified), level, layer; "structural" as a synonym for either top rung (it covers both, and the difference between them is the point).

**Promotion**:
The move of a rule from a prose Enforcement Tier to a structural one, earned — never automatic: a rule whose violation fails *silently* (plausible wrong result, no-op with a success echo) becomes a Promotion candidate at its **second live occurrence**; a loudly-failing rule may stay prose until recurrence is chronic (ADR-0034). Prose is a rule's draft mode, structure its production mode — tokens are the rent a rule pays until it earns structure. A Promotion pays its prose back: the same diff shrinks the promoted prose to the **residual form** — the rule in one sentence, its one-line why, a pointer to the enforcing structure — and names the word-count delta; defense-in-depth prose *is* that residual form, never a full paragraph kept beside the structure (ADR-0034 Amendment 2026-08-13).
_Avoid_: migration (sounds like data movement), hardening (vague), graduation, diet (colloquial — say residual form / prose walk-back).

**Operator register**:
The speech register every skill holds in output directed at the **Operator** — plain language, direct address ("du"), self-explaining: internal references (ADR numbers, convention numbers, finding ids, wave slugs, retro paths) are translated into their one-line consequence, a domain term gets a half-sentence introduction at its first use per session, and every skill run ends in an operator block (what happened → where it lives → what you do next). Strict in installed form; in source form (flotilla itself) a compact reference pointer may follow the plain text (Convention 16, ADR-0039).
_Avoid_: consumer mode (not a mode — the register is the default, the source-form pointer is the exception), simplification (nothing is omitted — evidence moves position, the message stays whole).

## Relationships

- An **IssueView** is keyed by its **id**; its **slug** decorates derived names but is never a key.
- A **Wave** plans many **IssueView**s into a **Spine**; the **Coordinator** dispatches one **Worker** per issue and one **Reviewer** per worker.
- Every **Fine state** projects to exactly one **Coarse state** rung — except the claim-releasing `parked`, which projects to *no claim* (executed as an idempotent unclaim; ADR-0022); the **Spine** holds fine state, the tracker holds the coarse projection.
- The **Coarse state** projection is **one-way**: the **Spine** (+ **Sidecar**s + worktree) is authoritative and the tracker is healed *from* it, never read *into* it (ADR-0002).
- An issue's acceptance criteria are verified by the **Reviewer**'s schema-validated `acVerification[]` (per-AC met/partial/not-met/deferred + evidence) — that is the AC ground-truth; the tracker checklist is cosmetic. An outcome-phrased AC is `met` only on outcome-exercising evidence; an outcome unreachable from review is `deferred` and becomes a **Disclosure** (ADR-0004 Amendment 2026-07-28, ADR-0027). A `deferred` core path additionally requires the Reviewer's **Documented-Form Comparison** (ADR-0030).
- A **Worker**/**Reviewer** disclosure becomes a **Disclosure** in the **Spine** at verdict-routing; a **Coordinator** find during close is captured at discovery, and the window ends hard at the archive (ADR-0038); `wave-close` archives only when every **Disclosure**'s **Disposition** is terminal — existence is gated mechanically, quality stays human (ADR-0027).
- A **PRD** is sliced by `to-issues` into many grabbable **IssueView**s, each carrying a **Parent** backlink to it; the PRD's *consumed* status is derived from those backlinks, never written — the same derive-don't-write discipline as the **Coarse state** bookends.
- A **Goal**'s member set lives in its bound native container; the **Frontier** is derived from member state, never written. Goal membership never makes an issue wave-eligible and the goal surface has no dispatch verbs — planning skills read it, execution skills never do (ADR-0044).
- **Arming** hands an approved row's merge to the code host; landing evidence flows back through the done-reconcile hierarchy **tracker attachment > host PR state > nothing** (ADR-0023).
- The **Echo-Guard** is defense-in-depth *over* the auth anchors, never one of them: the tracked settings-deny entries own the gitignored-file-read vector, the **Lookup-Command** indirection owns the direct-execution vector (ADR-0029), and the guard covers only what a command's own text reveals.
- The **Sweep** accounts for every registered worktree: an incomplete removal carries its **Survivor set** and, when exhausted, **Manual recovery**; a worktree outside every **Containment root** is reported **Unaccounted** — removal of both belongs to the **Operator**, never to a more forceful sweep (ADR-0042).
- A **Citation** must resolve against its **Resolution anchor**; a **Subject path** is exempted guard-side in a named, self-policing class — the checked text never carries its own exemption (ADR-0043).

## Flagged ambiguities

- **"status"** was overloaded across the triage lifecycle and the kanban **Coarse state**. **Resolved (ADR-0003):** two label worlds at two homes — issue-side **Triage** labels are the consumer's; the **`wave/*`** ledger is flotilla's. They are coupled only by the **Eligibility OR-set**. The engine's `IssueView.status` is `CoarseState` only; triage labels never enter it.
- **"worker"** is overloaded: the **`IssueView.worker`** field (an *assignment* — which agent type) vs the **Worker** runtime agent it spawns. Keep "worker (assignment)" for the field, "Worker" for the agent.
- **"tier"** is overloaded: the model tier (Worker/Reviewer routing, the abstract `-heavy` marker — ADR-0007/0012) vs the **Enforcement Tier** (which rung enforces a rule — ADR-0034). **Resolved:** unqualified "tier" keeps meaning the model tier everywhere in wave routing; the doctrine concept is always written out as **Enforcement Tier**.
- **"human"** is overloaded across two pipeline stages with **opposite** wave outcomes. **Resolved (ADR-0015):** `ready-for-human` (triage eligibility axis) = *not* wave work, a human handles it entirely outside flotilla, never enters a wave; `HITL-required` (Worker axis, ADR-0012) = wave work that *does* enter a wave, merely human-gated. The separating test is "does the wave system track/surface this work at all?". A `public-API-change` is `ready-for-agent` + `background-heavy` (AFK-implementable, landing-gated), **never** `ready-for-human`.

## Example dialogue

> **Coordinator:** "Slice #3 is blocked by #1 — but on GitHub #1 has no number until I create it. What do I write in `blockedBy`?"
> **Engine:** "Create blockers first; `create()` returns the real **id**; thread a plan-local-id → real-id map so #3's `blockedBy` resolves to #1's assigned **id**. The **slug** never enters this — it's cosmetic."
