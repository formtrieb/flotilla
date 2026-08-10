/**
 * credential-probe-cli.spec.ts — the ADR-0029 value-free auth probe.
 *
 * Four things are under test, and they are the four the issue's acceptance
 * criteria name:
 *   1. **The answer.** Exit 0 when every configured credential resolves, exit 1
 *      when any fails — over both selection forms (`--all` discovery and an
 *      explicit `--var`), including the deliberate asymmetry on the
 *      not-configured case.
 *   2. **The Convention-11 negative control.** A deliberately broken configured
 *      command, run through the REAL shell, observed driving the probe to its
 *      non-zero, value-free outcome. A probe only ever observed passing is
 *      unproven — ADR-0029 says so in as many words about its own resolver.
 *   3. **Value-freedom by construction.** No stream write and no reported field
 *      ever carries the resolved secret, the lookup's stdout, or its stderr —
 *      asserted with sentinels that live in FILES, not in the command string,
 *      so the command (which the report names by design) cannot trivially
 *      satisfy the assertion.
 *   4. **Usage.** A bare invocation, an unknown flag, and a stray positional
 *      each print usage and exit 2, consistent with the sibling verbs.
 *
 * A fifth block was added when the discovery list gained its third member: the
 * **Bitbucket consumer** shape the field report came from, where a configured,
 * reachable `BITBUCKET_TOKEN` made `--all` print `ok: true` / `probed: []` and
 * exit 0. That block pins the four outcomes the list entry changes (configured →
 * probed; configured-but-failing → exit 1; unconfigured → unchanged; named twice
 * → probed once). It is the BEHAVIOR half only — the durable half, that no
 * FUTURE adapter can repeat the omission, is a separate repo-source-reading
 * guard (`credential-discovery-drift.spec.ts`), because no behavior spec can
 * assert something about a call site that does not exist yet.
 *
 * Every environment in this file is INJECTED. The probe must never read the
 * developer's real `GITHUB_TOKEN` / `GITHUB_TOKEN_CMD` while a spec runs — that
 * would be both flaky and, for a `_CMD` pointing at a real keychain, an actual
 * credential lookup fired by a test run. The one spec that does drive
 * `process.env` sets a FIXTURE variable name (`EXAMPLE_TOKEN`) and removes it
 * again; `main()`'s end-to-end coverage of the router lives in cli.spec.ts.
 * Every "secret" here is a fixture string, never a credential.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCredentialProbe,
  probeCredential,
  probeCredentials,
  discoverConfiguredCredentials,
  configuredLookupCommand,
  KNOWN_CREDENTIAL_VARIABLES,
  type CredentialProbeReport,
} from './credential-probe-cli';
import { BITBUCKET_TOKEN_VAR } from './adapters/bitbucket/bitbucket-api';
import type { CredentialLookupSpawn, CredentialLookupResult } from './credential-resolver';

const VAR = 'EXAMPLE_TOKEN';
const CMD_VAR = 'EXAMPLE_TOKEN_CMD';

/** A binary that cannot exist — the deliberate break, shared by the negative controls. */
const BROKEN_LOOKUP = 'flotilla-no-such-lookup-binary-0029 --field token';

/** A spawn fixture: canned result, plus a record of every call. */
function fakeSpawn(result: Partial<CredentialLookupResult> = {}): {
  spawn: CredentialLookupSpawn;
  calls: string[];
} {
  const calls: string[] = [];
  const spawn: CredentialLookupSpawn = (command) => {
    calls.push(command);
    return {
      stdout: result.stdout ?? '',
      status: result.status ?? 0,
      timedOut: result.timedOut ?? false,
      ...result,
    };
  };
  return { spawn, calls };
}

/**
 * A REAL lookup command whose secret lives in a temp FILE rather than in the
 * command string. The probe names the configured command by design (it is the
 * pointer, and naming it is the point of ADR-0029's indirection), so a sentinel
 * spelled inside the command would appear in the output legitimately and make
 * every containment assertion vacuous.
 */
function secretFileLookup(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'flotilla-probe-secret-')), 'secret');
  writeFileSync(file, 'SENTINEL-RESOLVED-SECRET');
  return `cat '${file}'`;
}

