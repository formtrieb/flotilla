---
name: wave-close
description: Use when finishing a wave's host-side work — recompute the advisory merge order, clean up agent worktrees, flag stuck rows, and archive the spine. Re-entrant + idempotent; opt-in --auto partial-arms the order-free rows through the engine host-pr verb and exits (ADR-0023). Triggers on "close the wave <slug>", "finalise wave <slug>", "archive wave <slug>".
---

# wave-close

The operational terminator for a wave: confirm every row has reached `in-review`, clean up the wave's agent worktrees **before** anything merges (a worktree or a plain branch-checkout both silently break `--delete-branch`), recompute and **print** the advisory merge order (read-only — no parser-consumed section is mutated) so the human merges each PR and then verifies branch deletion as its own checked step, **land each merged row `done`** via the done-reconcile (the existing `issue-store close` verb) — **ticking the reviewer-met ACs it carries** (`--acked`, derived per-row from the FINAL Reviewer verdict via the engine's `verdict-acked` verb, FOR-17) — flag any closed-unmerged or stuck rows, and archive the spine to `_archive/`.

Load **wave-shared** by name first — it owns the auth-preflight / atomic-spine conventions this skill obeys.

Your job is the **judgment** — the terminality gate, deciding when a closed-unmerged PR or a stuck row becomes a `needs-attention` flag (and when a row with *no* merge evidence is merely reported, not flagged), and calling the archive at the right moment. The CLI plumbing (exact invocations, JSON shapes, exit codes, the worked sequence) lives in [reference/close-mechanics.md](reference/close-mechanics.md). You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

## When to Use

- Every Plan-Table row has reached `in-review` (the terminality gate below) and the Coordinator is ready to land.
- A prior `wave-close` run was interrupted (token outage mid-flight) — every phase is a guarded no-op when its work is already done; run as many times as needed.

Do **not** use this to dispatch (`wave-start`), to plan (`wave-plan`), or to merge `main` by hand. flotilla lands every change through a PR on protected `main` — there is **no fast-forward of `main`** here (the Ur's §7.1 branch-sync is gone). This skill recommends a merge order; the merge itself is either a human action (the default) or, with opt-in `--auto`, a **partial-arm** through the engine's `host-pr` verb — the order-free rows are armed server-side and the skill exits (ADR-0023). PR *creation* still rides the Worker terminator; moving it to the staged `host-pr create` verb is a later slice (ADR-0023 decision 3), out of scope here.

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

Do not open PRs or archive for a wave that has unfinished rows.

## Procedure

Each phase's full worked body — guards, worked command blocks, live-finding annotations, and that phase's own Common-Mistakes bullets — lives in its own file under [reference/](reference/), named by phase number. **Load every file in that directory, not a subset picked by name** — a sibling's "phase N" citation resolves to real prose only once the whole directory has been read. This loader deliberately does not enumerate what's in there: a new guard or a new live finding is a new edit to its one phase file, with zero edits to this file or to any sibling phase file required. The numbering below (`1`, `2`, `3`, `4`, `4a`, `4b`, `5`, `6`) is the stable identifier sibling skills cite (e.g. "wave-close phase 4b").

### 1. Load wave-shared + gate

Load wave-shared, read the spine, and confirm the terminality gate before doing anything else; a re-run on an already-archived wave is a guarded no-op past this point.

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

Probe each terminal row's closing state via the evidence hierarchy, then land it `done`, flag it, or report it — never guessing between merged and rejected.

### 6. Archive (the last phase — terminal-only, idempotent, layout-aware)

Once every row is finalised, detect the consumer's actual git-tracked status and archive the spine plus its sidecar folder to `_archive/`, never to `done/`.

## Common Mistakes

Phase-specific mistakes live with their phase in [reference/](reference/). These three are genuinely cross-phase:

- **Recording a held row as `abandoned`.** `abandoned` means "never"; a row held out of this wave for re-planning is `parked` ("later"). Recording it `abandoned` lies to the next planner and leaves the claim stuck on the board — this is the live-gate defect ADR-0022 exists to fix.
- **Merging `main` or fast-forwarding.** wave-close recommends an order and, opt-in via `--auto`, arms the order-free rows through the engine `host-pr` seam (ADR-0023) — it never touches `main` directly. The Ur's §7.1 branch-sync is gone.
- **Reaching for raw `gh` to arm/merge, or expecting a `host-pr create` verb.** The three **landing** verbs `host-pr arm | merge | status` are shipped and are the only host-write path (ADR-0023 — `gh` left the landing path entirely). The **creation** verb `host-pr create` is the *staged* half and is not yet a CLI verb; PR creation still rides the Worker terminator.

## Related

- [reference/close-mechanics.md](reference/close-mechanics.md) — the worked CLI sequence, JSON shapes, exit codes.
- [../wave-shared/SKILL.md](../wave-shared/SKILL.md) — auth-preflight / atomic-spine conventions this skill inherits.
- [../wave-start/SKILL.md](../wave-start/SKILL.md) — the dispatch loop that brings rows to `in-review`, the precondition for wave-close.
- [../wave-create/SKILL.md](../wave-create/SKILL.md) — materialises the spine this skill terminates.
