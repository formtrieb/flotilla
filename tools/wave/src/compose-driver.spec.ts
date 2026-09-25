/**
 * compose-driver.spec.ts — the composed driver, exercised the way the harness
 * exercises it.
 *
 * Four layers of evidence, deliberately separate:
 *
 *  1. **Substitution is total and nothing else moves.** The composed script is
 *     re-derived here by an INDEPENDENT implementation (plain string surgery in
 *     this file, not the module's own helpers) and compared byte-for-byte. That
 *     is what makes "the composed script is the template with its six constants
 *     and its ISSUES array filled" a checkable claim instead of a hope — the
 *     property that used to be defended by a currency checklist.
 *
 *  2. **The composed script RUNS under the Workflow-tool contract.** The script
 *     is evaluated against stubs for the four primitives the harness supplies
 *     (`agent`, `pipeline`, `phase`, `log`), so the stage layout, the per-stage
 *     dispatch options and the fully-rendered brief text are all observed rather
 *     than asserted about. This is the oracle the acceptance criteria name: what
 *     a hand-composed driver produced for the same inputs is exactly what the
 *     asserted stage labels, models, isolation posture and brief content below
 *     describe.
 *
 *  3. **The compose-time refusals fire.** The required-row-fields assertion, the
 *     human-gate/foreground refusal, the anchor-resolvability gate and the
 *     parse gate all moved into the engine with this verb; each gets a positive
 *     case and a negative control (Convention 11).
 *
 *  4. **The shipped template PARSES — as a NAMED gate (issue #868).** Layer 2
 *     parses the template incidentally, by running a COMPOSED copy of it, and
 *     that was the whole coverage: an unbalanced backtick surfaced as an opaque
 *     `SyntaxError` inside nineteen behaviour tests at once, no one of which
 *     says it is the parse gate and no one of which has ever been shown to fail
 *     for that reason. The named gate below compiles the SHIPPED template — not
 *     a composed copy — in the function-body form the harness evaluates, and
 *     never runs it; its negative control plants an unbalanced backtick into a
 *     copy and reads the position out of the `SyntaxError`. The compose-time
 *     half of the same gate lives in layer 3, because a refusal is what it is.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSE_DRIVER_CONTRACT,
  DRIVER_TEMPLATE_PATH,
  REQUIRED_ROW_FIELDS,
  agentDefinitionName,
  assertDispatchableWorker,
  assertRequiredRowFields,
  branchFor,
  closePhraseFor,
  composeDriverScript,
  composeIssueSpec,
  depsSetupFrom,
  isMissingField,
  projectScopeGrants,
  resolveReviewerAgent,
  runComposeDriver,
  slugFromSpinePath,
  stripBareIds,
  tierForRisk,
  type DriverRow,
} from './compose-driver';
import type { VerifyCommand } from './verify';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { HUMAN_GATED_WORKER, readSpine, renderSpine, setRowState, upsertDispatchLogEntry, upsertDispatchLogModel, upsertPrLogRow } from './wave-md-rw';
import { addDisclosureToSource, setDispositionInSource } from './spine-store';

const TEMPLATE = readFileSync(DRIVER_TEMPLATE_PATH, 'utf8');

// ─── fixtures ─────────────────────────────────────────────────────────────────

const SOURCE_FORM_CLI = './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts';
const INSTALLED_FORM_CLI = './node_modules/.bin/flotilla-engine';

const PLUGIN_MANIFEST = JSON.stringify({
  name: 'flotilla',
  version: '9.9.9',
  agents: ['./.claude/agents/wave-reviewer.md'],
});

const AGENT_DEFINITION = ['---', 'name: wave-reviewer', 'model: sonnet', '---', '', 'body'].join('\n');

function fakeClone(): (path: string) => string | null {
  return (path: string) => {
    if (path.endsWith(join('.claude-plugin', 'plugin.json'))) return PLUGIN_MANIFEST;
    if (path.endsWith(join('.claude', 'agents', 'wave-reviewer.md'))) return AGENT_DEFINITION;
    return null;
  };
}

const MANIFEST_PATH = join('/clone', '.claude-plugin', 'plugin.json');

function row(overrides: Partial<DriverRow> = {}): DriverRow {
  return {
    id: '42',
    slug: 'demo-slug',
    worker: 'background',
    risk: 'mechanical',
    iteration: 1,
    model: 'sonnet',
    anchorSha: 'deadbeefcafe',
    coordinatorBranch: 'main',
    depsSetup: 'npm ci --prefix tools/wave',
    issueSpec: '# Demo\n\nDo the thing.',
    scopeGrants: [],
    prTitle: 'fix: do the thing',
    closePhrase: 'Closes #42',
    reviewerHints: ['Verify the thing.'],
    siblingBranches: '(none — no sibling branches in this wave)',
    ...overrides,
  };
}

const CONSTANTS = {
  repoRoot: '/abs/repo — with a space',
  waveCli: `NODE_USE_ENV_PROXY=1 ${SOURCE_FORM_CLI}`,
  reportsDir: '/abs/repo/.flotilla/waves/w/reports',
  verdictsDir: '/abs/repo/.flotilla/waves/w/verdicts',
  reviewerAgent: 'flotilla:wave-reviewer',
  // The SIXTH constant (ADR-0012 Amendment 2026-09-21). A consumer-shaped id
  // rather than a brand, for the same reason every fixture model in this file
  // is one: the no-brand scan below reads this source too.
  scribeModel: 'consumer-scribe-model-id',
};

/**
 * The SAME substitution, re-implemented here with plain string surgery. A spec
 * that called `composeDriverScript` to build its own expectation would compare
 * the implementation with itself; this compares it with a second reading of the
 * same rule.
 */
function expectedScript(rows: DriverRow[]): string {
  let out = TEMPLATE;
  const fills: Array<[string, string]> = [
    ['REPO_ROOT', CONSTANTS.repoRoot],
    ['WAVE_CLI', CONSTANTS.waveCli],
    ['REPORTS_DIR', CONSTANTS.reportsDir],
    ['VERDICTS_DIR', CONSTANTS.verdictsDir],
    ['REVIEWER_AGENT', CONSTANTS.reviewerAgent],
    ['SCRIBE_MODEL', CONSTANTS.scribeModel],
  ];
  for (const [name, value] of fills) {
    const re = new RegExp(`^const ${name} = '[^']*'$`, 'm');
    expect(re.test(out), `the template must still carry a placeholder for ${name}`).toBe(true);
    out = out.replace(re, () => `const ${name} = ${JSON.stringify(value)}`);
  }
  const opener = 'const ISSUES = ';
  const at = out.indexOf(opener);
  expect(at).toBeGreaterThan(-1);
  // The array closes on a line of its own, at column 0 — the only `\n]\n` in the file.
  const close = out.indexOf('\n]\n', at);
  expect(close).toBeGreaterThan(at);
  return out.slice(0, at + opener.length) + JSON.stringify(rows, null, 2) + out.slice(close + 2);
}

// ─── the Workflow-tool contract stub ──────────────────────────────────────────

interface AgentCall {
  brief: string;
  opts: Record<string, unknown>;
}

/**
 * Run a composed driver the way the harness runs it: `export` stripped (the
 * Workflow sandbox provides the module frame), the four primitives injected,
 * the top-level `await`/`return` kept intact inside an async body.
 *
 * The `agent()` stub answers with schema-shaped payloads keyed on the stage's
 * own label, so every downstream stage receives exactly what a real dispatch
 * would hand it — the reviewerBrief reads the report it is given, the Scribe
 * briefs carry the payload byte-exact.
 */
async function runComposedDriver(script: string): Promise<{
  calls: AgentCall[];
  logs: string[];
  phases: string[];
  result: Array<Record<string, unknown>>;
}> {
  const calls: AgentCall[] = [];
  const logs: string[] = [];
  const phases: string[] = [];

  const agent = async (brief: string, opts: Record<string, unknown>) => {
    calls.push({ brief, opts });
    const label = String(opts.label ?? '');
    if (label.startsWith('worker:')) {
      return {
        outcome: 'done',
        issue: label.slice('worker:'.length),
        branch: 'wave/x',
        commitShas: ['c0ffee1'],
        filesChanged: { new: 1, modified: 0, renamed: 0 },
        tests: '10 passed',
        lint: 'clean',
        conflictMarkers: 'none',
        prUrl: 'https://example.invalid/pr/1',
        judgmentCalls: ['a call'],
        reviewerFocusItems: ['a focus item'],
      };
    }
    if (label.startsWith('review:')) {
      return {
        verdict: 'approve',
        branchReviewed: 'wave/x',
        riskClass: 'mechanical',
        workerReportDigest: 'digest',
        acVerification: [],
        reviewerFocusItems: [],
      };
    }
    return { ok: true, path: '/abs/sidecar.md' };
  };

  const pipeline = async (
    items: Array<Record<string, unknown>>,
    ...stages: Array<(a: unknown, b?: unknown) => unknown>
  ) => {
    return Promise.all(
      items.map(async (item) => {
        let acc: unknown = await stages[0](item);
        for (const stage of stages.slice(1)) acc = await stage(acc, item);
        return acc;
      }),
    );
  };

  const body = script.replace(/^export const meta =/m, 'const meta =');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    'agent',
    'pipeline',
    'phase',
    'log',
    `return (async () => {\n${body}\n})()`,
  ) as (
    a: typeof agent,
    p: typeof pipeline,
    ph: (name: string) => void,
    l: (line: string) => void,
  ) => Promise<Array<Record<string, unknown>>>;

  const result = await fn(
    agent,
    pipeline,
    (name: string) => phases.push(name),
    (line: string) => logs.push(line),
  );
  return { calls, logs, phases, result };
}

/**
 * The driver's `meta` literal, evaluated.
 *
 * `meta` must be a PURE LITERAL under the Workflow-tool contract (no variables,
 * calls, spreads or interpolation), so lifting it out of the script text and
 * evaluating it is exact rather than a parse approximation. It is also the only
 * way to see it at all from a run: the script's own `return` hands back the
 * routing tuples, never its own metadata.
 */
function metaOf(script: string): {
  name: string;
  description: string;
  phases: Array<Record<string, unknown>>;
} {
  const opener = 'export const meta = ';
  const at = script.indexOf(opener);
  expect(at).toBeGreaterThan(-1);
  // The literal closes on a `}` at column 0 — the same own-line anchoring
  // `expectedScript` above uses for the ISSUES array's `\n]\n`.
  const close = script.indexOf('\n}\n', at);
  expect(close).toBeGreaterThan(at);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`return (${script.slice(at + opener.length, close + 2)})`)();
}

// ─── 1. the substitution ──────────────────────────────────────────────────────

describe('compose-driver — the composed script is the shipped template with its constants filled', () => {
  it('differs from the template ONLY in the six constants and the ISSUES array', () => {
    const rows = [row(), row({ id: '43', slug: 'other', model: 'opus', risk: 'public-API-change' })];
    const composed = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });
    expect(composed).toBe(expectedScript(rows));
  });

  it('is deterministic — the same inputs compose byte-identically twice', () => {
    const rows = [row()];
    expect(composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows })).toBe(
      composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows }),
    );
  });

  it('fills every constant — no placeholder survives into a dispatch', () => {
    const composed = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows: [row()] });
    expect(composed).toContain(`const REPO_ROOT = ${JSON.stringify(CONSTANTS.repoRoot)}`);
    expect(composed).toContain(`const WAVE_CLI = ${JSON.stringify(CONSTANTS.waveCli)}`);
    expect(composed).toContain(`const REPORTS_DIR = ${JSON.stringify(CONSTANTS.reportsDir)}`);
    expect(composed).toContain(`const VERDICTS_DIR = ${JSON.stringify(CONSTANTS.verdictsDir)}`);
    expect(composed).toContain(`const REVIEWER_AGENT = ${JSON.stringify(CONSTANTS.reviewerAgent)}`);
    expect(composed).toContain(`const SCRIBE_MODEL = ${JSON.stringify(CONSTANTS.scribeModel)}`);
    expect(composed).not.toContain('<absolute repo root');
    expect(composed).not.toContain('<engine.cli from wave.config.json');
    expect(composed).not.toContain('<models.scribe, else models.standard');
    expect(composed).not.toContain("id: 'NN'");
  });

  it('the sixth constant composes even when this consumer declares no models block', () => {
    // `''` is the ONLY legitimately-empty constant of the six, and it still has
    // to be FILLED: the placeholder is prose, and a placeholder reaching a
    // dispatch would make the stage's own `|| issue.model` fallback unreachable.
    const composed = composeDriverScript({
      template: TEMPLATE,
      ...CONSTANTS,
      scribeModel: undefined,
      rows: [row()],
    });
    expect(composed).toContain('const SCRIBE_MODEL = ""');
    expect(composed).not.toContain('<models.scribe, else models.standard');
  });

  it('NEGATIVE CONTROL — a template missing a placeholder constant fails loud, it does not silently skip the fill', () => {
    const broken = TEMPLATE.replace(/^const WAVE_CLI = '[^']*'$/m, "const WAVE_CLI = `${cfg}`");
    expect(broken).not.toEqual(TEMPLATE);
    expect(() => composeDriverScript({ template: broken, ...CONSTANTS, rows: [row()] })).toThrow(
      /no `const WAVE_CLI = '…'` line to fill/,
    );
  });

  it('NEGATIVE CONTROL — a template missing the SCRIBE_MODEL placeholder is refused exactly like the other five', () => {
    // The sixth constant is the one whose absence would fail SILENTLY if it
    // were filled any other way: an unfilled `SCRIBE_MODEL` is still a truthy
    // string, so `SCRIBE_MODEL || issue.model` would dispatch every Scribe
    // against the placeholder PROSE rather than a model. It goes through the
    // same `fillStringConst` as the rest precisely so that cannot happen.
    const broken = TEMPLATE.replace(/^const SCRIBE_MODEL = '[^']*'$/m, 'const SCRIBE_MODEL = ""');
    expect(broken).not.toEqual(TEMPLATE);
    expect(() => composeDriverScript({ template: broken, ...CONSTANTS, rows: [row()] })).toThrow(
      /no `const SCRIBE_MODEL = '…'` line to fill/,
    );
  });

  it('NEGATIVE CONTROL — a template with no ISSUES array fails loud', () => {
    const broken = TEMPLATE.replace('const ISSUES = [', 'const ROWS = [');
    expect(broken).not.toEqual(TEMPLATE);
    expect(() => composeDriverScript({ template: broken, ...CONSTANTS, rows: [row()] })).toThrow(
      /no `const ISSUES = \[ … \]` array to fill/,
    );
  });
});

// ─── 1b. THE PARSE GATE ───────────────────────────────────────────────────────

/**
 * The harness's frame, as source text — the same two halves the composer's own
 * parse gate wraps a script in, re-spelled here rather than imported.
 *
 * Re-spelled deliberately, on this file's standing rule (layer 1 above): a gate
 * that called the module's own helper would compare the implementation with
 * itself. These are the frame `runComposedDriver` above builds by hand for
 * `new Function` — `export` stripped, the body inside an async arrow taking the
 * four Workflow primitives — written out as one string so it can be COMPILED
 * instead of constructed, which is what makes the failure carry a position.
 */
const HARNESS_FRAME_HEAD = '(function (agent, pipeline, phase, log) {\nreturn (async () => {\n';
const HARNESS_FRAME_TAIL = '\n})()\n})';
const HARNESS_FRAME_HEAD_LINES = HARNESS_FRAME_HEAD.split('\n').length - 1;

/**
 * Parse a driver script in the harness's frame, and NEVER run it: `new Script`
 * compiles its source and stops — no context, no `runInContext`, not one
 * statement of the driver executed. `lineOffset` cancels the frame's own lines
 * so a reported position is a line of the SCRIPT.
 */
function parseInHarnessFrame(script: string, filename: string): void {
  const body = script.replace(/^export const meta =/m, 'const meta =');
  new Script(HARNESS_FRAME_HEAD + body + HARNESS_FRAME_TAIL, {
    filename,
    lineOffset: -HARNESS_FRAME_HEAD_LINES,
  });
}

/**
 * The plant, in one place because two different gates use the identical one:
 * an unbalanced backtick opened on its own line just above a constant the
 * template is guaranteed to carry. Opening a template literal and never closing
 * it is the failure #819 claimed could ship green, so it is the failure both
 * negative controls plant.
 *
 * Never written over the shipped asset — it returns a COPY, and the one spec
 * that needs it on disk writes the copy to its own temp directory.
 */
function withUnbalancedBacktick(template: string): string {
  const lines = template.split('\n');
  const at = lines.findIndex((l) => l.startsWith('const REVIEWER_AGENT'));
  expect(at, 'the template must still carry the constant this plant anchors to').toBeGreaterThan(-1);
  return [
    ...lines.slice(0, at),
    'const PLANTED_UNBALANCED_BACKTICK = `this template literal is never closed',
    ...lines.slice(at),
  ].join('\n');
}

describe('compose-driver — THE PARSE GATE: the shipped driver template parses in the form the harness evaluates it', () => {
  it('THE PARSE GATE — the SHIPPED template compiles in the harness frame (compiled, never run)', () => {
    // The subject is `DRIVER_TEMPLATE_PATH`'s own bytes, not a composed copy:
    // this asks whether the ASSET is evaluable, which is a question about the
    // file a consumer installs, before any row is anywhere near it.
    expect(() => parseInHarnessFrame(TEMPLATE, DRIVER_TEMPLATE_PATH)).not.toThrow();
  });

  it('the FRAME is load-bearing — the same bytes compiled WITHOUT it are not valid script source at all', () => {
    // Without this, "the template parses" would be a claim about a form nothing
    // runs: `export` is a module-only declaration and the driver's top-level
    // `return`/`await` need a function body. A gate that compiled the file
    // as-written would be red on a perfectly good template.
    expect(() => new Script(TEMPLATE, { filename: DRIVER_TEMPLATE_PATH })).toThrow(SyntaxError);
  });

  it('NEGATIVE CONTROL — an unbalanced backtick planted in a COPY throws a SyntaxError naming a line', () => {
    const planted = withUnbalancedBacktick(TEMPLATE);
    expect(planted).not.toEqual(TEMPLATE);

    let thrown: unknown;
    try {
      parseInHarnessFrame(planted, DRIVER_TEMPLATE_PATH);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'the gate must reject a template carrying an unbalanced backtick').toBeDefined();
    expect((thrown as Error).name).toBe('SyntaxError');

    // "Naming a line" is the half that distinguishes this gate from the opaque
    // `SyntaxError` a behaviour test surfaces. `node:vm` decorates the stack
    // with `<filename>:<line>` on its FIRST line — the file an operator opens,
    // and the line V8 could not get past.
    const firstStackLine = String((thrown as Error).stack ?? '').split('\n')[0];
    expect(firstStackLine.startsWith(DRIVER_TEMPLATE_PATH)).toBe(true);
    const position = /:(\d+)$/.exec(firstStackLine);
    expect(position, `no line in: ${firstStackLine}`).not.toBeNull();
    // A line of the SCRIPT, not of the wrapper — which is what `lineOffset`
    // buys, and the reason it is counted off the frame rather than written out.
    const line = Number((position as RegExpExecArray)[1]);
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThanOrEqual(planted.split('\n').length);
  });
});

// ─── 2. the composed script under the Workflow-tool contract ──────────────────

describe('compose-driver — a composed driver runs under the Workflow-tool contract', () => {
  const rows = [
    row({ id: '42', slug: 'first', model: 'opus', risk: 'public-API-change' }),
    row({
      id: '43',
      slug: 'second',
      model: 'sonnet',
      prTitle: 'chore: the second thing',
      closePhrase: 'Closes #43',
      siblingBranches: 'wave/42-first',
    }),
  ];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  it('fans out FOUR stages per row, in the documented order', async () => {
    const { calls } = await runComposedDriver(script);
    const labels = calls.map((c) => String(c.opts.label));
    for (const id of ['42', '43']) {
      const own = labels.filter((l) => l.endsWith(`:${id}`));
      expect(own).toEqual([`worker:${id}`, `scribe-report:${id}`, `review:${id}`, `scribe-verdict:${id}`]);
    }
    expect(calls).toHaveLength(8);
  });

  it('returns the routing tuple the Coordinator routes', async () => {
    const { result } = await runComposedDriver(script);
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0])).toEqual(['id', 'risk', 'iteration', 'report', 'verdict']);
    expect(result[0].id).toBe('42');
    expect(result[0].risk).toBe('public-API-change');
  });

  it('the Worker stage is worktree-isolated and carries the row model; the Reviewer stage carries the DERIVED agent name and no isolation key', async () => {
    const { calls } = await runComposedDriver(script);
    const worker = calls.find((c) => c.opts.label === 'worker:42')!;
    expect(worker.opts.isolation).toBe('worktree');
    expect(worker.opts.model).toBe('opus');

    const reviewer = calls.find((c) => c.opts.label === 'review:42')!;
    expect(reviewer.opts.agentType).toBe(CONSTANTS.reviewerAgent);
    expect(reviewer.opts.model).toBe('opus');
    expect(reviewer.opts).not.toHaveProperty('isolation');
  });

  it('the Worker brief interpolates the row — branch, anchor, deps setup, close phrase, spec — and renders no literal "undefined"', async () => {
    const { calls } = await runComposedDriver(script);
    const brief = calls.find((c) => c.opts.label === 'worker:42')!.brief;
    expect(brief).toContain(branchFor('42', 'first'));
    expect(brief).toContain('deadbeefcafe');
    expect(brief).toContain('npm ci --prefix tools/wave');
    expect(brief).toContain('Closes #42');
    expect(brief).toContain('Do the thing.');
    expect(brief).toContain(CONSTANTS.waveCli);
    expect(brief).not.toContain('undefined');
    // The anchor is per ROUND, never per wave (glossary Anchor, Avoid: "wave
    // anchor" — issue #981), and the Worker brief now agrees with the
    // Reviewer brief's own such pin below.
    expect(brief).not.toMatch(/wave[ -]anchor/i);
  });

  it('the Reviewer brief carries the anchor, the named ref, the sibling denominator and the Worker digest', async () => {
    const { calls } = await runComposedDriver(script);
    const brief = calls.find((c) => c.opts.label === 'review:43')!.brief;
    expect(brief).toContain('refs/review/43');
    expect(brief).toContain('deadbeefcafe');
    expect(brief).toContain('wave/42-first'); // the sibling denominator
    expect(brief).toContain('c0ffee1'); // the Worker-reported commit
    expect(brief).not.toContain('undefined');
  });

  it("the Scribe brief carries the payload byte-exact and the absolute, shell-quoted paths", async () => {
    const { calls } = await runComposedDriver(script);
    const brief = calls.find((c) => c.opts.label === 'scribe-report:42')!.brief;
    expect(brief).toContain(`\`${CONSTANTS.repoRoot}\``);
    // ADR-0051 decisions 5 and 6: the Scribe call spells the payload file and
    // the sidecar directory with this verb's CANONICAL flags — never `--dir`,
    // never the leading positional, both of which the engine still accepts as
    // silent aliases. `shipped-invocation-guard.spec.ts` holds the same line
    // against the aggregated Verb contracts; this one pins the COMPOSED text.
    expect(brief).toContain(
      `write-report --report-file "${CONSTANTS.repoRoot}/.flotilla/tmp/report-42-1.json" --reports-dir "${CONSTANTS.reportsDir}" --id 42 --iter 1`,
    );
    expect(brief).toContain('"outcome":"done"');
  });

  it('the two agent-boundary schemas reach `agent({ schema })` free of a top-level combinator', async () => {
    const { calls } = await runComposedDriver(script);
    for (const label of ['worker:42', 'review:42']) {
      const schema = calls.find((c) => c.opts.label === label)!.opts.schema as Record<string, unknown>;
      expect(schema).toBeDefined();
      for (const key of ['anyOf', 'oneOf', 'allOf']) expect(schema).not.toHaveProperty(key);
    }
  });

  it('meta.phases agrees with the phase groups the script actually enters — both directions — and no phase claims a model', async () => {
    // The authoring contract: titles are matched EXACTLY, so a declared entry
    // nothing enters is a group box that never fills, and an entered group with
    // no entry silently mints its own. Both directions are asserted because
    // only one of them was ever wrong: `Review` is declared and entered ONLY
    // through `opts.phase` on the Stage-3 agent (a global `phase('Review')`
    // would race inside `pipeline()`), which reads as "declared but never
    // entered" to anyone grepping for `phase(` alone.
    const { calls, phases } = await runComposedDriver(script);
    const declared = metaOf(script).phases;
    const entered = new Set<string>([
      ...phases,
      ...calls.map((c) => c.opts.phase).filter((p): p is string => typeof p === 'string'),
    ]);

    expect([...entered].sort()).toEqual(['Dispatch', 'Review']);
    expect(new Set(declared.map((p) => p.title))).toEqual(entered);
    // `Review` really is entered per-call, not by the global cursor.
    expect(phases).not.toContain('Review');
    expect(calls.filter((c) => c.opts.phase === 'Review').map((c) => c.opts.label)).toEqual([
      'review:42',
      'review:43',
    ]);

    // The model tier is per ROW (Risk-derived, ADR-0007 Amendment 2026-07-31),
    // so no phase can state one: a `model` here would be a constant that does
    // not exist, contradicting the per-call binding the stages actually use.
    for (const p of declared) expect(p).not.toHaveProperty('model');
  });

  it('a human-gated row that reached ISSUES anyway is refused by the script itself, before any agent() call', async () => {
    const gated = composeDriverScript({
      template: TEMPLATE,
      ...CONSTANTS,
      rows: [row({ worker: HUMAN_GATED_WORKER })],
    });
    await expect(runComposedDriver(gated)).rejects.toThrow(/human-gated/);
  });
});

