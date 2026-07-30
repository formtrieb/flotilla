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

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The bindings as the MODULE FILE defines them...
import {
  readEngineVersion,
  compareEngineVersion,
  engineVersionExitCode,
} from './cli-store';

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
