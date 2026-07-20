/**
 * find-repo-root.spec.ts — Regression net for the `findRepoRoot` footgun.
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
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot } from './cli';
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
