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
  ROUTER_GLOBAL_FLAGS,
  type VerbContract,
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
 * `verb-contract.ts` appears because it holds the contracts of the three verbs
 * whose runner module is outside the declaring row's Files globs
 * (`DISPLACED_VERB_CONTRACTS`); when a later row moves those three beside their
 * runners, this entry shrinks to the two router globals and nothing else here
 * changes.
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
  'verb-contract.ts': ['compose-driver', 'route-tuple', 'close-row'],
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

  it('the runnerToken bridge is used by exactly the two flags ADR-0051 needed it for', () => {
    // A deletion date made checkable: `runnerToken` exists only because
    // `route-tuple.ts` was outside the declaring row's Files globs and could not
    // be rewritten to read the renamed spellings. Nothing else may reach for it.
    const bridged: string[] = [];
    for (const [verb, contract] of Object.entries(AGGREGATE)) {
      for (const f of contract.flags) {
        if (f.runnerToken !== undefined) bridged.push(`${verb} ${f.canonical}`);
      }
    }
    expect(bridged.sort()).toEqual(['route-tuple --report-file', 'route-tuple --verdict-file']);
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

  it('states the surface this row measured — 27 top-level verbs, 45 group ops', () => {
    // ADR-0051's own table measured 27 top-level verbs and 39 group ops at
    // `53261e0`. Both halves are re-measured here rather than trusted: the
    // top-level count is unchanged, and the op count has grown to 45 because
    // `issue-store` gained five ops since that commit and `config validate` is
    // counted as the group op it structurally is. The duty was never the
    // number — it is that EVERY verb and EVERY op declares a contract, which the
    // roster test above holds — but the number is stated so a later reader can
    // see which way it moved.
    const keys = Object.keys(AGGREGATE);
    const groups = ['host-pr', 'issue-store', 'spine', 'config'];
    const groupOps = keys.filter((k) => groups.some((g) => k.startsWith(`${g} `)));
    const topLevel = keys.filter((k) => !groupOps.includes(k));
    expect(topLevel.length + groups.length).toBe(27);
    expect(groupOps.length).toBe(45);
    expect(opsOf('host-pr').length).toBe(5);
    expect(opsOf('issue-store').length).toBe(26);
    expect(opsOf('spine').length).toBe(13);
    expect(opsOf('config').length).toBe(1);
  });
});
