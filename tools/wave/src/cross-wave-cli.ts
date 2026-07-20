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

/**
 * Run the cross-wave check CLI.
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`)
 * @returns exit code: 0 success, 1 domain failure, 2 usage error
 */
export function runCrossWave(args: string[]): number {
  const candidatesPath = flag(args, '--candidates');
  const claimedPath = flag(args, '--claimed');
  // No `?? process.cwd()` fallback (FOR-38) — an omitted --repo-root is
  // forwarded as `undefined` so crossWaveCheck/computeConflictMap can tell
  // "genuinely not supplied" apart from "supplied, happens to be cwd", and
  // degrade to the exact-pattern-text + warnings path instead of silently
  // guessing a root that may not correspond to where the Files globs live.
  const repoRoot = flag(args, '--repo-root');

  if (candidatesPath === undefined || claimedPath === undefined) {
    process.stderr.write(
      [
        'error: --candidates and --claimed are required',
        'usage: cross-wave --candidates <path> --claimed <path> [--repo-root <dir>]',
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
