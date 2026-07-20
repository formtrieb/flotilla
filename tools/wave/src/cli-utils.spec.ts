/**
 * cli-utils.spec.ts — the shared CLI helpers extracted from the runners.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { flag, printJson } from './cli-utils';

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
