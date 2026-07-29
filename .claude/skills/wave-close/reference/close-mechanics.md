# wave-close — close mechanics

The engine-CLI plumbing that is genuinely **cross-phase** — the pieces every phase file would otherwise have to repeat under its own roof. The skill body owns the **judgment** (terminality gate, auth-preflight stop, the flag decision, archive-only-when-terminal); each phase's own worked sequence — the exact invocations, live-finding annotations, and Common Mistakes for that phase — lives in its [reference/](.) phase file (`phase-1-load-gate.md` … `phase-6-archive.md`), not here. This file holds only what does not belong to any single phase: CLI resolution, the full command reference, the exit-code tables, the JSON shapes shared across phases, and the disclaimer.

> **The CLI is the source of truth for shapes.** Every command prints usage with no args and validates its input. The JSON below are worked examples — if one disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution

In-repo: `npx tsx tools/wave/src/cli.ts <verb> …` for top-level verbs; `npx tsx tools/wave/src/cli.ts issue-store <op> …` for issue-store verbs; `npx tsx tools/wave/src/spine-cli.ts <op> …` for spine verbs (or via the top-level CLI relay `npx tsx tools/wave/src/cli.ts spine <op> …`). Run from a directory with `wave.config.json`, or append `--config <path>` **after** the subcommand + op. The store (`markdown` or `github`) is selected there — you never name a tracker.

## Commands

