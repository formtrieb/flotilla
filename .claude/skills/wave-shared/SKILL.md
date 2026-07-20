---
name: wave-shared
description: Library skill the wave execution skills (wave-start, wave-reviewer, wave-close) load for the canonical agent-boundary JSON schemas and the shared auth-preflight, deterministic-routing, and atomic-spine-write conventions. Invoked by name by its siblings — never model-invoked.
disable-model-invocation: true
---

# wave-shared

The shared substrate the **execution** skills (`wave-start`, `wave-reviewer`, `wave-close`) load by name. It carries no judgment and is **never model-invoked** (`disable-model-invocation: true`) — siblings reach for it explicitly. It owns the three things those skills must agree on byte-for-byte:

1. **The canonical agent-boundary JSON schemas** — `WORKER_REPORT_SCHEMA` and `REVIEWER_VERDICT_SCHEMA`, inlined verbatim below. A skill cannot `import` a TS const, so the Workflow driver pastes these literals into `agent({ schema })`. They are **copies** of `tools/wave/src/worker-report-schema.ts` / `reviewer-verdict-schema.ts` and the drift-guard spec (`tools/wave/src/skill-schema-drift.spec.ts`) deep-equals them to the exported consts on every run — if you edit a literal here, the spec fails until the source const matches.
2. **The auth-preflight convention** — `detect-host` → verify, before any tracker write.
3. **The deterministic routing chain** — `route-verdict` / `route-outcome` → `issue-store transition` → spine write, with one **atomic spine write per state flip**.

The CLI invocation detail (exact flags, exit codes, the `{{wave-cli}}` resolution) lives in [reference/routing-mechanics.md](reference/routing-mechanics.md).

## THE SCHEMAS ARE COPIES — do not hand-edit to "fix" a shape

The two literals below are the **agent-boundary contract**: the Workflow tool validates each subagent's structured return against them *before* the driver ever sees it (this is what kills the prose-fabrication class — no number is re-typed from free text; routing reads a typed field). `additionalProperties: false` keeps a subagent from smuggling un-modelled fields the router would ignore.

They are hand-compacted copies of the engine consts. **The source of truth is the TS const**, not this file. To change a schema: edit `tools/wave/src/*.ts`, run the drift-guard, then update the literal here to match. Never edit the literal alone.

### Worker-Report schema

```js
// --- inlined from worker-report-schema.ts (WORKER_REPORT_JSON_SCHEMA) ---
const WORKER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'issue',
    'branch',
    'commitShas',
    'filesChanged',
    'tests',
    'lint',
    'judgmentCalls',
    'reviewerFocusItems',
  ],
  properties: {
    outcome: { type: 'string', enum: ['done', 'done-with-concerns', 'needs-context', 'blocked'] },
    issue: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    worktree: { type: 'string' },
    commitShas: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    prUrl: { type: 'string', minLength: 1 },
    filesChanged: {
      type: 'object',
      additionalProperties: false,
      required: ['new', 'modified', 'renamed'],
      properties: {
        new: { type: 'integer', minimum: 0 },
        modified: { type: 'integer', minimum: 0 },
        renamed: { type: 'integer', minimum: 0 },
      },
    },
    tests: { type: 'string', minLength: 1 },
    regressionSweep: { type: 'string' },
    lint: { type: 'string', minLength: 1 },
    conflictMarkers: { type: 'string' },
    judgmentCalls: { type: 'array', items: { type: 'string' } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
  },
  anyOf: [
    {
      properties: { outcome: { enum: ['done', 'done-with-concerns'] } },
      required: ['prUrl'],
    },
    {
      properties: { outcome: { enum: ['needs-context', 'blocked'] } },
    },
  ],
};
// --- end ---
```

The `outcome` field is the routing discriminator: `done` / `done-with-concerns` → proceed to Reviewer dispatch; `needs-context` → auto re-dispatch with context; `blocked` → STOP and flag. The driver never re-reads it from prose — it passes the typed `outcome` to `route-outcome` (see the routing chain below).

**A finishing report must carry the PR URL** — that is what the `anyOf` block encodes: `outcome: done` / `done-with-concerns` ⇒ `prUrl` is **required**; `needs-context` / `blocked` ⇒ it may be omitted (there may be no PR). Brief every Worker accordingly. Two consumers read that field as fact, and both fail silently when it is absent:

