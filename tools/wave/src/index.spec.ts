/**
 * index.spec.ts — public-API pairing for the package barrel (`src/index.ts`).
 *
 * The KW-F4 pairing standard: every root-reachable symbol has a spec that
 * imports it FROM THE PACKAGE ROOT and asserts the pairing. Most of this repo's
 * pairings live beside their own module spec — see `wave-config.spec.ts`'s
 * "engine.cli is reachable from the PACKAGE ROOT" block, the closest precedent.
 * This file exists for the pairing whose module spec is a CLI-EDGE spec:
 * `cli-store.spec.ts` is about probe output and exit codes, and a root-import
 * assertion buried there reads as a stray rather than as the contract it is. It
 * is also where a pairing spanning more than one module belongs.
 *
 * The pairing has two halves and both are load-bearing:
 *
 *   - COMPILE TIME — the barrel really re-exports the TYPES. `tsc --noEmit` is
 *     the assertion; an annotation naming a type the barrel does not re-export
 *     is the failure, and it fails HERE instead of in a consumer's build.
 *   - RUNTIME — the root-imported values are the SAME bindings, not lookalikes.
 *     `toBe` on function identity is what makes a second implementation behind
 *     the barrel impossible to hide: a re-export that drifted into a wrapper,
 *     or a barrel pointing at a stale copy of the module, fails this and
 *     nothing else would.
 *
 * A pairing that only imported from the root and re-asserted the module spec's
 * own behaviour would be vacuous — it would pass against a barrel re-exporting
 * a lookalike. The identity assertions are what give the behaviour tests below
 * their meaning: they run against the root import, and the root import is
 * proven to be the module's own binding.
 *
 * A THIRD half joined the two above with the command-line advisory family
 * (issue #338): the ENUMERATION probe. A named import can only prove that the
 * names it asks for are present — it is structurally blind to a name that is
 * ABSENT (nobody wrote the import) and to a stowaway that rode along (nobody
 * would have named it). Reading the export block instead of running it is the
 * same blindness with an extra step, since a block can list a name the barrel
 * does not actually re-bind. So the root surface is also inspected as a runtime
 * namespace object, and the claim asserted there is a DELTA against a recorded
 * baseline — which is the only form in which "nothing else rode along" is
 * checkable at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The bindings as the MODULE FILE defines them...
import {
  readEngineVersion,
  compareEngineVersion,
  engineVersionExitCode,
  // …plus the store-preflight family, the second root-surface decision this
  // file pins (issue #325).
  resolveStore,
  preflightStore,
  runStorePreflight,
  runStorePreflightSubcommand,
} from './cli-store';

// The typed create rejection lives in the ADAPTERS layer, not beside the
// preflight — the third module this pairing spans, and the reason the pairing
// belongs in this file rather than beside either module's own spec. The
// classifier is imported deliberately: it is NOT public API, so this spec throws
// through the module-internal thrower and catches with the ROOT-imported class,
// which is the contract a consumer actually depends on.
import { classifyCreateInput, CreateInputError } from './adapters/issue-store';

// The E2BIG advisory pair as the MODULE FILE defines it (issue #338). Both
// terms are imported, not just the new one: the defect this slice closes is an
// ASYMMETRY between them, so a spec that only knew about the command-line term
// could not state it.
// `MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES` joins them (issue #357): the
// per-string term is the THIRD term of the same budget, and the one the barrel
// missed because the command-line row was authored before the sibling existed.
import {
  measureExecArgumentBytes,
  checkCommandLineSizeAdvisory,
  COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
  MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
  checkWorktreeCountAdvisory,
  WORKTREE_COUNT_ADVISORY_THRESHOLD,
} from './worktree-cleanup';

// The human-lane family as the MODULE FILE defines it (issue #323, ADR-0012).
// All three are imported, not just the predicate: the constant is what the
// skills' worker literal is drift-pinned against, and a root that shipped the
// readers without it would leave an out-of-tree caller re-typing the token.
// `readSpine`/`renderSpine`/`setRowState` ride along so the ROOT-ONLY story
// below can build and mutate a real spine without importing the module.
import {
  HUMAN_GATED_WORKER,
  humanGatedRows,
  humanHeldRowIds,
} from './wave-md-rw';

// The surfaces as NAMESPACE OBJECTS, for the enumeration probe. `./index` is
// the surface under test; `./worktree-cleanup` and `./wave-md-rw` are the
// modules whose export blocks the two enumerated slices edit, and comparing
// bindings by identity across them is what makes "which root names does THIS
// module own?" a runtime question instead of a reading of the barrel's source.
import * as rootNamespace from './index';
import * as worktreeCleanupNamespace from './worktree-cleanup';
import * as waveMdRwNamespace from './wave-md-rw';

// ...and the same surface as the PACKAGE ROOT offers it. Aliased so the two can
// be compared in one file; `package.json`'s `main` is `./src/index.ts`, so this
// import is the literal thing an npm consumer's `from '@formtrieb/flotilla-engine'`
// resolves to.
import {
  readEngineVersion as readEngineVersionFromRoot,
  compareEngineVersion as compareEngineVersionFromRoot,
  engineVersionExitCode as engineVersionExitCodeFromRoot,
  type EngineVersionReading as EngineVersionReadingFromRoot,
  type EngineVersionOutcome as EngineVersionOutcomeFromRoot,
  type EngineVersionReport as EngineVersionReportFromRoot,
  // issue #325 — the store-preflight family…
  resolveStore as resolveStoreFromRoot,
  preflightStore as preflightStoreFromRoot,
  runStorePreflight as runStorePreflightFromRoot,
  runStorePreflightSubcommand as runStorePreflightSubcommandFromRoot,
  type PreflightCheck as PreflightCheckFromRoot,
  type StorePreflightReport as StorePreflightReportFromRoot,
  type StorePreflightOptions as StorePreflightOptionsFromRoot,
  // …and the typed create rejection.
  CreateInputError as CreateInputErrorFromRoot,
  type CreateInputFailure as CreateInputFailureFromRoot,
  // Already public before this slice; used here to keep the two new stories
  // ROOT-ONLY, so neither has to name a type the barrel does not offer.
  buildStore as buildStoreFromRoot,
  type WaveConfig as WaveConfigFromRoot,
  // issue #338 — the command-line advisory family, plus the count-advisory pair
  // it was asymmetric with. The count side was already root-reachable before
  // this slice; it is named here so the closed asymmetry can be asserted from
  // ONE import list rather than inferred across two spec files.
  measureExecArgumentBytes as measureExecArgumentBytesFromRoot,
  checkCommandLineSizeAdvisory as checkCommandLineSizeAdvisoryFromRoot,
  COMMAND_LINE_ADVISORY_THRESHOLD_BYTES as COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
  // issue #357 — the PER-STRING threshold, the one term of this family the
  // barrel above missed. Named from the root here because that is the whole
  // claim: a consumer that cannot import it cannot perform the comparison the
  // advisory's own message instructs it to perform.
  MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES as MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
  checkWorktreeCountAdvisory as checkWorktreeCountAdvisoryFromRoot,
  WORKTREE_COUNT_ADVISORY_THRESHOLD as WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT,
  type ExecArgumentMeasurement as ExecArgumentMeasurementFromRoot,
  type CommandLineSizeAdvisory as CommandLineSizeAdvisoryFromRoot,
  type CommandLineSizeAdvisoryOptions as CommandLineSizeAdvisoryOptionsFromRoot,
  // issue #323 — the human lane (ADR-0012). The spine reader/renderer/mutator
  // are named here (they were already root-reachable) so the ROOT-ONLY story
  // below can run the whole hold-decision job without importing wave-md-rw.
  HUMAN_GATED_WORKER as HUMAN_GATED_WORKER_FROM_ROOT,
  humanGatedRows as humanGatedRowsFromRoot,
  humanHeldRowIds as humanHeldRowIdsFromRoot,
  readSpine as readSpineFromRoot,
  renderSpine as renderSpineFromRoot,
  setRowState as setRowStateFromRoot,
  ROW_STATES as ROW_STATES_FROM_ROOT,
  type PlanTableRow as PlanTableRowFromRoot,
  type RowState as RowStateFromRoot,
  type Spine as SpineFromRoot,
} from './index';

/** Write a package manifest to a fresh tmp dir and hand back its path. */
function manifestAt(pkg: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), 'engine-version-')), 'package.json');
  writeFileSync(path, JSON.stringify(pkg), 'utf8');
  return path;
}

