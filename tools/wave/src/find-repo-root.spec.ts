/**
 * find-repo-root.spec.ts — Regression net for the `findRepoRoot` footgun, plus
 * (FOR-48) the legacy-warning-retirement coverage.
 *
 * Bug: `findRepoRoot(start)` walked up looking for a dir with BOTH a `.scratch/`
 * subdir AND a sibling `package.json`, and SILENTLY fell back to `process.cwd()`
 * when none was found. A freshly-created MarkdownFsStore root has no
 * package.json, so the real `.scratch` root was skipped and cwd was used
 * instead — making Gate-5 `blocked-by-chain-resolves` resolve sibling issues
 * against the WRONG root (false FAIL, or worse a false PASS if cwd happens to
 * have a matching `.scratch`).
 *
 * The fix anchors on the nearest `.scratch/` ancestor of `start`; package.json
 * is no longer required.
 *
 * FOR-48: the fallback-to-cwd path used to unconditionally print a "no
 * .scratch/ ancestor found" warning — firing on EVERY run for a consumer
 * without a `.scratch/` layout at all (any GitHub/Linear-backed wave). The
 * warning is now opt-in (`warnOnFallback` / `WAVE_WARN_NO_SCRATCH_ROOT=1`),
 * silent-off by default. Both paths are covered below.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from './cli';
import { findScratchRoot } from './find-repo-root';
import { validateIssue } from './dor-gate';

describe('findRepoRoot — anchors on the nearest .scratch ancestor', () => {
  let root: string;
  let issueDir: string;
  let issue02: string;

  beforeAll(() => {
    // A bare MarkdownFsStore-style root: .scratch/<slug>/issues/, NO package.json.
    root = mkdtempSync(join(tmpdir(), 'find-repo-root-spec-'));
    issueDir = join(root, '.scratch', 'mystore', 'issues');
    mkdirSync(issueDir, { recursive: true });

    // #1 — blocked by nothing (the resolvable blocker).
    writeFileSync(
      join(issueDir, '01-first.md'),
      [
        '# 01 — First',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- some/a.ts',
        '**Blocked by:** none',
        '',
        '## What to build',
        '',
        'A thing.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] Built',
      ].join('\n'),
      'utf-8',
    );

    // #2 — blocked by mystore#1, which DOES exist next door.
    issue02 = join(issueDir, '02-second.md');
    writeFileSync(
      issue02,
      [
        '# 02 — Second',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- some/b.ts',
        '**Blocked by:** mystore#1',
        '',
        '## What to build',
        '',
        'Another thing.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] Built',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the .scratch root even without a sibling package.json', () => {
    // Resolution must NOT depend on cwd: drive from a foreign cwd.
    expect(findRepoRoot(issue02)).toBe(root);
  });

  it('Gate-5 blocked-by-chain-resolves PASSes against the .scratch root', () => {
    const repoRoot = findRepoRoot(issue02);
    const source = require('node:fs').readFileSync(issue02, 'utf-8');
    const result = validateIssue({ repoRoot, issuePath: issue02, source });
    const gate5 = result.gates.find(
      (g) => g.name === 'blocked-by-chain-resolves',
    );
    expect(gate5?.status).toBe('pass');
  });
});

describe('findScratchRoot — the .scratch-ancestor warning is opt-in (FOR-48)', () => {
  // A directory tree with NO `.scratch/` ancestor anywhere — the shape of
  // every GitHub/Linear-backed wave (no MarkdownFsStore layout at all).
  let noScratchStart: string;

  beforeAll(() => {
    noScratchStart = mkdtempSync(join(tmpdir(), 'find-repo-root-no-scratch-'));
  });

  afterAll(() => {
    rmSync(noScratchStart, { recursive: true, force: true });
  });

  it('falls back to cwd silently by default — no legacy warning on stderr', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = findScratchRoot(noScratchStart);
    expect(result).toBe(process.cwd());
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('stays silent when an injected env leaves WAVE_WARN_NO_SCRATCH_ROOT unset/off', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = findScratchRoot(noScratchStart, {
      env: { WAVE_WARN_NO_SCRATCH_ROOT: '0' } as NodeJS.ProcessEnv,
    });
    expect(result).toBe(process.cwd());
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('the cli.ts findRepoRoot wrapper stays silent by default too — every consumer benefits', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = findRepoRoot(noScratchStart);
    expect(result).toBe(process.cwd());
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('the on-behavior stays covered: warnOnFallback: true prints the legacy warning', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = findScratchRoot(noScratchStart, { warnOnFallback: true });
    expect(result).toBe(process.cwd());
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toMatch(
      /no \.scratch\/ ancestor found/,
    );
    stderrSpy.mockRestore();
  });

  it('the on-behavior stays covered: WAVE_WARN_NO_SCRATCH_ROOT=1 (injected env) prints the legacy warning', () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const result = findScratchRoot(noScratchStart, {
      env: { WAVE_WARN_NO_SCRATCH_ROOT: '1' } as NodeJS.ProcessEnv,
    });
    expect(result).toBe(process.cwd());
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
  });
});