- the **Reviewer** verifies the PR body — including the store-kind close phrase (Convention 4), the one thing that decides whether the row can ever reach `done` on a `linear` store. With no `prUrl` it reports "PR is not yet opened" and skips a check it was briefed to run;
- the **Coordinator's terminator** reads an absent `prUrl` as "no PR exists" and opens one — a duplicate PR against a branch that already has one.

`prUrl` is optional *in shape* only so an honest `blocked` report isn't rejected; it is not optional on the path where the Worker finished. If a Worker's return is rejected at the boundary for a missing `prUrl`, the fix is the Worker reporting the URL it already has — never relaxing the schema.

#### This literal's top-level `anyOf` is NOT boundary-portable — do not paste it into `agent({ schema })`

The `WORKER_REPORT_SCHEMA` literal above is the **canonical** copy — deep-equal-pinned to the engine const — but its top-level `anyOf` is not something the agent-tool boundary accepts. The agent tool's `input_schema` validation **rejects a top-level `anyOf`/`oneOf`/`allOf` outright**: `input_schema does not support oneOf, allOf, or anyOf at the top level`. Pasting this literal verbatim into `agent({ schema })` fails every Worker dispatch instantly, before a single agent runs (live: **W5-F1**, `docs/retros/2026-07-19-hardening-w5.md` — the first Workflow dispatch of that wave failed this way, 0 tokens, all 4 Workers, 4.8s).

**The form to paste into `agent({ schema })` is the anyOf-free driver copy in `.claude/skills/wave-start/reference/workflow-driver.md`** (also named `WORKER_REPORT_SCHEMA` there) — identical to the literal above minus the `anyOf` block. On that driver copy, the `prUrl`-on-`done`/`done-with-concerns` invariant is **brief-enforced, not schema-enforced**: `workerBrief()`'s Termination + Report sections state the requirement in prose, and there is no structural rejection at the `agent({ schema })` boundary for a `done` report that omits `prUrl` on that path. `tools/wave/src/skill-schema-drift.spec.ts` separately asserts the driver copy stays free of any top-level combinator, so the W5-F1 regression cannot silently return.

### Reviewer-Verdict schema

```js
// --- inlined from reviewer-verdict-schema.ts (REVIEWER_VERDICT_JSON_SCHEMA) ---
const REVIEWER_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'branchReviewed',
    'riskClass',
    'workerReportDigest',
    'acVerification',
    'reviewerFocusItems',
  ],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes-requested', 'questions-blocking'] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: ['mechanical', 'isolated-refactor', 'cross-feature-refactor', 'public-API-change'] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ac', 'met', 'evidence'],
        properties: {
          ac: { type: 'string', minLength: 1 },
          met: { type: 'string', enum: ['met', 'partial', 'not-met', 'deferred'] },
          evidence: { type: 'string' },
        },
      },
    },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' },
    gitStateSane: { type: 'boolean' },
  },
};
// --- end ---
```

`riskClass` is **required and load-bearing** (the G3 guard): `route-verdict` bifurcates on it — a `public-API-change` `approve` never silently fast-paths past the human STOP. There is **no `briefProfile`** — flotilla's Reviewer is uniform (no Risk→profile map, ADR-0016); the field was removed engine-side and must not reappear here, or `additionalProperties: false` would reject every real verdict.

## Convention 1 — auth-preflight (detect-host → verify)

Before **any** tracker write in an execution skill, confirm the host is reachable and authenticated. flotilla never shells a tracker CLI directly — it goes through the engine's host seam.

1. `detect-host` — resolves the configured store and its host (e.g. `github`).
2. Verify auth for that host through the engine (the engine owns the `GitHubApi` seam; the skill never runs raw `gh`). A failed preflight aborts the dispatch **before** any claim or spine flip — you never want a half-authenticated run that claims an issue it cannot later transition.

This is a precondition, not a routing step: run it once at the top of `wave-start` / `wave-reviewer` / `wave-close`, surface a clear abort on failure.

