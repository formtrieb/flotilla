# wave-shared — routing mechanics

The engine-CLI plumbing the execution skills share. The SKILL.md body owns the **conventions** (auth-preflight, the routing chain, atomic spine writes); this file owns the **exact verb invocation** and exit codes. Every value is typed — routing never re-parses prose.

> **The CLI is the source of truth for shapes.** Each command prints usage on no args and validates input on every call. The examples below scaffold you; if one disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived at the keyboard. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running a verb. **Attach that one string to a shell *function*, never to a variable — the attachment itself is written out immediately below, not left to the reader** (rationale: [convention-12-no-command-in-a-shell-variable.md](./convention-12-no-command-in-a-shell-variable.md)). Tracker-touching verbs need the store config: run from a dir containing `wave.config.json`, or append `--config <path>` **after** the subcommand and its op. The pure routing/validation verbs (`route-verdict`, `route-outcome`, `validate-report`, `validate-verdict`) are store-independent — they take no `--config`.

### Binding the form — a shell function, never a variable

Reading the configured value is only half an instruction. The other half is **how it gets attached**, and a resolution section that stops at "here is the command string" leaves a gap the reader fills with the reflex that silently does nothing: `CLI="<the configured engine.cli value>"; $CLI route-verdict …` exits **127** under zsh (which does not field-split an unquoted expansion) and runs *nothing at all* — not an error the command produced, because the command was never reached. So bind it, once per session, before the first verb — the function body is the `engine.cli` string verbatim, copied out of the config rather than typed from memory:

```bash
# The shape: wave_cli() { NODE_USE_ENV_PROXY=1 <engine.cli, verbatim> "$@"; }
# This repo's own binding is the vendored one, shown because it is what a
# dogfooding session in THIS checkout reads out of its own config:
wave_cli() { NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts "$@"; }

# --state is verdict-keyed, not iteration-keyed (wave-start/reference/start-mechanics.md "Verified routing outputs") — reviewing is correct for this approve/iteration-1 cell, not a fixed value for every call. `route-tuple` derives it for you; this single verb does not.
wave_cli route-verdict --verdict approve --iteration 1 --risk mechanical --state reviewing
```

`"$@"` is the one expansion that preserves argument boundaries in **every** shell, which is exactly why a function survives where a variable does not. Read every `{{wave-cli}}` in the tables below as that function — and read a **list** the same way: iterate a real array (`for x in "${IDS[@]}"`), never a bare `$LIST` in a `for` head.

**Bind it in the same Bash call that runs the verb.** `wave_cli()` is a shell function, and a shell function is session state: it exists only in the call that defines it. Shell state does not survive from one Bash call to the next, so "define it once per session, before the first verb" is an instruction with no session to hold it — define and call together, or invoke the configured `engine.cli` string directly.

The convention's second half governs what you do with a verb's **output**, and it is the same constraint seen from the other side: a value you capture and then *use* — a PR URL, an id, a SHA — must be refused when it comes back empty, because an empty capture is indistinguishable from a 127 that never ran, **and the refusal only counts if it runs in the same Bash call as the capture**. So: verify in the call that produced the value, or do not capture it at all and re-query its source in the call that needs it — `{{wave-cli}} host-pr status --branch <branch>` re-reads a PR URL from the host, `issue-store read-closing` re-reads a ticket. The two forms, the retired `require_capture` helper and the live call sites are in [convention-12-no-command-in-a-shell-variable.md](./convention-12-no-command-in-a-shell-variable.md).

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

## Routing a whole tuple — one verb

| Call | Prints |
|---|---|
| `{{wave-cli}} route-tuple --spine <spine> --id <id> --iter <n> --report <path> --verdict <path> --anchor <sha> --config <cfg> [--title <text>] [--ruling <text>]` | ONE JSON result: `{ ok, verb, id, iter, disposition, steps[], wrote{…}, … }` — plus a `ruled` object on an Operator-ruled round |

This is the whole post-return sequence for one row, in the write-ahead order, in one process: the sidecar presence-and-validation check (recovering a missing or corrupt record from the passed `--report`/`--verdict` payload through the same writer the Scribe stages use, and refusing rather than guessing when it cannot), the worker-phase route, the verdict-phase route, the verdict render, find-before-create of the PR, the host status re-query, the two spine writes, and the `in-review` rung transition. Both `--state` derivations are the verb's — iteration-keyed for the worker phase, **verdict**-keyed for the reviewer phase — and `riskClass` comes off the typed verdict, so neither is a flag anyone can garble.

