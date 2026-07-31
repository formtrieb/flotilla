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
