---
name: wave-close
description: Use when finishing a wave's host-side work — recompute the advisory merge order, clean up agent worktrees, flag stuck rows, and archive the spine. Re-entrant + idempotent; opt-in --auto partial-arms the order-free rows through the engine host-pr verb and exits (ADR-0023). Triggers on "close the wave <slug>", "finalise wave <slug>", "archive wave <slug>".
---

# wave-close

The operational terminator for a wave: confirm every row has reached `in-review`, clean up the wave's agent worktrees **before** anything merges (a worktree or a plain branch-checkout both silently break `--delete-branch`), recompute and **print** the advisory merge order (read-only — no parser-consumed section is mutated) so the human merges each PR and then verifies branch deletion as its own checked step, **land each merged row `done`** via the done-reconcile (the existing `issue-store close` verb) — **ticking the reviewer-met ACs it carries** (`--acked`, derived per-row from the FINAL Reviewer verdict via the engine's `verdict-acked` verb, FOR-17) — flag any closed-unmerged or stuck rows, **gate the archive on TWO fail-closed engine checks — both read by exit code alone, both blocking**: every disclosure carrying a disposition (`spine check-disclosures`, ADR-0027) *and* no human-gated row still holding the live `queued` claim it was never dispatched to release (`spine check-awaiting-human`, [reference/phase-6-archive.md](reference/phase-6-archive.md)) — and archive the spine to `_archive/`.

