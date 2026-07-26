#!/usr/bin/env node
'use strict';

/**
 * `wave-engine` bin shim — the published entrypoint for
 * `npx @flotilla/wave-engine <subcommand> [...]`.
 *
 * The charter's "engine ships raw TS, no build step" rule (CLAUDE.md,
 * CHARTER §4) means the package contains `src/*.ts` and nothing compiled.
 * So the shim's only job is to install a TypeScript require-hook and then
 * hand the untouched argv to the same router every skill already shells into
 * (`src/cli.ts` → `mainAsync`).
 *
 * Why in-process rather than spawning `tsx`:
 *   - one process, so stdin/stdout/stderr and the exit code are the router's
 *     own, with no signal-forwarding or stream-plumbing layer to get wrong;
 *   - `tsx` is a real runtime `dependency`, so `require('tsx/cjs')` resolves
 *     from an installed tarball exactly like `fast-glob` or `micromatch` do.
 *
 * The shim deliberately adds NO surface of its own — no flags, no `--version`,
 * no argv rewriting. Every token after the bin name reaches the router
 * verbatim, so `npx @flotilla/wave-engine dor <path>` and the in-repo
 * `tsx tools/wave/src/cli.ts dor <path>` are the same invocation.
 */

try {
  // Side-effect import: registers tsx's CommonJS require hook so the
  // `require()` below can load raw `.ts` sources.
  require('tsx/cjs');
} catch (err) {
  process.stderr.write(
    'error: @flotilla/wave-engine could not load its TypeScript runtime ' +
      "('tsx'). It is a runtime dependency of this package — reinstall the " +
      'package (or run `npm install` in its directory) and retry.\n' +
      `cause: ${(err && err.message) || String(err)}\n`,
  );
  process.exit(1);
}

const { mainAsync } = require('../src/cli.ts');

// Exit semantics are the router's: it resolves to the process exit code and
// only rejects on a genuinely unhandled failure. Mirrors the
// `require.main === module` guard at the foot of src/cli.ts.
mainAsync(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${(err && err.message) || String(err)}\n`);
    process.exit(1);
  });
