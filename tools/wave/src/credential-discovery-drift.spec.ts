/**
 * credential-discovery-drift.spec.ts — the reconciliation guard for
 * `KNOWN_CREDENTIAL_VARIABLES`, the hand-maintained list that
 * `credential-probe --all` discovers over (ADR-0029).
 *
 * ## The gap this closes, observed once for real
 *
 * Engine 1.3.0 added a THIRD production credential — the Bitbucket landing
 * host's `BITBUCKET_TOKEN`, resolved through the same ADR-0029 seam by
 * `adapters/bitbucket/bitbucket-api`'s factory and by `host-pr-cli`'s create
 * edge — and did not widen the discovery list. Nothing failed. `--all` on a
 * Bitbucket consumer with a perfectly good, perfectly reachable credential
 * printed `ok: true`, `probed: []`, `failed: []` and exited 0: a SILENT false
 * all-clear at the two Coordinator auth preflights (wave-start step 4,
 * wave-close phase 2), for an entire release, discovered only by a consumer in
 * the field.
 *
 * The list entry is the fix for that one credential. This spec is the fix for
 * the CLASS: the list is hand-maintained, its call sites are not, and until now
 * no gate compared them. The next adapter cannot repeat it — a production call
 * site that resolves a variable the list does not carry fails here, by name.
 *
 * ## Family and idiom
 *
 * This belongs to the repo-source-reading consistency family — `barrel-drift.spec.ts`
 * (every module export is root-reachable or explicitly allowlisted),
 * `allowlist-scaffold-guard.spec.ts` (every live entry is cited or excepted, in
 * BOTH directions), `skill-schema-drift.spec.ts` (an inlined literal is pinned
 * to its engine const) — not to the engine-behavior specs, because it asserts
 * nothing about what the probe DOES at runtime. It asserts that two independently
 * maintained places in the repo still agree.
 *
 * Mechanism, following `barrel-drift.spec.ts` (the closest precedent, read
 * before this file was written): the TypeScript compiler API (`typescript` is
 * already a devDependency — `tsc --noEmit` uses it) over a program built from
 * the repo's own tsconfig, plus `fast-glob` discovery of `src/**\/*.ts`. Not a
 * regex scan, for two reasons a regex could not cover:
 *
 *   1. **Call sites are matched by SYMBOL IDENTITY.** A call counts only when
 *      its callee resolves — through the import alias chain — to the very
 *      `resolveCredential` that `credential-resolver.ts` exports. A same-named
 *      local helper elsewhere would not match; an aliased import
 *      (`import { resolveCredential as rc }`) still would.
 *   2. **The argument is read as a TYPE, not as text.** That is what lets one
 *      rule cover both spellings the repo actually uses: a bare literal
 *      (`resolveCredential('GITHUB_TOKEN', …)`) and an adapter's exported
 *      constant (`resolveCredential(BITBUCKET_TOKEN_VAR, …)`) both have a
 *      string-literal type at the call site, so both resolve to the same name.
 *      A regex would see two unrelated shapes and would have to guess at the
 *      second.
 *
 * ## Both directions, and the dynamic case
 *
 * Reconciliation means neither side may drift, so the guard runs both ways:
 * every literal call site's variable must be ON the list, and every list member
 * must be resolved by SOME production call site (a list entry with no call site
 * is a credential nothing reads — either a typo or a leftover, and both are the
 * kind of quiet wrongness this family exists to refuse).
 *
 * One production call site resolves a variable that is not knowable statically:
 * the probe verb itself, which resolves whatever variable it was HANDED. That
 * is not a defect and it is not drift — it is the `--var` selection form doing
 * its job — so it is named on {@link DYNAMIC_CALL_SITE_ALLOWLIST} with its
 * reason, and, per the house idiom, a stale entry there fails too.
 */

import { join } from 'node:path';
import ts from 'typescript';
import fastGlob from 'fast-glob';
import { describe, it, expect } from 'vitest';

// Importing the list under test FROM ITS OWN MODULE is deliberate: the guard
// compares the repo's call sites against the binding the runtime actually uses,
// never against a copy of it spelled here.
import { KNOWN_CREDENTIAL_VARIABLES } from './credential-probe-cli';

// ─── the production module surface ───────────────────────────────────────────