// ─── 3. the Reviewer agent name ───────────────────────────────────────────────

describe('compose-driver — the Reviewer agent name is derived per distribution form (issue #677)', () => {
  it('the SOURCE form yields the bare agent-definition name', () => {
    const r = resolveReviewerAgent({
      engineCli: SOURCE_FORM_CLI,
      manifestPath: MANIFEST_PATH,
      readFileOrNull: fakeClone(),
    });
    expect(r.form).toBe('source');
    expect(r.name).toBe('wave-reviewer');
    expect(r.agentName).toBe('wave-reviewer');
    expect(r.pluginName).toBe('flotilla');
  });

  it('the INSTALLED form yields the plugin-namespaced name', () => {
    const r = resolveReviewerAgent({
      engineCli: INSTALLED_FORM_CLI,
      manifestPath: MANIFEST_PATH,
      readFileOrNull: fakeClone(),
    });
    expect(r.form).toBe('installed');
    expect(r.name).toBe('flotilla:wave-reviewer');
  });

  it('both halves are READ, never spelled — a renamed plugin and a renamed agent both show through', () => {
    const renamed = (path: string) => {
      if (path.endsWith(join('.claude-plugin', 'plugin.json'))) {
        return JSON.stringify({ name: 'armada', agents: ['./.claude/agents/reviewer.md'] });
      }
      if (path.endsWith(join('.claude', 'agents', 'reviewer.md'))) {
        return '---\nname: armada-wave-reviewer\n---\n';
      }
      return null;
    };
    const r = resolveReviewerAgent({
      engineCli: INSTALLED_FORM_CLI,
      manifestPath: MANIFEST_PATH,
      readFileOrNull: renamed,
    });
    expect(r.name).toBe('armada:armada-wave-reviewer');
  });

  it('--reviewer-agent overrides both, and needs no manifest at all', () => {
    const r = resolveReviewerAgent({
      override: 'someones:reviewer',
      engineCli: INSTALLED_FORM_CLI,
      manifestPath: null,
      readFileOrNull: () => null,
    });
    expect(r.form).toBe('override');
    expect(r.name).toBe('someones:reviewer');
  });

  it('NEGATIVE CONTROL — no manifest and no override is a loud refusal naming both flags, never a guessed spelling', () => {
    expect(() =>
      resolveReviewerAgent({
        engineCli: INSTALLED_FORM_CLI,
        manifestPath: null,
        readFileOrNull: () => null,
      }),
    ).toThrow(/--plugin-manifest[\s\S]*--reviewer-agent/);
  });

  it('NEGATIVE CONTROL — a manifest with no readable agent definition refuses rather than defaulting', () => {
    expect(() =>
      resolveReviewerAgent({
        engineCli: SOURCE_FORM_CLI,
        manifestPath: MANIFEST_PATH,
        readFileOrNull: (p) =>
          p.endsWith(join('.claude-plugin', 'plugin.json')) ? PLUGIN_MANIFEST : null,
      }),
    ).toThrow(/names no readable agent definition/);
  });

  it('agentDefinitionName reads the frontmatter, and answers null when there is none', () => {
    expect(agentDefinitionName(AGENT_DEFINITION)).toBe('wave-reviewer');
    expect(agentDefinitionName("---\nname: 'quoted-name'\n---\n")).toBe('quoted-name');
    expect(agentDefinitionName('no frontmatter here')).toBeNull();
    expect(agentDefinitionName('---\nmodel: sonnet\n---\n')).toBeNull();
  });

  it('reads flotilla’s OWN manifest + agent definition off disk, both forms', () => {
    const realManifest = join(__dirname, '../../../.claude-plugin/plugin.json');
    const read = (p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    };
    expect(
      resolveReviewerAgent({ engineCli: SOURCE_FORM_CLI, manifestPath: realManifest, readFileOrNull: read }).name,
    ).toBe('wave-reviewer');
    expect(
      resolveReviewerAgent({ engineCli: INSTALLED_FORM_CLI, manifestPath: realManifest, readFileOrNull: read }).name,
    ).toBe('flotilla:wave-reviewer');
  });
});

// ─── 4. the compose-time assertions ───────────────────────────────────────────

describe('compose-driver — the required-row-fields assertion now runs in the engine', () => {
  const VALID: Record<string, unknown> = {
    id: '42',
    slug: 'demo-slug',
    branch: 'wave/42-demo-slug',
    risk: 'mechanical',
    model: 'sonnet',
    anchorSha: 'deadbeefcafe',
    coordinatorBranch: 'main',
    issueSpec: 'Do the thing.',
    prTitle: 'fix: do the thing',
    closePhrase: 'Closes #42',
    siblingBranches: '(none)',
  };

  it('the field set is exactly what a valid row carries', () => {
    expect(new Set(REQUIRED_ROW_FIELDS)).toEqual(new Set(Object.keys(VALID)));
  });

  it('a fully-populated row passes', () => {
    expect(() => assertRequiredRowFields({ ...VALID })).not.toThrow();
  });

  it.each(Object.keys(VALID))('an ABSENT %s throws, naming the row and the field', (field) => {
    const r = { ...VALID };
    delete r[field];
    expect(() => assertRequiredRowFields(r)).toThrow(new RegExp(field));
    if (field !== 'id') expect(() => assertRequiredRowFields(r)).toThrow(/42/);
  });

  it.each(Object.keys(VALID))('the literal string "undefined" for %s throws', (field) => {
    expect(() => assertRequiredRowFields({ ...VALID, [field]: 'undefined' })).toThrow(
      new RegExp(field),
    );
  });

  it.each(Object.keys(VALID))('an empty/whitespace-only %s throws', (field) => {
    expect(() => assertRequiredRowFields({ ...VALID, [field]: '   ' })).toThrow(new RegExp(field));
  });

  it('isMissingField rejects exactly the three shapes a template can silently render', () => {
    expect(isMissingField(undefined)).toBe(true);
    expect(isMissingField(null)).toBe(true);
    expect(isMissingField('undefined')).toBe(true);
    expect(isMissingField('   ')).toBe(true);
    expect(isMissingField('x')).toBe(false);
    expect(isMissingField(0)).toBe(false);
  });
});

describe('compose-driver — the worker gate refuses what no background agent may pick up', () => {
  it('refuses a human-gated row, naming the row and the remedy', () => {
    expect(() => assertDispatchableWorker({ id: '11', worker: HUMAN_GATED_WORKER })).toThrow(/11/);
    expect(() => assertDispatchableWorker({ id: '11', worker: HUMAN_GATED_WORKER })).toThrow(
      /human lane/,
    );
  });

  it('refuses a foreground row for its OWN reason — a different remedy, so a different message', () => {
    expect(() => assertDispatchableWorker({ id: '12', worker: 'foreground' })).toThrow(/in chat/);
  });

  it('passes the two background tiers', () => {
    expect(() => assertDispatchableWorker({ id: '13', worker: 'background' })).not.toThrow();
    expect(() => assertDispatchableWorker({ id: '14', worker: 'background-heavy' })).not.toThrow();
  });

  it('the match is EXACT — a worker that merely CONTAINS the token is not gated', () => {
    expect(() =>
      assertDispatchableWorker({ id: '15', worker: `not-${HUMAN_GATED_WORKER}` }),
    ).not.toThrow();
  });

  it('honours a consumer that re-spelled its own vocabulary', () => {
    expect(() => assertDispatchableWorker({ id: '16', worker: 'needs-a-human' }, ['needs-a-human'])).toThrow(
      /human lane/,
    );
  });
});

// ─── 5. the small derivations ─────────────────────────────────────────────────

