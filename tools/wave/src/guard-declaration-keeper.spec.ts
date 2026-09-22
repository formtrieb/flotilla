/**
 * guard-declaration-keeper.spec.ts — the keeper of the ADR-0052 Guard
 * declarations: the check that a Guard cannot land, or quietly stop, without
 * saying what it reads, which way it resolves a not-knowing, and what it does
 * not model.
 *
 * ## Why a keeper at all
 *
 * ADR-0052 gave the Guard family a third answer kind, a declared **Resolution
 * bias** and a named **Unmodelled set**, and put the declaration in PROSE by
 * design — the drift specs' scanners are not shell scanners, so there was
 * nothing to encode it in. The consequence was left standing: nothing asserted
 * that a Guard carried a declaration at all. A new Guard could land without
 * one, and an edit could delete one from an existing Guard, and in both cases
 * every test stayed green. That is the gap this file closes, and it is the
 * same shape as the gap `loaded-corpus-guard.spec.ts` closes for the
 * Enforcement-Tier declaration one rung up: a residual nobody re-reads is a
 * claim, not a fact.
 *
 * ## The derivation, stated in place — because the trap here is circularity
 *
 * A keeper that derives its population as *"the files that carry a
 * declaration"* can never catch a Guard that has none, which is the entire
 * failure it exists to prevent. A keeper that derives it as *"the files
 * matching the guard glob"* catches that, and misses a declaration living
 * anywhere else. Both halves matter, so the population is the UNION of three
 * sets, each derived independently from the filesystem and none of them a
 * hand-maintained list of members:
 *
 *   **A — named Guard specs that reach external text.** Every
 *   `src/*-guard.spec.ts`, read off the directory rather than listed here,
 *   FILTERED to those whose source imports a reader of something outside
 *   itself (`node:fs`, `node:fs/promises`, `node:child_process`,
 *   `fast-glob`). The filter is the substantive half of the definition, not a
 *   convenience: a Guard's Resolution bias is its answer to *"I read my
 *   subject and could not conclude"*, so a spec that reads no subject — one
 *   that drives a pure function through injected fakes — has no not-knowing to
 *   resolve and no corpus to under-model. A declaration there would be
 *   decoration. Set A is what catches a NEW Guard landing with nothing
 *   declared, and it consults no declaration to do it.
 *
 *   **B — this file.** By `__filename`, not by name: a keeper exempt from its
 *   own rule is the oldest failure in the genre, and self-reference costs
 *   nothing and cannot go stale.
 *
 *   **C — files that already carry a declaration**, anywhere under `src/` or
 *   `hooks/`, detected by the Subject marker in COMMENT position. This half IS
 *   circular and is kept for one job only, stated plainly: it protects a
 *   declaration living outside A and B from being GUTTED — a bias or an
 *   Unmodelled set deleted while the Subject line stays. Against TOTAL
 *   deletion outside A ∪ B it is useless by construction, because the deletion
 *   removes the membership. That blind spot is real and is named again in this
 *   keeper's own Unmodelled set, with the pinned census below as the tripwire
 *   over it.
 *
 * ## Where a member's declaration is allowed to live
 *
 * Two members of set A do not carry their declaration in themselves and must
 * not be made to: `conv12-guard.spec.ts` and `echo-guard.spec.ts` are the
 * executable specifications of two `PreToolUse` hooks, and the Guard is the
 * HOOK — a zero-dependency `.cjs` that ships to a consumer's own repo and is
 * read there. Its declaration belongs in the artifact a consumer reads. So a
 * member's declaration may live in the member itself OR in a hook it names
 * through the `join(__dirname, '..', 'hooks', '<name>.cjs')` form, which is
 * how both of them locate the file they spawn. That is derived from the
 * member's source, not configured here.
 *
 * ## Two pinned censuses, so the blind spots are visible rather than argued
 *
 * A derivation with a declared blind spot is worth more than one that looks
 * total and is not. Both edges of this one are pinned as assertions that break
 * in either direction:
 *
 *   - {@link NOT_A_GUARD} — the glob members set A's filter excludes. Today
 *     exactly one, and the reason is measured rather than asserted.
 *   - {@link PARTIALLY_DECLARED_OUTSIDE} — files carrying an ADR-0052 marker
 *     in comment position while sitting outside the population, so a
 *     declaration in a notation this keeper does not read is listed rather
 *     than silently unheld.
 *
 * Pure test — zero production change. Path note: this spec lives at
 * `tools/wave/src/`, so `__dirname` is the engine's source root and
 * `../hooks` is the shipped hook directory.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = __dirname;
const HOOKS_DIR = join(__dirname, '..', 'hooks');

// ─── the declaration's three markers, as ADR-0052's declarations write them ──

/** The Subject line's marker. Its presence is what makes a comment block a declaration. */
const SUBJECT_MARKER = '**Subject.**';