/** Capture both streams for one call; returns the exit code plus what was written. */
function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });
  try {
    return { code: fn(), stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. The answer ───────────────────────────────────────────────────────────

describe('probeCredential — resolvability, not presence', () => {
  it('a configured command that resolves → resolved, source "command", the pointer named', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'a-fixture-secret\n', status: 0 });
    const out = probeCredential(VAR, { env: { [CMD_VAR]: 'lookup --field token' }, spawn });
    expect(out.resolved).toBe(true);
    expect(out.source).toBe('command');
    expect(out.command).toBe('lookup --field token');
    expect(out.commandVariable).toBe(CMD_VAR);
    expect(out.failure).toBeUndefined();
    // The lookup genuinely RAN — a probe that short-circuits proves nothing.
    expect(calls).toEqual(['lookup --field token']);
  });

  it('an ambient-only credential resolves with source "ambient" and no lookup spawned', () => {
    const forbidden: CredentialLookupSpawn = (command) => {
      throw new Error(`no lookup must be spawned on the ambient path, but got: ${command}`);
    };
    const out = probeCredential(VAR, { env: { [VAR]: 'ambient-fixture' }, spawn: forbidden });
    expect(out).toMatchObject({ resolved: true, source: 'ambient' });
    expect(out.command).toBeUndefined();
  });

  it('a blank _CMD is NOT configured (the ADR-0029 escape hatch) — the ambient path applies', () => {
    const out = probeCredential(VAR, { env: { [CMD_VAR]: '   ', [VAR]: 'ambient-fixture' } });
    expect(out).toMatchObject({ resolved: true, source: 'ambient' });
  });

  it('a configured command that exits non-zero → not resolved, typed lookup-exit, pointer named', () => {
    const { spawn } = fakeSpawn({ status: 3 });
    const out = probeCredential(VAR, {
      env: { [CMD_VAR]: 'lookup --field token', [VAR]: 'ambient-fixture' },
      spawn,
    });
    expect(out.resolved).toBe(false);
    expect(out.failure).toBe('lookup-exit');
    expect(out.command).toBe('lookup --field token');
    // Loudness: it did NOT quietly report success off the ambient value.
    expect(JSON.stringify(out)).not.toContain('ambient-fixture');
  });

  it('an empty-stdout lookup and a timeout each surface their own typed failure', () => {
    const empty = probeCredential(VAR, {
      env: { [CMD_VAR]: 'lookup' },
      spawn: fakeSpawn({ status: 0, stdout: '' }).spawn,
    });
    expect(empty).toMatchObject({ resolved: false, failure: 'lookup-empty' });

    const timedOut = probeCredential(VAR, {
      env: { [CMD_VAR]: 'lookup' },
      spawn: fakeSpawn({ status: null, timedOut: true }).spawn,
    });
    expect(timedOut).toMatchObject({ resolved: false, failure: 'lookup-timeout' });
  });

  it('a named credential with NEITHER source is a failure (not-configured), source "none"', () => {
    const out = probeCredential(VAR, { env: {} });
    expect(out).toMatchObject({ resolved: false, failure: 'not-configured', source: 'none' });
    expect(out.command).toBeUndefined();
  });

  it('a non-CredentialResolutionError throw is reported WITHOUT its own message', () => {
    // An unknown error class carries no value-free guarantee — this is exactly
    // where an unfiltered `${err.message}` would leak.
    const throwing: CredentialLookupSpawn = () => {
      throw new TypeError('SENTINEL-FROM-AN-UNTYPED-THROW');
    };
    const out = probeCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn: throwing });
    expect(out).toMatchObject({ resolved: false, failure: 'unexpected' });
    expect(JSON.stringify(out)).not.toContain('SENTINEL-FROM-AN-UNTYPED-THROW');
    expect(out.message).toContain('TypeError'); // the CLASS, never the content
  });
});

