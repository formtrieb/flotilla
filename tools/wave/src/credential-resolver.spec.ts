/**
 * credential-resolver.spec.ts — the ADR-0029 credential seam.
 *
 * Three things are under test, and they are the three the ADR names as the
 * consequences the engine owes:
 *   1. **Precedence.** A configured `<VAR>_CMD` wins over a set ambient
 *      `<VAR>`; the ambient variable applies when no command is configured; an
 *      empty or whitespace-only `_CMD` counts as NOT configured (the deliberate
 *      per-environment escape hatch).
 *   2. **Fail-loud.** Non-zero exit, timeout, and empty stdout each produce a
 *      typed error that NAMES the command and never falls back to the ambient
 *      variable — including the Convention-11 negative control: a deliberately
 *      broken command, run through the REAL shell, observed failing loud.
 *   3. **Secret hygiene.** No message, no thrown value, no own property, and no
 *      stream write ever carries the command's stdout or stderr.
 *
 * Most paths drive an injected spawn seam (hermetic, instant). The ones whose
 * whole point is the real shell — the negative control, the stderr capture, the
 * trailing-newline trim, and the once-per-process memo — drive `/bin/sh` for
 * real. Every "secret" in this file is a fixture string, never a credential.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCredential,
  commandVariableFor,
  defaultCredentialLookupSpawn,
  CredentialResolutionError,
  CREDENTIAL_LOOKUP_TIMEOUT_MS,
  type CredentialLookupResult,
  type CredentialLookupSpawn,
} from './credential-resolver';

const VAR = 'EXAMPLE_TOKEN';
const CMD_VAR = 'EXAMPLE_TOKEN_CMD';

/** A spawn fixture: canned result, plus a record of every call. */
function fakeSpawn(
  result: Partial<CredentialLookupResult> = {},
): { spawn: CredentialLookupSpawn; calls: { command: string; timeoutMs: number }[] } {
  const calls: { command: string; timeoutMs: number }[] = [];
  const spawn: CredentialLookupSpawn = (command, timeoutMs) => {
    calls.push({ command, timeoutMs });
    return { stdout: result.stdout ?? '', status: result.status ?? 0, timedOut: result.timedOut ?? false, ...result };
  };
  return { spawn, calls };
}

/** A spawn that must never run — proves a path resolved without a lookup. */
const forbiddenSpawn: CredentialLookupSpawn = (command) => {
  throw new Error(`no lookup must be spawned on this path, but got: ${command}`);
};

/**
 * Everything an error could possibly leak through: message, stack, own
 * enumerable properties, and its `String()` form. A secret hiding in ANY of them
 * is a leak, so the hygiene assertions look at all of them at once.
 */
function dumpError(err: unknown): string {
  const e = err as Error & Record<string, unknown>;
  return JSON.stringify({
    name: e.name,
    message: e.message,
    stack: e.stack,
    own: Object.fromEntries(Object.entries(e)),
    str: String(e),
  });
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw, but the call returned normally');
}

// ─── 1. Precedence (ADR-0029: "X_CMD wins over X") ───────────────────────────