/** The Unmodelled-set marker, verbatim — the phrase ADR-0052 quotes from `echo-guard.cjs`. */
const UNMODELLED_MARKER = '**Unmodelled set, named rather than assumed away.**';

/**
 * The Resolution-bias line, and the closed vocabulary of directions.
 *
 * `SPLIT` is a real third value, not a hedge: `loaded-corpus-guard.spec.ts`
 * has four rules, two of which block on an unreadable subject while two pass,
 * and that split is the RULING rather than an open finding — a single regex
 * over prose cannot tell "prose I do not recognize" from "prose with no
 * finding", so it never reaches a broken invariant it could abstain on. A
 * `SPLIT` therefore has to name both directions ({@link declarationDefects}
 * enforces it), which is what keeps the word from becoming a shrug.
 */
const BIAS_LINE = /\*\*Resolution bias\s+—\s+(BLOCKS|PASSES|SPLIT)\b/;

/** Any ADR-0052 marker at all, in the canonical bold notation — used only by the census. */
const ANY_MARKER = /\*\*(?:Subject\.|Resolution bias|Unmodelled set)/;

/** A numbered member inside a declaration's Unmodelled set: ` *  3. **…** …`. */
const UNMODELLED_MEMBER = /^[ \t]*\*[ \t]+\d+\.[ \t]/gm;

/** An import of something that reads outside this module — see set A's filter. */
const EXTERNAL_READER = /'node:fs(?:\/promises)?'|'node:child_process'|'fast-glob'/;

/** The `join(__dirname, '..', 'hooks', '<name>.cjs')` form both hook specs use. */
const HOOK_PATH_FORM = /join\(\s*__dirname\s*,\s*'\.\.'\s*,\s*'hooks'\s*,\s*'([^']+\.cjs)'\s*\)/g;

// ─── reading a declaration out of source text ────────────────────────────────

/**
 * Every comment in `source`: each `/* … *\/` block, plus each run of
 * consecutive `//` lines as one block.
 *
 * Comment position is the whole point of this function.
 * {@link SUBJECT_MARKER} appears in four shipped spec files as an ASSERTION
 * ARGUMENT — `conv12-guard.spec.ts`, `echo-guard.spec.ts`,
 * `shell-quoting-conformance.spec.ts` and this one each check some OTHER
 * artifact's declaration. A raw `includes` would read every one of them as a
 * declaration and certify four files that carry none.
 *
 * (This docstring names the marker through a `{@link}` rather than quoting
 * it, for the same reason: a quotation here would be a comment block carrying
 * a Subject line, which is a second declaration in the keeper, which the
 * keeper rejects. The rule is self-demonstrating.)
 */
function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  const blockComment = /\/\*[\s\S]*?\*\//g;
  for (const m of source.matchAll(blockComment)) blocks.push(m[0]);

  let run: string[] = [];
  for (const line of source.split('\n')) {
    if (/^[ \t]*\/\//.test(line)) {
      run.push(line);
    } else if (run.length > 0) {
      blocks.push(run.join('\n'));
      run = [];
    }
  }
  if (run.length > 0) blocks.push(run.join('\n'));
  return blocks;
}

