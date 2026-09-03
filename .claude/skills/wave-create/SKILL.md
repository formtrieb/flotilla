---
name: wave-create
description: Use when turning a chosen set of issue ids into a wave that can actually be run — re-checks that every issue has what an agent needs, surfaces any overlapping files and any issue in the batch that has to wait for another one (stopping to ask before it goes ahead either way), writes the wave's own plan file, and marks the issues as taken so a second batch will not grab them. Triggers on "create the wave", "materialize wave <slug>", "build the spine for these issues".
---

# wave-create

Materialize one approved wave from a slug and a set of chosen issue ids (the human picked them via `wave-plan`): assemble the roster, run DoR + cross-wave, render the durable `WAVE.md` spine, create sidecar dirs, and set the `queued` soft-claim on each issue. **Does not dispatch** — that is `wave-start` (P7.4). **Does not author the `WAVE.md` markdown** — the engine `renderSpine`/`spine create` owns every parser-consumed section (ADR-0016); this skill supplies only the structured inputs and the opaque `## DOR-check` prose.

Your job is the **judgment** — assembling the roster, deciding whether DoR failures and cross-wave conflicts warrant proceeding or aborting, composing the payload, and setting the soft-claim in the right order. The CLI plumbing (the full worked sequence, the exact payload shape, a worked `payload.json`) lives in [reference/create-mechanics.md](reference/create-mechanics.md) — reach for it once the gate checks pass. You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

## When to Use

- The human has approved a set of issue ids from `wave-plan` and is ready to materialize the wave.
- You have a slug (e.g. `2026-06-18-triage-engine`) and a list of ids.

Do **not** use this for planning (that is `wave-plan`), for slicing work into issues (`to-issues`), or for dispatching workers (`wave-start`). wave-create is the materialization step; wave-plan is the advisory pass that precedes it.

## THE FLOTILLA BOUNDARY — spine-first always

**The spine is authority (ADR-0002 WAL).** Order is: render and flush the spine **first**, then transition each issue → `queued`. A crash between step 5 (spine flush) and step 6 (claim) leaves the spine intact and the claims re-assertable from it; claim-first would orphan a claim with no spine to reconcile against. Never invert this order.

## Procedure

### 1. Pre-flight

Abort (never overwrite) if `.flotilla/waves/<slug>.md` already exists. Slug shape: `YYYY-MM-DD-<topic>`.

### 2. Roster

Per chosen id, call two engine verbs:
- `issue-store read <id>` → `IssueView` (worker, risk, files)
- `issue-store triage-read <id>` → `TriageView` (`.title` for the roster row; `.body` for later)

Build each roster row as `{ id, title, worker, risk }`. The title comes from the **Triage facet** (`triage-read`) because `IssueView` carries no title — it is wave-header-only (ADR-0015). `triage-read` returns the native tracker title whether or not the issue was ever explicitly triaged. The same `TriageView` also carries `.body` — the full reported content — which is the **sanctioned source for embedding an issue's spec into a Worker brief at compose time** (`wave-start`), never a raw tracker API call reached for around it.

### 2a. Human-gate surface (surface + ask) — the row no agent may pick up

You have just read `IssueView.worker` for every chosen id. **A row whose Worker is the human-gated value must be surfaced here, before anything else happens to it** — the default token is `HITL-required` (the engine's `HUMAN_GATED_WORKER` in `tools/wave/src/wave-md-rw.ts`; the Worker vocabulary is consumer-configurable, so read the consumer's own set rather than assuming the spelling).

Such a row is **real wave work**: it enters the wave, gets a spine row, and takes the `queued` soft-claim exactly like any other row (ADR-0012). What it must never do is enter *silently*. A human-gated row that is materialized indistinguishably from background work is a row that reaches `wave-start` looking dispatchable — and gets fanned out to an unattended Worker that cannot do the one thing the row is waiting for.

So **surface + ask**, naming the row and stating plainly that no agent will pick it up until a human acts. Unlike the two cross-wave gates in step 4, the default here is **include-and-hold**, not abort:

- **Include it (the default).** It is materialized and claimed `queued`; `wave-start` then holds it in the visible human lane — never dispatched — until a human acts. The rest of the wave dispatches around it.
- **Act first, then include it.** The human does the thing now, in this session. The row then dispatches like any other row.
- **Drop it from the roster.** It stays `available` for a future draw — the same move as a DoR self-content FAIL you choose not to fix.

