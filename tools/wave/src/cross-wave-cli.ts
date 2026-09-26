#!/usr/bin/env node
/**
 * cross-wave-cli.ts — store-agnostic CLI runner for crossWaveCheck.
 *
 * Usage:
 *   npx tsx tools/wave/src/cross-wave-cli.ts \
 *     --candidates <path>  \  JSON file holding ScopedIssue[]
 *     --claimed    <path>  \  JSON file holding ScopedIssue[]
 *     [--repo-root <dir>]     omit only when no declared Files entry is a
 *                             glob pattern — see below
 *
 * Reads both JSON files, calls crossWaveCheck, emits the CrossWaveResult as
 * formatted JSON on stdout.
 *
 * `--repo-root` is NOT a convenience default (FOR-38: it previously silently
 * fell back to `process.cwd()`, which is only ever correct by coincidence —
 * a live finding showed the same candidate roster produce 17 conflict cells
 * without it vs. 40 with it, purely from glob patterns that could not expand
 * and were silently dropped). Omitting it now degrades glob comparison to
 * exact-pattern-text matching (still detects two issues declaring the
 * byte-identical glob) and surfaces every unexpanded pattern in
 * `result.warnings`, echoed to stderr here as well so it is never missed
 * even by a caller that only reads stdout for `parallelSafe`. Always pass a
 * real `--repo-root` in production (`wave-plan`/`wave-create` both do).
 *
 * Exit codes:
 *   0 — success (result on stdout; check result.warnings — non-fatal)
 *   1 — domain failure (crossWaveCheck threw; message on stderr)
 *   2 — missing required flag, or unreadable/malformed input file (message on stderr)
 */

import { readFileSync } from 'node:fs';
import { crossWaveCheck, type ScopedIssue } from './cross-wave';
import { flag, printJson } from './cli-utils';
import {
  defineVerb,
  helpRequested,
  printVerbHelp,
  refuseUndeclared,
  type VerbContract,
} from './verb-contract';

/**
 * `cross-wave`'s Verb contract (ADR-0051 decision 2), declared beside its
 * runner. No axis of ADR-0051's four passes through this verb — `--candidates`
 * and `--claimed` name things nothing else names — so the declaration is a
 * straight statement of what the runner already read.
 */
export const CROSS_WAVE_CONTRACT: VerbContract = defineVerb({
  verb: 'cross-wave',
  program: 'cross-wave',
  flags: [
    { canonical: '--candidates', value: 'one', valueType: 'path', required: true },
    { canonical: '--claimed', value: 'one', valueType: 'path', required: true },
    { canonical: '--repo-root', value: 'one', valueType: 'dir' },
  ],
  positionals: { kind: 'fixed', count: 0 },
  output: 'json',
  outputNote: 'JSON — the CrossWaveResult (check `warnings`; they are non-fatal)',
  // Issue #913: the type NAME is not the shape. Read off `printJson(result)` —
  // the whole `CrossWaveResult` — and confirmed by running the verb over two
  // empty rosters, which printed the four always-present keys and no `warnings`.
  json: {
    shape:
      '{ parallelSafe, crossWaveConflicts: [ { a, b, files: [ <path> ] } ], ' +
      'intraWaveConflicts: [ <same cell> ], ' +
      'intraWaveBlockedByPairs: [ { blocked, blocker, resolved } ], ' +
      'blockedByCycles: [ [ <id> ] ], warnings?: [ <text> ] }',
    trail:
      'warnings appears ONLY when an unexpanded glob made parallelSafe unreliable; ' +
      'each blockedByCycles entry names every issue on one dependency cycle (ADR-0054)',
  },
});

/**
 * Run the cross-wave check CLI.
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`)
 * @returns exit code: 0 success, 1 domain failure, 2 usage error
 */
export function runCrossWave(args: string[]): number {
  if (helpRequested(CROSS_WAVE_CONTRACT, args)) return printVerbHelp(CROSS_WAVE_CONTRACT);
  const refusal = refuseUndeclared(CROSS_WAVE_CONTRACT, args);
  if (refusal !== 0) return refusal;

  const candidatesPath = flag(args, CROSS_WAVE_CONTRACT, 'candidates');
  const claimedPath = flag(args, CROSS_WAVE_CONTRACT, 'claimed');
  // No `?? process.cwd()` fallback (FOR-38) — an omitted --repo-root is
  // forwarded as `undefined` so crossWaveCheck/computeConflictMap can tell
  // "genuinely not supplied" apart from "supplied, happens to be cwd", and
  // degrade to the exact-pattern-text + warnings path instead of silently
  // guessing a root that may not correspond to where the Files globs live.
  const repoRoot = flag(args, CROSS_WAVE_CONTRACT, 'repo-root');

  if (candidatesPath === undefined || claimedPath === undefined) {
    process.stderr.write(
      [
        'error: --candidates and --claimed are required',
        // The CONTRACT's own section (issue #758), not a second copy of its
        // first line: one place states what this verb accepts.
        ...CROSS_WAVE_CONTRACT.usage,
        '',
      ].join('\n'),
    );
    return 2;
  }

  let candidates: ScopedIssue[];
  try {
    candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as ScopedIssue[];
  } catch (err) {
    process.stderr.write(
      `error: cannot read --candidates ${candidatesPath}: ${(err as Error).message}\n`,
    );
    return 2;
  }

  let claimed: ScopedIssue[];
  try {
    claimed = JSON.parse(readFileSync(claimedPath, 'utf-8')) as ScopedIssue[];
  } catch (err) {
    process.stderr.write(
      `error: cannot read --claimed ${claimedPath}: ${(err as Error).message}\n`,
    );
    return 2;
  }

  // The inputs are pre-parsed, so crossWaveCheck is unlikely to throw — but if it
  // does, surface it as the documented domain-failure exit 1 (mirrors the sibling
  // CLIs) rather than letting an unhandled rejection escape a programmatic caller.
  try {
    const result = crossWaveCheck({ candidates, claimed, repoRoot });
    // Non-fatal (exit stays 0 — the check still ran and produced a result),
    // but echoed to stderr in addition to being in the JSON on stdout: a
    // caller piping stdout straight into a JSON parser and only reading
    // `parallelSafe` must not be able to miss this (FOR-38 — "never a
    // silently smaller conflict set").
    if (result.warnings && result.warnings.length > 0) {
      process.stderr.write(
        result.warnings.map((w) => `warning: ${w}`).join('\n') + '\n',
      );
    }
    // A dependency cycle holds every row on it forever (ADR-0054 decision 4).
    // Echoed to stderr for the same reason the warnings are: a caller reading
    // only `parallelSafe` off stdout must not miss it. Exit stays 0 — the check
    // ran and reported; what to do about the cycle is the Operator's call.
    for (const cycle of result.blockedByCycles) {
      process.stderr.write(
        `cycle: ${[...cycle, cycle[0]].join(' → ')} (each blocked by the next) — ` +
          'no row on it can ever be dispatched until one edge is removed (issue-store unblock)\n',
      );
    }
    printJson(result);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when this file is run directly.
if (require.main === module) {
  process.exit(runCrossWave(process.argv.slice(2)));
}
