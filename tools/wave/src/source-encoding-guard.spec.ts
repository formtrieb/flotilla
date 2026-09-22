/**
 * source-encoding-guard.spec.ts — the check that no engine TypeScript source
 * carries a raw U+0000 byte.
 *
 * ## Why a byte, and why this byte
 *
 * A single NUL anywhere in a file is what every POSIX text tool keys on to
 * decide the file is not text. `file(1)` then reports `data`; a POSIX `grep`
 * stops searching it. The failure that matters is the SECOND one, and it is
 * silent in the worst available way: the search returns EMPTY WITH NO ERROR,
 * so a shell audit of the file reads as clean when the file has not been read
 * at all. Nothing else notices — `vitest` and `tsc` both decode the file fine,
 * so the whole suite and the type gate stay green while every grep-shaped
 * check over that path is quietly answering about nothing.
 *
 * That is not hypothetical here. `ff-guard.spec.ts` carried two raw NULs as
 * the separator of a composite map key, and `skill-clause-drift.spec.ts` had
 * carried them for the same reason before it (flotilla #867). Both were found
 * by a reader, not by a test, because there was no test. This file is that
 * test.
 *
 * ## What it is NOT
 *
 * It is not a linter for text encoding in general, and it does not invoke
 * `file(1)` or `grep(1)`. The rule those tools apply to this byte is modelled
 * in-process, for a reason stated in the declaration's Unmodelled set: the
 * tools do not agree with each other on what to PRINT for a binary file, so
 * their output is not a stable instrument, while the byte itself is exact.
 *
 * Pure test — zero production change. Path note: this spec lives at
 * `tools/wave/src/`, so `__dirname` is the engine's source root.
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = __dirname;

/**
 * The byte this guard refuses, as a number rather than as a character.
 *
 * Note the shape of this line: the value is written `0x00`, and the one place
 * below that needs the CHARACTER writes the `\u0000` ESCAPE. Neither puts a
 * raw NUL in this file, which is what keeps the guard from failing on itself —
 * and is exactly the remedy it asks of everything else.
 */
const NUL_BYTE = 0x00;

/**
 * The measured floor on the scanned population.
 *
 * 149 `.ts` files sit under `tools/wave/src/` at this commit. The floor is not
 * that number — pinning it would turn every added or deleted module into an
 * edit here — it is a refusal of the silent green a walk bug would otherwise
 * produce: a `readdirSync` that returned `[]` would make "no file carries a
 * NUL" vacuously true, which is the same shape of empty answer this guard
 * exists to catch.
 */
const MIN_SCANNED = 100;

// ─── reading the subject ─────────────────────────────────────────────────────

/** Every `.ts` file under `dir`, recursively, as absolute paths, sorted. */
function typeScriptSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...typeScriptSourcesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** The byte offsets of every {@link NUL_BYTE} in `bytes`. */
function nulOffsets(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NUL_BYTE) out.push(i);
  }
  return out;
}

/**
 * The POSIX binary-classification rule, modelled: a file containing a NUL is
 * not text, and that is the whole rule as far as this byte is concerned.
 */
function classifiesAsBinary(bytes: Uint8Array): boolean {
  return nulOffsets(bytes).length > 0;
}

/**
 * What a text-mode search for `needle` in `bytes` would find — the predicate
 * that makes the defect visible instead of merely present.
 *
 * The first clause is the point. A searcher that has classified the buffer as
 * binary does not look inside it, so the answer is `false` even when the
 * needle is plainly there. A search that only decoded and called `includes`
 * would answer `true` in both states and discriminate nothing.
 */
function textSearchFinds(bytes: Uint8Array, needle: string): boolean {
  if (classifiesAsBinary(bytes)) return false;
  return Buffer.from(bytes).toString('utf8').includes(needle);
}

/** `line:column` of a byte offset, counting the newlines before it. */
function positionOf(bytes: Uint8Array, offset: number): string {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return `${line}:${column}`;
}

interface Finding {
  /** Absolute path of the offending file. */
  readonly file: string;
  /** Byte offsets of each NUL in it. */
  readonly offsets: readonly number[];
  /** A `path:line:column` list a reader can jump to. */
  readonly where: string;
}

/** Every `.ts` file under `dir` that carries a raw NUL, with where it sits. */
function scan(dir: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of typeScriptSourcesUnder(dir)) {
    const bytes = readFileSync(file);
    const offsets = nulOffsets(bytes);
    if (offsets.length === 0) continue;
    findings.push({
      file,
      offsets,
      where: offsets.map((o) => `${file}:${positionOf(bytes, o)}`).join(', '),
    });
  }
  return findings;
}

