#!/usr/bin/env node
/**
 * CLI entry for the Conflict-Map computer.
 *
 * Two invocation forms — the same JSON on stdout, one deep engine underneath:
 *
 *   1. Path form (markdown / local dogfood):
 *        npx tsx tools/wave/src/conflict-map-cli.ts <issue-path> [<issue-path> ...]
 *      Reads each issue FILE, parses its Header-Block, feeds the engine.
 *
 *   2. Store form (github / linear — non-file trackers, ADR-0014 parity with
 *      the `dor --id` entrypoint):
 *        npx tsx tools/wave/src/conflict-map-cli.ts --id <id> [--id <id> ...] \
 *          [--repo-root <dir>] [--config <path>]
 *      Resolves the configured IssueStore, `read`s each issue, and feeds the
 *      engine the store-read Files. On a non-file store there is no path to
 *      pass, so this is the only way to keep engine semantics authoritative
 *      instead of hand-rolling a tsx one-off (retro KW-F7.4).
 *
 * `--id` is the disambiguator between the two, exactly as `dor --id` disambiguates
 * the sync path form from the async store form in cli.ts. The two cannot be
 * mixed in one call — a path plus `--id` errors with usage.
 *
 * Behaviour (both forms):
 *   - Computes the intersection matrix across all issues.
 *   - Emits JSON on stdout. Exit code: 0 = success, 1 = no readable issues /
 *     store failure, 2 = usage (bad/mixed args).
 *
 * JSON output schema (consumed by the /wave create skill body):
 *   {
 *     "issues": ["claude-automation-gaps#07", "wave-orch#11", "wave-orch#12"],
 *     "cells": [
 *       { "a": "wave-orch#11", "b": "wave-orch#12", "files": ["libs/.../strings.ts"] }
 *     ]
 *   }
 *
 * Issue key format (path form): `<slug>#<NN>` for standard paths under
 * `.scratch/<slug>/issues/`; bare NN for non-standard/ad-hoc paths. The store
 * form uses the tracker-native `IssueView.id` verbatim (the engine never parses it).
 */

import { resolve } from 'node:path';
import { computeConflictMap, loadIssueGlobs, type IssueGlobs } from './conflict-map';
import { findScratchRoot } from './find-repo-root';
import { flag, flagAll } from './cli-utils';
import { resolveStore } from './cli-store';
import type { IssueStore } from './adapters/issue-store';
import {
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  type VerbContract,
} from './verb-contract';

const USAGE_LINES = [
  'usage:',
  '  wave-conflict-map <issue-path> [<issue-path> ...]                                        # path form (markdown/local)',
  '  wave-conflict-map --id <issue-id> [--id <id> ...] [--repo-root <dir>] [--config <path>]  # store form (github/linear, non-file)',
  '  paths and --id cannot be mixed in one call.',
];

function writeUsage(): void {
  process.stderr.write(USAGE_LINES.join('\n') + '\n');
}

/**
 * `conflict-map`'s Verb contract (ADR-0051 decision 2) — ONE contract for both
 * invocation forms, because both are one verb.
 *
 * `--id` is REPEATABLE here and takes one value on `dor`; that is a difference
 * in arity, not in value TYPE, so decision 5's uniqueness rule (no canonical
 * spelling carries two value types) is untouched — both spell an issue id.
 *
 * The positional arity declared below is the PATH form's. The store form takes
 * none at all, and the runner narrows the arity to zero for that call: a
 * positional mixed into `--id` is the "cannot mix" error, and it now travels
 * the same refusal path every other undeclared token does.
 */
export const CONFLICT_MAP_CONTRACT: VerbContract = {
  verb: 'conflict-map',
  flags: [
    { canonical: '--id', value: 'repeatable', valueType: 'id' },
    { canonical: '--repo-root', value: 'one', valueType: 'dir' },
    { canonical: '--config', value: 'one', valueType: 'path' },
  ],
  positionals: { kind: 'variadic', min: 1, label: '<issue-path>' },
  output: 'json',
  usage: [...USAGE_LINES, 'output: JSON — { issues, cells }'],
};

/**
 * Run the conflict-map CLI — PATH form (sync).
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`), issue
 *   file paths only. The store form (`--id`) is intercepted upstream (mainAsync)
 *   and dispatched to {@link runConflictMapById}; it never reaches here.
 * @returns exit code: 0 success, 1 no readable issues, 2 missing args
 */
