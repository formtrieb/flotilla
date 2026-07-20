#!/usr/bin/env node
/**
 * config-cli.ts — `config validate <path>` runner.
 *
 * Store-INDEPENDENT: it calls loadWaveConfig (which validates `store` + `verify`)
 * but never buildStore, so it validates a `github` config too — buildStore throws
 * the pre-P8 GitHub deferral, loadWaveConfig does not. This is how `wave-setup`
 * proves a freshly-written config loads (ADR-0016 skill-half grill 2026-06-18).
 *
 * Exit codes: 0 valid · 1 invalid/unreadable · 2 usage.
 */

import { loadWaveConfig } from './wave-config';

function printUsage(): void {
  process.stderr.write(['usage:', '  config validate <path>', ''].join('\n'));
}

export function runConfig(args: string[]): number {
  const op = args[0];
  if (op !== 'validate') {
    printUsage();
    return 2;
  }
  const path = args[1];
  if (!path) {
    printUsage();
    return 2;
  }
  try {
    const config = loadWaveConfig(path);
    const verifyNote = config.verify
      ? `, verify: ${config.verify.profiles.length} profile(s)`
      : '';
    process.stdout.write(
      `ok: "${path}" is a valid wave config (store.kind=${config.store.kind}${verifyNote})\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
if (require.main === module) {
  process.exit(runConfig(process.argv.slice(2)));
}
