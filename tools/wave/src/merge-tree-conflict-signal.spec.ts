/**
 * merge-tree-conflict-signal.spec.ts — what the Reviewer's sibling prediction
 * rests on, asserted against real git instead of recalled from its manual.
 *
 * ## Why this file exists
 *
 * Every copy of the Reviewer's sibling-prediction recipe (the checks
 * reference's Check 5, the packaged driver's Reviewer brief, the reviewer
 * skill and the agent definition) used to read a conflict off conflict
 * markers in the `git merge-tree` output. The two-argument form
 * `git merge-tree <a> <b>` runs in `--write-tree` mode, and in that mode the
 * markers go into the tree it writes, never to stdout; on a conflict it exits
 * 1 and prints `CONFLICT (…)` lines. A Reviewer who scanned stdout for
 * markers therefore recorded every real conflict as predicted-clean. The
 * recipe now reads the exit status and names the files from the `CONFLICT (`
 * lines, and `skill-schema-drift.spec.ts` holds that wording in all four
 * copies. This file holds the git behaviour the wording rests on, so a git
 * release that changed it turns this red before a Reviewer is misled again.
 *
 * ## What each case asserts
 *
 *   - **conflict** — exit 1, a `CONFLICT (` line naming the file, and no
 *     marker on stdout. The control that makes "no marker on stdout" mean
 *     something: the tree whose id it printed DOES carry the markers, so they
 *     exist and are simply not where the retired recipe looked.
 *   - **clean** — exit 0, one line (the tree id), no `CONFLICT (` line.
 *   - **at-anchor** — a second side still at the base also exits 0 with the
 *     same one-line shape, which is why the recipe compares tips before it
 *     reads the result.
 *   - **an argument that is not a commit** — exit 1 with NO `CONFLICT (` line.
 *     The manual says an error exits "something other than 0 or 1"; measured,
 *     this error exits 1. That is why the recipe reads an exit 1 without a
 *     `CONFLICT (` line as an error, not a conflict.
 *   - **unrelated histories** — an exit other than 0 or 1, the recipe's
 *     "any other exit → not covered".
 *
 * Fixtures are real throwaway repositories under the OS temp directory, cut
 * off from the machine's global and system git configuration
 * (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, every other `GIT_*`
 * variable dropped), so a user-level `merge.conflictStyle`,
 * `commit.gpgsign` or a hook-exported `GIT_DIR` cannot change what they show.
 *
 * Measurements and the live occurrences behind the rule:
 * `.claude/skills/wave-reviewer/evidence/reviewer-checks.md`.
 *
 * Pure test — zero production change.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The first conflict marker, the one every retired copy of the recipe named. */
const OURS_MARKER = '<<<<<<<';
/** The last conflict marker. */
const THEIRS_MARKER = '>>>>>>>';
/** The prefix of the messages the recipe names conflicting files from. */
const CONFLICT_LINE = 'CONFLICT (';

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The environment every git call here runs in: no inherited `GIT_*`, no global or system config. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

