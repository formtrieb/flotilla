/**
 * barrel-drift.spec.ts — the reconciliation guard for the package-root barrel
 * (`src/index.ts`) (issue #376).
 *
 * The gap, observed three times before this spec existed: a row adds exported
 * symbols to an engine source module, correctly stays inside its declared
 * Files globs (the package root is outside both scopes), and nothing reminds
 * either the row or a later reader that the barrel is a SEPARATE surface. The
 * gap is invisible from inside the repo — every in-repo import path is
 * module-relative and resolves fine — and visible only to an installed-form
 * consumer trying to import the symbol by name. Each prior occurrence was
 * caught by a human or a Reviewer noticing, never by a check.
 *
 * Same family as skill-schema-drift.spec.ts (pins an inlined literal to its
 * engine const) and allowlist-scaffold-guard.spec.ts (every live entry is
 * either cited or explicitly excepted, in BOTH directions): a drift spec that
 * enumerates a real surface and asserts membership rather than restating a
 * hand-maintained list. This one asks, for every engine source module: is
 * each of its exported symbols EITHER (a) reachable from the package root, or
 * (b) named on {@link MODULE_LOCAL_ALLOWLIST} with a stated reason? A symbol
 * in neither fails, naming the module and the symbol.
 *
 * Mechanism: the TypeScript compiler API (`typescript` is already a
 * devDependency — `tsc --noEmit` uses it), not a regex scan. A module's
 * exported symbols and the barrel's re-exports are compared by SYMBOL
 * IDENTITY (resolving through re-export aliases via `getAliasedSymbol`), not
 * by name — the discriminator this repo actually needed: `github-api.ts`
 * re-exports `ReportedCheck`/`RequiredChecksInfo`/`RulesetChecksInfo`/
 * `AutoMergeSetting` FROM `host-pr.ts` rather than declaring its own, so
 * exporting them once (from host-pr.ts) satisfies both modules' requirement
 * under one name — a name-only comparison would not know that. Conversely
 * `conflict-map.ts` and `merge-order.ts` each declare their OWN, separately-
 * typed `extractIssueId` — a name-only comparison would wrongly treat one
 * root export as satisfying both.
 *
 * Scope: every `.ts` file under `src/` except `*.spec.ts`, `__fixtures__/**`,
 * and `index.ts` itself — discovered dynamically via `fast-glob`, the same
 * tool the engine itself already depends on. Dynamic discovery is what makes
 * the "new module" acceptance criterion true without a dedicated code path: a
 * module added to `src/` tomorrow is scanned the same way every existing one
 * is, with nothing to update in this file for the discovery to see it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import fastGlob from 'fast-glob';
import { describe, it, expect } from 'vitest';

// The bindings as the MODULE FILE defines them (AC4's runtime half — see the
// dedicated describe block near the bottom of this file). Importing these
// FROM THE ROOT is itself the assertion: if any of these regressed off the
// barrel, this file would fail to even compile/load, before a single `it`
// runs.
import {
  armPullRequest,
  GitHubIssuesStore,
  MarkdownFsStore,
  DEFAULT_ELIGIBILITY,
  runRouteVerdict,
  sweepOrphanBranches,
  orderPrs,
  extractConflictMapIssueId,
  extractMergeOrderIssueId,
  findRepoRoot,
  LinearTransitionVerifyError,
  createGitHubApiFromEnv,
  renderConflictMap,
  // The ADR-0045 member-kind family, imported FROM THE ROOT for the same reason
  // every name above is: if any of these regressed off the barrel this file
  // would fail to load before a single `it` runs. Two of the four kinds this
  // spec's allowlist reasoning cares about are represented — a shared RULE
  // (`goalMemberKind`, `requireGoalMemberKind`), a typed ERROR class
  // (`GoalMemberKindError`, `GoalMemberJoinError`), a data MAPPING
  // (`GOAL_MEMBER_KIND_BY_CONTAINER`), and a pinned adapter CONSTANT
  // (`PROJECT_BLOCKS_RELATION_TYPE`).
  goalMemberKind,
  requireGoalMemberKind,
  GOAL_MEMBER_KIND_BY_CONTAINER,
  GoalMemberKindError,
  GoalMemberJoinError,
  PROJECT_BLOCKS_RELATION_TYPE,
  PROJECT_RELATION_ANCHOR_TYPE,
} from './index';
// The three TYPE-ONLY promotions this guard's own placement constraint had
// deferred (see the "types this guard deferred" block below). They are listed
// separately from the value imports above because `typeof` cannot probe them:
// a type is erased before a single `it` runs, so the compiler-API check in this
// file — which reads type exports and value exports alike through
// `checker.getExportsOfModule` — is their enforcement, and this import is a
// second, load-time signal that fails `tsc --noEmit` if any of them regresses
// off the barrel.
import type {
  UnaccountedWorktree,
  UnaccountedWorktreeReport,
  StoreGoalConfig,
  WorktreeCountAdvisory,
} from './index';

// ─── the module surface ──────────────────────────────────────────────────

const SRC_DIR = __dirname; // this file lives at tools/wave/src/
const WAVE_ROOT = join(SRC_DIR, '..');
const TSCONFIG_PATH = join(WAVE_ROOT, 'tsconfig.json');
const INDEX_PATH = join(SRC_DIR, 'index.ts');

/**
 * Every engine source module this spec holds to the barrel-or-allowlist rule:
 * every `.ts` file under `src/` except specs, fixtures, and the barrel
 * itself. Discovered fresh on every run — nothing here names a module by
 * hand, which is what makes the "new module" acceptance criterion hold
 * without a dedicated code path (see the module-level doc comment above).
 */