describe('compose-driver — the derivations', () => {
  it('branchFor matches the spine set-branch formula', () => {
    expect(branchFor('680', 'compose-driver-verb')).toBe('wave/680-compose-driver-verb');
  });

  // Updated by the ADR-0012 Amendment 2026-09-16 row: this helper used to return
  // the two brand literals and now returns the ABSTRACT tier marker — and
  // renamed to say so by the 2026-09-21 row that owns the barrel-drift
  // allowlist which had pinned the old spelling. The
  // full-coverage pin over all four default Risk values, plus the "no engine
  // code maps a marker to an id" half, lives in its own appended describe block
  // at the end of this file.
  it('tierForRisk binds the heavy tier marker to the two heavy Risk classes only', () => {
    expect(tierForRisk('public-API-change')).toBe('heavy');
    expect(tierForRisk('cross-feature-refactor')).toBe('heavy');
    expect(tierForRisk('mechanical')).toBe('standard');
    expect(tierForRisk('isolated-refactor')).toBe('standard');
  });

  it('closePhraseFor follows the store kind (Convention 4)', () => {
    expect(closePhraseFor('github', '680')).toBe('Closes #680');
    expect(closePhraseFor('linear', 'FOR-379')).toBe('Fixes FOR-379');
    expect(closePhraseFor('markdown', '07')).toBe('Closes #07');
  });

  /**
   * The guard the phrase has to survive, as this spec's own second reading of
   * it — a phrase the close-phrase guard cannot SEE is a phrase that makes a
   * legitimate PR-body rewrite come back `reuse-refused`. Deliberately re-typed
   * from the shape rule rather than imported: `route-tuple`'s own regex is
   * module-local, and a spec that imported the implementation would be checking
   * the phrase against itself.
   */
  const GUARD_SEES = (line: string): boolean =>
    /^(?:Closes|Fixes|Resolves) (?:#\d+|[A-Z][A-Z0-9]{0,9}-\d+|https?:\/\/\S+\/issues\/\d+)$/.test(line);

  it('closePhraseFor on the markdown store composes a phrase the close-phrase guard can SEE', () => {
    // The markdown id is `<slug>#NN`; the whole string after a `#` used to
    // compose `Closes #<slug>#01`, which no host resolves and the guard reads
    // as no close phrase at all.
    expect(closePhraseFor('markdown', '2026-09-04-honest-absences#01')).toBe('Closes #01');
    expect(GUARD_SEES(closePhraseFor('markdown', '2026-09-04-honest-absences#01'))).toBe(true);
    expect(GUARD_SEES('Closes #2026-09-04-honest-absences#01')).toBe(false); // what it used to compose
    // Zero-padding is carried verbatim — the pad is part of the minted id.
    expect(closePhraseFor('markdown', 'w#7')).toBe('Closes #7');
    expect(GUARD_SEES(closePhraseFor('markdown', '07'))).toBe(true); // the bare-NN form, unchanged
  });

  it('the tail lift is NARROW — a non-numeric tail and a plain id are untouched', () => {
    // Neither of these is a wave row a PR ever closes (a PRD document, a goal
    // container), so the phrase is left byte-for-byte rather than reshaped into
    // something that reads like a row reference.
    expect(closePhraseFor('markdown', 'a-slug#prd')).toBe('Closes #a-slug#prd');
    expect(closePhraseFor('markdown', 'a-slug#goal-01')).toBe('Closes #a-slug#goal-01');
    // A GitHub id carries no `#` at all and must survive the rule untouched.
    expect(closePhraseFor('github', '680')).toBe('Closes #680');
    // And `linear` never reaches the lift — the #700 negative control's premise.
    expect(closePhraseFor('linear', 'a-slug#01')).toBe('Fixes a-slug#01');
    expect(closePhraseFor('linear', '1')).toBe('Fixes 1');
    expect(GUARD_SEES(closePhraseFor('linear', '1'))).toBe(false);
  });

  it('stripBareIds removes the mention-discipline shapes and leaves ADR numbers alone', () => {
    expect(stripBareIds('#680 — ship the verb', '680')).toBe('ship the verb');
    expect(stripBareIds('680: ship the verb', '680')).toBe('ship the verb');
    expect(stripBareIds('honour ADR-0041 in the grant', 'FOR-1')).toBe('honour ADR-0041 in the grant');
    expect(stripBareIds('ship the verb', '680')).toBe('ship the verb');
  });

  it("stripBareIds takes an ATTACHED possessive with the id — no dangling `'s` survives", () => {
    // The fixture is the LIVE title of the row that exposed this: the composed
    // PR title was rendered from it, the Worker ran the rendered line verbatim
    // (its policy says to), and the PR opened reading
    // `(ADR-0051 decision 7, 's settled shape)` until it was renamed by hand at
    // landing. The expectation below is the whole possessive PHRASE minus its
    // possessive — the bare noun the sentence meant before the id was in it.
    const LIVE_TITLE =
      'The nine silent issue-store write ops answer `--json` with a receipt of ' +
      "what the engine sent — never a read-back (ADR-0051 decision 7, #648's settled shape)";
    expect(stripBareIds(LIVE_TITLE, '822')).toBe(
      'The nine silent issue-store write ops answer `--json` with a receipt of ' +
        'what the engine sent — never a read-back (ADR-0051 decision 7, settled shape)',
    );
    // No fragment of the possessive survives ANYWHERE in the result — the
    // assertion above already fails on one, but this states the property the row
    // was filed for rather than leaving it implied by one long string compare.
    expect(stripBareIds(LIVE_TITLE, '822')).not.toContain("'s");

    // The typographic apostrophe is the same token in the spelling a tracker's
    // own editor produces, and the LITERAL-id branch takes its possessive too —
    // neither is a `#<digits>` token, so each is its own path through the strip.
    expect(stripBareIds('carry #648’s settled shape', '822')).toBe('carry settled shape');
    expect(stripBareIds("honour 822's own scope line", '822')).toBe('honour own scope line');

    // DETACHED, and therefore none of the strip's business: an `'s` that is not
    // an id's inflection is prose, and a title-mangling default is worse than a
    // title the Coordinator overrides (this function's own narrowness rule).
    expect(stripBareIds("the row's own title", '822')).toBe("the row's own title");
  });

  it('stripBareIds consumes the separator between two adjacent stripped ids — slash-, comma- and `and`-joined (issue #888)', () => {
    // The live shape: row 800's tracker title, whose composed PR title on PR
    // #886 read "Residue after /: the STILL OPEN sentence …" — both ids
    // stripped, the bare slash left standing. The fix consumes the join AND
    // its separator as one unit, leaving only the sentence's own punctuation.
    const LIVE_SLASH_TITLE =
      'Residue after #751/#772: the STILL OPEN sentence stays only in the residual issue, ' +
      'never the wave row itself';
    expect(stripBareIds(LIVE_SLASH_TITLE, '800')).toBe(
      'Residue after : the STILL OPEN sentence stays only in the residual issue, ' +
        'never the wave row itself',
    );
    expect(stripBareIds(LIVE_SLASH_TITLE, '800')).not.toContain('/');

    // Comma-joined, two and three deep.
    expect(stripBareIds('Fixes #100, #200: cleanup', '800')).toBe('Fixes : cleanup');
    expect(stripBareIds('Fixes #100, #200, #300: cleanup', '800')).toBe('Fixes : cleanup');
    expect(stripBareIds('Fixes #100, #200: cleanup', '800')).not.toContain(',');

    // `and`-joined.
    expect(stripBareIds('Ship #100 and #200 together', '800')).toBe('Ship together');
    expect(stripBareIds('Ship #100 and #200 together', '800')).not.toMatch(/\band\b/);

    // A single id, or two ids that are NOT adjacent, never enters this pass —
    // the existing single-id branches still do the whole job, unchanged.
    expect(stripBareIds('#680 — ship the verb', '680')).toBe('ship the verb');
    expect(stripBareIds('Ship #100 now, revisit #200 later', '800')).toBe(
      'Ship now, revisit later',
    );
  });

  it("stripBareIds leaves a stray separator standing when the join is not one of the three recognised shapes — the case the compose-time notice below exists for", () => {
    // A doubled slash: the join pass requires exactly ONE separator between two
    // id tokens, so it does not recognise this as a join and falls through to
    // the single-id branches, which strip each `#<digits>` but know nothing
    // about the punctuation between them.
    expect(stripBareIds('Residue after #100 // #200: note', '800')).toBe(
      'Residue after // : note',
    );
    // A lone id directly followed by a separator and non-id text: the same
    // fallthrough, this time leaving a LEADING separator.
    expect(stripBareIds('#100/text needing its own fix', '800')).toBe('/text needing its own fix');
  });

  it('depsSetupFrom picks the first install command, and answers empty when there is none', () => {
    expect(
      depsSetupFrom([{ command: 'npm ci --prefix tools/wave' }, { command: 'vitest run' }]),
    ).toBe('npm ci --prefix tools/wave');
    expect(depsSetupFrom([{ command: 'composer install -d cms' }])).toBe('composer install -d cms');
    expect(depsSetupFrom([{ command: 'vitest run' }])).toBe('');
  });

  it('slugFromSpinePath reads the wave slug off the spine file name', () => {
    expect(slugFromSpinePath('/a/b/.flotilla/waves/2026-09-03-x.md')).toBe('2026-09-03-x');
  });

  it('composeIssueSpec embeds the title, id, risk, worker, globs, body and verify gate', () => {
    const spec = composeIssueSpec({
      id: '680',
      title: 'Ship the verb',
      body: 'Body text.\n\n## Acceptance criteria\n\n- [ ] it ships',
      risk: 'public-API-change',
      worker: 'background-heavy',
      files: ['tools/wave/**'],
      verify: [{ command: 'npm ci --prefix tools/wave' }, { command: 'vitest run', cwd: 'tools/wave' }],
      note: 'Read the template first.',
    });
    expect(spec).toContain('# Ship the verb');
    expect(spec).toContain('Issue id (bare): 680');
    expect(spec).toContain('Risk: public-API-change');
    expect(spec).toContain('Worker: background-heavy');
    expect(spec).toContain('- tools/wave/**');
    expect(spec).toContain('- [ ] it ships');
    expect(spec).toContain('## Notes from the Coordinator');
    expect(spec).toContain('Read the template first.');
    expect(spec).toContain('`npm ci --prefix tools/wave`');
    expect(spec).toContain('cwd `tools/wave`');
  });
});

// ── a verify command's declared needs travel in the spec (ADR-0049) ──────────
//
// `needs` is the config half of "a dispatched agent never escalates": the gate
// declares what it must reach, and the brief carries that declaration as DATA
// beside the command — the way an ADR-0041 scope grant travels rather than being
// re-derived at the far end. Both roles read the SAME embedded spec, which is
// what puts it in front of the Reviewer too; the Reviewer re-runs these exact
// commands and meets the identical wall.

describe('composeIssueSpec — declared verify needs ride beside the command (ADR-0049)', () => {
  const BASE = {
    id: '709',
    title: 'Ship the capability requirement',
    body: 'Body text.\n\n## Acceptance criteria\n\n- [ ] it ships',
    risk: 'public-API-change',
    worker: 'background-heavy',
    files: ['tools/wave/**'],
  } as const;

  /** The verify-gate tail of a composed spec — everything from its own heading on. */
  function verifySection(spec: string): string {
    const at = spec.indexOf('## Verify gate');
    expect(at).toBeGreaterThan(-1);
    return spec.slice(at);
  }

  it('renders each declared need as data, keyed by class', () => {
    const spec = composeIssueSpec({
      ...BASE,
      verify: [
        { command: 'npm ci --prefix tools/wave' },
        {
          command: 'xcodebuild test -scheme App',
          needs: {
            writes: ['~/Library/Developer/Xcode/DerivedData'],
            network: ['developer.apple.com'],
            host: true,
          },
        },
      ],
    });
    const section = verifySection(spec);
    // The undeclared command keeps its plain bullet — the declaration is per
    // command, never a banner over the whole gate.
    expect(section).toContain('- `npm ci --prefix tools/wave`\n');
    expect(section).toContain('declared needs —');
    expect(section).toContain('writes outside the worktree: `~/Library/Developer/Xcode/DerivedData`');
    expect(section).toContain('network hosts: `developer.apple.com`');
    expect(section).toContain('host: a capability that cannot be narrowed');
  });

  it('renders only the classes actually declared, and keeps the cwd note beside them', () => {
    const spec = composeIssueSpec({
      ...BASE,
      verify: [{ command: 'vendor/bin/phpunit', cwd: 'cms', needs: { network: ['packagist.org'] } }],
    });
    const section = verifySection(spec);
    expect(section).toContain('cwd `cms`');
    expect(section).toContain('network hosts: `packagist.org`');
    expect(section).not.toContain('writes outside the worktree');
    expect(section).not.toContain('host: a capability');
  });

  it('states the rule beside the data — a declaration is not a grant', () => {
    const spec = composeIssueSpec({ ...BASE, verify: [{ command: 'docker compose up', needs: { host: true } }] });
    const section = verifySection(spec);
    expect(section).toMatch(/A declaration is not a grant/);
    expect(section).toMatch(/never re-run it with the\s+sandbox off/);
    expect(section).toMatch(/never drop it silently/);
    expect(section).toContain('ADR-0049');
  });

  // NEGATIVE CONTROL (wave-shared Convention 11), and the one this row's AC
  // names explicitly: a config that declares NO needs anywhere must compose
  // BYTE-IDENTICALLY to how it composed before the field existed. The expected
  // string is written out in full rather than derived from the implementation —
  // a spec that rebuilt its expectation with `renderVerifyCommand` would compare
  // the code with itself and pass however the rendering drifted.
  it('NEGATIVE CONTROL: a needs-free config composes byte-identically to today', () => {
    const verify: VerifyCommand[] = [
      { command: 'npm ci --prefix tools/wave' },
      { command: 'vitest run --root tools/wave', cwd: 'tools/wave' },
    ];
    const spec = composeIssueSpec({ ...BASE, verify });

    expect(verifySection(spec)).toBe(
      [
        "## Verify gate (from this consumer's wave.config.json verify — run ALL of them, " +
          'regardless of which files you touched. Carry the directory IN each command, never `cd` first.)',
        '- `npm ci --prefix tools/wave`',
        '- `vitest run --root tools/wave`  (the profile declares cwd `tools/wave` — carry it IN the command, never `cd` first)',
      ].join('\n'),
    );
    // Nothing from the new rendering leaked in — not the data, not the rule.
    expect(spec).not.toContain('declared needs');
    expect(spec).not.toContain('ADR-0049');

    // POSITIVE CONTROL beside it, so "byte-identical" above is not the trivial
    // result of a renderer that never renders: the SAME two commands, with one
    // need added, compose to something strictly longer that still starts the
    // same way.
    const declared = composeIssueSpec({
      ...BASE,
      verify: [verify[0], { ...verify[1], needs: { host: true } }],
    });
    expect(declared).not.toBe(spec);
    expect(declared.length).toBeGreaterThan(spec.length);
    expect(declared).toContain('declared needs');
  });
});

// ── the composed brief never manufactures a confirmation (issue #717) ────────
//
// The wording this replaces asserted a CONSUMER ANSWER the composer never had:
// "consumer confirmed at wave-setup: nothing gitignored here — no install step
// needed". Two Workers of one consumer's two-row wave each read it, each found
// it false — that consumer's `engine.cli` resolves through a gitignored
// `node_modules/` — and each had to run `npm ci` itself before a single engine
// verb would resolve. An empty `depsSetup` means NO SOURCE ANSWERED, which is a
// deferral; only a measurement of the repo could support the confirmation, and
// the composer now makes that measurement itself (the refusal block below).
//
// THREE sites render the fallback — the iteration-1 Worker setup, the
// re-dispatch Worker setup, and the Reviewer's own setup — so all three are
// driven here, from ONE composed script carrying one row of each iteration.

describe('compose-driver — an absent install step reads as a deferral, never a confirmation (issue #717)', () => {
  const CONFIRMATION = 'consumer confirmed at wave-setup: nothing gitignored here';
  const DEFERRAL = 'no install step was recorded for this consumer';

  /** One iteration-1 row and one re-dispatch row, neither carrying an install step. */
  const rows = [
    row({ id: '42', slug: 'first', depsSetup: '' }),
    row({ id: '43', slug: 'second', iteration: 2, depsSetup: '', siblingBranches: 'wave/42-first' }),
  ];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  it('renders the deferral at ALL THREE fallback sites, and the old confirmation at none of them', async () => {
    const { calls } = await runComposedDriver(script);
    const briefFor = (label: string) => calls.find((c) => String(c.opts.label) === label)?.brief ?? '';

    // site 1: the iteration-1 Worker workspace setup
    const iter1 = briefFor('worker:42');
    // site 2: the re-dispatch Worker workspace setup
    const redispatch = briefFor('worker:43');
    // site 3: the Reviewer's own workspace setup — its worktree is just as bare
    const reviewer = briefFor('review:42');

    // Guard the fixture before the claim: these really are the two DIFFERENT
    // workspace-setup blocks, not the same one twice — which is what makes
    // "all three sites" a checked statement rather than a label-shaped hope.
    expect(redispatch).toContain('## Workspace setup (do first) — RE-DISPATCH');
    expect(iter1).not.toContain('RE-DISPATCH');

    for (const brief of [iter1, redispatch, reviewer]) {
      expect(brief).not.toBe('');
      expect(brief).not.toContain(CONFIRMATION);
      expect(brief).toContain(DEFERRAL);
      expect(brief).toContain('before the first engine call');
    }
  });

  // POSITIVE CONTROL beside it (wave-shared Convention 11): a row that DOES
  // carry an install step renders the command at all three sites and no
  // deferral at any of them — so "the deferral is everywhere" above is not the
  // trivial result of a fallback that always fires.
  it('POSITIVE CONTROL — a row WITH an install step renders the command, not the deferral', async () => {
    const withStep = composeDriverScript({
      template: TEMPLATE,
      ...CONSTANTS,
      rows: [
        row({ id: '42', slug: 'first', depsSetup: 'npm ci --prefix tools/wave' }),
        row({ id: '43', slug: 'second', iteration: 2, depsSetup: 'npm ci --prefix tools/wave' }),
      ],
    });
    const { calls } = await runComposedDriver(withStep);
    for (const label of ['worker:42', 'worker:43', 'review:42']) {
      const brief = calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
      expect(brief).toContain('npm ci --prefix tools/wave');
      expect(brief).not.toContain(DEFERRAL);
      expect(brief).not.toContain(CONFIRMATION);
    }
  });

  it('the retired wording is gone from the shipped template itself, not merely unrendered', () => {
    expect(TEMPLATE).not.toContain(CONFIRMATION);
  });
});

// ── the install line's own rule rides with it (issue #725) ───────────────────
//
// `npm ci --prefix <dir>` exits EUSAGE with `Missing: <basename>@<version> from
// lock file` — naming a package that does not exist — whenever the prefix path
// resolves THROUGH A SYMLINK. Reproduced deliberately in this row's dispatch:
// the SAME directory, reached as `/tmp/claude-501/…/tools/wave` (the macOS
// `/tmp` -> `/private/tmp` symlink) fails, and reached as
// `/private/tmp/claude-501/…/tools/wave` succeeds. The mechanism is npm's own
// `normalize(path) === realpath(path)` branch in `@npmcli/arborist`
// load-actual.js: when they differ the ideal tree's root is built as a LINK at
// a `../../..`-shaped location the lockfile has no entry for, and the name it
// is reported under comes from `@npmcli/name-from-folder` — the prefix
// DIRECTORY'S BASENAME — never the manifest's `name`.
//
// The install line is the FIRST command every dispatched agent runs, and it is
// rendered into THREE workspace-setup blocks. These pins hold the rule at all
// three, from ONE shared constant in the template, so the sites cannot drift
// apart the way a re-typed clause does.
describe('compose-driver — the install line carries the rule that keeps it working (issue #725)', () => {
  /** The instruction. */
  const RULE_HEADLINE = 'keep any directory it carries REPO-RELATIVE, and never re-render it as an absolute path';
  /** The mechanism, so a Worker that hits the message recognises it. */
  const RULE_SYMPTOM = 'Missing: <basename>@<version> from lock file';
  const RULE_MECHANISM = "reads the root package's name from the prefix DIRECTORY'S BASENAME instead of from the manifest";
  /** The substitute that must NOT be reached for — it drops the guarantee. */
  const RULE_SUBSTITUTE = 'do NOT switch `ci` to `install` to get past it';

  const rows = [
    row({ id: '42', slug: 'first' }),
    row({ id: '43', slug: 'second', iteration: 2, siblingBranches: 'wave/42-first' }),
  ];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  it('renders the rule at ALL THREE workspace-setup sites, beside the install line itself', async () => {
    const { calls } = await runComposedDriver(script);
    const briefFor = (label: string) => calls.find((c) => String(c.opts.label) === label)?.brief ?? '';

    const iter1 = briefFor('worker:42');
    const redispatch = briefFor('worker:43');
    const reviewer = briefFor('review:42');

    // Guard the fixture before the claim: three DIFFERENT blocks, not one
    // block counted three times.
    expect(redispatch).toContain('## Workspace setup (do first) — RE-DISPATCH');
    expect(iter1).not.toContain('RE-DISPATCH');
    expect(reviewer).toContain('re-run the verify commands below without installing first');

    for (const brief of [iter1, redispatch, reviewer]) {
      expect(brief).not.toBe('');
      // The rule sits with the command it governs, not in some distant section.
      expect(brief).toContain('npm ci --prefix tools/wave');
      expect(brief).toContain(RULE_HEADLINE);
      expect(brief).toContain(RULE_SYMPTOM);
      expect(brief).toContain(RULE_MECHANISM);
      expect(brief).toContain(RULE_SUBSTITUTE);
    }
  });

  it('the rule is ONE constant in the template, so the three sites cannot drift apart', () => {
    // Authored once…
    const authored = TEMPLATE.match(/keep any directory it carries REPO-RELATIVE/g) ?? [];
    expect(authored).toHaveLength(1);
    // …and interpolated three times.
    const rendered = TEMPLATE.match(/\$\{INSTALL_FORM_RULE\}/g) ?? [];
    expect(rendered).toHaveLength(3);
  });

  it('the placeholder a Coordinator fills says REPO-RELATIVE too, not only the rendered brief', () => {
    // The clause is worth nothing if the value it governs is composed absolute
    // in the first place — so the compose-time comment carries the rule as well.
    const placeholder = TEMPLATE.match(/^\s*depsSetup: '[^']*'/m)?.[0] ?? '';
    expect(placeholder).not.toBe('');
    expect(placeholder).toContain('REPO-RELATIVE');
  });
});

// ── inherited work-in-progress in a REUSED worktree (issue #731) ─────────────
//
// `isolation: 'worktree'` asks for a worktree; it does not promise a FRESH one.
// When the harness RETRIES a dispatch it re-runs the agent in the same checkout
// the previous attempt was already working in, so a first-iteration Worker can
// arrive to uncommitted edits, untracked new files and an already-created wave
// branch — all its own, one attempt earlier, and none of it reported anywhere.
//
// The setup was never SILENT about the anchor: it already prescribed a hard
// reset and then asserted a clean tree and a matching head. What it had no
// instruction for is the two dead ends that shape actually hits — a reset
// REFUSED (the harness write-deny is scoped per tool surface, so a shell reset
// that must unlink a tracked path under the agent-configuration directory is
// refused where a file-editing tool writing the same path is not), and a wave
// branch that already exists, which a plain `checkout -b` errors on outright.
//
// These pins read the RENDERED brief, because what has to carry a clause is
// what reaches the agent, not what sits in the template. Each clause gets a
// HEADLINE pin and a BODY pin, and the negative control at the end re-words a
// body while leaving its headline byte-intact — the failure mode a
// headline-only spec cannot see, and the one the sibling row shipped with.

describe('compose-driver — the iteration-1 setup instructs a Worker that inherited work-in-progress (issue #731)', () => {
  /** Headlines: what a skimming reader sees. Bodies: what the clause actually says. */
  const WIP_HEADLINE = 'INHERITED WORK-IN-PROGRESS — two honest options, and DISCARDING IS THE DEFAULT.';
  const DISCARD_HEADLINE = '**Discard it — the default, and what the reset below already does.**';
  const DISCARD_BODY = /Take this unless\s+you have positively decided otherwise/;
  const ADOPT_HEADLINE = '**Adopt it — permitted ONLY behind a recorded line-by-line review.**';
  const ADOPT_BODY = /read EVERY inherited line against EVERY acceptance criterion in\s+the task spec below/;
  const ADOPT_RECORD = /record it under `judgmentCalls` \(mirrored\s+in `reviewerFocusItems`\)/;
  const REFUSAL_HEADLINE = '**IF THE RESET IS REFUSED, the two asserts above have a branch to take';
  const REFUSAL_BODY = /write-deny is\s+scoped PER TOOL SURFACE/;
  const REFUSAL_BLOCKED = /STOP and report `blocked`, naming the residual paths/;
  const RETRY_NOT_REDISPATCH = /A harness\s+retry is NOT a re-dispatch:/;
  const RETRY_REANCHORS =
    /a retried FIRST iteration re-anchors to the round's anchor SHA exactly as a\s+first attempt does/;

  // ── issue #744: the two allowlist rulings the refused-reset remedy rests on ──
  //
  // The sibling row (#731) could only HEDGE both halves of its own remedy,
  // because the permission-allowlist scaffold it depends on sat outside its
  // declared Files globs. The Operator ruled both on 2026-09-16 — YES to the
  // read-at-commit, NO to the untracked sweep — and the brief now states each
  // as a ruling rather than as a hedge. These pins are what keeps it that way;
  // the negative control at the end of this block shows each BODY can fail
  // while its headline stays byte-intact.
  /** The headline carries the row's OWN anchor, so it is derived, never typed twice. */
  const readAtCommitHeadline = (sha: string) =>
    `**The source for that read is \`git show ${sha}:<path>\` — prescribed, not hedged.**`;
  const READ_AT_COMMIT_BODY =
    /allowlist scaffold carries `Bash\(git show:\*\)` as a prefix match \(Operator ruling\s+2026-09-16, the command form measured exit 0 under a dispatched agent's sandbox\)/;
  const READ_AT_COMMIT_FALLBACK =
    /If that read is ITSELF refused\s+for a permission reason, report it under policy clause 12 and stop at `blocked`/;
  const GIT_CLEAN_RULING_HEADLINE = '**Its absence is a RULING, not a gap (Operator, 2026-09-16):**';
  const GIT_CLEAN_CONFINEMENT =
    /a prefix-matched grant\s+cannot be confined to the agent's OWN worktree, so any `git clean` entry would reach\s+every sibling's live checkout/;

  /** One iteration-1 row and one re-dispatch row, from ONE composed script. */
  const rows = [
    row({ id: '42', slug: 'first' }),
    row({ id: '43', slug: 'second', iteration: 2, siblingBranches: 'wave/42-first' }),
  ];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  /**
   * The two Worker briefs, with the fixture guarded before any claim rests on
   * it (the same stance the deps-fallback block above takes): these really are
   * the two DIFFERENT workspace-setup blocks, not the same one twice.
   */
  async function workerBriefs(from = script): Promise<{ iter1: string; redispatch: string }> {
    const { calls } = await runComposedDriver(from);
    const briefAt = (label: string) =>
      calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    const iter1 = briefAt('worker:42');
    const redispatch = briefAt('worker:43');
    expect(iter1).not.toBe('');
    expect(redispatch).toContain('## Workspace setup (do first) — RE-DISPATCH');
    expect(iter1).not.toContain('RE-DISPATCH');
    return { iter1, redispatch };
  }

  /**
   * The driver-side rationale comment that records the harness-retry fact, with
   * its `//` prefixes and its wrapping normalised away so a pin can read it as
   * prose rather than as a particular line break. Fails loud when the note is
   * gone, rather than degrading to an empty scan.
   */
  function retryNote(template: string): string {
    const start = template.indexOf('// A HARNESS RETRY CAN REUSE THE WORKTREE');
    if (start < 0) {
      throw new Error('the driver-side harness-retry note is gone from the template');
    }
    const end = template.indexOf('const WORKSPACE_SETUP_ITER1', start);
    if (end < 0) {
      throw new Error('WORKSPACE_SETUP_ITER1 no longer follows the harness-retry note');
    }
    return template
      .slice(start, end)
      .split('\n')
      .map((line) => line.replace(/^\/\/ ?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  it('names BOTH options for inherited work-in-progress, with discarding stated as the default', async () => {
    const { iter1 } = await workerBriefs();
    expect(iter1).toContain(WIP_HEADLINE);
    expect(iter1).toContain(DISCARD_HEADLINE);
    expect(iter1).toMatch(DISCARD_BODY);
    expect(iter1).toContain(ADOPT_HEADLINE);
  });

  it('gates adoption on a recorded line-by-line review against every acceptance criterion', async () => {
    const { iter1 } = await workerBriefs();
    expect(iter1).toMatch(ADOPT_BODY);
    expect(iter1).toMatch(ADOPT_RECORD);
    expect(iter1).toContain('No record, no adoption.');
  });

  it('accounts for the untracked leftover the reset does NOT remove, and names git clean as a dead end', async () => {
    const { iter1 } = await workerBriefs();
    // `git reset --hard` discards tracked edits and leaves untracked files
    // standing, so the clean-tree assert would otherwise contradict itself on
    // exactly the shape the live occurrence had (a new spec file, uncommitted).
    expect(iter1).toMatch(/An UNTRACKED leftover survives `git reset --hard`/);
    expect(iter1).toMatch(/path you leave standing is ADOPTED and owes the recorded review/);
    // `git clean` is not on the measured AFK command surface (wave-setup's
    // allowlist scaffold), so prescribing it would stall the row on a
    // permission prompt with nobody there to answer it.
    expect(iter1).toMatch(/\*\*Do not reach for\s+`git clean`\*\*/);
  });

  it('states the git clean absence as a RULING with its confinement reason, not as a gap the next row closes (issue #744)', async () => {
    const { iter1 } = await workerBriefs();
    // "Not on the allowlist" alone reads as an oversight a Worker may ask to
    // have fixed. The Operator's 2026-09-16 ruling says WHY it can never be
    // fixed: a permission entry is a prefix match over a command string, and no
    // prefix of `git clean` can be confined to the agent's own worktree — the
    // same reason `git worktree remove`/`prune` are withheld.
    expect(iter1).toContain(GIT_CLEAN_RULING_HEADLINE);
    expect(iter1).toMatch(GIT_CLEAN_CONFINEMENT);
    expect(iter1).toMatch(/the same reason `git worktree remove`\/`prune` are\s+withheld/);
  });

  it('PRESCRIBES git show <anchorSha>:<path> as the refused-reset restore source, and keeps the report-and-stop fallback (issue #744)', async () => {
    const { iter1 } = await workerBriefs();
    // Prescription, not a hedge: the read is on the measured AFK command
    // surface (wave-setup's scaffold carries `Bash(git show:*)`), so the
    // remedy no longer depends on whatever permission surface the Worker
    // happens to have.
    expect(iter1).toContain(readAtCommitHeadline(rows[0].anchorSha));
    expect(iter1).toMatch(READ_AT_COMMIT_BODY);
    // The hedge that used to stand in the prescription's place is gone.
    expect(iter1).not.toContain('where your permission surface carries that read');
    // …and the floor survives the widening: a read refused anyway is reported
    // under clause 12 and STOPS, never guessed past.
    expect(iter1).toMatch(READ_AT_COMMIT_FALLBACK);
    expect(iter1).toMatch(/rather than guessing at the content\./);
  });

  it('gives the clean-tree assert a branch to take when the reset is REFUSED, instead of leaving it a dead end', async () => {
    const { iter1 } = await workerBriefs();
    expect(iter1).toContain(REFUSAL_HEADLINE);
    expect(iter1).toMatch(REFUSAL_BODY);
    // The remedy is the other side of the same per-tool-surface asymmetry…
    expect(iter1).toMatch(/Restore each surviving tracked path to its anchor content with your FILE-EDITING/);
    // …and it terminates: recovered, or an honest `blocked` — never "carry on".
    expect(iter1).toMatch(REFUSAL_BLOCKED);
    // It is a capability refusal, so clause 12's floor governs it: no retry
    // with the sandbox off, and no asking for the sandbox to be turned off.
    expect(iter1).toMatch(/you may not re-run it with the sandbox off/);
  });

  it('handles a wave branch that already exists at the anchor without failing on branch creation', async () => {
    const { iter1 } = await workerBriefs();
    const branch = branchFor('42', 'first');
    // The plain create still leads, so the ordinary path is unchanged…
    expect(iter1).toContain(`3. \`git checkout -b ${branch}\``);
    // …and the already-exists failure now has an instruction instead of a stop,
    // landing on the SAME branch name (the one the Coordinator routes by) at
    // the anchor, tracking-free.
    expect(iter1).toContain(`a branch named '${branch}' already exists`);
    expect(iter1).toContain(`git checkout -B ${branch} ${rows[0].anchorSha}`);
    expect(iter1).toMatch(/never `git checkout -B <branch> origin\/<branch>`/);
  });

  it('keeps the harness-retry case and the re-dispatch case distinguishable — a retried FIRST iteration still re-anchors', async () => {
    const { iter1, redispatch } = await workerBriefs();

    // Iteration 1, retried: the retry is named, and the re-anchor is restated
    // as holding THROUGH it — this is the pin the conflation would break.
    expect(iter1).toMatch(RETRY_NOT_REDISPATCH);
    expect(iter1).toMatch(RETRY_REANCHORS);
    expect(iter1).toContain(`git reset --hard ${rows[0].anchorSha}`);
    expect(iter1).toContain(`git rev-parse HEAD          # MUST equal ${rows[0].anchorSha}`);

    // Iteration ≥ 2: the opposite instruction, unchanged by this row, and none
    // of the iteration-1 clauses leaked into it.
    expect(redispatch).toMatch(/do not re-anchor to\s+the round's anchor SHA and branch fresh/);
    expect(redispatch).not.toMatch(/wave[ -]anchor/i);
    expect(redispatch).not.toContain(WIP_HEADLINE);
    expect(redispatch).not.toContain(REFUSAL_HEADLINE);
    expect(redispatch).not.toMatch(RETRY_REANCHORS);
  });

  it('records the harness-retry fact driver-side, as the note the brief clause is written around', () => {
    const note = retryNote(TEMPLATE);
    expect(note).toContain('A HARNESS RETRY CAN REUSE THE WORKTREE');
    expect(note).toContain(
      're-runs the agent in the SAME checkout the previous attempt was already working in',
    );
    expect(note).toContain('A harness retry is NOT a re-dispatch');
    // The note carries the reason the two must not merge, not just the fact.
    expect(note).toContain('let a retried Worker skip the re-anchor');
  });

  it('NEGATIVE CONTROL — retryNote fails loud when the driver-side note is gone, rather than scanning nothing', () => {
    expect(() => retryNote('// nothing here\n')).toThrow(
      /driver-side harness-retry note is gone from the template/,
    );
  });

  it('NEGATIVE CONTROL — re-wording a clause BODY while its HEADLINE stays byte-intact fails these pins (Convention 11)', async () => {
    // A clause-presence spec that pins only headlines passes a diff that keeps
    // the bold line and guts everything under it — which is how a clause stops
    // instructing anyone while still reading as present. Both probes below
    // leave the headline byte-identical on purpose.

    // Probe A — the adoption gate: the criterion-by-criterion review, the
    // measurement, the gate and the record all replaced by "use your judgment",
    // which is precisely the state this row exists to end.
    const guttedAdopt = TEMPLATE.replace(
      /(\*\*Adopt it — permitted ONLY behind a recorded line-by-line review\.\*\*)[\s\S]*?No record, no adoption\./,
      '$1 Use your judgment.',
    );
    expect(guttedAdopt).not.toEqual(TEMPLATE); // the replace actually matched
    expect(guttedAdopt).toContain(ADOPT_HEADLINE); // …and the headline survived it
    const adoptBriefs = await workerBriefs(
      composeDriverScript({ template: guttedAdopt, ...CONSTANTS, rows }),
    );
    expect(adoptBriefs.iter1).toContain(ADOPT_HEADLINE); // a headline-only pin still passes
    expect(adoptBriefs.iter1).not.toMatch(ADOPT_BODY); // the body pins fire
    expect(adoptBriefs.iter1).not.toMatch(ADOPT_RECORD);

    // Probe B — the refused-reset branch: same shape, different clause, so the
    // demonstration is not a property of one lucky regex.
    const guttedRefusal = TEMPLATE.replace(
      /The harness's write-deny is\n   scoped PER TOOL SURFACE[\s\S]*?refusal verbatim\./,
      'Deal with it.',
    );
    expect(guttedRefusal).not.toEqual(TEMPLATE); // the replace actually matched
    expect(guttedRefusal).toContain(REFUSAL_HEADLINE); // …and the headline survived it
    const refusalBriefs = await workerBriefs(
      composeDriverScript({ template: guttedRefusal, ...CONSTANTS, rows }),
    );
    expect(refusalBriefs.iter1).toContain(REFUSAL_HEADLINE); // headline-only pin still passes
    expect(refusalBriefs.iter1).not.toMatch(REFUSAL_BODY); // the body pins fire
    expect(refusalBriefs.iter1).not.toMatch(REFUSAL_BLOCKED);
  });

  it('NEGATIVE CONTROL — the two allowlist-ruling clauses fail their BODY pins while their headlines stay byte-intact (issue #744)', async () => {
    // The same demonstration as the control above, run against the clauses
    // THIS row added. Both rulings are exactly the shape that degrades
    // silently: a bold line that still reads as present over a body that no
    // longer says which command to run, or why the other one is withheld.

    // Probe C — the prescribed read-at-commit. The headline keeps naming
    // `git show <anchorSha>:<path>`; everything that makes it a PRESCRIPTION
    // (the allowlist citation, the ruling, the measurement) and the
    // report-and-stop fallback underneath it are replaced.
    const guttedRead = TEMPLATE.replace(
      /(\*\*The source for that read is [\s\S]*?prescribed, not hedged\.\*\*)[\s\S]*?guessing at the content\./,
      '$1 Work it out.',
    );
    expect(guttedRead).not.toEqual(TEMPLATE); // the replace actually matched
    const readBriefs = await workerBriefs(
      composeDriverScript({ template: guttedRead, ...CONSTANTS, rows }),
    );
    // a headline-only pin still passes…
    expect(readBriefs.iter1).toContain(readAtCommitHeadline(rows[0].anchorSha));
    // …and the body pins, and only the body pins, fire.
    expect(readBriefs.iter1).not.toMatch(READ_AT_COMMIT_BODY);
    expect(readBriefs.iter1).not.toMatch(READ_AT_COMMIT_FALLBACK);

    // Probe D — the `git clean` ruling. The withheld-command headline survives
    // (so does the older "Do not reach for `git clean`" dead-end pin), while
    // the confinement reason that turns the absence from an oversight into a
    // decision is gone — the precise degradation this row exists to prevent.
    const guttedClean = TEMPLATE.replace(
      /(\*\*Its absence is a RULING, not a gap \(Operator, 2026-09-16\):\*\*)[\s\S]*?do not ask for the entry\./,
      '$1 Trust me.',
    );
    expect(guttedClean).not.toEqual(TEMPLATE); // the replace actually matched
    expect(guttedClean).toContain(GIT_CLEAN_RULING_HEADLINE); // …and the headline survived it
    const cleanBriefs = await workerBriefs(
      composeDriverScript({ template: guttedClean, ...CONSTANTS, rows }),
    );
    expect(cleanBriefs.iter1).toContain(GIT_CLEAN_RULING_HEADLINE); // headline-only pin still passes
    expect(cleanBriefs.iter1).toMatch(/\*\*Do not reach for\s+`git clean`\*\*/); // so does the dead-end pin
    expect(cleanBriefs.iter1).not.toMatch(GIT_CLEAN_CONFINEMENT); // the body pin fires
  });
});

// ─── #778 — the RE-DISPATCH checkout can HALF-APPLY under the harness write-
// deny ───────────────────────────────────────────────────────────────────────
//
// `WORKSPACE_SETUP_REDISPATCH`'s own checkout (`git checkout -B <branch>
// FETCH_HEAD`) can be refused PER PATH by the same harness write-deny the
// #731 suite above exercises against `git reset --hard` — the skills corpus
// (`.claude/skills/`) is the measured case. The branch switch is still
// reported successful: `HEAD` lands correctly while the denied working
// copies silently keep their pre-checkout content, and the checkout's own
// asserts (status empty, HEAD matching) can both read clean on exactly that
// state. This is deliberately a DIFFERENT case from every #731 clause (those
// are iteration-1's `git reset --hard` refusal and the harness-retry
// re-anchor) and from #745 (a harness retry OF an already-re-dispatched
// worktree, ruled with no clause) — it is the re-dispatch CHECKOUT OPERATION
// itself half-applying. Same evidence discipline as the #731 suite: a
// HEADLINE pin and a BODY pin, read over the RENDERED brief, with a negative
// control that re-words the body while leaving the headline byte-intact.

describe('compose-driver — the re-dispatch checkout can half-apply under the harness write-deny (issue #778)', () => {
  const HALFAPPLY_HEADLINE =
    "**IF THE CHECKOUT HALF-APPLIES UNDER THE HARNESS WRITE-DENY, HEAD LANDING IS NOT PROOF THE WORKING TREE FOLLOWED IT — and this is NOT the harness-retry-of-a-re-dispatch case (that one is #745's, ruled with no clause).**";
  const HALFAPPLY_BODY =
    /prints `Operation not permitted` for each such path and still reports the branch switch as successful/;
  const HALFAPPLY_WHY_ORDER =
    /this repo's own corpus-scanning guards read the WORKING TREE, never the index/;
  const HALFAPPLY_NOT_OBJECT_STORE =
    /Staging the correct content through the git object store[\s\S]*is not the path/;
  const HALFAPPLY_BLOCKED =
    /STOP and report `blocked`, naming the residual paths and quoting the refusal verbatim/;
  const HALFAPPLY_CAPABILITY =
    /you may not re-run the checkout with the sandbox off, and you may not ask for the sandbox to be turned off/;

  /** One iteration-1 row and one re-dispatch row, from ONE composed script. */
  const rows778 = [
    row({ id: '42', slug: 'first' }),
    row({ id: '43', slug: 'second', iteration: 2, siblingBranches: 'wave/42-first' }),
  ];
  const script778 = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows: rows778 });

  async function workerBriefs778(from = script778): Promise<{ iter1: string; redispatch: string }> {
    const { calls } = await runComposedDriver(from);
    const briefAt = (label: string) =>
      calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    const iter1 = briefAt('worker:42');
    const redispatch = briefAt('worker:43');
    expect(iter1).not.toBe('');
    expect(redispatch).toContain('## Workspace setup (do first) — RE-DISPATCH');
    return { iter1, redispatch };
  }

  it('gives the re-dispatch checkout a branch to take when it half-applies under the harness write-deny', async () => {
    const { redispatch } = await workerBriefs778();
    expect(redispatch).toContain(HALFAPPLY_HEADLINE);
    expect(redispatch).toMatch(HALFAPPLY_BODY);
    expect(redispatch).toMatch(HALFAPPLY_NOT_OBJECT_STORE);
    expect(redispatch).toMatch(HALFAPPLY_BLOCKED);
    expect(redispatch).toMatch(HALFAPPLY_CAPABILITY);
  });

  it('states the refusal is a capability refusal and names staging through the git object store as not the path', async () => {
    const { redispatch } = await workerBriefs778();
    expect(redispatch).toMatch(HALFAPPLY_CAPABILITY);
    expect(redispatch).toMatch(HALFAPPLY_NOT_OBJECT_STORE);
  });

  it('orders the restore-and-re-assert before the install step and before any verify command, and says why', async () => {
    const { redispatch } = await workerBriefs778();
    expect(redispatch).toMatch(HALFAPPLY_WHY_ORDER);
    const clauseAt = redispatch.indexOf(HALFAPPLY_HEADLINE);
    const installAt = redispatch.indexOf('3. Install dependencies.');
    expect(clauseAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(clauseAt).toBeLessThan(installAt);
  });

  it('keeps the new clause distinguishable from the iteration-1 clauses, in both directions', async () => {
    const { iter1, redispatch } = await workerBriefs778();
    // The iteration-1 rendering does not carry the new clause's headline…
    expect(iter1).not.toContain(HALFAPPLY_HEADLINE);
    // …and the re-dispatch rendering still carries none of the iteration-1
    // clauses' headlines (the #731 suite's own pin, re-asserted from this
    // row's side, over the SAME two rows).
    expect(redispatch).not.toContain(
      'INHERITED WORK-IN-PROGRESS — two honest options, and DISCARDING IS THE DEFAULT.',
    );
    expect(redispatch).not.toContain(
      '**IF THE RESET IS REFUSED, the two asserts above have a branch to take',
    );
  });

  it('records the half-applied-checkout fact driver-side, and states the clause is not a harness-retry clause', () => {
    const start = TEMPLATE.indexOf('// A THIRD trap belongs beside the two above');
    expect(start).toBeGreaterThan(-1);
    const end = TEMPLATE.indexOf('const WORKSPACE_SETUP_REDISPATCH', start);
    expect(end).toBeGreaterThan(start);
    const note = TEMPLATE.slice(start, end)
      .split('\n')
      .map((line) => line.replace(/^\/\/ ?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(note).toContain('HALF-APPLY');
    expect(note).toContain('THIS IS NOT A HARNESS-RETRY-OF-A-RE-DISPATCH CLAUSE');
    expect(note).toContain('issue #745');
  });

  it('NEGATIVE CONTROL — re-wording the clause BODY while its HEADLINE stays byte-intact fails the body pins (Convention 11)', async () => {
    const gutted = TEMPLATE.replace(
      /The write-deny above is scoped PER PATH[\s\S]*?the sandbox to be turned off\./,
      'Deal with it.',
    );
    expect(gutted).not.toEqual(TEMPLATE); // the replace actually matched
    expect(gutted).toContain(HALFAPPLY_HEADLINE); // …and the headline survived it
    const briefs = await workerBriefs778(
      composeDriverScript({ template: gutted, ...CONSTANTS, rows: rows778 }),
    );
    expect(briefs.redispatch).toContain(HALFAPPLY_HEADLINE); // headline-only pin still passes
    expect(briefs.redispatch).not.toMatch(HALFAPPLY_BODY); // the body pins fire
    expect(briefs.redispatch).not.toMatch(HALFAPPLY_BLOCKED);
    expect(briefs.redispatch).not.toMatch(HALFAPPLY_CAPABILITY);
  });
});

// ─── #828 — the credential-helper writeback's benign `fatal:` line ───────────
//
// The harness denies a dispatched agent write access to the git credential
// helper's keychain store, so `git fetch`'s WRITEBACK fails and prints
// `fatal: failed to store: 100001` while the fetch's own OPERATION — the ref
// arrived, `FETCH_HEAD` (or, at the Reviewer's site, `refs/review/<id>`)
// updated — completes regardless. Nothing in the brief used to say so, so a
// dispatched Worker or Reviewer had exactly two honest, costly responses to
// the unexplained `fatal:` line: stop and report `blocked`, or proceed and
// disclose it as a judgment call. The clause below pre-empts both, at all
// three composed sites — the iteration-1 Worker setup, the re-dispatch
// Worker setup, and the Reviewer's own resolve-the-branch fetch.
//
// The `-u` upstream-config write line and the half-applied-checkout mirror
// case (both named in the issue) are DELIBERATELY out of scope for this row —
// the negative-scope test below guards that boundary too.

describe('compose-driver — the credential-helper writeback fatal line is named and ruled benign at all three sites (issue #828)', () => {
  const FATAL_LINE = 'fatal: failed to store: 100001';
  /** Matches the RENDERED brief (plain backticks — the template's `\` escapes are gone once `new Function` evaluates it). */
  const FATAL_HEADLINE = 'A `' + FATAL_LINE + '` line printed by that fetch is benign —';
  /** Matches the RAW template text (the source's own `\`` escaping survives a plain `readFileSync`) — used only against `TEMPLATE` below, never against a rendered brief. */
  const FATAL_HEADLINE_RAW = 'A \\`' + FATAL_LINE + '\\` line printed by that fetch is benign —';
  const MECHANISM =
    /credential helper failed to write the token back to the\s+keychain under the harness write-deny/;
  // The clause line-wraps inside the template (three-space-indented prose), so
  // the rendered brief carries a literal `\n   ` where the source line broke —
  // `\s+` stands in for that at each such join, never a plain space.
  const WORKER_PROCEED = /This is not a reason to report `blocked`,\s+and it needs no `judgmentCalls` disclosure\./;
  const REVIEWER_PROCEED = /This is not a reason to report `blocked`, and it is not a finding to\s+disclose\./;

  /** One iteration-1 row and one re-dispatch row, from ONE composed script. */
  const rows828 = [
    row({ id: '42', slug: 'first' }),
    row({ id: '43', slug: 'second', iteration: 2, siblingBranches: 'wave/42-first' }),
  ];
  const script828 = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows: rows828 });

  async function briefs828(
    from = script828,
  ): Promise<{ iter1: string; redispatch: string; reviewer: string }> {
    const { calls } = await runComposedDriver(from);
    const briefAt = (label: string) => calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    const iter1 = briefAt('worker:42');
    const redispatch = briefAt('worker:43');
    const reviewer = briefAt('review:42');
    // Guard the fixture before any claim rests on it: three DIFFERENT
    // composed blocks, not one counted three times.
    expect(iter1).not.toBe('');
    expect(redispatch).toContain('## Workspace setup (do first) — RE-DISPATCH');
    expect(iter1).not.toContain('RE-DISPATCH');
    expect(reviewer).toContain('## Resolve the branch');
    return { iter1, redispatch, reviewer };
  }

  it('names the literal fatal line and rules it benign at all three composed sites', async () => {
    const { iter1, redispatch, reviewer } = await briefs828();
    for (const brief of [iter1, redispatch, reviewer]) {
      expect(brief).toContain(FATAL_LINE);
      expect(brief).toContain(FATAL_HEADLINE);
      expect(brief).toMatch(MECHANISM);
    }
  });

  it('states the fetch succeeded when its own ref line printed — `-> FETCH_HEAD` at the two Worker sites', async () => {
    const { iter1, redispatch } = await briefs828();
    for (const brief of [iter1, redispatch]) {
      expect(brief).toMatch(/ref line printed \(`-> FETCH_HEAD`\), the ref arrived/);
    }
  });

  it('states the fetch succeeded when its own ref line printed — `-> refs/review/<id>` at the Reviewer site', async () => {
    const { reviewer } = await briefs828();
    expect(reviewer).toMatch(/ref line printed \(`-> refs\/review\/42`\), the ref\s+arrived/);
  });

  it('says proceed without reporting blocked and without a disclosure, at every site', async () => {
    const { iter1, redispatch, reviewer } = await briefs828();
    expect(iter1).toMatch(WORKER_PROCEED);
    expect(redispatch).toMatch(WORKER_PROCEED);
    expect(reviewer).toMatch(REVIEWER_PROCEED);
  });

  /** The clause paragraph only, sliced out of a rendered brief — so a check
   * that some OTHER topic is absent is scoped to what this row actually
   * wrote, not to the whole brief (which legitimately mentions `-u` in
   * Termination step 2, unrelated to this clause). */
  function claimClauseIn(brief: string): string {
    const at = brief.indexOf(FATAL_HEADLINE);
    expect(at).toBeGreaterThan(-1);
    const end = brief.indexOf('\n\n', at);
    expect(end).toBeGreaterThan(at);
    return brief.slice(at, end);
  }

  it('does not widen into the `-u` upstream-config write or the half-applied-checkout mirror case (both out of scope for this row)', async () => {
    const { iter1, redispatch, reviewer } = await briefs828();
    for (const brief of [iter1, redispatch, reviewer]) {
      const clause = claimClauseIn(brief);
      expect(clause).not.toContain('-u');
      expect(clause).not.toMatch(/HALF-APPL/i);
    }
  });

  it("no other workspace-setup wording moved — the #731 and #778 clauses' own headlines still render byte-identical", async () => {
    const { redispatch } = await briefs828();
    // Re-asserted here, over THIS row's own fixture, so a regression in this
    // row's edit — not just the #731/#778 rows' own fixtures — would be
    // caught by the row that could actually cause it.
    expect(redispatch).toContain(
      '**IF THE CHECKOUT HALF-APPLIES UNDER THE HARNESS WRITE-DENY, HEAD LANDING IS NOT PROOF THE WORKING TREE FOLLOWED IT — and this is NOT the harness-retry-of-a-re-dispatch case (that one is #745\'s, ruled with no clause).**',
    );
  });

  it('NEGATIVE CONTROL — stripping the clause from the iteration-1 site alone fails the pin there and only there (Convention 11)', async () => {
    // First occurrence of the headline in the raw template is the
    // iteration-1 site (it renders before the re-dispatch and Reviewer
    // clauses in file order) — `indexOf` with a plain string target finds
    // only that first match, so slicing it out is a TARGETED removal. Uses
    // the RAW (escaped-backtick) form because `TEMPLATE` here is unevaluated
    // source text, never the rendered brief.
    const clauseStart = TEMPLATE.indexOf(FATAL_HEADLINE_RAW);
    expect(clauseStart).toBeGreaterThan(-1);
    const clauseEnd = TEMPLATE.indexOf('An UNTRACKED leftover survives', clauseStart);
    expect(clauseEnd).toBeGreaterThan(clauseStart);
    const stripped = TEMPLATE.slice(0, clauseStart) + TEMPLATE.slice(clauseEnd);
    expect(stripped).not.toEqual(TEMPLATE); // the slice actually removed something

    const { iter1, redispatch, reviewer } = await briefs828(
      composeDriverScript({ template: stripped, ...CONSTANTS, rows: rows828 }),
    );
    // The site the strip targeted no longer carries the clause — this is the
    // FAIL state the earlier positive test would hit without this row's fix.
    expect(iter1).not.toContain(FATAL_HEADLINE);
    expect(iter1).not.toContain(FATAL_LINE);
    // …while the other two sites, untouched by the strip, still carry it —
    // proving the removal was targeted, not a template-wide loss, and that
    // the three pins above are independent rather than one pin in disguise.
    expect(redispatch).toContain(FATAL_HEADLINE);
    expect(reviewer).toContain(FATAL_HEADLINE);
  });
});

describe('compose-driver — the scope-grant projection reads the spine, never a hand-authored field (ADR-0041)', () => {
  function spineWithGrant(text: string): string {
    const base = renderSpine(
      {
        slug: 'w',
        description: 'd',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-03',
        lastUpdated: '2026-09-03',
      },
      [{ id: '42', title: 'T', worker: 'background', risk: 'mechanical' }],
      { issues: [], cells: [] },
      'ok',
    );
    const added = addDisclosureToSource(base, {
      rowId: '42',
      iter: 1,
      source: 'worker',
      text,
    });
    return setDispositionInSource(added.source, added.disclosure.ref, 'scope-extension');
  }

  it('projects a structured grant when the disclosure names its paths in backticks', () => {
    const grants = projectScopeGrants(
      spineWithGrant('the wiring lives in `tools/wave/src/cli.ts`, outside the globs'),
      '42',
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      paths: ['tools/wave/src/cli.ts'],
      grantedAtIteration: 1,
      disclosureRef: '42.1',
    });
  });

  it('degrades to the string form when the paths are stated in prose', () => {
    const grants = projectScopeGrants(spineWithGrant('the wiring lies outside the declared globs'), '42');
    expect(grants).toHaveLength(1);
    expect(typeof grants[0]).toBe('string');
    expect(grants[0]).toContain('42.1');
  });

  it('ignores another row’s grants and every non-scope-extension disposition', () => {
    const base = spineWithGrant('needs `a/b.ts`');
    expect(projectScopeGrants(base, '99')).toEqual([]);
    const stillOpen = renderSpine(
      { slug: 'w', description: 'd', coordinator: 'c', model: 'm', created: 'x', lastUpdated: 'x' },
      [{ id: '42', title: 'T', worker: 'background', risk: 'mechanical' }],
      { issues: [], cells: [] },
      'ok',
    );
    const added = addDisclosureToSource(stillOpen, {
      rowId: '42',
      iter: 1,
      source: 'worker',
      text: 'needs `a/b.ts`',
    });
    expect(projectScopeGrants(added.source, '42')).toEqual([]);
  });
});

// ─── 6. the verb, end to end, against a real store + a real git anchor ────────

describe('compose-driver — the verb, end to end', () => {
  let repoRoot: string;
  let anchor: string;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const SLUG = '2026-09-03-compose';

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  }

  async function seed(): Promise<{ id: string; spinePath: string; configPath: string }> {
    const store = new MarkdownFsStore({ repoRoot, slug: SLUG });
    const id = await store.create({
      title: 'Ship the compose verb',
      filingHint: 'ship-the-compose-verb',
      risk: 'public-API-change',
      worker: 'background-heavy',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'the verb composes', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'Compose the driver.' }],
    });

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'compose',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-03',
        lastUpdated: '2026-09-03',
      },
      [{ id, title: 'Ship the compose verb', worker: 'background-heavy', risk: 'public-API-change' }],
      { issues: [], cells: [] },
      'ok',
    );
    spine = setRowState(spine, id, 'dispatched');
    spine = upsertDispatchLogEntry(spine, id, `wave/${id}-ship-the-compose-verb`);
    spine = upsertDispatchLogModel(spine, id, 'opus');

    const spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    writeFileSync(spinePath, spine, 'utf8');

    const configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI },
        verify: {
          profiles: [
            {
              name: 'engine',
              appliesTo: ['tools/wave/**'],
              commands: [
                { command: 'npm ci --prefix tools/wave' },
                { command: 'vitest run --root tools/wave' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    return { id, spinePath, configPath };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compose-driver-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q']);
    execFileSync('git', [
      '-C',
      repoRoot,
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'anchor',
    ]);
    anchor = git('rev-parse', 'HEAD');
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('writes the finished script and prints one receipt', async () => {
    const { id, spinePath, configPath } = await seed();
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--anchor',
      anchor,
      '--out',
      out,
      '--reviewer-agent',
      'flotilla:wave-reviewer',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const receipt = JSON.parse(stdout) as Record<string, unknown>;
    expect(receipt.ok).toBe(true);
    expect(receipt.anchor).toBe(anchor);
    expect(receipt.reviewerAgent).toBe('flotilla:wave-reviewer');
    expect(receipt.template).toBe(DRIVER_TEMPLATE_PATH);
    expect(receipt.rows).toEqual([
      {
        id,
        slug: 'ship-the-compose-verb',
        branch: `wave/${id}-ship-the-compose-verb`,
        model: 'opus',
        iteration: 1,
        risk: 'public-API-change',
        worker: 'background-heavy',
        scopeGrants: 0,
        // issue #717 — WHICH precedence level answered, not just what it said.
        // This config carries no `engine.install`, so the install-shaped
        // command in the row's own verify profile is what answered.
        depsSetupSource: 'verify',
      },
    ]);

    const script = readFileSync(out, 'utf8');
    expect(script).toContain(`const REPO_ROOT = ${JSON.stringify(repoRoot)}`);
    expect(script).toContain(
      `const WAVE_CLI = ${JSON.stringify(`NODE_USE_ENV_PROXY=1 ${SOURCE_FORM_CLI}`)}`,
    );
    expect(script).toContain(JSON.stringify(join(repoRoot, '.flotilla', 'waves', SLUG, 'reports')));

    // …and the finished script really is a runnable driver.
    const { calls } = await runComposedDriver(script);
    expect(calls.map((c) => c.opts.label)).toEqual([
      `worker:${id}`,
      `scribe-report:${id}`,
      `review:${id}`,
      `scribe-verdict:${id}`,
    ]);
    const brief = calls[0].brief;
    expect(brief).toContain('Ship the compose verb');
    expect(brief).toContain('- [ ] the verb composes');
    expect(brief).toContain('- tools/wave/**');
    expect(brief).toContain('npm ci --prefix tools/wave');
    expect(brief).toContain('vitest run --root tools/wave');
    // This fixture's store is `markdown`, so the row id is the compound
    // `<slug>#NN`. The brief's close phrase carries the LIFTED numeric tail —
    // the whole-id form this line used to assert (`Closes #<slug>#NN`) is a
    // phrase no code host resolves and the close-phrase guard cannot see, which
    // is what made a dogfood reuse come back `reuse-refused`.
    expect(id).toMatch(/#\d+$/);
    expect(brief).toContain('Closes #01');
    expect(brief).not.toContain(`Closes #${id}`);
  });

  // ADR-0049 AC2 — BOTH composed briefs render each verify command with its
  // declared needs. They do so through one mechanism (the embedded issue spec is
  // the same string in both), which is exactly why this is asserted on the
  // RUNNING script rather than on `composeIssueSpec` alone: the claim is about
  // what the two dispatched agents actually read.
  it('both composed briefs carry each verify command WITH its declared needs, and the no-escalation clause', async () => {
    const { id, spinePath, configPath } = await seed();
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI },
        verify: {
          profiles: [
            {
              name: 'engine',
              appliesTo: ['tools/wave/**'],
              commands: [
                { command: 'npm ci --prefix tools/wave' },
                {
                  command: 'vitest run --root tools/wave',
                  needs: { writes: ['/var/tmp/flotilla-cache'], network: ['registry.npmjs.org'] },
                },
                { command: 'docker compose config', needs: { host: true } },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    const out = join(repoRoot, 'driver.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', out,
        '--reviewer-agent', 'flotilla:wave-reviewer',
      ]),
    ).toBe(0);

    const { calls } = await runComposedDriver(readFileSync(out, 'utf8'));
    const workerBrief = calls.find((c) => String(c.opts.label) === `worker:${id}`)?.brief ?? '';
    const reviewerBrief = calls.find((c) => String(c.opts.label) === `review:${id}`)?.brief ?? '';
    expect(workerBrief).not.toBe('');
    expect(reviewerBrief).not.toBe('');

    for (const brief of [workerBrief, reviewerBrief]) {
      // the data, per command, beside the command
      expect(brief).toContain('writes outside the worktree: `/var/tmp/flotilla-cache`');
      expect(brief).toContain('network hosts: `registry.npmjs.org`');
      expect(brief).toContain('host: a capability that cannot be narrowed');
      // the undeclared command still renders plainly
      expect(brief).toContain('- `npm ci --prefix tools/wave`\n');
      // and the rule, in each role's own voice
      expect(brief).toMatch(/never escalates? (?:its|your) own permissions/i);
      expect(brief).toContain('ADR-0049');
    }

    // Role-specific halves: the Worker's retired retry path, the Reviewer's valve.
    expect(workerBrief).toContain('retry-with-the-sandbox-off path is retired by name');
    expect(workerBrief).toMatch(/report it as NOT RUN/);
    expect(reviewerBrief).toContain('capability-gated');
    expect(reviewerBrief).toMatch(/at most the Worker's rights/i);
  });

  // ADR-0049 decision 1 — the no-escalation rule binds EVERY dispatched role:
  // Worker, Reviewer AND Scribe. The shipped driver carried it in two briefs;
  // the Scribe's, added here, is the third.
  //
  // ## Why this test exists beside the one above, instead of inside it
  //
  // The assertion above is the clause-PRESENCE check, and it had a measured
  // blind spot: `/never escalates? (its|your) own permissions/` matches the
  // clause HEADLINE, so re-wording the clause BODY — the four acts it actually
  // forbids — left it green, and only a re-worded headline went red. A clause
  // whose prohibitions can be rewritten under a stable headline is a clause no
  // guard is holding.
  //
  // So this test pins the BODY. `NO_ESCALATION_ACTS` is the enumeration all
  // three briefs share verbatim; each act is asserted separately and named in
  // the failure message, so a red says which brief lost which prohibition
  // rather than "a long string differs". The role-specific halves below are
  // pinned the same way, because "the Reviewer runs at most the Worker's
  // rights" and "the Worker reports the gate as NOT RUN" are the two sentences
  // that turn the rule from a slogan into an instruction.
  //
  // Briefs are whitespace-NORMALIZED before matching, deliberately: the clause
  // is a wrapped template literal, so re-wrapping a line is not re-wording it
  // and must not go red. Re-wording IS what goes red — which is the property
  // this test was falsified against (a body act re-spelled in the template,
  // observed failing, restored).
  it('all THREE composed briefs carry the no-escalation clause — headline AND body, per role (ADR-0049 decision 1)', async () => {
    const { id, spinePath, configPath } = await seed();
    const out = join(repoRoot, 'driver.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', out,
        '--reviewer-agent', 'flotilla:wave-reviewer',
      ]),
    ).toBe(0);

    const { calls } = await runComposedDriver(readFileSync(out, 'utf8'));
    const flat = (label: string): string =>
      (calls.find((c) => String(c.opts.label) === label)?.brief ?? '').replace(/\s+/g, ' ');

    const briefs: Array<[string, string]> = [
      ['worker', flat(`worker:${id}`)],
      ['reviewer', flat(`review:${id}`)],
      ['scribe', flat(`scribe-report:${id}`)],
    ];

    // The four acts the clause forbids, spelled the way every brief spells them.
    // These are BODY text, not the headline: re-wording any one of them here is
    // what this test exists to catch.
    const NO_ESCALATION_ACTS = [
      'disable the sandbox',
      'ask for it to be disabled',
      're-run anything with it off',
      'widen your own settings',
    ];

    for (const [role, brief] of briefs) {
      expect(brief, `${role} brief was not composed`).not.toBe('');
      // headline (the check that already existed) …
      expect(brief, `${role} brief: no-escalation HEADLINE missing`).toMatch(
        /never escalates? (?:its|your) own permissions/i,
      );
      expect(brief, `${role} brief: ADR-0049 citation missing`).toContain('ADR-0049');
      // … and the body, act by act (the half that used to be unguarded).
      for (const act of NO_ESCALATION_ACTS) {
        expect(brief, `${role} brief: clause BODY lost the prohibition "${act}"`).toContain(act);
      }
    }

    const [, workerBrief] = briefs[0];
    const [, reviewerBrief] = briefs[1];
    const [, scribeBrief] = briefs[2];

    // Role-specific body, each the sentence that makes the rule actionable in
    // that role's own vocabulary.
    expect(workerBrief, 'worker brief: the retired retry path is no longer named').toContain(
      'retry-with-the-sandbox-off path is retired by name',
    );
    expect(workerBrief, 'worker brief: the NOT-RUN reporting instruction is gone').toContain(
      'report it as NOT RUN',
    );
    expect(reviewerBrief, 'reviewer brief: the fourth deferred-valve trigger is gone').toContain(
      'capability-gated',
    );
    expect(reviewerBrief, "reviewer brief: the at-most-the-Worker's-rights ceiling is gone").toMatch(
      /at most the Worker's rights/i,
    );
    expect(scribeBrief, 'scribe brief: the every-role roster is gone').toContain(
      'Worker, Reviewer and Scribe alike',
    );
    expect(scribeBrief, 'scribe brief: the retired retry path is no longer named').toContain(
      'retry-with-the-sandbox-off path is retired by name',
    );
    expect(scribeBrief, 'scribe brief: the refusal-is-the-answer instruction is gone').toContain(
      "take step 4's one byte-identical retry",
    );
  });

  it('NEGATIVE CONTROL — a fabricated anchor is refused before anything is written (the gate that used to sit host-side)', async () => {
    const { spinePath, configPath } = await seed();
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--anchor',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '--out',
      out,
      '--reviewer-agent',
      'x',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/does not resolve to a commit/);
  });

  // ── the compose-time parse gate (issue #868) ──────────────────────────────
  //
  // The template's own parse is gated above, on the shipped asset. These three
  // gate the OTHER half: `--template` accepts any path, so the bytes the
  // composer fills are not necessarily the bytes this package ships. Before
  // this gate the composer checked the template's SHAPE — a placeholder line to
  // fill, a balanced `ISSUES` array — and never asked whether the result was
  // JavaScript, so an unparseable override composed clean, was written to disk
  // under a receipt reading `ok: true`, and failed inside a dispatched wave.

  it('NEGATIVE CONTROL — an unparseable `--template` override is refused at compose time, and NO file is written', async () => {
    const { spinePath, configPath } = await seed();
    const brokenTemplate = join(repoRoot, 'broken-template.js');
    writeFileSync(brokenTemplate, withUnbalancedBacktick(TEMPLATE), 'utf8');

    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
      '--template', brokenTemplate,
    ]);

    expect(code).toBe(1);
    // An `error:` line naming the syntax failure — the class, the message, the
    // position, and the path an operator opens to fix it.
    expect(stderr).toMatch(/^error: /m);
    expect(stderr).toContain('SyntaxError');
    expect(stderr).toMatch(/line \d+ of the composed script/);
    expect(stderr).toContain(brokenTemplate);
    // "before anything is written" is the load-bearing half, exactly as it is
    // for the fabricated-anchor refusal above: no script exists.
    expect(existsSync(out)).toBe(false);
    // …and no receipt was printed either, so nothing downstream can read this
    // compose as `ok: true`.
    expect(stdout).toBe('');
  });

  it('POSITIVE CONTROL — a parseable `--template` override still composes, byte-identically to no override at all', async () => {
    const { spinePath, configPath } = await seed();

    const withoutOverride = join(repoRoot, 'driver-default.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', withoutOverride,
        '--reviewer-agent', 'flotilla:wave-reviewer',
      ]),
    ).toBe(0);

    // A VERBATIM copy of the shipped template, handed over as an override.
    const verbatim = join(repoRoot, 'verbatim-template.js');
    writeFileSync(verbatim, TEMPLATE, 'utf8');
    const withOverride = join(repoRoot, 'driver-verbatim.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', withOverride,
        '--reviewer-agent', 'flotilla:wave-reviewer',
        '--template', verbatim,
      ]),
    ).toBe(0);

    expect(stderr).toBe('');
    expect(readFileSync(withOverride, 'utf8')).toBe(readFileSync(withoutOverride, 'utf8'));

    // And a template that is parseable but NOT the shipped bytes composes too —
    // without this, "the gate accepts a parseable override" would be compatible
    // with "the gate recognises the shipped template and nothing else".
    const edited = join(repoRoot, 'edited-template.js');
    writeFileSync(edited, `// a hand-edited override, still valid JavaScript\n${TEMPLATE}`, 'utf8');
    const fromEdited = join(repoRoot, 'driver-edited.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', fromEdited,
        '--reviewer-agent', 'flotilla:wave-reviewer',
        '--template', edited,
      ]),
    ).toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(fromEdited)).toBe(true);
    expect(readFileSync(fromEdited, 'utf8')).toContain(
      '// a hand-edited override, still valid JavaScript',
    );
  });

  it('NEGATIVE CONTROL — the gate catches a break the OTHER compose-time checks pass clean', async () => {
    // The discriminator. This override keeps every placeholder line and a
    // balanced `ISSUES` array — so `fillStringConst` and `balancedEnd` are both
    // satisfied and the compose reaches the write — and breaks only the parse,
    // with a template literal carrying an unclosed `${` appended after the
    // array. That is the shape the shape-checks are blind to by construction,
    // and it is the one the falsification confirmed: with the gate removed this
    // same override composed to exit 0 and wrote the file.
    const { spinePath, configPath } = await seed();
    const broken = join(repoRoot, 'unclosed-expression.js');
    writeFileSync(broken, `${TEMPLATE}\nconst TRAILING = \`an unclosed \${expression\n`, 'utf8');

    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
      '--template', broken,
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('SyntaxError');
    expect(existsSync(out)).toBe(false);
  });

  it('NEGATIVE CONTROL — a config with no engine.cli binding is a STOP, not a guessed spelling', async () => {
    const { spinePath } = await seed();
    const bare = join(repoRoot, 'bare.config.json');
    writeFileSync(
      bare,
      JSON.stringify({ store: { kind: 'markdown', repoRoot, slug: SLUG } }),
      'utf8',
    );
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      bare,
      '--repo-root',
      repoRoot,
      '--anchor',
      anchor,
      '--out',
      join(repoRoot, 'driver.js'),
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/engine\.cli/);
    expect(stderr).toMatch(/wave-setup/);
  });

  it('NEGATIVE CONTROL — a spine with no dispatchable row refuses rather than writing an empty fan-out', async () => {
    const { id, spinePath, configPath } = await seed();
    const planned = setRowState(readFileSync(spinePath, 'utf8'), id, 'planned');
    writeFileSync(spinePath, planned, 'utf8');
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--anchor',
      anchor,
      '--out',
      join(repoRoot, 'driver.js'),
      '--reviewer-agent',
      'x',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/dispatchable state/);
  });

  it('NEGATIVE CONTROL — a row with no recorded branch refuses (the ADR-0021 WAL precondition)', async () => {
    const { spinePath, configPath } = await seed();
    const noBranch = readFileSync(spinePath, 'utf8').replace(/branch wave\/[^\s"]+/, '');
    writeFileSync(spinePath, noBranch, 'utf8');
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--anchor',
      anchor,
      '--out',
      join(repoRoot, 'driver.js'),
      '--reviewer-agent',
      'x',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/spine set-branch/);
  });

  it('usage: the three required flags are named, exit 2', async () => {
    expect(await runComposeDriver([])).toBe(2);
    expect(stderr).toMatch(/--spine/);
  });

  // ── the install-step precedence, level by level (issue #717) ─────────────
  //
  // Five levels, most specific first: the row's own metadata, the compose
  // call's explicit flag, `engine.install`, the step derived from the verify
  // profile's install-shaped command, then nothing. Each is set ALONE, and each
  // adjacent pair is set IN CONFLICT — an ordering asserted only on the winners
  // would pass for any ordering that happened to agree on the cases tried.
  //
  // Read off the COMPOSED SCRIPT, which is what the dispatched agents actually
  // get, and off the receipt's `depsSetupSource`, which is what the operator
  // reads. Both, because they are two different claims: what the brief says,
  // and where it came from.

  const FROM_ROW = 'npm ci --prefix from-row';
  const FROM_FLAG = 'npm ci --prefix from-flag';
  const FROM_CONFIG = 'npm ci --prefix from-config';
  const FROM_VERIFY = 'npm ci --prefix tools/wave';

  /** Rewrite the seeded config, optionally with an `engine.install` and/or install-shaped verify command. */
  function rewriteConfig(
    configPath: string,
    opts: { install?: string; verifyInstalls?: boolean; cli?: string },
  ): void {
    const commands = opts.verifyInstalls === false
      ? [{ command: 'vitest run --root tools/wave' }]
      : [{ command: FROM_VERIFY }, { command: 'vitest run --root tools/wave' }];
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: {
          cli: opts.cli ?? SOURCE_FORM_CLI,
          ...(opts.install === undefined ? {} : { install: opts.install }),
        },
        verify: { profiles: [{ name: 'engine', appliesTo: ['tools/wave/**'], commands }] },
      }),
      'utf8',
    );
  }

  /** The `ISSUES` array the composed script carries, parsed back out of it. */
  function composedRows(script: string): Array<Record<string, unknown>> {
    const opener = 'const ISSUES = ';
    const at = script.indexOf(opener);
    expect(at).toBeGreaterThan(-1);
    const close = script.indexOf('\n]\n', at);
    expect(close).toBeGreaterThan(at);
    return JSON.parse(script.slice(at + opener.length, close + 2)) as Array<Record<string, unknown>>;
  }

  /** Compose with the given extra flags and hand back the row's step plus the receipt's source. */
  async function composeAndReadStep(
    spinePath: string,
    configPath: string,
    extraArgs: string[] = [],
  ): Promise<{ depsSetup: string; source: string }> {
    // Each compose reads its OWN receipt: the spies accumulate across calls, and
    // a stale prefix would make `JSON.parse` read the previous run's answer.
    stdout = '';
    stderr = '';
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
      ...extraArgs,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ depsSetupSource: string }> };
    return {
      depsSetup: String(composedRows(readFileSync(out, 'utf8'))[0].depsSetup),
      source: receipt.rows[0].depsSetupSource,
    };
  }

  it('EACH SOURCE ALONE — row metadata, the flag, engine.install, the verify profile, nothing', async () => {
    const { id, spinePath, configPath } = await seed();
    const rowMeta = JSON.stringify({ [id]: { depsSetup: FROM_ROW } });

    // 1. the row's own metadata, alone
    rewriteConfig(configPath, { verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath, ['--row-meta', rowMeta]))
      .toEqual({ depsSetup: FROM_ROW, source: 'row-meta' });

    // 2. the compose call's explicit flag, alone
    rewriteConfig(configPath, { verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath, ['--deps-setup', FROM_FLAG]))
      .toEqual({ depsSetup: FROM_FLAG, source: 'flag' });

    // 3. engine.install, alone
    rewriteConfig(configPath, { install: FROM_CONFIG, verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_CONFIG, source: 'engine.install' });

    // 4. the verify profile's install-shaped command, alone
    rewriteConfig(configPath, {});
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_VERIFY, source: 'verify' });

    // 5. nothing at all — composes, and says so rather than confirming anything
    rewriteConfig(configPath, { verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: '', source: 'none' });
  });

  it('EACH PAIR IN CONFLICT — the more specific source wins, at every adjacent level', async () => {
    const { id, spinePath, configPath } = await seed();
    const rowMeta = JSON.stringify({ [id]: { depsSetup: FROM_ROW } });

    // row metadata BEATS the flag
    rewriteConfig(configPath, { verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath, ['--row-meta', rowMeta, '--deps-setup', FROM_FLAG]))
      .toEqual({ depsSetup: FROM_ROW, source: 'row-meta' });

    // the flag BEATS engine.install
    rewriteConfig(configPath, { install: FROM_CONFIG, verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath, ['--deps-setup', FROM_FLAG]))
      .toEqual({ depsSetup: FROM_FLAG, source: 'flag' });

    // engine.install BEATS the verify-derived step
    rewriteConfig(configPath, { install: FROM_CONFIG });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_CONFIG, source: 'engine.install' });

    // and the verify-derived step BEATS nothing — the level that used to be the
    // only non-flag source, still answering when no binding was authored
    rewriteConfig(configPath, {});
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_VERIFY, source: 'verify' });

    // …and all four at once still resolves to the most specific
    rewriteConfig(configPath, { install: FROM_CONFIG });
    expect(await composeAndReadStep(spinePath, configPath, ['--row-meta', rowMeta, '--deps-setup', FROM_FLAG]))
      .toEqual({ depsSetup: FROM_ROW, source: 'row-meta' });
  });

  it('a BLANK at any level is not an answer — it falls through instead of manufacturing an empty step', async () => {
    const { id, spinePath, configPath } = await seed();
    rewriteConfig(configPath, { install: FROM_CONFIG, verifyInstalls: false });
    expect(
      await composeAndReadStep(spinePath, configPath, [
        '--row-meta', JSON.stringify({ [id]: { depsSetup: '   ' } }),
      ]),
    ).toEqual({ depsSetup: FROM_CONFIG, source: 'engine.install' });
  });

  // ── the gitignored-binding refusal (issue #717) ──────────────────────────
  //
  // The honest deferral above is the right answer where the row can still DO
  // its work. It is not the right answer where `engine.cli` itself resolves
  // through a path this repo gitignores: a worktree carries tracked files only,
  // so that binary is absent from every dispatched worktree, and the row could
  // neither run its verify gate nor open its PR. That is a compose-time STOP.

  /** Write (and commit) a `.gitignore` in the seeded repo. */
  function gitignore(patterns: string[]): void {
    writeFileSync(join(repoRoot, '.gitignore'), `${patterns.join('\n')}\n`, 'utf8');
  }

  it('POSITIVE CONTROL — refuses when engine.cli resolves through a gitignored path and NO source offers an install step', async () => {
    const { spinePath, configPath } = await seed();
    gitignore(['node_modules/']);
    rewriteConfig(configPath, { cli: './node_modules/.bin/flotilla-engine', verifyInstalls: false });
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
    ]);
    expect(code).toBe(1);
    // The reason names the BINDING and the PATH it resolves through, plus the
    // setup-time fix — either half alone leaves the reader guessing which one
    // to change.
    expect(stderr).toMatch(/engine\.cli/);
    expect(stderr).toContain('./node_modules/.bin/flotilla-engine');
    expect(stderr).toMatch(/gitignores/);
    expect(stderr).toMatch(/engine\.install/);
    expect(stderr).toMatch(/tracked files only/i);
    // Nothing was written: the refusal is a STOP, not a warning beside an output.
    expect(() => readFileSync(out, 'utf8')).toThrow();
  });

  it('NEGATIVE CONTROL — the SAME gitignored binding composes as soon as any install source answers', async () => {
    const { id, spinePath, configPath } = await seed();
    gitignore(['node_modules/']);

    // engine.install answers
    rewriteConfig(configPath, {
      cli: './node_modules/.bin/flotilla-engine',
      install: FROM_CONFIG,
      verifyInstalls: false,
    });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_CONFIG, source: 'engine.install' });

    // the flag answers
    rewriteConfig(configPath, { cli: './node_modules/.bin/flotilla-engine', verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath, ['--deps-setup', FROM_FLAG]))
      .toEqual({ depsSetup: FROM_FLAG, source: 'flag' });

    // the row's metadata answers
    expect(
      await composeAndReadStep(spinePath, configPath, [
        '--row-meta', JSON.stringify({ [id]: { depsSetup: FROM_ROW } }),
      ]),
    ).toEqual({ depsSetup: FROM_ROW, source: 'row-meta' });

    // the verify profile answers
    rewriteConfig(configPath, { cli: './node_modules/.bin/flotilla-engine' });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: FROM_VERIFY, source: 'verify' });
  });

  it('NEGATIVE CONTROL — a binding on an UNIGNORED path composes with no install step at all', async () => {
    const { spinePath, configPath } = await seed();
    gitignore(['node_modules/']);
    rewriteConfig(configPath, { cli: './scripts/engine.js', verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: '', source: 'none' });
  });

  // The discriminator is ABSENCE FROM A WORKTREE, not "a pattern matches the
  // name". A TRACKED file arrives in a worktree checkout even when an ignore
  // pattern would otherwise cover it, and `git check-ignore` is index-aware by
  // default — so this case must compose, and it is the one that would break if
  // the probe ever grew a `--no-index`.
  it('NEGATIVE CONTROL — a TRACKED path under an ignored directory composes: it is present in a worktree', async () => {
    const { spinePath, configPath } = await seed();
    gitignore(['vendor/']);
    mkdirSync(join(repoRoot, 'vendor'), { recursive: true });
    writeFileSync(join(repoRoot, 'vendor', 'engine.js'), '// engine\n', 'utf8');
    execFileSync('git', ['-C', repoRoot, 'add', '-f', 'vendor/engine.js']);
    execFileSync('git', [
      '-C', repoRoot,
      '-c', 'user.email=t@example.invalid',
      '-c', 'user.name=t',
      'commit', '-q', '-m', 'track the binding',
    ]);
    rewriteConfig(configPath, { cli: './vendor/engine.js', verifyInstalls: false });
    expect(await composeAndReadStep(spinePath, configPath))
      .toEqual({ depsSetup: '', source: 'none' });
  });

  it('the refusal tests the ROW, not the repo: a gitignored binding with a step is a wholly ordinary compose', async () => {
    const { spinePath, configPath } = await seed();
    gitignore(['node_modules/']);
    // Both an `engine.install` AND a verify-derived step available — the
    // ordinary shape of the consumer this issue came from, which must stay a
    // clean exit-0 compose rather than becoming collateral of the new gate.
    rewriteConfig(configPath, { cli: './node_modules/.bin/flotilla-engine', install: FROM_CONFIG });
    expect((await composeAndReadStep(spinePath, configPath)).source).toBe('engine.install');
  });
});

