/**
 * canonical-json.spec.ts — the one canonical form, the fidelity digest over it,
 * and the PARITY PIN between the engine helper and the copy inlined into the
 * shipped driver script.
 *
 * Three layers, each answering a different question:
 *
 *  1. **The form** — keys sorted at every depth, array order kept, leaves as
 *     `JSON.stringify` renders them.
 *  2. **The digest is FNV-1a 64-bit over UTF-8** — checked against an
 *     INDEPENDENT reference written here (`Buffer`'s UTF-8 encoder, not the
 *     helper's hand-rolled one) that is itself pinned to the published FNV test
 *     vectors. A parity test alone would only prove the two copies agree with
 *     each other; this layer proves they agree with the algorithm they name.
 *  3. **Parity** — the driver's inlined `canonicalJson`/`canonicalDigest`
 *     (the region between its `CANONICAL-DIGEST:BEGIN`/`END` markers, evaluated
 *     as the harness would) and the engine's helper agree on a shared fixture
 *     set: key reordering, unicode, nested arrays, escapes, and a full report
 *     and verdict. A negative control shows the parity check red on a copy with
 *     one line changed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_DIGEST_SHAPE, canonicalDigest, canonicalJson } from './canonical-json';

const DRIVER_PATH = join(__dirname, '..', 'driver', 'wave-start-inflight.js');
const BEGIN = '// CANONICAL-DIGEST:BEGIN';
const END = '// CANONICAL-DIGEST:END';

// ─── the independent reference ───────────────────────────────────────────────

/** FNV-1a 64-bit over `Buffer`'s UTF-8 bytes — a second implementation, on purpose. */
function referenceFnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

// ─── the shared fixture set ──────────────────────────────────────────────────

const REPORT = {
  outcome: 'done',
  issue: '42',
  branch: 'wave/42-first',
  commitShas: ['c0ffee1', 'deadbee'],
  prUrl: 'https://example.invalid/pr/1',
  filesChanged: { new: 1, modified: 2, renamed: 0 },
  tests: '10 passed',
  lint: 'clean',
  judgmentCalls: ['kept the old flag as an alias — “quoted” and ✓'],
  reviewerFocusItems: ['check the parity fixture set'],
};

const VERDICT = {
  verdict: 'approve',
  branchReviewed: 'wave/42-first',
  riskClass: 'cross-feature-refactor',
  workerReportDigest: '10/10 green',
  acVerification: [
    { ac: 'refuses an undeclared key', met: 'met', evidence: 'route-cli.spec.ts:1' },
    { ac: 'digest pinned', met: 'partial', evidence: '' },
  ],
  reviewerFocusItems: [],
  documentedFormComparison: {
    trigger: 'worker-declared',
    sources: ['https://example.invalid/doc'],
    divergences: [{ description: 'none of note', deliberate: true }],
  },
};

/** Every fixture the two implementations must agree on. */
const FIXTURES: ReadonlyArray<readonly [string, unknown]> = [
  ['empty object', {}],
  ['empty array', []],
  ['null', null],
  ['booleans', [true, false]],
  ['numbers', [0, -1.5, 1e21, 123456789, 0.1]],
  ['key order A', { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } }],
  ['key order B', { c: { y: [3, 2, 1], z: 1 }, a: 2, b: 1 }],
  ['unicode', { 'ü': 'Grüße – ✓', emoji: '🚀 👩‍💻', cjk: '漢字', rtl: 'שלום' }],
  ['escapes', { s: 'quote " backslash \\ newline \n tab \t nul \u0000 bell \u0007' }],
  ['lone surrogate (as JSON.parse yields it)', JSON.parse('{"s":"\\ud800x"}')],
  ['nested arrays', [[1, [2, [3, [4]]]], { x: [{ y: [] }, [[]]] }]],
  ['a full WorkerReport', REPORT],
  ['a full ReviewerVerdict', VERDICT],
];

// ─── 1. the form ─────────────────────────────────────────────────────────────

describe('canonicalJson — keys sorted at every depth, array order kept', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order — an ordered field reordered is a different record', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('renders leaves exactly as JSON.stringify does', () => {
    expect(canonicalJson('a"b')).toBe(JSON.stringify('a"b'));
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(1.5)).toBe('1.5');
  });
});

// ─── 2. the digest ───────────────────────────────────────────────────────────