> **Raw-fetch adapters vs. a sandboxed harness (proxy requirement).** The real `GitHubApi`/`LinearApi` impls talk over raw `fetch` (ADR-0019/0020) — no `gh`/`git` subprocess. The `host-pr` landing verbs (ADR-0023) are raw-fetch too. Under a sandboxed harness that forces outbound HTTP through a proxy, Node's global `fetch` ignores the proxy env by default and the call fails with `EPERM`/`ECONNREFUSED` (a false "unreachable host / unauthenticated" surface). On **Node ≥ 24**, prefix every engine CLI call that hits the network — the auth-preflight, `issue-store *`, `read-closing`, the store-preflight, and `host-pr arm|merge|status` — with **`NODE_USE_ENV_PROXY=1`** so raw `fetch` honours `HTTP(S)_PROXY`:
>
> ```bash
> NODE_USE_ENV_PROXY=1 npx tsx tools/wave/src/cli.ts detect-host <remote-url> --config <path>
> ```
>
> A local-git-only command (`git worktree`, `git push`) does not need this — it is a raw-`fetch`-only concern. If auth-preflight fails inside a proxied sandbox, check this flag before concluding the token is bad.

## Convention 2 — the deterministic routing chain

Routing is **never** hand-synthesised from prose. The chain is, in order:

```
typed return  →  route-{verdict,outcome}  →  issue-store transition  →  spine write
```

- **Worker phase.** The Worker returns a `WorkerReport` (validated against `WORKER_REPORT_SCHEMA` at the agent boundary). Feed its typed `outcome` + the issue's current state to `route-outcome --outcome <o> --state <s>`. It prints `{ event, outcome }` — the `event` is the `WaveEvent` the engine derived; the `outcome` is the resulting fine state. The transition is then applied via `issue-store transition`.
- **Reviewer phase.** The Reviewer returns a `ReviewerVerdict` (validated against `REVIEWER_VERDICT_SCHEMA`). Feed its typed `verdict` + `riskClass` + the iteration + the issue's state to `route-verdict --verdict <v> --iteration <1|2> --risk <riskValue> --state <s>`. It bifurcates on `riskClass` (the G3 guard) and prints `{ event, outcome }`.
- **Apply.** Take the `outcome`/`event` from the router and call `issue-store transition <id> <target-rung>` — the router decided, the transition executes. A `questions-blocking` verdict or a `blocked` worker outcome routes to **needs-attention** via `issue-store flag` (see below), not a rung transition.

The router CLIs are pure wrappers over the engine's `verdictToEvent` / `outcomeToEvent` adapters — they cannot invent an event. If you ever find yourself reading a number or a verdict word out of the subagent's prose to decide a transition, stop: that is the fabrication class this whole chain exists to kill. Use the typed field.

### needs-attention is orthogonal to the rung

When the chain routes to a STOP (`questions-blocking`, `blocked`, or any recoverable/terminal stall), set the **needs-attention flag** — it is orthogonal to the claim rung (ADR-0006), not a rung value:

```
issue-store flag <id> --kind <recoverable-stop|terminal-failure> --question "<q>" --option "<o>" [--option "<o>" ...]
```

`clear-flag <id>` removes it once resolved. The flag carries a `NeedsAttentionPayload` (`{ kind, question, options }`) so the human sees the exact decision to make. On GitHub this is the `wave/needs-attention` label + a structured comment; the rung label (`wave/<rung>`) is untouched.

## Convention 3 — one atomic spine write per state flip

The spine (`.flotilla/waves/<slug>.md`) is the resume-authoritative ledger (ADR-0002 WAL). Every state flip is **one atomic spine write** — read the spine, apply exactly one row's change, flush. Never batch two flips into one read-modify-write; never leave the spine mid-edit. The discipline:

- One flip = one `readSpine` → mutate one row → flush. If the process dies, resume reads a spine that is either fully pre-flip or fully post-flip — never a torn half.
- The tracker transition (`issue-store transition`) and the spine write are paired, but the **spine is authority**: on GitHub the rung is *derived*, so a crash after the spine flush is recoverable (resume re-asserts the claim); a crash after a tracker write but before the spine flush is the dangerous inversion — always flush the spine to reflect the new state as the durable record.
- Sidecar reports/verdicts live under `.flotilla/waves/<slug>/reports/` and `.flotilla/waves/<slug>/verdicts/` (relative to the spine's own directory) — write the artefact, then the spine row that references it, as separate atomic steps.

## Convention 4 — the store-kind close phrase (PR body)

The magic word a merged PR's body must carry to close/link the issue is **derived from the configured store kind** (`wave.config.json`'s `store.kind`), not hardcoded — a PR is always a GitHub artifact in both known consumers, but the phrase the *tracker* recognizes differs (ADR-0020):

