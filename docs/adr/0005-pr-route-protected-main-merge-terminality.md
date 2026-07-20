# PR-route by default; protected main; merge execution, terminality & a derived `done`

flotilla lands **everything via PRs against a protected `main`** — never a direct default-branch push, including orchestration artifacts. The spine rides the wave branch as a branch-local archive and does not merge to `main`. This is flotilla's one deliberate divergence from the Ur's FF ritual (it makes the Ur's §7.1 FF-classifier gate vanish — there is no direct-push path to classify). On top of that core, this ADR pins the merge/close mechanics the move to GitHub exposed.

## Merge execution

- **wave-start** ends the dispatch/review loop with **all rows `in-review`** (PRs opened) and proposes an **initial, advisory merge-order**. It never merges and never sets `done`.
- **wave-close** is the (possibly later) merge phase. Because PRs are revised after review, it **recomputes** the merge-order, then either recommends it (default) or — **opt-in `auto`** — executes it via `gh pr merge --auto` per the order, letting **GitHub complete the merge server-side** (this survives a dead/idle Coordinator — no live re-push needed). A PR that cannot auto-merge (out-of-date without a merge queue, failing check, conflict, required human review) → **`needs-attention`** (§7, Q7), a human resolves.

## Terminality & the spine

- **Wave terminality = all rows `in-review`** (the Ur's "all rows `pr-created`" generalized). The wave does **not** block on merge.
- The **spine is archived at `wave-close`**, not at `wave-start` — wave-start ends the dispatch loop, but the spine must stay live for the merge phase.

## `done` is a derived bookend

- A wave-tracked issue is **`done` ⟺ it is natively closed** (via `Closes #N` on the merged PR) — visible truth on GitHub, **no `wave/done` label is written**. This is symmetric with `available` (ADR-0003): flotilla **actively writes only `queued / in-flight / in-review` (+ `needs-attention`)**; `available` and `done` are the derived endpoints.
- `GitHubIssuesStore.close()` is therefore **no-op-or-reconcile**: the PR's `Closes #N` performs the native close; `close()` only records `ackedACs[]` and ticks the cosmetic AC body (ADR-0004), and may optionally clean up the stale `wave/in-review` label.

## Considered Options

- **Human-only merge** (the Ur) — kept as the *default* advisory mode.
- **wave-close auto-merge** — adopted as an *opt-in* mode via GitHub's server-side `--auto`, which is the only form safe under a dead Coordinator.
- **Block wave terminality on merge** (rejected) — merges can be post-session; terminality is `in-review` and `done` reconciles later.

## Resolved (P7.4 grill, 2026-06-19)

The three points this ADR left open are now settled:

- **The re-work-loop owner = `wave-start`, bounded and autonomous.** `wave-start` is the loop driver: it routes the reviewer verdict through `verdictToEvent` → `transition`, which already encodes a **cap=1 re-dispatch** (`reviewing` + `changes-requested-1st` → `re-dispatched`; a 2nd `changes-requested` → STOP `re-dispatch-cap-exhausted`). The first changes-requested **auto-re-dispatches a fresh Worker onto the same branch/worktree**; the second STOPs and `wave-start` raises **`needs-attention`** (ADR-0006) and pauses the row. This preserves the AFK premise (autonomy with a bounded loop) and is consistent with the headless-async bridge — adopting the engine-tested semantics rather than a human-gated edit. So `wave-start` is a **stateful loop**, not a one-pass dispatcher ([ADR-0018](0018-wave-execution-runs-on-a-single-workflow-driver-with-a-shared-skill.md)).
- **PR closed without merging — owned now.** A PR that closes without merging is detected by the adapter-agnostic **closing-probe** (`closedBy`, P7.4) + `classifyClosedBy`, and `wave-close`/`resume` raise **`needs-attention`** rather than letting the row dangle at `in-review`. The default is *not* an auto-return to `available` — a rejected PR re-grabbed by another wave would redo deliberately-rejected work; the human dispositions it (re-plan / abandon / fix).
- **Merge-time rebase-train — deferred to M2, risk surfaced in M1.** Full automation (detect #2 fell behind after #1 merged → rebase → re-run the dead Worker) is M2. In M1, `wave-close` recomputes the **advisory merge-order** and, when `--auto` lets a later PR fall behind, raises **`needs-attention`** with a rebase note rather than failing silently. Under the default advisory-merge mode the human merges in the recommended order and handles rebases at merge time, so flotilla's M1 job here is the order recommendation + the no-silent-failure flag.

## Amended — partial-arm through the engine host seam ([ADR-0023](0023-landing-is-partial-arm-through-the-engine-host-seam.md), 2026-07-16)

The opt-in `auto` mode keeps this ADR's core property (server-side completion — survives a dead Coordinator) but is refined twice. The shape is **partial-arm**: the per-wave confirm arms only the order-free rows (those in no Conflict-Map pair); overlapping rows keep the recomputed advisory order as the human playbook — not arm-all + fall-behind flags, which would knowingly convert *predicted* overlaps into `needs-attention` noise. And the transport is **the engine host seam, not `gh`**: GraphQL `enablePullRequestAutoMerge` / REST merge under the ambient `GITHUB_TOKEN` (the token the FOR-12 preflight already probes for merge rights) — this ADR's literal `gh pr merge --auto` wording is superseded (gh's sandbox-denied creds + keychain/proxy TLS failures, live-proven P-6/w2-F4).
