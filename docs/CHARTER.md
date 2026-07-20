# flotilla — Project Charter

> **Status:** design-approved, pre-seed · **Name:** `flotilla` (provisional, renameable) · **Date:** 2026-06-05
> Seeded from the Ur's wave-orchestration system. This document is self-contained so it travels with the seed into the new repo.

---

## 1. What flotilla is

A **portable, Claude-Code-native toolkit for wave orchestration**: planning a batch of independently-grabbable issues, dispatching parallel AFK agents to execute them in isolated git worktrees, reviewing each before merge, and landing the work via PRs.

Its universal core — the thing that is true regardless of stack (Angular, Kirby/PHP, Figma-derived components, plain content) — is the **conflict / parallelism reasoning**:

> *"How much work goes into one wave, and can these two waves run side-by-side?"*

That question reduces to pure glob-set math over declared file-scopes, and it is identical whether the work units are Angular components, Kirby plugins, or wiki pages. Everything else (the tracker, the verify commands, the host) is an adapter around that core.

flotilla is extracted from **the Ur**'s wave system and generalized to be **tracker-agnostic** (GitHub Issues / markdown-files / later Linear) and **stack-agnostic**.

---

## 2. Relationship to the Ur — the frozen ancestor and the descendant

Three sibling repositories, parallel on disk:

```
parent/
  the-ur/            ← frozen, .scratch + git mv, client-specific
  flotilla/          ← THIS repo: generic, evolving, adapter-based, GitHub-Issues-capable
  the-wiki-pilot/    ← first consumer: GitHub + GitHub Issues, full orchestration
```

- **The Ur is the frozen ancestor.** It keeps its `.scratch/`-markdown issue tracker, its `git mv`-to-`done/` close lifecycle, its ADR/Nx/Bitbucket bindings, and its interim "unprotected `main` + manual fast-forward" branch ritual. It does **not** adopt flotilla's adapter seams. It earned the right to stay as it is.
- **flotilla is the evolving descendant** and will overtake the Ur (cleaner seams, GitHub Issues, protected-main, more adapters). This is expected.
- **Back-flow is asymmetric, not symmetric.** The Ur donates its battle-tested patterns **once** (the seed). After that, only **engine-layer** bug-fixes are worth manually porting between the two (the engine is small and stable — see §4). Adapters, gates, skills, and config diverge freely. Do **not** expect or attempt two-way sync of the whole system.

**Seeding mechanism: `cp`, not git-subtree.** A clean copy of the Ur's `tools/wave/` + the wave skills, plus a `PROVENANCE.md` recording `seeded from the Ur's tools/wave @ <commit-sha>` **and** `front-half skills seeded from github.com/mattpocock/skills` with the upstream license notice retained — **P0 must confirm the actual license from that repo** (no co-located LICENSE in the install; "MIT" is asserted, not yet verified) before flotilla is published (ADR-0010). Copy (not subtree) is deliberate: subtree implies *regular* sync; flotilla wants *free divergence* with only occasional engine-fix cross-pollination. The recorded SHA lets you diff later if you ever want to back-port a specific engine fix.

---

## 3. Positioning (own this consciously)

- flotilla = **(a)** a harness-agnostic TypeScript **engine** + **(b)** a Claude-Code **skill driver**.
- The TS engine imports only `node:*` + `fast-glob` + `micromatch` — **no Workflow/Agent/MCP primitives**. It is already harness-agnostic. A non-Claude orchestrator (a CI script, another agent framework) *could* drive the same engine — but flotilla does **not ship** that driver (YAGNI until someone needs it).
- The Claude-Code coupling lives **entirely in the skills**. The skills *are* the dispatch layer (`agent({schema, isolation:'worktree'})`, `pipeline()`, journal-resume).
- **Consequence:** flotilla's external consumers are **other Claude Code users**. That is not a limitation — it is the value proposition (AFK-agent orchestration *under Claude Code*). flotilla is a "Claude-Code wave-orchestration toolkit," not a universal CI agent orchestrator.
- **The fabrication-prevention guarantee** (schema-validated subagent returns, which kill the "agent invents numbers" failure class) is a property of the **Claude-Code driver** — the Workflow tool enforces the JSON schema at dispatch. The engine *provides* the schemas (`worker-report-schema`, `reviewer-verdict-schema` as pure validators); the harness *enforces* them. Do not abstract the driver away; it would weaken this guarantee for no current benefit. On GitHub the AC half of this guarantee is anchored in the reviewer's schema-validated `acVerification[]`, **not** the (remote, un-tickable) issue checklist — see ADR-0004.

---

## 4. Architecture — the seam

Two layers. The cut is **already mostly present in the Ur's code** (the pure cores take objects; thin loaders bridge to markdown).

### Layer ① — Engine (the shared sync-surface)

Pure, near-zero project literals, already vitest-tested. **This is the only surface kept manually in sync with the Ur** — and it barely changes, which is what makes that cheap.

| Module | Role |
|---|---|
| `stop-condition-state-machine` | total transition function, 11 issue-states × wave-events; the crown jewel, zero literals |
| `verdict-to-event`, `worker-report-schema`, `reviewer-verdict-schema` | pure validators — "classify by typed field, reject the unmappable loudly" |
| `ff-guard` | fast-forward decision = pure ancestry math |
| `merge-order` (algorithm) | stacked-branch topological sort + cycle guard over abstract `PR[]` |
| `conflict-map` (`computeConflictMap` core) | pure glob-intersection set math over `IssueGlobs[]` — **the universal value** |
| `files-drift` (algorithm) | path-prefix set arithmetic; the runtime guarantor of declared-scope (see §7) |
| `worktree-cleanup` | `list → plan → execute`, dirty-never-removed invariant |

Plus the **contract type** `IssueView` (§5) and a `validateHeaderBlock(view, schema)` predicate (the enum-vocabulary lives in config, not the code).

### Layer ② — Adapters (diverge freely per consumer)

The whole "source → `IssueView`" projection, the host, the verify commands, the project-specific checks, and the spine serialization.

> **Key correction from the grill:** the `header-parser` (the markdown `**Field:**` regex extractor + the "frontmatter above the first H2" rule) is an **adapter**, not engine. It exists *only* because the Ur's issues are markdown files. For a structured tracker it evaporates (Linear → 0% parsing; GitHub → ~10%, just a body-section read for `Files`). What is shared is the **`IssueView` contract + validator**, never the parser.

There is no separate "parameterized middle layer" and **no `DispatchHost` adapter** — the engine needs neither.

---

## 5. The canonical contract: `IssueView`

The engine never knows where an issue comes from. The adapter's whole job is `read(id) → IssueView`.

```ts
interface IssueView {
  id: string;              // opaque tracker-native identifier; engine never parses/orders it (ADR-0001)
  risk: Risk;              // enum vocabulary supplied by wave.config
  worker: Worker;          // enum vocabulary supplied by wave.config
  files: string[];         // globs / paths — the conflict-map input
  blockedBy: 'none' | IssueRef[];
  unblocks?: IssueRef[];
  acceptanceCriteria: { text: string; checked: boolean }[];  // `checked` from a tracker read is cosmetic; AC-met truth is the reviewer verdict (ADR-0004)
  status: CoarseState;     // see §6
  closedBy?: string;       // PR ref
  estimatedWallclock?: string;
}
```

Field-mapping per tracker (the adapter's private business). **`id` is opaque to the engine** — whatever the tracker's human-visible identifier is, returned by `create()`; the engine never parses, orders, or assumes a format for it (ADR-0001):

| field | the Ur's markdown | GitHub Issues | Linear |
|---|---|---|---|
| `id` | `<slug>#NN` (filename) | issue number `"412"` | `identifier` `"ENG-123"` (**not** the UUID) |
| `risk`/`worker` | `**Risk:**` regex | **label** (`risk/mechanical`) | custom field / label |
| `files[]` | `**Files:**` list parse | body section `## Files` (light read) | text custom field |
| `blockedBy`/`unblocks` | `**Blocked by:** #42` | native issue dependencies / sub-issues | native blocking relations |
| `acceptanceCriteria` | `- [ ]` body task-list | `- [ ]` body task-list (GH bodies *are* markdown) | sub-issues / checklist |
| `status` | filesystem location + `**Status:**` line | native open/closed + label/Project-status | native workflow state |
| `closedBy` | `**Closed-by:**` line | `Closes #N` auto-link | native PR attachment |