/** Repo-relative-ish label, so a failure message names a path a reader can open. */
function label(file: string): string {
  return relative(join(SRC_DIR, '..', '..', '..'), file);
}

// ─── Guard declaration (ADR-0052) ────────────────────────────────────────────

/**
 * **Subject.** Raw bytes, read as bytes: every `.ts` file under
 * `tools/wave/src/`, walked recursively off the directory rather than listed,
 * and scanned for one byte value — `0x00`. Nothing here decodes a file, parses
 * TypeScript, type-checks, or judges whether a NUL-free file says anything
 * true. The one derived fact is the offset of each NUL, reported as
 * `path:line:column`.
 *
 * **Resolution bias — BLOCKS.** Every subject this reader cannot read fails.
 * `readdirSync`, `statSync` and `readFileSync` throw rather than returning
 * "nothing found" on a directory or file the walk cannot open, and the
 * population carries a floor ({@link MIN_SCANNED}) so a walk that returned an
 * empty list goes red instead of making the assertion vacuously green.
 *
 * The direction is not a default here, it is the whole point. The failure this
 * guard exists to catch IS a silent empty answer — a grep that read nothing
 * and reported nothing wrong. A guard that passed on a subject it could not
 * read would reproduce that exact failure one layer up, and would do it in the
 * one place a reader has left to trust. The cost of blocking wrongly is a
 * maintainer at `npm test` with the unreadable path named; the cost of passing
 * wrongly is a check that certifies a tree it never opened.
 *
 * **Unmodelled set, named rather than assumed away.**
 *
 *  1. **Everything that is not a `.ts` file under `tools/wave/src/`.** Files
 *     of another extension inside that tree, the shipped `.cjs` hooks, the
 *     driver assets, the `.claude/skills/` corpus and the docs tree are all
 *     unscanned.
 *     The same byte has the same effect in every one of them, and nothing here
 *     looks. The scope is the tree where the two measured occurrences lived.
 *  2. **Every other reason a tool calls a file binary.** `file(1)` also keys on
 *     invalid multi-byte sequences and on the density of non-printing bytes in
 *     its first buffer; GNU `grep` keys on encoding errors as well as on NUL.
 *     Only `0x00` is modelled — it is the one occurrence measured in this tree
 *     and the one rule the tools agree on.
 *  3. **`file(1)` and `grep(1)` themselves, which are never invoked.** Their
 *     shared rule is modelled in-process instead, deliberately: asked about a
 *     binary file, GNU `grep -c` prints a COUNT while BSD `grep -c` prints
 *     nothing at all, so the tool's own answer is not a stable instrument
 *     across the platforms this suite runs on — it is green on the defect under
 *     one build and red under another. A divergence between the model here and
 *     a particular `grep` build would not be seen by this guard.
 *  4. **A NUL introduced at runtime.** The subject is bytes on disk. A string
 *     built from a `\u0000` escape or from `String.fromCharCode(0)` is plain
 *     ASCII in the source and passes, correctly — and would still re-create the
 *     hazard in any file that code goes on to WRITE. Nothing here follows a
 *     value to its destination.
 *  5. **The walk's own reach.** `statSync` follows symlinks, so a link into the
 *     tree is scanned as the file it points at and a source file reachable only
 *     through a path `readdirSync` does not enumerate is not scanned at all.
 *  6. **Whether the remedy is the right one.** The guard refuses the byte; it
 *     does not know or check what replaced it. `ff-guard.spec.ts`'s U+E000
 *     separator satisfies this guard, and so would any other NUL-free
 *     separator, including one the operands CAN contain — the injectivity that
 *     key relies on is asserted in that spec, not here.
 */

// ─── the population is derived, and the derivation is visible ────────────────

// Printed on every run, for the same reason the guard-declaration keeper and
// the loaded-corpus guard print theirs: a reader sees WHAT was scanned without
// opening this file, so a population that moved under the check is visible in
// the run that first noticed.
{
  const scanned = typeScriptSourcesUnder(SRC_DIR);
  const bytes = scanned.reduce((sum, f) => sum + readFileSync(f).length, 0);
  console.log(
    `[source-encoding-guard] ${scanned.length} .ts files under tools/wave/src/ ` +
      `(${Math.ceil(bytes / 1024)} KB) scanned for raw U+0000`,
  );
}