const SRC_DIR = __dirname; // this file lives at tools/wave/src/
const WAVE_ROOT = join(SRC_DIR, '..');
const TSCONFIG_PATH = join(WAVE_ROOT, 'tsconfig.json');
const RESOLVER_PATH = join(SRC_DIR, 'credential-resolver.ts');

/**
 * Every PRODUCTION engine source module: `src/**\/*.ts` minus specs and
 * fixtures. Specs are excluded on purpose — a spec resolves fixture variable
 * names (`EXAMPLE_TOKEN`) by design, and holding those to the discovery list
 * would be exactly backwards. Discovered fresh on every run, so a module added
 * to `src/` tomorrow is scanned with nothing here to update.
 */
const PRODUCTION_RELATIVE_FILES = fastGlob
  .sync(['**/*.ts'], {
    cwd: SRC_DIR,
    ignore: ['**/*.spec.ts', '__fixtures__/**'],
  })
  .sort();

/** `./relative/module/path` (no `.ts`) — how this repo's own imports and
 * {@link DYNAMIC_CALL_SITE_ALLOWLIST}'s keys both spell a module. */
function moduleLabel(relativeFile: string): string {
  return './' + relativeFile.replace(/\.ts$/, '');
}

const MODULE_LABEL_TO_ABS_PATH = new Map<string, string>(
  PRODUCTION_RELATIVE_FILES.map((rel) => [moduleLabel(rel), join(SRC_DIR, rel)]),
);

// ─── the real production TS program (built once for this file) ───────────────

/**
 * Compiler options straight from the repo's own tsconfig.json — the same options
 * `npm run typecheck` uses — with `rootNames` narrowed to the production modules
 * above (skipping the `.spec.ts` files tsconfig's `include` would otherwise pull
 * in as separate roots; nothing non-spec imports a spec, so only build time is
 * lost). Mirrors `barrel-drift.spec.ts`'s `loadRealProgram`.
 */
function loadRealProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read tsconfig.json at ${TSCONFIG_PATH}: ${configFile.error.messageText}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, WAVE_ROOT);
  const program = ts.createProgram({
    rootNames: [...MODULE_LABEL_TO_ABS_PATH.values()],
    options: parsed.options,
  });
  return { program, checker: program.getTypeChecker() };
}

const { program: realProgram, checker: realChecker } = loadRealProgram();

// ─── finding the call sites ──────────────────────────────────────────────────

/**
 * Resolve a symbol through any import/re-export alias chain to the original
 * declaration. Without it, `resolveCredential` as imported into a call site is
 * an ALIAS symbol and would never compare equal to the declaration in
 * `credential-resolver.ts`. Cycle-guarded exactly as in `barrel-drift.spec.ts`.
 */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let sym = symbol;
  let guard = 0;
  while ((sym.flags & ts.SymbolFlags.Alias) !== 0 && guard < 50) {
    const next = checker.getAliasedSymbol(sym);
    if (next === sym) break;
    sym = next;
    guard += 1;
  }
  return sym;
}

/**
 * The ONE `resolveCredential` this guard recognises: the symbol
 * `credential-resolver.ts` actually exports. Throws rather than returning
 * `undefined` — a missing resolver means this guard would silently match
 * nothing and pass for the worst possible reason.
 */
