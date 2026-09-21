/**
 * close-row.spec.ts — the done-reconcile verb, driven end to end against real
 * durable state and injected store/disk seams.
 *
 * The fixture is REAL where realness is the point and injected where the order
 * has to be observed: a real spine file on disk written by `renderSpine` (so the
 * bare `## PR-Log` heading and the empty `## Closed-by` section are exactly the
 * shapes the renderer actually produces, not a hand-typed approximation), real
 * verdict sidecars under a real verdicts dir (so the acked derivation runs
 * through the same reader `verdict-acked` uses), a real {@link GitHubIssuesStore}
 * over {@link InMemoryGitHubApi} (so `close` and `readClosing` are the store's
 * own semantics), and a RECORDING `SpineIo` + a recording store so the one
 * ordering claim the write-ahead property rests on is observed rather than
 * argued.
 *
 * Four properties get the most attention, because each is a place this verb's
 * absence has already cost something:
 *
 *  1. **The order.** Both spine writes precede the tracker close. The recorder
 *     below sees three calls and asserts their sequence AND the bytes each
 *     spine write carried — a check that a re-ordered implementation fails.
 *  2. **Read-then-upsert, never replace.** Landing a second row must leave the
 *     first row's `## PR-Log` row and `## Closed-by` line byte-identical. The
 *     rejected implementation — replace the whole `## Closed-by` body — passes
 *     every single-row test and fails only this one.
 *  3. **The refusal writes nothing.** A PR cell that is not a real PR URL is
 *     refused before the first byte is written, asserted against a
 *     byte-identical spine and an untouched tracker.
 *  4. **A missing verdict sidecar is an answer, not a failure.** `acked: []`,
 *     the step reports `skipped`, and the close still lands — the tick is
 *     cosmetic (ADR-0004) and may never block a close.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderClosedByLine,
  resolveClosingPr,
  runCloseRow,
  upsertClosedByLine,
  type CloseRowDeps,
} from './close-row';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import type { IssueStore } from './adapters/issue-store';
import { stillOpenLine } from './issue-store-cli';
import { renderSidecarBody } from './route-cli';
import { readSpine, renderSpine, setRowPrCell, setRowState } from './wave-md-rw';
import type { SpineIo } from './spine-store';
import type { ReviewerVerdict } from './reviewer-verdict-schema';
import type { StepResult } from './route-tuple';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const SLUG = 'close-row-wave';
const TODAY = '2026-09-16';

function verdict(overrides: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: 'approve',
    branchReviewed: 'PLACEHOLDER',
    riskClass: 'mechanical',
    workerReportDigest: 'Worker reports 4542/4542 green, 0 judgment calls.',
    acVerification: [
      { ac: 'the verb lands one merged row', met: 'met', evidence: 'src/close-row.ts:1' },
      { ac: 'the second row keeps the first intact', met: 'partial', evidence: 'n/a' },
      { ac: 'the refusal writes nothing', met: 'met', evidence: 'src/close-row.ts:2' },
    ],
    reviewerFocusItems: [],
    lintTestSummary: 'vitest 4542/4542, tsc clean',
    ...overrides,
  };
}

/** One recorded impure call, in the order it happened. */
interface Recorded {
  call: 'spine.write' | 'store.close';
  /** For a spine write: the bytes it persisted. */
  source?: string;
  /** For the store close: what it was handed. */
  args?: { id: string; prUrl: string; acked: number[] };
}