describe('resolveCredential — precedence', () => {
  it('with no command configured, the ambient variable applies (the ephemeral-environment path)', () => {
    const secret = resolveCredential(VAR, { env: { [VAR]: 'ambient-secret' }, spawn: forbiddenSpawn });
    expect(secret).toBe('ambient-secret');
  });

  it('a configured command WINS over a set ambient variable', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'from-the-command\n' });
    const secret = resolveCredential(VAR, {
      env: { [VAR]: 'ambient-secret', [CMD_VAR]: 'lookup --field token' },
      spawn,
    });
    expect(secret).toBe('from-the-command');
    expect(secret).not.toBe('ambient-secret');
    expect(calls).toEqual([{ command: 'lookup --field token', timeoutMs: CREDENTIAL_LOOKUP_TIMEOUT_MS }]);
  });

  it('a configured command resolves with no ambient variable present at all', () => {
    const { spawn } = fakeSpawn({ stdout: 'only-from-the-command' });
    expect(resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn })).toBe('only-from-the-command');
  });

  it('an EMPTY _CMD counts as not configured — the ambient variable applies (the CI escape hatch)', () => {
    const secret = resolveCredential(VAR, { env: { [VAR]: 'ambient-secret', [CMD_VAR]: '' }, spawn: forbiddenSpawn });
    expect(secret).toBe('ambient-secret');
  });

  it('a WHITESPACE-ONLY _CMD counts as not configured — the ambient variable applies', () => {
    for (const blank of [' ', '\t', '\n', '  \t \n ']) {
      const secret = resolveCredential(VAR, {
        env: { [VAR]: 'ambient-secret', [CMD_VAR]: blank },
        spawn: forbiddenSpawn,
      });
      expect(secret).toBe('ambient-secret');
    }
  });

  it('the command string is passed to the shell with its own whitespace intact (only the blank check trims)', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 's' });
    resolveCredential(VAR, { env: { [CMD_VAR]: '  op read "op://vault/item/field"  ' }, spawn });
    // The blank-detection trim decides CONFIGURED-ness; the command that runs is
    // the trimmed string, so a stray trailing space cannot become a shell arg.
    expect(calls[0].command).toBe('op read "op://vault/item/field"');
  });

  it('neither source configured → a typed not-configured error naming BOTH the variable and its _CMD counterpart', () => {
    const err = caught(() => resolveCredential(VAR, { env: {}, spawn: forbiddenSpawn }));
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as CredentialResolutionError).failure).toBe('not-configured');
    expect((err as CredentialResolutionError).command).toBeUndefined();
    expect((err as Error).message).toContain(VAR);
    expect((err as Error).message).toContain(CMD_VAR);
  });

  it('an empty ambient value with no command is "not configured", not an empty secret', () => {
    const err = caught(() => resolveCredential(VAR, { env: { [VAR]: '' }, spawn: forbiddenSpawn }));
    expect((err as CredentialResolutionError).failure).toBe('not-configured');
  });

  it('the not-configured message states WHICH edge asked (the purpose)', () => {
    const err = caught(() =>
      resolveCredential(VAR, { env: {}, purpose: 'build a github IssueStore (ADR-0019)', spawn: forbiddenSpawn }),
    );
    expect((err as Error).message).toContain('build a github IssueStore (ADR-0019)');
  });
});

// ─── 2. Fail-loud (ADR-0029: never a silent fallback) ────────────────────────

describe('resolveCredential — a configured command fails LOUD, never falls back', () => {
  const ENV_WITH_AMBIENT = { [VAR]: 'ambient-secret', [CMD_VAR]: 'broken-lookup --field token' };

  it('a NON-ZERO exit → typed lookup-exit naming the command, and the ambient value is NOT returned', () => {
    const { spawn } = fakeSpawn({ status: 3, stdout: '' });
    const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
    expect(err).toBeInstanceOf(CredentialResolutionError);
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-exit');
    expect(e.command).toBe('broken-lookup --field token');
    expect(e.message).toContain('broken-lookup --field token');
    expect(e.message).toContain('3');
    // The fallback that would be convenient here is exactly the rejected one.
    expect(dumpError(err)).not.toContain('ambient-secret');
  });

  it('a TIMEOUT → typed lookup-timeout naming the command and the 60 s budget', () => {
    const { spawn } = fakeSpawn({ status: null, timedOut: true });
    const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-timeout');
    expect(e.command).toBe('broken-lookup --field token');
    expect(e.message).toContain('broken-lookup --field token');
    expect(e.message).toContain('60s');
    expect(dumpError(err)).not.toContain('ambient-secret');
  });

  it('the timeout budget handed to the spawn seam IS 60 seconds (a hung prompt can never hang a wave)', () => {
    const { spawn, calls } = fakeSpawn({ stdout: 's' });
    resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn });
    expect(calls[0].timeoutMs).toBe(60_000);
    expect(CREDENTIAL_LOOKUP_TIMEOUT_MS).toBe(60_000);
  });

  it('EMPTY stdout on a zero exit → typed lookup-empty, never a silent fallback', () => {
    const { spawn } = fakeSpawn({ status: 0, stdout: '' });
    const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-empty');
    expect(e.message).toContain('broken-lookup --field token');
    expect(dumpError(err)).not.toContain('ambient-secret');
  });

  it('whitespace-only stdout is EMPTY too (a blank line is not a secret)', () => {
    for (const blank of ['\n', '  \n', '\t\r\n']) {
      const { spawn } = fakeSpawn({ status: 0, stdout: blank });
      const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
      expect((err as CredentialResolutionError).failure).toBe('lookup-empty');
    }
  });

  it('a SPAWN failure (no shell / EACCES) → typed lookup-spawn-error carrying the errno code only', () => {
    const { spawn } = fakeSpawn({ status: null, spawnErrorCode: 'ENOENT' });
    const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-spawn-error');
    expect(e.message).toContain('ENOENT');
    expect(e.message).toContain('broken-lookup --field token');
    expect(dumpError(err)).not.toContain('ambient-secret');
  });

  it('every failure mode is the SAME typed error class with a machine-readable code', () => {
    const modes: CredentialLookupResult[] = [
      { status: 3, stdout: '', timedOut: false },
      { status: null, stdout: '', timedOut: true },
      { status: 0, stdout: '', timedOut: false },
      { status: null, stdout: '', timedOut: false, spawnErrorCode: 'EACCES' },
    ];
    for (const mode of modes) {
      const { spawn } = fakeSpawn(mode);
      const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT, spawn }));
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as CredentialResolutionError).code).toBe('credential-resolution-failed');
      expect((err as CredentialResolutionError).variable).toBe(VAR);
    }
  });
});