describe('discovery — what "every configured credential" means', () => {
  it("names the three credentials this engine's own adapters read", () => {
    expect([...KNOWN_CREDENTIAL_VARIABLES]).toEqual([
      'GITHUB_TOKEN',
      'LINEAR_API_KEY',
      'BITBUCKET_TOKEN',
    ]);
  });

  it('takes the Bitbucket entry FROM the adapter, so the two cannot disagree by construction', () => {
    // Not a spelling assertion — an identity one. `KNOWN_CREDENTIAL_VARIABLES`
    // imports the adapter's own exported constant, so a rename of the variable
    // cannot leave the discovery list pointing at the old name. (The general
    // case, which no import can cover because the GitHub and Linear factories
    // pass bare literals, is credential-discovery-drift.spec.ts.)
    expect(KNOWN_CREDENTIAL_VARIABLES).toContain(BITBUCKET_TOKEN_VAR);
  });

  it('selects a credential configured by _CMD or by an ambient value, and no other', () => {
    expect(
      discoverConfiguredCredentials({ GITHUB_TOKEN_CMD: 'lookup gh' }),
    ).toEqual(['GITHUB_TOKEN']);
    expect(discoverConfiguredCredentials({ LINEAR_API_KEY: 'ambient' })).toEqual([
      'LINEAR_API_KEY',
    ]);
    expect(
      discoverConfiguredCredentials({ GITHUB_TOKEN_CMD: 'lookup gh', LINEAR_API_KEY: 'x' }),
    ).toEqual(['GITHUB_TOKEN', 'LINEAR_API_KEY']);
  });

  it('discovers the Bitbucket credential from EITHER source — the 1.3.0 gap, closed', () => {
    // The field report (a Bitbucket + Linear consumer on engine 1.3.0): an
    // ambient BITBUCKET_TOKEN was configured and reachable, and `--all`
    // discovered nothing at all. Both sources, since a consumer that has
    // adopted ADR-0029 carries the _CMD pointer and no ambient value.
    expect(discoverConfiguredCredentials({ BITBUCKET_TOKEN: 'ambient' })).toEqual([
      'BITBUCKET_TOKEN',
    ]);
    expect(discoverConfiguredCredentials({ BITBUCKET_TOKEN_CMD: 'lookup bb' })).toEqual([
      'BITBUCKET_TOKEN',
    ]);
    // …and it does not displace the others: the pilot consumer's real shape is
    // a Bitbucket code host beside a Linear tracker.
    expect(
      discoverConfiguredCredentials({ LINEAR_API_KEY_CMD: 'lookup lin', BITBUCKET_TOKEN: 'x' }),
    ).toEqual(['LINEAR_API_KEY', 'BITBUCKET_TOKEN']);
  });

  it('ignores an unconfigured credential and an unrelated *_CMD variable alike', () => {
    // A github-store consumer has no LINEAR_API_KEY, and that is not a defect —
    // nor is an operator's EDITOR_CMD a credential to spawn at a preflight.
    // Discovery is ENVIRONMENT PRESENCE only: no host detection, no store kind,
    // no wave config reaches this decision, which is why adding a third
    // credential inherited the existing selectivity for free.
    expect(discoverConfiguredCredentials({ EDITOR_CMD: 'vim', GITHUB_TOKEN_CMD: '  ' })).toEqual(
      [],
    );
    // A blank Bitbucket _CMD is the same escape hatch, not a third rule.
    expect(discoverConfiguredCredentials({ BITBUCKET_TOKEN_CMD: '   ' })).toEqual([]);
  });

  it('BITBUCKET_EMAIL is NOT a credential and is never discovered (ADR-0023 amendment)', () => {
    // It is an identifier, not a secret, and deliberately does not travel the
    // ADR-0029 seam — so a consumer that set only the email has configured no
    // credential at all, and `--all` must still find nothing.
    expect(discoverConfiguredCredentials({ BITBUCKET_EMAIL: 'someone@example.com' })).toEqual([]);
    expect([...KNOWN_CREDENTIAL_VARIABLES]).not.toContain('BITBUCKET_EMAIL');
  });

  it('configuredLookupCommand applies the blank rule in ONE place', () => {
    expect(configuredLookupCommand(VAR, { [CMD_VAR]: ' lookup x ' })).toBe('lookup x');
    expect(configuredLookupCommand(VAR, { [CMD_VAR]: '' })).toBeUndefined();
    expect(configuredLookupCommand(VAR, {})).toBeUndefined();
  });
});

describe('probeCredentials — the aggregate answer', () => {
  it('ok only when every probe resolved; failures are listed by variable name', () => {
    const env = { GITHUB_TOKEN: 'ambient-fixture', LINEAR_API_KEY_CMD: 'lookup linear' };
    const { spawn } = fakeSpawn({ status: 7 });
    const report = probeCredentials(['GITHUB_TOKEN', 'LINEAR_API_KEY'], { env, spawn });
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual(['LINEAR_API_KEY']);
    expect(report.probed).toHaveLength(2);
    expect(report.probed[0]).toMatchObject({ variable: 'GITHUB_TOKEN', resolved: true });
  });
});

// ─── 2. The CLI: exit codes, selection, usage ────────────────────────────────

