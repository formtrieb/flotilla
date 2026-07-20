# wave-shared — routing mechanics

The engine-CLI plumbing the execution skills share. The SKILL.md body owns the **conventions** (auth-preflight, the routing chain, atomic spine writes); this file owns the **exact verb invocation** and exit codes. Every value is typed — routing never re-parses prose.

> **The CLI is the source of truth for shapes.** Each command prints usage on no args and validates input on every call. The examples below scaffold you; if one disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution

The wave engine CLI. In-repo that is `npx tsx tools/wave/src/cli.ts`. Tracker-touching verbs need the store config: run from a dir containing `wave.config.json`, or append `--config <path>` **after** the subcommand and its op. The pure routing/validation verbs (`route-verdict`, `route-outcome`, `validate-report`, `validate-verdict`) are store-independent — they take no `--config`.

## Auth preflight

| Call | Purpose |
|---|---|
| `{{wave-cli}} detect-host <remote-url>` | resolve the configured store + host (e.g. `github`); the entry point for the auth check |

Run once at the top of an execution skill, before any claim. The engine owns the host seam — never run raw `gh`.

## Validation (agent-boundary, mirror of the inlined literals)

| Call | Behavior |
|---|---|
| `{{wave-cli}} validate-report <file>` | exit `0` + `valid` if the file is a well-formed `WorkerReport`; exit `1` + errors otherwise (wraps `validateWorkerReport`) |
| `{{wave-cli}} validate-verdict <file>` | exit `0` + `valid` if the file is a well-formed `ReviewerVerdict`; exit `1` + errors otherwise (wraps `validateReviewerVerdict`) |

These validate a structured return on disk against the same constraints the inlined `agent({ schema })` literals enforce. Use them to re-check a subagent return the driver captured to a file.

## Sidecar writes (verb-written at agent-return, Convention 5 / ADR-0024)

| Call | Behavior |
|---|---|
| `{{wave-cli}} write-report <json-file> --dir <reportsDir> --id <id> --iter <n>` | validate-then-write: renders `<reportsDir>/<id>-<iter>.md` (fenced `WorkerReport`) the `sidecar.ts` reader accepts; refuses an invalid payload or a `report.issue`↔`--id` mismatch (exit 1, nothing written); `mkdir -p`; last-writer-wins; prints the absolute written path on exit 0 |
| `{{wave-cli}} write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>` | same, for a `ReviewerVerdict` (no issue cross-check); renders `<verdictsDir>/<id>-<iter>.md` |

The filename is **engine-computed** — the caller passes `--id` + `--iter`, never a path with a name. These are the printers paired with the reader (`renderSpine`↔`readSpine` symmetry): a Scribe (or the inline Coordinator) runs them the moment an agent returns, so a durable record exists before any routing. Never hand-format a sidecar; never bundle the writes after routing.

## Routing (typed field → event → outcome)

| Call | Prints | Wraps |
|---|---|---|
| `{{wave-cli}} route-outcome --outcome <workerOutcome> --state <issueState>` | JSON `{ event, outcome }` | `outcomeToEvent` → `transition` |
| `{{wave-cli}} route-verdict --verdict <approve\|changes-requested\|questions-blocking> --iteration <1\|2> --risk <riskValue> --state <issueState>` | JSON `{ event, outcome }` | `verdictToEvent` → `transition` |

`<workerOutcome>` ∈ `done | done-with-concerns | needs-context | blocked`. `<riskValue>` ∈ `mechanical | isolated-refactor | cross-feature-refactor | public-API-change`. `<issueState>` is the issue's current fine state. The router derives the `event` deterministically and computes the resulting `outcome` (the target rung) — you never hand-pick the event.

## Apply + flag

| Call | Purpose |
|---|---|
| `{{wave-cli}} issue-store transition <id> <rung>` | apply the routed transition (set the claim rung) |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>" ...]` | set needs-attention (orthogonal to the rung) with a `NeedsAttentionPayload` |
| `{{wave-cli}} issue-store clear-flag <id>` | clear needs-attention |
| `{{wave-cli}} issue-store read-closing <id>` | print `ClosingState` JSON (`{ state: 'open'\|'merged'\|'closed-unmerged', prUrl? }`) — the closing-PR probe `wave-close` uses to confirm a merge |
| `{{wave-cli}} issue-store amend <id> --patch <AmendPatch.json>` | amend authored content — `{ title?, sections? }`, upsert-by-heading prose (ADR-0025); the sanctioned Worker-discloses/Coordinator-amends path (Convention 5). Cannot touch Files/AC/Blocked by (that is `annotate`) |

## Exit codes

### `route-verdict` / `route-outcome`

| Code | Meaning |
|---|---|
| `0` | success (`{ event, outcome }` on stdout) |
| `1` | domain failure (un-mappable verdict/outcome, or invalid transition for the given state) |
| `2` | usage error (missing/unknown flag) |

### `validate-report` / `validate-verdict`

| Code | Meaning |
|---|---|
| `0` | valid (`valid` on stdout) |
| `1` | invalid (errors on stdout/stderr) |
| `2` | usage error (missing `<file>` or unreadable) |

### `write-report` / `write-verdict`

| Code | Meaning |
|---|---|
| `0` | written (absolute path of `<id>-<iter>.md` on stdout) |
| `1` | invalid payload, or `report.issue`↔`--id` mismatch — **nothing written** |
| `2` | usage error (missing `<json-file>`/`--dir`/`--id`/`--iter`, non-integer `--iter`, or unreadable/unparseable `<json-file>`) |

### `issue-store flag` / `clear-flag` / `transition`

| Code | Meaning |
|---|---|
| `0` | written |
| `1` | issue not found, or (for `transition`) invalid transition |
| `2` | usage error |

### `issue-store read-closing`

| Code | Meaning |
|---|---|
| `0` | success (`ClosingState` JSON on stdout) |
| `1` | issue not found |
| `2` | usage error |

### `issue-store amend`

| Code | Meaning |
|---|---|
| `0` | amended |
| `1` | issue not found, or invalid patch (a reserved-heading section — Files/Blocked by/Unblocks/Acceptance criteria — which belongs to `annotate`) |
| `2` | usage error (missing `<id>`/`--patch`, an unreadable/unparseable patch file, or an **empty** patch — a change-nothing amend is a caller bug) |

## Disclaimer

flotilla writes only the `queued → in-flight → in-review` ledger; `available` and `done` are derived bookends. needs-attention is an **orthogonal flag** (ADR-0006), not a rung value — `read().status` already gives it precedence; `flag`/`clear-flag` are the write side. The Reviewer is **uniform** — there is no Risk→brief-profile map (ADR-0016), which is why the verdict schema carries no `briefProfile`.