| Call | Purpose / shape |
|---|---|
| `{{wave-cli}} spine read <wave-file>` | print the spine source (raw markdown) |
| `{{wave-cli}} issue-store read-closing <id>` | `ClosingState` JSON: `{ "state": "open"\|"merged"\|"closed-unmerged"\|"closed-unknown", "prUrl": "…" }` — `closed-unmerged` = a PR was found and did NOT merge (a real rejection → flag); `closed-unknown` = closed with NO PR evidence either way (→ report + ask, never auto-flag) |
| `{{wave-cli}} verdict-acked <verdictsDir> <id>` | (FOR-17) the single-owner derivation of `close`'s `--acked` indexes: `{ "acked": [0, 2], "iter": 2\|null, "corrupt": 0 }`. Reads the MAX-iter valid ReviewerVerdict sidecar for `<id>` out of `<verdictsDir>` and returns the 0-based `acVerification` indexes marked `met` (`metAcIndexes()`, reviewer-verdict-schema.ts) — partial/not-met/deferred excluded. Max-iter means a changes-requested → re-dispatch cycle's answer is always the LATEST verdict. No verdict sidecar (or only a corrupt one) → `{ acked: [], iter: null, corrupt: 0 }`, never a failure — the tick is cosmetic (ADR-0004). |
| `{{wave-cli}} issue-store close <id> <prUrl> [--acked 0,2,3]` | the done-reconcile: records the closing PR + cosmetic AC tick from `--acked` (source it from `verdict-acked`, above — never hand-parse a verdict). Idempotent no-op-or-reconcile; on a `states.doneState` store with no integration it forces the mapped done-state transition + a loud advisory (FOR-13). The existing `IssueStore.close()` verb — never re-implemented. |
| `{{wave-cli}} closed-by "<closed-by-line>"` | `{ "class": "real-pr"\|"pre-fill"\|"placeholder"\|"sha"\|"prose"\|"empty", "needsPin": true\|false }` |
| `{{wave-cli}} detect-host "<remote-url>"` | `{ "host": "github"\|"bitbucket"\|"unknown", "workspace": "…", "repo": "…" }` |
| `{{wave-cli}} merge-order <wave-file>` | `{ "algorithmic": [branch, …], "override": [branch, …]\|null, "hasOverride": boolean, "reason": "…" }` |
| `{{wave-cli}} worktree-cleanup [--dry-run] --wave <wave-file> --orphans` | `{ "removed": [], "skipped": [], "errors": [], "branchesDeleted": [], "branchHygieneSkipped": [], "orphans": {...} }` — always pass `--orphans`; a `0/0/0` `removed/skipped/errors` triple is not evidence of "nothing to do" on its own, check `branchesDeleted`/`orphans` in the same payload (close-review finding). With `--dry-run --orphans`, the JSON also carries `orphanBranches: { toDelete, branchHygieneSkipped }` (issue #148) — see phase 3 for the one residual preview/execute asymmetry. |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>"]` | set needs-attention (orthogonal to the rung) |
| `{{wave-cli}} issue-store clear-flag <id>` | clear needs-attention |
| `{{wave-cli}} host-pr arm --branch <b> [--remote <url>] [--method <squash\|merge\|rebase>] [--delete-branch]` | `--auto` landing (ADR-0023): `{ ok, verb:"arm", host, branch, method, outcome:"armed"\|"merged"\|"already-merged"\|"refused"\|"no-pr", prNumber?, prUrl?, reason, branchDeletion? }`. Decides per PR: checks pending → enable auto-merge (GraphQL); already clean → direct merge (REST). Idempotent. Detect-host-routed; **no `--config`** (talks to the code host, not the tracker). `arm` threads the same `--delete-branch` flag as `merge` (consumer KW-F6): an immediate `merged` outcome deletes the head branch synchronously and reports it under `branchDeletion:{ branch, deleted, error? }`; a deferred `armed` outcome has no synchronous merge moment to delete from, so the deferral is recorded in `reason` instead and no `branchDeletion` key is present. |
| `{{wave-cli}} host-pr status --branch <b> [--remote <url>]` | done-reconcile host-evidence probe: `{ ok, verb:"status", host, branch, state:"open"\|"merged"\|"closed-unmerged"\|"none", url?, number? }`. `none` is a valid answer (no PR), not a failure. |
| `{{wave-cli}} host-pr merge --branch <b> [--method …] [--delete-branch]` | merge now, no arm intent (caller already decided). Idempotent. Same shape as `arm`, plus — with `--delete-branch` (consumer KW-F6) — it deletes the PR's **remote** head branch through the host API after a successful merge and reports the outcome under `branchDeletion:{ branch, deleted, error? }`. A failed delete is a reported degradation (`deleted:false`), **never** a merge failure (exit stays 0). `arm` threads the identical flag (row above) — its immediate-merge outcome deletes the same way; only its deferred `armed` outcome cannot delete synchronously. |
| `{{wave-cli}} host-pr preflight [--remote <url>]` | code-host posture probe for the `--auto` confirm (ADR-0023 amendment): `{ ok, verb:"preflight", host, checks:[{name,status,detail}] }` for `pr-merge-token` / `allow-auto-merge` / `required-checks`. **Store-blind** — detect-host-routed, **no `--config`**, **no `--branch`** (required checks read against the default branch) — so it answers on **every** store kind, unlike the store-preflight it replaced here. `status` may be `pass`/`fail`/`advisory`/`unknown`; only `fail` blocks. |
| `{{wave-cli}} spine check-disclosures <wave-file>` | the fail-closed archive gate (ADR-0027, phase 6): exits `0` iff no `open` disclosure remains in the spine's `## Disclosures` section, non-zero otherwise. On a non-zero exit, prints one line per still-open entry (`<ref>  row <id>  iter <n>  (<source>)  <text>`) — **read the exit code, not this prose** (the convention-coupled parse-back class, #141/#146). A spine with no `## Disclosures` section at all (predates ADR-0027, or nothing was ever captured) reads as already clear. |
| `{{wave-cli}} spine set-disposition <wave-file> <disclosure-ref> <disposition>` | dispositions exactly one open entry. `<disposition>` must be one of `resolved-in-slice \| scope-extension \| filed:<id> \| dropped:<reason>` — anything else, including `open` (the capture default, not a decision), is refused loud with **nothing written**. |
| any command, no args | usage |

`host-pr create` (find-before-create PR opening, ADR-0023 decision 3) is also a shipped verb, but it is not in this table: it rides the **Worker terminator**, not wave-close — this skill only ever calls the four **landing/probe** verbs above (`arm`/`merge`/`status`/`preflight`).

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `closed-by` | `needsPin: false` | `needsPin: true` | usage |
| `detect-host` | known host | `unknown` host | usage |
| `merge-order` | advisory result on stdout (incl. empty wave) | — | usage / unreadable spine |
| `worktree-cleanup` | clean | per-worktree removal errors | usage |
| `read-closing` | `ClosingState` on stdout | issue not found | usage |
| `verdict-acked` | `{ acked, iter, corrupt }` printed (found or not found — an absent/corrupt verdict is not a failure) | — | usage (missing `<verdictsDir>`/`<id>`) |
| `close` | closing facts recorded (done-reconcile / FOR-13 fallback) | issue not found (store threw) | usage (missing `<id>`/`<prUrl>`) |
| `flag` / `clear-flag` | written | issue not found | usage (bad `--kind`) |
| `spine read` | raw source on stdout | file not found / parse error | usage |
| `host-pr arm` / `merge` | landed (`armed`/`merged`/`already-merged`) — incl. a `--delete-branch` request whose deletion FAILED on either verb (`branchDeletion.deleted:false` is a reported degradation, not a merge/arm failure) | did not land (`no-pr`/`refused`), no adapter (`adapter-not-implemented`), or host error | usage (incl. `--delete-branch` on a verb other than `arm`/`merge`) |
| `host-pr status` | probe answered (read `state`; `none` is a valid answer) | host error | usage |
| `host-pr preflight` | no check `fail`ed (checks may be `advisory`/`unknown`) | a check `fail`ed, no adapter (`adapter-not-implemented`), or host error / missing token | usage |
| `spine check-disclosures` | `0 open of N` — archive gate CLEAR | `≥1 open of N` — archive gate BLOCKED (ADR-0027); an unreadable/corrupt spine blocks the same way (fail-closed) | usage (missing `<wave-file>`) |
| `spine set-disposition` | disposition written, flushed | unknown disclosure-ref, or a disposition outside the vocabulary (including `open`) — nothing written | usage (missing `<disclosure-ref>`/`<disposition>`) |

## Disclosure gate — worked invocation (ADR-0027)

Phase 6 runs this before touching the archive move — the gate reads `check-disclosures`' exit code, never its printed prose:

```bash
{{wave-cli}} spine check-disclosures <wave-file>
# clear:
#   disclosures: 0 open of 3 — archive gate CLEAR
#   exit 0 → continue straight to the archive Guards

# blocked:
#   disclosures: 1 open of 3 — archive gate BLOCKED (ADR-0027)
#     01.1  row 01  iter 1  (worker)  gate 8 ships inert
#     disposition each: spine set-disposition <wave-file> <ref> <resolved-in-slice|scope-extension|filed:<id>|dropped:<reason>>
#   exit 1 → do NOT archive

# disposition the entry the gate named — the vocabulary is exactly four
# tokens, `open` itself is refused (it's the capture default, not a decision):
{{wave-cli}} spine set-disposition <wave-file> 01.1 "filed:#210"

# re-run — the very same check now flips green:
{{wave-cli}} spine check-disclosures <wave-file>
# → disclosures: 0 open of 3 — archive gate CLEAR
# exit 0 → now archive
```

`dropped:<reason>` clears the gate exactly the same way `resolved-in-slice` does — the check counts dispositioned-vs-open, it does not read or judge which disposition was chosen.

## `ClosingState` shape

`read-closing` prints `{ "state": "open" | "merged" | "closed-unmerged" | "closed-unknown", "prUrl"?: string }` — the four outcomes are **evidence claims, not verdicts** (ADR-0020), matching the landed engine:

- `open` — PR is open; no action needed (human merges in advisory order). Exception: a no-integration `states.doneState` workspace never reports `merged` — consult `host-pr status --branch <b>` (the evidence hierarchy, ADR-0023); on its `state: merged`, land it with `close` (FOR-13 fallback), `--acked` derived the same way as below.
- `merged` — PR merged; **derive `--acked` via `verdict-acked <verdictsDir> <id>` (FOR-17), then land it `done` via `issue-store close <id> <prUrl> --acked <indexes>`** (the done-reconcile). On a native-integration tracker the row's `done` also derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), so `close` is an idempotent reconcile that records the closing facts + the cosmetic AC tick; then clear any stale flag.
- `closed-unmerged` — a closing PR was **found and it did not merge** (a proven rejection); flag `recoverable-stop`.
- `closed-unknown` — closed with **no PR evidence either way** (a hand-close, a duplicate, or the Convention-4 mention-footgun closing the row via a stray bare-id sighting). This is *absence of evidence*, **not** evidence of rejection (never flag on it alone — that false alarm is exactly why this fourth outcome exists). Read it via the same **evidence hierarchy — tracker attachment > host PR state > nothing**: fall to `host-pr status --branch <b>`. Its `state: merged` → the PR did land, the tracker just never attached it → derive `--acked` (above), then the same `close` call (FOR-13 fallback). Its `state: closed-unmerged` → the host proves a real rejection → flag `recoverable-stop`. Its `state: open`/`none` → still no merge evidence anywhere → report `closed-unknown — closed, but no merged-PR evidence found; confirm before landing`, naming the id, and leave it for the human. **Never guess** between merged and rejected.

## `NeedsAttentionPayload` shape

`flag` writes `{ kind: 'recoverable-stop' | 'terminal-failure', question: string, options: string[] }` (ADR-0006). The flag is **orthogonal to the coarse rung** — the row keeps its rung (typically `in-review`); `read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged. On GitHub: `wave/needs-attention` label + structured comment carrying the payload. On MarkdownFs: `**Needs-Attention:**` header line + payload block.

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `available` (eligible + unclaimed) and `done` are the derived bookends. On a native-integration tracker `done` derives from the merged PR's store-kind close phrase (`wave-shared` Convention 4), and the wave-close done-reconcile (`issue-store close`) is an idempotent reconcile that records the closing facts. On a **no-integration `states.doneState` workspace (FOR-13)** the tracker can never see the merge, so the done-reconcile follows the ADR-0023 evidence hierarchy — **tracker attachment (`read-closing`) > host PR state (`host-pr status`) > nothing** — and that same `close` verb forces the mapped done-state transition + a loud advisory the moment the host supplies the merge evidence, the operational trigger for `done` when the tracker cannot reach it. Every `close` call on a merged row also carries `--acked`, derived per-row from that row's FINAL Reviewer verdict via `verdict-acked` (FOR-17, ADR-0004) — a cosmetic, human-facing tick only, never re-read as gate input. wave-close recomputes the advisory merge order (printed, not persisted), lands each merged row `done` (with its reviewer-met ACs ticked), flags stuck rows, cleans worktrees, and archives the spine; opt-in `--auto` additionally partial-arms the order-free rows through `host-pr arm` and exits (arm-and-exit) — it **never merges `main`**. Reaching `done` for a row whose PR merged is this done-reconcile, the resume done-reconcile (`wave-resume`), or the human's merge action.
