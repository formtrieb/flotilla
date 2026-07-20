#!/usr/bin/env node
/**
 * CLI entry for the Conflict-Map computer.
 *
 * Usage:
 *   npx tsx tools/wave/src/conflict-map-cli.ts <issue-path> [<issue-path> ...]
 *
 * Behaviour:
 *   - Reads each issue file, parses its Header-Block (silently skips files
 *     whose header fails to parse — /wave validate is the auth check for that).
 *   - Computes the intersection matrix across all parsed issues.
 *   - Emits JSON on stdout. Exit code: 0 = success, 1 = no readable issues.
 *
 * JSON output schema (consumed by the /wave create skill body):
 *   {
 *     "issues": ["claude-automation-gaps#07", "wave-orch#11", "wave-orch#12"],
 *     "cells": [
 *       { "a": "wave-orch#11", "b": "wave-orch#12", "files": ["libs/.../strings.ts"] }
 *     ]
 *   }
 *
 * Issue key format: `<slug>#<NN>` for standard paths under
 * `.scratch/<slug>/issues/`; bare NN for non-standard/ad-hoc paths.
 */

import { resolve } from 'node:path';
import { computeConflictMap, loadIssueGlobs } from './conflict-map';
import { findScratchRoot } from './find-repo-root';

/**
 * Run the conflict-map CLI.
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`)
 * @returns exit code: 0 success, 1 no readable issues, 2 missing args
 */
export function runConflictMap(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write(
      'usage: wave-conflict-map <issue-path> [<issue-path> ...]\n',
    );
    return 2;
  }

  const absPaths = args.map((arg) => resolve(arg));
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

// Only execute when run directly (not when imported by tests / the main router).
if (require.main === module) {
  process.exit(runConflictMap(process.argv.slice(2)));
}