const MODULE_RELATIVE_FILES = fastGlob
  .sync(['**/*.ts'], {
    cwd: SRC_DIR,
    ignore: ['**/*.spec.ts', '__fixtures__/**', 'index.ts'],
  })
  .sort();

/** `./relative/module/path` (no `.ts`) — matches how every import specifier
 * in this repo's own source already spells a sibling module, and how
 * {@link MODULE_LOCAL_ALLOWLIST}'s keys below are spelled. */
function moduleLabel(relativeFile: string): string {
  return './' + relativeFile.replace(/\.ts$/, '');
}

/** label → absolute path, for every discovered module. */
const MODULE_LABEL_TO_ABS_PATH = new Map<string, string>(
  MODULE_RELATIVE_FILES.map((rel) => [moduleLabel(rel), join(SRC_DIR, rel)]),
);

// ─── the TypeScript-compiler-API comparison ──────────────────────────────

/**
 * Resolve an export symbol through any re-export alias chain to the original
 * declaration's symbol. `checker.getExportsOfModule` returns ALIAS symbols
 * for `export { x } from './y'` re-exports; without this, two modules that
 * both (correctly) re-export the SAME underlying declaration would look like
 * two different, unrelated symbols. Guarded against a pathological self-alias
 * or cycle (`next === sym`, or a hard iteration cap) — neither should occur
 * in well-formed TS, but a hang here would be a worse failure mode than a
 * wrong answer.
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

/** The symbols a module (or the barrel) exports, straight from the checker.
 * Throws if `absPath` never made it into `program` — a stale/typo'd path is a
 * defect in the CALLER, not a "no exports" state, and must not pass silently
 * as an empty array. Returns `[]` only for a genuine file-with-no-exports. */