describe('runCredentialProbe — exit codes and selection', () => {
  it('--all with every configured credential resolving → exit 0, ok: true', () => {
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all'], {
        env: { GITHUB_TOKEN: 'ambient-fixture', LINEAR_API_KEY_CMD: 'lookup linear' },
        spawn: fakeSpawn({ stdout: 'linear-fixture-secret' }).spawn,
      }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.probed.map((p) => p.variable)).toEqual(['GITHUB_TOKEN', 'LINEAR_API_KEY']);
  });

  it('--all with ONE failing configured credential → exit 1, and the failure named', () => {
    const { code, stdout, stderr } = capture(() =>
      runCredentialProbe(['--all'], {
        env: { GITHUB_TOKEN_CMD: 'lookup gh', LINEAR_API_KEY: 'ambient-fixture' },
        spawn: fakeSpawn({ status: 1 }).spawn,
      }),
    );
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual(['GITHUB_TOKEN']);
    expect(stderr).toMatch(/1 of 2 credential\(s\) failed to resolve: GITHUB_TOKEN/);
  });

  it('--all with NOTHING configured → exit 0 with probed: [] and a note explaining the empty run', () => {
    const { code, stdout } = capture(() => runCredentialProbe(['--all'], { env: {} }));
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report).toMatchObject({ ok: true, probed: [], failed: [] });
    // A run must never do nothing and show nothing (the FOR-67 doctrine).
    expect(report.note).toMatch(/no configured credential found/);
    // The note ENUMERATES the known list by RENDERING it — asserted against the
    // rendered join, never against a hand-written copy. A hardcoded enumeration
    // in either place would re-create the exact drift class this list already
    // suffered once (see credential-discovery-drift.spec.ts).
    expect(report.note).toContain(KNOWN_CREDENTIAL_VARIABLES.join(', '));
    // …and the join is not vacuously satisfiable: the third entry really is in
    // there, by the adapter's own constant rather than by its spelling.
    expect(report.note).toContain(BITBUCKET_TOKEN_VAR);
  });

  it('the usage text renders the same list — one source, not a second enumeration', () => {
    const { stderr } = capture(() => runCredentialProbe([], { env: {} }));
    expect(stderr).toContain(`known credentials for --all: ${KNOWN_CREDENTIAL_VARIABLES.join(', ')}`);
  });

  it('--var names a credential the caller ASSERTS must resolve — unconfigured is exit 1', () => {
    // The deliberate asymmetry with --all: naming it is the assertion.
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--var', 'GITHUB_TOKEN'], { env: {} }),
    );
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.probed[0]).toMatchObject({
      variable: 'GITHUB_TOKEN',
      resolved: false,
      failure: 'not-configured',
    });
  });

  it('--var probes an out-of-tree credential the --all list does not know', () => {
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--var', VAR], {
        env: { [CMD_VAR]: 'lookup custom' },
        spawn: fakeSpawn({ stdout: 'custom-fixture-secret' }).spawn,
      }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.probed.map((p) => p.variable)).toEqual([VAR]);
  });

  it('--all --var <already-discovered> probes it ONCE — no duplicate lookup spawn', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'gh-fixture-secret' });
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all', '--var', 'GITHUB_TOKEN'], {
        env: { GITHUB_TOKEN_CMD: 'lookup gh' },
        spawn,
      }),
    );
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as CredentialProbeReport).probed).toHaveLength(1);
    expect(calls).toEqual(['lookup gh']);
  });

  it('--config <path> is accepted and discarded (the uniform-wrapper tolerance)', () => {
    const { code } = capture(() =>
      runCredentialProbe(['--all', '--config', '/some/wave.config.json'], { env: {} }),
    );
    expect(code).toBe(0);
  });

  it('a bare invocation prints usage and exits 2 — consistent with the sibling verbs', () => {
    const { code, stdout, stderr } = capture(() => runCredentialProbe([], { env: {} }));
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage:/);
    expect(stderr).toMatch(/requires a selection: --all or --var/);
    expect(stdout).toBe('');
  });

  it('--config alone (no selection) is also a usage error, not an empty success', () => {
    const { code, stderr } = capture(() =>
      runCredentialProbe(['--config', '/x.json'], { env: {} }),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/requires a selection/);
  });

  it('an unknown flag and a stray positional each exit 2 naming the offender', () => {
    const unknown = capture(() => runCredentialProbe(['--frobnicate'], { env: {} }));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown flag --frobnicate/);

    const stray = capture(() => runCredentialProbe(['GITHUB_TOKEN'], { env: {} }));
    expect(stray.code).toBe(2);
    expect(stray.stderr).toMatch(/unexpected argument "GITHUB_TOKEN"/);
  });

  it('--var with no value following exits 2 rather than swallowing the next flag', () => {
    const { code, stderr } = capture(() => runCredentialProbe(['--var', '--all'], { env: {} }));
    expect(code).toBe(2);
    expect(stderr).toMatch(/--var requires a variable name/);
  });

  it('the usage text names the never-execute-the-lookup rule (Convention 8)', () => {
    const { stderr } = capture(() => runCredentialProbe([], { env: {} }));
    expect(stderr).toMatch(/its stdout IS the secret/i);
  });
});

