/**
 * verb-contract-drift.spec.ts — "no flag without a declaration", as structure
 * rather than prose (ADR-0051 decision 2, last sentence).
 *
 * Three things are held here, and each one closes a way the contract could
 * quietly stop describing the engine:
 *
 *   1. **Source side.** Every `'--x'` STRING LITERAL in the engine's CLI sources
 *      appears in the contract of a verb that module runs — or on the
 *      git-subprocess allowlist, where the literal is an argument to `git`, not
 *      a flag of a flotilla verb. A module that carries flag literals and is on
 *      NEITHER list fails: that is the "somebody added a verb and forgot the
 *      contract" case, and it is the one a per-verb spec cannot see.
 *   2. **Value types.** No canonical spelling carries two value TYPES across the
 *      aggregate (decision 5's second half). The measured polymorphism this
 *      forbids was `--verdict` — a file PATH on route-tuple, an ENUM on
 *      route-verdict, in adjacent usage lines — and it is why route-tuple's path
 *      flag is now `--verdict-file`.
 *   3. **Aliases.** Within one verb, every alias maps to exactly one canonical,
 *      and no alias is also a canonical of that same verb. `--dir` resolving to
 *      `--reports-dir` on one write verb and `--verdicts-dir` on the other is
 *      legal and intended — it is only possible BECAUSE a contract is per verb —
 *      so the uniqueness is asserted per verb, never globally.
 *
 * Same family as `barrel-drift.spec.ts` (every module export is root-reachable
 * or explicitly allowlisted, in both directions) and
 * `allowlist-scaffold-guard.spec.ts`: a drift spec that ENUMERATES a real
 * surface and asserts membership, rather than restating a hand-maintained list.
 *
 * ## Why a tokenizer rather than a grep
 *
 * A bare `grep -o "'--[a-z-]*'"` reads DOCBLOCKS too, and this repo's docblocks
 * quote flag spellings constantly — including, in `verb-contract.ts` itself, the
 * literal `'--x'` from the sentence describing this very check. A comment is not
 * a declaration and not a use, so the scan below walks the source tracking
 * string, template, line-comment and block-comment state, and collects only
 * quoted STRING tokens from real code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import fastGlob from 'fast-glob';
import { main, verbContracts } from './cli';
import {
  declaredFlagTokens,
  defineVerb,
  renderInvocations,
  renderUsageSection,
  ROUTER_GLOBAL_FLAGS,
  type VerbContract,
  type VerbContractDeclaration,
} from './verb-contract';

const SRC_DIR = __dirname;

// ─── The scanner ─────────────────────────────────────────────────────────────

const FLAG_SHAPE = /^--[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Every `'--x'` / `"--x"` string literal in `source`, from CODE only — comments
 * and template literals excluded. Exported shape: a de-duplicated, sorted list.
 */
export function flagLiteralsIn(source: string): string[] {
  const found = new Set<string>();
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // line comment
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // template literal — skipped wholesale; a `--flag` inside one is prose in a
    // rendered usage line, never a parser's idea of a spelling.
    if (ch === '`') {
      i++;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        value += source[i];
        i++;
      }
      i++;
      if (FLAG_SHAPE.test(value)) found.add(value);
      continue;
    }
    i++;
  }
  return [...found].sort();
}

// ─── The map: which module runs which verbs ──────────────────────────────────

const AGGREGATE = verbContracts();

/** Every aggregate key under one verb-group prefix (`spine `, `issue-store `, …). */
function opsOf(prefix: string): string[] {
  return Object.keys(AGGREGATE).filter((v) => v.startsWith(`${prefix} `));
}

/**
 * Which verbs' contracts a CLI module's flag literals may draw on.
 *
 * `verb-contract.ts` carries no verb's contract any more — the three that were
 * once a stated exception here (`compose-driver`, `route-tuple`, `close-row`,
 * ADR-0051 row 1's central displaced-contracts map) moved beside their own
 * runners in the mechanical follow-up row that deleted that exception. Its
 * entry stays on the map because it still carries the two router-global flag
 * literals (`--json`, `--help`), which every module's `declared` set already
 * includes regardless of its verb list — so an empty list is enough.
 */