// ─── 2b. The security(1) hex-mangling refusal (issue #597) ───────────────────
//
// The measured shape (2026-08-15, on a live `flotilla-linear-key` item): a
// keychain item added via `echo "$KEY" | security add-generic-password …`
// carries a trailing newline in its stored value, and
// `security find-generic-password -w` then prints that value HEX-ENCODED
// instead of as text. The resolver refuses the shape at the lookup-command
// seam rather than handing the hex string on. Both AC2 negative controls
// (hex-looking-but-not-mangled, ordinary non-hex) live here alongside the
// positive firing case, so a reader sees all three side by side.

describe('resolveCredential — refuses the measured macOS security(1) trailing-newline hex mangling', () => {
  const ENV_WITH_AMBIENT_FOR_HEX = { [VAR]: 'ambient-secret', [CMD_VAR]: 'security-lookup --field token' };

  /** hex(`plain`) — the shape `security find-generic-password -w` prints when
   * the stored item was added with a trailing newline. */
  function hexEncode(plain: string): string {
    return Buffer.from(plain, 'ascii').toString('hex');
  }

  it('FIRES on the measured shape: even-length pure hex decoding to printable text + trailing newline', () => {
    const mangled = hexEncode('lin_api_deadbeef1234567890\n');
    const { spawn } = fakeSpawn({ stdout: `${mangled}\n` }); // the lookup tool's own line ending
    const err = caught(() => resolveCredential(VAR, { env: ENV_WITH_AMBIENT_FOR_HEX, spawn }));
    expect(err).toBeInstanceOf(CredentialResolutionError);
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-hex-mangled');
    expect(e.command).toBe('security-lookup --field token');
    // Names the cause…
    expect(e.message).toContain('security(1)');
    expect(e.message).toContain('trailing newline');
    // …and the EXACT re-add fix.
    expect(e.message).toContain("printf '%s'");
    expect(e.message).toContain('security add-generic-password');
    // Never falls back to the ambient value, and never leaks either the
    // decoded plaintext or the raw hex it was decoded from — the decoded
    // text is the secret, one hex step removed.
    expect(dumpError(err)).not.toContain('ambient-secret');
    expect(dumpError(err)).not.toContain('lin_api_deadbeef1234567890');
    expect(dumpError(err)).not.toContain(mangled);
  });

  it('NEGATIVE CONTROL 1: a hex-looking value that does NOT decode to the mangled shape passes through unchanged', () => {
    // A realistic hex-spelled credential (a hash-shaped key) — even-length,
    // pure hex, but its decoded bytes are NOT printable text, so the
    // predicate must not fire and the raw value must reach the caller as-is.
    const hashLike = 'a3f5c9d2e1b7486f9a0c3d5e7f1b2a4c6d8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a';
    const { spawn } = fakeSpawn({ stdout: hashLike });
    const secret = resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn });
    expect(secret).toBe(hashLike);
  });

  it('NEGATIVE CONTROL 2: an ordinary non-hex credential is untouched', () => {
    const ordinary = 'lin_api_not_hex_at_all_zzz';
    const { spawn } = fakeSpawn({ stdout: ordinary });
    const secret = resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn });
    expect(secret).toBe(ordinary);
  });

  it('a hex value with NO trailing whitespace in its decode passes through (mid-string whitespace is not the signature)', () => {
    // decodes to "abc def" — printable, but nothing trailing to trigger on.
    const noTrailingWs = hexEncode('abc def');
    const { spawn } = fakeSpawn({ stdout: noTrailingWs });
    expect(resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn })).toBe(noTrailingWs);
  });

  it('an ODD-length hex-looking string can never be the mangling (hex is always even-length) and passes through', () => {
    const odd = 'abcde'; // 5 hex chars, odd length
    const { spawn } = fakeSpawn({ stdout: odd });
    expect(resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn })).toBe(odd);
  });

  it('the resolved credential is EITHER the raw configured value or a refusal — never a decoded form (AC3)', () => {
    const mangled = hexEncode('other-secret-value\n');
    const { spawn } = fakeSpawn({ stdout: mangled });
    let observed: string | undefined;
    try {
      observed = resolveCredential(VAR, { env: { [CMD_VAR]: 'lookup' }, spawn });
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as CredentialResolutionError).failure).toBe('lookup-hex-mangled');
    }
    // Either it threw (asserted above) or, had it not, the ONLY acceptable
    // return value is the raw configured stdout — never the decoded text.
    if (observed !== undefined) {
      expect(observed).toBe(mangled);
      expect(observed).not.toBe('other-secret-value');
    }
  });

  it('the check is pinned to the LOOKUP-COMMAND seam: an ambient value that happens to look hex-mangled is never touched', () => {
    // No `_CMD` configured at all, so this is the plain ambient-variable
    // path — the mangling is a `security(1)` lookup-output artifact, and
    // this issue pins detection there, never to the ambient variable itself.
    const mangled = hexEncode('ambient-looking-mangled\n');
    const secret = resolveCredential(VAR, { env: { [VAR]: mangled }, spawn: forbiddenSpawn });
    expect(secret).toBe(mangled);
  });
});