// ─── 2b. The Bitbucket consumer — the shape the field report came from ───────
//
// Engine 1.3.0 resolved BITBUCKET_TOKEN at two production call sites and never
// widened the discovery list, so `--all` on a Bitbucket consumer printed
// `ok: true` / `probed: []` and exited 0 — a silent all-clear at the AFK auth
// preflight over a credential that was never probed at all. These drive the
// probe through SYNTHETIC env fixtures only; no real credential is touched and
// no real lookup is ever spawned (see this file's header).

describe('runCredentialProbe — the Bitbucket credential is discoverable by --all', () => {
  it('with ONLY a Bitbucket credential configured, --all probes it and exits 0', () => {
    // The reproduction, inverted: this exact environment used to be an EMPTY
    // selection. `probed: []` here would be the bug, not a pass.
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all'], {
        env: { [BITBUCKET_TOKEN_VAR]: 'ambient-fixture' },
        spawn: fakeSpawn({ stdout: 'bb-fixture-secret' }).spawn,
      }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.ok).toBe(true);
    expect(report.probed).toHaveLength(1);
    expect(report.probed[0]).toMatchObject({
      variable: BITBUCKET_TOKEN_VAR,
      commandVariable: 'BITBUCKET_TOKEN_CMD',
      resolved: true,
      source: 'ambient',
    });
    // The run is no longer an empty selection, so it carries no note.
    expect(report.note).toBeUndefined();
  });

  it('a Bitbucket credential whose lookup FAILS makes --all exit 1 and report it failed', () => {
    const { code, stdout, stderr } = capture(() =>
      runCredentialProbe(['--all'], {
        env: { BITBUCKET_TOKEN_CMD: 'lookup bb --field token' },
        spawn: fakeSpawn({ status: 1 }).spawn,
      }),
    );
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual([BITBUCKET_TOKEN_VAR]);
    expect(report.probed[0]).toMatchObject({
      variable: BITBUCKET_TOKEN_VAR,
      resolved: false,
      failure: 'lookup-exit',
      source: 'command',
      command: 'lookup bb --field token',
    });
    expect(stderr).toMatch(/1 of 1 credential\(s\) failed to resolve: BITBUCKET_TOKEN/);
  });

  it('with NO Bitbucket credential configured, --all is unchanged — absent, no failure, exit 0', () => {
    // The selectivity that made the wider list safe to ship: a github-store
    // consumer must not start failing its preflight over a code host it does
    // not use. Discovery is environment presence, never a host detection.
    const forbidden: CredentialLookupSpawn = (command) => {
      throw new Error(`no Bitbucket lookup must be spawned here, but got: ${command}`);
    };
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all'], {
        env: { GITHUB_TOKEN: 'ambient-fixture' },
        spawn: forbidden,
      }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report).toMatchObject({ ok: true, failed: [] });
    expect(report.probed.map((p) => p.variable)).toEqual(['GITHUB_TOKEN']);
  });

  it('--all --var BITBUCKET_TOKEN probes it ONCE — the de-duplication still holds', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'bb-fixture-secret' });
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all', '--var', BITBUCKET_TOKEN_VAR], {
        env: { BITBUCKET_TOKEN_CMD: 'lookup bb' },
        spawn,
      }),
    );
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as CredentialProbeReport).probed).toHaveLength(1);
    // The real assertion: exactly one lookup was spawned, not two.
    expect(calls).toEqual(['lookup bb']);
  });
});

// ─── 3. Value-freedom, through the REAL shell ────────────────────────────────
//
// The injected-seam specs above cannot prove containment, because the fixture
// decides what stdout is. These drive `/bin/sh` for real with a command that
// prints loud sentinels on BOTH streams.