// ─── issue #888: the bare-id strip's separator fix, exercised through the
// real verb ──────────────────────────────────────────────────────────────
//
// Unit coverage for `stripBareIds` itself lives in "the derivations" above;
// this is AC3's composed-title pin — the same slash-joined shape row 800's
// own tracker title carried, run through `runComposeDriver` rather than the
// function in isolation — plus AC2's compose-time notice, proven to fire on a
// title the strip cannot cleanly repair (Convention 11) and proven silent on
// one it can (the pin test's own empty-stderr assertion is that restored-green
// case).
describe('compose-driver — the bare-id strip separator fix, end to end (issue #888)', () => {
  let repoRoot: string;
  let anchor: string;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const SLUG = '2026-09-21-separator-fix';

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  }

  async function seed(title: string): Promise<{ id: string; spinePath: string; configPath: string }> {
    const store = new MarkdownFsStore({ repoRoot, slug: SLUG });
    const id = await store.create({
      title,
      filingHint: 'separator-fix',
      risk: 'isolated-refactor',
      worker: 'background',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'the separator is consumed', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'Fix the strip.' }],
    });

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'separator fix',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-21',
        lastUpdated: '2026-09-21',
      },
      [{ id, title, worker: 'background', risk: 'isolated-refactor' }],
      { issues: [], cells: [] },
      'ok',
    );
    spine = setRowState(spine, id, 'dispatched');
    spine = upsertDispatchLogEntry(spine, id, `wave/${id}-separator-fix`);
    spine = upsertDispatchLogModel(spine, id, 'sonnet');

    const spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    writeFileSync(spinePath, spine, 'utf8');

    const configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI },
        verify: {
          profiles: [
            {
              name: 'engine',
              appliesTo: ['tools/wave/**'],
              commands: [
                { command: 'npm ci --prefix tools/wave' },
                { command: 'vitest run --root tools/wave' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    return { id, spinePath, configPath };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compose-driver-sep-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q']);
    execFileSync('git', [
      '-C',
      repoRoot,
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'anchor',
    ]);
    anchor = git('rev-parse', 'HEAD');
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function compose(title: string, outName: string) {
    const { id, spinePath, configPath } = await seed(title);
    const out = join(repoRoot, outName);
    const code = await runComposeDriver([
      '--spine',
      spinePath,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--anchor',
      anchor,
      '--out',
      out,
      '--reviewer-agent',
      'flotilla:wave-reviewer',
    ]);
    return { id, code, out };
  }

  function prTitleFor(scriptPath: string, id: string): unknown {
    const script = readFileSync(scriptPath, 'utf8');
    const at = script.indexOf('const ISSUES = ');
    const close = script.indexOf('\n]\n', at);
    const rows = JSON.parse(script.slice(at + 'const ISSUES = '.length, close + 2)) as Array<
      Record<string, unknown>
    >;
    return rows.find((r) => r.id === id)?.prTitle;
  }

  it('AC3 — a slash-joined title of the shape the live row carried composes with no dangling separator, and stays silent (the restored-green case)', async () => {
    const LIVE_SLASH_TITLE =
      'Residue after #751/#772: the STILL OPEN sentence stays only in the residual issue';
    const { id, code, out } = await compose(LIVE_SLASH_TITLE, 'driver.js');
    expect(code).toBe(0);
    expect(stderr).toBe(''); // a clean strip: no compose-time notice
    const prTitle = prTitleFor(out, id);
    expect(prTitle).toBe(
      'Residue after : the STILL OPEN sentence stays only in the residual issue',
    );
    expect(String(prTitle)).not.toContain('/');
  });

  it('AC2 FALSIFICATION — a title the strip cannot cleanly repair produces a compose-time notice, not a silent write (Convention 11)', async () => {
    // A doubled slash is not one of the three recognised join shapes, so the
    // strip falls through to the single-id branches and leaves the doubled
    // separator standing — the shape the notice exists to catch.
    const MALFORMED_TITLE = 'Residue after #100 // #200: note';
    const { id, code, out } = await compose(MALFORMED_TITLE, 'driver.js');
    // The notice does not stop the compose — the row still gets a title, and
    // the Coordinator (who reads compose-driver's stderr) decides whether it
    // needs a hand fix via --row-meta.
    expect(code).toBe(0);
    expect(stderr).toMatch(/^notice: compose-driver: row .*: the bare-id strip left a doubled "\/"/m);
    expect(stderr).toContain(id);
    expect(stderr).toContain('Residue after // : note');
    expect(prTitleFor(out, id)).toBe('Residue after // : note');
  });
});

// ─── issue #767: a `model` word inside the BRANCH slug must not shadow the
// recorded model tier ──────────────────────────────────────────────────────
//
// The end-to-end receipt-level regression for the wave-md-rw.ts MODEL_REF fix
// (see wave-md-rw.spec.ts "dispatch-log model parsing stays clear of a
// `model`-shaped branch slug (issue #767)" for the reader/writer-level cases).
// This exercises the real bug report shape through the actual compose-driver
// verb: a row whose branch slug ends in the word `model`, composed with the
// engine's `modelByRow` derivation, must come out with the recorded tier, not
// the literal word `model`.
describe('compose-driver — a `model`-shaped branch slug does not shadow the recorded tier (issue #767)', () => {
  let repoRoot: string;
  let anchor: string;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const SLUG = '2026-09-16-model-shadow';

  async function seed(filingHint: string): Promise<{ id: string; spinePath: string; configPath: string }> {
    const store = new MarkdownFsStore({ repoRoot, slug: SLUG });
    const id = await store.create({
      title: 'Delete old board view model',
      filingHint,
      risk: 'isolated-refactor',
      worker: 'background',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'the old view model is gone', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'Delete it.' }],
    });

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'model-shadow regression',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-16',
        lastUpdated: '2026-09-16',
      },
      [{ id, title: 'Delete old board view model', worker: 'background', risk: 'isolated-refactor' }],
      { issues: [], cells: [] },
      'ok',
    );
    spine = setRowState(spine, id, 'dispatched');
    spine = upsertDispatchLogEntry(spine, id, `wave/${id}-${filingHint}`);
    spine = upsertDispatchLogModel(spine, id, 'sonnet');

    const spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    writeFileSync(spinePath, spine, 'utf8');

    const configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI },
        verify: { profiles: [] },
      }),
      'utf8',
    );
    return { id, spinePath, configPath };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compose-driver-model-shadow-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q']);
    execFileSync('git', [
      '-C', repoRoot,
      '-c', 'user.email=t@example.invalid',
      '-c', 'user.name=t',
      'commit', '--allow-empty', '-q', '-m', 'anchor',
    ]);
    anchor = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('a branch slug ending in the word `model` still composes the recorded tier, not the literal word', async () => {
    const { id, spinePath, configPath } = await seed('delete-old-board-view-model');
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string; branch: string }> };
    const row = receipt.rows.find((r) => r.id === id);
    expect(row?.branch).toBe(`wave/${id}-delete-old-board-view-model`);
    expect(row?.model).toBe('sonnet');
  });

  it('CONTROL — a branch slug without the word `model` composes the same recorded tier', async () => {
    const { id, spinePath, configPath } = await seed('delete-dead-board-vm');
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string; branch: string }> };
    const row = receipt.rows.find((r) => r.id === id);
    expect(row?.branch).toBe(`wave/${id}-delete-dead-board-vm`);
    expect(row?.model).toBe('sonnet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0012 Amendments 2026-09-16 and 2026-09-21 — the engine derives a TIER,
// never a model id; the CONSUMER binds the tier, per row or standing.
//
// Three separate claims, each with its own falsifiable pin:
//   1. No model brand is spelled in the composer module or the shipped driver
//      template — including the template's own `ISSUES` placeholder comment,
//      which is the copy an operator READS even though nothing extracts it now,
//      and including the Scribe stage's own former literal, retired by the
//      2026-09-21 amendment through the `models.scribe` config key.
//   2. `tierForRisk` answers with the abstract marker only, for all four
//      default Risk values, and nothing in the ENGINE maps that marker to an id
//      — the only thing that maps it is the CONSUMER's own `models` block, read
//      as an opaque string exactly as a recorded `--model` is.
//   3. A row's `model` is ECHOED from what the consumer declared — row-meta
//      first, then the spine dispatch-log entry, then `models.<tier>` — and a
//      row with none of the three is refused before the script is written.
// ─────────────────────────────────────────────────────────────────────────────

describe('compose-driver — no model brand is spelled in the engine or the shipped template (ADR-0012 Amendments 2026-09-16 / 2026-09-21)', () => {
  /**
   * The three literals these amendments retired, each assembled at runtime from
   * two halves so this spec file's OWN source does not spell any one of them.
   * That is not cosmetic: the pin's whole claim is that a repo-wide search for
   * these names lands on nothing in the engine, and a guard that writes them
   * out would be the one hit a reader then has to explain away.
   *
   * The third entry is the Scribe stage's own former binding — the last
   * concrete model id in the shipped driver, and the one the 2026-09-16 pin
   * could not see because that row scanned only for the two it had retired.
   */
  const RETIRED_LITERALS = [
    { label: 'the heavy-tier brand', literal: `op${'us'}` },
    { label: 'the standard-tier brand', literal: `sonn${'et'}` },
    { label: "the Scribe stage's former brand", literal: `hai${'ku'}` },
  ].map(({ label, literal }) => ({
    label,
    literal,
    pattern: new RegExp(`\\b${literal}\\b`, 'i'),
  }));

  /**
   * Both sources the amendment binds: the composer that used to return the
   * literals, and the shipped template that used to document them. Read from
   * disk, so the pin sees what actually ships rather than what an import
   * re-exports.
   */
  const SOURCES = [
    { label: 'tools/wave/src/compose-driver.ts', text: readFileSync(join(__dirname, 'compose-driver.ts'), 'utf8') },
    { label: 'tools/wave/driver/wave-start-inflight.js', text: TEMPLATE },
  ] as const;

  it('the scan actually has something to read (a guard over an empty string is green for the wrong reason)', () => {
    for (const source of SOURCES) {
      expect(source.text.length, source.label).toBeGreaterThan(1000);
    }
    // ...and both really do still talk about models, so "no hit" is a fact
    // about the BRAND, never about the topic having vanished from the file.
    for (const source of SOURCES) {
      expect(source.text, source.label).toMatch(/\bmodel\b/);
    }
  });

  it.each(SOURCES.map((s) => [s.label, s.text] as const))(
    '%s contains neither retired model literal',
    (label, text) => {
      for (const { label: which, pattern } of RETIRED_LITERALS) {
        expect(pattern.test(text), `${label} still spells ${which} (${pattern})`).toBe(false);
      }
    },
  );

  it("the template's ISSUES placeholder comment describes the model as recorded, not as a default to pick", () => {
    const at = TEMPLATE.indexOf('const ISSUES = ');
    expect(at).toBeGreaterThan(-1);
    const rowLiteral = TEMPLATE.slice(at, TEMPLATE.indexOf('anchorSha:', at));
    expect(rowLiteral).toMatch(/spine set-branch --model/);
    expect(rowLiteral).toMatch(/REFUSES/);
    // The abstract markers are named there; no id is.
    expect(rowLiteral).toMatch(/`heavy`/);
    expect(rowLiteral).toMatch(/`standard`/);
    // …and, since the 2026-09-21 amendment, the THIRD rung the refusal names.
    // An operator reading this comment has to learn that a standing config key
    // can answer where a per-row recording did not.
    expect(rowLiteral).toMatch(/`models\.<tier>`/);
  });

  it("the Scribe constant's own comment states the chain and forbids the omitted-key floor", () => {
    // The stage's binding is the one place a reader could reasonably guess the
    // old behaviour back (a cheap fixed tier), so the constant carries the
    // chain in prose beside it — with the reason the chain may not bottom out
    // in an absent `model` key, which is the outcome that silently re-inherits
    // the session model per stage.
    const at = TEMPLATE.indexOf('const SCRIBE_MODEL = ');
    expect(at).toBeGreaterThan(-1);
    const region = TEMPLATE.slice(TEMPLATE.indexOf('// SCRIBE_MODEL IS'), at);
    expect(region).toMatch(/models\.scribe/);
    expect(region).toMatch(/models\.standard/);
    expect(region).toMatch(/NO `model` key at all/);
    expect(region).toMatch(/re-inherits/);
  });

  it('NEGATIVE CONTROL — the scan fires when either literal is re-introduced into either source', () => {
    for (const { literal, pattern } of RETIRED_LITERALS) {
      for (const source of SOURCES) {
        const poisoned = `${source.text}\nconst RETUNE = '${literal}'\n`;
        expect(pattern.test(poisoned), `${source.label} + ${literal}`).toBe(true);
      }
    }
  });
});

describe('compose-driver — the Risk-derived helper returns an abstract tier marker and no ENGINE code maps it to an id (ADR-0012 Amendments 2026-09-16 / 2026-09-21)', () => {
  /** The four default Risk values, from ADR-0007's frozen enum. */
  const DEFAULT_RISKS: Array<[string, string]> = [
    ['mechanical', 'standard'],
    ['isolated-refactor', 'standard'],
    ['cross-feature-refactor', 'heavy'],
    ['public-API-change', 'heavy'],
  ];

  it.each(DEFAULT_RISKS)('Risk `%s` derives the `%s` tier marker', (risk, tier) => {
    expect(tierForRisk(risk)).toBe(tier);
  });

  it('answers only those two markers — there is no third value and no id-shaped one', () => {
    const answers = new Set(DEFAULT_RISKS.map(([risk]) => tierForRisk(risk)));
    expect([...answers].sort()).toEqual(['heavy', 'standard']);
    // An unknown Risk falls to the standard marker rather than inventing one.
    expect(tierForRisk('something-nobody-configured')).toBe('standard');
  });

  it('the old spelling is GONE as a symbol — the helper says what it returns', () => {
    // The rename is the point of this half: `modelForRisk` answered with a tier
    // from the moment the literal fallback was retired, and survived only
    // because the barrel-drift allowlist pinned the spelling from outside that
    // row's globs. A source-level scan, because a removed export cannot be
    // imported to assert its absence.
    const composer = readFileSync(join(__dirname, 'compose-driver.ts'), 'utf8');
    expect(composer).not.toMatch(/\bmodelForRisk\b/);
    expect(composer).toMatch(/export function tierForRisk\(/);
  });

  it('the composer reads the helper for the TIER only — the id it binds is a value the consumer wrote', () => {
    const composer = readFileSync(join(__dirname, 'compose-driver.ts'), 'utf8');
    // The helper survives for TWO purposes, and neither is an id: naming the
    // tier inside the refusal, and choosing WHICH key of the consumer's own
    // `models` block to read. Reading a consumer's string at a key the engine
    // names is not the engine knowing a model.
    expect([...composer.matchAll(/tierForRisk\(/g)].length).toBeGreaterThan(0);
    const ladderRegion = composer.slice(
      composer.indexOf('const tier = tierForRisk(view.risk);'),
      composer.indexOf('const composed: DriverRow ='),
    );
    expect(ladderRegion).not.toBe('');
    // The refusal names the tier it derived...
    expect(ladderRegion).toContain('${tier} tier');
    // ...and the third rung is a lookup in the CONSUMER's block, keyed by it.
    expect(ladderRegion).toContain('configuredTierModel(config.models, tier)');
    // The lookup itself maps a marker to a CONFIG VALUE and never to a literal.
    const lookup = composer.slice(
      composer.indexOf('function configuredTierModel('),
      composer.indexOf('function scribeModelFrom('),
    );
    expect(lookup).toContain('models.heavy');
    expect(lookup).toContain('models.standard');
    // ...and the row's own value is the resolved one, with no `??` chain to a
    // literal left anywhere.
    expect(composer).toContain('model: resolvedModel,');
    expect(composer).not.toMatch(/model:\s*meta\.model\s*\?\?\s*modelByRow/);
  });
});

describe('compose-driver — the row-model ladder, end to end (ADR-0012 Amendments 2026-09-16 / 2026-09-21)', () => {
  let repoRoot: string;
  let anchor: string;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const SLUG = '2026-09-16-echoed-model';
  const HINT = 'echo-the-recorded-model';

  /**
   * One dispatchable row. `recordedModel` is written onto the dispatch-log
   * entry exactly as `spine set-branch --model` writes it; passing `null`
   * records the BRANCH and no model, which is the shape the refusal exists
   * for — a spine that a Coordinator built without the flag.
   *
   * `models` is this consumer's own standing block (ADR-0012 Amendment
   * 2026-09-21) — the THIRD rung, and omitted from the written config entirely
   * when not passed, so every pre-existing case below composes against the
   * byte-identical config it always did.
   */
  async function seed(
    recordedModel: string | null,
    models?: Record<string, string>,
  ): Promise<{
    id: string;
    spinePath: string;
    configPath: string;
  }> {
    const store = new MarkdownFsStore({ repoRoot, slug: SLUG });
    const id = await store.create({
      title: 'Echo the recorded model',
      filingHint: HINT,
      risk: 'cross-feature-refactor',
      worker: 'background-heavy',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'the model is echoed', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'Echo it.' }],
    });

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'echoed model',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-16',
        lastUpdated: '2026-09-16',
      },
      [
        {
          id,
          title: 'Echo the recorded model',
          worker: 'background-heavy',
          risk: 'cross-feature-refactor',
        },
      ],
      { issues: [], cells: [] },
      'ok',
    );
    spine = setRowState(spine, id, 'dispatched');
    spine = upsertDispatchLogEntry(spine, id, `wave/${id}-${HINT}`);
    if (recordedModel !== null) spine = upsertDispatchLogModel(spine, id, recordedModel);

    const spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    writeFileSync(spinePath, spine, 'utf8');

    const configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI, install: 'npm ci --prefix tools/wave' },
        verify: { profiles: [] },
        ...(models ? { models } : {}),
      }),
      'utf8',
    );
    return { id, spinePath, configPath };
  }

  function compose(spinePath: string, configPath: string, out: string, extra: string[] = []) {
    return runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
      ...extra,
    ]);
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compose-driver-echoed-model-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q']);
    execFileSync('git', [
      '-C', repoRoot,
      '-c', 'user.email=t@example.invalid',
      '-c', 'user.name=t',
      'commit', '--allow-empty', '-q', '-m', 'anchor',
    ]);
    anchor = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('refuses a row no rung answers for — naming the row, its tier and all three remedies', async () => {
    const { id, spinePath, configPath } = await seed(null);
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out);

    expect(code).not.toBe(0);
    expect(stderr).toContain(id);
    // The row's Risk is cross-feature-refactor, so the refusal names the HEAVY
    // tier marker — the abstract half the engine does own.
    expect(stderr).toContain('heavy');
    expect(stderr).toContain('spine set-branch');
    expect(stderr).toContain('--model');
    expect(stderr).toContain('--row-meta');
    // …and, since the 2026-09-21 amendment, the standing config key beside it.
    // A refusal that names only the per-row remedies would send an operator to
    // record the same id on every wave for ever.
    expect(stderr).toContain('models.heavy');
    // "before anything is written" is the load-bearing half: no script exists.
    expect(existsSync(out)).toBe(false);
  });

  it('POSITIVE CONTROL — the recorded model reaches the composed row byte-identically', async () => {
    const recorded = 'consumer-chosen-model-id-9';
    const { id, spinePath, configPath } = await seed(recorded);
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out);

    expect(stderr).toBe('');
    expect(code).toBe(0);

    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe(recorded);

    const script = readFileSync(out, 'utf8');
    const at = script.indexOf('const ISSUES = ');
    const close = script.indexOf('\n]\n', at);
    const rows = JSON.parse(script.slice(at + 'const ISSUES = '.length, close + 2)) as Array<
      Record<string, unknown>
    >;
    expect(rows[0].model).toBe(recorded);
  });

  it('a `--row-meta` model outranks the dispatch-log entry, and rescues a spine that records none', async () => {
    const { id, spinePath, configPath } = await seed(null);
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out, [
      '--row-meta',
      JSON.stringify({ [id]: { model: 'override-model-id' } }),
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe('override-model-id');
  });

  // ── rung 3: the standing `models.<tier>` binding (Amendment 2026-09-21) ────
  //
  // The row's Risk is `cross-feature-refactor`, so every case below reads the
  // HEAVY key. `models.standard` rides along in each fixture precisely so a
  // pass proves the tier was SELECTED rather than the block being read as one
  // undifferentiated answer.

  it('rung 3 ANSWERS: `models.<tier>` binds a row whose spine records nothing', async () => {
    const { id, spinePath, configPath } = await seed(null, {
      heavy: 'configured-heavy-id',
      standard: 'configured-standard-id',
    });
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    // The HEAVY key, not the standard one — the tier is derived from Risk.
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe('configured-heavy-id');
  });

  it('rung 3 does NOT answer for a tier it does not declare — the refusal still fires', async () => {
    // NEGATIVE CONTROL for the rung above: a `models` block that binds only the
    // OTHER tier must leave this row exactly as refused as no block at all.
    // Without this, "rung 3 answers" would be compatible with "any models block
    // answers for any row".
    const { id, spinePath, configPath } = await seed(null, { standard: 'configured-standard-id' });
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out);

    expect(code).not.toBe(0);
    expect(stderr).toContain(id);
    expect(stderr).toContain('models.heavy');
    expect(existsSync(out)).toBe(false);
  });

  it('the RECORDED model outranks `models.<tier>` — the per-row act still wins', async () => {
    const { id, spinePath, configPath } = await seed('recorded-for-this-row', {
      heavy: 'configured-heavy-id',
      standard: 'configured-standard-id',
    });
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe('recorded-for-this-row');
  });

  it('`--row-meta` outranks BOTH — the whole ladder, top to bottom, in one compose', async () => {
    const { id, spinePath, configPath } = await seed('recorded-for-this-row', {
      heavy: 'configured-heavy-id',
    });
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out, [
      '--row-meta',
      JSON.stringify({ [id]: { model: 'override-model-id' } }),
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    // The receipt's `model` shows the WINNER — which is the whole point of it
    // being on the receipt at all.
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe('override-model-id');
  });

  it('a BLANK at a rung is not an answer — the next rung down still gets to speak', async () => {
    // `resolveDepsSetup`'s rule, applied to the model ladder: an explicit `""`
    // that outranked a real binding would compose a row no dispatch can use.
    const { id, spinePath, configPath } = await seed(null, { heavy: 'configured-heavy-id' });
    const out = join(repoRoot, 'driver.js');
    const code = await compose(spinePath, configPath, out, [
      '--row-meta',
      JSON.stringify({ [id]: { model: '   ' } }),
    ]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as { rows: Array<{ id: string; model: string }> };
    expect(receipt.rows.find((r) => r.id === id)?.model).toBe('configured-heavy-id');
  });

  // ── the Scribe stage's own binding (Amendment 2026-09-21) ─────────────────
  //
  // Asserted through the RUN HELPER's captured Scribe options rather than off
  // the composed text: what matters is the `model` a Scribe `agent()` call
  // actually carries, and only a run shows that. All three chain cases, plus
  // the property the chain exists for — the key is never absent.

  /** Every Scribe `agent()` call's options from one composed script's run. */
  async function scribeOptions(out: string): Promise<Array<Record<string, unknown>>> {
    const { calls } = await runComposedDriver(readFileSync(out, 'utf8'));
    const scribes = calls.filter((c) => String(c.opts.label ?? '').startsWith('scribe-'));
    // Guard the fixture before any claim rests on it: report + verdict.
    expect(scribes.length).toBe(2);
    return scribes.map((c) => c.opts);
  }

  it('`models.scribe` binds the Scribe stage', async () => {
    const { spinePath, configPath } = await seed('recorded-for-this-row', {
      scribe: 'configured-scribe-id',
      standard: 'configured-standard-id',
      heavy: 'configured-heavy-id',
    });
    const out = join(repoRoot, 'driver.js');
    expect(await compose(spinePath, configPath, out)).toBe(0);
    for (const opts of await scribeOptions(out)) {
      expect(opts.model).toBe('configured-scribe-id');
    }
  });

  it('with no `models.scribe`, `models.standard` binds it — never the heavy row model', async () => {
    const { spinePath, configPath } = await seed('recorded-for-this-row', {
      standard: 'configured-standard-id',
      heavy: 'configured-heavy-id',
    });
    const out = join(repoRoot, 'driver.js');
    expect(await compose(spinePath, configPath, out)).toBe(0);
    for (const opts of await scribeOptions(out)) {
      expect(opts.model).toBe('configured-standard-id');
      // The discriminator: this row IS heavy, and the Scribe must not inherit
      // that — it is a fixed cheap stage, not a Risk-derived tier.
      expect(opts.model).not.toBe('configured-heavy-id');
    }
  });

  it("with no `models` block at all, the row's own recorded model binds it — and the key is never omitted", async () => {
    const { spinePath, configPath } = await seed('recorded-for-this-row');
    const out = join(repoRoot, 'driver.js');
    expect(await compose(spinePath, configPath, out)).toBe(0);
    for (const opts of await scribeOptions(out)) {
      expect(opts.model).toBe('recorded-for-this-row');
      // The property the whole chain exists for (Coordinator ruling
      // 2026-09-21): a stage dispatched with NO `model` key silently
      // re-inherits the session model, per stage.
      expect(Object.prototype.hasOwnProperty.call(opts, 'model')).toBe(true);
      expect(opts.model).not.toBe('');
      expect(opts.model).not.toBeUndefined();
    }
  });

  it('the receipt reports the Scribe binding — `null` when this consumer declares none', async () => {
    const bare = await seed('recorded-for-this-row');
    const out = join(repoRoot, 'driver.js');
    expect(await compose(bare.spinePath, bare.configPath, out)).toBe(0);
    expect((JSON.parse(stdout) as { scribeModel: string | null }).scribeModel).toBeNull();

    stdout = '';
    const bound = await seed('recorded-for-this-row', { scribe: 'configured-scribe-id' });
    const out2 = join(repoRoot, 'driver2.js');
    expect(await compose(bound.spinePath, bound.configPath, out2)).toBe(0);
    expect((JSON.parse(stdout) as { scribeModel: string | null }).scribeModel).toBe(
      'configured-scribe-id',
    );
  });
});

