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

// ── the engine-invocation binding at the CLI seam (ADR-0032, issue #273) ─────
//
// `config validate` is the surface `wave-setup` uses to prove a freshly-written
// config loads, so it is also where an operator finds out WHICH engine form
// this repo is bound to — and where a malformed binding has to stop being
// invisible.

describe('config validate — engine.cli (ADR-0032)', () => {
  const INSTALLED_FORM = './node_modules/.bin/flotilla-engine';

  it('exits 0 and reports the BOUND VALUE, not merely that a binding exists (AC#1)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
    expect(stdoutBuf).toContain(`engine.cli: ${INSTALLED_FORM}`);
  });

  it('reports the source form flotilla itself binds to, verbatim', () => {
    const sourceForm = './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts';
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: sourceForm } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain(`engine.cli: ${sourceForm}`);
  });

  it('exits 0 and says nothing about engine.cli when the binding is absent (AC#1)', () => {
    const path = writeConfig({ store: { kind: 'github' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).not.toMatch(/engine/);
  });

  it('exits 1 naming the field for an EMPTY-STRING binding (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: '' } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli/);
    expect(stdoutBuf).toBe(''); // never both "ok" and an error
  });

  it('exits 1 naming the field for a NON-STRING binding (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: 42 } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli.*command string/s);
  });

  it('exits 1 naming the field for a binding carrying shell metacharacters (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: `${INSTALLED_FORM} && rm -rf /` } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli/);
  });

  it('exits 1 for a non-object engine key', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: INSTALLED_FORM });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/"engine" must be an object/);
  });

  // NEGATIVE CONTROL for the CLI-level gate (wave-shared Convention 11, spec
  // half): the same config differing ONLY in the binding's value must come out
  // 0 one way and 1 the other. A `config validate` that always exited 0 — the
  // silent-skip failure ADR-0032 exists to end — fails the second assertion; one
  // that always exited 1 fails the first.
  it('NEGATIVE CONTROL: the exit code turns on the binding value alone', () => {
    const good = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM } });
    const bad = writeConfig({ store: { kind: 'github' }, engine: { cli: `${INSTALLED_FORM};` } });
    expect(runConfig(['validate', good])).toBe(0);
    expect(runConfig(['validate', bad])).toBe(1);
  });
});

// ── the declared capability requirement at the CLI seam (ADR-0049) ───────────
//
// `config validate` is where an operator finds out whether the `needs` they
// declared at setup actually landed — and where a declaration the skill tier has
// no translation for has to stop being invisible. The refusal itself is
// `loadWaveConfig`'s; what this block pins is that it reaches the CLI as an
// exit-1 with the closed set named, and that the reporting half is conditional.

describe('config validate — verify command needs (ADR-0049)', () => {
  /** A github config whose one verify profile carries `commands` verbatim. */
  function writeWithCommands(commands: unknown[]): string {
    return writeConfig({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'app', appliesTo: ['App/**'], commands }] },
    });
  }

  it('exits 0 and reports the declared needs WITH their denominator', () => {
    const path = writeWithCommands([
      { command: 'npm ci' },
      { command: 'xcodebuild test -scheme App', needs: { host: true } },
    ]);
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain('1 of 2 verify command(s) declare a sandbox need');
  });

  it('exits 1 naming the field AND the closed set for an unknown needs key', () => {
    const path = writeWithCommands([{ command: 'xcodebuild test', needs: { gpu: true } }]);
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/verify\.profiles\[0\]\.commands\[0\]\.needs/);
    expect(stderrBuf).toMatch(/unknown key "gpu"/);
    expect(stderrBuf).toMatch(/"writes".*"network".*"host"/s);
    expect(stdoutBuf).toBe(''); // never both "ok" and an error
  });

  it('exits 1 for a wrong value shape, naming the closed set', () => {
    const path = writeWithCommands([{ command: 'xcodebuild test', needs: { host: false } }]);
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/host must be literally true/);
    expect(stderrBuf).toMatch(/"writes".*"network".*"host"/s);
  });

  // NEGATIVE CONTROL, two halves at once. (a) The exit code turns on the needs
  // VALUE alone — same config, same profile count, 0 one way and 1 the other, so
  // this gate cannot be one that always passes or always fails. (b) The report
  // is silent when nothing is declared: today's line, unchanged, for a config
  // written before the field existed.
  it('NEGATIVE CONTROL: the exit code turns on the needs value alone, and a needs-free config prints today\'s line', () => {
    const good = writeWithCommands([{ command: 'xcodebuild test', needs: { host: true } }]);
    const bad = writeWithCommands([{ command: 'xcodebuild test', needs: { host: 'yes' } }]);
    expect(runConfig(['validate', good])).toBe(0);
    expect(runConfig(['validate', bad])).toBe(1);

    stdoutBuf = '';
    const bare = writeWithCommands([{ command: 'npm ci' }, { command: 'npm test' }]);
    expect(runConfig(['validate', bare])).toBe(0);
    expect(stdoutBuf).toBe(
      `ok: "${bare}" is a valid wave config (store.kind=github, verify: 1 profile(s))\n`,
    );
    expect(stdoutBuf).not.toMatch(/needs|sandbox/);
  });
});