describe('runCredentialProbe — what it must never print', () => {
  it('a REAL succeeding lookup: the resolved secret appears in NO stream and NO field', () => {
    // The secret lives in a FILE, not in the command string — the report names
    // the command by design, so a sentinel spelled inside it would make this
    // assertion unfalsifiable in the wrong direction.
    const { code, stdout, stderr } = capture(() =>
      runCredentialProbe(['--var', VAR], { env: { [CMD_VAR]: secretFileLookup() } }),
    );
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain('SENTINEL-RESOLVED-SECRET');
    // …and it really did resolve, so the absence is containment, not a no-op.
    expect((JSON.parse(stdout) as CredentialProbeReport).probed[0].resolved).toBe(true);
  });

  it('a REAL failing lookup leaks neither its stdout nor its stderr nor the ambient value', () => {
    // The sentinels live in FILES, not in the command string — otherwise the
    // command (which the report names, by design) would trivially contain them
    // and the assertion would prove nothing.
    const dir = mkdtempSync(join(tmpdir(), 'flotilla-probe-'));
    const outFile = join(dir, 'out');
    const errFile = join(dir, 'err');
    writeFileSync(outFile, 'SENTINEL-ON-STDOUT');
    writeFileSync(errFile, 'SENTINEL-ON-STDERR');
    const command = `cat '${outFile}'; cat '${errFile}' 1>&2; exit 4`;

    const { code, stdout, stderr } = capture(() =>
      runCredentialProbe(['--var', VAR], {
        env: { [VAR]: 'SENTINEL-AMBIENT-VALUE', [CMD_VAR]: command },
      }),
    );

    expect(code).toBe(1);
    const everything = stdout + stderr;
    expect(everything).not.toContain('SENTINEL-ON-STDOUT');
    expect(everything).not.toContain('SENTINEL-ON-STDERR');
    expect(everything).not.toContain('SENTINEL-AMBIENT-VALUE');
    // The command IS named — that is the pointer, and naming it is the point.
    expect(stdout).toContain(command);
    expect((JSON.parse(stdout) as CredentialProbeReport).probed[0].failure).toBe('lookup-exit');
  });

  it('no reported field can hold a secret: the outcome keys are a fixed value-free set', () => {
    const { stdout } = capture(() =>
      runCredentialProbe(['--var', VAR], { env: { [CMD_VAR]: secretFileLookup() } }),
    );
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(Object.keys(report.probed[0]).sort()).toEqual([
      'command',
      'commandVariable',
      'resolved',
      'source',
      'variable',
    ]);
  });
});

// ─── 4. Convention 11 — the negative control ─────────────────────────────────
//
// A probe only ever observed PASSING is compatible with "the probe works" AND
// with "the probe cannot fail", and no acceptance criterion distinguishes them.
// These break the thing the probe exists to catch — a configured lookup command
// that does not work — and observe the probe's own FAIL state, through the real
// shell, on both selection forms.

describe('NEGATIVE CONTROL (Convention 11) — a deliberately broken configured command', () => {
  it('drives --var to exit 1 with a typed, value-free outcome naming the command', () => {
    const { code, stdout, stderr } = capture(() =>
      runCredentialProbe(['--var', VAR], {
        env: { [VAR]: 'SENTINEL-AMBIENT-VALUE', [CMD_VAR]: BROKEN_LOOKUP },
      }),
    );

    expect(code).toBe(1);
    const report = JSON.parse(stdout) as CredentialProbeReport;
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual([VAR]);
    // `sh: command not found` → 127, so the typed mode is lookup-exit.
    expect(report.probed[0]).toMatchObject({ resolved: false, failure: 'lookup-exit' });
    expect(report.probed[0].command).toBe(BROKEN_LOOKUP);
    expect(stderr).toMatch(/credential-probe: 1 of 1 credential\(s\) failed to resolve/);
    // The loudness that matters: it did NOT quietly pass off the ambient value.
    expect(stdout + stderr).not.toContain('SENTINEL-AMBIENT-VALUE');
  });

  it('drives --all to exit 1 too — a broken GITHUB_TOKEN_CMD fails the whole preflight', () => {
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all'], { env: { GITHUB_TOKEN_CMD: BROKEN_LOOKUP } }),
    );
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as CredentialProbeReport).failed).toEqual(['GITHUB_TOKEN']);
  });

  it('RESTORED: the same probe with the command repaired is green again (exit 0)', () => {
    // The other half of the falsification: the FAIL above was caused by the
    // break, not by the probe being broken outright.
    const { code, stdout } = capture(() =>
      runCredentialProbe(['--all'], { env: { GITHUB_TOKEN_CMD: 'echo a-fixture-secret' } }),
    );
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as CredentialProbeReport).ok).toBe(true);
  });
});