describe('compose-driver — the rendered Reviewer brief cites no policy clause it does not have (issue #753)', () => {
  const rows = [row({ id: '42', slug: 'first' })];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  /** The two RENDERED briefs from one composed run — not the template's text. */
  async function briefs(): Promise<{ worker: string; reviewer: string }> {
    const { calls } = await runComposedDriver(script);
    const at = (label: string) => calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    const worker = at('worker:42');
    const reviewer = at('review:42');
    // Guard the fixture before any claim rests on it.
    expect(worker).toContain('You are a Wave Worker');
    expect(reviewer).toContain('You are the Wave Reviewer');
    return { worker, reviewer };
  }

  it('the rendered Reviewer brief contains no "policy clause" citation at all', async () => {
    const { reviewer } = await briefs();
    expect(reviewer).not.toMatch(/policy clause/i);
  });

  it("attributes the guard's live rejection of the value-free presence test to the Reviewer brief's OWN rule", async () => {
    const { reviewer } = await briefs();
    // The sentence is still there — this row changed what it cites, not what it
    // says. (Issue #933 later moved it to the PAST tense: the refusal it
    // reports was retired by the 2026-09-22 re-measurement. Which rule it
    // cites, the claim this block guards, did not move.)
    expect(reviewer).toMatch(/the command the guard once rejected outright, live, when a Worker ran it/);
    // ...and it now points at the rule the Reviewer brief actually carries.
    expect(reviewer).toMatch(/\*\*ONE BASH CALL PER STEP\*\* rule directly above \(wave-shared Convention 13\)/);
    // The rule it names is genuinely in this brief, above that sentence.
    const ruleAt = reviewer.indexOf('**ONE BASH CALL PER STEP** (wave-shared Convention 13)');
    const citeAt = reviewer.indexOf('rejected outright, live, when a Worker ran it');
    expect(ruleAt).toBeGreaterThan(-1);
    expect(citeAt).toBeGreaterThan(ruleAt);
  });

  it('POSITIVE CONTROL — the rendered Worker brief, which DOES have the numbered list, still carries clauses 1–12', async () => {
    const { worker } = await briefs();
    expect(worker).toContain('## Policy clauses (obey verbatim)');
    for (let n = 1; n <= 12; n += 1) {
      expect(worker, `Worker brief lost policy clause ${n}`).toMatch(
        new RegExp(`^${n}\\. `, 'm'),
      );
    }
    // And the Worker brief's own citations of that list are untouched.
    expect(worker).toMatch(/policy clause 11/);
    expect(worker).toMatch(/policy clause 12/);
  });

  it('NEGATIVE CONTROL — the no-citation pin fires against a template that still carries the stale reference', async () => {
    const stale = TEMPLATE.replace(
      'the \\`\\$VAR\\`-expansion shape the **ONE BASH CALL PER STEP** rule directly above (wave-shared Convention 13) names',
      '(policy clause 11 above)',
    );
    expect(stale).not.toEqual(TEMPLATE); // the replace actually matched
    const { calls } = await runComposedDriver(
      composeDriverScript({ template: stale, ...CONSTANTS, rows }),
    );
    const reviewer = calls.find((c) => String(c.opts.label) === 'review:42')?.brief ?? '';
    expect(reviewer).toContain('You are the Wave Reviewer');
    expect(reviewer).toMatch(/policy clause/i);
  });
});

