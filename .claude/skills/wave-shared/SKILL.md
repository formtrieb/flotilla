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

## Plugin-namespaced by-name loads (the cross-skill composition finding)

`wave-shared` is always **invoked by name**, never model-triggered — but the name a sibling must type is **not the same string in every context**, and the gap between the two is not cosmetic:

- **Project-local (this repo, dogfooding).** flotilla runs here with its own plugin explicitly disabled (`.claude/settings.json` → `"enabledPlugins": {"flotilla@formtrieb": false}` — the plugin-manifest slice's resolution to the skill/agent double-registration it found). Every skill, including this one, registers under its **bare** name: `/wave-shared`. There is no `flotilla:`-prefixed form available in this context at all — a Coordinator typing `/flotilla:wave-shared` here finds nothing to load.
- **Installed-plugin consumer (no project-level `.claude/skills` of its own — the clean-room case).** A repository that only ever consumes flotilla through the packaged plugin is inferred to register every skill under the **plugin-namespaced** form: `/flotilla:wave-shared`. [ADR-0018](../../../docs/adr/0018-wave-execution-runs-on-a-single-workflow-driver-with-a-shared-skill.md) anticipated exactly this dual naming before any consumer run existed ("`/wave-shared` (project-local; `/flotilla:wave-shared` once packaged as a plugin)"). The closest empirical data point is the sibling by-name mechanism — agent dispatch, not skill loading — from the first clean-room consumer wave run purely through the installed `@formtrieb/flotilla-engine` plugin (`docs/retros/2026-07-27-plugin-consumer-w1.md`, finding DA-F3). Read what DA-F3 actually supports, not more than that: the Coordinator set the Workflow driver's `agentType` to the plugin-namespaced `flotilla:wave-reviewer` **preemptively**, because the harness's own agent list showed the Reviewer registered that way — the run therefore demonstrates only that **the prefixed form resolves**. A bare-form failure was never tried, let alone observed; DA-F3 says so explicitly ("belegt ist damit nur, dass die präfixierte Form geht, nicht dass die nackte scheitert" — proven only that the prefixed form works, not that the bare one fails). The determination above for skills is a **reasoned inference** stacked on that data point — the same plugin-manifest mechanism that namespaces agents plausibly namespaces skills identically — not a direct observation of a bare `/wave-shared` load failing under an installed plugin. That residual gap is named in full below.

**No single spelling resolves in both, so the fix is dual-form, not a blanket replace.** Rewriting every reference to the plugin-namespaced form outright would break every in-repo dogfooding session — the one context this repo's own Workers and Coordinators can actually exercise directly. Instead, every cross-skill by-name reference to this skill states **both** forms, project-local first, plugin-namespaced second, so whichever context is live, the reader picks the one that is actually registered: `wave-start` and `wave-close` (and `wave-close`'s phase-1 reference file) carry this dual form at their own "load wave-shared by name" line. This file does not load itself and has no reference of its own to update. **Coordinator sign-off (2026-07-28):** the dual form was reviewed and endorsed as the intended resolution of this slice's AC2 binary menu — neither "namespaced-only" nor "no edit" fits a case where no single spelling resolves in both contexts, and the dual form is the reasoned middle path; this flagged deviation is closed, not open.

**What was not independently re-verified.** This Worker cannot install the packaged plugin from an isolated worktree of the flotilla repo itself — the plugin-manifest slice's own resolution disables flotilla's own plugin in-repo, and a fresh clean-room repository is out of reach from here. The plugin-namespaced-required determination above rests on the DA-F3 clean-room finding for the parallel agent-dispatch mechanism plus the general plugin-skill-registration behavior it shares, not on a fresh probe of a Skill-tool by-name load specifically. A follow-up clean-room probe — a back-half skill's own `/wave-shared` load, exercised in a repository that has never carried flotilla, plugin installed — would close that residual gap if a higher evidence bar is ever needed here.

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

Each Convention this skill's siblings inherit lives as its own file under [reference/](reference/) — one file per convention, carrying its full `## Convention N — …` heading and body verbatim, including any Live-occurrences evidence. **Load every file in that directory, not a subset picked by name** — a sibling's `Convention <n>` citation resolves to real prose only once the whole directory has been read, and no single file stands in for the rest. This loader deliberately does not enumerate what's in there: a new convention is a new file dropped into `reference/`, with zero edits to this file or to any existing reference file required.

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

- **Re-scoping or correcting an issue with raw tracker GraphQL / a tracker CLI.** The exact W4-F5 failure. To change an issue's title or prose, use `issue-store amend` (Convention 6); to change its Files/ACs, use `issue-store annotate`. A Worker *discloses* the needed change in its report and the Coordinator amends — never reach past the engine seam. And `amend` cannot be used to change acceptance criteria: an `AmendPatch` has no AC field and a reserved-heading section throws.