---

## 6. State model — two scopes

Two *kinds* of state live at two *homes*.

### Wave/orchestration state → local markdown spine (`SpineStore`)

The `WAVE.md` spine (frontmatter, plan-table, conflict-map, dispatch-log, PR-log) is **transient coordinator scaffolding**, git-versioned for audit. It stays **repo-local markdown** for *all* consumers — tracker-agnostic by design. `wave-md-rw` becomes the shared `SpineStore` (column indices + section names lifted to a `SpineSchema` config; the bespoke footnote/conflict-list grammar stays inside the markdown impl, the engine only ever sees the parsed object). It is **durable** — this is what makes resume possible (§7).

The plan-table row is keyed on the opaque `IssueView.id` (ADR-0001); the merge-order / wave-start-DOR / wave-close loaders join `spine → IssueStore.read(id)` rather than re-reading a filesystem path (the Ur's `[^source-*]` footnote-path handle, which had a `done/`-fallback to survive `git mv`, has no tracker-native equivalent and is replaced by the stable `id`).

### Issue lifecycle state → projected to the tracker (`IssueStore`)

The engine's **11 fine-grained states** (`planned → dispatched → report-in → reviewing → verdict-in → re-dispatched → approved → pr-created → failed → abandoned`, plus the claim-releasing terminal **`parked`** — "not this wave, re-plan later"; releases the claim immediately, terminal-but-silent at close, ADR-0022) are coordinator-internal and stay in the spine.

A **coarse projection** is written to the tracker so other humans / concurrent waves can see what is claimed. The coarse vocabulary is exactly the standard kanban columns:

```
available → queued → in-flight → in-review → done        (needs-attention = orthogonal flag, ADR-0006)
```

- `planned` → **`queued`** (soft claim — so a second coordinator does not plan it into a *different* wave). **Written by `wave-create`** at plan-composition — invoking `wave-create` *is* the commit-to-scope act (it replaces the Ur's skill-less `draft→ready` flip), and `wave-create` therefore gets `transition` authority, a deliberate divergence from the Ur's read-only `wave-create`. `queued` ships in M1.
- **`queued` → `available` (un-claim)** — the reverse edge: remove the `wave/queued` label on any plan-time drop (DOR-fail, conflict-drop, slug-collision, draft-abort) so the issue returns to the eligible pool. Distinct from `needs-attention` (which flags an *in-flight* problem, §7), not a re-plannable drop.
- `dispatched` → **`in-flight`** (hard claim — prevents double-dispatch)
- `approved`/`pr-created` → `in-review`
- closed → **`done`** — a **derived bookend** (ADR-0005): an issue is `done` ⟺ it is **natively closed** (via `Closes #N` on the merged PR), symmetric with `available`. **No `wave/done` label is written.**
- a wave STOP (recoverable) / `failed` / `abandoned` (terminal) → set the **`needs-attention`** flag (the claim-releasing `parked` is the deliberate, *silent* terminal — never flagged, ADR-0022) — an **orthogonal attention flag, not a coarse-ledger rung** (ADR-0006). It coexists with the underlying coarse state, is **cleared on resolution** (a recoverable STOP just continues; a terminal failure is dispositioned: retry → `available`/`queued`, abandon → close-as-`wontfix`, escalate → `ready-for-human`), and carries a serialized payload (the kind + question + options) — the bridge to headless-async mode (§7).

> So flotilla **actively writes the ledger `queued / in-flight / in-review`** plus the orthogonal **`needs-attention`** flag; `available` (eligible & unclaimed) and `done` (natively closed) are derived endpoints, not written labels.

**The projection is one-way and the spine is a write-ahead log (ADR-0002).** The durable spine (+ on-disk sidecars + worktree git-state) is the **single authority**; the coarse projection is written *downstream* and on resume is **healed from** the authority, **never read into** it — it is lossy (`report-in`/`reviewing`/`verdict-in` all collapse to `in-flight`) and so cannot reconstruct fine state. Dual-write order is **spine-commit first, then label** (authority before projection), with idempotent re-projection healing drift. Double-dispatch is prevented not by label ordering but by an idempotent **worktree/branch-exists guard** (§7). Cross-coordinator atomic claim is M2 (§12).

**Two label worlds, one coupling (ADR-0003).** Issue-side labels (triage roles, categories, any custom label a PRD-split produces) are the **consumer's**, configured at setup — flotilla imposes no taxonomy. The `wave/*` claim ledger above is **flotilla's fixed product**. The only coupling is a configured **eligibility OR-set**: an issue is wave-eligible iff it carries *at least one* label from a consumer-declared set (`{ready-for-agent}` by default; the consumer may add a custom label such as `ready-for-neo`, …). flotilla treats those labels as **opaque membership tokens**. **`ready-for-human` is never an eligibility token** — that triage state means *not wave work* (ADR-0015); it is orthogonal to the `HITL-required` worker, which *is* wave-eligible but human-gated. Consequently `available` is **not a written label** — it is just "eligible and not yet claimed (no `wave/*` label)"; the ledger's first write is `queued`. Eligibility is evaluated by `listOpen(scope='wave-ready')` in the adapter, so there is no eligibility field on `IssueView`.

### `IssueStore` interface (read **and** write)

```
create(view) → id        // to-issues calls this
read(id) → IssueView     // the engine consumes this
transition(id, coarse)   // the wave claim ledger (writes wave/* only); the wave skills drive it — NOT triage (ADR-0003)
close(id, prUrl, ackedACs[])
listOpen(scope)

// Document facet (ADR-0011) — a PRD is a tracker document, not a wave issue
publishDocument(input) → id · readDocument(id) · listDocuments()

// Triage facet (ADR-0015) — the issue-side lifecycle, tracker-agnostic, single-select/intent-shaped
readTriage(id) → TriageView · applyTriage(id, {state, category?, comment?}) · closeUnplanned(id, comment)
```

Shipped adapters: **`MarkdownFsStore`** (Ur parity) and **`GitHubIssuesStore`** (the wiki pilot). For GitHub, `close` collapses the Ur's entire `git mv` + audit-grep ceremony into a single native state transition (`Closes #N`). Both facets are **universal** — every adapter implements them (Document + Triage), conformance-tested across both; the Triage facet's GitHub impl runs through the same injectable `GitHubApi` seam as the wave operations, and writes the consumer's *opaque* triage tokens (ADR-0003 holds — the engine still imposes no taxonomy; the skill supplies the strings from `wave.config`).

---

## 7. Execution & landing

- **PR-route by default.** Protected `main`, PR-only landing for *everything* — including orchestration artifacts. This makes the Ur's **§7.1 harness auto-mode FF-classifier gate vanish**: that gate fires only on *direct* default-branch pushes, and with branch protection there is no such path. The spine **rides the wave branch** and is a branch-local archive; it does **not** need to land on `main`. The whole "session-end FF-sync ritual" the Ur needs simply does not exist here. *This is the one decision flotilla deliberately makes differently from the Ur.*
- **Merge, terminality & `done` (ADR-0005).** `wave-start` ends the dispatch/review loop at **all rows `in-review`** and proposes an *advisory* initial merge-order (never merges, never `done`). **`wave-close`** is the merge phase: it **recomputes** the order (PRs get revised post-review) and either recommends it (default) or — **opt-in `auto`** — runs `gh pr merge --auto` per the order, letting GitHub complete server-side (survives a dead Coordinator); a PR that cannot auto-merge → `needs-attention`. **Wave terminality = all rows `in-review`**; the **spine is archived at `wave-close`**, not at `wave-start`. **`done` is derived** (natively closed via `Closes #N`), so `close()` is no-op-or-reconcile.
- **Coordinator = a (mostly-idle) foreground session; Workers = background agents** it spawns into isolated `/tmp` worktrees. The Coordinator cannot be a pure background Workflow because human-in-the-loop STOPs need a conversation to pause/ask/resume.
- **Two topologies, one architecture:**
  - **(I) interactive Coordinator** — STOP pauses the live session and asks in-chat. Used **now** (solo, tight loop).
  - **(II) headless + tracker-async** — a STOP sets the `needs-attention` flag (label + a comment serializing the **kind** + decision + options); humans resolve asynchronously via the tracker; no live session required. The `needs-attention` flag (ADR-0006), with its payload distinguishing recoverable-STOP from terminal-failure, builds the bridge. **Design toward (II); ship (I).**
- **Resume is load-bearing (M1).** "Let it run while I work, attend later" only holds if the Coordinator session can die and be resumed. The Ur deferred `/wave resume` as Tier-2; flotilla **cannot**. Resume reconstructs from **three durable homes — spine fine-state + on-disk sidecars (reports/verdicts) + the live `git worktree list`** (ADR-0002), with the tracker claims healed *from* that, never read *into* it. **Workers are assumed dead on a Coordinator kill** (they are session children); resume does not reattach live agents but rebuilds from the worktree's committed work + the sidecar — disk beats a non-landed spine flip. The double-dispatch guard is the **worktree/branch-exists adopt-or-redispatch** rule: if `wave-orch/<id>` already exists for a `planned`/`dispatched` row, adopt it; if not, the spawn never landed, so (re)dispatch is safe. The spine dispatch-log stores branch **and** worktree path; the worktree-root marker (`agentPathMarker`) lives in `SpineSchema`/`wave.config`.
- **Honest edge:** the conflict-map protects *workers from each other*, not from *your concurrent foreground edits*. If you FG-edit a file the wave is touching, you hit a normal PR-merge conflict. The `in-flight` claims tell you which files are hands-off.

---

## 8. The check layer

| Moment | What | Placement |
|---|---|---|
| **DOR** (pre-dispatch) | header valid, Files-glob valid, AC consistent, Risk/file-count, Blocked-by resolved, AC↔Files coverage | **engine + config** (operates on `IssueView`) |
| **Pre-PR floor** | conflict-marker grep, AC-count (`acVerification` covers declared ACs 1:1 — ADR-0004) | **engine** (universal) |
| | project-specific checks (e.g. the Ur's ADR-0005 Pure-I/O) | **flat `wave.config.checks[]` array** — `{name, appliesTo: glob, command\|predicate, onFail}` |
| **VerifyGate** | the verification commands (build/test/lint) | **config function** `verifyCommands(changedFiles) → string[]`; profiles: nx / npm / composer / none |

**No plugin-registry framework.** A flat array consumed by the gate-runner; project checks are entries, not plugins. VerifyGate output feeds *both* the worker brief *and* the reviewer's independent re-run (worker-report drift is failure-mode #1).

The AC-count check (Pre-PR floor) consumes the **typed reviewer return**, not a re-parsed markdown file — adapter-agnostic for both `MarkdownFsStore` and `GitHubIssuesStore`, which also strips the engine's last issue-file re-read (ADR-0001, ADR-0004). The issue checklist stays cosmetic; flotilla ticks the GitHub body only at `close` for human visibility.

**`Risk` is a load-bearing routing key (ADR-0007), not just a validated enum.** The Risk *string* drives three behaviours — keep them documented here so the generic rewrite does not lose them:

| Risk | reviewer profile | extra |
|---|---|---|
| `mechanical` | quick-verify | dor-gate Gate-4: `>5` files = concern |
| `isolated-refactor` | quick-verify | — |
| `cross-feature-refactor` | full-review | dor-gate Gate-4: `==1` file = concern |
| `public-API-change` | full-review | **hard-STOP** `public-api-approval-required` (`verdict-to-event` G3 guard) |

The whole enum vocab is config-authoritative (`wave.config` via the `wave-setup` interview); **M1 freezes the Risk set + these behaviours** (only `Worker` is freely trimmable), with the Risk→behaviour *map* lifted to config in M2 (ADR-0007).

---

## 9. The core value: cross-wave conflict reasoning

The conflict-map is **wave-agnostic** — `computeConflictMap` takes *any* `IssueGlobs[]`. Feed it `(candidate wave) ∪ (everything currently queued + in-flight)` and it answers directly: *can this wave run alongside the running ones?* — disjoint = yes, overlap = serialize/split.

Five parts interlock:
1. **conflict-map (global)** — disjointness over all claimed work, *planned* up front.
2. **claim-state (queued/in-flight at the tracker)** — the cross-wave coordination ledger.
3. **files-drift** — the *own-lane* runtime guard: it catches a worker leaving **its own** declared globs (per-issue, reviewer-side), so the *planned* disjointness still describes reality. It does **not** compare two workers against each other.
4. **sibling merge-tree check (the *cross-branch* runtime guard)** — a **reviewer-layer** responsibility (the Ur's reviewer-brief **input #7** = the sibling in-flight branches; the reviewer `git merge-tree`s the branch-under-review against each sibling and surfaces predicted conflicts as an advisory). This is what catches two *overlapping or drifted* branches colliding **at merge**, and it informs the merge-order. Pure `git merge-tree` → stack/tracker-agnostic, transfers verbatim; **not** GitHub-redundant — GitHub only detects conflicts against `main` *after* a sibling has landed, whereas this predicts pairwise sibling conflicts *before* either merges. **Must be carried into the generic skill rewrite — not dropped as the Ur's reviewer ceremony** (see §10 / M1-PRD §2h).
5. **wave-plan heuristics** — "how much per wave," now cross-wave-aware.

Parts 3 and 4 are distinct runtime guards: **files-drift = "did *this* worker stay in its lane"**; **sibling merge-tree = "will *this* branch collide with the *other* in-flight branches at merge"** (the preventive form of the Q6 rebase-train — it lets `wave-close` serialize colliding siblings before the conflict bites).

The classic conflict is a **shared barrel/registry** file (the Ur's `public-api.ts`, an icon registry, the wiki pilot's blueprint index): N parallel component-generation issues all touch it → the conflict-map flags it → resolve by serializing the barrel write or giving one issue ownership. Stack-agnostic, always the same pattern.

This behaviour is *emergent* in the Ur today — the planner spontaneously observed "these two have no overlap, run them in parallel." That is the proof the seam is real.

**M1 = the cross-wave *check* (single-wave orchestration that consults claims before launch). M2 = truly concurrent multi-wave orchestration.**

---

## 10. The skill pipeline (the front half matters)

A wave cannot exist without the planning tools that feed it. flotilla ships the **whole pipeline**, not just the execution skills:

```
(idea) → triage → to-prd → to-issues[Header-Block] → wave-plan → wave-create → wave-validate → wave-start → wave-summary → wave-close
          └───────────────── grill (stress-tests any upstream step) ─────────────────┘
```

- **`to-issues` is the linchpin** — it *writes* the Header-Block the engine *reads*. It is the write half of the `IssueStore` boundary (`create()`). flotilla ships a **self-contained, config-driven** version (enum vocab from `wave.config`, writes through `IssueStore.create`, tracker-agnostic) — **not** dependent on Mattpocock's base skill being installed. It is **dual-mode** (ADR-0010): **create** a fresh fully-annotated issue, or **decorate** an existing triage-ready issue (the wiki pilot's reality) — closing the gap that Matt's template leaves (it emits AC + Blocked-by but **no** `## Files`/Risk/Worker). The wave Header-Block lives **on the tracker issue** (body `## Files` + `risk/*`/`worker/*` labels), round-tripping via `IssueView` — not in the spine.
- **flotilla owns the *complete* pipeline (ADR-0010).** The whole front-half (`triage / to-prd / to-issues / grill`) is flotilla's own, seeded by copy from Matt Pocock's **MIT**-licensed skills, rewritten generic, with **MIT attribution in `PROVENANCE.md`**. Rationale: control + gap-closure — deliver the whole set rather than inherit external implementation gaps. No external skill is a prerequisite.
- **`triage`** drives the **issue-side** lifecycle (the consumer's triage roles) through the tracker-agnostic **Triage facet** on `IssueStore` (`readTriage`/`applyTriage`/`closeUnplanned` — ADR-0015), *not* by shelling `gh` directly: GitHub renders the states as labels, Linear as native workflow-states, MarkdownFs as a status line. It does **not** write the `wave/*` claim ledger (ADR-0003). The only coupling to the wave is the configured eligibility OR-set that tells `wave-plan` which issue-labels are grabbable. (Linear is now a near-term consumer — decided 2026-06-17 — which is *why* triage stopped being the one `gh`-coupled skill.)
- **`to-prd`** writes a PRD as repo-local markdown (config-pathed); GitHub-Discussion / wiki-page output is M2 cosmetics.
- **`grill`** is stack-agnostic (a planning conversation) → ships ~as-is.
- **Skills are rewritten generic, seeded by copy** — not placeholder-templated. The Ur's skills are so laden with structural specifics (§7.1 FF ritual, `.scratch` git-mv lifecycle, ADR re-reads) that templating would be a conditional jungle; cleaner to rewrite against GitHub + `IssueStore` + protected-main, using the Ur's skills as the *logic* reference.

---

## 11. ADRs to write inside flotilla

These cleared the "hard to reverse + surprising + real trade-off" bar during the grill — write them as the first ADRs in the new repo. They are numbered in the order the zoom-out grill resolves them, not the order below.

- **Written:** [`0001`](adr/0001-engine-identity-is-opaque-tracker-native-id.md) — engine issue-identity = opaque tracker-native id; path-coupled engine modules take `IssueView[]`.
- **Written:** [`0002`](adr/0002-two-scope-state-spine-authoritative-one-way-projection.md) — two-scope state: spine+disk authoritative, tracker projection one-way, spine-as-WAL, worktree-exists double-dispatch guard.
- **Written:** [`0003`](adr/0003-issue-labels-consumer-owned-wave-labels-flotilla-product.md) — issue labels are the consumer's; `wave/*` lifecycle labels are flotilla's product; coupled only by a configured eligibility OR-set.
- **Written:** [`0004`](adr/0004-ac-ground-truth-is-the-reviewer-verdict.md) — AC-verification ground-truth is the schema-validated reviewer verdict, not the tracker checklist; AC-count gate re-based to `acVerification` 1:1 coverage.
- **Written:** [`0005`](adr/0005-pr-route-protected-main-merge-terminality.md) — PR-route / protected main; merge execution (advisory + opt-in `--auto`), terminality = all-`in-review`, spine archived at `wave-close`, `done` derived.
- **Written:** [`0006`](adr/0006-needs-attention-is-an-orthogonal-flag.md) — `needs-attention` is an orthogonal attention flag (not a coarse rung), cleared on resolution, payload-carrying; the headless-async (mode II) bridge.
- **Written:** [`0007`](adr/0007-risk-is-a-load-bearing-key-config-authoritative.md) — `Risk` is a load-bearing routing key; enum vocab is `wave.config`-authoritative; M1 freezes Risk (only `Worker` trimmable), behaviour-map lifted in M2.
- **Written:** [`0008`](adr/0008-spine-stays-local-markdown.md) — the spine stays repo-local markdown (not tracker-native); rejected the GitHub-Projects alternative.
- **Written:** [`0009`](adr/0009-harness-agnostic-engine-no-dispatch-host.md) — harness-agnostic engine + Claude-Code skill driver; no `DispatchHost`; rejected the speculative abstraction.
- **Written:** [`0010`](adr/0010-flotilla-owns-the-complete-pipeline-mit-seeded.md) — flotilla owns the complete pipeline; front-half MIT-seeded from Matt Pocock with attribution; `to-issues` is dual-mode (create/decorate).
- **Written:** [`0011`](adr/0011-prd-is-a-tracker-document-not-a-wave-issue.md) — a PRD is a tracker document, not a wave issue: published via a tracker-agnostic Document facet (not `CreateInput`), no Header-Block / no eligibility marker; slices carry an explicit `Parent` backlink, and *consumed* is derived from those backlinks, never written. (Amended by the `to-issues` grill: `parent` in `AnnotatePatch`, single-parent forest, PRD-never-a-blocker.)
- **Written:** [`0012`](adr/0012-worker-is-brand-free-autonomy-first.md) — `Worker` is brand-free and autonomy-first (`background · background-heavy · foreground · HITL-required`); model tier resolves `heavy → <model>` through driver config, never the tracker label; `HITL-required` stays an eligible (human-gated) wave candidate; AFK = "implement unattended," not "land unattended."
- **Written:** [`0013`](adr/0013-parent-is-an-opaque-id-reference-not-an-issueref.md) — a slice's `Parent` backlink is the PRD's opaque id *string*, not an `IssueRef` (corrects ADR-0011): `parent` references a document's identity (ADR-0001), not a resolvable wave issue, and a markdown PRD's `<slug>#prd` id isn't `IssueRef`-representable; `consumed` derives by exact id match; `parse-ref` is left to invert `blockedBy` ids only.
- **Written:** [`0014`](adr/0014-dor-is-a-per-gate-deferring-validator-with-a-store-blind-structured-entrypoint.md) — `dor` gains an additive store-blind structured entrypoint `validateIssueView(view, {schema, repoRoot?})` for the non-file (`dor --id`) path; the file-path `validateIssue` is byte-identical. Gates split into three classes — self-content / working-tree / cross-issue (correcting filing-mechanics' content/filesystem binary); per-gate deferral is **capability-conditional** (a new `'deferred'` `GateStatus`, keyed on what's present, not on the store kind); `blocked-by-chain` defers on a bare id in M1 and is re-homed onto `IssueStore` in P2a (ADR-0001).
- **Written:** [`0015`](adr/0015-triage-is-a-tracker-agnostic-triage-facet.md) — `triage` stops shelling `gh` and writes through a tracker-agnostic **Triage facet** on `IssueStore` (`readTriage`/`applyTriage`/`closeUnplanned`), parallel to the Document facet (ADR-0011) — single-select/intent-shaped, universal across adapters, through the `GitHubApi` seam (the guardrail). Vocabulary becomes `DEFAULT_TRIAGE_SCHEMA` (known/typed, overridable, routing-core eligibility-blind); the disclaimer moves into the facet. Resolves a CHARTER §6 vs CONTEXT contradiction: `ready-for-human` (not wave work) is orthogonal to the `HITL-required` worker (wave work, human-gated) and is never an eligibility token. Driven by Linear becoming a near-term consumer (2026-06-17).
- **Written:** [`0016`](adr/0016-spine-creation-is-an-engine-owned-renderspine.md) — a fresh `WAVE.md` spine is produced by an engine `renderSpine` (+ a `spine create` CLI verb), not authored skill-side as the Ur did. It owns the resume-critical parsed structure (frontmatter + Plan-Table + empty log sections); the narrative `## DOR-check`/`## Conflict-Map` sections, which `readSpine` ignores, are injected as opaque skill-supplied strings ("A-struct"). Pairs printer with parser so the format can't drift (the dual source-of-truth the Ur had). Four deliberate de-couplings from the Ur format: `Reviewer` column is a uniform decoration (no Risk→profile map; flotilla's reviewer is universal), spine lives at `.flotilla/waves/` not `.scratch/`, no express variant in M1, simplified dispatch-order. `wave-create` is spine-first (ADR-0002 WAL). Surfaced by the P7.3 grill (2026-06-18).
- **Written:** [`0017`](adr/0017-linear-document-facet-maps-to-a-native-linear-document.md) — the M2 Linear adapter's **Document facet** (ADR-0011) maps a PRD to a **native Linear Document**, not an issue-with-a-`prd`-label as GitHub does: a Document is categorically not an issue, so ADR-0011's "never enters `listOpen('wave-ready')`" holds *structurally* (no label discipline). `publishDocument`→`save_document`/`content`, `readDocument`→`get_document`, `listDocuments`→`list_documents`; id = the Document uuid that slices carry as `Parent`. Optional richer binding: wave ≈ Linear **Project** with the PRD attached (`projectId`) recovers the sliced-from grouping GitHub gets free from the cross-ref. Verified against the server pilot's live Linear workspace (2026-06-19). No engine change. Forward-cross-ref mechanism deferred to the M2 build.
- **Written:** [`0018`](adr/0018-wave-execution-runs-on-a-single-workflow-driver-with-a-shared-skill.md) — the wave-**execution** skills (`wave-shared`/`wave-start`/`wave-reviewer`/`wave-close`) run on **one** dispatch mechanism, the Claude-Code **Workflow tool** (not the Ur's dual Workflow-driver-vs-prose-loop selector): `wave-start` fans Workers/Reviewers out via `agent({schema, isolation:'worktree'})` — structurally schema-validated, worktree-isolated, parallel, and **Coordinator-offloading** at every wave size (the Ur's reason for its driver → make it the default). Deterministic **routing** (`verdictToEvent`/`transition`) stays in the Coordinator skill via CLI, because a Workflow script can't import/shell the engine. Shared material (the two inlined schema literals + auth-preflight + routing/spine-write discipline) lives in a **`wave-shared` skill** with `disable-model-invocation: true`, invoked by name (Claude-Code best-practice for cross-skill sharing, not the Ur's references folder); a **`skill-schema-drift`** vitest guard pins the inlined literals to the engine consts. Surfaced + decided by the P7.4 grill (2026-06-19).
- **Written:** [`0019`](adr/0019-real-githubapi-is-raw-fetch-rest-graphql-behind-a-github-local-seam.md) — the P8 production `GitHubApi` is **raw `fetch`** REST (issue/label/comment/close) + **GraphQL** (the `getClosingState` closing-probe only, via `closedByPullRequestsReferences`), **not** `@octokit` (breaks the engine dependency floor) and **not** `gh` CLI (sandbox-denied creds → per-call `dangerouslyDisableSandbox`; `github.com` is sandbox-allowed). The network side-effect sits behind a **new GitHub-adapter-local `GitHubHttp` seam** (`GET/POST/PATCH/DELETE` + GraphQL, token auth, fixture-injectable) — *not* an extension of host-pr's cross-host `HttpProbe` (which is `GET|POST`/Basic, GitHub+Bitbucket). A **CLI-edge factory** `createGitHubApiFromEnv()` (env `GITHUB_TOKEN` + `detectHost` owner/repo) constructs the impl so `buildStore` stays a pure assembler (deferral-throw retained as safety net). Pagination = `per_page=100` count-heuristic (header-free); errors fail-fast + typed + construction-time `GET /user` preflight; tests stay hermetic (fixture-probe), live proof = the e2e runbook. Surfaced + decided by the P8 grill (2026-06-20).

- **Written:** [`0020`](adr/0020-linear-claims-live-in-workflow-states-triage-vocabulary-stays-labels.md) — the pulled-forward **`LinearIssuesStore`**: the claim ledger is written as the **native workflow state** (config-mapped `Todo / In Progress / In Review`; `done` derives from `completed`∪`canceled` types, lossy per ADR-0002; the board *is* the ledger), while everything vocabulary-shaped (Eligibility OR-set, triage vocabulary, `risk/*`/`worker/*`, `wave/needs-attention`) stays **labels** — GitHub parity. `blockedBy` reads as **body-codec ∪ native relations** (union — the DoR gate must see the consumer's existing native relations) but writes body-codec (native write = declared fast-follow); body-codec lifts to a shared adapter home. Closing probe = **Linear-only** via GitHub-integration attachments (magic word `Fixes DES-NN`); id = the human team key (`DES-16`), UUID seam-internal; `LinearApi` seam + fake must pass the conformance suite with **zero changes**; real impl = raw-`fetch` GraphQL behind `LinearHttp` (`LINEAR_API_KEY`, CLI-edge factory — ADR-0019 parity). Amends ADR-0015 (triage identity row). Re-scopes the M1 §6 live gate to the server pilot's Mock-Server wave. Grilled 2026-07-10.
- **Written:** [`0021`](adr/0021-wave-start-records-each-row-branch-in-the-dispatch-log.md) — `wave-start` durably records each dispatched row's branch (+ model, ADR-0012) in the spine `## Resume-Metadata` → `dispatch-log:` — the durable branch home the code already designated but nothing wrote. Three wires: `renderSpine` scaffolds the `dispatch-log:` key (ADR-0016 said "empty Dispatch-Log section" but shipped no key); a `spine set-branch` CLI verb exposes the existing `upsertDispatchLogEntry`/`upsertDispatchLogModel`; the dispatch WAL calls it. Found at the M1 live gate: with an empty log `branchesByIssueId` returns `{}` → `resume()` redispatches committed rows and discards work (the resume guarantee, an M1 requirement, was silently non-functional); `wave-close` merge-order degraded identically. Masked by resume/merge-order specs feeding hand-authored dispatch-logs — closed by a render→set-branch→resume seam test. The parse-back was Ur-coupled (`DISPATCH_HEAD` numeric-only, `BRANCH_REF` `wave-orch/`-only) → generalized to flotilla's `wave/<id>-<slug>` with alphanumeric ids (`DES-21`/`FOR-5`) so the recorded branch is actually recoverable. Amends ADR-0016. Found + fixed 2026-07-15 (FOR-5).
- **Written:** [`0022`](adr/0022-parked-is-a-claim-releasing-terminal-row-state.md) — the 11th fine state **`parked`**: "deliberately taken out of *this* wave, re-plan into a future one". Entry edges exactly `planned → parked` (held before dispatch) and `failed → parked` (the STOP disposition the coarse-projection comment always promised); **releases the claim immediately** (spine-first WAL, `unclaim` widened to any-rung → available); `coarse()` becomes honest — `ClaimRung | null`, `null` = no claim to hold; terminal-but-**silent** at close (passes the gate, never flagged — `failed`/`abandoned` = terminal + alarm, `parked` = terminal + silence), excluded from merge-order; Coordinator-set (no `WaveEvent`), offered as a scripted disposition at wave-start membership-resolution and the STOP menu, never automatic; **no un-park** (the released issue is back in the pool — a concurrent wave may hold it; re-entry = a fresh row in a future spine). Named `parked`, not `deferred` (collides with the ADR-0014 per-gate result) nor `held` (implies a retained claim). Live-gate finding P-2/P-5; grilled 2026-07-16 (FOR-7); build = FOR-14.
- **Written:** [`0023`](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md) — landing automation: `wave-close --auto` = **partial-arm** (the per-wave confirm arms exactly the rows in **no** Conflict-Map pair; the overlapping tail keeps the recomputed advisory merge-order as the human playbook — the ordered-landing strength survives automation; no second risk gate at landing, G3 already fired at verdict routing; headless requires explicit pre-authorize) **through the engine host seam** — new `host-pr create|arm|merge|status` CLI verbs (detect-host-routed, GitHub impls on `GitHubHttp`): GraphQL `enablePullRequestAutoMerge` when checks pend, REST merge when already clean; **`gh` leaves the landing and (staged) creation paths** (sandbox-denied creds, keychain/proxy TLS — P-6/w2-F4). Preconditions probed + displayed, never dictated (allow-auto-merge hard-probe — off by default on GitHub; required-checks report-only — no-CI ⇒ confirm = instant merge). **Arm-and-exit** (no `--watch`); done-reconcile evidence hierarchy **tracker attachment > host PR state > nothing** — mechanizes the FOR-13 `doneState` fallback on no-integration workspaces (incl. the Bitbucket+Linear pilot), docks onto FOR-20. Merge Queue never standard (paid on private repos); the M2 rebase-train = "the free merge queue" (OSS differentiator). Amends 0005/0019. Grilled 2026-07-16.
- **Written:** [`0024`](adr/0024-sidecars-are-written-at-agent-return-by-scribes-through-paired-write-verbs.md) — sidecars are written **at agent-return by Scribes through paired engine write verbs** (`write-report`/`write-verdict`, siblings of `validate-*` in `route-cli.ts`): live-gate P-1 showed the real WAL ≠ the assumed WAL — the Coordinator wrote sidecars bundled *after* routing, so a mid-wave death left zero durable records and resume depended on the harness journal flotilla doesn't own; P-8 showed the format was only derivable from `sidecar.ts` source. The verb owns filename (`<id>-<iter>.md`, engine-computed) + fenced-json format + validate-then-write (refuse invalid, exit codes mirror `validate-*`) + report/`--id` cross-check + `mkdir -p` + last-writer-wins overwrite; `--dir` explicit (read-side symmetry; layout stays skill convention). The Workflow driver's pipeline gains two cheap **Scribe** `agent()` stages (`worker → scribe(report) → reviewer → scribe(verdict)`) whose briefs carry the already-schema-validated JSON byte-exact — a Workflow script has no fs/shell, so a subagent is the only in-driver write path; a Scribe failure never discards the in-band tuple (try/catch + pass-through + loud log; Coordinator existence-check at routing writes a missing one via the same verb, documented recovery). The invariant is **per-path**: driver → Scribe stage (seam test proves zero Coordinator writes on the happy path); degenerate inline dispatch → the Coordinator is its own Scribe, same verb at return. Forbidden everywhere: bundled post-routing writes, hand-formatted sidecars. Rejected: Worker/Reviewer self-write (no engine/`.flotilla` in consumer worktrees; double-typing; pre-validation record), Reviewer-writes-report (write waits on Reviewer slot start — the P-1 window persists), a `resume-cli` journal-recovery path (harness dependence). Amends 0018; makes the 0002 resume doctrine true at work-completion time. Grilled 2026-07-19 (FOR-6); spec preserved in the private archive.

- **Written:** [`0025`](adr/0025-amend-is-a-minimal-authored-content-facet.md) — the **Amend facet**: `IssueStore.amend(id, {title?, sections?})` + `issue-store amend <id> --patch <json-file>` — the sanctioned path W4-F5 lacked (FOR-20 was re-scoped via raw Linear GraphQL, bypassing the seam). Grill reframe first: FOR-33's "no update verb" premise was too broad — `annotate` already surgically replaces the modeled Files/AC lists + upserts Parent + appends free sections, `applyTriage` already posts comments, `setBody`/`setDescription` exist on both seams; the verb-less gap was exactly **title** (no `setTitle` on any seam) + **replacing an existing free-prose section** (`appendBodySections` appends a shadowed duplicate). The patch is deliberately minimal — no files/AC/blockedBy/risk/worker: every modeled surface keeps its single owner, so the AC-clobber protection is **structural** (amend has no AC field; the `to-issues` decorate rule governs the one verb that can) and a full re-scope **composes `amend` + `annotate`**, two calls. New codec `upsertSection` (RESERVED collision throws → use annotate); `GitHubApi.setTitle`/`LinearApi.setTitle`; MarkdownFs swaps only the `# NN — Title` title part, filename stays (cosmetic slug, ADR-0001). Whole-patch validation before any write; empty patch = usage; races stay last-writer-wins like annotate. Rejected: widening annotate (intent merge + silent append→upsert semantics change), a full re-scope verb (two owners for Files/ACs, flag-grade AC protection, opens blockedBy), whole-body replace, a neutral comment verb. `amendDocument` shares the shape, deferred (earn-its-place). `public-API-change` — interface + 3 adapters + fakes + conformance move together. Grilled 2026-07-19 (FOR-33); build = FOR-33; spec preserved in the private archive.

- **Written:** [`0026`](adr/0026-publication-is-a-hard-cut-to-a-fresh-public-repo.md) — **publication is a hard cut to a fresh public repo**; the private history becomes the ops archive. Deciding fact: the confidential references live not only in the working tree and the squashed initial commit but in **PR bodies/reviews — GitHub data no history rewrite can clean** — so the existing repo can never flip public. A fresh repo takes the canonical name (`formtrieb/flotilla`, Apache-2.0, one clean initial commit of the de-cliented tree); dev incl. wave dogfood moves there; the private repo renames to `flotilla-archive` and freezes as ops/provenance home. Public doc-set = CHARTER/CONTEXT/ADRs/PROVENANCE **+ the retros** (show-your-work), de-cliented via the CONTEXT `Provenance` alias set (**the Ur / the wiki pilot / the server pilot**); PRD/CANARY/HANDOFF/plans/specs/CLAUDE-status stay private. Verification = a public check script reading a **gitignored denylist** (committing the list would publish what it guards — honestly a cut-time + local guard, not public CI). Durability = `.flotilla/` becomes a **nested ops git repo** pushed to `flotilla-archive` (toolkit-ignore rule holds), initial push before the repo dance. Distribution at cut = documented **vendor-copy**; npm/plugin = named post-publication tracks. Dogfood stays Linear (integration repointed); **one GitHub-Issues wave on the public repo is the planned live gate** for the least live-proven adapter that is simultaneously the primary OSS onboarding path. Sequencing: W7 hardening quartet (FOR-34/36/37/38, pre-cut, Scribe first live run) → W8 publication wave + ops runbook → cut → rails (FOR-27/28) → OSS polish (FOR-16/17) → GitHub gate wave → FOR-20 + remainder. Grilled 2026-07-19 (onboarding/publication scoping grill).

All twenty-six ADRs (the nine zoom-out decisions + the to-issues-scope follow-on + the PRD-as-document decision + the `to-issues` grill's Worker redesign + the parent-is-an-opaque-id correction + the M1 #4 dor-non-file design + the triage-facet decision + the P7.3 spine-creation decision + the Linear Document-facet mapping + the P7.4 execution-driver decision + the P8 real-GitHubApi decision + the Linear-adapter mapping + the dispatch-log branch-home fix + the parked row state + the partial-arm landing decision + the Scribe sidecar-write decision + the amend-facet decision + the publication-cut decision) are now written. ADRs **0005 / 0006 / 0016** were amended by the P7.4 grill (re-work-loop owner + rejected-PR + rebase-train resolved; `needs-attention` write-path = an `IssueStore` facet; `briefProfile` dropped from the reviewer verdict); ADR **0015** was amended by the Linear-adapter grill (2026-07-10: on Linear the triage vocabulary is labels — the workflow states belong to the claim ledger); ADR **0016** was further amended by the dispatch-log branch-home fix (2026-07-15: an empty Dispatch-Log heading is not a write target — the `dispatch-log:` key must be scaffolded and `wave-start` must write it); ADRs **0005 / 0019** were amended by the auto-merge grill (2026-07-16: `--auto` = **partial-arm through the engine host seam** — `gh` leaves the creation and landing paths; ADR-0023); ADR **0018** was amended by the Scribe sidecar-write grill (2026-07-19: the driver's responsibility grows a persistence duty — sidecars are written by Scribe stages at agent-return; ADR-0024).

---

## 12. Open questions / the "zoom-out" review pass

- **Walk the full chain step-by-step, then review it from the top** to find gaps the linear grill missed (planned activity).
- **`validate` and `summary` must earn their place.** They are thin *and* low-usage (the Ur's author almost never invoked them). They are **out of M1**; decide by actual usage whether they are worth porting at all.
- PRD home for the wiki pilot could ironically be a wiki page — revisit in M2.
- True compare-and-swap claim (atomic, race-free) for many concurrent coordinators — M2 hardening; the small-team convention ("one coordinator dispatches at a time; humans treat `in-flight` as hands-off") suffices first.
- **Merge/close open points (settle while building M1 — ADR-0005).** (1) the **re-work loop owner** — a change-requested `in-review` PR back to `reviewing`: wave-start re-entry vs human edit; (2) the **merge-time rebase-train** — merging #1 makes #2 un-mergeable, the worker is dead, who rebases? (ties to Q8); (3) a **PR closed without merging** needs a path back to `needs-attention`/`available`, not a dangling `in-review`.
- **Stale-claim reaper (idea, M2 hardening).** `wave-plan` could self-heal a field of stray claims left by other/dead coordinators — the cross-coordinator generalization of resume reconciliation (ADR-0002): both heal the tracker *from the authority*. Two mechanisms, different safety: **(a) truth-reconcile** — a claimed issue whose PR has merged / issue has closed → project `done` (always safe; could even be cheap in M1); **(b) TTL un-claim** — a claim older than a configured TTL (a `wave.config`/setup value) → `queued → available`. (b) must be **authority-aware** — only reap claims with *no live backing* (no spine/worktree behind them = orphaned), never on wall-clock age alone, or a legitimately long-running wave or a days-pending human STOP (§7) gets reaped out from under itself.
