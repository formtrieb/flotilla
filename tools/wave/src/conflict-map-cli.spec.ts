/**
 * conflict-map-cli.spec.ts — the two invocation forms of the conflict-map CLI.
 *
 * The PATH form (`runConflictMap`) reads issue FILES; the STORE form
 * (`runConflictMapById`, ADR-0014 parity with `dor --id`) reads each issue from
 * a configured IssueStore. Both feed the byte-identical engine
 * (`computeConflictMap`) and print the same JSON cell shape — these tests pin
 * that parity, the store-read overlap detection, and the arg-guard behaviour
 * (missing `--id`, and paths mixed with `--id`).
 *
 * The store is a hand-rolled fake (no network, no config) — the store form is
 * exercised through its `injected` seam exactly as the `dor --id` specs do.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConflictMap, runConflictMapById } from './conflict-map-cli';
import type { IssueStore } from './adapters/issue-store';
import type { IssueView } from './contract';
import type { ConflictMap } from './conflict-map';

// ─── stdout / stderr capture ────────────────────────────────────────────────

let stdoutBuf: string;
let stderrBuf: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ─── fake store ─────────────────────────────────────────────────────────────

/** Minimal IssueView; only `id` + `files` matter to the conflict-map engine. */
function view(id: string, files: string[]): IssueView {
  return {
    id,
    risk: 'mechanical',
    worker: 'background',
    files,
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'x', checked: false }],
    status: 'available',
  };
}

/** A store that resolves a fixed id→IssueView map (throws on an unknown id). */
function storeOf(views: Record<string, IssueView>): IssueStore {
  return {
    read: async (id: string) => {
      const v = views[id];
      if (v === undefined) throw new Error(`no such issue: ${id}`);
      return v;
    },
  } as unknown as IssueStore;
}

function parseStdout(): ConflictMap {
  return JSON.parse(stdoutBuf) as ConflictMap;
}

// ─── STORE form: overlap detection ──────────────────────────────────────────

describe('conflict-map --id (store-backed, non-file)', () => {
  it('reports an overlap cell for two store-read issues sharing a concrete file', async () => {
    const store = storeOf({
      'ENG-1': view('ENG-1', ['src/shared.ts', 'src/a.ts']),
      'ENG-2': view('ENG-2', ['src/shared.ts', 'src/b.ts']),
    });

    const code = await runConflictMapById(['--id', 'ENG-1', '--id', 'ENG-2'], store);

    expect(code).toBe(0);
    const out = parseStdout();
    expect(out.issues).toEqual(['ENG-1', 'ENG-2']);
    expect(out.cells).toEqual([{ a: 'ENG-1', b: 'ENG-2', files: ['src/shared.ts'] }]);
  });

  it('expands intersecting GLOBS via --repo-root and reports the overlapping file', async () => {
    // A real fixture tree so the engine's fast-glob expansion runs: both issues
    // declare `src/*.ts`, which expands to the same concrete file.
    const repoRoot = mkdtempSync(join(tmpdir(), 'cmap-glob-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'overlap.ts'), '// x', 'utf-8');

    const store = storeOf({
      'ENG-1': view('ENG-1', ['src/*.ts']),
      'ENG-2': view('ENG-2', ['src/*.ts']),
    });

    const code = await runConflictMapById(
      ['--id', 'ENG-1', '--id', 'ENG-2', '--repo-root', repoRoot],
      store,
    );

    expect(code).toBe(0);
    const out = parseStdout();
    expect(out.cells).toEqual([{ a: 'ENG-1', b: 'ENG-2', files: ['src/overlap.ts'] }]);
    // A real repoRoot was supplied, so no unexpanded-glob warning is emitted.
    expect(out.warnings).toBeUndefined();
  });

  it('emits no cells when the two store-read issues are file-disjoint', async () => {
    const store = storeOf({
      'ENG-1': view('ENG-1', ['src/a.ts']),
      'ENG-2': view('ENG-2', ['src/b.ts']),
    });

    const code = await runConflictMapById(['--id', 'ENG-1', '--id', 'ENG-2'], store);

    expect(code).toBe(0);
    const out = parseStdout();
    expect(out.issues).toEqual(['ENG-1', 'ENG-2']);
    expect(out.cells).toEqual([]);
  });

  it('reads a single --id and prints a well-formed (empty-cells) map', async () => {
    const store = storeOf({ 'ENG-1': view('ENG-1', ['src/a.ts']) });

    const code = await runConflictMapById(['--id', 'ENG-1'], store);

    expect(code).toBe(0);
    const out = parseStdout();
    expect(out.issues).toEqual(['ENG-1']);
    expect(out.cells).toEqual([]);
  });

  it('returns usage (2) when no --id is given', async () => {
    const code = await runConflictMapById([], storeOf({}));

    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--id requires/);
    expect(stderrBuf).toMatch(/usage:/);
  });

  it('errors with usage (2) when paths are mixed with --id', async () => {
    const code = await runConflictMapById(
      ['--id', 'ENG-1', 'issues/07-something.md'],
      storeOf({ 'ENG-1': view('ENG-1', ['src/a.ts']) }),
    );

    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/cannot mix issue paths and --id/);
    expect(stderrBuf).toMatch(/usage:/);
  });

  it('exits 1 and reports to stderr when a store read fails', async () => {
    const store = storeOf({ 'ENG-1': view('ENG-1', ['src/a.ts']) });

    const code = await runConflictMapById(['--id', 'ENG-1', '--id', 'MISSING'], store);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/cannot read issue MISSING/);
  });
});

// ─── PATH form: unchanged + same cell shape as the store form ───────────────

describe('conflict-map <path> (path form) — behaviour unchanged', () => {
  function writeIssue(dir: string, nn: string, files: string[]): string {
    const path = join(dir, `${nn}-x.md`);
    writeFileSync(
      path,
      [
        `# ${nn} — x`,
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        ...files.map((f) => `- ${f}`),
        '**Blocked by:** none',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  it('returns usage (2) with no args', () => {
    const code = runConflictMap([]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/usage:/);
  });

  it('prints the same JSON cell shape as the store form for an overlap', () => {
    const root = mkdtempSync(join(tmpdir(), 'cmap-path-'));
    const issueDir = join(root, '.scratch', 'slug', 'issues');
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"r"}', 'utf-8');
    const a = writeIssue(issueDir, '01', ['src/shared.ts', 'src/a.ts']);
    const b = writeIssue(issueDir, '02', ['src/shared.ts', 'src/b.ts']);

    const code = runConflictMap([a, b]);

    expect(code).toBe(0);
    const out = parseStdout();
    expect(out.issues).toEqual(['slug#01', 'slug#02']);
    // Identical cell shape {a,b,files} as the store form — only the ids differ.
    expect(out.cells).toEqual([{ a: 'slug#01', b: 'slug#02', files: ['src/shared.ts'] }]);
  });
});