describe('the engine-version surface is reachable from the PACKAGE ROOT (ADR-0032)', () => {
  it('re-exports the same function bindings, not lookalikes', () => {
    expect(readEngineVersionFromRoot).toBe(readEngineVersion);
    expect(compareEngineVersionFromRoot).toBe(compareEngineVersion);
    expect(engineVersionExitCodeFromRoot).toBe(engineVersionExitCode);
  });

  it('re-exports the result types, so a root-only consumer can annotate them', () => {
    // Compile-time half — these annotations resolve only if the barrel really
    // re-exports the types. `tsc --noEmit` is the assertion; the runtime
    // expectations below just keep the values from being dead code.
    const reading: EngineVersionReadingFromRoot = {
      version: '0.1.0-beta.1',
      packageName: '@formtrieb/flotilla-engine',
      manifestPath: '/somewhere/package.json',
      unreadable: null,
    };
    const report: EngineVersionReportFromRoot = compareEngineVersionFromRoot(
      '0.1.0-beta.1',
      reading,
    );
    const outcome: EngineVersionOutcomeFromRoot = report.outcome;

    expect(reading.manifestPath).toBe('/somewhere/package.json');
    expect(outcome).toBe('match');
  });

  it('re-exports the outcome union WHOLE, so it can be switched on exhaustively', () => {
    // The `never` arm is the real assertion and it is a compile-time one: it
    // typechecks only while the root-imported union has exactly these five
    // members. A sixth outcome added in cli-store.ts — or a barrel re-export
    // that narrowed the union on its way out — fails `tsc` right here.
    const label = (o: EngineVersionOutcomeFromRoot): string => {
      switch (o) {
        case 'match':
          return 'in lockstep';
        case 'mismatch':
          return 'skewed';
        case 'no-expectation':
          return 'nothing compared';
        case 'engine-version-unreadable':
          return 'engine side unreadable';
        case 'expectation-unusable':
          return 'expectation unusable';
        default: {
          const exhaustive: never = o;
          return exhaustive;
        }
      }
    };
    expect(label('match')).toBe('in lockstep');
    expect(label('expectation-unusable')).toBe('expectation unusable');
  });
});

describe('a ROOT-ONLY consumer can run the whole lockstep job', () => {
  it('read → compare → exit code, importing nothing but the package root', () => {
    const path = manifestAt({
      name: '@formtrieb/flotilla-engine',
      version: '0.1.0-beta.1',
    });

    const reading = readEngineVersionFromRoot(path);
    expect(reading.version).toBe('0.1.0-beta.1');
    expect(reading.packageName).toBe('@formtrieb/flotilla-engine');
    expect(reading.manifestPath).toBe(path);
    expect(reading.unreadable).toBeNull();

    const inLockstep = compareEngineVersionFromRoot('0.1.0-beta.1', reading);
    expect(inLockstep.outcome).toBe('match');
    expect(inLockstep.match).toBe(true);
    expect(inLockstep.repair).toBeNull();
    expect(engineVersionExitCodeFromRoot(inLockstep)).toBe(0);

    const skewed = compareEngineVersionFromRoot('0.1.0-beta.2', reading);
    expect(skewed.outcome).toBe('mismatch');
    expect(skewed.match).toBe(false);
    // The repair is quoted by callers rather than re-derived (single-owner),
    // so a root consumer must get the SAME line the CLI prints.
    expect(skewed.repair).toBe('npm i -D @formtrieb/flotilla-engine@0.1.0-beta.2');
    expect(engineVersionExitCodeFromRoot(skewed)).toBe(1);
  });

  it('carries the non-vacuity guarantees across the barrel unchanged', () => {
    // An unreadable engine side is a NON-MATCH, never a pass — the property the
    // whole gate rests on. If the barrel ever re-exported something weaker,
    // this is where a root consumer's silently-green gate would surface.
    const gone = readEngineVersionFromRoot('/nonexistent/definitely-not-here/package.json');
    expect(gone.version).toBeNull();
    const unreadable = compareEngineVersionFromRoot('0.1.0-beta.1', gone);
    expect(unreadable.match).toBe(false);
    expect(unreadable.outcome).toBe('engine-version-unreadable');
    expect(engineVersionExitCodeFromRoot(unreadable)).toBe(1);

    // A blank expectation is a caller whose lookup produced nothing, not a
    // request to skip the check.
    const blank = compareEngineVersionFromRoot('   ', gone);
    expect(blank.match).toBe(false);
    expect(blank.outcome).toBe('expectation-unusable');
    expect(engineVersionExitCodeFromRoot(blank)).toBe(1);

    // And "nothing was compared" stays distinguishable from "compared and
    // equal": `match` is null, not true.
    const nothing = compareEngineVersionFromRoot(
      undefined,
      readEngineVersionFromRoot(manifestAt({ name: 'x', version: '9.9.9' })),
    );
    expect(nothing.match).toBeNull();
    expect(nothing.outcome).toBe('no-expectation');
    expect(engineVersionExitCodeFromRoot(nothing)).toBe(0);
  });

  it('defaults to THIS package\'s own manifest when handed no path', () => {
    // The zero-argument form is what a consumer asking "what version is the
    // engine I installed?" actually calls. It must answer about the engine
    // package, not about the consumer's own manifest — the reading names the
    // file it read, so the answer is checkable rather than trusted.
    const reading = readEngineVersionFromRoot();
    expect(reading.manifestPath.replace(/\\/g, '/')).toMatch(/\/package\.json$/);
    expect(reading.packageName).toBe('@formtrieb/flotilla-engine');
    expect(reading.unreadable).toBeNull();
    expect(reading.version).not.toBeNull();
  });
});