**The seam this reuses is HELD** — the intra-wave `Blocked by` hold `wave-start` step 3 already implements. A human-gated row and a blocked row are the same shape: materialized, claimed, `State: planned`, skipped at fan-out, and picked up unchanged by a later pass. Nothing new is invented; the only difference is the axis the hold reads — this row's own Worker, rather than another row's status.

**What this gate is NOT: a plan-time exclusion.** `wave-plan`'s contract deliberately *includes and flags* human-gated rows, and dropping one by hand hides a real node in the dependency graph. It is also not the triage terminal `ready-for-human`, which is not wave work at all and never reaches a roster (ADR-0015). Ask; do not decide silently in either direction.

Record the answer in the `## DOR-check` narrative you assemble in step 3 — row id, the human action it is waiting on, and which of the three options the Coordinator chose. `wave-start` re-derives the hold itself from the spine on every entry, so this narrative is the human-readable record, not the mechanism. Worked detail: [reference/create-mechanics.md](reference/create-mechanics.md).

### 3. DoR

Run `dor --id <id> --repo-root <consumer-root> --config <path-to-wave.config.json>` per chosen id. The `--repo-root` flag lets the engine run working-tree gates (glob resolution, literal-file existence) against the coordinator's checkout — without it, those gates defer. **`--config` is not the same optional convenience it is for `issue-store`/`cross-wave`:** those verbs fall back to a `wave.config.json` in the working directory when `--config` is omitted, but `dor`'s Gate 8 (`verify-profile-coverage`, below) only ever sees the consumer's `verify` block when `--config` names it explicitly on *this* call — running from the right directory is not enough. Pass it whenever a `wave.config.json` exists to point at (the ordinary case); only a genuinely config-less consumer leaves it off.

**Self-content FAIL stance — surface + ask, default abort.** A self-content FAIL (header not parseable, missing AC, risk-file-count mismatch) means the issue is not currently grabbable. Surface the failing issue and failing gate, then ask: drop the issue and continue with N−1, or fix the issue first? Do **not** silently fix or silently drop. `deferred` and `warn` outcomes never block — they show in the `## DOR-check` narrative but do not gate proceeding.

**`verify-profile-coverage` (advisory) — a row matching no verify profile must be *stated*, not silently equivalent to a gated one.** DoR now also intersects each row's declared `Files:` against the consumer's `wave.config.json` verify profiles' `appliesTo` globs — the same set arithmetic the cross-wave conflict check already performs, just against profiles instead of another row's files. A `warn` means the row's declared files match **no** configured verify profile: nothing will be compiled or tested for it, and a later Reviewer `approve` on that row is inspection-only, not verify-backed. This is a legitimate outcome, not a defect to fix — some work genuinely has no automated gate — so it never blocks and it never fails. It also never fires spuriously on a consumer with no verify profile configured at all (an empty or absent `verify`), and on a bare id with no repo checkout it `defer`s rather than guessing.

**`files-touched-since-tracker-update` (the staleness advisory) — an advisory hit means RE-READ the row body against `main` before dispatch.** Nothing else in this pipeline re-checks a decorated row's *premise* between decoration and dispatch: triage, decoration and both DoR gates all read the row, and none of them reads the ground the row stands on. This gate reads that ground — it asks git whether the repo's default branch has touched any of the row's declared `Files:` since the tracker last recorded a change to the row, and warns naming the touching commits when it has. It resolves the branch from the checkout (`origin/HEAD`, else `origin/main`/`main`/…) and **names the ref it compared against** in the warn text; read that, because a comparison against a bare `HEAD` on some feature branch is weaker evidence than one against `origin/main`.

**The required Coordinator response to a hit is a re-read, and it is yours to do — the engine deliberately stops at pointing.** Open the row body and check its acceptance criteria against the current default branch: does every mechanism, file, symbol and behaviour they name still exist and still mean what the row assumes? The live occurrence this gate exists for is exactly that shape — a row's ACs went on demanding a mechanism that a landed change had already retired, and it survived triage, decoration and *both* DoR gates before a hand read caught it. Then decide, and record the decision in the `## DOR-check` narrative: proceed (the premise still holds), amend the row first, or drop it from the roster. Do not skip the re-read because the wave is otherwise clean, and do not delegate the judgment to the Worker — the Worker's brief embeds the row's ACs as fact.

**Know what the window actually is.** "Last tracker update" is the tracker's last write of *any* kind — including flotilla's own claim writes (`issue-store transition <id> queued` in step 6 stamps the row). This step runs **before** the claim, so here the window is the real one: since the row was last authored or decorated. At `wave-start`'s re-check the same gate asks a narrower question — did the branch move since this wave claimed the row — which is the right question *there* and is exactly why the re-check exists, but is not a second opinion on the authoring-time premise. This step is where that opinion is formed; do not defer it to `wave-start`.