const MODULE_VERBS: Readonly<Record<string, readonly string[]>> = {
  'cli.ts': [
    'dor',
    'files-drift',
    'merge-order',
    'closed-by',
    'detect-host',
    'worktree-cleanup',
    'verdict-acked',
    'render-verdict',
    'version',
    'catalog',
  ],
  'cli-store.ts': ['store-preflight'],
  'cli-utils.ts': [],
  'host-pr-cli.ts': opsOf('host-pr'),
  'issue-store-cli.ts': opsOf('issue-store'),
  'spine-cli.ts': opsOf('spine'),
  'route-cli.ts': [
    'route-verdict',
    'route-outcome',
    'validate-report',
    'validate-verdict',
    'write-report',
    'write-verdict',
  ],
  'resume-cli.ts': ['resume'],
  'cross-wave-cli.ts': ['cross-wave'],
  'conflict-map-cli.ts': ['conflict-map'],
  'config-cli.ts': opsOf('config'),
  'credential-probe-cli.ts': ['credential-probe'],
  'compose-driver.ts': ['compose-driver'],
  'route-tuple.ts': ['route-tuple'],
  'close-row.ts': ['close-row'],
  'verb-contract.ts': [],
};

/**
 * Flag literals that are arguments to a SUBPROCESS — `git`, almost always —
 * rather than flags of a flotilla verb. Per file, so an entry cannot excuse a
 * literal in a module it was never measured against.
 *
 * A module listed ONLY here declares no verb at all: every flag literal it
 * carries must be on its own list.
 */
const GIT_SUBPROCESS_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'compose-driver.ts': ['--abbrev-ref', '--verify'],
  'dor-gate.ts': ['--git-dir', '--quiet', '--short', '--verify'],
  'ff-guard.ts': ['--count', '--is-ancestor'],
  'files-drift.ts': ['--name-only'],
  'merge-order.ts': ['--heads', '--is-ancestor', '--list'],
  'worktree-cleanup.ts': [
    '--exit-code',
    '--force',
    '--heads',
    '--is-ancestor',
    '--porcelain',
    '--quiet',
    '--short',
    '--show-toplevel',
  ],
  'adapters/markdown-fs-store.ts': ['--error-unmatch'],
  // `--version` is the ROUTER's leading-token alias for the `version` VERB
  // (ADR-0032), not a flag of any verb: `flotilla-engine --version` is spelled
  // like a flag and resolved like a subcommand. It is allowlisted here rather
  // than declared, because declaring it on `version` would say the verb takes a
  // `--version` flag, which it does not.
  'cli.ts': ['--version'],
};

function sourceOf(file: string): string {
  return readFileSync(join(SRC_DIR, file), 'utf-8');
}

// ─── 1. Source side ──────────────────────────────────────────────────────────

describe('verb-contract drift — every flag literal in the CLI sources is declared', () => {
  it('names a spelling the contract of a verb that module runs accepts', () => {
    const violations: string[] = [];
    for (const [file, verbs] of Object.entries(MODULE_VERBS)) {
      const declared = new Set<string>();
      for (const verb of verbs) {
        const contract = AGGREGATE[verb];
        expect(contract, `${file} maps to an unknown verb "${verb}"`).toBeDefined();
        for (const token of declaredFlagTokens(contract)) declared.add(token);
      }
      for (const g of ROUTER_GLOBAL_FLAGS) declared.add(g.canonical);
      for (const allowed of GIT_SUBPROCESS_FLAGS[file] ?? []) declared.add(allowed);

      for (const literal of flagLiteralsIn(sourceOf(file))) {
        if (!declared.has(literal)) {
          violations.push(
            `${file} — ${literal} is in no contract of the verbs this module runs ` +
              `(${verbs.join(', ') || 'none'}) and is not on its git-subprocess allowlist`,
          );
        }
      }
    }
    expect(violations.join('\n')).toBe('');
  });

  it('accounts for EVERY engine source: a module with flag literals is mapped or allowlisted', async () => {
    const files = await fastGlob('**/*.ts', {
      cwd: SRC_DIR,
      ignore: ['**/*.spec.ts', '__fixtures__/**'],
    });
    const unaccounted: string[] = [];
    for (const file of files) {
      const rel = relative('.', file);
      if (rel in MODULE_VERBS || rel in GIT_SUBPROCESS_FLAGS) continue;
      const literals = flagLiteralsIn(sourceOf(rel));
      if (literals.length > 0) {
        unaccounted.push(`${rel} — ${literals.join(', ')}`);
      }
    }
    expect(unaccounted.join('\n')).toBe('');
  });

  it('every verb in the aggregate is claimed by at least one module', () => {
    const claimed = new Set(Object.values(MODULE_VERBS).flat());
    const orphans = Object.keys(AGGREGATE).filter((v) => !claimed.has(v));
    expect(orphans.join(', ')).toBe('');
  });
});