// ─── issue #325 — the STORE-PREFLIGHT family reaches the package root ─────────
//
// The recorded decision lives at both definition sites (`cli-store.ts`'s module
// header and `src/index.ts`'s export block); this is its enforcement. The
// markdown store kind is used throughout because its preflight is the one that
// touches no api at all — the probe is pure over the seam, which is half the
// reason the family is public.

/** A markdown-store config: the store kind whose preflight reaches no tracker. */
function markdownConfig(): WaveConfigFromRoot {
  return {
    store: {
      kind: 'markdown',
      repoRoot: mkdtempSync(join(tmpdir(), 'root-store-preflight-')),
      slug: '2026-07-31-root-surface',
    },
  };
}

/** Run `fn` with `process.stdout.write` captured, and hand back what it wrote. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('the store-preflight family is reachable from the PACKAGE ROOT (issue #325)', () => {
  it('re-exports the same function bindings, not lookalikes', () => {
    expect(resolveStoreFromRoot).toBe(resolveStore);
    expect(preflightStoreFromRoot).toBe(preflightStore);
    expect(runStorePreflightFromRoot).toBe(runStorePreflight);
    expect(runStorePreflightSubcommandFromRoot).toBe(runStorePreflightSubcommand);
  });

  it('the identity assertion is exactly what a behaviourally-identical WRAPPER fails', async () => {
    // Non-vacuity, demonstrated rather than asserted in a comment. `wrapper`
    // delegates to the real probe, so EVERY behavioural expectation in this file
    // passes against it — same report object, same `ok`, same check names, same
    // exit codes downstream. Only `toBe` separates them, which is why the
    // identity half of the pairing carries the weight: a re-export that drifted
    // into a wrapper, or a barrel pointing at a stale copy of the module, fails
    // there and at nothing else.
    const wrapper: typeof preflightStore = (config, store, opts) =>
      preflightStore(config, store, opts);

    const config = markdownConfig();
    const store = buildStoreFromRoot(config);
    expect(await wrapper(config, store)).toEqual(await preflightStoreFromRoot(config, store));
    expect(wrapper).not.toBe(preflightStoreFromRoot);
    expect(preflightStoreFromRoot).toBe(preflightStore);
  });

  it('re-exports the report, check and options types, so a root-only consumer can annotate them', async () => {
    // Compile-time half — these annotations resolve only if the barrel really
    // re-exports the types; `tsc --noEmit` is the assertion.
    const config = markdownConfig();
    const store = buildStoreFromRoot(config);
    const opts: StorePreflightOptionsFromRoot = { expectedEngineVersion: '0.0.0-not-this-one' };

    const report: StorePreflightReportFromRoot = await preflightStoreFromRoot(config, store, opts);
    const checks: PreflightCheckFromRoot[] = report.checks;

    expect(report.storeKind).toBe('markdown');
    expect(checks.map((c) => c.name)).toEqual([
      'tracker-host-integration',
      'state-catalog',
      'engine-version',
    ]);
    // The lockstep row is ADVISORY by construction, so a skew never moves `ok` —
    // the guarantee a root consumer inherits along with the option.
    expect(checks.find((c) => c.name === 'engine-version')?.status).toBe('advisory');
    expect(report.ok).toBe(true);

    // `status` is `CheckStatus`, owned by host-pr and deliberately NOT given a
    // second root name: indexed access already reaches it, and this line is the
    // proof that it does.
    const status: PreflightCheckFromRoot['status'] = 'not-applicable';
    expect(status).toBe('not-applicable');
  });

  it('re-exports the check-name union WHOLE, so it can be switched on exhaustively', () => {
    // The `never` arm is the real assertion and it is a compile-time one: it
    // typechecks only while the root-imported union has exactly these three
    // members. A fourth check name added in cli-store.ts — or a barrel re-export
    // that narrowed the union on its way out — fails `tsc` right here.
    const label = (name: PreflightCheckFromRoot['name']): string => {
      switch (name) {
        case 'tracker-host-integration':
          return 'tracker↔host';
        case 'state-catalog':
          return 'workflow states';
        case 'engine-version':
          return 'plugin/engine lockstep';
        default: {
          const exhaustive: never = name;
          return exhaustive;
        }
      }
    };
    expect(label('state-catalog')).toBe('workflow states');
    expect(label('engine-version')).toBe('plugin/engine lockstep');
  });
});

describe('a ROOT-ONLY consumer can run the whole store-preflight job', () => {
  it('resolveStore hands back an injected store untouched, so a fake can be probed', async () => {
    // The impure edge, exercised on its ONE pure path: an injected store
    // short-circuits before any config read or api factory call, which is what
    // makes `resolveStore` usable from a test or an embedding consumer at all.
    const injected = buildStoreFromRoot(markdownConfig());
    const resolved = await resolveStoreFromRoot(
      ['--config', '/nonexistent/definitely-not-here/wave.config.json'],
      injected,
    );
    expect(resolved).toBe(injected);
  });

  it('runs the verb and its router spelling, importing nothing but the package root', async () => {
    const config = markdownConfig();
    const path = join(mkdtempSync(join(tmpdir(), 'root-store-preflight-cfg-')), 'wave.config.json');
    writeFileSync(path, JSON.stringify(config), 'utf8');
    const store = buildStoreFromRoot(config);

    let standaloneCode = -1;
    const standaloneOut = await captureStdout(async () => {
      standaloneCode = await runStorePreflightFromRoot(['preflight', '--config', path], store);
    });
    expect(standaloneCode).toBe(0);
    const printed = JSON.parse(standaloneOut) as StorePreflightReportFromRoot;
    expect(printed.ok).toBe(true);
    expect(printed.storeKind).toBe('markdown');

    // The router-facing spelling: there the SUBCOMMAND NAME is already the op,
    // so the `preflight` token is the shim's to add and not the caller's. Both
    // names ship from the root precisely so an embedding consumer picks the arg
    // shape it already holds — and the two must be indistinguishable in output
    // and exit code, since the shim adds no logic.
    let shimCode = -1;
    const shimOut = await captureStdout(async () => {
      shimCode = await runStorePreflightSubcommandFromRoot(['--config', path], store);
    });
    expect(shimCode).toBe(standaloneCode);
    expect(JSON.parse(shimOut)).toEqual(printed);
  });
});

// ─── issue #325 — the TYPED CREATE REJECTION reaches the package root ─────────

/**
 * A BARE filing carrying no authored body — the rejection every adapter's
 * `create()` raises before minting an id or touching disk. Deliberately typed by
 * inference rather than by an imported `CreateInput`: a root-only consumer does
 * not have that name, and this story must stay runnable without it.
 */
const BODYLESS_BARE = {
  title: 'a bare filing with no authored body',
  filingHint: 'bare-without-body',
};

