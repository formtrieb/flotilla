/**
 * cli-utils.spec.ts — the shared CLI helpers extracted from the runners.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { flag, printJson, describeConfigLoadError } from './cli-utils';

describe('flag', () => {
  it('returns the value following a present flag', () => {
    expect(flag(['--config', 'wave.json', '--x'], '--config')).toBe('wave.json');
  });

  it('returns undefined when the flag has no following value (last token)', () => {
    expect(flag(['read', 'id', '--patch'], '--patch')).toBeUndefined();
  });

  it('returns undefined when the flag is absent', () => {
    expect(flag(['read', 'id'], '--patch')).toBeUndefined();
  });
});

describe('printJson', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes 2-space pretty JSON with a trailing newline', () => {
    let captured = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array): boolean => {
        captured += chunk.toString();
        return true;
      },
    );
    printJson({ a: 1, b: ['x'] });
    expect(captured).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
  });
});

// ─── describeConfigLoadError (issue #505 — the config-miss teaching error) ──
//
// The motivating misfire: `triage-apply` without `--config` used to surface a
// bare `ENOENT: no such file or directory, open 'wave.config.json'` — Node's
// message, not an operator's. These specs prove BOTH sides of Convention 11:
// the negative control shows the raw fs error really is bare (the bug this
// replaces is real, not assumed), and the positive cases show the transform
// replaces it with a message naming the fix.

describe('describeConfigLoadError', () => {
  const nonexistentPath = '/definitely/does-not-exist/wave.config.json';

  function realEnoent(): unknown {
    try {
      readFileSync(nonexistentPath, 'utf8');
    } catch (err) {
      return err;
    }
    throw new Error('expected readFileSync to throw for a nonexistent path');
  }

  it('NEGATIVE CONTROL — the raw fs error really is a bare ENOENT with no mention of --config', () => {
    const err = realEnoent();
    expect((err as Error).message).toContain('ENOENT');
    expect((err as Error).message).not.toContain('--config');
  });

  it('a missing DEFAULT wave.config.json teaches "pass --config <path>", never the bare ENOENT', () => {
    const message = describeConfigLoadError(realEnoent(), 'wave.config.json', false);
    expect(message).toBe('no wave.config.json in cwd — pass --config <path>');
    expect(message).not.toContain('ENOENT');
  });

  it('a missing EXPLICIT --config path names the path it tried, not "pass --config" (the caller already did)', () => {
    const message = describeConfigLoadError(realEnoent(), nonexistentPath, true);
    expect(message).toContain(nonexistentPath);
    expect(message).toContain('--config');
    expect(message).not.toContain('ENOENT');
  });

  it('a non-ENOENT failure (malformed config, bad store shape) passes through unchanged — it already names its own fix', () => {
    const domainErr = new Error('unknown store kind: "bogus"');
    expect(describeConfigLoadError(domainErr, 'wave.config.json', false)).toBe(
      'unknown store kind: "bogus"',
    );
    expect(describeConfigLoadError(domainErr, '/x/wave.config.json', true)).toBe(
      'unknown store kind: "bogus"',
    );
  });
});