describe('close-row', () => {
  let repoRoot: string;
  let spinePath: string;
  let configPath: string;
  let verdictsDir: string;
  let store: IssueStore;
  let idA: string;
  let idB: string;
  let prA: string;
  let prB: string;
  let log: Recorded[];
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  /** A disk-backed SpineIo that records the bytes of every write, in order. */
  function recordingSpineIo(): SpineIo {
    return {
      read: (p) => readFileSync(p, 'utf-8'),
      write: (p, content) => {
        log.push({ call: 'spine.write', source: content });
        writeFileSync(p, content, 'utf-8');
      },
    };
  }

  /**
   * The two store methods this verb touches, recorded and delegated. Written as
   * a two-method object rather than a proxy on purpose: it is also the
   * assertion that the verb touches exactly these two — any third call fails
   * with a TypeError rather than passing unnoticed.
   */
  function recordingStore(): IssueStore {
    return {
      close: async (id: string, prUrl: string, acked: number[]) => {
        log.push({ call: 'store.close', args: { id, prUrl, acked: [...acked] } });
        await store.close(id, prUrl, acked);
      },
      readClosing: (id: string) => store.readClosing(id),
    } as unknown as IssueStore;
  }

  /**
   * Seed a wave: two issues in an in-memory GitHub store, a spine on disk with
   * both rows at `pr-created` and each carrying its own PR cell.
   *
   * `GitHubIssuesStore` rather than the markdown dogfood store for the same
   * reason `route-tuple.spec.ts` picks it: its ids are the numeric tracker ids
   * the close phrase is built from (`Closes #1`), which is what the PR-Log
   * row's `Closes` cell records.
   */
  async function seed(): Promise<void> {
    store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    idA = await store.create({
      title: 'Land one merged row in one call',
      filingHint: 'close-row-verb',
      risk: 'public-API-change',
      worker: 'background-heavy',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [
        { text: 'the verb lands one merged row', checked: false },
        { text: 'the second row keeps the first intact', checked: false },
        { text: 'the refusal writes nothing', checked: false },
      ],
      bodySections: [{ heading: 'What to build', markdown: 'The verb.' }],
    });
    idB = await store.create({
      title: 'A second row that lands afterwards',
      filingHint: 'second-row',
      risk: 'mechanical',
      worker: 'background',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'it lands', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'The row.' }],
    });
    prA = `https://github.com/example-org/example-repo/pull/${idA}`;
    prB = `https://github.com/example-org/example-repo/pull/${idB}`;

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'done-reconcile',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-16',
        lastUpdated: '2026-09-16',
      },
      [
        { id: idA, title: 'Land one merged row in one call', worker: 'background-heavy', risk: 'public-API-change' },
        { id: idB, title: 'A second row that lands afterwards', worker: 'background', risk: 'mechanical' },
      ],
      { issues: [], cells: [] },
      'ok',
    );
    for (const [id, pr] of [
      [idA, prA],
      [idB, prB],
    ] as const) {
      spine = setRowState(spine, id, 'pr-created');
      spine = setRowPrCell(spine, id, pr);
    }

    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    writeFileSync(spinePath, spine, 'utf8');

    verdictsDir = join(repoRoot, '.flotilla', 'waves', SLUG, 'verdicts');

    configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: { kind: 'github' },
        engine: { cli: './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts' },
      }),
      'utf8',
    );
  }

  /** Put ONE verdict sidecar on disk for `id` at `iter`. */
  function landVerdict(id: string, iter: number, v: ReviewerVerdict = verdict()): void {
    mkdirSync(verdictsDir, { recursive: true });
    writeFileSync(
      join(verdictsDir, `${id}-${iter}.md`),
      renderSidecarBody('ReviewerVerdict', id, iter, v),
      'utf8',
    );
  }

  function argv(id: string, extra: string[] = []): string[] {
    return [
      '--spine',
      spinePath,
      '--id',
      id,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      ...extra,
    ];
  }

  function deps(over: Partial<CloseRowDeps> = {}): CloseRowDeps {
    return { store: recordingStore(), spineIo: recordingSpineIo(), today: TODAY, ...over };
  }

  const result = (): Record<string, unknown> => JSON.parse(stdout) as Record<string, unknown>;
  const steps = (): StepResult[] => result().steps as StepResult[];
  const step = (name: string): StepResult | undefined => steps().find((s) => s.step === name);
  const spineSource = (): string => readFileSync(spinePath, 'utf8');
  /**
   * The PR-Log rows for `id`, matched STRUCTURALLY (six cells, the id in cell
   * two) rather than by substring: a Plan-Table row for the same id also
   * contains `| <id> |`, and a substring match would have counted it and made
   * every "exactly one row" assertion below a test of the wrong thing.
   */
  const prLogLines = (source: string, id: string): string[] =>
    source.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) return false;
      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      return cells.length === 6 && cells[1] === id;
    });
  const closedByLines = (source: string, id: string): string[] =>
    source.split('\n').filter((l) => l.trim().startsWith(`- **${id}** —`));

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'close-row-'));
    log = [];
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

  // ── the pure `## Closed-by` rules ─────────────────────────────────────────

  describe('the `## Closed-by` line — render and read-then-upsert', () => {
    it('renders an id-keyed line the upsert finds back by the same key', () => {
      expect(renderClosedByLine('751', 'https://x/pull/1')).toBe('- **751** — https://x/pull/1');
      const first = upsertClosedByLine('', '751', 'https://x/pull/1');
      expect(first.changed).toBe(true);
      expect(upsertClosedByLine(first.body, '751', 'https://x/pull/1').changed).toBe(false);
    });

    it('an EMPTY body (the shape renderSpine produces) becomes the line, padded in the house style', () => {
      expect(upsertClosedByLine('', '751', 'https://x/pull/1').body).toBe(
        '\n- **751** — https://x/pull/1\n',
      );
    });

    it('a SECOND id is inserted after the last keyed line — the first line is byte-identical', () => {
      const one = upsertClosedByLine('', '751', 'https://x/pull/1').body;
      const two = upsertClosedByLine(one, '752', 'https://x/pull/2').body;
      expect(two.split('\n')).toEqual([
        '',
        '- **751** — https://x/pull/1',
        '- **752** — https://x/pull/2',
        '',
      ]);
      // The property stated as the check, not just as the shape: every line the
      // first upsert produced survives the second, in order.
      for (const line of one.split('\n').filter((l) => l !== '')) {
        expect(two.split('\n')).toContain(line);
      }
    });

    it('re-pinning the SAME id replaces its own line in place and touches no other', () => {
      const one = upsertClosedByLine('', '751', 'https://x/pull/1').body;
      const two = upsertClosedByLine(one, '752', 'https://x/pull/2').body;
      const repinned = upsertClosedByLine(two, '751', 'https://x/pull/9');
      expect(repinned.changed).toBe(true);
      expect(repinned.body.split('\n')).toEqual([
        '',
        '- **751** — https://x/pull/9',
        '- **752** — https://x/pull/2',
        '',
      ]);
    });

    it('hand-written prose keeps the top of the section — nothing is ever deleted', () => {
      const legacy = ['', '_(written at close time)_', '', '**Wave operational close:** —', ''].join('\n');
      const out = upsertClosedByLine(legacy, '751', 'https://x/pull/1').body;
      expect(out.split('\n')).toEqual([
        '',
        '_(written at close time)_',
        '',
        '**Wave operational close:** —',
        '',
        '- **751** — https://x/pull/1',
        '',
      ]);
    });
  });

  // ── the pure PR-URL resolution ────────────────────────────────────────────

  describe('the closing PR URL — the explicit flag, else the row cell', () => {
    const row = (prCell: string, prUrl: string | null = null) => ({ prCell, prUrl });

    it('the explicit flag wins over the row cell', () => {
      const r = resolveClosingPr({ explicit: 'https://github.com/o/r/pull/9', row: row('https://github.com/o/r/pull/1') });
      expect(r).toMatchObject({ url: 'https://github.com/o/r/pull/9', source: 'flag', classification: 'real-pr' });
    });

    it('a bare-URL row cell resolves (the form route-tuple and `spine set-row-pr` write)', () => {
      const r = resolveClosingPr({ row: row('https://github.com/o/r/pull/1') });
      expect(r).toMatchObject({ url: 'https://github.com/o/r/pull/1', source: 'row', classification: 'real-pr' });
    });

    it('a MARKDOWN-LINK row cell resolves through its parsed href', () => {
      const r = resolveClosingPr({
        row: row('[PR#8](https://github.com/o/r/pull/8)', 'https://github.com/o/r/pull/8'),
      });
      expect(r).toMatchObject({ url: 'https://github.com/o/r/pull/8', source: 'row', classification: 'real-pr' });
    });

    it('every non-real-pr class resolves to NO url, keeping its own name', () => {
      const cases: Array<[string, string]> = [
        ['pre-fill', 'https://bitbucket.org/ws/repo/pull-requests/new?source=wave/1-x'],
        ['placeholder', '<PR-URL pending>'],
        ['sha', 'a1b2c3d4e5f6'],
        ['prose', '—'],
        ['empty', ''],
      ];
      for (const [expected, cell] of cases) {
        const r = resolveClosingPr({ row: row(cell) });
        expect(r.classification, cell).toBe(expected);
        expect(r.url, cell).toBeNull();
      }
    });

    it('an explicit flag that is blank falls back to the row cell rather than resolving to empty', () => {
      const r = resolveClosingPr({ explicit: '   ', row: row('https://github.com/o/r/pull/1') });
      expect(r).toMatchObject({ source: 'row', url: 'https://github.com/o/r/pull/1' });
    });
  });

  // ── usage ─────────────────────────────────────────────────────────────────

  describe('usage — exit 2, nothing written', () => {
    beforeEach(async () => {
      await seed();
    });

    it('a missing --spine prints usage and exits 2', async () => {
      const before = spineSource();
      expect(await runCloseRow(['--id', idA], deps())).toBe(2);
      expect(stderr.split('\n')[0]).toBe('error: close-row requires --spine <spine>');
      expect(stderr).toMatch(/--pr-url/);
      expect(spineSource()).toBe(before);
      expect(log).toEqual([]);
    });

    it('a missing --id prints usage and exits 2', async () => {
      const before = spineSource();
      expect(await runCloseRow(['--spine', spinePath], deps())).toBe(2);
      expect(stderr.split('\n')[0]).toBe('error: close-row requires --id <id>');
      expect(spineSource()).toBe(before);
      expect(log).toEqual([]);
    });

    it('an unreadable --spine path prints usage and exits 2', async () => {
      const code = await runCloseRow(
        ['--spine', join(repoRoot, 'nope.md'), '--id', idA, '--config', configPath, '--repo-root', repoRoot],
        deps(),
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/could not read --spine/);
      expect(log).toEqual([]);
    });

    it('a row id that is not in the Plan-Table prints usage and exits 2, writing nothing', async () => {
      const before = spineSource();
      expect(await runCloseRow(argv('does-not-exist'), deps())).toBe(2);
      expect(stderr).toMatch(/no Plan-Table row with id "does-not-exist"/);
      expect(spineSource()).toBe(before);
      expect(log).toEqual([]);
    });
  });

  // ── the refusal ───────────────────────────────────────────────────────────

  describe('a PR cell that is not a real PR URL is refused with NOTHING written', () => {
    beforeEach(async () => {
      await seed();
      landVerdict(idA, 1);
    });

    it('refuses a placeholder cell, exit 2, spine byte-identical, tracker untouched', async () => {
      writeFileSync(spinePath, setRowPrCell(spineSource(), idA, '<PR-URL pending>'), 'utf8');
      const before = spineSource();
      const bodyBefore = (await store.read(idA)).status;

      expect(await runCloseRow(argv(idA), deps())).toBe(2);
      expect(stderr).toMatch(/classifies as "placeholder", not a real PR URL/);
      expect(spineSource()).toBe(before);
      expect(log).toEqual([]);
      expect((await store.read(idA)).status).toBe(bodyBefore);
    });

    it('refuses the un-dispatched `—` cell as prose', async () => {
      writeFileSync(spinePath, setRowPrCell(spineSource(), idA, '—'), 'utf8');
      expect(await runCloseRow(argv(idA), deps())).toBe(2);
      expect(stderr).toMatch(/classifies as "prose"/);
      expect(log).toEqual([]);
    });

    it('refuses a Bitbucket PRE-FILL link — the one that looks most like a PR URL', async () => {
      writeFileSync(
        spinePath,
        setRowPrCell(spineSource(), idA, 'https://bitbucket.org/ws/repo/pull-requests/new?source=wave/1-x'),
        'utf8',
      );
      expect(await runCloseRow(argv(idA), deps())).toBe(2);
      expect(stderr).toMatch(/classifies as "pre-fill"/);
      expect(log).toEqual([]);
    });

    it('an explicit --pr-url that is not a real PR URL is refused too', async () => {
      expect(await runCloseRow(argv(idA, ['--pr-url', 'see the PR']), deps())).toBe(2);
      expect(stderr).toMatch(/source: flag/);
      expect(log).toEqual([]);
    });
  });

  // ── the order — the write-ahead property, observed ────────────────────────

  describe('one run: both spine writes, then the tracker close', () => {
    beforeEach(async () => {
      await seed();
      landVerdict(idA, 1);
    });

    it('performs the four steps in order and calls close(id, prUrl, acked) LAST', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);

      expect(steps().map((s) => s.step)).toEqual([
        'spine-pr-log',
        'spine-closed-by',
        'verdict-acked',
        'store-close',
      ]);
      expect(log.map((e) => e.call)).toEqual(['spine.write', 'spine.write', 'store.close']);
      expect(log[2].args).toEqual({ id: idA, prUrl: prA, acked: [0, 2] });
    });

    it('the bytes prove the order: PR-Log lands first, Closed-by second, close third', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      const line = renderClosedByLine(idA, prA);

      expect(log[0].source).toContain(`| ${idA} | ${prA} |`);
      expect(log[0].source).not.toContain(line);
      expect(log[1].source).toContain(`| ${idA} | ${prA} |`);
      expect(log[1].source).toContain(line);
      // …and the tracker write happened after BOTH of them.
      expect(log.findIndex((e) => e.call === 'store.close')).toBe(2);
    });

    it('scaffolds the PR-Log table into the bare heading renderSpine produced, and readSpine reads the row back', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      const parsed = readSpine(spineSource());
      expect(parsed.prLog).toHaveLength(1);
      expect(parsed.prLog[0]).toMatchObject({
        created: TODAY,
        id: idA,
        prCell: prA,
        closes: `Closes #${idA}`,
        merged: TODAY,
        notes: '—',
      });
    });

    it('writes the Closed-by line into the section renderSpine emitted empty', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      expect(readSpine(spineSource()).closedBy.body).toContain(renderClosedByLine(idA, prA));
    });

    it('prints the acked indexes, the verdict iteration it used, and the closing state', async () => {
      landVerdict(idA, 2, verdict({
        acVerification: [
          { ac: 'the verb lands one merged row', met: 'met', evidence: 'x' },
          { ac: 'the second row keeps the first intact', met: 'met', evidence: 'y' },
          { ac: 'the refusal writes nothing', met: 'not-met', evidence: 'z' },
        ],
      }));
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      // The MAX-iter sidecar wins — iteration 1's [0, 2] is never picked over
      // iteration 2's [0, 1].
      expect(result().acked).toEqual([0, 1]);
      expect(result().verdictIter).toBe(2);
      expect(result().corruptVerdicts).toBe(0);
      expect(result().closing).toMatchObject({ state: 'open' });
      expect(result().prUrlSource).toBe('row');
      expect(result().wrote).toEqual({ spine: true, tracker: true });
    });

    it('the AC tick reaches the tracker — the dead --acked wire, live', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      const view = await store.read(idA);
      expect(view.acceptanceCriteria?.map((ac) => ac.checked)).toEqual([true, false, true]);
      expect(view.closedBy).toBe(prA);
    });
  });

  // ── the verdict sidecar is not a gate ─────────────────────────────────────

  describe('a missing or invalid verdict sidecar yields acked: [] and the run still completes', () => {
    beforeEach(async () => {
      await seed();
    });

    it('no sidecar at all → acked [], iter null, the step reports `skipped`, close still runs', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      expect(result().acked).toEqual([]);
      expect(result().verdictIter).toBeNull();
      expect(step('verdict-acked')).toMatchObject({ status: 'skipped' });
      expect(log.map((e) => e.call)).toEqual(['spine.write', 'spine.write', 'store.close']);
      expect(log[2].args).toEqual({ id: idA, prUrl: prA, acked: [] });
    });

    it('a schema-INVALID sidecar is counted as corrupt, still yields acked [], and still closes', async () => {
      mkdirSync(verdictsDir, { recursive: true });
      writeFileSync(
        join(verdictsDir, `${idA}-1.md`),
        renderSidecarBody('ReviewerVerdict', idA, 1, { verdict: 'approve' }),
        'utf8',
      );
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      expect(result().acked).toEqual([]);
      expect(result().verdictIter).toBeNull();
      expect(result().corruptVerdicts).toBe(1);
      expect(step('verdict-acked')).toMatchObject({ status: 'skipped', corrupt: 1 });
    });

    it('the default verdicts dir is derived from the spine path when --verdicts-dir is absent', async () => {
      landVerdict(idA, 1);
      expect(await runCloseRow(argv(idA), deps())).toBe(0);
      expect(result().acked).toEqual([0, 2]);
      expect(step('verdict-acked')).toMatchObject({ verdictsDir });
    });
  });

  // ── idempotence ───────────────────────────────────────────────────────────

  describe('idempotence — a re-run leaves exactly one of each line and closes again', () => {
    beforeEach(async () => {
      await seed();
      landVerdict(idA, 1);
    });

    it('a second run for the same id reports both spine steps `performed-before` and re-calls close identically', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      const afterFirst = spineSource();
      const firstCloseArgs = log[2].args;

      log = [];
      stdout = '';
      // A LATER day: `Created` and `Merged` are preserved from the row on disk,
      // which is what keeps the re-run a described no-op instead of a rewrite.
      expect(
        await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps({ today: '2026-12-31' })),
      ).toBe(0);

      expect(step('spine-pr-log')).toMatchObject({ status: 'performed-before' });
      expect(step('spine-closed-by')).toMatchObject({ status: 'performed-before' });
      expect(result().wrote).toEqual({ spine: false, tracker: true });
      expect(spineSource()).toBe(afterFirst);
      expect(log.map((e) => e.call)).toEqual(['store.close']);
      expect(log[0].args).toEqual(firstCloseArgs);

      expect(prLogLines(spineSource(), idA)).toHaveLength(1);
      expect(closedByLines(spineSource(), idA)).toHaveLength(1);
    });

    it('landing a SECOND id keeps the first id\'s PR-Log row and Closed-by line byte-identical', async () => {
      landVerdict(idB, 1);
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      const rowABefore = prLogLines(spineSource(), idA);
      const closedABefore = closedByLines(spineSource(), idA);
      expect(rowABefore).toHaveLength(1);
      expect(closedABefore).toHaveLength(1);

      stdout = '';
      log = [];
      expect(await runCloseRow(argv(idB, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);

      // The whole point: a whole-section rewrite would have taken row A's line
      // with it. Both survive, byte for byte.
      expect(prLogLines(spineSource(), idA)).toEqual(rowABefore);
      expect(closedByLines(spineSource(), idA)).toEqual(closedABefore);
      expect(prLogLines(spineSource(), idB)).toHaveLength(1);
      expect(closedByLines(spineSource(), idB)).toHaveLength(1);
      expect(readSpine(spineSource()).prLog.map((r) => r.id)).toEqual([idA, idB]);
    });

    it('a re-pin to a DIFFERENT PR URL rewrites only that row\'s two lines', async () => {
      landVerdict(idB, 1);
      await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps());
      stdout = '';
      await runCloseRow(argv(idB, ['--verdicts-dir', verdictsDir]), deps());
      const rowBBefore = prLogLines(spineSource(), idB);
      stdout = '';
      log = [];

      const rePinned = 'https://github.com/example-org/example-repo/pull/999';
      expect(
        await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir, '--pr-url', rePinned]), deps()),
      ).toBe(0);
      expect(step('spine-pr-log')).toMatchObject({ status: 'performed' });
      expect(step('spine-closed-by')).toMatchObject({ status: 'performed' });
      expect(result().prUrlSource).toBe('flag');
      expect(prLogLines(spineSource(), idA)).toHaveLength(1);
      expect(closedByLines(spineSource(), idA)).toEqual([renderClosedByLine(idA, rePinned)]);
      // Row B untouched.
      expect(prLogLines(spineSource(), idB)).toEqual(rowBBefore);
    });
  });

  // ── the closing state and the STILL OPEN line ─────────────────────────────

  describe('the closing state the store reports rides out on stdout, and `open` shouts on stderr', () => {
    beforeEach(async () => {
      await seed();
      landVerdict(idA, 1);
    });

    it('a tracker that still reads `open` gets the STILL OPEN line, verbatim, and exit 0', async () => {
      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      expect(result().closing).toMatchObject({ state: 'open' });
      // #801: the line says what the READER does next in their own terms and
      // names no document — a consumer repo has this engine but not this
      // repo's release procedure, so a pointer at one was unfollowable.
      expect(stderr).toContain(
        `STILL OPEN: issue ${idA} recorded closing facts (${prA}) but the ` +
          'tracker still reports it OPEN — this call does not natively close ' +
          'an issue whose satisfying act was not a merged PR carrying its own ' +
          'close phrase. It stays open until that native close happens, and ' +
          'there is no further close verb to reach for: close it by hand in ' +
          'the tracker.',
      );
      // …and the line itself points at no maintainer-only document of any
      // kind. Asserted on the LINE, not on the whole stream, so an unrelated
      // future stderr write cannot make this read red for the wrong reason.
      const line = stderr.split('\n').find((l) => l.startsWith('STILL OPEN:'))!;
      expect(line).not.toMatch(/RELEASING/);
      expect(line).not.toMatch(/\.md\b/);
    });

    it('a natively-closed, merged issue reports `merged` and prints NO STILL OPEN line', async () => {
      const api = (store as unknown as { api: InMemoryGitHubApi }).api;
      await api.nativeClose(Number(idA), 'completed');
      await api.setClosingPr(Number(idA), { merged: true, url: prA });

      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(0);
      expect(result().closing).toMatchObject({ state: 'merged', prUrl: prA });
      expect(step('store-close')).toMatchObject({ status: 'performed', closingState: 'merged' });
      expect(stderr).not.toContain('STILL OPEN:');
    });

    /**
     * The two renderings can no longer drift apart, because there is only one
     * of them (#800): `issue-store-cli.ts` exports `stillOpenLine` and this
     * verb calls that same function rather than carrying its own copy. What
     * this pins is that the call site is wired to the shared renderer for
     * these exact inputs — a regression here would mean `close-row` built its
     * own line again (by inlining, or by a stale re-copy), not that the
     * shared renderer changed underneath it (`issue-store-cli.spec.ts` pins
     * that renderer's own literal text).
     */
    it("close-row's STILL OPEN line equals the shared `stillOpenLine(id, prUrl)` for the same inputs", async () => {
      await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps());
      const mine = stderr
        .split('\n')
        .find((l) => l.startsWith('STILL OPEN:'))!;
      expect(mine).toBeDefined();
      expect(mine + '\n').toBe(stillOpenLine(idA, prA));
    });
  });

  // ── the sections this verb will not invent ────────────────────────────────

  describe('a spine missing a section this verb writes into is a refusal, not a half-write', () => {
    beforeEach(async () => {
      await seed();
    });

    it('no `## Closed-by` section → exit 1 BEFORE the PR-Log write, nothing on disk', async () => {
      const stripped = spineSource()
        .split('\n')
        .filter((l) => l !== '## Closed-by')
        .join('\n');
      writeFileSync(spinePath, stripped, 'utf8');
      const before = spineSource();

      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(1);
      expect(stderr).toMatch(/has no "## Closed-by" section/);
      expect(spineSource()).toBe(before);
      expect(log).toEqual([]);
    });

    it('no `## PR-Log` section → exit 1, and the store is never reached', async () => {
      const stripped = spineSource()
        .split('\n')
        .filter((l) => l !== '## PR-Log')
        .join('\n');
      writeFileSync(spinePath, stripped, 'utf8');

      expect(await runCloseRow(argv(idA, ['--verdicts-dir', verdictsDir]), deps())).toBe(1);
      expect(stderr).toMatch(/no "## PR-Log" section/);
      expect(log.some((e) => e.call === 'store.close')).toBe(false);
    });
  });
});