describe("compose-driver — the RENDERED Worker brief carries Convention 13's fourth-shape clause (issue #911)", () => {
  const rows = [row({ id: '42', slug: 'first' })];

  /**
   * The clause's two halves as they read AFTER rendering — the template escapes
   * its backticks (`\`{\``), the composed brief does not, so a pin written
   * against the TEMPLATE text would not catch a rendering that mangled them.
   * That is the whole reason this pin is here and not only in
   * `skill-schema-drift.spec.ts`, which reads the asset: that spec proves the
   * clause survives EDITING, this one proves it survives COMPOSITION and lands
   * in the copy a live dispatch is actually handed.
   */
  const TRIGGER = 'a heredoc whose body carries a literal `{` or `}` near its head';
  const REMEDY = '**PREFER YOUR FILE-EDITING TOOL OVER A SHELL HEREDOC FOR EVERY CONTENT WRITE YOU MAKE**';

  async function workerBrief(template: string): Promise<string> {
    const { calls } = await runComposedDriver(
      composeDriverScript({ template, ...CONSTANTS, rows }),
    );
    const brief = calls.find((c) => String(c.opts.label) === 'worker:42')?.brief ?? '';
    expect(brief).toContain('You are a Wave Worker'); // guard the fixture before any claim rests on it
    return brief;
  }

  it('the trigger and its remedy both reach the dispatched brief', async () => {
    const worker = await workerBrief(TEMPLATE);
    expect(worker).toContain(TRIGGER);
    expect(worker).toContain(REMEDY);
  });

  it('NEGATIVE CONTROL — a template with the clause cut renders a brief without it', async () => {
    const cut = TEMPLATE.replace(
      /\*\*A FOURTH SHAPE is refused the same way[\s\S]*?for its own payload\./,
      '',
    );
    expect(cut).not.toEqual(TEMPLATE); // the replace actually matched
    const worker = await workerBrief(cut);
    expect(worker).not.toContain(TRIGGER);
    expect(worker).not.toContain(REMEDY);
  });
});

