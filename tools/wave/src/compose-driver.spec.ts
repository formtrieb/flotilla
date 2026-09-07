/**
 * compose-driver.spec.ts — the composed driver, exercised the way the harness
 * exercises it.
 *
 * Three layers of evidence, deliberately separate:
 *
 *  1. **Substitution is total and nothing else moves.** The composed script is
 *     re-derived here by an INDEPENDENT implementation (plain string surgery in
 *     this file, not the module's own helpers) and compared byte-for-byte. That
 *     is what makes "the composed script is the template with its five constants
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
 *     human-gate/foreground refusal and the anchor-resolvability gate all moved
 *     into the engine with this verb; each gets a positive case and a negative
 *     control (Convention 11).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
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
  modelForRisk,
  projectScopeGrants,
  resolveReviewerAgent,
  runComposeDriver,
  slugFromSpinePath,
  stripBareIds,
  type DriverRow,
} from './compose-driver';
import type { VerifyCommand } from './verify';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { HUMAN_GATED_WORKER, renderSpine, setRowState, upsertDispatchLogEntry, upsertDispatchLogModel } from './wave-md-rw';
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
  it('differs from the template ONLY in the five constants and the ISSUES array', () => {
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
    expect(composed).not.toContain('<absolute repo root');
    expect(composed).not.toContain('<engine.cli from wave.config.json');
    expect(composed).not.toContain("id: 'NN'");
  });

  it('NEGATIVE CONTROL — a template missing a placeholder constant fails loud, it does not silently skip the fill', () => {
    const broken = TEMPLATE.replace(/^const WAVE_CLI = '[^']*'$/m, "const WAVE_CLI = `${cfg}`");
    expect(broken).not.toEqual(TEMPLATE);
    expect(() => composeDriverScript({ template: broken, ...CONSTANTS, rows: [row()] })).toThrow(
      /no `const WAVE_CLI = '…'` line to fill/,
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
    expect(brief).toContain(`--dir "${CONSTANTS.reportsDir}"`);
    expect(brief).toContain(`"${CONSTANTS.repoRoot}/.flotilla/tmp/report-42-1.json"`);
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

  it('modelForRisk binds the heavy tier to the two heavy Risk classes only', () => {
    expect(modelForRisk('public-API-change')).toBe('opus');
    expect(modelForRisk('cross-feature-refactor')).toBe('opus');
    expect(modelForRisk('mechanical')).toBe('sonnet');
    expect(modelForRisk('isolated-refactor')).toBe('sonnet');
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
    /a retried FIRST iteration re-anchors to the wave anchor SHA exactly as a\s+first attempt does/;

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
    expect(redispatch).toMatch(/do not re-anchor to\s+the wave anchor SHA and branch fresh/);
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

// ─── the deferred valve's trigger list reads FOUR wherever this row governs ───
//
// ADR-0049 gave the Reviewer's deferred valve a fourth trigger, `capability-gated`,
// beside merge-, prod- and human-gated. The corpus states that list in several
// places; the row that landed the decision updated the copies inside its own
// declared files and left two others reading THREE. Nothing went red, because
// nothing was looking. This is the check that looks.
//
// ## Bounded on purpose
//
// The population below is exactly the set of files the follow-through row
// declares — not the whole corpus. A corpus-wide sweep is a larger, separate
// change, and a check that quietly grows its own scope is a check nobody can
// land. A three-trigger copy found OUTSIDE this list is a disclosure to file,
// never a reason to widen this constant in passing.
//
// ## The predicate is a WINDOW, not a line
//
// Three shapes state the list, and a line-based rule would miss two of them: a
// wrapped prose sentence (the driver's reviewer brief splits its enumeration
// across two source lines), a markdown table where each trigger owns a row
// (`reviewer-checks.md`), and a parenthetical inside a decision record. So each
// file's text is whitespace-normalized and every occurrence of `merge-gated`
// must have `capability-gated` within WINDOW characters on either side. The
// table passes because its four rows sit inside one window; a stale
// three-trigger sentence cannot, because nothing near it names the fourth.
//
// ## No exemption marker, and none may be added
//
// ADR-0043: the checked text never carries its own exemption. ADR-0049's own
// quotation of the pre-decision three-trigger list passes this check because the
// sentence carrying the quotation now names the fourth as the thing that record
// adds — the fix lived in the prose, not in a skip-list here.
describe("the deferred valve's trigger list — no three-trigger copy survives in this row's files", () => {
  const REPO_ROOT = join(__dirname, '../../..');

  /** This row's declared files — the bounded population, stated once. */
  const GOVERNED = [
    'tools/wave/driver/wave-start-inflight.js',
    '.claude/agents/wave-reviewer.md',
    '.claude/skills/wave-reviewer/SKILL.md',
    '.claude/skills/wave-reviewer/reference/reviewer-checks.md',
    '.claude/skills/wave-shared/reference/convention-07-host-landing-seam.md',
    'docs/adr/0004-ac-ground-truth-is-the-reviewer-verdict.md',
    'docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md',
  ];

  /**
   * Files that must still CARRY a trigger-list statement. A file dropping out of
   * this set is as much a finding as a stale copy in it: silence reads green.
   * `convention-07` is deliberately absent — it states the host seam, not the
   * valve, and must never be asked for a trigger list.
   */
  const STATEMENT_BEARING = [
    'tools/wave/driver/wave-start-inflight.js',
    '.claude/agents/wave-reviewer.md',
    '.claude/skills/wave-reviewer/SKILL.md',
    '.claude/skills/wave-reviewer/reference/reviewer-checks.md',
    'docs/adr/0004-ac-ground-truth-is-the-reviewer-verdict.md',
    'docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md',
  ];

  /**
   * Half-width of the window, in normalized characters. Sized against the widest
   * legitimate statement in the population: `reviewer-checks.md`'s four-row
   * table, where `merge-gated` and `capability-gated` sit three rows apart, and
   * ADR-0004's parenthetical, which carries a full ADR filename between the two.
   */
  const WINDOW = 400;

  /** Does `capability-gated` sit within WINDOW of the `merge-gated` at `at`? */
  function fourTriggered(text: string, at: number): boolean {
    return text.slice(Math.max(0, at - WINDOW), at + WINDOW).includes('capability-gated');
  }

  it('every trigger-list statement names capability-gated beside merge-gated', () => {
    const stale: string[] = [];
    const bearing: string[] = [];
    let statements = 0;

    for (const rel of GOVERNED) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\s+/g, ' ');
      let hit = text.indexOf('merge-gated');
      if (hit !== -1) bearing.push(rel);
      while (hit !== -1) {
        statements += 1;
        if (!fourTriggered(text, hit)) {
          stale.push(rel + ': …' + text.slice(Math.max(0, hit - 90), hit + 130) + '…');
        }
        hit = text.indexOf('merge-gated', hit + 'merge-gated'.length);
      }
    }

    expect(
      stale,
      'a three-trigger copy of the deferred valve is still shipping — ADR-0049 added ' +
        '`capability-gated` as the fourth:\n  ' +
        stale.join('\n  '),
    ).toEqual([]);

    // Population floor — a listing that silently stopped finding statements (a
    // renamed file, a moved reference dir, a rewritten paragraph) would
    // otherwise be green for the wrong reason. Six statements ship today.
    expect(
      statements,
      'the trigger-list population shrank — is every GOVERNED file still where it says?',
    ).toBeGreaterThanOrEqual(6);
    for (const rel of STATEMENT_BEARING) {
      expect(bearing, rel + " no longer states the valve's trigger list at all").toContain(rel);
    }
  });

  it('NEGATIVE CONTROL — the window rule sees a seeded three-trigger sentence', () => {
    // The same predicate over a fixture rather than the corpus: proof it can
    // tell a four-trigger statement from a three-trigger one, so the green above
    // is a result and not an artifact of a check that cannot fail.
    const four =
      'an outcome unreachable — merge-gated, prod-gated, human-gated, capability-gated — is deferred';
    const three = 'an outcome unreachable — merge-gated, prod-gated, human-gated — is deferred';
    expect(fourTriggered(four, four.indexOf('merge-gated'))).toBe(true);
    expect(fourTriggered(three, three.indexOf('merge-gated'))).toBe(false);
  });
});
