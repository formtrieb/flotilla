---
name: wave-shared
description: Shared reference that the wave execution skills — wave-start, wave-reviewer, wave-close — load for the exact result shapes a dispatched agent has to return, and for the working rules they all follow: checking access to the tracker and the code host up front, handling each review outcome the same way every time, and writing to a wave's plan file without ever leaving it half-written. Read via a sibling-path file read by those skills, from their own base directory rather than loaded by name; never picked on its own.
disable-model-invocation: true
---

# wave-shared

The shared substrate the **execution** skills (`wave-start`, `wave-reviewer`, `wave-close`) read via a sibling-path file read. It carries no judgment and is **never model-invoked** (`disable-model-invocation: true`) — siblings reach for it explicitly, as a file beside their own base directory rather than through the Skill tool. It owns the three things those skills must agree on byte-for-byte:

1. **The canonical agent-boundary JSON schemas** — `WORKER_REPORT_SCHEMA` and `REVIEWER_VERDICT_SCHEMA`, inlined verbatim below. A skill cannot `import` a TS const, so the Workflow driver pastes these literals into `agent({ schema })`. They are **copies** of `tools/wave/src/worker-report-schema.ts` / `reviewer-verdict-schema.ts` and the drift-guard spec (`tools/wave/src/skill-schema-drift.spec.ts`) deep-equals them to the exported consts on every run — if you edit a literal here, the spec fails until the source const matches.
2. **The auth-preflight convention** — `detect-host` → verify, before any tracker write.
3. **The deterministic routing chain** — `route-verdict` / `route-outcome` → `issue-store transition` → spine write, with one **atomic spine write per state flip**.

The CLI invocation detail (exact flags, exit codes, the `{{wave-cli}}` resolution) lives in [reference/routing-mechanics.md](reference/routing-mechanics.md).

## Sibling-path loads (the cross-skill composition finding)

`wave-shared` is never model-invoked — `disable-model-invocation: true` removes it from what a model may Skill-invoke by name, in every context, so no Coordinator can execute a "load it by name" instruction through the Skill tool at all. Its siblings read it as a file instead: the harness hands every loaded skill its own base directory, and `../wave-shared/SKILL.md` plus every file under `../wave-shared/reference/`, resolved against that anchor, sit beside it identically in source form, in a plugin clone, and in a vendored copy — no namespace to guess, no Skill tool, no human in the loop (ADR-0040).

**Live occurrence (2026-08-13, installed-form consumer).** flotilla's first fully-external consumer dispatched a wave and the Coordinator could not load `wave-shared` at all: `disable-model-invocation: true` blocks a model-invoked by-name load everywhere, project-local or installed, so the by-name doctrine this section used to teach was never executable — the operator had to invoke `/flotilla:wave-shared` by hand to get past it. That negative result is why `wave-start` and `wave-close` (and `wave-close`'s phase-1 reference file) now read `../wave-shared/SKILL.md` and everything under `../wave-shared/reference/` against their own base directory, rather than loading by name.