describe('canonicalDigest — FNV-1a 64-bit over the UTF-8 bytes of the canonical form', () => {
  it('the independent reference reproduces the published FNV-1a 64 test vectors', () => {
    expect(referenceFnv1a64('')).toBe('cbf29ce484222325');
    expect(referenceFnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(referenceFnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('equals the reference over every fixture — including multi-byte UTF-8', () => {
    for (const [name, value] of FIXTURES) {
      expect(canonicalDigest(value), name).toBe(referenceFnv1a64(canonicalJson(value)));
    }
  });

  it('always has the declared shape', () => {
    for (const [name, value] of FIXTURES) {
      expect(canonicalDigest(value), name).toMatch(CANONICAL_DIGEST_SHAPE);
    }
  });

  it('key reordering alone does not change the digest', () => {
    expect(canonicalDigest({ b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } })).toBe(
      canonicalDigest({ c: { y: [3, 2, 1], z: 1 }, a: 2, b: 1 }),
    );
    const reordered = Object.fromEntries(Object.entries(REPORT).reverse());
    expect(canonicalDigest(reordered)).toBe(canonicalDigest(REPORT));
  });

  it('one reworded list element changes the digest', () => {
    const reworded = { ...REPORT, judgmentCalls: ['kept the old flag as an alias'] };
    expect(canonicalDigest(reworded)).not.toBe(canonicalDigest(REPORT));
  });

  it('an added key, an array reorder and a changed number each change the digest', () => {
    const base = canonicalDigest(REPORT);
    expect(canonicalDigest({ ...REPORT, verifyOutput: 'x' })).not.toBe(base);
    expect(canonicalDigest({ ...REPORT, commitShas: ['deadbee', 'c0ffee1'] })).not.toBe(base);
    expect(canonicalDigest({ ...REPORT, filesChanged: { new: 1, modified: 3, renamed: 0 } })).not.toBe(
      base,
    );
  });

  it('a JSON round-trip — what a faithful Scribe copy is — does not change the digest', () => {
    for (const [name, value] of FIXTURES) {
      expect(canonicalDigest(JSON.parse(JSON.stringify(value))), name).toBe(canonicalDigest(value));
    }
  });
});

// ─── 3. parity with the driver's inlined copy ────────────────────────────────

/** The driver's inlined region, sliced by its markers. */
function driverRegion(source: string): string {
  const at = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  expect(at, `the driver must carry ${BEGIN}`).toBeGreaterThan(-1);
  expect(end, `the driver must carry ${END}`).toBeGreaterThan(at);
  return source.slice(at, end);
}

/** Evaluate a region the way the harness would run it — plain script, no imports. */
function evaluate(region: string): {
  canonicalJson: (v: unknown) => string;
  canonicalDigest: (v: unknown) => string;
} {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${region}\nreturn { canonicalJson, canonicalDigest }`)();
}

/** Every fixture on which `copy` disagrees with the engine helper. */
function disagreements(copy: ReturnType<typeof evaluate>): string[] {
  return FIXTURES.filter(
    ([, value]) =>
      copy.canonicalJson(value) !== canonicalJson(value) ||
      copy.canonicalDigest(value) !== canonicalDigest(value),
  ).map(([name]) => name);
}

describe("PARITY — the driver's inlined digest and the engine helper agree on the shared fixtures", () => {
  const region = driverRegion(readFileSync(DRIVER_PATH, 'utf-8'));

  it('the region imports nothing and names no Node global — it runs where the driver runs', () => {
    expect(region).not.toMatch(/\brequire\(|\bimport\b|\bBuffer\b|\bTextEncoder\b|\bcrypto\b/);
  });

  it('agrees on every fixture — form and digest alike', () => {
    expect(disagreements(evaluate(region))).toEqual([]);
  });

  it('NEGATIVE CONTROL — a copy with the key sort removed disagrees, on the key-order fixtures', () => {
    const broken = region.replace('Object.keys(value).sort()', 'Object.keys(value)');
    expect(broken).not.toBe(region);
    const failing = disagreements(evaluate(broken));
    expect(failing).toContain('key order A');
    expect(failing).toContain('key order B');
  });

  it('NEGATIVE CONTROL — a copy that hashes UTF-16 code units instead of UTF-8 disagrees, on unicode', () => {
    const broken = region.replace('if (cp < 0x80) { eat(cp) }', 'if (true) { eat(cp & 0xff) }');
    expect(broken).not.toBe(region);
    const failing = disagreements(evaluate(broken));
    expect(failing).toContain('unicode');
    expect(failing).not.toContain('key order A');
  });
});
