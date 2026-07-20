import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrossWave } from './cross-wave-cli';
import type { ScopedIssue } from './cross-wave';

// Overlap semantics: non-glob literal paths are compared as plain strings —
// no FS expansion against repoRoot. Any repoRoot is valid for literal-only tests.
const REPO_ROOT = '/repo';

function writeScopedIssues(dir: string, name: string, issues: ScopedIssue[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(issues));
  return p;
}

describe('runCrossWave', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cross-wave-cli-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 and emits JSON with parallelSafe=false when candidate shares a file with claimed', () => {
    const sharedFile = 'cms/site/config/config.php';
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates.json', [
      { id: 'issue-1', files: [sharedFile] },
    ]);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed.json', [
      { id: 'issue-2', files: [sharedFile] },
    ]);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledOnce();

    const written = (stdoutSpy.mock.calls[0][0] as string);
    const result = JSON.parse(written);
    expect(result.parallelSafe).toBe(false);
    expect(result.crossWaveConflicts).toHaveLength(1);
    expect(result.crossWaveConflicts[0].files).toEqual([sharedFile]);
  });

  it('returns 0 and emits JSON with parallelSafe=true when candidate and claimed are disjoint', () => {
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates-disjoint.json', [
      { id: 'issue-a', files: ['src/alpha.ts'] },
    ]);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-disjoint.json', [
      { id: 'issue-b', files: ['src/beta.ts'] },
    ]);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledOnce();

    const written = (stdoutSpy.mock.calls[0][0] as string);
    const result = JSON.parse(written);
    expect(result.parallelSafe).toBe(true);
    expect(result.crossWaveConflicts).toEqual([]);
  });

  it('returns 2 and writes to stderr when --candidates is missing', () => {
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-only.json', [
      { id: 'issue-x', files: ['src/x.ts'] },
    ]);

    const code = runCrossWave([
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns 2 and writes to stderr when --claimed is missing', () => {
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates-only.json', [
      { id: 'issue-y', files: ['src/y.ts'] },
    ]);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('omitting --repo-root still works for concrete (non-glob) paths — no fallback to process.cwd() needed (FOR-38)', () => {
    // FOR-38: --repo-root no longer silently defaults to process.cwd(). This
    // case still passes because literal paths never needed a repo root in
    // the first place — no warnings, no degraded matching.
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates-cwd.json', [
      { id: 'issue-c', files: ['src/c.ts'] },
    ]);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-cwd.json', [
      { id: 'issue-d', files: ['src/d.ts'] },
    ]);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--claimed', claimedPath,
      // no --repo-root
    ]);

    expect(code).toBe(0);
    const written = (stdoutSpy.mock.calls[0][0] as string);
    const result = JSON.parse(written);
    expect(result.parallelSafe).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('omitting --repo-root with a glob Files entry emits an explicit warning (stdout JSON AND stderr) instead of a silently smaller conflict set (FOR-38)', () => {
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates-glob.json', [
      { id: 'FOR-6', files: ['.claude/skills/wave-shared/**'] },
    ]);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-glob.json', [
      { id: 'FOR-33', files: ['.claude/skills/wave-shared/**'] },
    ]);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--claimed', claimedPath,
      // no --repo-root — the same glob declared by both issues
    ]);

    expect(code).toBe(0);
    const written = (stdoutSpy.mock.calls[0][0] as string);
    const result = JSON.parse(written);

    // AC2: string-identical patterns produce an overlap cell even without a repo-root.
    expect(result.parallelSafe).toBe(false);
    expect(result.crossWaveConflicts).toHaveLength(1);

    // AC1: the result is never a silently smaller conflict set — an explicit
    // warning names the unexpanded pattern, both in the JSON result...
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w: string) => w.includes('.claude/skills/wave-shared/**'))).toBe(
      true,
    );
    // ...and echoed to stderr so a caller reading only stdout-as-JSON can't miss it.
    expect(stderrSpy).toHaveBeenCalled();
    const stderrText = stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(stderrText).toContain('.claude/skills/wave-shared/**');
  });

  it('deduplicates canonical pairs through the CLI when --candidates and --claimed overlap (own-wave soft-claim)', () => {
    const shared: ScopedIssue[] = [
      { id: 'b', files: ['src/one.ts'] },
      { id: 'a', files: ['src/one.ts', 'src/two.ts'] },
      { id: 'c', files: ['src/two.ts'] },
    ];
    const candidatesPath = writeScopedIssues(tmpDir, 'candidates-overlap.json', shared);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-overlap.json', shared);

    const code = runCrossWave([
      '--candidates', candidatesPath,
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(0);
    const written = (stdoutSpy.mock.calls[0][0] as string);
    const result = JSON.parse(written);

    expect(result.intraWaveConflicts).toHaveLength(2);
    const pairs = result.intraWaveConflicts.map((c: { a: string; b: string }) => [c.a, c.b]);
    for (const [a, b] of pairs) expect(a < b).toBe(true);
    const seen = new Set(pairs.map((p: string[]) => p.join('|')));
    expect(seen.size).toBe(pairs.length);
    expect(result.crossWaveConflicts).toEqual([]);
  });

  it('returns 2 and writes to stderr when --candidates path does not exist', () => {
    const stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-err.json', [
      { id: 'issue-e', files: ['src/e.ts'] },
    ]);

    const code = runCrossWave([
      '--candidates', join(tmpDir, 'nonexistent-candidates.json'),
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(2);
    expect(stderrMock).toHaveBeenCalled();
    const message = (stderrMock.mock.calls[0][0] as string);
    expect(message).toMatch(/--candidates/);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns 2 and writes to stderr when --candidates file contains malformed JSON', () => {
    const stderrMock = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const badPath = join(tmpDir, 'bad-candidates.json');
    writeFileSync(badPath, 'not json');
    const claimedPath = writeScopedIssues(tmpDir, 'claimed-err2.json', [
      { id: 'issue-f', files: ['src/f.ts'] },
    ]);

    const code = runCrossWave([
      '--candidates', badPath,
      '--claimed', claimedPath,
      '--repo-root', REPO_ROOT,
    ]);

    expect(code).toBe(2);
    expect(stderrMock).toHaveBeenCalled();
    const message = (stderrMock.mock.calls[0][0] as string);
    expect(message).toMatch(/--candidates/);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