describe('compose-driver — the RENDERED briefs carry the re-measured variable-expansion reason, not the retired one (issue #933)', () => {
  const rows = [row({ id: '42', slug: 'first' })];

  /**
   * Convention 13's Catalog entry 1 claimed a `$VAR` expansion was refused in
   * ANY position from a worktree-isolated dispatch; the 2026-09-22
   * re-measurement retired it (a `$VAR` expansion is not refused on its own in
   * any position probed, and exactly one variable-bearing shape still is).
   *
   * These are the four wordings the asset carried as a CURRENT fact, and the
   * wordings that replaced them — written as they read AFTER rendering, where
   * the template's escaped backticks have become plain ones. That is the whole
   * reason this block exists beside `skill-schema-drift.spec.ts`'s: a pin
   * written against the TEMPLATE cannot catch a composition that mangles the
   * passage on its way into the brief a live dispatch is handed.
   */
  const SITES: ReadonlyArray<{ role: 'worker' | 'reviewer'; site: string; retired: string; current: string }> = [
    {
      role: 'worker',
      site: 'policy clause 11',
      retired: '**The discriminator is the `$VAR` expansion, not the punctuation**',
      current:
        '**a 2026-09-22 re-measurement from a worktree-isolated dispatch RETIRED that claim: ' +
        'a `$VAR` expansion is NOT refused on its own, in any position probed**',
    },
    {
      role: 'worker',
      site: 'Termination step 4 re-query rationale',
      retired:
        'The discriminator is not fusion and not the control structure: it is the ' +
        '**`$VAR` expansion**, refused in any position, in any call',
      current:
        '**A 2026-09-22 re-measurement, re-run live from a worktree-isolated dispatch, ' +
        'RETIRED those refusals**',
    },
    {
      role: 'reviewer',
      site: 'ONE BASH CALL PER STEP paragraph',
      retired: '`case`/`esac` has been observed refused standing entirely alone',
      current: '`case`/`esac` was once observed refused standing entirely alone',
    },
    {
      role: 'reviewer',
      site: 'SECRET-SAFE paragraph',
      retired: 'is exactly the command the guard has rejected outright, live, when a Worker ran it',
      current: 'is the command the guard once rejected outright, live, when a Worker ran it',
    },
  ];

  /** The two RENDERED briefs from one composed run — not the template's text. */
  async function briefs(template: string): Promise<Record<'worker' | 'reviewer', string>> {
    const { calls } = await runComposedDriver(
      composeDriverScript({ template, ...CONSTANTS, rows }),
    );
    const at = (label: string) => calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    const worker = at('worker:42');
    const reviewer = at('review:42');
    // Guard the fixture before any claim rests on it.
    expect(worker).toContain('You are a Wave Worker');
    expect(reviewer).toContain('You are the Wave Reviewer');
    return { worker, reviewer };
  }

  /** The sites whose RENDERED brief still states the retired claim. */
  function staleSites(rendered: Record<'worker' | 'reviewer', string>): string[] {
    return SITES.filter((s) => rendered[s.role].includes(s.retired)).map((s) => `${s.role}: ${s.site}`);
  }

  /** The sites whose replacement wording did not reach the RENDERED brief. */
  function unrepairedSites(rendered: Record<'worker' | 'reviewer', string>): string[] {
    return SITES.filter((s) => !rendered[s.role].includes(s.current)).map((s) => `${s.role}: ${s.site}`);
  }

  it('no dispatched brief states the retired claim, and every site carries the re-measured one', async () => {
    const rendered = await briefs(TEMPLATE);
    expect(staleSites(rendered)).toEqual([]);
    expect(unrepairedSites(rendered)).toEqual([]);
  });

  it('the prescriptions reach the dispatched briefs intact, each with the surviving reason attached', async () => {
    const { worker, reviewer } = await briefs(TEMPLATE);
    // Re-query over capture, in both briefs that prescribe it…
    expect(worker).toContain(
      'so a captured URL is simply not there in the call that would spend it, and a guard on it ' +
        'would inspect an unset variable whether or not anything refuses the shape',
    );
    expect(reviewer).toContain(
      'so a value must still be re-queried in the call that needs it rather than carried, refusal or no refusal',
    );
    // …nothing carried across a call boundary…
    expect(worker).toContain(
      'so a captured value is unreadable in the call that would spend it whether or not anything ' +
        'refuses the shape, which is why a value must never be carried from one call to the next',
    );
    // …and the file-editing tool over a shell heredoc, whose own refusal the
    // re-measurement did NOT retire.
    expect(worker).toContain(
      '**PREFER YOUR FILE-EDITING TOOL OVER A SHELL HEREDOC FOR EVERY CONTENT WRITE YOU MAKE**',
    );
    // The Reviewer is told the heredoc still refuses, so it cannot read the
    // retirement as covering entry 2 as well.
    expect(reviewer).toContain('the brace-bearing heredoc of Catalog entry 2 still refuses too');
  });

  it('NEGATIVE CONTROL — a template drifted back to the retired wording renders briefs the pin rejects', async () => {
    const stale = SITES.reduce((template, s) => {
      // The template escapes its backticks; the rendered brief does not, so the
      // drift-back is applied in the template's own spelling.
      const esc = (text: string) => text.replaceAll('`', '\\`');
      const next = template.replace(esc(s.current), esc(s.retired));
      expect(next, `drift-back replacement did not match at ${s.role}: ${s.site}`).not.toEqual(template);
      return next;
    }, TEMPLATE);

    const rendered = await briefs(stale);
    // Shown, not asserted: every one of the four sites is reported.
    expect(staleSites(rendered)).toEqual(SITES.map((s) => `${s.role}: ${s.site}`));
    expect(unrepairedSites(rendered)).toEqual(SITES.map((s) => `${s.role}: ${s.site}`));
  });
});

describe('compose-driver — the RENDERED Worker brief states truthfully what lands on the default branch (ADR-0053)', () => {
  const rows = [row({ id: '42', slug: 'first' })];

  /**
   * The claim ADR-0053 retired. The brief told the Worker its PR title was,
   * "on a single-commit squash, what lands on the default branch" — the inverse
   * of GitHub's defaults, under which a single-commit PR lands under its
   * COMMIT's subject and a multi-commit PR under the PR title with every branch
   * commit concatenated. The landing verb now authors the message from the PR
   * on every commit count, so the claim is wrong in both halves.
   */
  const RETIRED = 'on a single-commit squash, what lands on the default branch';

  /**
   * The three statements the acceptance criterion asks for, as they read AFTER
   * rendering (the template escapes its backticks; the brief does not). Each is
   * pinned separately so a partial regression names the half it lost.
   */
  const CORRECTED: ReadonlyArray<{ half: string; text: string }> = [
    {
      half: 'the default: PR title and body, any commit count',
      text:
        'Under the default (`landing.commitMessage` absent or `pr`), the PR title and body are the ' +
        'landed message on any commit count: the landing verb writes the squash commit from them ' +
        'whether your branch carries one commit or several.',
    },
    {
      half: 'the Worker commit messages do not reach the default branch',
      text:
        'Your own commit messages do not reach the default branch under the default, so the PR body ' +
        'is where the durable record goes, never a commit message.',
    },
    {
      half: 'under host, the repository squash setting decides',
      text: "Under `host`, the repository's own squash setting decides what lands instead.",
    },
  ];

  async function workerBrief(template: string): Promise<string> {
    const { calls } = await runComposedDriver(
      composeDriverScript({ template, ...CONSTANTS, rows }),
    );
    const brief = calls.find((c) => String(c.opts.label) === 'worker:42')?.brief ?? '';
    expect(brief).toContain('You are a Wave Worker'); // guard the fixture before any claim rests on it
    return brief;
  }

  /** The halves of the corrected statement the RENDERED brief is missing. */
  function missingHalves(brief: string): string[] {
    return CORRECTED.filter((c) => !brief.includes(c.text)).map((c) => c.half);
  }

  it('the dispatched brief carries all three halves of the corrected statement', async () => {
    expect(missingHalves(await workerBrief(TEMPLATE))).toEqual([]);
  });

  it('CONTROL — the retired single-commit claim is gone from the dispatched brief AND from the template', async () => {
    expect(await workerBrief(TEMPLATE)).not.toContain(RETIRED);
    // The template too, so the claim cannot survive in a branch of the asset
    // this fixture's composition happens not to render.
    expect(TEMPLATE).not.toContain(RETIRED);
    expect(TEMPLATE).not.toContain('single-commit squash');
  });

  it('the title rule now says what the title is under the default, not under a commit count', async () => {
    expect(await workerBrief(TEMPLATE)).toContain(
      'it is what the reviewer reads first and, under the default, the subject of the commit that ' +
        'lands on the default branch.',
    );
  });

  it('NEGATIVE CONTROL — a template drifted back to the retired claim renders a brief both pins reject', async () => {
    const drifted = TEMPLATE.replace(
      /under the default, the subject of the commit that lands on the default branch\.\n\n {3}\*\*What lands on the default branch is your PR[\s\S]*?decides what lands instead\.\n/,
      `${RETIRED}.\n`,
    );
    expect(drifted).not.toEqual(TEMPLATE); // the replace actually matched
    const brief = await workerBrief(drifted);
    expect(brief).toContain(RETIRED);
    expect(missingHalves(brief)).toEqual(CORRECTED.map((c) => c.half));
  });
});