describe('merge-tree-conflict-signal — the two-argument git merge-tree signals a conflict by its exit status', () => {
  let repo = '';

  /** Run git in the fixture repo and hand back what it did — never throws on a non-zero exit. */
  function git(...args: string[]): GitResult {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8', env: isolatedEnv() });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /** Run a fixture-setup git call that must succeed. */
  function setup(...args: string[]): void {
    const r = git(...args);
    if (r.status !== 0) {
      throw new Error(`fixture setup failed: git ${args.join(' ')} → ${r.status}\n${r.stderr}`);
    }
  }

  /** Commit `content` to `file` on `branch`, starting from `from`. */
  function commitOn(branch: string, from: string, file: string, content: string): void {
    setup('checkout', '-q', '-b', branch, from);
    writeFileSync(join(repo, file), content, 'utf-8');
    setup('add', file);
    setup('commit', '-q', '-m', branch);
  }

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'wave-merge-tree-signal-')));
    setup('init', '-q');
    setup('config', 'user.email', 'test@example.com');
    setup('config', 'user.name', 'Test');
    setup('config', 'commit.gpgsign', 'false');
    setup('config', 'core.excludesFile', '/dev/null');
    writeFileSync(join(repo, 'a.txt'), 'line one\nline two\nline three\n', 'utf-8');
    writeFileSync(join(repo, 'b.txt'), 'other\n', 'utf-8');
    setup('add', 'a.txt', 'b.txt');
    setup('commit', '-q', '-m', 'base');
    setup('branch', '-M', 'base');
    // Two sides editing the same line of a.txt — a real content conflict.
    commitOn('left', 'base', 'a.txt', 'line one\nLEFT two\nline three\n');
    commitOn('right', 'base', 'a.txt', 'line one\nRIGHT two\nline three\n');
    // A side editing only b.txt — merges cleanly with `left`.
    commitOn('disjoint', 'base', 'b.txt', 'changed\n');
    // A side still sitting at the base — the at-anchor case.
    setup('branch', 'at-base', 'base');
    // A root commit sharing no history with the rest.
    setup('checkout', '-q', '--orphan', 'lonely');
    setup('rm', '-q', '-r', '-f', '.');
    writeFileSync(join(repo, 'c.txt'), 'lonely\n', 'utf-8');
    setup('add', 'c.txt');
    setup('commit', '-q', '-m', 'lonely');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('a real conflict exits 1, prints a CONFLICT ( line naming the file, and prints no conflict marker on stdout', () => {
    const r = git('merge-tree', 'left', 'right');
    expect(r.status).toBe(1);
    const conflictLines = r.stdout.split('\n').filter((l) => l.startsWith(CONFLICT_LINE));
    expect(conflictLines.length).toBeGreaterThan(0);
    expect(conflictLines.join('\n')).toContain('a.txt');
    expect(r.stdout).not.toContain(OURS_MARKER);
    expect(r.stdout).not.toContain(THEIRS_MARKER);
  });

  it('CONTROL — the markers exist, in the tree whose id the conflict printed first', () => {
    // Without this, "no marker on stdout" could mean the fixture never
    // conflicted at all. The markers are real; they are in the written tree.
    const r = git('merge-tree', 'left', 'right');
    const tree = r.stdout.split('\n')[0];
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    const merged = git('cat-file', '-p', `${tree}:a.txt`);
    expect(merged.status).toBe(0);
    expect(merged.stdout).toContain(`${OURS_MARKER} left`);
    expect(merged.stdout).toContain(`${THEIRS_MARKER} right`);
  });

  it('a clean merge exits 0 and prints one line, the tree id, with no CONFLICT ( line', () => {
    const r = git('merge-tree', 'left', 'disjoint');
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40,64}$/);
    expect(r.stdout).not.toContain(CONFLICT_LINE);
  });

  it('a side still at the base exits 0 with the same one-line shape as a clean merge — the at-anchor vacuity', () => {
    const atAnchor = git('merge-tree', 'left', 'at-base');
    const clean = git('merge-tree', 'left', 'disjoint');
    expect(atAnchor.status).toBe(0);
    expect(atAnchor.stdout.trimEnd().split('\n')).toHaveLength(1);
    // Nothing in the output separates the two; only a tip comparison does.
    expect(atAnchor.status).toBe(clean.status);
    expect(atAnchor.stdout.trimEnd().split('\n').length).toBe(clean.stdout.trimEnd().split('\n').length);
  });

  it('an argument that is not a commit exits 1 too, with no CONFLICT ( line — so exit 1 alone is not a conflict', () => {
    for (const notACommit of ['refs/review/sib/does-not-exist', 'base^{tree}']) {
      const r = git('merge-tree', 'left', notACommit);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain(CONFLICT_LINE);
      expect(r.stderr).toMatch(/not something we can merge/);
    }
  });

  it('an error that is not a conflict exits something other than 0 or 1 — the recipe\'s "any other exit"', () => {
    const r = git('merge-tree', 'left', 'lonely');
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(1);
    expect(r.stdout).not.toContain(CONFLICT_LINE);
    expect(r.stderr).toMatch(/unrelated histories/);
  });
});