| `store.kind` | Close phrase | Example |
|---|---|---|
| `github` | `Closes #<issue-number>` | `Closes #42` |
| `linear` | `Fixes <TEAM-NN>` | `Fixes EX-16` |

Read `store.kind` off the consumer's `wave.config.json` (the same file `{{wave-cli}}` resolves via `--config`) and compose the PR body with the matching phrase whenever a terminator opens a PR (`wave-start`'s `approved → pr-created` step). For a `linear` store this phrase is also what creates the merged-PR attachment `issue-store read-closing` reads (the Linear closing probe, ADR-0020) — get the phrase wrong and the row never resolves past `in-review`/`pr-created` even though the code merged.

`linear`'s Linear-GitHub-integration precondition (installed + connected to the code repo) must already hold for this to work at all — `wave-setup`'s Linear operational-preconditions checklist confirms it before the store is ever configured.

**Opening the PR goes through the engine — `{{wave-cli}} host-pr create`, never `gh pr create`.** The PR-open is the ADR-0023 last mile: every host write goes through the engine host seam, and `create` is that verb (`gh`'s creds are sandbox-denied and its TLS fought the proxy MITM cert in every live run — creation only ever worked sandbox-off). It is **find-before-create idempotent**: an OPEN PR already on the branch is reused (`outcome: reused`), a missing one is created (`outcome: created`) — so a cap=1 re-dispatch onto the same branch never opens a duplicate. The `--body` you pass carries the store-kind close phrase above, verbatim, and per the mention-footgun below it is the **only** tracker id the title or body may contain:

```bash
{{wave-cli}} host-pr create --branch <branch> --title "<title, no bare tracker id>" \
  --body "<summary>

<the store-kind close phrase, on its own line — e.g. Fixes EX-16>"
# exit 0 → stdout JSON carries .url (outcome: created | reused) — pin that as the row's PR URL.
# create reads GITHUB_TOKEN from the environment (never printed); github-only in M1,
# bitbucket/unknown fail loud + typed like the landing verbs.
```

### The flip side — a bare mention is also an action

Convention 4 governs the phrase that closes an issue **on purpose**. Nothing governed the flip side until now: on a tracker with a native GitHub integration, the integration does not distinguish "the phrase that means close this" from "any other sighting of this issue's id" — it links **every** bare issue id it finds in a merged PR's title or body, and a linked issue is an issue the integration can act on. **An issue id belongs in a PR title or body only when closing that issue at merge is intended.** Do not name a bare tracker id to reference, credit, or contextualize other work — that reference is itself a close-shaped action on an integrated tracker, whether or not a Convention-4 close phrase is present anywhere.

The sanctioned alternative for docs/meta PRs that legitimately discuss other work — an ADR write-up, a retro, a wave-shared change spanning multiple rows — is to reference the **ADR number or spec/doc slug** (`ADR-0024`, `2026-07-19-hardening-w6`), never the bare tracker id. An ADR/spec identifier names the artifact without being integration-linked.

When this footgun *does* fire, the detection side is the closing probe: an issue closed by a stray mention leaves **no closing-PR evidence**, so `issue-store read-closing` reports it `closed-unknown` — the fourth outcome, an "evidence claim, not a verdict" (ADR-0020). The done-reconcile must **report** such a row, never auto-flag it as a rejection: `closed-unmerged` is reserved for a PR that was found and did not merge, and a mention-closed row is not that. Prevention (this convention) and honest detection (`closed-unknown`) are the two halves of the same W2-F1c defect.

Two live occurrences are the evidence this is a real footgun, not a hypothetical:

- **w2 (2026-07-16):** `FOR-13` resolved to `Done` mid-session with the trigger unconfirmed at the time — PR #9's title/body named "FOR-13" though FOR-13 was not the row that PR landed (docs/retros/2026-07-16-hardening-w2.md).
- **2026-07-19:** a docs-only PR (#29) whose **title** mentioned `FOR-6` and `FOR-33` — no Convention-4 close phrase anywhere in the body — was squash-merged, and the Linear GitHub integration moved both issues to `Done` before either had even been dispatched in the wave that was about to build them. Recovery required an out-of-band state reset (raw-GraphQL reopen) before the wave could run.

## Convention 5 — the sidecar write path (verb-written, at agent-return)

Sidecars — the durable Worker-report / Reviewer-verdict records under `.flotilla/waves/<slug>/reports|verdicts/` — are the WAL the resume doctrine ("disk beats a non-landed spine flip", ADR-0002) stands on. **The invariant (ADR-0024): every sidecar comes into being through the engine write verb, at the moment its agent returns — never hand-formatted, never bundled after routing.** This is the P-1 live-gate fix: a Coordinator death used to leave zero sidecars because they were written last, in a batch, after the Workflow returned.

- **The write verbs own the format.** `write-report`/`write-verdict` are the printers paired with the `sidecar.ts` reader (the way `renderSpine` is paired with `readSpine`, ADR-0016). They **validate-then-write** — an invalid payload is refused (exit 1, nothing written), the filename is engine-computed (`<id>-<iter>.md`, the caller cannot misname it), the body is the fenced-json block the reader parses, the target dir is `mkdir -p`'d, and a same-iter re-write is last-writer-wins. Full flags + exit codes: [reference/routing-mechanics.md](reference/routing-mechanics.md).

  | Verb | Renders | Cross-check |
  |---|---|---|
  | `write-report <json> --dir <reportsDir> --id <id> --iter <n>` | `<reportsDir>/<id>-<iter>.md` (fenced `WorkerReport`) | `report.issue` must be prefix-compatible with `--id` (the reader's rule) — else exit 1 |
  | `write-verdict <json> --dir <verdictsDir> --id <id> --iter <n>` | `<verdictsDir>/<id>-<iter>.md` (fenced `ReviewerVerdict`) | none (a verdict has no issue field — like the reader) |

- **Who runs the verb — per path.** On the Workflow-driver path, two cheap **Scribe** `agent()` stages run the verb (`worker → scribe(report) → reviewer → scribe(verdict)`) so the record is durable seconds after each agent returns, before any Coordinator routing (workflow-driver.md). On the degenerate inline path (`n = 1`, or an inline Reviewer re-dispatch), the Coordinator is its own Scribe — same verb, run immediately at agent-return. The old bundled post-routing write is gone.
- **A Scribe failure never discards the tuple.** The driver's Scribe stage passes the report/verdict through regardless and logs loud; at routing, the Coordinator checks each sidecar's existence and writes a *missing* one through the same verb (the documented recovery path, not the default).
- **`SCRIBE_RESULT_SCHEMA` is driver-local — NOT one of the drift-pinned copies.** The Scribe's `{ ok, path, error? }` return shape lives only in the Workflow driver; no engine const corresponds to it, so `skill-schema-drift.spec.ts` does not pin it and must not be extended to. Only `WORKER_REPORT_SCHEMA` / `REVIEWER_VERDICT_SCHEMA` above are drift-pinned.

## Convention 6 — the sanctioned amend path (Worker discloses, Coordinator amends)

When a Worker discovers mid-slice that an issue's **authored content** needs correcting — most often a **deferral that re-scopes an already-open issue** (the W4-F5 case: FOR-23's Worker found a gap belonging to FOR-20) — the fix goes through the engine's **Amend facet** (ADR-0025), never raw tracker GraphQL and never a tracker CLI.

- **The Worker discloses; it does NOT write.** A Worker has no store access from its isolated worktree (W4-F4) — its `wave.config.json` is gitignored and absent there. It records the needed change in its `WorkerReport` (`judgmentCalls` / `reviewerFocusItems`), and the **Coordinator** performs the amend from the wave root, where the store is configured.
- **The verb.** `issue-store amend <id> --patch <json-file>` — the patch is `{ title?, sections? }`, whole-patch-validated before any write (an empty patch is a usage error, exit 2; a reserved-heading collision or unknown id is a domain failure, exit 1). `sections` is **upsert-by-heading**: an existing `## <heading>` prose section is replaced (no shadow duplicate), an absent one appended.

  ```bash
  {{wave-cli}} issue-store amend <id> --patch /path/to/amend-patch.json --config <path>
  ```

- **`amend` cannot touch Files / Acceptance criteria / Blocked by.** Those are the wave Header-Block, and they have exactly one owner: `annotate` (decorate, ADR-0010). The `AmendPatch` type has **no such field**, and a `sections` heading of `Files` / `Blocked by` / `Unblocks` / `Acceptance criteria` throws, naming `annotate`. So an amend can never clobber acceptance criteria — structurally.
- **A full re-scope is two deliberate calls:** `amend` for the new title + prose, then `annotate` for the new Files / ACs (under the existing decorate rule — `to-issues` remains the sole governor of AC replacement). New title + a re-written brief go through `amend`; the modeled Header-Block goes through `annotate`.

This is the exact path W4-F5 lacked, where the only way to re-scope FOR-20 was raw Linear `issueUpdate` — bypassing the very seam flotilla is built around.

## Convention 7 — the host landing seam + the done-reconcile evidence hierarchy

Landing (arm / merge) and the host-side merge probe are **code-host** writes/reads, not tracker ones, and they all go through the engine's **`host-pr`** verb group (ADR-0023) — never raw `gh` (its creds are sandbox-denied and its TLS stack fought both the keychain and the proxy MITM cert, live-proven). Three shipped verbs, detect-host-routed, with `github` the one shipped adapter; the Bitbucket pilot implements the same interface and inherits them with no new skills:

- **`host-pr arm --branch <b>`** — the `--auto` landing intent (wave-close phase 4b). It decides **per PR**: checks pending → **enable auto-merge** (GraphQL); already clean → **direct merge now** (REST). Idempotent (`already-merged` on a re-run). Outcomes: `armed` / `merged` / `already-merged` / `refused` / `no-pr`.
- **`host-pr merge --branch <b>`** — merge now, no arm intent (the caller already decided).
- **`host-pr status --branch <b>`** — the merge probe: `{ state: open|merged|closed-unmerged|none, url? }`. `none` ("no PR for this branch") is a valid answer, not a failure.

None take `--config` — landing talks to the **code host**, not the tracker; the adapter builds from `$GITHUB_TOKEN`. Under a proxied sandbox, prefix `NODE_USE_ENV_PROXY=1` (Convention 1). The creation verb `host-pr create` is the *staged* half (ADR-0023 decision 3) and is not yet a CLI verb — PR creation still rides the Worker terminator.

**The done-reconcile evidence hierarchy — tracker attachment > host PR state > nothing.** Both `wave-close` (phase 5) and `wave-resume` (step 5) land a merged row `done` the same way, consulting evidence in this order:

1. **Tracker attachment** — `issue-store read-closing <id>`. On a native-integration tracker a merged PR attaches and this reports `merged` directly.
2. **Host PR state** — `host-pr status --branch <b>`, consulted **only when tier 1 cannot see a merge** (a no-integration workspace — Linear without the GitHub integration, or the Bitbucket pilot — where `read-closing` stays `open` / `closed-unknown` even after the PR lands). The host answers "did the PR for this branch merge?" mechanically.
3. **Nothing** — when neither tier proves a merge, leave the row `in-review` and report; a later touch reconciles.

On a merge proven by *either* tier, derive `--acked` first — `{{wave-cli}} verdict-acked <verdictsDir> <id>` (FOR-17, ADR-0004; the single-owner derivation of the reviewer-met AC indexes from that row's FINAL Reviewer verdict — never hand-parse `acVerification[]`) — then `issue-store close <id> <prUrl> --acked <indexes>` records the closing facts + the cosmetic AC tick and, on a `states.doneState` store, fires the FOR-13 done-state fallback. This **replaces the old out-of-band human-confirmation step** with a probe — a human is never asked to hand-assert a merge the host can report. Both execution skills derive `--acked` the same way before every merged-row `close` call — see `wave-close`'s [reference/close-mechanics.md](../wave-close/reference/close-mechanics.md) and `wave-resume`'s [reference/resume-mechanics.md](../wave-resume/reference/resume-mechanics.md) for the worked invocation; never call `close` on a merged row without it (the FOR-17 dead-wire bug).

**Arm-and-exit, not watch.** `--auto` arms and exits; the host completes merges server-side (surviving a dead Coordinator). Late merges — and an armed PR whose checks later fail — reconcile on the next `wave-close` / `wave-resume` touch, not live. This latency is accepted and documented, never papered over with a poll loop.

## Convention 8 — secret-safe briefs (never echo an environment variable's value)

An agent's tool output is not ephemeral — it is the session transcript on disk, long-lived and read by humans and downstream agents alike. **A brief never causes an agent to echo an environment variable's VALUE into that output — not even with fallback syntax like `${VAR:-no}`.** This applies to every brief the driver composes (Worker, Reviewer, Scribe alike), not just the ones that write to the tracker.

- **Fallback syntax is not safe.** `echo "${VAR:-no}"` still prints the live value whenever `VAR` is set — the fallback branch fires only when it is *absent*. There is no "just for diagnostics" form of `echo $VAR` that stays safe once the variable might hold a secret.
- **Check availability value-free.** The only sanctioned presence test is one that cannot leak the value:
  ```bash
  [ -n "$VAR" ] && echo set
  ```
  This prints the literal string `set` (or nothing) — never the token.
- **The constraint is on tool output generally, not just brief prose.** A brief that itself never asks for `${VAR:-no}` can still be defeated by an agent free-styling a diagnostic mid-task. Tool output must never contain a secret — full stop — whether it originates from brief-scripted bash or an agent's own improvised check.

### Live occurrence (evidence)

**2026-07-20, publication wave, finding W8-F1** (docs/retros/2026-07-20-publication-w8.md): a Worker checked host-token availability with a flawed `${VAR:-no}` diagnostic echo and printed the live `GITHUB_TOKEN` into its agent-visible tool output — i.e. into the session transcript on disk. The Worker self-disclosed it, the Reviewer escalated ("this review cannot verify or remediate"); nothing was committed and nothing left the machine, but the token was rotated as a precaution. This convention is the fix: value-free availability checks only, in every dispatched brief.

## Convention 9 — wiring-disclosure (a new verb/interface names its consumer, or discloses the gap)

A Worker that introduces a new verb, subcommand, or exported interface can pass every gate — spec-covered, tests green — while the consuming flow never calls it, because the call site lives in a file outside the slice's declared Files globs. There is no structural way to catch "is this new symbol actually invoked" at the schema boundary, so the fix is a brief-level disclosure requirement, not an engine check: a slice introducing a new verb, subcommand, or exported interface must, in its `WorkerReport`, either

- name the consuming call-site(s) that now invoke it, or
- explicitly disclose under `judgmentCalls` — mirrored in `reviewerFocusItems` so the Reviewer inherits the same flag — that the wiring lies outside the declared Files globs, so the Coordinator can grant a scope extension or plan the wiring before the review round.

The clause itself lives in `workerBrief()`'s policy-clauses list (`.claude/skills/wave-start/reference/workflow-driver.md`) — the text a Worker actually receives; this section documents the convention it encodes.

### Live occurrences (evidence)

Two consecutive cap=1 re-dispatches were caused by exactly this class — each caught only at review, each costing a full iteration-2 round (~9 min, ~200k tokens):

- **W11 — FOR-30** (docs/retros/2026-07-20-hardening-polish-w11.md): the new `ENGINE_SURFACE` detection regex matched the wrapper stores but not the transport layer beneath them (`real-*-api.ts`, the factories, `cli-store.ts`) — spec-covered, gate green, caught by the Reviewer; iter-2 widened the regex.
- **W12 — FOR-53** (docs/retros/2026-07-20-preflight-hardening-w12.md): `setRowIter` + the `spine set-row-iter` CLI verb landed correct and spec-covered, but a repo-wide grep for the new verb name returned 0 hits — the consuming call site (`start-mechanics.md` Step 7d) still invoked only the old `set-row-state re-dispatched`. Caught by the Reviewer; iter-2 wired it via a Coordinator scope extension to exactly the two named files.

## Common Mistakes

- **Hand-editing an inlined schema literal.** The TS const is the source of truth; edit it, run the drift-guard, then sync the literal. A lone literal edit fails `skill-schema-drift.spec.ts`.
- **Pasting this file's canonical `WORKER_REPORT_SCHEMA` (with `anyOf`) straight into `agent({ schema })`.** The agent tool rejects a top-level `anyOf`/`oneOf`/`allOf` at the boundary (live: W5-F1). Paste the anyOf-free driver copy in `workflow-driver.md` instead — on that copy the `prUrl`-on-`done` invariant is brief-enforced, not schema-enforced.
- **Re-adding `briefProfile`.** It was removed engine-side (uniform Reviewer, ADR-0016). With `additionalProperties: false`, a verdict carrying it would be *rejected* at the agent boundary.
- **Routing off prose.** Never read a verdict word, a test count, or an outcome out of the subagent's free text. Use the typed field through `route-verdict` / `route-outcome`.
- **Dropping `riskClass` from a verdict.** It is required and bifurcates the route (G3). A verdict missing it is rejected before routing — by design.
- **Omitting `prUrl` on a finishing report.** `done` / `done-with-concerns` ⇒ the PR exists ⇒ report its URL. The Reviewer's PR-body check and the Coordinator's terminator both read the field as fact; its absence reads as "no PR exists" and costs you a blind review and a duplicate-PR attempt (retro W3-F2).
- **Batching spine writes.** One atomic write per flip. A torn spine breaks resume.
- **Shelling a tracker CLI.** All tracker writes go through the engine (`issue-store …`, the host seam). Never raw `gh` from an execution skill.
- **Reaching for raw `gh` to arm, merge, or probe a PR.** Landing and the host merge-probe go through the `host-pr arm | merge | status` verbs (Convention 7, ADR-0023) — `gh` left the landing path entirely (sandbox-denied creds, keychain/proxy TLS). These verbs take no `--config` (they talk to the code host, not the tracker).
- **Stopping the done-reconcile at `read-closing` on a no-integration workspace.** There the tracker never attaches the PR, so `read-closing` can never report `merged`. Follow the evidence hierarchy (Convention 7): consult `host-pr status`, and let the host's `merged` fire the FOR-13 `close` fallback. There is no out-of-band human-confirmation step. And do not build a watch/poll loop after `--auto` arms — arm-and-exit; a later touch reconciles.
- **Calling `issue-store close` on a merged row without deriving `--acked` first (the FOR-17 dead wire).** `close` has always accepted `--acked 0,2,3` to tick the reviewer-met ACs, but a call that omits it leaves the tracker's checklist unticked even though the row lands `done`. Both `wave-close` and `wave-resume` derive it the same way — `{{wave-cli}} verdict-acked <verdictsDir> <id>` (Convention 7) — before every merged-row `close`; never hand-parse `acVerification[]` in the skill instead.
- **Hardcoding `Closes #N` in a PR body regardless of store kind.** The close phrase is store-kind-derived (Convention 4): `github` → `Closes #N`, `linear` → `Fixes <TEAM-NN>`. A `linear` consumer's PR carrying `Closes #N` closes nothing and creates no attachment — the row silently stalls at `in-review`.
- **Naming a bare tracker id in a PR title/body you don't intend to close (the mention-footgun).** An integrated tracker links and can act on every issue id it finds, not just the Convention-4 close phrase — a docs/meta PR's title mentioning another row's id has auto-closed it before that row was even dispatched (live twice: w2 FOR-13, 2026-07-19 FOR-6/FOR-33). Reference an ADR/spec identifier instead; never a bare tracker id unless closing it is the point.
- **Bundling sidecar writes after routing, or hand-formatting a sidecar (Convention 5).** Sidecars are written by `write-report`/`write-verdict` **at agent-return**, before routing — not batched at the end (the P-1 kill window) and never hand-typed. A hand-formatted sidecar drifts from the reader and resurfaces as "corrupt" at resume.
- **Drift-pinning `SCRIBE_RESULT_SCHEMA`.** It is driver-local (no engine const); only the two agent-boundary schemas above are pinned by `skill-schema-drift.spec.ts`. Do not add the Scribe shape to that spec.
- **Echoing an environment variable's value — even via `${VAR:-no}` fallback syntax.** The fallback only fires when the variable is absent; when it's set, the value prints straight into agent-visible tool output, i.e. the session transcript on disk (live: W8-F1, docs/retros/2026-07-20-publication-w8.md). Check availability value-free instead: `[ -n "$VAR" ] && echo set` (Convention 8).
- **Letting a Scribe failure kill the tuple.** The driver's Scribe stage must pass the report/verdict through and log loud on a write failure — a throw would drop the row to `null` and convert a finished Worker into a spurious `worker-failed` STOP.

- **Re-scoping or correcting an issue with raw tracker GraphQL / a tracker CLI.** The exact W4-F5 failure. To change an issue's title or prose, use `issue-store amend` (Convention 6); to change its Files/ACs, use `issue-store annotate`. A Worker *discloses* the needed change in its report and the Coordinator amends — never reach past the engine seam. And `amend` cannot be used to change acceptance criteria: an `AmendPatch` has no AC field and a reserved-heading section throws.