describe('the typed create rejection is reachable from the PACKAGE ROOT (issue #325)', () => {
  it('re-exports the same class binding, so `instanceof` matches across the barrel', () => {
    expect(CreateInputErrorFromRoot).toBe(CreateInputError);

    // The claim the export exists for: the error the ADAPTERS LAYER throws is
    // recognised by the class a ROOT-ONLY consumer imported. A barrel that
    // re-declared the class rather than re-exporting it would still produce an
    // Error with the same message and the same `failure` field — and this
    // assertion is the only one that would notice.
    expect(() => classifyCreateInput(BODYLESS_BARE)).toThrow(CreateInputErrorFromRoot);
  });

  it('the identity assertion is exactly what a behaviourally-identical SUBCLASS fails', () => {
    // The wrapper demonstration in the shape this family would actually drift
    // into. A subclass carries the same `failure`, `fields`, `code`, message and
    // stack, and even passes `instanceof` against the root-imported base — so
    // every behavioural assertion in this block holds for it. It is not the base
    // binding, and `toBe` is the only thing that says so.
    class Lookalike extends CreateInputError {}
    const impostor = new Lookalike('bare-without-body', ['bodySections'], 'same message');

    expect(impostor).toBeInstanceOf(CreateInputErrorFromRoot);
    expect(impostor.failure).toBe('bare-without-body');
    expect(impostor.code).toBe('create-input-invalid');
    expect(Lookalike).not.toBe(CreateInputErrorFromRoot);
  });

  it('a root consumer routes on the DISCRIMINANT, never on the message', () => {
    let routed: CreateInputFailureFromRoot | 'not-a-create-rejection' = 'not-a-create-rejection';
    let fields: readonly string[] = [];
    try {
      classifyCreateInput(BODYLESS_BARE);
    } catch (err) {
      if (err instanceof CreateInputErrorFromRoot) {
        routed = err.failure;
        fields = err.fields;
      }
    }
    expect(routed).toBe('bare-without-body');
    expect(fields).toEqual(['bodySections']);
  });

  it('re-exports the failure union WHOLE, so it can be switched on exhaustively', () => {
    // Compile-time assertion, same shape as the check-name union above: a fourth
    // `CreateInputFailure` member — or a barrel re-export that narrowed the
    // union — fails `tsc` at the `never` arm.
    const label = (failure: CreateInputFailureFromRoot): string => {
      switch (failure) {
        case 'header-block-half-written':
          return 'half-written Header-Block';
        case 'bare-carries-decoration-only-fields':
          return 'decoration-only stowaway on a bare input';
        case 'bare-without-body':
          return 'bare input with no authored body';
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
      }
    };
    expect(label('bare-without-body')).toBe('bare input with no authored body');
    expect(label('header-block-half-written')).toBe('half-written Header-Block');
  });

  it('the rejection is INHERITED: a root-built store rejects before it writes anything', async () => {
    // The end-to-end story, and the reason the classifier itself stays internal.
    // Nothing here names the adapters module: `buildStore` and `CreateInputError`
    // are both root names, the input is an inline literal, and the store points
    // at a directory that was never created — so a rejection arriving AFTER a
    // write would surface as a filesystem error rather than pass quietly.
    const store = buildStoreFromRoot({
      store: {
        kind: 'markdown',
        repoRoot: join(tmpdir(), 'root-create-rejection-never-created'),
        slug: '2026-07-31-root-surface',
      },
    });

    await expect(store.create({ ...BODYLESS_BARE })).rejects.toBeInstanceOf(
      CreateInputErrorFromRoot,
    );
  });
});

// ─── issue #338 — the COMMAND-LINE ADVISORY family reaches the package root ────
//
// The E2BIG budget has TWO terms (issue #266): the registered-worktree count
// that the harness turns into sandbox deny paths, and the command line the
// spawn itself carries. Before this slice the package root shipped the FIRST
// term whole (`checkWorktreeCountAdvisory` + `WORKTREE_COUNT_ADVISORY_THRESHOLD`,
// issue #250) and none of the second — while the first term's own advisory text
// tells its reader, in so many words, that a count under threshold is not an
// all-clear and names `checkCommandLineSizeAdvisory` as the thing to measure
// next. A root-only consumer therefore received the correction's premise and
// could not reach the correction: it reproduced exactly the one-term mismeasure
// the second term exists to end.
//
// Three assertions carry this block, and they are different in kind:
//
//   - IDENTITY, per name — the root binding IS the module's binding (the
//     file-header pairing standard).
//   - COMPILE TIME — the three result types really cross the barrel; `tsc
//     --noEmit` is the assertion.
//   - ENUMERATION — the root's runtime namespace is inspected as data. This is
//     the only one of the three that can see an ABSENT name or a stowaway,
//     because a named import cannot fail to mention what nobody thought to
//     import, and an export block can list a name it does not actually re-bind.

/**
 * The root surface as DATA. A module namespace object's own enumerable keys are
 * exactly its runtime (value) exports — types are erased, which is why the type
 * half of this family is pinned by annotation above rather than counted here.
 */
const rootExports = rootNamespace as unknown as Record<string, unknown>;

/** The same, for the module whose export block this slice edits. */
const worktreeCleanupExports = worktreeCleanupNamespace as unknown as Record<
  string,
  unknown
>;

/** …and for the human lane's module (issue #323). */
const waveMdRwExports = waveMdRwNamespace as unknown as Record<string, unknown>;

/**
 * Which root names does `./worktree-cleanup` OWN? Answered by binding identity,
 * never by name: a root name that merely collided with a worktree-cleanup name
 * while pointing at some other module's value is not a re-export, and would be
 * counted as one by a name-only match.
 */
function rootNamesOwnedByWorktreeCleanup(): string[] {
  return Object.keys(worktreeCleanupExports)
    .filter(
      (name) =>
        Object.hasOwn(rootExports, name) &&
        rootExports[name] === worktreeCleanupExports[name],
    )
    .sort();
}

/** The same question, asked of `./wave-md-rw` (issue #323). */
function rootNamesOwnedByWaveMdRw(): string[] {
  return Object.keys(waveMdRwExports)
    .filter(
      (name) =>
        Object.hasOwn(rootExports, name) &&
        rootExports[name] === waveMdRwExports[name],
    )
    .sort();
}

/**
 * The worktree-cleanup names the root re-exported BEFORE this slice, recorded
 * from the wave anchor commit by running the same enumeration this spec runs.
 * It is a baseline, not a wish list: the delta assertions below are what turn
 * "exactly the named family was added" into a checkable claim, and no smaller
 * form of this check can make it — a probe with nothing to subtract from can
 * only ever say "these names are present".
 */
const WORKTREE_CLEANUP_NAMES_AT_ROOT_BEFORE = [
  'DEFAULT_AGENT_PATH_MARKERS',
  'WORKTREE_COUNT_ADVISORY_THRESHOLD',
  'checkWorktreeCountAdvisory',
  'cleanAgentWorktrees',
  'defaultWorktreeRemover',
  'executeCleanup',
  'listAgentWorktrees',
  'listDetachedScratchpadWorktrees',
  'normalizeDisposableNames',
  'parseWorktreeList',
  'planCleanup',
  'planDetachedScratchpadSweep',
  'sweepDetachedScratchpadWorktrees',
];

/** The value half of the family issue #338 adds — sorted, as the probe sorts. */
const COMMAND_LINE_FAMILY_ADDED_AT_ROOT = [
  'COMMAND_LINE_ADVISORY_THRESHOLD_BYTES',
  'checkCommandLineSizeAdvisory',
  'measureExecArgumentBytes',
];

