/**
 * source-encoding-guard.spec.ts — the check that no git-tracked text file in
 * this repository carries a raw U+0000 byte.
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
 * **Downstream dependency (flotilla #956).** Every grep-shaped audit run over
 * this repository trusts this guard whether or not it says so. The Reviewer's
 * conflict-marker floor check — `.claude/skills/wave-reviewer/reference/reviewer-checks.md`
 * Check 2 and `.claude/agents/wave-reviewer.md`'s own Check 2 — is a POSIX-style
 * `grep` over the review tree, and it is sound only because this guard has
 * already established, for the tree it covers, that no file in it carries the
 * one byte that would make that grep report the tree clean without having read
 * it. Both of those files now say so in one sentence apiece, at the check they
 * back; this paragraph is this guard's own half of that same statement. Any
 * FUTURE grep-shaped audit in this repository inherits the identical
 * dependency, whether or not its own author thinks to name it.
 *
 * ## Widened from engine TypeScript to every tracked text file (flotilla #956)
 *
 * The guard originally scanned `.ts` files under `tools/wave/src/` only,
 * because that is where both measured occurrences lived. Nothing about the
 * hazard is TypeScript-specific or engine-specific — the skills corpus, the
 * shipped hook files, the driver assets and the docs tree carry the same byte
 * hazard and were unscanned. The subject is now every file **git tracks**,
 * minus three named exclusions (see {@link EXCLUDED_BINARY_EXTENSIONS} and
 * {@link isNonRegularGitMode}), scanned as bytes exactly as before.
 *
 * Pure test — zero production change. Path note: this spec lives at
 * `tools/wave/src/`, so `__dirname` is the engine's source root and
 * `REPO_ROOT` (three levels up) is the clone root `git ls-files` is run from.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The engine's own source root — kept for the tests that specifically exercise
 * a known file inside it (`ff-guard.spec.ts`, this file itself). */
const ENGINE_SRC_DIR = __dirname;

/** The clone root — `git ls-files` is run from here, and every path this file
 * reports is relative or absolute against it. Three levels up from
 * `tools/wave/src/`, the same computation `loaded-corpus-guard.spec.ts` makes. */
const REPO_ROOT = resolve(__dirname, '../../..');

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
 * **Exclusion 1 of 3 — binary file extensions.** A named denylist, not a
 * content sniff: a binary format legitimately carries arbitrary bytes,
 * including NUL, and a NUL in one is not a defect this guard exists to report
 * — scanning them for this specific byte would be noise, not signal.
 *
 * As of this row, **zero tracked files in this repository match any entry
 * here** (`git ls-files` today is images-and-fonts-free — see the population
 * print below). The list still earns its place: it is what keeps a future
 * binary asset — a logo, a font, a packaged tarball fixture — from failing
 * this guard for carrying the very byte it is expected to carry.
 */
const EXCLUDED_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives / packages
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar',
  // documents
  '.pdf',
  // audio / video
  '.mp3', '.mp4', '.mov', '.wav', '.avi', '.webm',
  // compiled / binary code
  '.so', '.dylib', '.dll', '.wasm', '.node', '.class', '.jar', '.exe',
]);

/** Does `path`'s extension put it on the binary denylist? Case-insensitive —
 * `.PNG` is excluded exactly as `.png` is. */