describe('compose-driver — the PR-create title is rendered single-quoted, and the row data stays plain (issue #776, folded into #753)', () => {
  /**
   * A title carrying every character that survives inside double quotes and
   * should not: a backtick-quoted token (the LIVE failure — a title opening
   * with one ran command substitution on its way to the host), a double quote,
   * and a `$`.
   */
  const TRICKY_TITLE = 'fix: `spine set-branch` honours "--model" and the $MODEL it records';
  /** A title carrying the ONE character single quotes cannot hold. */
  const APOSTROPHE_TITLE = "fix: don't shadow the row's recorded model";

  const rows = [
    row({ id: '42', slug: 'tricky', prTitle: TRICKY_TITLE }),
    row({ id: '43', slug: 'apostrophe', prTitle: APOSTROPHE_TITLE, siblingBranches: 'wave/42-tricky' }),
  ];
  const script = composeDriverScript({ template: TEMPLATE, ...CONSTANTS, rows });

  async function workerBrief(from: string, label: string): Promise<string> {
    const { calls } = await runComposedDriver(from);
    const brief = calls.find((c) => String(c.opts.label) === label)?.brief ?? '';
    expect(brief).toContain('You are a Wave Worker');
    return brief;
  }

  it('HEADLINE — the rule beside the command tells the Worker to run the line as printed and never re-quote', async () => {
    const brief = await workerBrief(script, 'worker:42');
    expect(brief).toMatch(/RUN THAT `--title` LINE EXACTLY AS PRINTED, AND NEVER RE-QUOTE THE TITLE/);
    expect(brief).toMatch(/SINGLE-QUOTED shell word/);
    // It names the escape idiom the Worker will see, so an odd-looking line
    // reads as the escaping working rather than as a rendering bug.
    expect(brief).toContain("'\\''");
    // ...and it names why the double-quoted form was wrong.
    expect(brief).toMatch(/inside DOUBLE quotes the shell still expands backticks/);
  });

  it('BODY — the rendered `--title` is single-quoted and carries the title verbatim; no double-quoted form survives', async () => {
    const brief = await workerBrief(script, 'worker:42');
    expect(brief).toContain(`--title '${TRICKY_TITLE}' \\`);
    // The backtick, the double quote and the dollar sign are all inside the quotes.
    expect(brief).toContain('`spine set-branch`');
    expect(brief).toContain('"--model"');
    expect(brief).toContain('$MODEL');
    expect(brief).not.toMatch(/--title "/);
  });

  it("BODY — an inner single quote is escaped with the close-escape-reopen idiom, and nothing else in the title moves", async () => {
    const brief = await workerBrief(script, 'worker:43');
    const escaped = APOSTROPHE_TITLE.split("'").join("'\\''");
    expect(brief).toContain(`--title '${escaped}' \\`);
    // Sanity: the escaped form really is different from the plain one, so the
    // assertion above is not vacuously equal to "the title, quoted".
    expect(escaped).not.toEqual(APOSTROPHE_TITLE);
  });

  it('the ISSUES row data stays the PLAIN title — the quoting happens only where the shell line is rendered', () => {
    const at = script.indexOf('const ISSUES = ');
    expect(at).toBeGreaterThan(-1);
    const close = script.indexOf('\n]\n', at);
    const composed = JSON.parse(script.slice(at + 'const ISSUES = '.length, close + 2)) as Array<
      Record<string, unknown>
    >;
    expect(composed.find((r) => r.id === '43')?.prTitle).toBe(APOSTROPHE_TITLE);
    expect(composed.find((r) => r.id === '42')?.prTitle).toBe(TRICKY_TITLE);
    // No escaping characters were added to the row data.
    expect(String(composed.find((r) => r.id === '43')?.prTitle)).not.toContain("'\\''");
  });

  it('NEGATIVE CONTROL — the pins fail against a template that renders the double-quoted form', async () => {
    const doubleQuoted = TEMPLATE.replace(
      '--title ${sq(issue.prTitle)} \\\\',
      '--title "${issue.prTitle}" \\\\',
    );
    expect(doubleQuoted).not.toEqual(TEMPLATE); // the replace actually matched
    const brief = await workerBrief(
      composeDriverScript({ template: doubleQuoted, ...CONSTANTS, rows }),
      'worker:42',
    );
    expect(brief).toMatch(/--title "/);
    expect(brief).not.toContain(`--title '${TRICKY_TITLE}' \\`);
  });
});

// ─── issue #791: the sibling denominator is WAVE-WIDE, not compose-wide ──────
//
// A wave whose Conflict-Map has overlap cells is run in ROUNDS: its rows are
// flipped `dispatched` and composed one round at a time. The denominator used
// to be "the rows dispatchable in THIS compose", so every earlier round's rows
// — already at `pr-created`, and the siblings most likely to collide, because
// sharing files is exactly why they were serialised — were invisible to every
// later round's Reviewer. Live: wave `2026-09-16-hub-truth-and-checklist` round
// 2 named one sibling and reported 1/1 clean while a round-1 row sat on the
// same three files; rounds 3 and 4 composed an EMPTY denominator and reported
// "0/0 — vacuously satisfied".
//
// The fixture below is AC1's, built once and read by most cases: the five row
// states that decide membership, plus the annotation and sentinel cases.
describe('compose-driver — the sibling denominator spans the WAVE, not this compose (issue #791)', () => {
  let repoRoot: string;
  let anchor: string;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const SLUG = '2026-09-21-rounds';

  /** The composer's own no-siblings sentinel — the exact bytes AC3 pins. */
  const NO_SIBLINGS = '(none — no sibling branches in this wave)';

  /**
   * One roster row's shape in this fixture, keyed by a stable LETTER because
   * the markdown store mints the real ids (`<wave-slug>#NN`) and the composer
   * refuses any branch that is not `wave/<that id>-<slug>`. `branchSlug: null`
   * means the spine records no dispatch-log branch for the row at all — the
   * `planned` case.
   */
  interface FixtureRow {
    key: string;
    state: string;
    branchSlug: string | null;
    /**
     * When set, the spine's `## PR-Log` carries a row for this key with this
     * text in its `Merged` cell — a date is what `close-row` writes on a
     * recorded merge, `—` is the renderer's own not-merged placeholder.
     */
    prLogMerged?: string;
  }

  /** The branch the fixture recorded for `key`, rebuilt the way the spine has it. */
  function branchOf(storeIds: Map<string, string>, key: string, branchSlug: string): string {
    return `wave/${storeIds.get(key) as string}-${branchSlug}`;
  }

  /**
   * Seed a spine whose Plan-Table carries `rows` in order. Every row is created
   * in the store (only a dispatchable row is ever `store.read`, but creating
   * them all keeps the fixture honest about what a real wave looks like), and
   * every row that carries a branch gets a dispatch-log entry and a recorded
   * model — exactly what `spine set-branch [--model]` writes at dispatch.
   */
  async function seed(rows: readonly FixtureRow[]): Promise<{
    spinePath: string;
    configPath: string;
    storeIds: Map<string, string>;
  }> {
    const store = new MarkdownFsStore({ repoRoot, slug: SLUG });
    const storeIds = new Map<string, string>();
    for (const r of rows) {
      const id = await store.create({
        title: `Row ${r.key}`,
        filingHint: `row-${r.key}`,
        risk: 'cross-feature-refactor',
        worker: 'background-heavy',
        files: ['tools/wave/**'],
        blockedBy: 'none',
        acceptanceCriteria: [{ text: `row ${r.key} is done`, checked: false }],
        bodySections: [{ heading: 'What to build', markdown: `Build row ${r.key}.` }],
      });
      storeIds.set(r.key, id);
    }

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'rounds',
        coordinator: 'c',
        created: '2026-09-21',
        lastUpdated: '2026-09-21',
        model: 'm',
      },
      rows.map((r) => ({
        id: storeIds.get(r.key) as string,
        title: `Row ${r.key}`,
        worker: 'background-heavy',
        risk: 'cross-feature-refactor',
      })),
      { issues: [], cells: [] },
      'ok',
    );
    for (const r of rows) {
      const id = storeIds.get(r.key) as string;
      spine = setRowState(spine, id, r.state as Parameters<typeof setRowState>[2]);
      if (r.branchSlug) {
        spine = upsertDispatchLogEntry(spine, id, branchOf(storeIds, r.key, r.branchSlug));
        spine = upsertDispatchLogModel(spine, id, 'opus');
      }
      if (r.prLogMerged !== undefined) {
        spine = upsertPrLogRow(spine, {
          created: '2026-09-23',
          id,
          prCell: `https://github.com/example/repo/pull/${id.replace(/\D/g, '') || '1'}`,
          closes: `Closes #${id}`,
          merged: r.prLogMerged,
          notes: '—',
        });
      }
    }

    const spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    writeFileSync(spinePath, spine, 'utf8');

    const configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot, slug: SLUG },
        engine: { cli: SOURCE_FORM_CLI },
        verify: {
          profiles: [
            {
              name: 'engine',
              appliesTo: ['tools/wave/**'],
              commands: [{ command: 'npm ci --prefix tools/wave' }],
            },
          ],
        },
      }),
      'utf8',
    );
    return { spinePath, configPath, storeIds };
  }

  /** Compose, and hand back the ISSUES array the driver script carries. */
  async function compose(
    spinePath: string,
    configPath: string,
    extra: readonly string[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const out = join(repoRoot, 'driver.js');
    const code = await runComposeDriver([
      '--spine', spinePath,
      '--config', configPath,
      '--repo-root', repoRoot,
      '--anchor', anchor,
      '--out', out,
      '--reviewer-agent', 'flotilla:wave-reviewer',
      ...extra,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const script = readFileSync(out, 'utf8');
    const at = script.indexOf('const ISSUES = ');
    expect(at).toBeGreaterThan(-1);
    const close = script.indexOf('\n]\n', at);
    return JSON.parse(script.slice(at + 'const ISSUES = '.length, close + 2)) as Array<
      Record<string, unknown>
    >;
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compose-driver-siblings-'));
    execFileSync('git', ['-C', repoRoot, 'init', '-q']);
    execFileSync('git', [
      '-C', repoRoot,
      '-c', 'user.email=t@example.invalid',
      '-c', 'user.name=t',
      'commit', '--allow-empty', '-q', '-m', 'anchor',
    ]);
    anchor = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // AC1's fixture, exactly: A `pr-created` with a branch, B `dispatched`,
  // C `parked` with a branch, D `abandoned`, E `planned` with no branch.
  // D is given a branch too — the AC does not say it has none, and an
  // `abandoned` row with NO branch would already be excluded by the branch
  // test, leaving the state exclusion untested. With a branch, only the state
  // can explain its absence.
  const AC1_ROWS: readonly FixtureRow[] = [
    { key: 'A', state: 'pr-created', branchSlug: 'first-round' },
    { key: 'B', state: 'dispatched', branchSlug: 'second-round' },
    { key: 'C', state: 'parked', branchSlug: 'parked' },
    { key: 'D', state: 'abandoned', branchSlug: 'abandoned' },
    { key: 'E', state: 'planned', branchSlug: null },
  ];

  it("AC1 — the dispatched row's denominator is the earlier round's PR branch, annotated, and nothing else", async () => {
    const { spinePath, configPath, storeIds } = await seed(AC1_ROWS);
    const issues = await compose(spinePath, configPath);
    // Only B is dispatchable, so only B is composed.
    expect(issues).toHaveLength(1);
    expect(issues[0].siblingBranches).toBe(
      `${branchOf(storeIds, 'A', 'first-round')} (pr-created)`,
    );
    // Said again as exclusions, so a future widening cannot pass by accident.
    const value = String(issues[0].siblingBranches);
    expect(value).not.toContain(branchOf(storeIds, 'C', 'parked'));
    expect(value).not.toContain(branchOf(storeIds, 'D', 'abandoned'));
    // …and a row never names ITSELF as its own sibling.
    expect(value).not.toContain(branchOf(storeIds, 'B', 'second-round'));
  });

  it('NEGATIVE CONTROL — AC1: the pre-change roster-only rule would have produced the sentinel', async () => {
    // The rule this row replaced, re-implemented here over the SAME spine the
    // compose read: siblings = the OTHER rows dispatchable in this compose,
    // unannotated. Over AC1's fixture that set is EMPTY, so the old rule
    // composed the no-siblings sentinel for B — and the round-1 PR branch, the
    // one sibling that genuinely shares files with it, was never named.
    const { spinePath, configPath, storeIds } = await seed(AC1_ROWS);
    const spine = readSpine(readFileSync(spinePath, 'utf8'));
    const DISPATCHABLE = ['dispatched', 're-dispatched'];
    const rosterOnly = spine.planTable
      .filter((r) => DISPATCHABLE.includes(String(r.state)))
      .map((r) => ({ id: r.id, branch: r.branch ?? '' }));
    const bId = storeIds.get('B') as string;
    const oldSiblings = rosterOnly.filter((r) => r.id !== bId).map((r) => r.branch);
    expect(oldSiblings).toEqual([]);
    const oldValue = oldSiblings.length ? oldSiblings.join(', ') : NO_SIBLINGS;
    expect(oldValue).toBe(NO_SIBLINGS);

    // …and the shipped rule, over the same spine, does not.
    const issues = await compose(spinePath, configPath);
    expect(issues[0].siblingBranches).not.toBe(oldValue);
    expect(issues[0].siblingBranches).toBe(
      `${branchOf(storeIds, 'A', 'first-round')} (pr-created)`,
    );
  });

  it('AC2 — two dispatched rows name each other `(dispatched)`; `(re-dispatched)` and `(failed)` annotate too', async () => {
    const { spinePath, configPath, storeIds } = await seed([
      { key: 'A', state: 'dispatched', branchSlug: 'one' },
      { key: 'B', state: 'dispatched', branchSlug: 'two' },
      { key: 'C', state: 're-dispatched', branchSlug: 'three' },
      { key: 'D', state: 'failed', branchSlug: 'four' },
    ]);
    const issues = await compose(spinePath, configPath);
    const byId = new Map(issues.map((i) => [String(i.id), i]));
    const a = byId.get(storeIds.get('A') as string);
    const b = byId.get(storeIds.get('B') as string);
    const c = byId.get(storeIds.get('C') as string);
    const bA = `${branchOf(storeIds, 'A', 'one')} (dispatched)`;
    const bB = `${branchOf(storeIds, 'B', 'two')} (dispatched)`;
    const bC = `${branchOf(storeIds, 'C', 'three')} (re-dispatched)`;
    const bD = `${branchOf(storeIds, 'D', 'four')} (failed)`;
    // A, B and C are all dispatchable; D (`failed`) is not composed, but its
    // live branch IS in everyone's denominator — the Coordinator's 2026-09-21
    // ruling: it may yet land through a ruled round.
    expect(issues).toHaveLength(3);
    expect(a?.siblingBranches).toBe([bB, bC, bD].join(', '));
    expect(b?.siblingBranches).toBe([bA, bC, bD].join(', '));
    expect(c?.siblingBranches).toBe([bA, bB, bD].join(', '));
  });

  it('AC2 — each entry still opens with the branch token, so the refs/review/sib fetch instruction parses', async () => {
    const { spinePath, configPath } = await seed(AC1_ROWS);
    const issues = await compose(spinePath, configPath);
    for (const entry of String(issues[0].siblingBranches).split(', ')) {
      expect(entry.split(' ')[0]).toMatch(/^wave\//);
      expect(entry).toMatch(/^wave\/\S+ \([a-z-]+\)$/);
    }
  });

  it('AC3 — with no other branch-bearing row the value is exactly the sentinel', async () => {
    const { spinePath, configPath } = await seed([
      { key: 'A', state: 'dispatched', branchSlug: 'alone' },
      { key: 'B', state: 'parked', branchSlug: 'parked' },
      { key: 'C', state: 'planned', branchSlug: null },
    ]);
    const issues = await compose(spinePath, configPath);
    expect(issues).toHaveLength(1);
    expect(issues[0].siblingBranches).toBe(NO_SIBLINGS);
  });

  it('AC3 — a `--row-meta` siblingBranches override reaches the composed row byte-identically', async () => {
    const OVERRIDE = 'wave/999-hand-written (whatever the Coordinator says)';
    const { spinePath, configPath, storeIds } = await seed(AC1_ROWS);
    const issues = await compose(spinePath, configPath, [
      '--row-meta',
      JSON.stringify({ [storeIds.get('B') as string]: { siblingBranches: OVERRIDE } }),
    ]);
    expect(issues[0].siblingBranches).toBe(OVERRIDE);
  });

  it('AC4 — the composed Reviewer brief carries the renamed header and the per-annotation not-on-origin sentence', async () => {
    const { spinePath, configPath, storeIds } = await seed(AC1_ROWS);
    const out = join(repoRoot, 'driver.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', out,
        '--reviewer-agent', 'flotilla:wave-reviewer',
      ]),
    ).toBe(0);
    const { calls } = await runComposedDriver(readFileSync(out, 'utf8'));
    const bId = storeIds.get('B') as string;
    const brief = calls.find((c) => String(c.opts.label) === `review:${bId}`)?.brief ?? '';
    // The renamed header — "in-flight" was never the membership rule and is now
    // plainly wrong, since an earlier round's landed PR is on the list. Renamed
    // again by the landed-sibling row: the ROW is the subject and its branch
    // only the in-flight carrier (glossary: Sibling), so the header no longer
    // calls the list "branches".
    expect(brief).toContain(
      'Siblings in this wave (your merge-tree denominator): ' +
        `${branchOf(storeIds, 'A', 'first-round')} (pr-created)`,
    );
    expect(brief).not.toContain('Sibling in-flight branches:');
    expect(brief).not.toContain('Sibling branches in this wave');
    // …and the sentence that tells the Reviewer what the annotation means.
    expect(brief).toMatch(/Each entry reads .*<branch> \(<state>\).*fact about the SPINE/);
    expect(brief).toMatch(/\(pr-created\).*may already have landed/s);
    expect(brief).toMatch(/\(failed\).*is on the list on purpose/s);
  });

  it('AC5 — the receipt per-row key set is unchanged by this row', async () => {
    // The receipt is a PUBLIC surface (the verb's JSON contract). This row
    // deliberately adds nothing to it: a `siblings` key here would make the
    // change a public-API-change and pull in the verb-contract specs. Pinned as
    // the exact key list so a later "helpful" addition fails here first.
    const { spinePath, configPath } = await seed(AC1_ROWS);
    await compose(spinePath, configPath);
    const receipt = JSON.parse(stdout) as { rows: Array<Record<string, unknown>> };
    expect(receipt.rows).toHaveLength(1);
    expect(Object.keys(receipt.rows[0]).sort()).toEqual([
      'branch',
      'depsSetupSource',
      'id',
      'iteration',
      'model',
      'risk',
      'scopeGrants',
      'slug',
      'worker',
    ]);
  });

  it('the DECLARED shape names every key the receipt actually carries (issue #913)', async () => {
    // Three things have to agree, and this is what makes it three rather than
    // two: the EMITTER (what `runComposeDriver` prints), the PIN above (a
    // hand-typed key list that fails on a "helpful" addition), and the CONTRACT
    // (what `--help` and the Catalog advertise). Before issue #913 the third
    // did not exist — `output: 'json'` was the whole declaration — so a key
    // could be added to the receipt and to the pin while the public contract
    // surface went on saying nothing about it.
    //
    // Asserted in ONE direction, over the receipt this run actually printed: a
    // key in the JSON that the shape does not name is drift. The reverse is not
    // asserted here, because nothing in this shape is conditional and the
    // `toEqual` below already pins the row list exactly.
    const { spinePath, configPath } = await seed(AC1_ROWS);
    await compose(spinePath, configPath);
    const receipt = JSON.parse(stdout) as Record<string, unknown>;
    const shape = COMPOSE_DRIVER_CONTRACT.json?.shape ?? '';
    const undeclared = Object.keys(receipt).filter((k) => !new RegExp(`\\b${k}\\b`).test(shape));
    expect(undeclared, 'the receipt carries a key the declared shape does not name').toEqual([]);
    // …and the per-row key list is declared in the SAME order the emitter
    // builds it, so a reader of `--help` sees the object they will receive.
    expect(shape).toContain(
      'rows: [ { id, slug, branch, model, iteration, risk, worker, scopeGrants, depsSetupSource } ]',
    );
    // NEGATIVE CONTROL — the filter is not one that can only return [].
    expect(
      ['ok', 'aKeyNoShapeNames'].filter((k) => !new RegExp(`\\b${k}\\b`).test(shape)),
    ).toEqual(['aKeyNoShapeNames']);
  });

  // ─── a landed sibling reads `(landed)`, off the spine's PR-Log alone ───────
  //
  // In a wave that lands by squash and re-anchors every round, a landed
  // sibling's branch tip is a stale leftover — or gone, which reads as "never
  // pushed" — so the Reviewer covers it through the default branch's current
  // tip instead of its tip. The composer's share of that is the annotation,
  // and the annotation is a fact about the SPINE: the PR-Log's `Merged` cell,
  // which `close-row` writes only once a merge is established. Nothing in the
  // compose asks `origin` anything; the fixture repo has no remote at all.

  /** Compose, run the composed driver, and hand back the Reviewer brief for `key`. */
  async function reviewerBriefFor(
    spinePath: string,
    configPath: string,
    storeIds: Map<string, string>,
    key: string,
  ): Promise<string> {
    const out = join(repoRoot, 'driver.js');
    expect(
      await runComposeDriver([
        '--spine', spinePath,
        '--config', configPath,
        '--repo-root', repoRoot,
        '--anchor', anchor,
        '--out', out,
        '--reviewer-agent', 'flotilla:wave-reviewer',
      ]),
    ).toBe(0);
    const { calls } = await runComposedDriver(readFileSync(out, 'utf8'));
    const id = storeIds.get(key) as string;
    return calls.find((c) => String(c.opts.label) === `review:${id}`)?.brief ?? '';
  }

  /** One merged sibling (A), the row under review (B), one in-flight sibling (C). */
  const LANDED_ROWS: readonly FixtureRow[] = [
    { key: 'A', state: 'pr-created', branchSlug: 'merged-earlier', prLogMerged: '2026-09-23' },
    { key: 'B', state: 'dispatched', branchSlug: 'under-review' },
    { key: 'C', state: 'dispatched', branchSlug: 'in-flight' },
  ];

  it('a sibling with a merged PR-Log entry reads `(landed)`; an in-flight sibling keeps its state; the branch token leads both', async () => {
    const { spinePath, configPath, storeIds } = await seed(LANDED_ROWS);
    const issues = await compose(spinePath, configPath);
    const b = issues.find((i) => String(i.id) === storeIds.get('B'));
    const landed = `${branchOf(storeIds, 'A', 'merged-earlier')} (landed)`;
    const inFlight = `${branchOf(storeIds, 'C', 'in-flight')} (dispatched)`;
    expect(b?.siblingBranches).toBe([landed, inFlight].join(', '));
    // The annotation REPLACES the state — the landed row's `pr-created` does
    // not ride along beside it.
    expect(String(b?.siblingBranches)).not.toContain('(pr-created)');
    for (const entry of String(b?.siblingBranches).split(', ')) {
      expect(entry.split(' ')[0]).toMatch(/^wave\//);
      expect(entry).toMatch(/^wave\/\S+ \([a-z-]+\)$/);
    }
    // …and the in-flight sibling C sees the same landed sibling the same way.
    const c = issues.find((i) => String(i.id) === storeIds.get('C'));
    expect(c?.siblingBranches).toBe(
      [landed, `${branchOf(storeIds, 'B', 'under-review')} (dispatched)`].join(', '),
    );
  });

  it('NEGATIVE CONTROL — a PR-Log row whose Merged cell is still the placeholder records a PR, not a landing', async () => {
    // The same spine shape with the one fact changed: the PR-Log carries A's
    // PR, but its Merged cell is the renderer's own `—`. An annotation read off
    // "a PR-Log row exists" instead of "a merge is recorded" would say
    // `(landed)` here and send the Reviewer past a live branch.
    const { spinePath, configPath, storeIds } = await seed([
      { key: 'A', state: 'pr-created', branchSlug: 'open-pr', prLogMerged: '—' },
      { key: 'B', state: 'dispatched', branchSlug: 'under-review' },
    ]);
    const issues = await compose(spinePath, configPath);
    expect(issues[0].siblingBranches).toBe(`${branchOf(storeIds, 'A', 'open-pr')} (pr-created)`);
    expect(String(issues[0].siblingBranches)).not.toContain('(landed)');
  });

  it('the composed Reviewer brief covers a `(landed)` sibling through the default branch, and asks origin first for every other one', async () => {
    const { spinePath, configPath, storeIds } = await seed(LANDED_ROWS);
    const brief = await reviewerBriefFor(spinePath, configPath, storeIds, 'B');
    const bId = storeIds.get('B') as string;
    expect(brief).toContain(`${branchOf(storeIds, 'A', 'merged-earlier')} (landed)`);
    // The landed rule and its one check, rendered with this row's own ids.
    expect(brief).toContain('A `(landed)` sibling is NEVER fetched and never merge-treed by its tip.');
    expect(brief).toContain(`git merge-tree refs/review/${bId} refs/review/base/${bId}`);
    // Every other sibling: `ls-remote` BEFORE the fetch, and the fetch's exit
    // code is never what decides.
    const lsRemote = brief.indexOf('git ls-remote origin refs/heads/<branch>');
    const fetch = brief.indexOf('git fetch origin <branch>:refs/review/sib/<sibling-id>');
    expect(lsRemote).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(lsRemote);
    expect(brief).toMatch(/exit\s+code is never an input/);
    // The diff base is the ROUND's anchor, and the brief never calls it the wave's.
    expect(brief).toContain(`Round anchor SHA (diff base — NOT main): \`${anchor}\``);
    expect(brief).not.toMatch(/wave[ -]anchor/i);
    expect(brief).toMatch(/never means that nothing landed/);
    // The coverage line asks for no re-run: no step reads that request.
    expect(brief).not.toMatch(/before landing/i);
  });

  it('the composed Reviewer brief reads every merge-tree by its exit status and carries no conflict marker at all (issue #975)', async () => {
    // The drift spec holds the asset's template text; this holds what the
    // composed driver actually hands a running Reviewer, after the template's
    // escaped backticks are rendered. The two-argument merge-tree never prints
    // a conflict marker, so the rendered brief has no reason to carry one.
    const { spinePath, configPath, storeIds } = await seed(LANDED_ROWS);
    const brief = await reviewerBriefFor(spinePath, configPath, storeIds, 'B');
    expect(brief).toMatch(/BY ITS EXIT STATUS — NEVER BY CONFLICT MARKERS ON STDOUT/);
    expect(brief).toMatch(/exit 0 → clean, subject to the `at-anchor` rule below; exit 1 →\s+`predicted-conflict`, naming the files from its `CONFLICT \(` lines/);
    expect(brief).toMatch(/any other exit →\s+that sibling is NOT covered, reported with the error on the coverage line/);
    expect(brief).toMatch(/then read the merge-tree by its EXIT STATUS/);
    expect(brief).not.toContain('<<<<<<<');
    expect(brief).not.toContain('>>>>>>>');
  });

  it('the composed Reviewer brief names its probe checkout with the stamp — wave slug, row id, iteration', async () => {
    const { spinePath, configPath, storeIds } = await seed(LANDED_ROWS);
    const brief = await reviewerBriefFor(spinePath, configPath, storeIds, 'B');
    const stamp = `flotilla-probe-${SLUG}-${storeIds.get('B') as string}-i1`;
    // The stamp is the checkout's OWN basename, never a parent (issue #974):
    // the path handed to `git worktree add` must itself end in it.
    expect(brief.replace(/\s+/g, ' ')).toContain(
      `the path you hand to \`git worktree add\` must itself end in \`${stamp}\``,
    );
    expect(brief).toMatch(/own basename, never a parent directory/);
    expect(brief).not.toContain('name its directory exactly');
    expect(brief).toMatch(/lives OUTSIDE the repository/);
    expect(brief).toMatch(/You never remove it yourself/);
    // Nothing unresolved reached the stamp.
    expect(brief).not.toMatch(/flotilla-probe-[^`]*undefined/);
  });

  // Issue #991: Reviewers who falsified a check inside their probe left the
  // edit behind; the sweep skipped each `dirty` and each needed a hand
  // removal. The composed brief — what a running Reviewer actually reads,
  // backticks rendered — tells it to revert and verify the probe clean.
  it('the composed Reviewer brief tells the Reviewer to revert its own probe edits and verify the probe clean before returning', async () => {
    const { spinePath, configPath, storeIds } = await seed(LANDED_ROWS);
    const flat = (await reviewerBriefFor(spinePath, configPath, storeIds, 'B')).replace(/\s+/g, ' ');
    expect(flat).toContain('revert every edit you made inside your probe');
    expect(flat).toContain('a falsification break included');
    expect(flat).toContain('verify the probe clean before you return');
    expect(flat).toContain('`git -C <probe> status --porcelain` must print nothing');
    expect(flat).toMatch(/The sweep skips a dirty probe \(`dirty`\), so an edit you leave behind is never collected and needs a removal by hand/);
    // The rendered form carries no template escape: a Reviewer reads backticks.
    expect(flat).not.toContain('\\`git -C <probe>');
  });
});