/**
 * The value half of the term issue #357 adds — the PER-STRING threshold, kept
 * as its OWN family rather than appended to the list above even though both
 * belong to one advisory. The list above records what issue #338 decided at its
 * anchor, and that decision was complete for the family as it stood then: the
 * per-string sibling did not exist in the module yet. Folding this name into it
 * would rewrite that history into "issue #338 shipped four names", and the next
 * reader would lose the one fact this gap is evidence for — that a barrel row
 * authored at an anchor goes stale against a module that grew after it.
 *
 * Exactly one name, and the singleton is the claim, not an accident of
 * bookkeeping: the per-string term has no entry point of its own. It is measured
 * by `measureExecArgumentBytes` and checked by `checkCommandLineSizeAdvisory`,
 * both already root-reachable, so a second added name here would mean something
 * beyond the recorded decision rode along.
 */
const MAX_ARG_STRLEN_TERM_ADDED_AT_ROOT = ['MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES'];

/**
 * The `wave-md-rw` names the root re-exported BEFORE issue #323, recorded the
 * same way and for the same reason as the worktree-cleanup baseline above:
 * `wave-md-rw` exports far more than the barrel re-exports (every targeted
 * writer and every parser helper), so "one more name slipped into the export
 * block" is a live way to be wrong here too.
 */
const WAVE_MD_RW_NAMES_AT_ROOT_BEFORE = [
  'ROW_STATES',
  'branchesByIssueId',
  'readSpine',
  'renderSpine',
  'replaceClosedByBlock',
  'setRowPrCell',
  'setRowState',
  'upsertDispatchLogEntry',
  'upsertDispatchLogModel',
  'upsertPrLogRow',
];

/** The value half of the family issue #323 adds — sorted, as the probe sorts. */
const HUMAN_LANE_FAMILY_ADDED_AT_ROOT = [
  'HUMAN_GATED_WORKER',
  'humanGatedRows',
  'humanHeldRowIds',
];

/**
 * How many runtime names the package root carried before this slice, recorded
 * the same way. This is the widest net in the file: it catches a stowaway from
 * ANY module, including one that has nothing to do with worktree-cleanup.
 *
 * A later slice that deliberately adds a root export updates this number, and
 * that is the check working rather than a false positive — every addition to
 * this barrel is a recorded decision (see the export block's own comments), so
 * a root-surface change that could land without anyone typing a number here is
 * precisely the change nobody would have reviewed.
 */
const ROOT_RUNTIME_EXPORT_COUNT_BEFORE = 135;

/**
 * The whole-root total as of the newest recorded slice. Deliberately written as
 * ARITHMETIC over the per-slice families rather than as a fresh absolute number:
 * `135` stays anchored to the commit it was measured at, and each later slice
 * appends its own family's length, so the expression keeps saying WHICH decision
 * each addition belongs to. Re-typing an absolute total would erase exactly
 * that, and the next reader would have no way to tell an intended growth from a
 * stowaway that had already been absorbed into the number.
 */
const ROOT_RUNTIME_EXPORT_COUNT_NOW =
  ROOT_RUNTIME_EXPORT_COUNT_BEFORE +
  COMMAND_LINE_FAMILY_ADDED_AT_ROOT.length +
  HUMAN_LANE_FAMILY_ADDED_AT_ROOT.length +
  MAX_ARG_STRLEN_TERM_ADDED_AT_ROOT.length;

describe('the command-line advisory family is reachable from the PACKAGE ROOT (issue #338)', () => {
  it('re-exports the same bindings, not lookalikes', () => {
    expect(measureExecArgumentBytesFromRoot).toBe(measureExecArgumentBytes);
    expect(checkCommandLineSizeAdvisoryFromRoot).toBe(checkCommandLineSizeAdvisory);
    expect(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT).toBe(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
    );
  });

  it('the identity assertion is exactly what a behaviourally-identical WRAPPER fails', () => {
    // Same non-vacuity demonstration the store-preflight block above makes, for
    // the same reason: `wrapper` delegates, so every behavioural expectation in
    // this block passes against it — same advisory object, same level, same
    // message, same threshold. Only `toBe` separates them.
    const wrapper: typeof checkCommandLineSizeAdvisory = (opts) =>
      checkCommandLineSizeAdvisory(opts);

    const opts = { argv: ['node', 'x'], env: {}, threshold: 0 };
    expect(wrapper(opts)).toEqual(checkCommandLineSizeAdvisoryFromRoot(opts));
    expect(wrapper).not.toBe(checkCommandLineSizeAdvisoryFromRoot);
    expect(checkCommandLineSizeAdvisoryFromRoot).toBe(checkCommandLineSizeAdvisory);
  });

  it('re-exports the measurement, advisory and options types, so a root-only consumer can annotate them', () => {
    // Compile-time half — these annotations resolve only if the barrel really
    // re-exports the types; `tsc --noEmit` is the assertion, and the runtime
    // expectations below just keep the values from being dead code.
    const measurement: ExecArgumentMeasurementFromRoot =
      measureExecArgumentBytesFromRoot(['node', 'cli.ts'], { PATH: '/usr/bin' });
    expect(measurement.argCount).toBe(2);
    expect(measurement.envCount).toBe(1);
    expect(measurement.bytes).toBe(measurement.argvBytes + measurement.envBytes);

    const opts: CommandLineSizeAdvisoryOptionsFromRoot = {
      argv: ['node', 'cli.ts'],
      env: {},
      threshold: COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    };
    const advisory: CommandLineSizeAdvisoryFromRoot =
      checkCommandLineSizeAdvisoryFromRoot(opts);
    expect(advisory.level).toBe('ok');
    expect(advisory.message).toBeNull();
    expect(advisory.threshold).toBe(524_288);
  });

  it('re-exports the level union WHOLE, so it can be switched on exhaustively', () => {
    // The `never` arm is the real assertion and it is a compile-time one: it
    // typechecks only while the root-imported union has exactly these two
    // members. A third level added in worktree-cleanup.ts — or a barrel
    // re-export that narrowed the union on its way out — fails `tsc` here.
    const label = (level: CommandLineSizeAdvisoryFromRoot['level']): string => {
      switch (level) {
        case 'ok':
          return 'under budget';
        case 'advisory':
          return 'over budget';
        default: {
          const exhaustive: never = level;
          return exhaustive;
        }
      }
    };
    expect(label('ok')).toBe('under budget');
    expect(label('advisory')).toBe('over budget');
  });
});

