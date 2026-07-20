import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from './config-cli';

let stdoutBuf = '';
let stderrBuf = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    stdoutBuf += String(s);
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderrBuf += String(s);
    return true;
  });
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'wave.config.json');
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return path;
}

describe('config validate', () => {
  it('exits 0 and prints ok for a valid markdown config', () => {
    const path = writeConfig({ store: { kind: 'markdown', repoRoot: '/x', slug: 's' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
    expect(stdoutBuf).toMatch(/markdown/);
  });

  it('exits 0 for a github config WITHOUT building a store (no P8 deferral)', () => {
    const path = writeConfig({ store: { kind: 'github', eligibility: ['ready-for-agent'] } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0); // would be impossible if it called buildStore
    expect(stdoutBuf).toMatch(/github/);
  });

  it('exits 0 and reports the verify profile count when present', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'cms', appliesTo: ['cms/**'], commands: [{ command: 'composer install' }] }] },
    });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/1 profile/);
  });

  it('exits 1 with a clear message for an unknown store kind', () => {
    const path = writeConfig({ store: { kind: 'svn' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/unknown store kind/);
  });

  it('exits 1 for a malformed verify (no profiles array)', () => {
    const path = writeConfig({ store: { kind: 'github' }, verify: { profiles: 'oops' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/verify/);
  });

  it('exits 2 (usage) for a missing path', () => {
    expect(runConfig(['validate'])).toBe(2);
  });

  it('exits 2 (usage) for an unknown op', () => {
    expect(runConfig(['frobnicate', 'x'])).toBe(2);
  });
});