function theResolverSymbol(program: ts.Program, checker: ts.TypeChecker): ts.Symbol {
  const sourceFile = program.getSourceFile(RESOLVER_PATH);
  if (!sourceFile) {
    throw new Error(`credential-resolver.ts is not in the TS program: ${RESOLVER_PATH}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`credential-resolver.ts exports nothing: ${RESOLVER_PATH}`);
  }
  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .find((s) => s.name === 'resolveCredential');
  if (!exported) {
    throw new Error(
      'credential-resolver.ts no longer exports `resolveCredential` — this guard ' +
        'matches call sites by symbol identity against that export, so a rename ' +
        'must be followed here rather than silently matching nothing.',
    );
  }
  return resolveAlias(checker, exported);
}

/** One production `resolveCredential(...)` call. `variable` is `null` when the
 * argument is not statically knowable (see {@link DYNAMIC_CALL_SITE_ALLOWLIST}). */
interface ResolverCallSite {
  modulePath: string;
  line: number;
  /** The argument's source text — what a reader greps for, and the allowlist key. */
  argumentText: string;
  /** The credential variable name, when it is statically knowable. */
  variable: string | null;
}

/**
 * The credential name an argument denotes, or `null` when it is not statically
 * knowable. Handles BOTH spellings in one rule by reading the argument's TYPE:
 * a string literal and an identifier bound to a `const … = 'NAME'` both carry
 * the string-literal type `"NAME"` at the call site, while the probe verb's own
 * `variable: string` parameter carries the widened `string` and falls through.
 */
function literalVariableOf(checker: ts.TypeChecker, argument: ts.Expression): string | null {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  const type = checker.getTypeAtLocation(argument);
  return type.isStringLiteral() ? type.value : null;
}

/** Every production call of the resolver, in module order. */
function findResolverCallSites(
  program: ts.Program,
  checker: ts.TypeChecker,
  modules: Map<string, string>,
): ResolverCallSite[] {
  const target = theResolverSymbol(program, checker);
  const sites: ResolverCallSite[] = [];

  for (const [label, absPath] of modules) {
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) {
      throw new Error(`source file not found in the TS program: ${absPath}`);
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const calleeSymbol = checker.getSymbolAtLocation(node.expression);
        if (calleeSymbol && resolveAlias(checker, calleeSymbol) === target) {
          const argument = node.arguments[0];
          sites.push({
            modulePath: label,
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            argumentText: argument.getText(sourceFile),
            variable: literalVariableOf(checker, argument),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return sites;
}

const CALL_SITES = findResolverCallSites(realProgram, realChecker, MODULE_LABEL_TO_ABS_PATH);
const STATIC_CALL_SITES = CALL_SITES.filter((s) => s.variable !== null);
const DYNAMIC_CALL_SITES = CALL_SITES.filter((s) => s.variable === null);

function formatSites(sites: ResolverCallSite[]): string {
  if (sites.length === 0) return '(none)';
  return sites
    .map((s) => `${s.modulePath}:${s.line} — resolveCredential(${s.argumentText}, …)`)
    .join('\n');
}

// ─── the reconciled dynamic-call-site allowlist ──────────────────────────────

/**
 * Every production call site whose credential variable is deliberately NOT
 * statically knowable, keyed by module label and then by the argument's source
 * text, with the reason a reader needs to trust it instead of re-litigating it.
 *
 * A dynamic call site is not automatically fine: it is a place where a
 * credential can be resolved that `--all` will never discover, which is the very
 * failure mode this guard exists for. Each one has to earn its exception.
 */
const DYNAMIC_CALL_SITE_ALLOWLIST: Record<string, Record<string, string>> = {
  './credential-probe-cli': {
    variable:
      'The probe verb resolving whatever variable it was HANDED — this IS the ' +
      '`--var <VAR>` selection form (ADR-0029: `<VAR>_CMD` is mechanical, so an ' +
      'out-of-tree store adapter probes its own credential by naming it rather ' +
      'than by being added to the discovery list). It cannot be static without ' +
      'deleting that form, and it is the one call site that can never cause the ' +
      'drift this guard catches: it probes exactly what the caller asserted.',
  },
};

// ─── the check ───────────────────────────────────────────────────────────────

describe('credential-discovery drift — every production credential a call site resolves is discoverable by `--all` (ADR-0029)', () => {
  it('scans a realistic surface (a guard matching nothing is green for the wrong reason)', () => {
    // Both halves matter: the module sweep must actually see the engine, and
    // the symbol match must actually find calls. Either at zero would make
    // every assertion below vacuously true.
    expect(PRODUCTION_RELATIVE_FILES.length).toBeGreaterThanOrEqual(50);
    expect(CALL_SITES.length, formatSites(CALL_SITES)).toBeGreaterThanOrEqual(5);
    expect(STATIC_CALL_SITES.length, formatSites(STATIC_CALL_SITES)).toBeGreaterThanOrEqual(4);
  });

  it('reads BOTH argument spellings — a bare literal and an adapter `*_VAR` constant', () => {
    // The discriminator that makes a type-based read necessary rather than
    // decorative: `github-api-factory` passes 'GITHUB_TOKEN' as a literal,
    // `adapters/bitbucket/bitbucket-api` passes the BITBUCKET_TOKEN_VAR
    // constant, and this guard has to see the same kind of fact in both.
    const literalSpelled = STATIC_CALL_SITES.filter((s) => /^['"]/.test(s.argumentText));
    const constantSpelled = STATIC_CALL_SITES.filter((s) => !/^['"]/.test(s.argumentText));
    expect(literalSpelled.length, formatSites(STATIC_CALL_SITES)).toBeGreaterThanOrEqual(1);
    expect(constantSpelled.length, formatSites(STATIC_CALL_SITES)).toBeGreaterThanOrEqual(1);
    // …and the constant-spelled ones really did resolve to a NAME, not to the
    // identifier's own text — otherwise this test would pass on a broken read.
    for (const site of constantSpelled) {
      expect(site.variable).not.toBe(site.argumentText);
      expect(site.variable).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('THE GUARD: no production call site resolves a credential `--all` cannot discover', () => {
    const known = new Set<string>(KNOWN_CREDENTIAL_VARIABLES);
    const undiscoverable = STATIC_CALL_SITES.filter((s) => !known.has(s.variable as string));
    expect(
      undiscoverable,
      'These production call sites resolve a credential that is NOT in ' +
        'KNOWN_CREDENTIAL_VARIABLES, so `credential-probe --all` would report a ' +
        'false all-clear on a consumer that has it configured:\n' +
        formatSites(undiscoverable) +
        `\n\ncurrent discovery list: ${KNOWN_CREDENTIAL_VARIABLES.join(', ')}`,
    ).toEqual([]);
  });

  it('and no discovery-list member is a credential nothing actually resolves (the other direction)', () => {
    const resolved = new Set(STATIC_CALL_SITES.map((s) => s.variable as string));
    const orphaned = KNOWN_CREDENTIAL_VARIABLES.filter((v) => !resolved.has(v));
    expect(
      [...orphaned],
      'These discovery-list members are resolved by NO production call site — ' +
        'either a typo, or a leftover from a removed adapter. `--all` would ' +
        'probe (and could fail a preflight over) a credential this engine no ' +
        `longer reads.\nproduction call sites:\n${formatSites(STATIC_CALL_SITES)}`,
    ).toEqual([]);
  });

  it('every dynamic call site is explicitly allowlisted with a reason', () => {
    const unaccounted = DYNAMIC_CALL_SITES.filter((s) => {
      const allowedForModule = DYNAMIC_CALL_SITE_ALLOWLIST[s.modulePath];
      return !(allowedForModule && Object.hasOwn(allowedForModule, s.argumentText));
    });
    expect(
      unaccounted,
      'These production call sites resolve a credential whose name is not ' +
        'statically knowable, so this guard cannot check them against the ' +
        'discovery list. Each needs an entry in DYNAMIC_CALL_SITE_ALLOWLIST ' +
        'stating why that is correct:\n' + formatSites(unaccounted),
    ).toEqual([]);
  });

  it('every allowlist entry names a call site that still exists (no stale entries)', () => {
    // A stale exception would silently absolve a FUTURE dynamic call site that
    // happens to reuse the same module and argument spelling — the same
    // both-directions reconciliation barrel-drift and allowlist-scaffold-guard
    // hold their own allowlists to.
    const live = new Set(DYNAMIC_CALL_SITES.map((s) => `${s.modulePath}#${s.argumentText}`));
    const stale: string[] = [];
    for (const [mod, entries] of Object.entries(DYNAMIC_CALL_SITE_ALLOWLIST)) {
      for (const arg of Object.keys(entries)) {
        if (!live.has(`${mod}#${arg}`)) stale.push(`${mod}#${arg}`);
      }
    }
    expect(stale, `stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('the discovery list carries AMBIENT variable names only, never a `<VAR>_CMD` name', () => {
    // The command counterpart is derived mechanically by the resolver
    // (commandVariableFor). A `_CMD` member would make `--all` probe
    // `BITBUCKET_TOKEN_CMD_CMD` — configured nowhere, discovered never.
    for (const variable of KNOWN_CREDENTIAL_VARIABLES) {
      expect(variable.endsWith('_CMD'), `${variable} is a lookup-command name`).toBe(false);
    }
  });
});