Read `disposition`:

| `disposition` | What happened | What is still yours |
|---|---|---|
| `pr-created` | PR open (body: summary → rendered verdict → close phrase), spine row `pr-created` with its PR cell filled, rung `in-review`. `prUrl` is what the HOST answered on the re-query. | nothing |
| `re-dispatched` | The spine row state and the iteration bump were written. Host and tracker untouched. | the worktree teardown and the re-compose, in the order `next` names |
| `stop` | The row halts; `stop.reason` + `stop.severity` say why. **No spine, host or tracker write happened.** | the `needs-attention` flag (below) |

Every entry in `steps[]` carries `performed` or `performed-before`, so a re-run after an interruption is safe and says what it found already done — the open PR is reused rather than duplicated, no second verdict section is stacked into its body, and a rung already at `in-review` is left alone.

**Two things the verb deliberately does not do.** It never captures a disclosure — that is judgment, and the Coordinator's own observation is a source no payload carries, so `spine add-disclosure` stays a separate call made *before* this one. And it never flags and never dispatches: a `stop` is reported, not acted on.

Exit codes: `0` — the sequence completed (a `stop` is a routed outcome, not a failure); `1` — a refusal that wrote nothing past the step it names (an unrecoverable sidecar, a routing `noop` — a caller bug — a failed create, a refused reuse, a status re-query that found no PR); `2` — usage, an unreadable config, or an unreadable spine.

## The single-verb pages (the building blocks a resume path reaches for one at a time)

`route-tuple` composes these; they are unchanged, and they remain the right call when the question is about ONE step rather than a whole tuple — which is exactly the shape `wave-resume` works in, row by row, after a reconstruction.

| Call | Prints | Wraps |
|---|---|---|
| `{{wave-cli}} route-outcome --outcome <workerOutcome> --state <issueState>` | JSON `{ event, outcome }` | `outcomeToEvent` → `transition` |
| `{{wave-cli}} route-verdict --verdict <approve\|changes-requested\|questions-blocking> --iteration <n> --risk <riskValue> --state <issueState> [--ruling <text>]` | JSON `{ event, outcome }`, plus `ruled` on an above-cap ruled round | `verdictToRouting` → `transition` |
| `{{wave-cli}} render-verdict <verdictsDir> <id> --anchor <sha>` | the `## Reviewer verdict` markdown section (text) | the MAX-iter valid verdict sidecar → `renderVerdictSection` |
| `{{wave-cli}} host-pr create --branch <b> --title <t> --body <body>` | JSON `{ ok, outcome, url, … }` | find-before-create, then update-or-create |
| `{{wave-cli}} host-pr status --branch <b>` | JSON `{ state, url?, … }` | the host's own answer for that branch |

`<workerOutcome>` ∈ `done | done-with-concerns | needs-context | blocked`. `<riskValue>` ∈ `mechanical | isolated-refactor | cross-feature-refactor | public-API-change`. `<issueState>` is the issue's current fine state. The router derives the `event` deterministically and computes the resulting `outcome` (the target rung) — you never hand-pick the event.

## The Operator-ruled round — the one cell above the re-dispatch cap

A second `changes-requested` exhausts the cap and stops the row. The documented recovery is an **Operator ruling**: fix the world, then re-dispatch the **Reviewer only**, outside the cap, with the row's iteration bumped so the sidecars land at the third iteration. `--ruling "<the Operator's own reason>"` is what admits that round, on `route-verdict` and on `route-tuple` alike — it is the only thing that opens an iteration above the cap, and it is a **stated reason, never a switch**: a blank, a bare token (`true`, `yes`, `ok`) or anything under three words is refused, so a ruled round cannot exist without saying why it exists.

| `--verdict` | `--risk` | `--state` (derived by `route-tuple`; pass it yourself to the single verb) | `event` | `ruled.cell` | `outcome` |
|---|---|---|---|---|---|
| `approve` | not `public-API-change` | `reviewing` | `reviewer-approve` | `reviewer-approve-ruled` | `transition → approved` |
| `approve` | `public-API-change` | `reviewing` | `reviewer-approve-public-api` | `reviewer-approve-public-api-ruled` | `stop public-api-approval-required` |
| `changes-requested` | any | `re-dispatched` | `reviewer-changes-requested-2nd` | `reviewer-changes-requested-ruled` | `stop re-dispatch-cap-exhausted` |
| `questions-blocking` | any | `reviewing` | `reviewer-questions-blocking` | `reviewer-questions-blocking-ruled` | `stop reviewer-questions-blocking` |