Load **wave-shared** by name first — `/wave-shared` project-local, `/flotilla:wave-shared` once consumed via the installed plugin (wave-shared's own [plugin-namespaced by-name loads](../wave-shared/SKILL.md) note has the finding) — it owns the auth-preflight / atomic-spine conventions this skill obeys.

Your job is the **judgment** — the terminality gate, deciding when a closed-unmerged PR or a stuck row becomes a `needs-attention` flag (and when a row with *no* merge evidence is merely reported, not flagged), and calling the archive at the right moment. Each phase's worked sequence — exact invocations, live-finding annotations, Common Mistakes — lives with that phase under [reference/](reference/); the pieces genuinely common to every phase (CLI resolution, the full command reference, exit-code tables, shared JSON shapes) live in [reference/close-mechanics.md](reference/close-mechanics.md). You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

## When to Use

- Every Plan-Table row has reached `in-review` (the terminality gate below) and the Coordinator is ready to land.
- A prior `wave-close` run was interrupted (token outage mid-flight) — every phase is a guarded no-op when its work is already done; run as many times as needed.

Do **not** use this to dispatch (`wave-start`), to plan (`wave-plan`), or to merge `main` by hand. flotilla lands every change through a PR on protected `main` — there is **no fast-forward of `main`** here (the Ur's §7.1 branch-sync is gone). This skill recommends a merge order; the merge itself is either a human action (the default) or, with opt-in `--auto`, a **partial-arm** through the engine's `host-pr` verb — the order-free rows are armed server-side and the skill exits (ADR-0023). PR *creation* rides the Worker terminator, through the shipped `host-pr create` verb (ADR-0023 decision 3, find-before-create) — wave-close itself never creates a PR, only lands one, and that stays out of scope here.

## THE FLOTILLA BOUNDARY — protected main, PR-only, spine never edits main

- **Never push to `main`.** Landing is per-PR through the protected-branch route. wave-close recomputes the advisory order and, opt-in via `--auto`, arms the order-free rows through the engine `host-pr` seam (ADR-0023) — it does not merge `main` itself and never fast-forwards it.
- **Archive to `_archive/`, never to `done/`.** flotilla has no `git mv`-to-`done/` close ceremony (that is an Ur binding). The spine and its sidecar folder move together into `.flotilla/waves/_archive/`.
- **Advisory merge-order is print-only.** The recomputed merge order is printed to stdout (advisory). It is **not** written into the spine's `## Conflict-Map` — that section is parser-consumed (ADR-0016 forbids skills hand-authoring parser-consumed spine content; there is no CLI verb to write an advisory order into `## Conflict-Map` separately from the conflict pairs, and `spine replace-closed-by` targets the `## Closed-by` section, not `## Conflict-Map`).
- **Idempotent — read before mutate.** Every mutating step checks state first: skip already-flagged rows, skip already-archived spines.
- **Self-repair hazard — every engine verb this skill calls predates the wave.** `issue-store read-closing`, `merge-order`, `worktree-cleanup`, the `host-pr` routing verbs (`arm`/`merge`/`status`), and `issue-store close` all run from the **local checkout** — and that checkout sits at the **wave anchor**, i.e. the code as it was BEFORE this wave's rows landed. A wave whose own rows change any of that machinery cannot reconcile against its own fix until the merge is pulled locally. Phase 4a below gives the mechanical detection step and the required `merge → pull → reconcile` order (W4-F1 / W5-F3).

## Terminality gate

wave-close runs only once the wave is **all-in-review**: every Plan-Table row's reconstructed coarse rung is `in-review` (its Worker finished and its Reviewer approved — the row reached `approved`/`pr-created`). Check by reading each row's `State` cell via `spine read`:

- A row still at `dispatched`/`re-dispatched`/`reviewing`/`verdict-in`/`report-in` means the wave isn't done → STOP: `wave not yet terminal — N row(s) still in flight; run wave-start (or resume) first`.
- `failed`/`abandoned` rows are terminal; include them in the gate check but they do not block closing — they will be flagged in phase 5.
- **`parked` rows are terminal and silent** (ADR-0022). They pass the gate and never block closing. A parked row was deliberately taken out of *this* wave and its claim is already released — it is **not** a problem to flag, has no branch and no PR, and gets its own report rubric in phase 5. It is the reason a held row no longer has to be recorded as `abandoned` (which would mean "never" for work that will be re-planned).
- **A row still at `planned` was HELD, never dispatched — report it, do not STOP on it.** `planned` is deliberately absent from the STOP list above: it is where both of `wave-start`'s holds park a row that this wave never sent out. Two shapes, distinguished by the row's `Worker` cell:
  - **awaiting-human** — the `Worker` is human-gated (`HITL-required` by default, ADR-0012) and no human has acted yet. The row is **awaiting a human, not stuck and not errored**: nothing failed, nothing is in flight, and no probe can tell you anything about it. Phase 5 has its rubric.
  - **HELD on an intra-wave blocker** — the `Worker` is ordinary; the row waited on a sibling that has since landed (or has not). Same treatment: report it, name what it waits on.

  Neither blocks closing, and neither is a `needs-attention` flag — but neither is finished either, so **read the `Worker` column when you read the `State` column**. A `planned` row reported as "stuck" or silently swept into the archive is the failure this bullet exists to prevent.

Do not open PRs or archive for a wave that has unfinished rows.

## Capture a find where it surfaces — the window closes at the archive

A find that surfaces while you are closing is captured into the spine **the moment it surfaces**, in the phase it surfaced in — not at the end of the run, and never out of your own memory. The capture window runs from verdict-routing through every close phase and ends **hard at the archive move in phase 6** (ADR-0038): while the spine is live it is a write target, once archived it is evidence, and a find that arrives after that goes straight onto the tracker as a bare issue with a provenance line instead.

One verb, two spellings — reach for whichever the find actually is:

- **Row-scoped** — a Plan-Table row and an iteration own the find (a stuck row's residue, a merged row's leftover branch):
  ```bash
  {{wave-cli}} spine add-disclosure <wave-file> <row-id> --iter <n> --source coordinator --text "<the gap>"
  ```
- **Wave-scoped** — the find is about the wave's OWN machinery and no row owns it: the worktree sweep, a phase-2 auth posture, the merge-order tool itself.
  ```bash
  {{wave-cli}} spine add-disclosure <wave-file> --wave --source coordinator --text "<the gap>"
  ```
  Do **not** hang such a find on an arbitrary "affected" row to make it fit the row-scoped form: that corrupts row-scoped counting and has no answer at all for a find with no affected row (the option ADR-0038 rejected by name).

Both forms land in the same table, both are counted by phase 6's disclosure gate, and `coordinator` is the source for anything you observed yourself. Both invocations are in the command table at [reference/close-mechanics.md](reference/close-mechanics.md).

**Why this is doctrine and not a gate.** The phase-6 gate forces a *disposition* onto what was recorded; it can never force *capture* — you cannot gate what was never written down, so this rule is capture's only carrier, deliberately (ADR-0038). What it protects is less the lost find than the **uncounted** one: the spine's Disclosures table is the occurrence counter for sub-ticket findings, and a find that lived only in one session's memory never reaches the recurrence that earns it a ticket.

**A close-visible measurement you can predict at routing is pre-captured there instead** — as a measurement-point disclosure, so the archive gate later forces the measurement itself to happen and its disposition carries the measured evidence. Pre-capture carries what you could foresee; this window carries what you could not (ADR-0038). Neither replaces the other.

## Procedure

Each phase's full worked body — guards, worked command blocks, live-finding annotations, and that phase's own Common-Mistakes bullets — lives in its own file under [reference/](reference/), named by phase number. **Load every file in that directory, not a subset picked by name** — a sibling's "phase N" citation resolves to real prose only once the whole directory has been read. This loader deliberately does not enumerate what's in there: a new guard or a new live finding is a new edit to its one phase file, with zero edits to this file or to any sibling phase file required. The numbering below (`1`, `2`, `3`, `4`, `4a`, `4b`, `5`, `6`) is the stable identifier sibling skills cite (e.g. "wave-close phase 4b").

### 1. Load wave-shared + gate

Load wave-shared (`/wave-shared` project-local, `/flotilla:wave-shared` once consumed via the installed plugin), read the spine, and confirm the terminality gate before doing anything else; a re-run on an already-archived wave is a guarded no-op past this point.

### 2. Auth preflight (skip when no host writes pending)

Skip the network entirely when every row's `Closed-by:` already classifies as a real PR; otherwise detect the host and verify auth before any write.

### 3. Worktree cleanup — BEFORE the merge

Clean up this wave's agent worktrees and sweep orphaned branches/directories — unconditionally, every time — so nothing still holds a wave branch locally by the time anyone reaches the merge step.

### 4. Advisory merge-order (print-only) — the merge happens here, verify branch deletion separately

Recompute and print the advisory merge order, merge each PR through the engine host seam, and verify branch deletion as its own checked step — the merge command's exit code alone is never evidence the branch is gone.

### 4a. Self-repair check + pull to completion before you reconcile (W4-F1 / W5-F3)

Detect whether this wave's own rows changed the engine surface wave-close depends on, then pull `main` to a verified completion before phase 5 reconciles against it.

### 4b. `--auto` — partial-arm confirm + arm-and-exit (opt-in)

Opt-in only: present one confirm for the wave, arm the order-free rows through `host-pr arm`, then exit without watching — the overlapping tail stays on the phase-4 advisory order.

### 5. Done-reconcile + needs-attention for stuck rows

Probe each terminal row's closing state via the evidence hierarchy, then land it `done`, flag it, or report it — never guessing between merged and rejected. A never-dispatched row (`parked`, or `planned` in one of the two held lanes) is reported under its own rubric and never probed: there is nothing for a probe to find, and a flag would answer a question nobody asked.

### 6. Archive (the last phase — terminal-only, idempotent, layout-aware)

**Two** fail-closed gates run first, in this order, each read by exit code alone. The disclosure gate: `spine check-disclosures` blocks on any `open` entry, and every open disclosure the wave surfaced must carry a disposition — one of exactly `resolved-in-slice | scope-extension | filed:<id> | dropped:<reason>` — before the archive proceeds (ADR-0027). The gate checks existence only and never judges quality, so **which** disposition to reach for is your judgment, guided by the defaults in the phase file: a disclosure earns its own ticket only when it names a mechanism defect with an observed consequence, everything else bundles thematically via a shared `filed:<id>` (N:1, appends only while that bundle is still bare), and a `filed:` body carries the observation — symptom, evidence, provenance — never an unverified diagnosis (ADR-0027 Amendment 2026-07-31). Then the awaiting-human gate: `spine check-awaiting-human` blocks while any human-gated row still sits at `planned` holding the live `queued` claim nothing ever released, and it offers exactly two exits — the human acts and the row dispatches, or the row is parked and unclaimed ([reference/phase-6-archive.md](reference/phase-6-archive.md), park per ADR-0022). Both gates are fail-closed in both directions: an unreadable spine blocks exactly like a real finding. Once both are clear and every row is finalised, detect the consumer's actual git-tracked status and archive the spine plus its sidecar folder to `_archive/`, never to `done/`.

## Common Mistakes

Phase-specific mistakes live with their phase in [reference/](reference/). These three are genuinely cross-phase:

- **Recording a held row as `abandoned`.** `abandoned` means "never"; a row held out of this wave for re-planning is `parked` ("later"). Recording it `abandoned` lies to the next planner and leaves the claim stuck on the board — this is the live-gate defect ADR-0022 exists to fix.
- **Merging `main` or fast-forwarding.** wave-close recommends an order and, opt-in via `--auto`, arms the order-free rows through the engine `host-pr` seam (ADR-0023) — it never touches `main` directly. The Ur's §7.1 branch-sync is gone.
- **Reaching for raw `gh` anywhere on the host path.** `gh` left the landing path entirely (ADR-0023): the shipped `host-pr` verbs (`create | arm | merge | status | preflight`) are the only host-write path. wave-close itself only ever calls the **landing/probe** ones (`arm`/`merge`/`status`/`preflight`) — PR **creation** rides the Worker terminator's own `host-pr create` call, not wave-close.

## Related

- [reference/close-mechanics.md](reference/close-mechanics.md) — the cross-phase remainder: CLI resolution, the full command reference, exit-code tables, and the JSON shapes shared across phases. Each phase's own worked sequence lives with that phase, not here.
- [../wave-shared/SKILL.md](../wave-shared/SKILL.md) — auth-preflight / atomic-spine conventions this skill inherits.
- [../wave-start/SKILL.md](../wave-start/SKILL.md) — the dispatch loop that brings rows to `in-review`, the precondition for wave-close.
- [../wave-create/SKILL.md](../wave-create/SKILL.md) — materialises the spine this skill terminates.
