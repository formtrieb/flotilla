import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';

import { parsePatterns, runCheck, scanFileContent } from './check-client-refs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, 'check-client-refs.mjs');
const DENYLIST_FILENAME = '.declient-denylist';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create a throwaway git repo with the given tracked files staged (no
 * commit needed — `git ls-files` reads the index). Returns the repo root.
 * @param {Record<string, string>} files relative path -> file content
 */
function makeTrackedRepo(files) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'declient-'));
  tempDirs.push(repoRoot);
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  if (Object.keys(files).length > 0) {
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
  }
  return repoRoot;
}

/** Write the denylist file WITHOUT tracking it (mirrors the real gitignored file). */
function writeDenylist(repoRoot, content) {
  const denylistPath = path.join(repoRoot, DENYLIST_FILENAME);
  writeFileSync(denylistPath, content);
  return denylistPath;
}

describe('parsePatterns', () => {
  test('drops blank lines and #-comment lines', () => {
    const patterns = parsePatterns(
      ['# a comment', 'realname', '', '   ', '#another comment', 'secondname', '  indented  '].join('\n'),
    );
    assert.deepEqual(patterns, ['realname', 'secondname', 'indented']);
  });

  test('empty content yields no patterns', () => {
    assert.deepEqual(parsePatterns(''), []);
    assert.deepEqual(parsePatterns('\n\n# only comments\n'), []);
  });
});

describe('scanFileContent', () => {
  test('matches case-insensitively, one hit per (line, pattern)', () => {
    const hits = scanFileContent(
      ['nothing here', 'This mentions SecretCo in prose', 'SECRETCO again here'].join('\n'),
      ['secretco'],
    );
    assert.deepEqual(hits, [
      { line: 2, pattern: 'secretco' },
      { line: 3, pattern: 'secretco' },
    ]);
  });

  test('multiple distinct patterns on the same line both hit', () => {
    const hits = scanFileContent('alpha and beta together', ['alpha', 'beta']);
    assert.deepEqual(hits, [
      { line: 1, pattern: 'alpha' },
      { line: 1, pattern: 'beta' },
    ]);
  });

  test('no patterns means no hits', () => {
    assert.deepEqual(scanFileContent('anything at all', []), []);
  });

  test('no matches means no hits', () => {
    assert.deepEqual(scanFileContent('clean content only', ['nomatch']), []);
  });
});

describe('runCheck — the three outcomes', () => {
  test('outcome: hits found — reports file, line and pattern for every match', () => {
    const repoRoot = makeTrackedRepo({
      'notes.md': ['line one is fine', 'line two mentions SecretCo here', 'line three is fine'].join('\n'),
      'src/deep/file.txt': 'nothing interesting',
    });
    const denylistPath = writeDenylist(repoRoot, '# denylist\nSecretCo\n');

    const result = runCheck({ repoRoot, denylistPath });

    assert.equal(result.status, 'hits');
    assert.equal(result.scanned, 2);
    assert.deepEqual(result.hits, [{ file: 'notes.md', line: 2, pattern: 'SecretCo' }]);
  });

  test('outcome: hits found — every match across the tree is named, not just the first', () => {
    const repoRoot = makeTrackedRepo({
      'a.md': 'AcmeCorp shows up here',
      'b.md': 'and AcmeCorp shows up here too, twice AcmeCorp',
    });
    const denylistPath = writeDenylist(repoRoot, 'AcmeCorp\n');

    const result = runCheck({ repoRoot, denylistPath });

    assert.equal(result.status, 'hits');
    // one hit per (file, line, pattern) — b.md's single line hits once even
    // though the pattern occurs twice on it, per the documented contract.
    assert.deepEqual(result.hits, [
      { file: 'a.md', line: 1, pattern: 'AcmeCorp' },
      { file: 'b.md', line: 1, pattern: 'AcmeCorp' },
    ]);
  });

  test('outcome: clean scan — zero hits, reports a scanned-N-files summary', () => {
    const repoRoot = makeTrackedRepo({
      'notes.md': 'nothing sensitive in here',
      'src/deep/file.txt': 'also nothing sensitive',
    });
    const denylistPath = writeDenylist(repoRoot, 'SecretCo\n# comment\nOtherName\n');

    const result = runCheck({ repoRoot, denylistPath });

    assert.equal(result.status, 'clean');
    assert.equal(result.scanned, 2);
  });

  test('outcome: list absent — exits clean-shaped but flagged as skipped, not scanned', () => {
    const repoRoot = makeTrackedRepo({ 'notes.md': 'anything at all' });
    const denylistPath = path.join(repoRoot, DENYLIST_FILENAME); // never written

    assert.equal(existsSync(denylistPath), false);
    const result = runCheck({ repoRoot, denylistPath });

    assert.equal(result.status, 'skipped');
    assert.equal('scanned' in result, false);
    assert.equal('hits' in result, false);
  });

  test('the denylist file itself is never scanned (it is untracked, never in git ls-files)', () => {
    // Denylist content itself contains the pattern text — if the scanner
    // ever walked the filesystem instead of `git ls-files`, or read
    // patterns from a tracked copy, this would spuriously self-hit.
    const repoRoot = makeTrackedRepo({ 'notes.md': 'nothing sensitive in here' });
    const denylistPath = writeDenylist(repoRoot, 'SecretCo\n');

    const result = runCheck({ repoRoot, denylistPath });

    assert.equal(result.status, 'clean');
  });
});

describe('CLI end-to-end (spawns the real script)', () => {
  test('hits found -> exit 1, stdout names file:line: pattern', () => {
    const repoRoot = makeTrackedRepo({
      'notes.md': ['fine', 'this line names SecretCo', 'fine again'].join('\n'),
    });
    writeDenylist(repoRoot, 'SecretCo\n');

    const proc = spawnSync('node', [SCRIPT_PATH], { cwd: repoRoot, encoding: 'utf8' });

    assert.equal(proc.status, 1);
    assert.match(proc.stdout, /notes\.md:2: SecretCo/);
  });

  test('clean scan -> exit 0, loudly "OK" + scanned-N-files, no SKIPPED', () => {
    const repoRoot = makeTrackedRepo({ 'notes.md': 'nothing sensitive here' });
    writeDenylist(repoRoot, 'SecretCo\n');

    const proc = spawnSync('node', [SCRIPT_PATH], { cwd: repoRoot, encoding: 'utf8' });

    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /OK - scanned 1 tracked files, 0 hits/);
    assert.doesNotMatch(proc.stdout, /SKIPPED/);
  });

  test('list absent -> exit 0, loud SKIPPED notice distinct from the clean-scan summary', () => {
    const repoRoot = makeTrackedRepo({ 'notes.md': 'nothing sensitive here' });
    // deliberately no .declient-denylist written

    const proc = spawnSync('node', [SCRIPT_PATH], { cwd: repoRoot, encoding: 'utf8' });

    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /SKIPPED/);
    // must not be shaped like the zero-hits success summary
    assert.doesNotMatch(proc.stdout, /^OK - scanned/);
    assert.doesNotMatch(proc.stdout, /0 hits/);
  });
});