function moduleExports(
  program: ts.Program,
  checker: ts.TypeChecker,
  absPath: string,
): ts.Symbol[] {
  const sourceFile = program.getSourceFile(absPath);
  if (!sourceFile) {
    throw new Error(`source file not found in the TS program: ${absPath}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  return checker.getExportsOfModule(moduleSymbol);
}

/** The set of ORIGINAL (alias-resolved) symbols reachable from `barrelPath`. */
function rootReachableSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  barrelPath: string,
): Set<ts.Symbol> {
  return new Set(
    moduleExports(program, checker, barrelPath).map((s) => resolveAlias(checker, s)),
  );
}

interface MissingExport {
  modulePath: string;
  symbol: string;
}

/**
 * For every `(label, absPath)` pair in `modules`, every exported symbol NOT
 * reachable (by alias-resolved identity) from `barrelPath`. This is the raw
 * signal, before the allowlist is applied — {@link violationsAfterAllowlist}
 * is the second half.
 */
function findMissingExports(
  program: ts.Program,
  checker: ts.TypeChecker,
  barrelPath: string,
  modules: Map<string, string>,
): MissingExport[] {
  const rootReachable = rootReachableSymbols(program, checker, barrelPath);
  const missing: MissingExport[] = [];
  for (const [label, absPath] of modules) {
    for (const exp of moduleExports(program, checker, absPath)) {
      const resolved = resolveAlias(checker, exp);
      if (!rootReachable.has(resolved)) {
        missing.push({ modulePath: label, symbol: exp.name });
      }
    }
  }
  return missing.sort(
    (a, b) => a.modulePath.localeCompare(b.modulePath) || a.symbol.localeCompare(b.symbol),
  );
}

/** `missing`, minus every entry {@link MODULE_LOCAL_ALLOWLIST} names for that
 * exact module. What survives is the real defect: neither exported nor
 * allowlisted. */
function violationsAfterAllowlist(
  missing: MissingExport[],
  allowlist: Record<string, Record<string, string>>,
): MissingExport[] {
  return missing.filter((m) => {
    const allowedForModule = allowlist[m.modulePath];
    return !(allowedForModule && Object.hasOwn(allowedForModule, m.symbol));
  });
}

function formatViolations(violations: MissingExport[]): string {
  if (violations.length === 0) return '(none)';
  return violations.map((v) => `${v.modulePath} — ${v.symbol}`).join('\n');
}

// ─── the REAL production TS program (built once for this file) ──────────

/**
 * Compiler options straight from the repo's own tsconfig.json — the same
 * options `npm run typecheck` uses — with `rootNames` narrowed to the barrel
 * plus every discovered module (skipping the ~60 `.spec.ts` files tsconfig's
 * `include` would otherwise pull in as separate roots; nothing non-spec
 * imports a spec file, so nothing is lost by narrowing the root list, only
 * build time).
 */
function loadRealProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read tsconfig.json at ${TSCONFIG_PATH}: ${configFile.error.messageText}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, WAVE_ROOT);
  const rootNames = [INDEX_PATH, ...MODULE_LABEL_TO_ABS_PATH.values()];
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const checker = program.getTypeChecker();
  return { program, checker };
}

const { program: realProgram, checker: realChecker } = loadRealProgram();

// ─── the reconciled allowlist ─────────────────────────────────────────────

/**
 * Every currently-missing symbol this reconciliation deliberately did NOT
 * re-export from the root, with the reason a reader needs to trust the
 * omission instead of re-litigating it. Reconciliation means every symbol
 * {@link findMissingExports} reports against the real program is named
 * EITHER here OR in `index.ts`'s own export blocks — see the "no stale
 * entries" and "no unaccounted-for gap" tests below for the two ways this
 * could otherwise drift out of sync with reality.
 */
const MODULE_LOCAL_ALLOWLIST: Record<string, Record<string, string>> = {
  './adapters/body-codec': {
    ParsedBody:
      "Adapter-internal markdown body-codec shape (CLAUDE.md: \"the header-parsing/body-codec logic that reads a tracker's native shape is an adapter concern, not engine\") — consumed by MarkdownFsStore/GitHubIssuesStore/LinearIssuesStore internally. IssueView (contract.ts) is the engine's public contract, not this wire codec.",
    BodyInput:
      'Same adapter-internal body-codec class as ParsedBody above — the serializer input shape.',
    appendBodySections: 'Adapter-internal body-codec helper (see ParsedBody above).',
    parentToLine: 'Adapter-internal body-codec helper (see ParsedBody above).',
    parseBody: 'Adapter-internal body-codec helper (see ParsedBody above).',
    replaceSection: 'Adapter-internal body-codec helper (see ParsedBody above).',
    serializeBareBody: 'Adapter-internal body-codec helper (see ParsedBody above).',
    serializeBody: 'Adapter-internal body-codec helper (see ParsedBody above).',
    tickAcs: 'Adapter-internal body-codec helper (see ParsedBody above).',
    upsertLine: 'Adapter-internal body-codec helper (see ParsedBody above).',
    upsertSection: 'Adapter-internal body-codec helper (see ParsedBody above).',
  },
  // ─── the Bitbucket LANDING adapter ──────────────────────────────────────
  //
  // Read the asymmetry with `./adapters/github/*` before assuming this block
  // is an oversight: the GitHub adapter is root-exported because it is ALSO
  // the tracker seam — `GitHubIssuesStore` (a shipped, consumer-wired
  // `IssueStore`) is constructed from a `GitHubApi`, so a consumer legitimately
  // reaches for `RealGitHubApi` / `createGitHubApiFromEnv` / `GitHubHttp` by
  // name. Bitbucket is a code HOST here and nothing else: there is no
  // `BitbucketIssuesStore`, no `IssueStore` takes this adapter, and the ONLY
  // constructor of it is the engine's own `host-pr` detect-host router, which
  // consumers drive as a CLI verb (`host-pr create|arm|merge|status|preflight`)
  // rather than as an import. So these are module-local by the same standard
  // every other entry here is held to.
  //
  // Honest caveat, stated so it cannot rot silently: `src/index.ts` is outside
  // this slice's declared Files globs, so root-export parity was not an option
  // to weigh here even had the reasoning above come out the other way. A future
  // row that gives Bitbucket a tracker-side surface (or a consumer that needs
  // to inject `BitbucketHttp` from outside the engine) is the trigger to move
  // these onto the barrel and delete this block.
  './adapters/bitbucket/bitbucket-api': {
    RealBitbucketApi:
      'The Bitbucket Cloud landing adapter (LandingHost + LandingPosture, ADR-0023). Constructed only by the host-pr detect-host router; consumers reach it through the `host-pr` CLI verb group, never by importing it — unlike RealGitHubApi, which is also the GitHubIssuesStore API seam. See the block comment above.',
    createBitbucketApiFromEnv:
      'The CLI-edge factory for the adapter above (credential resolve + construction preflight). Its one call site is host-pr-cli\'s router; no consumer wiring path reaches it, because no IssueStore takes a Bitbucket API.',
    BitbucketApiFactoryOptions: 'The options type of the factory directly above — same reasoning, and unusable without it.',
    BitbucketApiError:
      "The adapter's typed non-2xx error. It never crosses the engine boundary: host-pr-cli catches every landing throw and prints `.message` into its JSON payload, so a consumer branches on the payload, not on this class.",
    BitbucketHttp:
      "The adapter-LOCAL network seam (ADR-0019 discipline — distinct from host-pr's cross-host HttpProbe, which IS root-exported). Injected by this adapter's own spec suite; the same standard FakeGitHubHttp/FakeLinearHttp are held to.",
    BitbucketHttpRequest: 'The request type of the adapter-local seam above — test-only, same reasoning.',
    BitbucketHttpResponse: 'The response type of the adapter-local seam above — test-only, same reasoning.',
    defaultBitbucketHttp:
      'The real-fetch implementation of the adapter-local seam above. It is the class\'s own default argument; a consumer that wanted it would already be constructing the adapter by hand, which is the path this block explains is not a supported one.',
    bitbucketAuthHeader:
      "Builds the Authorization header from the resolved credential (Basic email:token, or Bearer for an access token). A pure helper of the factory — exported so the spec can pin BOTH documented shapes without a network, not so a consumer can authenticate by hand.",
    bitbucketCreateCreds:
      "Builds the Basic user:secret pair `host-pr create` needs on Bitbucket, or throws the BITBUCKET_EMAIL instruction. Its one call site is host-pr-cli's create edge; exported for the same spec-pinning reason as bitbucketAuthHeader.",
    bitbucketBranchRestrictionApplies:
      "Decides whether one branch-restriction entry covers a branch (Bitbucket glob semantics, deliberately over-matching). Exported so its safety-critical over-match direction is spec-pinnable on its own; it is an internal step of the required-builds read, not a consumer question.",
    BITBUCKET_TOKEN_VAR:
      "The ambient credential variable name (ADR-0029 naming rule). A consumer SETS this variable in its settings env block — it never reads the constant, and host-pr's own error messages already name it verbatim.",
    BITBUCKET_EMAIL_VAR: 'The Basic-auth username variable name — same set-it-never-read-it reasoning as BITBUCKET_TOKEN_VAR directly above.',
  },
  './adapters/conformance/issue-store-conformance': {
    ConformanceHarness:
      "This module imports `vitest` (a devDependency of @formtrieb/flotilla-engine, never a runtime dependency) to register its suite via describe/it. Re-exporting anything from it at the package root would make `vitest` a load-time transitive import for EVERY installed-form consumer — package resolution would break for a consumer who never calls this symbol and has not installed vitest.",
    runIssueStoreConformance:
      'Same vitest-load-time reason as ConformanceHarness above — this function IS the describe/it registration call.',
  },
  './adapters/github/github-api-fake': {
    InMemoryGitHubApi:
      "In-memory test fake for this adapter's own conformance suite (github-api-fake.ts), not the public IssueStore-level testing surface — mirrors the Linear adapter's InMemoryLinearApi below, held to the same standard: a consumer testing against flotilla fakes at the IssueStore boundary, not this adapter-internal seam.",
    githubConformanceHooks:
      'Concrete conformance-hook fixture DATA for the fake above (not a type), analogous to linearConformanceHooks/markdownConformanceHooks — not a shipped consumer surface.',
  },
  './adapters/github/github-http-fake': {
    FakeGitHubHttp:
      "In-memory HTTP-seam test fake for this adapter's own spec suite — mirrors FakeLinearHttp below, held to the same standard.",
  },
  './adapters/issue-store': {
    classifyCreateInput:
      "Pre-existing, documented barrel decision, unchanged by this reconciliation (issue #376) — see the comment directly above the CreateInputError export block in index.ts. Every adapter's create() already runs this classifier first, so a consumer calling it by hand would be asking a question create() answers on its behalf; the typed rejection it produces (CreateInputError/CreateInputFailure) is exported, the classifier stays the seam.",
  },
  './adapters/linear/linear-api-fake': {
    InMemoryLinearApi:
      "In-memory test fake for this adapter's own conformance suite — not the public IssueStore-level testing surface.",
    linearConformanceHooks: 'Concrete conformance-hook fixture DATA for the fake above.',
  },
  './adapters/linear/linear-http-fake': {
    FakeLinearHttp: "In-memory HTTP-seam test fake for this adapter's own spec suite.",
    LinearHttpFakeHandler: 'The handler-function TYPE the fake above is configured with — test-only.',
    operationName:
      "GraphQL operation-name extraction used only by the fake's own request routing — test-only.",
  },
  './adapters/markdown-fs-store': {
    markdownConformanceHooks:
      "Concrete conformance-hook fixture DATA for MarkdownFsStore's own test suite — mirrors githubConformanceHooks/linearConformanceHooks, held to the same standard. MarkdownFsStore and MarkdownFsStoreOptions themselves ARE exported from the root.",
  },
  './cli-store': {
    engineManifestPath:
      'Pre-existing, documented barrel decision, unchanged by this reconciliation — see the comment above the readEngineVersion export block in index.ts. Every reading already carries the manifest it read as `manifestPath`; a root export would be a second way to ask one question.',
    engineVersionPreflightCheck:
      "Pre-existing, documented barrel decision, unchanged by this reconciliation — see the same comment block in index.ts. preflightStore's `expectedEngineVersion` option already appends exactly this check to its report; a standalone constructor here would be a second way to ask one question.",
  },
  './cli-utils': {
    flag: "Internal CLI argv-flag lookup (`--name value` extraction) for this engine's own verb parsers — not a consumer-facing API; a root-only consumer parses its own argv.",
    printJson: "Internal CLI stdout-JSON helper for this engine's own verb output — not a consumer-facing API.",
    describeConfigLoadError:
      "Internal CLI wave.config.json-load-error teaching helper (issue #505) for this engine's own verb runners — not a consumer-facing API; a root-only consumer wraps its own loadWaveConfig call.",
  },
  // ─── the finishing-outcome prUrl gate (issue #556) ──────────────────────
  //
  // Both symbols exist to serve ONE internal call site: `write-report`'s
  // post-write notice hook in route-cli.ts. A consumer reaches that gate the
  // way it reaches every other write-verb behaviour — by running the CLI verb
  // and reading the `notice:` line off stderr (the Scribe's documented exit-0
  // channel) — never by importing the predicate and calling it itself. The
  // enum a consumer legitimately reasons about is already root-exported as
  // WORKER_OUTCOME_VALUES; this is a partition of it, cut for the gate.
  //
  // Honest caveat, stated the way the Bitbucket block above states its own:
  // `src/index.ts` is outside this row's declared Files globs, so root-export
  // parity was not an option to weigh here even had the reasoning come out the
  // other way. A future row that gives a CONSUMER a reason to ask "is this
  // outcome a finishing one?" in its own code — a consumer-side driver, or a
  // second gate outside this engine — is the trigger to move these onto the
  // barrel and delete this block.
  './worker-report-schema': {
    FINISHING_OUTCOMES:
      "The `done`/`done-with-concerns` partition of WORKER_OUTCOME_VALUES (which IS root-exported). It exists so the sidecar-write gate and the schema's own anyOf branch read ONE set rather than two hand-kept lists; a consumer asking the same question already has outcomeToEvent(o) === 'worker-done'.",
    finishingReportLacksUsablePrUrl:
      "The gate predicate behind `write-report`'s exit-0 prUrl notice (ADR-0034: a rule earns its enforcement tier). Its single call site is route-cli.ts's postWriteNotice hook; consumers drive it through the `write-report` verb and read the `notice:` line, exactly as they drive the decorated-id normalization next to it.",
  },
};

// ─── the real check ────────────────────────────────────────────────────────

describe('barrel-drift — every engine source module export is root-reachable OR explicitly module-local allowlisted (issue #376)', () => {
  it('discovers a realistic number of engine source modules (a guard matching nothing is green for the wrong reason)', () => {
    expect(MODULE_RELATIVE_FILES.length).toBeGreaterThanOrEqual(50);
  });

  it('no module export is missing from BOTH the barrel and the allowlist', () => {
    const missing = findMissingExports(realProgram, realChecker, INDEX_PATH, MODULE_LABEL_TO_ABS_PATH);
    const violations = violationsAfterAllowlist(missing, MODULE_LOCAL_ALLOWLIST);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('every allowlist entry names a symbol that is ACTUALLY still an unreached module export (no stale entries)', () => {
    // The allowlist must be exactly the missing set, never a superset — a
    // stale entry (the symbol became root-reachable another way, was
    // renamed, or was removed) would silently mask a FUTURE real gap under
    // the same name once someone reintroduces one.
    const missing = findMissingExports(realProgram, realChecker, INDEX_PATH, MODULE_LABEL_TO_ABS_PATH);
    const missingKeys = new Set(missing.map((m) => `${m.modulePath}#${m.symbol}`));
    const stale: string[] = [];
    for (const [mod, entries] of Object.entries(MODULE_LOCAL_ALLOWLIST)) {
      for (const sym of Object.keys(entries)) {
        const key = `${mod}#${sym}`;
        if (!missingKeys.has(key)) stale.push(key);
      }
    }
    expect(stale, `stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry carries a real, non-trivial stated reason', () => {
    const empty: string[] = [];
    for (const [mod, entries] of Object.entries(MODULE_LOCAL_ALLOWLIST)) {
      for (const [sym, reason] of Object.entries(entries)) {
        if (typeof reason !== 'string' || reason.trim().length < 15) {
          empty.push(`${mod}#${sym}`);
        }
      }
    }
    expect(empty, `allowlist entries with no real reason: ${empty.join(', ')}`).toEqual([]);
  });
});

// ─── falsification (Convention 11): the check demonstrably CAN fail ───────
//
// A synthetic, throwaway TS program per test (mkdtempSync-backed, matching
// allowlist-scaffold-guard.spec.ts's own fixture technique) — never the real
// production `src/`. This is what lets this section prove the check's
// FAILING state without actually breaking a real module export (which would
// make the suite red for everyone else running it).

interface SyntheticProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  dir: string;
  paths: Record<string, string>;
}

/** Builds a tiny real (on-disk, in a temp dir) TS program from `files` —
 * `{ 'a.ts': '...source...' }`. Always clean up `dir` with `rmSync` in a
 * `finally`. */
function buildSyntheticProgram(files: Record<string, string>): SyntheticProgram {
  const dir = mkdtempSync(join(tmpdir(), 'barrel-drift-synthetic-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content);
    paths[name] = p;
  }
  const program = ts.createProgram({
    rootNames: Object.values(paths),
    options: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
    },
  });
  return { program, checker: program.getTypeChecker(), dir, paths };
}

describe('barrel-drift — falsification (Convention 11): the check fails on a genuine gap, and passes once closed', () => {
  it('a module export in neither the barrel nor the allowlist FAILS, naming the module and the symbol', () => {
    const synth = buildSyntheticProgram({
      'module-a.ts': 'export const foo = 1;\nexport const bar = 2;\n',
      'barrel.ts': "export { foo } from './module-a';\n",
    });
    try {
      const missing = findMissingExports(
        synth.program,
        synth.checker,
        synth.paths['barrel.ts'],
        new Map([['./module-a', synth.paths['module-a.ts']]]),
      );
      const violations = violationsAfterAllowlist(missing, {});
      expect(violations).toEqual([{ modulePath: './module-a', symbol: 'bar' }]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });

  it('...RESTORED green by re-exporting the missing symbol from the barrel', () => {
    const synth = buildSyntheticProgram({
      'module-a.ts': 'export const foo = 1;\nexport const bar = 2;\n',
      'barrel.ts': "export { foo, bar } from './module-a';\n",
    });
    try {
      const missing = findMissingExports(
        synth.program,
        synth.checker,
        synth.paths['barrel.ts'],
        new Map([['./module-a', synth.paths['module-a.ts']]]),
      );
      expect(violationsAfterAllowlist(missing, {})).toEqual([]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });

  it('...OR restored green by allowlisting it instead, without exporting it', () => {
    const synth = buildSyntheticProgram({
      'module-a.ts': 'export const foo = 1;\nexport const bar = 2;\n',
      'barrel.ts': "export { foo } from './module-a';\n",
    });
    try {
      const missing = findMissingExports(
        synth.program,
        synth.checker,
        synth.paths['barrel.ts'],
        new Map([['./module-a', synth.paths['module-a.ts']]]),
      );
      const allowlist = { './module-a': { bar: 'synthetic test-only local symbol' } };
      expect(violationsAfterAllowlist(missing, allowlist)).toEqual([]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });

  it('a NEW module with no barrel or allowlist coverage fails too — never silently skipped', () => {
    const synth = buildSyntheticProgram({
      'module-a.ts': 'export const foo = 1;\n',
      // module-b.ts is a brand-new module the barrel has never heard of —
      // the exact shape a future `src/` addition takes.
      'module-b.ts': 'export const baz = 3;\n',
      'barrel.ts': "export { foo } from './module-a';\n",
    });
    try {
      const modules = new Map([
        ['./module-a', synth.paths['module-a.ts']],
        // Discovered the same way fast-glob would discover it in real src/ —
        // nothing in the discovery mechanism singles module-b out.
        ['./module-b', synth.paths['module-b.ts']],
      ]);
      const missing = findMissingExports(synth.program, synth.checker, synth.paths['barrel.ts'], modules);
      const violations = violationsAfterAllowlist(missing, {});
      expect(violations).toEqual([{ modulePath: './module-b', symbol: 'baz' }]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });

  it('symbol-IDENTITY resolution: a module that re-exports ANOTHER module\'s symbol is satisfied by that symbol reaching the root under any name', () => {
    // The exact shape github-api.ts uses for ReportedCheck/RequiredChecksInfo/
    // etc.: `export type { X } from './host-like-module'` rather than its own
    // declaration. A NAME-only comparison could not tell this apart from a
    // second, unrelated declaration coincidentally sharing the name.
    const synth = buildSyntheticProgram({
      'canonical.ts': 'export const shared = 1;\n',
      're-exporter.ts': "export { shared } from './canonical';\n",
      'barrel.ts': "export { shared } from './canonical';\n", // only canonical's copy is exported
    });
    try {
      const modules = new Map([
        ['./canonical', synth.paths['canonical.ts']],
        ['./re-exporter', synth.paths['re-exporter.ts']],
      ]);
      const missing = findMissingExports(synth.program, synth.checker, synth.paths['barrel.ts'], modules);
      // re-exporter.ts's `shared` resolves (via alias) to the SAME symbol as
      // canonical.ts's — satisfied by the one root export, no violation.
      expect(violationsAfterAllowlist(missing, {})).toEqual([]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });

  it('...and the SAME check tells apart two DIFFERENT declarations that happen to share a name (the conflict-map/merge-order shape)', () => {
    const synth = buildSyntheticProgram({
      'module-x.ts': 'export function extractId(p: string): string { return p; }\n',
      'module-y.ts': 'export function extractId(p: string): string { return p + p; }\n',
      // Only module-x's copy is exported, aliased so both COULD coexist.
      'barrel.ts': "export { extractId as extractXId } from './module-x';\n",
    });
    try {
      const modules = new Map([
        ['./module-x', synth.paths['module-x.ts']],
        ['./module-y', synth.paths['module-y.ts']],
      ]);
      const missing = findMissingExports(synth.program, synth.checker, synth.paths['barrel.ts'], modules);
      // module-x's extractId is satisfied (under the alias); module-y's own,
      // DIFFERENT declaration of the same name is NOT — a name-only
      // comparison would have wrongly cleared both.
      expect(violationsAfterAllowlist(missing, {})).toEqual([
        { modulePath: './module-y', symbol: 'extractId' },
      ]);
    } finally {
      rmSync(synth.dir, { recursive: true, force: true });
    }
  });
});

// ─── AC4: a sample of the newly-reconciled symbols resolve by NAME, at RUNTIME, from the root ───

describe('barrel-drift — AC4: newly-reconciled symbols resolve by name from the package root at runtime', () => {
  it('functions and classes import as themselves — not undefined — across a spread of the families this reconciliation added', () => {
    expect(typeof armPullRequest).toBe('function'); // host-pr landing family
    expect(typeof GitHubIssuesStore).toBe('function'); // class — GitHub/Linear adapter parity
    expect(typeof MarkdownFsStore).toBe('function'); // class — the third shipped IssueStore impl
    expect(typeof createGitHubApiFromEnv).toBe('function');
    expect(typeof runRouteVerdict).toBe('function'); // the route-cli verb family
    expect(typeof sweepOrphanBranches).toBe('function'); // worktree-cleanup's second wave
    expect(typeof orderPrs).toBe('function'); // merge-order's lower-level primitive
    expect(typeof findRepoRoot).toBe('function'); // cli.ts's own walker
    expect(typeof LinearTransitionVerifyError).toBe('function'); // class extends Error
    expect(typeof renderConflictMap).toBe('function'); // wave-md-rw's writer family
    expect(DEFAULT_ELIGIBILITY).toBeDefined();
  });

  it('the ADR-0045 member-kind family resolves by name — rules, errors, mapping and pinned constants alike', () => {
    // The 578.2 lesson, applied in the same diff that adds the exports: a slice
    // can stay perfectly inside its Files globs and still leave every new symbol
    // unreachable from the package root, because the barrel is a SEPARATE
    // surface and every in-repo import resolves fine without it.
    expect(typeof goalMemberKind).toBe('function');
    expect(typeof requireGoalMemberKind).toBe('function');
    expect(typeof GoalMemberKindError).toBe('function'); // class extends Error
    expect(typeof GoalMemberJoinError).toBe('function');
    expect(GOAL_MEMBER_KIND_BY_CONTAINER).toBeDefined();
    expect(typeof PROJECT_BLOCKS_RELATION_TYPE).toBe('string');
    expect(typeof PROJECT_RELATION_ANCHOR_TYPE).toBe('string');

    // …and they BEHAVE like the modules' own bindings rather than merely
    // importing cleanly — the same standard the aliased pair below is held to.
    expect(goalMemberKind('initiative')).toBe('project');
    expect(goalMemberKind('milestone')).toBe('issue');
    expect(GOAL_MEMBER_KIND_BY_CONTAINER.initiative).toBe('project');
    expect(() =>
      requireGoalMemberKind({
        storeKind: 'linear',
        container: 'initiative',
        memberId: 'EX-1',
        isIssueShaped: () => true,
      }),
    ).toThrow(GoalMemberKindError);
  });

  // ─── the types this guard's own constraint deferred, now promoted ─────────
  //
  // This guard has a second-order effect worth naming where it is enforced: it
  // fails ANY new export in an engine module unless `index.ts` OR this file's
  // allowlist moves in the same diff. Both are outside most rows' declared
  // Files globs, so the in-glob move available to a row that adds a
  // public-surface TYPE is to leave it unexported — reachable through an
  // indexed spelling or an inline literal, nameable by nobody. Two rows landed
  // that way and filed the residue:
  //
  //   · the unaccounted-worktree reconciliation (ADR-0042 Decision 3) left
  //     `UnaccountedWorktree` / `UnaccountedWorktreeReport` module-local, root-
  //     reachable only as
  //     `NonNullable<WorktreeCountAdvisory['unaccounted']>['entries'][number]`;
  //   · the goal-seam row (ADR-0044 decision 4) left `store.goal` as an inline
  //     `{ container?: GoalContainer }` literal copied onto all three store-
  //     config variants rather than one named interface.
  //
  // Both are promoted in the diff that added this block, which is the row that
  // owns the barrel and this file at once. The assertions below are what a
  // TYPE can be held to at runtime — that a real value flows through the named
  // annotations — since `typeof` has nothing to look at once TS erases them;
  // the identity proofs (the named types ARE the previously-required spellings,
  // not lookalikes) live beside each type's own suite, in
  // worktree-cleanup.spec.ts and wave-config.spec.ts.
  it('the promoted TYPE-ONLY names annotate real values from the root — the surface a consumer signature needs', () => {
    const entry: UnaccountedWorktree = { path: '/elsewhere/x', branch: null, prunable: true };
    const report: UnaccountedWorktreeReport = {
      entries: [entry],
      level: 'advisory',
      notice: 'names every unaccounted path',
    };
    const advisory: WorktreeCountAdvisory = {
      count: 2,
      threshold: 12,
      level: 'ok',
      message: null,
      unaccounted: report,
    };
    const goal: StoreGoalConfig = { container: 'initiative' };

    expect(advisory.unaccounted?.entries[0]?.path).toBe('/elsewhere/x');
    expect(advisory.unaccounted?.level).toBe('advisory');
    expect(goal.container).toBe('initiative');
    // The optional role really is optional — "nothing declared" is a complete
    // value of the named type, not an incomplete one.
    const unbound: StoreGoalConfig = {};
    expect(unbound.container).toBeUndefined();
  });

  it('the aliased extractIssueId pair resolves to two DIFFERENT, genuinely importable bindings — not one shadowing the other', () => {
    expect(typeof extractConflictMapIssueId).toBe('function');
    expect(typeof extractMergeOrderIssueId).toBe('function');
    expect(extractConflictMapIssueId).not.toBe(extractMergeOrderIssueId);
    // Both actually work — proof the alias reconciliation didn't just import
    // cleanly but behaves like the module's own function.
    expect(extractConflictMapIssueId('.scratch/my-wave/issues/042-thing.md')).toBe('my-wave#042');
    expect(extractMergeOrderIssueId('.scratch/my-wave/issues/042-thing.md')).toBe('my-wave#042');
  });
});