export function runConflictMap(args: string[]): number {
  if (helpRequested(CONFLICT_MAP_CONTRACT, args)) return printVerbHelp(CONFLICT_MAP_CONTRACT);
  const refusal = refuseUndeclared(CONFLICT_MAP_CONTRACT, args);
  if (refusal !== 0) return refusal;

  const paths = positionalsOf(CONFLICT_MAP_CONTRACT, args);
  if (paths.length === 0) {
    writeUsage();
    return 2;
  }

  const absPaths = paths.map((arg) => resolve(arg));
  const repoRoot = findScratchRoot(absPaths[0]);
  const inputs = loadIssueGlobs(absPaths);

  if (inputs.length === 0) {
    process.stderr.write(
      'no readable issues — every header-block failed to parse\n',
    );
    return 1;
  }

  const result = computeConflictMap(inputs, { repoRoot });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

/**
 * Run the conflict-map CLI — STORE form (`--id`, async; ADR-0014 parity with
 * `dor --id`). Resolves the configured IssueStore, `read`s each `--id` into an
 * `IssueView`, and feeds the engine the store-read Files — the byte-identical
 * `computeConflictMap` the path form uses, so the JSON cell shape is identical.
 *
 * `repoRoot` comes from the optional `--repo-root` flag (there is no path to
 * derive it from on a non-file store). Without it, glob-pattern Files entries
 * fall back to exact-text overlap + a `warnings` entry, exactly as the engine's
 * FOR-38 no-repoRoot path already documents — concrete paths are unaffected.
 *
 * `resolveStore` is inside the try/catch (FOR-11): a store-construction throw
 * (unreadable config, network failure standing up the tracker client) must
 * resolve to a clean non-zero exit, never an unhandled rejection.
 *
 * @param args - CLI args after the `conflict-map` subcommand token.
 * @param injected - a store to read from directly (tests); when absent the store
 *   is built from `--config` via resolveStore (impure — the real factory).
 * @returns exit code: 0 success, 1 store-resolution/read failure, 2 usage
 *   (missing `--id`, or paths mixed with `--id`).
 */
export async function runConflictMapById(
  args: string[],
  injected?: IssueStore,
): Promise<number> {
  if (helpRequested(CONFLICT_MAP_CONTRACT, args)) return printVerbHelp(CONFLICT_MAP_CONTRACT);
  const ids = flagAll(args, CONFLICT_MAP_CONTRACT, 'id');
  const positionals = positionalsOf(CONFLICT_MAP_CONTRACT, args);

  // The mixed-form refusal keeps its OWN message: "cannot mix issue paths and
  // --id" teaches the actual mistake, which the generic stray-positional
  // refusal below could not. Everything else undeclared goes the one way.
  if (positionals.length > 0) {
    process.stderr.write(
      'error: cannot mix issue paths and --id in one call — use one form or the other\n',
    );
    writeUsage();
    return 2;
  }
  // The store form takes NO positional, so the declared (path-form) arity is
  // narrowed to zero for this call; positionals are already handled above, so
  // what reaches here is an undeclared FLAG (ADR-0051 decision 4).
  const refusal = refuseUndeclared(CONFLICT_MAP_CONTRACT, args, {
    positionals: { kind: 'fixed', count: 0 },
  });
  if (refusal !== 0) return refusal;
  if (ids.length === 0) {
    process.stderr.write('error: conflict-map --id requires at least one <id>\n');
    writeUsage();
    return 2;
  }

  let store: IssueStore;
  try {
    store = await resolveStore(args, injected);
  } catch (err) {
    process.stderr.write(
      `error: could not resolve the issue store: ${(err as Error).message}\n`,
    );
    return 1;
  }

  const inputs: IssueGlobs[] = [];
  for (const id of ids) {
    let view;
    try {
      view = await store.read(id);
    } catch (err) {
      process.stderr.write(
        `error: cannot read issue ${id}: ${(err as Error).message}\n`,
      );
      return 1;
    }
    inputs.push({ issueId: view.id, files: view.files });
  }

  const repoRoot = flag(args, CONFLICT_MAP_CONTRACT, 'repo-root');
  const result = computeConflictMap(
    inputs,
    repoRoot !== undefined ? { repoRoot } : {},
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

// Only execute when run directly (not when imported by tests / the main router).
if (require.main === module) {
  process.exit(runConflictMap(process.argv.slice(2)));
}