describe('a ROOT-ONLY consumer can measure the command-line term end to end (issue #338)', () => {
  it('measure → check → act, importing nothing but the package root', () => {
    // The preflight form: a command line the consumer is ABOUT to spawn, which
    // is why the measurement ships beside the check. Nothing here reads
    // `process.argv`, so the story is deterministic.
    const body = 'x'.repeat(600_000);
    const argv = ['node', 'cli.ts', `--body=${body}`];

    const measurement = measureExecArgumentBytesFromRoot(argv, {});
    expect(measurement.argCount).toBe(3);
    expect(measurement.bytes).toBeGreaterThan(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    );

    const advisory = checkCommandLineSizeAdvisoryFromRoot({ argv, env: {} });
    expect(advisory.level).toBe('advisory');
    expect(advisory.bytes).toBe(measurement.bytes);
    // The wording is the engine's, quoted rather than paraphrased by callers —
    // so a root consumer must get the same load-bearing substrings the CLI
    // prints, including the per-term recovery that separates this term from the
    // count term.
    expect(advisory.message).toContain('E2BIG');
    expect(advisory.message).toContain('SWEEPING WORKTREES DOES NOT MOVE THIS TERM');
  });

  it('carries the fail-loud guarantee across the barrel: a garbled threshold throws', () => {
    // The non-vacuity guarantee this advisory rests on. A `NaN` threshold would
    // compare false forever, i.e. read as a permanent `ok` — a root consumer
    // that inherited a weaker check would have a silently-green preflight.
    expect(() =>
      checkCommandLineSizeAdvisoryFromRoot({ argv: [], env: {}, threshold: Number.NaN }),
    ).toThrow(/non-negative integer/);
  });
});

describe('the E2BIG asymmetry is closed at the root — runtime enumeration (issue #338)', () => {
  it('ships BOTH terms, with the second one derived from the first term\'s own message', () => {
    // The sharpest form of the claim, and the reason this is an enumeration and
    // not a name list: the required name is READ OUT of the running engine
    // rather than typed here. The count advisory's message names the function a
    // reader must call next; every function name it names must be root-reachable,
    // or the root ships a correction's premise while withholding the correction.
    const countAdvisory = checkWorktreeCountAdvisoryFromRoot({
      threshold: WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT,
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT + 1,
    });
    expect(countAdvisory.level).toBe('advisory');

    const namedInMessage = [
      ...new Set(countAdvisory.message?.match(/\bcheck[A-Za-z]+Advisory\b/g) ?? []),
    ];
    // Guards the regex itself: an empty match set would make the loop below
    // pass vacuously, which is the one way this assertion could rot silently.
    expect(namedInMessage).toContain('checkCommandLineSizeAdvisory');

    const rootNames = Object.keys(rootExports);
    for (const named of namedInMessage) {
      expect(rootNames).toContain(named);
    }

    // And both terms' thresholds, since a consumer that cannot read the number
    // cannot state or raise the budget it is being warned about.
    expect(rootNames).toContain('WORKTREE_COUNT_ADVISORY_THRESHOLD');
    expect(rootNames).toContain('COMMAND_LINE_ADVISORY_THRESHOLD_BYTES');
  });

  it('adds EXACTLY the command-line family and the per-string term to the worktree-cleanup names at the root', () => {
    const after = rootNamesOwnedByWorktreeCleanup();

    // Nothing was dropped…
    expect(after).toEqual(expect.arrayContaining(WORKTREE_CLEANUP_NAMES_AT_ROOT_BEFORE));
    // …and what is new is exactly the two recorded families, no stowaway.
    // `worktree-cleanup` exports far more than the root re-exports (the
    // orphan-branch and redispatch sweeps among them), so "one more name slipped
    // into the export block" is a live way to be wrong here, not a hypothetical
    // one — and this slice is itself the proof, since the name it adds is one
    // that slipped OUT of an export block written one commit too early.
    const added = after.filter(
      (name) => !WORKTREE_CLEANUP_NAMES_AT_ROOT_BEFORE.includes(name),
    );
    expect(added).toEqual(
      [...COMMAND_LINE_FAMILY_ADDED_AT_ROOT, ...MAX_ARG_STRLEN_TERM_ADDED_AT_ROOT].sort(),
    );

    expect(after).toEqual(
      [
        ...WORKTREE_CLEANUP_NAMES_AT_ROOT_BEFORE,
        ...COMMAND_LINE_FAMILY_ADDED_AT_ROOT,
        ...MAX_ARG_STRLEN_TERM_ADDED_AT_ROOT,
      ].sort(),
    );
  });

});

// ─── issue #357 — the PER-STRING term reaches the package root ────────────────
//
// The barrel-gap class of issue #338, recurring exactly one term later. execve
// documents E2BIG on TWO independent conditions, and the engine models both: a
// combined argv+envp TOTAL, and a hard cap on any ONE argv/env entry
// (`MAX_ARG_STRLEN`). Issue #338 exported the family whole as the family stood
// at ITS anchor — which was one commit before the per-string sibling existed in
// the module. Nothing about that row was wrong; it simply could not export a
// constant that had not been written yet, and no per-branch review of either row
// could see the gap the pair left. A reconciled-merge probe by the barrel row's
// own reviewer is what found it.
//
// What the gap actually costs is not "one fewer constant". A root-only consumer
// already received the per-string VERDICT (`checkCommandLineSizeAdvisory`
// returns `level: 'advisory'` when EITHER condition trips), the per-string
// NUMBERS (`maxEntryBytes` and `maxEntryThreshold`, which cross the barrel as
// fields of the already-exported result types) and the SENTENCE instructing it
// to compare them — while the threshold it is told to compare against, state, or
// raise stayed behind a deep import. That is the same shape issue #338 closed
// for the total term: the root shipped a correction's premise while withholding
// the correction.
//
// The same three kinds of assertion carry it — IDENTITY, COMPILE TIME,
// ENUMERATION — because a public-API claim needs all three: a named import
// cannot see an absent name, an export block can list a name it does not
// re-bind, and only a DELTA against a recorded baseline can say "and nothing
// else rode along".