**Dual-form narrows to humans.** `/wave-shared` (project-local) and `/flotilla:wave-shared` (installed) stay the right answer for a slash-command recommendation addressed to a person — the naming gap between the two contexts is real for a human typing a name into the session — but agent-side loading needs neither spelling; it is out of that scope entirely.

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
    documentedFormComparison: {
      type: 'object',
      additionalProperties: false,
      required: ['trigger', 'sources', 'divergences'],
      properties: {
        trigger: { type: 'string', enum: ['issue-declared', 'worker-declared', 'deferred-core-path'] },
        sources: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        divergences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['description', 'deliberate'],
            properties: {
              description: { type: 'string', minLength: 1 },
              deliberate: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
};
// --- end ---
```

`riskClass` is **required and load-bearing** (the G3 guard): `route-verdict` bifurcates on it — a `public-API-change` `approve` never silently fast-paths past the human STOP. There is **no `briefProfile`** — flotilla's Reviewer is uniform (no Risk→profile map, ADR-0016); the field was removed engine-side and must not reappear here, or `additionalProperties: false` would reject every real verdict.

`documentedFormComparison` is the **Documented-Form Comparison** ([ADR-0030](../../../docs/adr/0030-deferred-core-path-requires-documented-form-comparison.md)) — the Reviewer's required substitute evidence for a row whose core path cannot be executed from the review environment, carried as **its own outcome** rather than folded into `acVerification[]`. It is **flat and optional in the schema, required by contract prose whenever a trigger fired**: the requirement is conditional, but encoding a conditional at the schema root would mean a top-level `anyOf`/`if` — the one shape the agent boundary rejects outright (W5-F1, same lesson as the `WORKER_REPORT_SCHEMA` note above), so the conditional half lives in `.claude/agents/wave-reviewer.md` (Check 6). `sources` is `minItems: 1` on purpose: that is the structural half of the no-restatement rule — a comparison must cite at least one document the Reviewer read **in its own dispatch**, so it can never be discharged by restating the Worker's claim.

## Load every file under reference/

Each Convention this skill's siblings inherit lives as its own file under [reference/](reference/) — one file per convention, carrying its full `## Convention N — …` heading and body verbatim, including any Live-occurrences evidence. **Load every file in that directory, not a subset picked by name** — a sibling's `Convention <n>` citation resolves to real prose only once the whole directory has been read, and no single file stands in for the rest. This loader deliberately does not enumerate what's in there — only the number allocated most recently (below): a new convention is a new file dropped into `reference/`, with zero edits to any *existing* reference file required.

### Number-allocation register — the highest allocated Convention number is **16**

**Content shape: a counter plus an always-current one-liner for whichever convention holds that number — decided when 14 held the slot, before Convention 15 existed to test it.** This section is not a running index of every convention ever allocated (the split ADR rejected a per-convention index line, below) and not a changelog of past ones — it holds exactly two things: the heading's embedded number, and a single descriptive line for the convention currently on top. The one-liner exists so a reader who never opens `reference/` still meets the newest rule (that is why the loader names this section explicitly, above); anything about an *older* convention belongs in that convention's own reference file, and, where it earned one, a Common-Mistakes bullet — never a second one-liner accumulating here.

**16 — the operator register** ([convention-16-operator-register.md](reference/convention-16-operator-register.md)): every line an agent prints for the person at the session is operator-directed output and holds one register — internal references (decision-record numbers, convention numbers, finding ids, wave slugs, retro paths) are translated into their one-line consequence, a domain term gets a half-sentence introduction at first use per session, the human is addressed directly ("du"/"you") and never as "the Coordinator", and every skill run ends with an operator block (what happened → where it lives → what you do next). Operator-directed text follows the operator's language while artifacts stay English. Strict in installed form; source form may append one compact reference pointer after the plain text (ADR-0039).

**A new convention takes the next number and REPLACES both lines above with its own — the heading's embedded number *and* the one-liner beneath it, together.** Bumping only the number and leaving the prior convention's one-liner in place is the defect this content-shape decision closes: it would strand a stale description under a heading that no longer matches it. "Nothing else" refers to the rest of this file — the Common-Mistakes catalogue, the other conventions' reference files — none of which a new allocation touches. This is still one allocation counter (plus its one-liner), not the per-convention index the split ADR rejected (ADR-0028): an index line per convention re-creates the shared-file conflict the split existed to remove, whereas a counter-plus-one-liner stays two lines no matter how long the convention list gets. It buys the one thing the directory listing alone cannot: **same-number collision hygiene** — two slices planned in parallel both reaching for "the next number" and both landing `Convention 14` produce two files whose `Convention <n>` citations are ambiguous forever, because sibling skills cite conventions by number and numbers are never re-used and never renumbered.

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
- **Echoing an environment variable's value — even via `${VAR:-no}` fallback syntax, a whole-environment dump, or reading a gitignored settings/secret file.** This is Convention 8, and it binds every role that produces tool output — Worker, Reviewer, Scribe, and the Coordinator itself — not only the brief text a Worker reads. Recurring, each new vector past whatever prose the previous one had hardened: a flawed `${VAR:-no}` echo (W8-F1, docs/retros/2026-07-20-publication-w8.md), a `printenv GITHUB_TOKEN` whole-environment-style check (W21-F1, docs/retros/2026-07-22-runtime-residue-docs-w21.md), and a Reviewer `cat`ing the gitignored `.claude/settings.local.json` (W23-F1, docs/retros/2026-07-23-ci-verify-setup-env-w23.md) — see this convention's own reference file for the full, still-growing catalogue. Check availability value-free instead: `[ -n "$VAR" ] && echo set` (Convention 8) — and lean on the settings-deny anchor (`.claude/settings.json` `permissions.deny`, FOR-81) as the structural backstop a brief clause alone can never be for the one role that reads no brief.
- **Letting a Scribe failure kill the tuple.** The driver's Scribe stage must pass the report/verdict through and log loud on a write failure — a throw would drop the row to `null` and convert a finished Worker into a spurious `worker-failed` STOP.
- **Leaving a self-started runtime resource running with no disclosure (Convention 10).** `worktree-cleanup` only knows git artifacts — a compose project, container, volume, network, or bound port a Worker starts is invisible to it. Tear the resource down before termination, or disclose it under `judgmentCalls` (mirrored in `reviewerFocusItems`) so the Coordinator can clean up after landing (live: PC-F2, doc slug 2026-07-22-postgres-ci).
- **Burying a rule's evidence inside the instruction that states it (Convention 14).** Keep the rule and its one-line *why* in place — an unexplained invariant invites an executing agent to improve it — and move the citation that backs the why to a provenance position: a compact trailing pointer, a provenance block, or a reference file. A paragraph recounting which wave hit this and what the retro concluded is provenance in an instruction's clothes, and it is what makes shipped skill prose read as an internal diary to a consumer. Guarded over SKILL.md bodies, legacy allowlist shrinking opportunistically — never by a mass-rewrite pass, which conflicts with every open row declaring those files.
- **Landing a PR that closes a tracker issue without a Reviewer verdict (Convention 15).** The boundary is provenance, not file class: a doc-only diff, a one-line skill edit and a mechanical bundle are all in the reviewed lane the moment the PR body carries a close phrase, because the verdict is the AC ground truth and CI is no content check at all on prose. Only a session-authored orchestration artifact that closes no issue — a retro, an ADR, a glossary update — may land Coordinator-direct. When cost is the concern, cut the Worker, never the verdict: implement the row `foreground` and dispatch the Reviewer anyway (ADR-0033).
- **Re-scoping or correcting an issue with raw tracker GraphQL / a tracker CLI.** The exact W4-F5 failure. To change an issue's title or prose, use `issue-store amend` (Convention 6); to change its Files/ACs, use `issue-store annotate`. A Worker *discloses* the needed change in its report and the Coordinator amends — never reach past the engine seam. And `amend` cannot be used to change acceptance criteria: an `AmendPatch` has no AC field and a reserved-heading section throws.

## Operator register (Convention 16)

**Everything you print for the person at this session is operator-directed output, and it holds one register.** Plain language, direct address ("du"/"you"), self-explaining. Translate every internal reference — a decision-record number, a convention number, a finding id, a wave slug, a retro path — into the one-line consequence it carries for them, instead of naming it. Introduce a domain term with a half-sentence the first time it appears in a session, then use it freely. End the run with an operator block: what happened → where it lives → what you do next. Operator-directed text follows the operator's own language; the artifacts you write — issues, PRs, decision records, spine entries — stay English. **Installed form is strict** — no internal token reaches the operator. **Source form**, flotilla's own repo, may append one compact reference pointer after the plain text. Full clause text, the operator mini-glossary, and the mistakes it closes: [wave-shared/reference/convention-16-operator-register.md](../wave-shared/reference/convention-16-operator-register.md), read as a file beside this skill's own directory — no skill invocation, no namespace to guess.