/**
 * A comment block's prose, with the comment gutter stripped and the line
 * wrapping undone, so a phrase assertion is about the sentence rather than
 * about where the author happened to break the line.
 */
function prose(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/^[ \t]*(?:\/\*+|\*+\/?|\/\/)[ \t]?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The comment blocks of `source` that carry the Subject marker — a declaration each. */
function declarationBlocks(source: string): string[] {
  return commentBlocks(source).filter((b) => b.includes(SUBJECT_MARKER));
}

/**
 * Why `source` does not carry one complete ADR-0052 declaration, or `[]` when
 * it does.
 *
 * Deliberately a pure function over text, and deliberately the ONLY place a
 * verdict is formed: it is what lets the red cases below be shown against
 * synthetic sources and against a real file with its declaration cut out,
 * rather than asserted in prose.
 */
function declarationDefects(source: string): string[] {
  const blocks = declarationBlocks(source);
  if (blocks.length === 0) {
    return [`no declaration: no comment block carries ${SUBJECT_MARKER}`];
  }
  if (blocks.length > 1) {
    return [
      `${blocks.length} declarations: two Subject lines are two answers to one question`,
    ];
  }

  const declaration = blocks[0];
  const defects: string[] = [];

  const bias = BIAS_LINE.exec(declaration);
  if (bias === null) {
    defects.push(
      'no resolution bias: the declaration states no ' +
        '**Resolution bias — BLOCKS|PASSES|SPLIT**',
    );
  } else if (bias[1] === 'SPLIT' && !(/\bBLOCK/.test(declaration) && /\bPASS/.test(declaration))) {
    defects.push('SPLIT resolution bias that names only one direction');
  }

  if (!declaration.includes(UNMODELLED_MARKER)) {
    defects.push(`no unmodelled set: the declaration carries no ${UNMODELLED_MARKER}`);
    return defects;
  }

  const tail = declaration.slice(declaration.indexOf(UNMODELLED_MARKER) + UNMODELLED_MARKER.length);
  const members = tail.match(UNMODELLED_MEMBER) ?? [];
  if (members.length === 0) {
    defects.push('empty unmodelled set: the marker is present and names no member');
  }

  return defects;
}

// ─── deriving the population ─────────────────────────────────────────────────

/** Every `.ts` / `.cjs` file under `dir`, recursively, as absolute paths. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFilesUnder(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.cjs')) out.push(full);
  }
  return out;
}

/** Set A, before the filter: every `src/*-guard.spec.ts`, read off the directory. */
function namedGuardSpecs(): string[] {
  return readdirSync(SRC_DIR)
    .filter((e) => e.endsWith('-guard.spec.ts'))
    .sort()
    .map((e) => join(SRC_DIR, e));
}

/** Set A's filter: does this source reach any text outside itself? */
function reachesExternalText(source: string): boolean {
  return EXTERNAL_READER.test(source);
}

/** The hooks a member names through {@link HOOK_PATH_FORM} and that exist on disk. */
function delegatedHooks(source: string): string[] {
  const named = new Set<string>();
  for (const m of source.matchAll(HOOK_PATH_FORM)) named.add(m[1]);
  return [...named]
    .map((name) => join(HOOKS_DIR, name))
    .filter((p) => existsSync(p))
    .sort();
}

interface Member {
  /** Absolute path of the population member. */
  readonly file: string;
  /** Which derived set put it here — the first one that did, in A, B, C order. */
  readonly via: 'named-guard-spec' | 'the-keeper-itself' | 'already-declared';
  /** The files allowed to carry this member's declaration: itself, plus any hook it spawns. */
  readonly sources: readonly string[];
}

/** The union of sets A, B and C, de-duplicated, with each member's declaration sources. */
function population(): Member[] {
  const byFile = new Map<string, Member>();
  const add = (file: string, via: Member['via']): void => {
    if (byFile.has(file)) return;
    const source = readFileSync(file, 'utf8');
    byFile.set(file, { file, via, sources: [file, ...delegatedHooks(source)] });
  };

  for (const file of namedGuardSpecs()) {
    if (reachesExternalText(readFileSync(file, 'utf8'))) add(file, 'named-guard-spec');
  }
  add(__filename, 'the-keeper-itself');
  for (const file of [...sourceFilesUnder(SRC_DIR), ...sourceFilesUnder(HOOKS_DIR)]) {
    if (declarationBlocks(readFileSync(file, 'utf8')).length > 0) add(file, 'already-declared');
  }

  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Repo-relative-ish label for a member, so a failure message names a path a reader can open. */
function label(file: string): string {
  return relative(join(SRC_DIR, '..', '..', '..'), file);
}

// ─── the two pinned censuses ─────────────────────────────────────────────────

/**
 * The `src/*-guard.spec.ts` files set A's filter excludes, pinned so the
 * exclusion is a visible decision rather than a silent narrowing.
 *
 * `ff-guard.spec.ts` is the whole list today and it is not a Guard in
 * ADR-0052's sense. It is the fixture suite for `isFastForward` — a pure
 * function whose git side effects are injected through the `FfProbe` seam, so
 * the spec imports `vitest` and `./ff-guard` and nothing else. "Guard" there
 * is the domain noun for a refusal to push a non-fast-forward tip, not a
 * scanner over a corpus: there is no text it reads, therefore no shape it can
 * fail to parse, therefore no direction to declare and no unmodelled
 * constructs to name. Give it a `readFileSync` and this pin goes red and it
 * joins the population, which is the self-policing half of the decision.
 */
const NOT_A_GUARD = ['ff-guard.spec.ts'];

/**
 * Files carrying an ADR-0052 marker in comment position while sitting outside
 * the population — the tripwire over set C's admitted circularity.
 *
 * `verb-contract-drift.spec.ts` is the whole list today. It declares
 * `**Resolution bias (ADR-0052): fail-closed.**` in a notation of its own, with
 * no Subject line and with its Unmodelled set asserted empty in running prose,
 * so set C's Subject marker does not reach it and this keeper holds nothing
 * there. Normalising it to the canonical three-part form would move it into
 * the population and out of this list; that is a separate change to a file
 * outside this row's scope, and until it happens the omission is listed here
 * rather than unrecorded.
 */
const PARTIALLY_DECLARED_OUTSIDE = ['verb-contract-drift.spec.ts'];

// ─── Guard declaration (ADR-0052) ────────────────────────────────────────────

/**
 * **Subject.** Source text, read as text: every `.ts` and `.cjs` file under
 * `tools/wave/src/` and `tools/wave/hooks/`, scanned for comment blocks, and
 * within a comment block for the three canonical declaration markers and the
 * numbered members of an Unmodelled set. Nothing here executes a Guard, opens
 * its corpus, or judges whether what a declaration SAYS is true — only that
 * the declaration is there, is single, states a direction from the closed
 * vocabulary, and names at least one thing it does not model.
 *
 * **Resolution bias — BLOCKS.** Every shape this reader cannot place fails.
 * A file in the population with no declaration block fails; two declaration
 * blocks fail rather than the first one winning; a declaration whose bias word
 * is absent or outside {BLOCKS, PASSES, SPLIT} fails rather than being read as
 * "some bias is stated"; an Unmodelled-set marker with no numbered member
 * under it fails rather than counting as a declared-empty set. `readFileSync`
 * and `statSync` throw on a file the walk cannot read, and the walk itself
 * carries floor assertions, so a population that emptied — the other silent
 * green — goes red too.
 *
 * The direction is chosen for what a declaration IS. It is a residual: prose
 * left behind so a later reader can trust a Guard's boundary without
 * re-deriving it. An unreadable or absent one is indistinguishable, to that
 * reader, from a Guard with no boundary — and the cost of blocking wrongly is
 * a maintainer at `npm test` with the file and the missing part named, while
 * the cost of passing wrongly is the state this file was written to end. That
 * is the opposite of the two rules in `loaded-corpus-guard.spec.ts` that pass
 * on prose they do not recognize, and the difference is the instrument: this
 * keeper parses a structured block and can find it absent, doubled or
 * incomplete, so it has an invariant to break (ADR-0052 decision 3). A single
 * regex over free prose has none, which is why that guard's bias is SPLIT and
 * why the split is its resolution rather than a finding.
 *
 * **Unmodelled set, named rather than assumed away.**
 *
 *  1. **Total deletion of a declaration outside sets A and B.** Set C's
 *     membership is the Subject marker itself, so deleting the whole
 *     declaration deletes the membership and this keeper says nothing. Set A
 *     (the guard glob) and set B (this file) are the only non-circular
 *     halves, and today they reach every declaration bearer except the two
 *     hooks, which are reached a second way — through the
 *     `join(__dirname, '..', 'hooks', …)` delegation of the two specs that
 *     spawn them. A declaration added to a file matching neither is protected
 *     against gutting and not against removal.
 *  2. **A Guard that reads its corpus through a helper module.** Set A's
 *     filter looks for a direct `node:fs` / `node:child_process` /
 *     `fast-glob` import. A guard spec that imported a loader from a sibling
 *     module instead would read as a hermetic fixture suite and be excluded,
 *     silently. No shipped guard does this today — measured, not assumed:
 *     eleven of the twelve glob members import a reader directly.
 *  3. **Declarations in another notation.** Only the canonical bold markers
 *     are read. `verb-contract-drift.spec.ts`'s
 *     `**Resolution bias (ADR-0052): fail-closed.**` and
 *     `worktree-cleanup.ts`'s all-caps `RESOLUTION BIAS —` block both state a
 *     direction and neither is held here; the first is pinned in
 *     {@link PARTIALLY_DECLARED_OUTSIDE}, the second is invisible even to
 *     that census because it carries no `**` marker at all.
 *  4. **Comment extraction is lexical, not a parser.**
 *     {@link commentBlocks} matches `/*` … `*\/` and runs of `//` lines. A
 *     `/*` inside a string or regex literal would open a block that is not
 *     one, and a marker inside a template literal laid out to start its line
 *     with `*` would read as a comment. Neither occurs in the population
 *     today; both would mis-read it if they did.
 *  5. **Whether a declaration is TRUE.** The whole predicate is presence and
 *     shape. A Subject that describes a corpus the Guard does not read, a
 *     bias word that contradicts the code beneath it, an Unmodelled set that
 *     omits its largest member — all pass. `shell-quoting-conformance.spec.ts`
 *     is the one place a declared bias is checked against observed behaviour,
 *     and it covers the two hooks only.
 *  6. **Declaration bearers outside `src/` and `hooks/`.** The walk stops at
 *     those two directories. A Guard shipped from `driver/`, `bin/` or a
 *     consumer scaffold is not in any of the three sets.
 */

// ─── the population is derived, and the derivation is visible ────────────────

// The keeper prints the population it derived on every run, so a reader sees
// WHICH files it holds and by which set, without opening this file — the same
// reason `loaded-corpus-guard.spec.ts` prints its two sums. A population that
// moved under the check is then visible in the run that first noticed.
{
  const counted = population();
  const tally = (via: Member['via']): number => counted.filter((m) => m.via === via).length;
  console.log(
    `[guard-declaration-keeper] ${counted.length} declaration bearers held: ` +
      `${tally('named-guard-spec')} named guard specs that read external text, ` +
      `${tally('the-keeper-itself')} keeper, ` +
      `${tally('already-declared')} already-declared elsewhere — ` +
      `excluded from the glob: ${NOT_A_GUARD.join(', ') || 'none'}; ` +
      `declared in another notation, unheld: ${PARTIALLY_DECLARED_OUTSIDE.join(', ') || 'none'}`,
  );
}

describe('guard-declaration-keeper: the population is derived, not listed', () => {
  const members = population();

  it('is not empty, and is not a handful — the floor that refuses a population that emptied', () => {
    // A derivation bug that returned `[]` would make every assertion below
    // vacuously green. This is the same silent-green refusal the loaded-corpus
    // guard's MIN_* floors make.
    expect(members.length).toBeGreaterThanOrEqual(12);
  });

  it('draws from all three sets, so neither circular nor glob-only', () => {
    const vias = new Set(members.map((m) => m.via));
    expect(vias.has('named-guard-spec')).toBe(true);
    expect(vias.has('the-keeper-itself')).toBe(true);
    expect(vias.has('already-declared')).toBe(true);
  });

  it('set A reaches every named guard spec that reads external text', () => {
    const reaching = namedGuardSpecs()
      .filter((f) => reachesExternalText(readFileSync(f, 'utf8')))
      .map((f) => basename(f));
    // Measured at this anchor: twelve files match the glob and eleven reach
    // external text. Neither number is pinned here — the SET DIFFERENCE is,
    // in the census below, which is the assertion that has to be re-decided
    // when the population moves.
    expect(reaching.length).toBeGreaterThan(0);
    const inPopulation = members.map((m) => basename(m.file));
    for (const spec of reaching) expect(inPopulation).toContain(spec);
  });

  it('the glob members excluded by that filter are exactly the pinned census', () => {
    const excluded = namedGuardSpecs()
      .filter((f) => !reachesExternalText(readFileSync(f, 'utf8')))
      .map((f) => basename(f))
      .sort();
    expect(excluded).toEqual([...NOT_A_GUARD].sort());
  });

  it('and the excluded one is excluded by MEASUREMENT — it reads nothing outside itself', () => {
    for (const name of NOT_A_GUARD) {
      const source = readFileSync(join(SRC_DIR, name), 'utf8');
      expect(reachesExternalText(source), `${name} now reaches external text`).toBe(false);
    }
  });

  it('set B holds: the keeper is inside its own population', () => {
    const self = members.find((m) => m.file === __filename);
    expect(self, 'the keeper is not policing itself').toBeDefined();
  });

  it('set C reaches both shipped hooks, whose declaration is the artifact a consumer reads', () => {
    const files = members.map((m) => basename(m.file));
    expect(files).toContain('conv12-guard.cjs');
    expect(files).toContain('echo-guard.cjs');
  });

  it('the two hook SPECS delegate to the hook they spawn, rather than declaring twice', () => {
    for (const name of ['conv12-guard.spec.ts', 'echo-guard.spec.ts']) {
      const member = members.find((m) => basename(m.file) === name);
      expect(member, `${name} is not in the population`).toBeDefined();
      expect(member?.sources.map((s) => basename(s))).toContain(name.replace('.spec.ts', '.cjs'));
      // …and the delegation is load-bearing: the spec itself carries none.
      expect(declarationBlocks(readFileSync(member!.file, 'utf8'))).toHaveLength(0);
    }
  });

  it('files carrying a marker in another notation, outside the population, are the pinned census', () => {
    const inPopulation = new Set(population().map((m) => m.file));
    const strays = [...sourceFilesUnder(SRC_DIR), ...sourceFilesUnder(HOOKS_DIR)]
      .filter((f) => !inPopulation.has(f))
      .filter((f) => commentBlocks(readFileSync(f, 'utf8')).some((b) => ANY_MARKER.test(b)))
      .map((f) => basename(f))
      .sort();
    expect(strays).toEqual([...PARTIALLY_DECLARED_OUTSIDE].sort());
  });
});

// ─── every member carries a complete declaration ─────────────────────────────

describe('guard-declaration-keeper: every Guard declares its subject, bias and unmodelled set', () => {
  for (const member of population()) {
    it(`${label(member.file)} carries a complete declaration`, () => {
      const readings = member.sources.map((source) => ({
        source,
        defects: declarationDefects(readFileSync(source, 'utf8')),
      }));
      const complete = readings.find((r) => r.defects.length === 0);
      expect(
        complete,
        `no complete ADR-0052 declaration for ${label(member.file)} (via ${member.via}). ` +
          readings
            .map((r) => `${label(r.source)}: ${r.defects.join('; ')}`)
            .join(' | '),
      ).toBeDefined();
    });
  }

  it('every declared bias comes from the closed vocabulary', () => {
    const biases = new Set<string>();
    for (const member of population()) {
      for (const source of member.sources) {
        const block = declarationBlocks(readFileSync(source, 'utf8'))[0];
        const m = block === undefined ? null : BIAS_LINE.exec(block);
        if (m !== null) biases.add(m[1]);
      }
    }
    expect(biases.size).toBeGreaterThan(1);
    for (const bias of biases) expect(['BLOCKS', 'PASSES', 'SPLIT']).toContain(bias);
  });

  it("the corpus guard's split is declared as the resolution, not as an open finding", () => {
    // ADR-0052's ruling, carried where a reader of that guard will meet it:
    // two of its four rules block on an unreadable subject and two pass, and
    // that is correct rather than pending, because a single regex over prose
    // reaches no broken invariant it could abstain on.
    const source = readFileSync(join(SRC_DIR, 'loaded-corpus-guard.spec.ts'), 'utf8');
    const block = declarationBlocks(source)[0];
    expect(block).toBeDefined();
    expect(BIAS_LINE.exec(block)?.[1]).toBe('SPLIT');
    expect(prose(block)).toContain('the split is the resolution');
    expect(prose(block)).not.toContain('filed as a finding instead');
    expect(declarationDefects(source)).toEqual([]);
  });

  it('the keeper declares a BLOCKING bias, in the same form it enforces', () => {
    const source = readFileSync(__filename, 'utf8');
    const block = declarationBlocks(source)[0];
    expect(BIAS_LINE.exec(block)?.[1]).toBe('BLOCKS');
    expect(declarationDefects(source)).toEqual([]);
  });
});

// ─── the keeper's own failing state, shown rather than asserted ──────────────

/**
 * A declaration built from parts, so each red case below differs from the
 * green control in exactly one way.
 *
 * Assembled line by line rather than written as one template literal: the
 * markers have to sit at the start of a comment line to be read at all, and a
 * template literal laid out that way inside this file would itself parse as a
 * comment block carrying a Subject — a second declaration in the keeper, which
 * the keeper rejects. Building the strings from array elements keeps every
 * source line here in code position.
 */
function declarationFixture(parts: {
  subject?: boolean;
  bias?: string;
  unmodelled?: boolean;
  members?: number;
}): string {
  const lines = ['/**'];
  if (parts.subject !== false) lines.push(` * ${SUBJECT_MARKER} One text, read as text.`);
  if (parts.bias !== undefined) lines.push(` * **Resolution bias — ${parts.bias}.** Because.`);
  if (parts.unmodelled !== false) lines.push(` * ${UNMODELLED_MARKER}`);
  for (let i = 1; i <= (parts.members ?? 1); i++) lines.push(` *  ${i}. **A thing** not read.`);
  lines.push(' */');
  return lines.join('\n');
}

describe('guard-declaration-keeper: the keeper goes red, and here is each way', () => {
  it('the control is green — a complete declaration has no defects', () => {
    expect(declarationDefects(declarationFixture({ bias: 'BLOCKS' }))).toEqual([]);
  });

  it('no declaration at all → red', () => {
    const defects = declarationDefects('export const x = 1;\n');
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain('no declaration');
  });

  it('a Subject with no resolution bias → red', () => {
    const defects = declarationDefects(declarationFixture({ bias: undefined }));
    expect(defects).toContain(
      'no resolution bias: the declaration states no **Resolution bias — BLOCKS|PASSES|SPLIT**',
    );
  });

  it('an EMPTY unmodelled set → red, and the marker alone does not buy a pass', () => {
    const defects = declarationDefects(declarationFixture({ bias: 'BLOCKS', members: 0 }));
    expect(defects).toContain('empty unmodelled set: the marker is present and names no member');
  });

  it('no unmodelled set at all → red', () => {
    const defects = declarationDefects(
      declarationFixture({ bias: 'BLOCKS', unmodelled: false, members: 0 }),
    );
    expect(defects[0]).toContain('no unmodelled set');
  });

  it('a bias word outside the closed vocabulary → red, not read as "some bias is stated"', () => {
    const defects = declarationDefects(declarationFixture({ bias: 'SOMETIMES' }));
    expect(defects[0]).toContain('no resolution bias');
  });

  it('a SPLIT bias naming only one direction → red', () => {
    const defects = declarationDefects(declarationFixture({ bias: 'SPLIT' }));
    expect(defects).toContain('SPLIT resolution bias that names only one direction');
  });

  it('two declarations in one file → red, rather than the first one winning', () => {
    const doubled = `${declarationFixture({ bias: 'BLOCKS' })}\n\n${declarationFixture({
      bias: 'PASSES',
    })}`;
    expect(declarationDefects(doubled)[0]).toContain('2 declarations');
  });

  it('a marker in ASSERTION position is not a declaration', () => {
    // The shape that would make this keeper certify four files that carry
    // nothing: a `toContain` whose ARGUMENT is the marker. Written below
    // rather than quoted here, because a quotation in this comment would be a
    // second declaration in the keeper — the rule demonstrating itself again.
    const assertionOnly = [
      "it('declares its Subject', () => {",
      `  expect(source).toContain('${SUBJECT_MARKER}');`,
      `  expect(source).toContain('${UNMODELLED_MARKER}');`,
      '});',
    ].join('\n');
    expect(declarationDefects(assertionOnly)[0]).toContain('no declaration');
  });
});

describe('guard-declaration-keeper: deleting a real declaration makes it fail', () => {
  /** Cut the declaration block out of a real file's source, leaving the rest intact. */
  function withDeclarationDeleted(source: string): string {
    const block = declarationBlocks(source)[0];
    return source.replace(block, '');
  }

  for (const name of ['skill-reference-guard.spec.ts', 'loaded-corpus-guard.spec.ts']) {
    it(`${name}: green as it ships, red with its declaration cut out`, () => {
      const source = readFileSync(join(SRC_DIR, name), 'utf8');
      expect(declarationDefects(source), `${name} does not ship green`).toEqual([]);

      const gutted = withDeclarationDeleted(source);
      expect(gutted.length).toBeLessThan(source.length);
      expect(declarationDefects(gutted)[0]).toContain('no declaration');
    });
  }

  it('conv12-guard.cjs: cutting the HOOK declaration reddens the spec that delegates to it', () => {
    // The delegation is the one place a member's declaration lives in another
    // file, so it is the one place a deletion could land where nothing looks.
    const specPath = join(SRC_DIR, 'conv12-guard.spec.ts');
    const hookPath = join(HOOKS_DIR, 'conv12-guard.cjs');
    const spec = readFileSync(specPath, 'utf8');
    const hook = readFileSync(hookPath, 'utf8');

    expect(delegatedHooks(spec)).toEqual([hookPath]);
    expect(declarationDefects(hook)).toEqual([]);

    const gutted = withDeclarationDeleted(hook);
    const sources = [spec, gutted];
    expect(sources.some((s) => declarationDefects(s).length === 0)).toBe(false);
  });

  it('a partial edit is caught too — deleting only the bias line', () => {
    const source = readFileSync(join(SRC_DIR, 'no-gh-shellout-guard.spec.ts'), 'utf8');
    expect(declarationDefects(source)).toEqual([]);
    const biasLine = /^[ \t]*\*[ \t]*\*\*Resolution bias\s+—\s+(?:BLOCKS|PASSES|SPLIT)\b.*$/m;
    expect(biasLine.test(source)).toBe(true);
    expect(declarationDefects(source.replace(biasLine, ' *'))[0]).toContain('no resolution bias');
  });
});