// ─── 2. Value types ──────────────────────────────────────────────────────────

describe('verb-contract drift — one canonical spelling, one value type', () => {
  it('no canonical spelling carries two value types across the aggregate', () => {
    const seen = new Map<string, { type: string; verb: string }>();
    const conflicts: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      for (const f of contract.flags) {
        const prior = seen.get(f.canonical);
        if (prior === undefined) {
          seen.set(f.canonical, { type: f.valueType, verb });
          continue;
        }
        if (prior.type !== f.valueType) {
          conflicts.push(
            `${f.canonical} is "${prior.type}" on ${prior.verb} and "${f.valueType}" on ${verb}`,
          );
        }
      }
    }
    expect(conflicts.join('\n')).toBe('');
  });

  it('every flag declares a value KIND consistent with its value type', () => {
    const bad: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      for (const f of contract.flags) {
        if (f.value === 'none' && f.valueType !== 'none') {
          bad.push(`${verb} ${f.canonical}: a switch cannot have value type "${f.valueType}"`);
        }
        if (f.value !== 'none' && f.valueType === 'none') {
          bad.push(`${verb} ${f.canonical}: a value-taking flag needs a value type`);
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });
});

// ─── 3. Aliases ──────────────────────────────────────────────────────────────

describe('verb-contract drift — every alias maps to exactly one canonical, per verb', () => {
  it('no alias is claimed twice within one verb, and none is also a canonical there', () => {
    const problems: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const canonicals = new Set(contract.flags.map((f) => f.canonical));
      const aliasOwner = new Map<string, string>();
      for (const f of contract.flags) {
        for (const alias of f.aliases ?? []) {
          if (canonicals.has(alias)) {
            problems.push(`${verb}: ${alias} is both an alias of ${f.canonical} and a canonical`);
          }
          const prior = aliasOwner.get(alias);
          if (prior !== undefined) {
            problems.push(`${verb}: ${alias} is an alias of both ${prior} and ${f.canonical}`);
          }
          aliasOwner.set(alias, f.canonical);
        }
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('no canonical spelling is declared twice within one verb', () => {
    const problems: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const seen = new Set<string>();
      for (const f of contract.flags) {
        if (seen.has(f.canonical)) problems.push(`${verb}: ${f.canonical} declared twice`);
        seen.add(f.canonical);
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('a verb never re-declares a router-global flag as its own', () => {
    // `--json` and `--help` are accepted everywhere by the machinery; a verb
    // that also declared one would give it a second, verb-local meaning — the
    // exact ambiguity decision 7 settles by making them router-global.
    const globals = new Set(ROUTER_GLOBAL_FLAGS.map((f) => f.canonical));
    const problems: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      for (const f of contract.flags) {
        if (globals.has(f.canonical)) problems.push(`${verb}: ${f.canonical} is router-global`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });
});

// ─── Coverage: every verb and every op declares a contract ───────────────────

describe('verb-contract drift — the aggregate covers the whole engine surface', () => {
  it('every contract states its four required parts', () => {
    const incomplete: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const c = contract as VerbContract;
      if (c.verb !== verb) incomplete.push(`${verb}: names itself "${c.verb}"`);
      if (!Array.isArray(c.flags)) incomplete.push(`${verb}: no flags list`);
      if (c.positionals === undefined) incomplete.push(`${verb}: no positional arity`);
      if (c.output === undefined) incomplete.push(`${verb}: no output class`);
      if (!Array.isArray(c.usage) || c.usage.length === 0) {
        incomplete.push(`${verb}: no usage lines`);
      }
    }
    expect(incomplete.join('\n')).toBe('');
  });

  it('EVERY subcommand the router advertises resolves to a contract', () => {
    // The roster is read back AT RUNTIME off the router's own unknown-subcommand
    // message, never transcribed — the same discipline cli.spec.ts's FOR-11
    // guard uses, and for the same reason: a hand-copied list is a second
    // vocabulary that can disagree with the dispatch.
    const captured: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      main(['definitely-not-a-subcommand']);
    } finally {
      process.stderr.write = write;
    }
    const match = /available: ([^\n]+)/.exec(captured.join(''));
    expect(match, 'the router no longer prints its `available:` roster').not.toBeNull();
    const roster = (match as RegExpExecArray)[1].split(', ').map((s) => s.trim());
    expect(roster.length).toBeGreaterThan(20);

    const keys = Object.keys(AGGREGATE);
    const missing = roster.filter(
      (verb) => AGGREGATE[verb] === undefined && !keys.some((k) => k.startsWith(`${verb} `)),
    );
    expect(missing.join(', ')).toBe('');
  });

  it('states the surface this row measured — 28 top-level verbs, 45 group ops', () => {
    // ADR-0051's own table measured 27 top-level verbs and 39 group ops at
    // `53261e0`. Both halves are re-measured here rather than trusted: the
    // top-level count has grown to 28 because `catalog` — decision 2's fourth
    // reader, which 2.7.0 shipped without — joined it, and the op count has
    // grown to 45 because `issue-store` gained five ops since that commit and
    // `config validate` is counted as the group op it structurally is. The duty
    // was never the number — it is that EVERY verb and EVERY op declares a
    // contract, which the roster test above holds — but the number is stated so
    // a later reader can see which way it moved.
    const keys = Object.keys(AGGREGATE);
    const groups = ['host-pr', 'issue-store', 'spine', 'config'];
    const groupOps = keys.filter((k) => groups.some((g) => k.startsWith(`${g} `)));
    const topLevel = keys.filter((k) => !groupOps.includes(k));
    expect(topLevel.length + groups.length).toBe(28);
    expect(groupOps.length).toBe(45);
    expect(opsOf('host-pr').length).toBe(5);
    expect(opsOf('issue-store').length).toBe(26);
    expect(opsOf('spine').length).toBe(13);
    expect(opsOf('config').length).toBe(1);
  });

  it('`catalog` is ONE contract on this map, declared like every other verb', () => {
    // The emitter of the aggregate is itself IN the aggregate, once. Stated
    // here because the failure it forbids is specific to a verb that prints
    // the contracts: a second entry — a group op, a module claiming it twice —
    // would make the Catalog contain two answers to "what does `catalog`
    // accept", and the emitted JSON is where a consumer would read them.
    const keys = Object.keys(AGGREGATE).filter((k) => k === 'catalog' || k.endsWith(' catalog'));
    expect(keys).toEqual(['catalog']);
    const claims = Object.entries(MODULE_VERBS).filter(([, verbs]) => verbs.includes('catalog'));
    expect(claims.map(([file]) => file)).toEqual(['cli.ts']);
    // …and it is a contract of the same shape as every other, not a special
    // case the coverage checks above would have to exempt.
    const contract = AGGREGATE.catalog;
    expect(contract.verb).toBe('catalog');
    expect(contract.output).toBe('json');
    expect(contract.positionals).toEqual({ kind: 'fixed', count: 0 });
    expect(contract.flags).toEqual([]);
    expect(contract.usage.length).toBeGreaterThan(0);
  });
});

// ─── 4. Relationships: every alternation maps to a declaration, and back ────
//
// Issue #856 moved the flag RELATIONSHIPS onto the contract — a `groups`
// declaration (exactly-one / at-most-one, over branches that may mix a flag
// with a positional) and a second `forms` entry where a verb has two call
// shapes — and renders them into the signature line. That closes the loss row
// 758 measured (`host-pr create … [--body <text>] [--body-file <path>]` read as
// two independent optionals where the parser requires exactly one) and opens
// exactly one new way to drift: a rendered alternation that no longer
// corresponds to a declaration, or a declaration the renderer stopped printing.
//
// Both directions are held here, because only both together mean anything. A
// one-way check "every declaration is rendered" passes a renderer that also
// prints alternations out of nowhere; a one-way check "every alternation is
// declared" passes a renderer that prints none at all.

/**
 * Every `( … | … )` / `[ … | … ]` alternation in one rendered section — the
 * RELATIONSHIPS, and nothing else.
 *
 * Angle-bracket spans are masked out before the scan, because a pipe inside
 * `<…>` is a value VOCABULARY, not a choice between arguments: without the
 * mask, `[--method <squash|merge|rebase>]` — one optional flag whose value has
 * three spellings — reads as an alternation between two flags, and the drift
 * check below would demand a declaration for a relationship that does not
 * exist. The mask preserves offsets (one NUL per masked character) so the text
 * reported back is the line's own, not the masked one.
 */
export function alternationsIn(section: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of section) {
    const masked = line.replace(/<[^<>]*>/g, (span) => '\u0000'.repeat(span.length));
    for (const match of masked.matchAll(/[([]([^()[\]]*\|[^()[\]]*)[)\]]/g)) {
      const start = (match.index ?? 0) + 1;
      found.push(line.slice(start, start + match[1].length).trim());
    }
  }
  return found;
}

describe('verb-contract drift — every rendered alternation maps to a declaration', () => {
  /**
   * What a contract DECLARES an alternation for: one per `groups` entry —
   * contract-level, or declared on a {@link VerbForm} instead (issue #892;
   * `signatureSegments` reads `form?.groups ?? decl.groups ?? []`, so a form
   * that declares its own group is rendered from THAT, not the contract's) —
   * plus one for a named twin (the positional form against the named one,
   * ADR-0051 decision 6 — the relationship the renderer has always drawn).
   *
   * A value VOCABULARY is deliberately not counted. `--method
   * <squash|merge|rebase>` and `issue-store transition <queued|in-flight|
   * in-review>` spell their pipes inside angle brackets, which is what
   * {@link alternationsIn} reads as "one slot, several accepted values" rather
   * than as a choice between arguments. Relationships and vocabularies are two
   * different facts and the renderer says them with two different brackets.
   */
  function declaredAlternationCount(contract: VerbContract): number {
    const groups = (contract.groups ?? []).length;
    const formGroups = (contract.forms ?? []).reduce(
      (n, form) => n + (form.groups?.length ?? 0),
      0,
    );
    const twin = contract.twin === undefined || contract.twin.length === 0 ? 0 : 1;
    return groups + formGroups + twin;
  }

  it('renders one alternation per declaration, and declares one per alternation', () => {
    const mismatches: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const rendered = alternationsIn(renderInvocations(contract));
      const declared = declaredAlternationCount(contract);
      if (rendered.length !== declared) {
        mismatches.push(
          `${verb}: renders ${rendered.length} alternation(s) [${rendered.join(' ; ')}] ` +
            `but declares ${declared}`,
        );
      }
    }
    expect(mismatches.join('\n')).toBe('');
  });

  it('every declared group and form names flags the verb actually declares', () => {
    // A group or a form over a spelling the contract does not carry would
    // render a flag nobody can pass — the omission class in reverse, and the
    // one way a relationship declaration can lie on its own.
    const bad: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const canonicals = new Set(contract.flags.map((f) => f.canonical));
      const check = (token: string, where: string): void => {
        if (token.startsWith('--') && !canonicals.has(token)) {
          bad.push(`${verb}: ${where} names ${token}, which this verb does not declare`);
        }
      };
      for (const group of contract.groups ?? []) {
        for (const token of group.branches.flat()) check(token, 'a group');
      }
      for (const form of contract.forms ?? []) {
        for (const token of [...(form.requires ?? []), ...(form.accepts ?? [])]) {
          check(token, 'a form');
        }
        for (const group of form.groups ?? []) {
          for (const token of group.branches.flat()) check(token, "a form's group");
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('the five verbs the ticket named each render their relationship', () => {
    // Named, because these are the losses that were MEASURED — a structural
    // check that happened to hold on an empty set would say nothing about them.
    const shapes: Record<string, string> = {
      'host-pr create': '(--body <body> | --body-file <path>)',
      'spine add-disclosure': '(<row-id> --iter <n> | --wave-scoped)',
    };
    for (const [verb, shape] of Object.entries(shapes)) {
      expect(renderInvocations(AGGREGATE[verb]).join('\n')).toContain(shape);
    }
    // The other three carry their relationship as a second FORM rather than as
    // an alternation inside one line: two shapes, two lines.
    for (const verb of ['dor', 'conflict-map', 'credential-probe']) {
      expect(renderInvocations(AGGREGATE[verb]), `${verb} declares two forms`).toHaveLength(2);
    }
  });

  it('NEGATIVE CONTROL — a declaration the renderer drops is caught, and so is the reverse', () => {
    // The check above is worth exactly what it can fail on, so both halves are
    // provoked here against synthetic contracts rather than trusted.
    const base = {
      verb: 'toy',
      flags: [
        { canonical: '--a', value: 'none', valueType: 'none' },
        { canonical: '--b', value: 'none', valueType: 'none' },
      ],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
    } as const;

    // (a) declared and rendered — balanced.
    const balanced = defineVerb({
      ...base,
      groups: [{ kind: 'exactly-one', branches: [['--a'], ['--b']] }],
    });
    expect(alternationsIn(renderInvocations(balanced))).toHaveLength(1);

    // (b) the SAME contract rendered with relationships off — the declaration
    // is there and the alternation is not. This is what a renderer that
    // silently stopped printing groups would look like.
    expect(
      alternationsIn(renderInvocations(balanced, { relationships: false })),
    ).toHaveLength(0);

    // (c) an alternation with NO declaration behind it — a positional label
    // that spells one by hand. It renders, it declares nothing, and the count
    // check above is what catches it: RUN against the real assertion here, so
    // the failure is observed rather than assumed.
    const handWritten = defineVerb({
      ...base,
      positionals: { kind: 'fixed', count: 1, labels: ['(x | y)'] },
    });
    const rendered = alternationsIn(renderInvocations(handWritten));
    expect(rendered).toEqual(['x | y']);
    expect(declaredAlternationCount(handWritten)).toBe(0);
    expect(rendered.length).not.toBe(declaredAlternationCount(handWritten));

    // (d) a group declared INSIDE a form, not at the contract level (issue
    // #892). No shipped verb does this today — every current form falls back
    // to the contract's own `groups` — so this fixture is what pins the
    // counter against the day one does: a group declared only on `form.groups`
    // renders exactly as a contract-level one does (`signatureSegments` reads
    // `form?.groups ?? decl.groups ?? []`), and the count has to follow it
    // there.
    const formGrouped = defineVerb({
      ...base,
      forms: [{ groups: [{ kind: 'exactly-one', branches: [['--a'], ['--b']] }] }],
    });
    expect(alternationsIn(renderInvocations(formGrouped))).toHaveLength(1);
    expect(declaredAlternationCount(formGrouped)).toBe(1);
  });
});

// ─── 5. The retired spellings are gone from the engine sources ──────────────

describe('verb-contract drift — a renamed flag leaves no copy behind', () => {
  it('no engine source still spells route-tuple\'s pre-decision-5 payload flags', async () => {
    // `route-tuple`'s private usage printer outlived ADR-0051 decision 5's
    // rename by two rows: `--help` printed `--report-file`/`--verdict-file`
    // while the missing-flag refusal three lines down still taught
    // `--report`/`--verdict` followed by a path. Issue #856 deleted the printer;
    // this is what stops the pair coming back — in a printer, a docblock, or a
    // brief. Scanned over the engine's own sources, specs excluded (this file
    // has to be able to name what it forbids).
    const files = await fastGlob('**/*.ts', {
      cwd: SRC_DIR,
      ignore: ['**/*.spec.ts', '__fixtures__/**'],
    });
    const retired = ['--report <path>', '--verdict <path>'];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(SRC_DIR, file), 'utf-8');
      for (const spelling of retired) {
        if (source.includes(spelling)) offenders.push(`${file} — ${spelling}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('NEGATIVE CONTROL — the scan fires on the exact text that was removed', () => {
    // The deleted printer's second line, verbatim. If this ever reads clean the
    // check above has stopped being able to fail.
    const removed =
      "      '         --report <path> --verdict <path> --anchor <sha> --config <cfg>\\n' +";
    expect(['--report <path>', '--verdict <path>'].filter((s) => removed.includes(s))).toEqual([
      '--report <path>',
      '--verdict <path>',
    ]);
  });
});

// ─── 6. A JSON verb declares the SHAPE of its JSON (issue #913) ──────────────
//
// `output: 'json'` says stdout is JSON and says nothing about what that JSON
// IS. Thirty-five of the engine's thirty-six json-class verbs declared exactly
// that and stopped — `catalog` alone carried a shape — while the `prose` and
// `silent-write` verbs beside them had been declaring theirs since ADR-0051
// decision 7. The asymmetry had a measured cost: two shipped reference
// documents described `merge-order`'s output as an array of branch STRINGS
// where it prints an array of OBJECTS, and nothing rendered the real shape
// anywhere a reader — or a drift check — would meet it.
//
// This is the check that makes the omission impossible to re-introduce. It is
// deliberately a MEMBERSHIP check over the live aggregate rather than a list of
// verbs: a verb added tomorrow with `output: 'json'` and no shape fails here on
// the day it lands, with no edit to this file.
//
// **Resolution bias (ADR-0052): fail-closed.** A contract this check cannot
// read a shape off is a FINDING, not an abstention — there is no ambiguous case
// to abstain over, because the predicate is the presence of one declared string
// and the aggregate is fully enumerable in-process. The unmodelled set is
// empty, and the two negative controls below are what keeps that claim honest.

/** Every `output: 'json'` contract in the live aggregate, keyed as a caller types it. */
function jsonClassContracts(): [string, VerbContract][] {
  return Object.entries(AGGREGATE).filter(([, c]) => c.output === 'json');
}

/**
 * Why `shape` fails to be usable notation, or `null` when it is fine.
 *
 * Deliberately shallow: it asks whether the string could be a shape at all —
 * non-empty, and its braces/brackets balanced — not whether it matches any
 * particular grammar. A stricter parser here would be a second notation the
 * receipt clauses already shipped without, and the failure it would catch (a
 * typo inside a key list) is one the printed-form comparison catches better.
 */
function malformedShape(shape: string): string | null {
  if (shape.trim() === '') return 'empty';
  const stack: string[] = [];
  const close: Record<string, string> = { '}': '{', ']': '[' };
  for (const ch of shape) {
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch in close) {
      if (stack.pop() !== close[ch]) return `unbalanced at "${ch}"`;
    }
  }
  return stack.length === 0 ? null : `unclosed "${stack[stack.length - 1]}"`;
}

describe('verb-contract drift — a JSON verb declares the shape of its JSON', () => {
  it('every `output: json` contract carries a declared `json.shape`', () => {
    const undeclared = jsonClassContracts()
      .filter(([, c]) => c.json?.shape === undefined)
      .map(([verb]) => verb);
    // No exemption list, and none is needed: every json verb in the engine
    // states a shape. An exemption would have to be declared and reasoned in
    // the contract itself — there is no allowlist here to add a verb to.
    expect(undeclared.join('\n')).toBe('');
  });

  it('the surface this row closed — 36 json-class verbs, every one of them shaped', () => {
    // The DUTY is the membership check above; this states the number the row
    // measured so a later reader can see which way it moved. 35 of these 36
    // carried no shape before issue #913 — `catalog` was the one that did.
    const shaped = jsonClassContracts().filter(([, c]) => c.json?.shape !== undefined);
    expect(jsonClassContracts()).toHaveLength(36);
    expect(shaped).toHaveLength(36);
  });

  it('every declared shape is usable notation, on every output class', () => {
    // Not only the json verbs: a receipt clause's shape is the same notation
    // and gets the same check, so this cannot pass by narrowing its subject.
    const bad: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      const shape = contract.json?.shape;
      if (shape === undefined) continue;
      const why = malformedShape(shape);
      if (why !== null) bad.push(`${verb}: ${why} — ${shape}`);
    }
    expect(bad.join('\n')).toBe('');
  });

  it('the rendered section SHOWS each shape, headed `shape:` on a json verb', () => {
    // A declaration the renderer drops is the same omission one layer out: the
    // Catalog would carry the shape and `--help` would not, which is the exact
    // split that let the merge-order defect live. Both halves are asserted.
    const missing: string[] = [];
    for (const [verb, contract] of jsonClassContracts()) {
      const shape = contract.json?.shape;
      if (shape === undefined) continue; // the check above owns that case
      const section = contract.usage;
      const clause = section.find((line) => line.trimStart().startsWith('shape:'));
      if (clause === undefined) {
        missing.push(`${verb}: renders no \`shape:\` line`);
      } else if (!clause.includes(shape)) {
        missing.push(`${verb}: its \`shape:\` line does not carry the declared shape`);
      }
      // …and the flag-headed spelling is NOT what a json verb renders: there is
      // no `--json` to explain when the whole stdout already is the JSON.
      if (section.some((line) => line.trimStart().startsWith('--json:'))) {
        missing.push(`${verb}: renders a \`--json:\` clause on a json-class verb`);
      }
    }
    expect(missing.join('\n')).toBe('');
  });

  it('a non-json verb keeps the flag-headed `--json:` clause', () => {
    // The other direction of the same rule: the heading follows the output
    // class, so a prose verb must NOT start reading `shape:`.
    const wrong: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      if (contract.output === 'json' || contract.json === undefined) continue;
      const headed = contract.usage.filter((line) => line.trimStart().startsWith('shape:'));
      if (headed.length > 0) wrong.push(`${verb}: ${headed.join(' / ')}`);
    }
    expect(wrong.join('\n')).toBe('');
    // A declared LABEL still overrides both defaults: the issue-store write
    // receipts say `--json receipt`, and the class rule does not touch them.
    expect(AGGREGATE['issue-store transition'].usage.join('\n')).toContain('--json receipt:');
  });

  it('merge-order — the verb this row was filed for — names its real keys', () => {
    // Named, because this is the shape that was MEASURED wrong: two shipped
    // reference documents called `algorithmic` an array of branch strings. The
    // keys below are the ones `renderMergeOrder`'s `projectPr` actually builds.
    const shape = AGGREGATE['merge-order'].json?.shape ?? '';
    for (const key of ['issueId', 'nn', 'fileCount', 'branch', 'title?', 'prUrl?']) {
      expect(shape, `merge-order's shape omits ${key}`).toContain(key);
    }
    expect(shape).toContain('algorithmic: [ {');
    // …and the rendered help — the public contract surface — shows it.
    const rendered = AGGREGATE['merge-order'].usage.join('\n');
    expect(rendered).toContain('shape: { algorithmic: [ { issueId, nn, fileCount, branch');
  });

  it('route-tuple — its declared shape carries `repaired` beside `recovered` (issue #977)', () => {
    // The one additive key the divergence repair put on the result: it sits in
    // the `sidecar-check` step's detail, beside `recovered`, so the envelope
    // names the pair on the step entry and a continuation line says what they
    // list. A result key the contract does not declare is the omission this
    // describe block exists to stop.
    const contract = AGGREGATE['route-tuple'];
    const shape = contract.json?.shape ?? '';
    expect(shape).toContain('steps: [ { step, status, recovered?, repaired?, ...detail } ]');
    const rendered = contract.usage.join('\n');
    expect(rendered).toContain(`shape: ${shape}`);
    expect(rendered).toContain('sidecar-check:     recovered / repaired: [ report | verdict ]');
  });

  it('NEGATIVE CONTROL — a json verb with no shape, and a malformed one, both fail', () => {
    // The two predicates above are worth exactly what they can fail on, so a
    // defect of each kind is built by hand here and run through the SAME
    // functions, rather than trusted to stay catchable.
    const base: VerbContractDeclaration = {
      verb: 'toy',
      flags: [],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
    };

    // (a) the omission this row closes: `output: 'json'` and nothing else.
    const unshaped = defineVerb(base);
    expect(unshaped.json?.shape).toBeUndefined();
    expect(
      [unshaped].filter((c) => c.output === 'json' && c.json?.shape === undefined),
    ).toHaveLength(1);
    expect(unshaped.usage.some((l) => l.trimStart().startsWith('shape:'))).toBe(false);

    // (b) notation that cannot be read as a shape.
    expect(malformedShape('')).toBe('empty');
    expect(malformedShape('{ a, b: [ c }')).toBe('unbalanced at "}"');
    expect(malformedShape('{ a, b: [ c ]')).toBe('unclosed "{"');
    // …and the well-formed one it has to let through.
    expect(malformedShape('{ a, b: [ { c, d? } ], e | null }')).toBeNull();
  });

  it('NEGATIVE CONTROL — the renderer check fires when the clause is dropped', () => {
    // The `shape:`-line assertion could pass vacuously if the renderer stopped
    // emitting the clause AND the loop skipped the verb. It does not: a
    // declared shape that the renderer does not print is caught here.
    const shaped = renderUsageSection({
      verb: 'toy',
      flags: [],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
      json: { shape: '{ a, b }' },
    });
    expect(shaped.some((l) => l.trimStart() === 'shape: { a, b }')).toBe(true);
    // The same declaration on a PROSE verb renders the flag-headed spelling —
    // one declaration, two headings, decided by the class and by nothing else.
    const prose = renderUsageSection({
      verb: 'toy',
      flags: [],
      positionals: { kind: 'fixed', count: 0 },
      output: 'prose',
      json: { shape: '{ a, b }' },
    });
    expect(prose.some((l) => l.trimStart() === '--json: { a, b }')).toBe(true);
  });
});