**It never blocks, and it is not evidence that anything is wrong.** Files moving is not proof a premise broke — most hits are a neighbouring change that leaves the row's assumptions intact. The gate is `warn`-only in every path and has no FAIL, so it can never abort a wave; what it changes is that "the ground moved under this row" is now *stated* instead of invisible. Treat a `deferred` here as a real gap, not a shrug: it means either no checkout was passed (`--repo-root` missing), or the store could not state when the row was last updated, or the checkout has no readable default-branch history — never "checked and clean". That distinction is the whole point of the `deferred` status: an unknown must never read like a pass.

Two situations used to render as the identical `deferred` text, leaving the narrative you write as the only thing telling them apart; the engine now spells them apart in the gate text itself (issue #676). **Resolvable** — `--config` was passed on the `dor` call above, `wave.config.json` loaded, and its `verify.profiles` (empty or not) were actually weighed against this row's files — now reads `pass`/`warn`, a real verdict: when the loaded config carries no `verify` block at all (or an explicit empty one), the text is `Verify config loaded — it declares no profiles, so nothing gates this row (inspection-only).`. **Genuinely absent** — no `--config` reached this call, so `verify` was never even in view — is now the *only* case left reading `deferred`, and says so directly: `No verify config reached this check — pass --config <path> so this call can read the consumer wave.config.json (its \`verify\` profiles drive Gate 8).`. The DoR step above should land in the resolvable state (`pass`/`warn`, never `deferred`) on every ordinary run; a `deferred` verify-profile-coverage line here is worth a second look, not a shrug — it means `--config` genuinely never reached the call. What it changes is that the gap can no longer pass unnoticed: name the warning row and its unmatched files explicitly when you write the narrative below, so an `approve` later in the wave is a choice the Coordinator/Reviewer made knowingly, not an accident indistinguishable from a fully test-backed row.

Capture the per-issue results — the full narrative becomes the spine's `## DOR-check` section (the one opaque, skill-side section; the engine never parses it). Any `verify-profile-coverage` warn belongs in this narrative **by name** (row id + the files that matched nothing) — and so does any `files-touched-since-tracker-update` warn: row id, the commits the gate named, and the outcome of the re-read you did ("premise re-read against `main`, still holds" / "row amended first" / "dropped"). Do not summarize either of them away as a generic "warnings present" line. `wave-start` re-runs DoR per row at its own dispatch step, so the same warn resurfaces there; keeping it explicit here is what lets it reach the Worker and Reviewer briefs instead of dead-ending in a narrative nobody reads closely.

### 4. Cross-wave

Write the chosen `IssueView`s to a temp file as the candidates array; run `issue-store listClaimed` for the claimed set; run `cross-wave --candidates … --claimed … --repo-root <consumer-root>` — **`--repo-root` is required here, never omit it** (FOR-38: without it, glob `Files` patterns cannot be expanded and the conflict check silently under-reports — the dangerous direction for a gate that defaults to proceeding when clean).

The result is `CrossWaveResult { parallelSafe, crossWaveConflicts, intraWaveConflicts, intraWaveBlockedByPairs, warnings? }`.

**Split the three result kinds — they have different destinations:**

- **`intraWaveConflicts` → the spine's Conflict-Map.** Build the payload's `conflict` field as `{ issues: <all chosen ids>, cells: result.intraWaveConflicts }`. The cells are already canonical (`a < b`, sorted). This records in-wave file overlaps so the Coordinator can plan sequencing within the wave.
- **`crossWaveConflicts` / `parallelSafe` → launch-gate, not spine state.** If `parallelSafe === false`, surface the cross-wave overlap (which ids, which files) and **ask the Operator, default abort**. They may override with an explicit serialization mitigation (e.g. "I know the other wave already landed; safe to proceed"). Never persist cross-wave conflicts in the spine.
- **`intraWaveBlockedByPairs` → a second, orthogonal launch-gate (FOR-8).** If non-empty, the roster contains a `Blocked by` pair where the blocker is ALSO in this same roster — surface every pair (which id blocks which) and **ask the Operator, default abort**, exactly like the file-conflict gate above, regardless of each pair's `resolved` flag. A blocker already `resolved` (shipped to `in-review`/`done`) is not automatically safe to wave together: `wave-start`'s own membership-resolution step (not this one) is what actually gates dispatch order, so wave-create's posture stays "surface + ask" for any intra-wave dependency — the human may confirm ("the blocker is a smoke-test row dispatched first on purpose") or drop one issue and re-plan. Never silently split the pair or reorder the roster to route around it.
- **`warnings` (FOR-38, present only when non-empty) → surface, do not treat a clean `parallelSafe` as trustworthy alongside it.** Each entry names a glob `Files` pattern that could not be expanded. This should never appear when `--repo-root` is passed correctly (the normal case here); if it does, treat it the same as a DoR self-content FAIL — surface + ask, default abort, rather than proceeding on an incomplete check.
- **No include-and-park at create time (ADR-0022).** `parked` is a real terminal row state, but it is **not** an escape hatch for this gate: do not resolve a blocked pair by admitting the blocked issue and immediately parking it. Default-abort stands. A row you already know you cannot run does not belong in the wave — **do not claim what you cannot run**. Parking is a *disposition for work already in a wave*, offered only by `wave-start` (membership resolution) and the STOP menu; at create time the equivalent move is simply to leave the issue out of the roster, where it stays `available` for a future draw. Rendering a row as `parked` in a fresh spine is always wrong.

### 5. Render (WAL — authority first)

Build the payload:
```
{
  meta: { slug, description, coordinator, model, created, lastUpdated },
  roster: [ { id, title, worker, risk }, … ],
  conflict: { issues: string[], cells: { a, b, files: string[] }[] },
  dorCheck: "<narrative from step 3>"
}
```

Stamp `created` and `lastUpdated` to today's date; set `coordinator` and `model` from this session. **Create the sidecar directories first** — `spine create` does not mkdir its parent, so `.flotilla/waves/` must exist before the spine write:

```
mkdir -p .flotilla/waves/<slug>/reports .flotilla/waves/<slug>/verdicts
spine create .flotilla/waves/<slug>.md payload.json
touch .flotilla/waves/<slug>/reports/.gitkeep .flotilla/waves/<slug>/verdicts/.gitkeep
```

`spine create` renders every parser-consumed section (frontmatter, Plan-Table with `State=planned`, `Reviewer=universal`, `PR=—`, `Iter=1`, sidecar links, `## Conflict-Map`). The `dorCheck` string is placed verbatim in the `## DOR-check` section.

### 6. Claim

Run `issue-store transition <id> queued` per issue — in the same order as the roster. A crash here leaves the spine intact; claims are re-assertable from the spine on resume. This is why the spine must be flushed first.

### 7. Report

Name every human-gated row you admitted in step 2a, and say what it is waiting on — the Coordinator running `wave-start` next must not have to rediscover it from the Plan-Table. Print the spine path. Note that Status is `draft` — left that way deliberately. There is no manual step: `wave-start` auto-flips `draft → ready` via `spine set-status` at dispatch (idempotent — a no-op if already `ready`), so the commit-to-scope decision is expressed by the act of running `wave-start`, never by manually editing the frontmatter. The next step is `wave-start`.

## Common Mistakes

- **Calling `spine create` before its parent dir exists.** `spine create` does not mkdir `.flotilla/waves/` — create the sidecar dirs first, or it ENOENT-fails.
- **Authoring `WAVE.md` by hand.** Use `spine create` — every parser-consumed section is owned by the engine (ADR-0016). Hand-authored sections will drift from the parser and corrupt resume.
- **Claim-first.** Always flush the spine before transitioning issues to `queued`. A `queued` claim with no spine orphans the claim; a spine with no claim is recoverable.
- **Putting `crossWaveConflicts` in the spine.** The spine's `## Conflict-Map` holds **in-wave conflicts only** (`intraWaveConflicts`). Cross-wave conflicts are a launch-gate; if `parallelSafe === false`, abort (or obtain an explicit mitigation) — never write the cross-wave overlap into the spine.
- **Skipping the `intraWaveBlockedByPairs` gate because the blocker looks "already resolved".** wave-create's job is to surface + ask, default abort, for ANY intra-wave `Blocked by` pair — resolved or not. Whether a resolved blocker actually unblocks dispatch is `wave-start`'s call at dispatch-time, not this skill's.
- **Admitting a blocked issue "and just parking it" (ADR-0022).** Parking is not a create-time move. Every fresh row is `planned`; a row rendered `parked` into a new spine claims an issue only to release it. Leave it out of the roster instead.
- **Skipping the pre-flight existence check.** `spine create` overwrites silently — it does NOT reject an existing path. The skill's step-1 existence check is the *only* guard against clobbering a durable, possibly in-flight spine. Never skip it.
- **Using the `conflict-map` CLI to build the spine's Conflict-Map.** `conflict-map` now has a store-backed `--id` entrypoint for non-file stores, but the spine build still goes through `cross-wave` — it computes the same cells *plus* the claimed-set comparison and the `intraWaveBlockedByPairs` this skill's gates need. Use `cross-wave` with the `IssueView[]` arrays, then extract `intraWaveConflicts` from the `CrossWaveResult`.
- **Deriving the roster title from `IssueView`.** `IssueView` has no title — it is wave-header-only. Always use `issue-store triage-read <id>` for the title.
- **Materializing a human-gated row silently, as if it were background work (step 2a).** A `HITL-required` Worker is not a decoration on an otherwise-ordinary row: it is the statement that no agent may pick the row up until a human acts. Surface it and ask. A row that enters the spine unannounced is a row the next `wave-start` fans out to an unattended Worker.
- **"Solving" a human-gated row by dropping it from the roster without asking.** The include-and-hold default exists because such a row is real wave work at a node other rows may depend on — `wave-plan` includes and flags it precisely so it is *visible*, not so it can be filtered out one step later. Dropping it is one of the three options the human picks from, never the one you take on their behalf.
- **Reading `HITL-required` as `ready-for-human` and refusing the roster.** They are two different "human" concepts at two pipeline stages: `ready-for-human` never enters a wave; a human-gated **Worker** does, and is merely gated (ADR-0015). Refusing to materialize one contradicts the eligibility that put it in the candidate set.
- **Dispatching from this skill.** wave-create ends at `queued` + `draft` spine. Dispatch is `wave-start`.
- **Treating a `verify-profile-coverage` warn as noise and summarizing it out of the `## DOR-check` narrative.** It is the one signal telling a later Reviewer that an `approve` on that row will be inspection-only — nothing compiled or tested — rather than backed by a real run. Keep the row id and its unmatched files verbatim; do not fold it into a generic "warnings present" line.
- **Widening a verify profile's `appliesTo` (or inventing a catch-all profile) just to make a `verify-profile-coverage` warn go away.** The warn is not a defect in the row — some work genuinely has no automated gate. Silencing it by changing the consumer's verify config hides exactly the fact the gate exists to surface; leave the config alone and let the warn stand.
- **Reading a `files-touched-since-tracker-update` warn and dispatching anyway without opening the row body.** The gate points; it does not judge. Its whole value is the re-read it asks for, and a hit that gets acknowledged in the narrative but never acted on is strictly worse than no gate — it makes an unchecked premise look checked. Open the row, check its ACs against the current default branch, then decide.

- **Treating a `files-touched-since-tracker-update` warn as a defect in the row, and dropping or "fixing" the row to silence it.** Files moving is not proof the premise broke. The ordinary outcome of the re-read is "still holds, proceed" — record that and move on. Amending or dropping is for a row whose premise the re-read actually found broken.

- **Reading a `deferred` staleness advisory as "nothing moved".** It means the gate could not run — no `--repo-root`, no tracker-update timestamp from the store, or no readable default-branch history in the checkout. That is an unknown, and it is why the status is `deferred` rather than `pass`. Pass `--repo-root` as shown above; if it still defers, say so in the narrative rather than letting the row read as premise-checked.

- **Reading a quiet `verify-profile-coverage` on a consumer with no `verify` configured at all as "checked and fine".** Zero configured profiles and "profiles exist but none matched this row" are both `pass`/quiet by design (AC4) — neither one is a claim that the row's work is gated. Don't infer verify coverage from the DoR narrative's silence; check whether the consumer's `wave.config.json` has a `verify` block at all.

## Operator register (Convention 16)

**Everything you print for the person at this session is operator-directed output, and it holds one register.** Plain language, direct address ("du"/"you"), self-explaining. Translate every internal reference — a decision-record number, a convention number, a finding id, a wave slug, a retro path — into the one-line consequence it carries for them, instead of naming it. Introduce a domain term with a half-sentence the first time it appears in a session, then use it freely. End the run with an operator block: what happened → where it lives → what you do next. Operator-directed text follows the operator's own language; the artifacts you write — issues, PRs, decision records, spine entries — stay English. **Installed form is strict** — no internal token reaches the operator. **Source form**, flotilla's own repo, may append one compact reference pointer after the plain text. Full clause text, the operator mini-glossary, and the mistakes it closes: [wave-shared/reference/convention-16-operator-register.md](../wave-shared/reference/convention-16-operator-register.md), read as a file beside this skill's own directory — no skill invocation, no namespace to guess.