// ─── 3. Secret hygiene, through the REAL shell ───────────────────────────────
//
// The injected-seam tests above cannot prove the stdout/stderr containment,
// because the fixture decides what stdout is. These drive `/bin/sh` for real
// with a command that prints loud sentinels on BOTH streams.

describe('resolveCredential — the real shell, and what it must never leak', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a real lookup resolves its stdout as the secret, trailing newline trimmed', () => {
    // `echo` ends its line; that newline is not part of the secret.
    expect(resolveCredential(VAR, { env: { [CMD_VAR]: 'echo resolved-by-the-shell' } })).toBe('resolved-by-the-shell');
  });

  it('shell quoting survives (the reason ADR-0029 rejected an argv whitespace-split)', () => {
    expect(resolveCredential(VAR, { env: { [CMD_VAR]: "printf '%s' 'a b  c'" } })).toBe('a b  c');
  });

  it('a real failing lookup leaks NEITHER its stdout NOR its stderr — into the error or onto a stream', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });

    // The sentinels live in FILES, not in the command string — otherwise the
    // command (which the error names, by design) would trivially contain them
    // and the assertion would prove nothing.
    const dir = mkdtempSync(join(tmpdir(), 'flotilla-cred-'));
    const outFile = join(dir, 'out');
    const errFile = join(dir, 'err');
    writeFileSync(outFile, 'SENTINEL-ON-STDOUT');
    writeFileSync(errFile, 'SENTINEL-ON-STDERR');
    const command = `cat '${outFile}'; cat '${errFile}' 1>&2; exit 4`;
    const err = caught(() => resolveCredential(VAR, { env: { [VAR]: 'ambient-secret', [CMD_VAR]: command } }));

    const dumped = dumpError(err);
    expect(dumped).not.toContain('SENTINEL-ON-STDOUT');
    expect(dumped).not.toContain('SENTINEL-ON-STDERR');
    expect(dumped).not.toContain('ambient-secret');
    // …and the resolver itself printed nothing at all: it writes no streams.
    expect(writes.join('')).toBe('');
    // The command IS named — that is the pointer, and naming it is the point.
    expect((err as Error).message).toContain(command);
    expect((err as CredentialResolutionError).failure).toBe('lookup-exit');
  });

  it('the thrown value carries no stdout/stderr-shaped property to log by accident', () => {
    const { spawn } = fakeSpawn({ status: 1, stdout: 'SENTINEL-ON-STDOUT' });
    const err = caught(() => resolveCredential(VAR, { env: { [CMD_VAR]: 'x' }, spawn }));
    const keys = Object.keys(err as object);
    expect(keys).not.toContain('stdout');
    expect(keys).not.toContain('stderr');
    expect(keys).not.toContain('output');
    expect(keys.sort()).toEqual(['code', 'command', 'failure', 'name', 'variable']);
    expect(dumpError(err)).not.toContain('SENTINEL-ON-STDOUT');
  });

  it('a successfully resolved secret never reaches a stream (nothing here logs)', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (writes.push(String(c)), true));
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (writes.push(String(c)), true));
    const secret = resolveCredential(VAR, { env: { [CMD_VAR]: 'echo SENTINEL-RESOLVED-SECRET' } });
    expect(secret).toBe('SENTINEL-RESOLVED-SECRET');
    expect(writes.join('')).toBe('');
  });

  // ── Convention 11 negative control ──────────────────────────────────────────
  // A resolver only ever observed SUCCEEDING is unproven (ADR-0029 says so in
  // as many words). This is a deliberately broken command — a binary that does
  // not exist — run through the real shell, observed failing loud.
  it('NEGATIVE CONTROL: a deliberately broken lookup command fails loud, typed, and named', () => {
    const broken = 'flotilla-no-such-lookup-binary-0029 --field token';
    const err = caught(() =>
      resolveCredential(VAR, { env: { [VAR]: 'ambient-secret', [CMD_VAR]: broken }, purpose: 'prove the check fails' }),
    );
    expect(err).toBeInstanceOf(CredentialResolutionError);
    const e = err as CredentialResolutionError;
    expect(e.failure).toBe('lookup-exit'); // sh: command not found → 127
    expect(e.command).toBe(broken);
    expect(e.message).toContain(broken);
    // The loudness that matters: it did NOT quietly hand back the ambient value.
    expect(dumpError(err)).not.toContain('ambient-secret');
  });
});