describe('source-encoding-guard: no engine TypeScript source carries a raw NUL byte', () => {
  const scanned = typeScriptSourcesUnder(SRC_DIR);

  it('scans a population, rather than an empty list that would pass vacuously', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
  });

  it('no file under the engine source tree contains U+0000', () => {
    const findings = scan(SRC_DIR);
    expect(
      findings.map((f) => f.where),
      findings.length === 0
        ? ''
        : `raw NUL byte(s) in ${findings.length} file(s). A NUL makes the file ` +
          `classify as binary, so file(1) reports "data" and a POSIX grep skips ` +
          `it and returns EMPTY WITH NO ERROR. Write the escape (\\u0000), or ` +
          `pick a NUL-free sentinel — U+E000 is what ff-guard.spec.ts and ` +
          `skill-clause-drift.spec.ts use.`,
    ).toEqual([]);
  });

  it('this guard holds itself to its own rule', () => {
    // The guard writes `0x00` and the `\u0000` escape and never a raw byte, so
    // it is inside its own population rather than an exception to it.
    expect(nulOffsets(readFileSync(__filename))).toEqual([]);
    expect(scanned).toContain(__filename);
  });
});

describe('source-encoding-guard: the previously-affected spec is searchable as text', () => {
  const affected = join(SRC_DIR, 'ff-guard.spec.ts');
  const bytes = readFileSync(affected);

  it('classifies as text, not as binary data', () => {
    expect(classifiesAsBinary(bytes), `${label(affected)} classifies as binary`).toBe(false);
  });

  it('a text-mode search for an identifier it contains returns a match, not empty', () => {
    // Before flotilla #937 this file carried two raw NULs, so a POSIX grep
    // skipped it and this identifier — plainly present on two lines — could not
    // be found from a shell at all.
    expect(bytes.toString('utf8')).toContain('isAncestor');
    expect(textSearchFinds(bytes, 'isAncestor')).toBe(true);
  });
});

describe('source-encoding-guard: negative controls — each way this guard goes red', () => {
  it('a buffer carrying a NUL is detected, and its offset reported', () => {
    const planted = Buffer.from(`const isAncestor = 1;\u0000\n`, 'utf8');
    expect(nulOffsets(planted)).toEqual([21]);
    expect(classifiesAsBinary(planted)).toBe(true);
    expect(positionOf(planted, 21)).toBe('1:22');
  });

  it('…and the identifier in that same buffer becomes UNFINDABLE — the actual defect', () => {
    const planted = Buffer.from(`const isAncestor = 1;\u0000\n`, 'utf8');
    const clean = Buffer.from(`const isAncestor = 1;\n`, 'utf8');
    // The needle is present in BOTH buffers. Only the classification differs,
    // and that alone is enough to make the search answer "no match" — which it
    // does without raising anything.
    expect(clean.toString('utf8')).toContain('isAncestor');
    expect(planted.toString('utf8')).toContain('isAncestor');
    expect(textSearchFinds(clean, 'isAncestor')).toBe(true);
    expect(textSearchFinds(planted, 'isAncestor')).toBe(false);
  });

  it('the file-level scan reports a real NUL-bearing .ts file on disk, and is clean without it', () => {
    // The predicate above is a pure function; this exercises the path that
    // actually runs in anger — walk the directory, read each file as BYTES,
    // report. A scanner that read files as decoded text with a lossy encoding,
    // or that skipped what it could not parse, passes the pure test and fails
    // here.
    const dir = mkdtempSync(join(tmpdir(), 'source-encoding-guard-'));
    try {
      writeFileSync(join(dir, 'clean.ts'), 'export const a = 1;\n', 'utf8');
      expect(scan(dir)).toEqual([]);

      const offender = join(dir, 'offender.ts');
      writeFileSync(offender, Buffer.from(`export const sep = '\u0000';\n`, 'utf8'));
      const findings = scan(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe(offender);
      expect(findings[0].offsets).toEqual([20]);
      expect(findings[0].where).toBe(`${offender}:1:21`);

      // …and removing it restores the green, so the red above was the NUL and
      // not the directory.
      rmSync(offender);
      expect(scan(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a walk that returned nothing does not pass as "no findings"', () => {
    // MIN_SCANNED is what stands between this guard and the silent green. Shown
    // here rather than asserted in prose: an empty population makes the finding
    // list empty too, and the floor is the only thing that tells them apart.
    const empty = mkdtempSync(join(tmpdir(), 'source-encoding-guard-empty-'));
    try {
      expect(typeScriptSourcesUnder(empty)).toEqual([]);
      expect(scan(empty)).toEqual([]);
      expect(typeScriptSourcesUnder(empty).length).toBeLessThan(MIN_SCANNED);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