function isBinaryExtension(path: string): boolean {
  return EXCLUDED_BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * **Exclusion 2 of 3 — a tracked path whose git mode is not a regular file.**
 * `120000` is a symlink: its tracked content (what `git cat-file` would print)
 * is a PATH STRING, not the target's bytes — reading it as source text would
 * be scanning the wrong thing, or scanning it twice under two different names.
 * `160000` is a submodule gitlink: its tracked content is a commit pointer
 * into another repository, not a file this repository owns the bytes of.
 * `100644` (regular) and `100755` (regular, executable) are the only modes
 * this guard treats as scannable text.
 *
 * As of this row, **zero tracked entries in this repository carry either
 * excluded mode** (`tools/wave/bin/flotilla-engine.js` is the repo's one
 * `100755`, itself scanned normally). Named anyway, for the same reason as
 * the extension denylist above: so a future symlink or submodule does not
 * fail this guard for a byte in a file it never actually reads.
 */
function isNonRegularGitMode(mode: string): boolean {
  return mode !== '100644' && mode !== '100755';
}

/**
 * The measured floor on the scanned population.
 *
 * 354 tracked files sit in this repository at this commit; none is excluded
 * by either named exclusion (see above), so the scanned population is 354.
 * The floor is not that number — pinning it would turn every added or deleted
 * tracked file into an edit here — it is a refusal of the silent green a walk
 * bug would otherwise produce: an empty (or git-unavailable) population would
 * make "no file carries a NUL" vacuously true, which is the same shape of
 * empty answer this guard exists to catch.
 */
const MIN_SCANNED = 300;

// ─── reading the subject: every git-tracked text file ────────────────────────

interface TrackedEntry {
  /** The raw git file mode, e.g. `100644`, `120000`. */
  readonly mode: string;
  /** Repo-root-relative path, forward-slash, exactly as git prints it. */
  readonly path: string;
}

/**
 * Parse `git ls-files -s -z` output: `<mode> <sha> <stage>\t<path>`, entries
 * NUL-terminated. `-z` (not the newline form) is what makes this safe against
 * a path containing a space or any other byte a newline-based parse would
 * mishandle — verified below against a path containing a space.
 */
function parseLsFilesZ(output: string): TrackedEntry[] {
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).trim().split(/\s+/);
      return { mode: meta[0], path: entry.slice(tab + 1) };
    });
}

/**
 * Every path `git` tracks in `repoRoot`, with its mode. Throws — does not
 * return `[]` — if `git` is missing or `repoRoot` is not a git working tree,
 * which is this guard's Resolution bias applied to the new subject: a reader
 * that cannot be asked fails loudly rather than reporting an empty, vacuously
 * clean population.
 */
function trackedEntries(repoRoot: string): TrackedEntry[] {
  const output = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseLsFilesZ(output);
}

/**
 * Every git-tracked TEXT file under `repoRoot`, as absolute paths, sorted.
 * "Tracked" excludes everything git itself does not track — build output,
 * `node_modules/`, the `.git/` directory itself, anything gitignored — by
 * construction: this reads `git ls-files`'s own list of tracked blobs, never
 * a filesystem walk. "Text" additionally excludes the two named exclusions
 * above.
 */
function trackedTextFiles(repoRoot: string): string[] {
  return trackedEntries(repoRoot)
    .filter((e) => !isNonRegularGitMode(e.mode) && !isBinaryExtension(e.path))
    .map((e) => join(repoRoot, e.path))
    .sort();
}

/**
 * Every text file under `dir`, walked off the filesystem (not git) — for the
 * mkdtemp fixtures below, which are deliberately OUTSIDE any git working tree.
 * Applies the same {@link isBinaryExtension} exclusion as the real corpus, so
 * a fixture test exercises the identical filter the live guard runs.
 *
 * `statSync` follows symlinks (unchanged from this guard's original walker),
 * so a symlink planted inside a fixture directory is scanned as the file it
 * points at. This is a narrower, filesystem-only caveat than
 * {@link isNonRegularGitMode} above: the real corpus never reaches this
 * function, and a git-tracked symlink is excluded there by mode, not walked
 * through.
 */
function textFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...textFilesUnder(full));
    else if (!isBinaryExtension(full)) out.push(full);
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