// ─── The spawn seam itself ───────────────────────────────────────────────────

describe('defaultCredentialLookupSpawn', () => {
  it('reports stdout + a zero status for a succeeding command', () => {
    const res = defaultCredentialLookupSpawn('printf %s hello', CREDENTIAL_LOOKUP_TIMEOUT_MS);
    expect(res).toMatchObject({ stdout: 'hello', status: 0, timedOut: false });
  });

  it('reports the non-zero status of a failing command', () => {
    expect(defaultCredentialLookupSpawn('exit 9', CREDENTIAL_LOOKUP_TIMEOUT_MS).status).toBe(9);
  });

  it('reports timedOut for a command that outlives its budget (driven at 50 ms, not 60 s)', () => {
    // The BUDGET is 60 s in production; the seam takes it as a parameter so the
    // timeout PATH can be observed in milliseconds instead of a minute.
    const res = defaultCredentialLookupSpawn('sleep 5', 50);
    expect(res.timedOut).toBe(true);
    expect(res.status).not.toBe(0);
  });

  it('never surfaces stderr — there is no field for it', () => {
    const res = defaultCredentialLookupSpawn('printf %s LEAK 1>&2; printf %s ok', CREDENTIAL_LOOKUP_TIMEOUT_MS);
    expect(res.stdout).toBe('ok');
    expect(JSON.stringify(res)).not.toContain('LEAK');
    expect(Object.keys(res)).not.toContain('stderr');
  });
});

// ─── Once per credential per process (ADR-0029) ──────────────────────────────

describe('resolveCredential — memoised once per credential per process', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the production path ONCE per credential, however many edges ask', () => {
    // A dedicated variable name, so the memo this test populates can never be
    // handed to another test. The command appends a line per invocation, so the
    // file counts real shell runs.
    const dir = mkdtempSync(join(tmpdir(), 'flotilla-cred-'));
    const counter = join(dir, 'runs');
    writeFileSync(counter, '');
    const variable = 'FLOTILLA_SPEC_MEMO_TOKEN';
    vi.stubEnv(commandVariableFor(variable), `printf 'x\\n' >> '${counter}'; printf %s memoised-secret`);

    // No `env`/`spawn` override → the production path, which is the memoised one.
    expect(resolveCredential(variable)).toBe('memoised-secret');
    expect(resolveCredential(variable)).toBe('memoised-secret');
    expect(resolveCredential(variable)).toBe('memoised-secret');

    expect(readFileSync(counter, 'utf-8')).toBe('x\n'); // one shell run, three asks
  });

  it('an injected env or spawn is NEVER served from the memo (worlds do not bleed)', () => {
    const a = fakeSpawn({ stdout: 'world-a' });
    const b = fakeSpawn({ stdout: 'world-b' });
    const env = { [CMD_VAR]: 'lookup' };
    expect(resolveCredential(VAR, { env, spawn: a.spawn })).toBe('world-a');
    expect(resolveCredential(VAR, { env, spawn: b.spawn })).toBe('world-b');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

// ─── The mechanical naming rule ──────────────────────────────────────────────

describe('commandVariableFor — the mechanical `<VAR>_CMD` pairing', () => {
  it('pairs each shipped credential with its command counterpart', () => {
    expect(commandVariableFor('GITHUB_TOKEN')).toBe('GITHUB_TOKEN_CMD');
    expect(commandVariableFor('LINEAR_API_KEY')).toBe('LINEAR_API_KEY_CMD');
  });

  it('a future adapter inherits the naming for free — no per-credential table', () => {
    expect(commandVariableFor('SOME_FUTURE_TRACKER_TOKEN')).toBe('SOME_FUTURE_TRACKER_TOKEN_CMD');
  });
});
