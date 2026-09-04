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
    expect(brief).toContain(`Closes #${id}`);
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
});