/** Every file in `files` that carries a raw NUL, with where it sits. */
function scan(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
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

/** Repo-relative label, so a failure message names a path a reader can open. */
function label(file: string): string {
  return relative(REPO_ROOT, file);
}

// ─── Guard declaration (ADR-0052) ────────────────────────────────────────────

/**
 * **Subject.** Raw bytes, read as bytes: every file `git ls-files` reports as
 * tracked in this repository, minus two named exclusions applied by git mode
 * and by extension (see {@link isNonRegularGitMode} and
 * {@link isBinaryExtension} above — "exclusion 2 of 3" and "1 of 3"; the third
 * is "everything git itself does not track", which the subject excludes by
 * construction rather than by a predicate this file runs), scanned for one
 * byte value — `0x00`. Nothing here decodes a file, parses TypeScript,
 * type-checks, or judges whether a NUL-free file says anything true. The one
 * derived fact is the offset of each NUL, reported as `path:line:column`.
 *
 * **Resolution bias — BLOCKS.** Every subject this reader cannot read fails.
 * `execFileSync('git', ['ls-files', …])`, `readFileSync` and the fixture
 * walker's `readdirSync`/`statSync` all throw rather than returning "nothing
 * found" on a repository, directory or file they cannot open, and the
 * population carries a floor ({@link MIN_SCANNED}) so a walk that returned an
 * empty list goes red instead of making the assertion vacuously green.
 *
 * The direction is not a default here, it is the whole point. The failure this
 * guard exists to catch IS a silent empty answer — a grep that read nothing
 * and reported nothing wrong. A guard that passed on a subject it could not
 * read would reproduce that exact failure one layer up, and would do it in the
 * one place a reader has left to trust. The cost of blocking wrongly is a
 * maintainer at `npm test` with the unreadable path (or the missing `git`)
 * named; the cost of passing wrongly is a check that certifies a tree it never
 * opened.
 *
 * **Unmodelled set, named rather than assumed away.**
 *
 *  1. **The three named exclusions above.** A binary-extension match, a
 *     non-regular git mode, and anything git itself does not track (build
 *     output, `node_modules/`, `.git/` internals, anything gitignored) are
 *     all out of the subject. Together they subtract exactly zero files from
 *     this repository's tracked tree today — the population print below shows
 *     the live count — so widening this guard did not also quietly narrow it
 *     back down through the exclusions; they are named for what they will
 *     someday matter to, not for what they matter to now.
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
 *     a particular `grep` build would not be seen by this guard. (`git`,
 *     conversely, is invoked, for enumeration only — never asked to classify
 *     content, which is the part that varies across tools.)
 *  4. **A NUL introduced at runtime.** The subject is bytes on disk. A string
 *     built from a `\u0000` escape or from `String.fromCharCode(0)` is plain
 *     ASCII in the source and passes, correctly — and would still re-create the
 *     hazard in any file that code goes on to WRITE. Nothing here follows a
 *     value to its destination.
 *  5. **The fixture walker's own reach.** `textFilesUnder` (used only by the
 *     mkdtemp negative controls below, never by the real corpus) calls
 *     `statSync`, which follows symlinks — a link planted inside a fixture
 *     directory is scanned as the file it points at. The real corpus never
 *     takes this path: a git-tracked symlink is excluded by mode before any
 *     file is opened.
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
  const scanned = trackedTextFiles(REPO_ROOT);
  const bytes = scanned.reduce((sum, f) => sum + readFileSync(f).length, 0);
  const excluded = trackedEntries(REPO_ROOT).length - scanned.length;
  console.log(
    `[source-encoding-guard] ${scanned.length} git-tracked text file(s) across the repository ` +
      `(${Math.ceil(bytes / 1024)} KB, ${excluded} excluded by the two named exclusions) scanned for raw U+0000`,
  );
}

describe('source-encoding-guard: no git-tracked text file in the repository carries a raw NUL byte', () => {
  const scanned = trackedTextFiles(REPO_ROOT);

  it('scans a population, rather than an empty list that would pass vacuously', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(MIN_SCANNED);
  });

  it('no file in the repository contains U+0000', () => {
    const findings = scan(scanned);
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

  it('the population is not confined to engine TypeScript — the widening this row adds', () => {
    // A concrete assertion against the REAL tracked tree, not only against a
    // synthetic fixture: engine TypeScript is still in, and so are the other
    // shipped kinds the original guard never looked at.
    expect(scanned.some((f) => f.endsWith('.spec.ts'))).toBe(true);
    expect(scanned).toContain(join(REPO_ROOT, 'CLAUDE.md'));
    expect(scanned).toContain(
      join(REPO_ROOT, '.claude/skills/wave-reviewer/reference/reviewer-checks.md'),
    );
    expect(scanned).toContain(join(REPO_ROOT, '.claude/agents/wave-reviewer.md'));
    expect(scanned).toContain(join(REPO_ROOT, 'tools/wave/package.json'));
  });
});

describe('source-encoding-guard: the previously-affected spec is searchable as text', () => {
  const affected = join(ENGINE_SRC_DIR, 'ff-guard.spec.ts');
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

  it('parses git ls-files -s -z output, including a path containing a space', () => {
    // The `-z` (NUL-terminated) form, not the newline form, is what makes this
    // safe: a newline-based parse handles a space in a path fine too, but this
    // is the format the real reader actually consumes, asserted directly.
    const sample = '100644 aaaa 0\tfoo/bar.ts\u0000100755 bbbb 0\tfoo/has space.sh\u0000';
    expect(parseLsFilesZ(sample)).toEqual([
      { mode: '100644', path: 'foo/bar.ts' },
      { mode: '100755', path: 'foo/has space.sh' },
    ]);
  });

  it('git file modes: only a symlink or a submodule gitlink is excluded by mode', () => {
    expect(isNonRegularGitMode('100644')).toBe(false); // regular file
    expect(isNonRegularGitMode('100755')).toBe(false); // regular, executable
    expect(isNonRegularGitMode('120000')).toBe(true); // symlink — tracked content is a path string
    expect(isNonRegularGitMode('160000')).toBe(true); // submodule gitlink — tracked content is a commit pointer
  });

  it('a binary-extension file is excluded — not scanned, even though it carries the byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-encoding-guard-binary-'));
    try {
      const asset = join(dir, 'sprite.png');
      writeFileSync(asset, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
      expect(isBinaryExtension(asset)).toBe(true);
      // Excluded, not "scanned and clean" — the file is never opened for this
      // purpose, which is the point of an exclusion rather than a pass.
      expect(textFilesUnder(dir)).not.toContain(asset);
      expect(scan(textFilesUnder(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the widened guard catches a NUL in a non-TypeScript file, outside the engine tree entirely (flotilla #956)', () => {
    // The control this row's acceptance criteria ask for: a fixture OUTSIDE
    // tools/wave/src/ (a temp directory, not even inside this git working
    // tree) carrying a U+0000 fails, with the file named — proving the widened
    // net is real and not TypeScript-specific.
    const dir = mkdtempSync(join(tmpdir(), 'source-encoding-guard-widened-'));
    try {
      writeFileSync(join(dir, 'clean.md'), '# clean\n', 'utf8');
      expect(scan(textFilesUnder(dir))).toEqual([]);

      const offender = join(dir, 'offender.md');
      writeFileSync(offender, Buffer.from('# offender\n\u0000\n', 'utf8'));
      const findings = scan(textFilesUnder(dir));
      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe(offender);
      expect(findings[0].offsets).toEqual([11]);
      expect(findings[0].where).toBe(`${offender}:2:1`);

      // …and removing it restores the green, so the red above was the NUL and
      // not the directory.
      rmSync(offender);
      expect(scan(textFilesUnder(dir))).toEqual([]);
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
      expect(textFilesUnder(empty)).toEqual([]);
      expect(scan(textFilesUnder(empty))).toEqual([]);
      expect(textFilesUnder(empty).length).toBeLessThan(MIN_SCANNED);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