describe('the per-string E2BIG threshold is reachable from the PACKAGE ROOT (issue #357)', () => {
  it('re-exports the same binding, not a lookalike', () => {
    expect(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT).toBe(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
  });

  it('is a distinct constant from its total-term sibling, not the same number under two names', () => {
    // The one way a "re-export" of this name could be present and still useless:
    // pointing at the total threshold. Both are root-reachable, so the two terms
    // can be told apart from the root — which is the entire operational point of
    // modelling them separately.
    expect(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT).not.toBe(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    );
  });

  it('re-exports the per-string RESULT FIELDS, so a root-only consumer can read and override them', () => {
    // Compile-time half — every annotation here resolves only if the barrel
    // really re-exports the type that declares the field. `tsc --noEmit` is the
    // assertion; the runtime expectations keep the values from being dead code.
    //
    // The fields are the other half of AC1 alongside the constant: a consumer
    // holding the threshold but unable to read `maxEntryBytes` off the
    // measurement, or unable to name `maxEntryThreshold` on the options it
    // passes, still cannot perform the comparison.
    // One argv/env pair, measured and then checked, so `maxEntryBytes` can be
    // compared across the two entry points rather than merely being non-zero on
    // each. The env entry is deliberately the largest string in the pair: the
    // per-string condition is charged across BOTH vectors, and a fixture whose
    // widest entry was always an argv one could not tell that apart from an
    // argv-only implementation.
    const argv = ['node', 'cli.ts'];
    const env = { PATH: '/usr/bin:/usr/local/bin' };

    const measurement: ExecArgumentMeasurementFromRoot =
      measureExecArgumentBytesFromRoot(argv, env);
    const largestEntry: number = measurement.maxEntryBytes;
    // Larger than the ENTIRE argv half, so it demonstrably came from the env
    // vector — the assertion that would fail against an argv-only max.
    expect(largestEntry).toBeGreaterThan(measurement.argvBytes);

    const opts: CommandLineSizeAdvisoryOptionsFromRoot = {
      argv,
      env,
      maxEntryThreshold: MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    };
    const advisory: CommandLineSizeAdvisoryFromRoot =
      checkCommandLineSizeAdvisoryFromRoot(opts);
    const effective: number = advisory.maxEntryThreshold;
    expect(effective).toBe(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT);
    expect(advisory.maxEntryBytes).toBe(largestEntry);
    expect(advisory.level).toBe('ok');
  });

  it('the DEFAULT the root advertises is the one the check actually applies', () => {
    // Guards the failure mode a constant export invites: a root-reachable number
    // that documents nothing, because the check defaults to a different one.
    // Asked without passing `maxEntryThreshold` at all, so the value read back is
    // the check's own default.
    const defaulted = checkCommandLineSizeAdvisoryFromRoot({ argv: [], env: {} });
    expect(defaulted.maxEntryThreshold).toBe(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    );
  });
});

describe('a ROOT-ONLY consumer can measure the PER-STRING term end to end (issue #357)', () => {
  it('a single oversized entry trips the advisory while the TOTAL sits comfortably under budget', () => {
    // The exact shape the per-string term exists for, and the one the total-only
    // model calls `ok`: one argument larger than the per-string threshold, in a
    // command line whose total is nowhere near the total threshold. Sized from
    // the ROOT-imported constants, never from a typed number, so this story
    // cannot drift away from the engine's own budget.
    const oversized = 'x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT + 1);
    const argv = ['node', 'cli.ts', `--body=${oversized}`];

    const measurement = measureExecArgumentBytesFromRoot(argv, {});
    // The total really is under budget — without this the story would prove
    // nothing the total term did not already catch.
    expect(measurement.bytes).toBeLessThan(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    );
    expect(measurement.maxEntryBytes).toBeGreaterThan(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT,
    );

    const advisory = checkCommandLineSizeAdvisoryFromRoot({ argv, env: {} });
    expect(advisory.level).toBe('advisory');
    // …and the wording names the per-string condition, so a root consumer gets
    // the same load-bearing substrings the CLI prints rather than a bare level.
    expect(advisory.message).toContain('MAX_ARG_STRLEN');
    expect(advisory.message).toContain('TWO INDEPENDENT CONDITIONS');
  });

  it('the same command line reads `ok` under a total-only model — the mismeasure this term ends', () => {
    // The negative control for the story above, expressed as the model a
    // root-only consumer was stuck with before this slice: it could read the
    // total and its threshold, and had no per-string threshold to compare
    // against. Raising `maxEntryThreshold` out of the way reproduces that model
    // exactly, and it returns `ok` on a command line that kills the spawn.
    const oversized = 'x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT + 1);
    const argv = ['node', 'cli.ts', `--body=${oversized}`];

    const totalOnly = checkCommandLineSizeAdvisoryFromRoot({
      argv,
      env: {},
      maxEntryThreshold: Number.MAX_SAFE_INTEGER,
    });
    expect(totalOnly.level).toBe('ok');
    expect(totalOnly.message).toBeNull();
  });

  it('carries the fail-loud guarantee for the per-string override across the barrel', () => {
    // The total threshold's guarantee, pinned for its sibling: a `NaN`
    // per-string override would compare false forever, i.e. read as a permanent
    // `ok` — a root consumer that inherited a silently-disabled second condition
    // is back to the one-term mismeasure with a green check on top.
    expect(() =>
      checkCommandLineSizeAdvisoryFromRoot({
        argv: [],
        env: {},
        maxEntryThreshold: Number.NaN,
      }),
    ).toThrow(/non-negative integer/);
  });
});

describe('the per-string term at the root — runtime enumeration (issue #357)', () => {
  it('the advisory message names MAX_ARG_STRLEN, and the constant carrying it is root-reachable', () => {
    // The enumeration in its sharpest form, mirroring the issue-#338 probe: the
    // required name is READ OUT of the running engine rather than typed here.
    // The engine's own advisory text names the kernel condition; the constant
    // that models it must be reachable from the root, or the root ships the
    // instruction without the means to follow it.
    const oversized = 'x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES_FROM_ROOT + 1);
    const advisory = checkCommandLineSizeAdvisoryFromRoot({
      argv: ['node', `--body=${oversized}`],
      env: {},
    });
    expect(advisory.level).toBe('advisory');

    const namedInMessage = [
      ...new Set(advisory.message?.match(/\bMAX_ARG_STRLEN\b/g) ?? []),
    ];
    // Guards the regex itself: an empty match set would make the assertion below
    // pass vacuously, the one way this could rot silently.
    expect(namedInMessage).toEqual(['MAX_ARG_STRLEN']);

    const rootNames = Object.keys(rootExports);
    for (const named of namedInMessage) {
      expect(rootNames.some((name) => name.startsWith(named))).toBe(true);
    }
    expect(rootNames).toContain('MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES');
  });

  it('all THREE E2BIG thresholds are root-reachable together', () => {
    // The whole point of the family, stated as one assertion: an operator or a
    // consumer reading one term and not the others is exactly the failure both
    // this slice and issue #338 exist to end.
    const rootNames = Object.keys(rootExports);
    expect(rootNames).toContain('WORKTREE_COUNT_ADVISORY_THRESHOLD');
    expect(rootNames).toContain('COMMAND_LINE_ADVISORY_THRESHOLD_BYTES');
    expect(rootNames).toContain('MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES');
  });
});

// ─── the human lane at the root (issue #323, ADR-0012) ───────────────────────
//
// A row whose `Worker` is human-gated is real wave work that no agent may pick
// up until a human acts. The engine owns the token and the predicate; before
// this slice it owned them PRIVATELY — the three symbols existed, were
// spec-covered in wave-md-rw.spec.ts, and were reachable from neither the
// package root nor any CLI verb. The consequence was not "slightly less
// convenient": the skills reached the same predicate by grepping the Worker
// cell and carrying the literal `HITL-required` in their own prose, so the
// engine constant and the skill literal could drift apart with nothing
// asserting they still agreed. Root-reachability is one half of closing that
// (the drift pin in skill-schema-drift.spec.ts is the other).
//
// The family is exported WHOLE for the same reason it is pinned whole: a root
// that shipped `humanHeldRowIds` without `HUMAN_GATED_WORKER` would hand a
// consumer the predicate while making them re-type the token it defaults to —
// which is the divergence, re-created one layer out.

describe('the human-lane family is reachable from the PACKAGE ROOT (issue #323)', () => {
  it('re-exports the same bindings, not lookalikes', () => {
    expect(humanGatedRowsFromRoot).toBe(humanGatedRows);
    expect(humanHeldRowIdsFromRoot).toBe(humanHeldRowIds);
    expect(HUMAN_GATED_WORKER_FROM_ROOT).toBe(HUMAN_GATED_WORKER);
  });

  it('the identity assertion is exactly what a behaviourally-identical WRAPPER fails', () => {
    // Same non-vacuity demonstration the two blocks above make. `wrapper`
    // delegates, so every behavioural expectation in this block passes against
    // it — same ids, same order, same defaulting. Only `toBe` separates them.
    const wrapper: typeof humanHeldRowIds = (spine, workers) =>
      humanHeldRowIds(spine, workers);

    const spine = readSpineFromRoot(spineWithHumanLane());
    expect(wrapper(spine)).toEqual(humanHeldRowIdsFromRoot(spine));
    expect(wrapper).not.toBe(humanHeldRowIdsFromRoot);
    expect(humanHeldRowIdsFromRoot).toBe(humanHeldRowIds);
  });

  it('re-exports the row and state types, so a root-only consumer can annotate them', () => {
    // Compile-time half — these annotations resolve only if the barrel really
    // re-exports the types; `tsc --noEmit` is the assertion, and the runtime
    // expectations keep the values from being dead code.
    const spine: SpineFromRoot = readSpineFromRoot(spineWithHumanLane());
    const rows: PlanTableRowFromRoot[] = humanGatedRowsFromRoot(spine);
    expect(rows.map((r) => r.id)).toEqual(['11']);

    // `PlanTableRow.state` is `RowState | string` (a spine may carry a token
    // the enum has not learned yet), so a root-only consumer narrowing it needs
    // BOTH the union and the row type across the barrel.
    const held: RowStateFromRoot = 'planned';
    expect(rows[0].state).toBe(held);
    expect(ROW_STATES_FROM_ROOT).toContain(held);
  });
});

/**
 * A rendered spine carrying one human-gated row among ordinary ones. Built with
 * ROOT-imported `renderSpine` so the stories below import nothing but the
 * package root — the point of a pairing spec is that the consumer's whole job
 * is reachable from there.
 */
function spineWithHumanLane(): string {
  return renderSpineFromRoot(
    {
      slug: 'human-lane-at-root',
      description: 'a wave carrying a human-gated row',
      coordinator: 'at',
      model: 'Opus 4.8',
      created: '2026-07-31',
      lastUpdated: '2026-07-31',
    },
    [
      { id: '10', title: 'Ordinary AFK row', worker: 'background', risk: 'mechanical' },
      {
        id: '11',
        title: 'Rotate the credential by hand',
        worker: HUMAN_GATED_WORKER_FROM_ROOT,
        risk: 'cross-feature-refactor',
      },
      { id: '12', title: 'Another AFK row', worker: 'background-heavy', risk: 'isolated-refactor' },
    ],
    { issues: [], cells: [] },
    'all self-content gates pass.',
  );
}

describe('a ROOT-ONLY consumer can decide the hold end to end (issue #323)', () => {
  it('render → read → hold, importing nothing but the package root', () => {
    const spine = readSpineFromRoot(spineWithHumanLane());

    // The state-BLIND view describes the lane…
    expect(humanGatedRowsFromRoot(spine).map((r) => r.id)).toEqual(['11']);
    // …and the CONJUNCTION is the dispatch answer. Both are needed: a caller
    // with only the first would hold a released row forever.
    expect(humanHeldRowIdsFromRoot(spine)).toEqual(['11']);
    // The wave runs AROUND the hold — the siblings are untouched.
    expect(spine.planTable.map((r) => r.id)).toEqual(['10', '11', '12']);
  });

  it('carries the released-row corollary across the barrel: past `planned` is not held', () => {
    // The guarantee that keeps the gate from becoming permanent. A root-only
    // consumer that inherited a weaker predicate ("human-gated, forever") would
    // have a wave that can never reach terminal, and nothing else in this file
    // would notice.
    const released = setRowStateFromRoot(spineWithHumanLane(), '11', 'dispatched');
    const spine = readSpineFromRoot(released);
    expect(humanGatedRowsFromRoot(spine).map((r) => r.id)).toEqual(['11']);
    expect(humanHeldRowIdsFromRoot(spine)).toEqual([]);
  });

  it('carries the parked corollary too — the archive gate\'s second exit (ADR-0022)', () => {
    // `parked` is terminal AND claim-releasing, so a parked row must stop
    // reading as "awaiting a human". This is the property wave-close phase 6's
    // fail-closed gate rests on: park is one of its two documented exits
    // precisely because taking it makes the row drop out of the predicate.
    const parked = setRowStateFromRoot(spineWithHumanLane(), '11', 'parked');
    const spine = readSpineFromRoot(parked);
    expect(spine.planTable.find((r) => r.id === '11')?.state).toBe('parked');
    expect(humanHeldRowIdsFromRoot(spine)).toEqual([]);
  });

  it('carries the config-governed vocabulary across the barrel (ADR-0007)', () => {
    // `Worker` is a consumer-configurable enum, so the root constant is a
    // DEFAULT. A root-only consumer must be able to substitute its own set —
    // and to see the default stop matching when it does, or the argument is
    // decorative.
    const spine = readSpineFromRoot(spineWithHumanLane());
    expect(humanHeldRowIdsFromRoot(spine, ['needs-a-human'])).toEqual([]);
    expect(humanHeldRowIdsFromRoot(spine, [HUMAN_GATED_WORKER_FROM_ROOT])).toEqual(['11']);
    expect(humanHeldRowIdsFromRoot(spine, [])).toEqual([]);
  });
});

describe('the human lane at the root — runtime enumeration (issue #323)', () => {
  it('adds EXACTLY the human-lane family to the wave-md-rw names at the root', () => {
    const after = rootNamesOwnedByWaveMdRw();

    // Nothing was dropped…
    expect(after).toEqual(expect.arrayContaining(WAVE_MD_RW_NAMES_AT_ROOT_BEFORE));
    // …and what is new is exactly the family, no stowaway.
    const added = after.filter(
      (name) => !WAVE_MD_RW_NAMES_AT_ROOT_BEFORE.includes(name),
    );
    expect(added).toEqual(HUMAN_LANE_FAMILY_ADDED_AT_ROOT);

    expect(after).toEqual(
      [...WAVE_MD_RW_NAMES_AT_ROOT_BEFORE, ...HUMAN_LANE_FAMILY_ADDED_AT_ROOT].sort(),
    );
  });
});

describe('the WHOLE root surface grows only by recorded decisions', () => {
  it('carries exactly the recorded per-slice families and nothing else', () => {
    // The widest net in the file, and the reason it lives in its own block
    // rather than inside either slice's: the per-module assertions above are
    // each scoped to ONE module's bindings, so neither would see an unrelated
    // export riding along in the same edit. This one would.
    //
    // A slice that deliberately adds a root export appends its family above and
    // this arithmetic follows — a failure here means either a stowaway or an
    // addition nobody recorded, and both are the check working.
    expect(Object.keys(rootExports)).toHaveLength(ROOT_RUNTIME_EXPORT_COUNT_NOW);
  });
});