Three properties of that table are the point, and each is pinned by a spec:

- **The cap is untouched.** A ruled `approve` reaches the state an ordinary `approve` reaches, and nothing else. A ruled `changes-requested` lands on the cap-exhaustion STOP — it neither spends a budget that is already spent nor hands the row a fresh one. A further ruled round takes a further ruling; nothing here grants one.
- **The refusal survives.** Drop `--ruling` and an above-cap iteration is refused with the message it has always printed: `iteration 3 is out of range. Expected an integer in [1, 2] (re-dispatch cap = 1).` The flag widens the range for *this* round and for nobody else.
- **The reason is in the output.** `ruled` carries `{ cell, ruling }` — on `route-verdict`'s printed JSON, and on `route-tuple`'s both in the `route-verdict` step and at the top level. Quote it from there in the closing report rather than reconstructing it from memory.

```bash
wave_cli route-verdict --verdict approve --iteration 3 --risk mechanical --state reviewing \
  --ruling "Operator ruling 03:50 — the throwaway repository was deleted; re-dispatch the Reviewer only."
```

## Apply + flag

`route-tuple` performs the first row of this table itself, as its last step. The rest stay hand-called, and `flag` is deliberately one of them: a `stop` is reported by the routing verb and acted on here, by a Coordinator that has decided what to ask the Operator.

| Call | Purpose |
|---|---|
| `{{wave-cli}} issue-store transition <id> <rung>` | apply the routed transition (set the claim rung) |
| `{{wave-cli}} issue-store flag <id> --kind <recoverable-stop\|terminal-failure> --question "<q>" --option "<o>" [--option "<o>" ...]` | set needs-attention (orthogonal to the rung) with a `NeedsAttentionPayload` |
| `{{wave-cli}} issue-store clear-flag <id>` | clear needs-attention |
| `{{wave-cli}} issue-store read-closing <id>` | print `ClosingState` JSON (`{ state: 'open'\|'merged'\|'closed-unmerged', prUrl? }`) — the closing-PR probe `wave-close` uses to confirm a merge |
| `{{wave-cli}} issue-store amend <id> --patch <AmendPatch.json>` | amend authored content — `{ title?, sections? }`, upsert-by-heading prose (ADR-0025); the sanctioned Worker-discloses/Coordinator-amends path (Convention 5). Cannot touch Files/AC/Blocked by (that is `annotate`) |

### Verify the write

`transition`, `flag`, and `clear-flag` all answer success with **empty stdout** — three of the nine mutating `issue-store` ops that are silent by design (#648): the exit code is the whole signal at the call site, and on its own it says only "the write did not throw," never "the rung/flag now reads the way you meant it to." Read the coarse projection back before trusting any of the three landed:

```bash
{{wave-cli}} issue-store read <id>
```

- After `transition` — `IssueView.status` reflects the rung you just set (`in-flight`, `in-review`, …).
- After `flag` — `status` reads `needs-attention`: the Disclaimer below already says why it shows here even though the underlying rung is unchanged (needs-attention takes precedence in the coarse projection).
- After `clear-flag` — `status` has dropped back to the underlying rung; `needs-attention` no longer appears.

Never pipe any of these three calls through another command before reading its exit code — a pipeline reports only the *last* command's status, so `{{wave-cli}} issue-store flag "$ID" … | tee log` would hide a non-zero `flag` behind a zero `tee`.

## Exit codes

### `route-tuple`

| Code | Meaning |
|---|---|
| `0` | the sequence completed — read `disposition` (`pr-created` \| `re-dispatched` \| `stop`). A `stop` is a ROUTED outcome, not a failure of this verb |
| `1` | a refusal, having written nothing past the step it names: an unrecoverable sidecar, a routing `noop` (a caller bug), a failed create, a refused reuse, a status re-query that found no PR, or a spine/tracker write that threw |
| `2` | usage error, an unreadable/invalid `--config`, or an unreadable `--spine` |

### `route-verdict` / `route-outcome`

| Code | Meaning |
|---|---|
| `0` | success (`{ event, outcome }` on stdout, plus `ruled` on an Operator-ruled round) |
| `1` | domain failure (un-mappable verdict/outcome, invalid transition for the given state, an above-cap iteration with no ruling, or a ruling that states no reason) |
| `2` | usage error (missing/unknown flag, or `--ruling` passed with no value) |

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
