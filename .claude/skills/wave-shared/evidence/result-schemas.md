## Result schemas — the full literal copies

**Moved out of `wave-shared/SKILL.md` on 2026-09-26 (issue #818).** `compose-driver` has filled both schemas into the shipped driver script from the engine asset since issue #680; no Coordinator has pasted either literal by hand since then. Keeping the two literals and their explanatory notes at their fence anchors in `wave-shared/SKILL.md` meant every wave's standing per-wave read carried the full field-by-field shape for a schema no Coordinator authors any more. They move here — reachable on demand, via the same sibling-path read a citation already resolves through, never as part of the standing per-wave load (ADR-0040) — and `wave-shared/SKILL.md` keeps, in short form, every rule the notes below carry, plus a pointer to this file. `tools/wave/src/skill-schema-drift.spec.ts` now extracts both fence-anchored literals from here instead of from `wave-shared/SKILL.md`.

### THE SCHEMAS ARE COPIES — do not hand-edit to "fix" a shape

The two literals below are the **agent-boundary contract**: the Workflow tool validates each subagent's structured return against them *before* the driver ever sees it (this is what kills the prose-fabrication class — no number is re-typed from free text; routing reads a typed field). `additionalProperties: false` keeps a subagent from smuggling un-modelled fields the router would ignore.

They are hand-compacted copies of the engine consts. **The source of truth is the TS const**, not this file. To change a schema: edit `tools/wave/src/*.ts`, run the drift-guard, then update the literal here to match. Never edit the literal alone.

#### Worker-Report schema

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

The `outcome` field is the routing discriminator: `done` / `done-with-concerns` → proceed to Reviewer dispatch; `needs-context` → auto re-dispatch with context; `blocked` → STOP and flag. The driver never re-reads it from prose — it passes the typed `outcome` to `route-outcome` (see the routing chain in `wave-shared/SKILL.md`).

**A finishing report must carry the PR URL** — that is what the `anyOf` block encodes: `outcome: done` / `done-with-concerns` ⇒ `prUrl` is **required**; `needs-context` / `blocked` ⇒ it may be omitted (there may be no PR). Brief every Worker accordingly. Two consumers read that field as fact, and both fail silently when it is absent:

- the **Reviewer** verifies the PR body — including the store-kind close phrase (Convention 4), the one thing that decides whether the row can ever reach `done` on a `linear` store. With no `prUrl` it reports "PR is not yet opened" and skips a check it was briefed to run;
- the **Coordinator's terminator** reads an absent `prUrl` as "no PR exists" and opens one — a duplicate PR against a branch that already has one.

`prUrl` is optional *in shape* only so an honest `blocked` report isn't rejected; it is not optional on the path where the Worker finished. If a Worker's return is rejected at the boundary for a missing `prUrl`, the fix is the Worker reporting the URL it already has — never relaxing the schema.

##### This literal's top-level `anyOf` is NOT boundary-portable — do not paste it into `agent({ schema })`

The `WORKER_REPORT_SCHEMA` literal above is the **canonical** copy — deep-equal-pinned to the engine const — but its top-level `anyOf` is not something the agent-tool boundary accepts. The agent tool's `input_schema` validation **rejects a top-level `anyOf`/`oneOf`/`allOf` outright**: `input_schema does not support oneOf, allOf, or anyOf at the top level`. Pasting this literal verbatim into `agent({ schema })` fails every Worker dispatch instantly, before a single agent runs (live: **W5-F1**, `docs/retros/2026-07-19-hardening-w5.md` — the first Workflow dispatch of that wave failed this way, 0 tokens, all 4 Workers, 4.8s).

**The anyOf-free copy lives in the SHIPPED DRIVER SCRIPT — `tools/wave/driver/wave-start-inflight.js`** (also named `WORKER_REPORT_SCHEMA` there) — identical to the literal above minus the `anyOf` block. Nobody pastes it by hand any more: the engine's `compose-driver` verb fills that shipped script and the harness runs the file, so the copy is a package asset rather than a fence anyone extracts (issue #680). `wave-start/reference/workflow-driver.md` is where that copy is *reasoned about* — §"Why the shipped driver's `WORKER_REPORT_SCHEMA` drops `anyOf`" — and the literal itself is not in that document. On that driver copy, the `prUrl`-on-`done`/`done-with-concerns` invariant is **brief-enforced, not schema-enforced**: `workerBrief()`'s Termination + Report sections state the requirement in prose, and there is no structural rejection at the `agent({ schema })` boundary for a `done` report that omits `prUrl` on that path. `tools/wave/src/skill-schema-drift.spec.ts` separately asserts the driver copy stays free of any top-level combinator, so the W5-F1 regression cannot silently return.

#### Reviewer-Verdict schema

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

`documentedFormComparison` is the **Documented-Form Comparison** ([ADR-0030](../../../../docs/adr/0030-deferred-core-path-requires-documented-form-comparison.md)) — the Reviewer's required substitute evidence for a row whose core path cannot be executed from the review environment, carried as **its own outcome** rather than folded into `acVerification[]`. It is **flat and optional in the schema, required by contract prose whenever a trigger fired**: the requirement is conditional, and the schema root is the wrong home for it — but not because the boundary refuses the shape (measured with controls: a top-level `anyOf`/`oneOf`/`allOf` is refused, the same lesson as the `WORKER_REPORT_SCHEMA` note above, W5-F1; a top-level `if`/`then` is **accepted and genuinely enforced**). It stays out because the antecedent is `trigger`, a field the Reviewer itself authors — an author cornered on a consequent changes the antecedent rather than failing, so a root conditional buys shape and never truth ([ADR-0034](../../../../docs/adr/0034-a-rule-earns-its-enforcement-tier.md) Amendment 2026-08-14: engine refusal outranks schema boundary whenever a rule's condition names a field the constrained agent also writes). So the conditional half lives in `.claude/agents/wave-reviewer.md` (Check 6) — and stays there; this is a placement decision, never a cue to re-encode it as a root `if`/`then`. `sources` is `minItems: 1` on purpose: that is the structural half of the no-restatement rule — a comparison must cite at least one document the Reviewer read **in its own dispatch**, so it can never be discharged by restating the Worker's claim.
