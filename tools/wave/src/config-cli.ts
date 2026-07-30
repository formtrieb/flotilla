#!/usr/bin/env node
/**
 * config-cli.ts — `config validate <path>` runner.
 *
 * Store-INDEPENDENT: it calls loadWaveConfig (which validates `store`, `verify`,
 * `cleanup` and the ADR-0032 `engine.cli` binding)
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
    // ADR-0032 — report the BOUND VALUE, not just that one exists. This line is
    // what an operator reads to confirm the repo is bound to the form they
    // think it is; "engine.cli: present" would confirm nothing. An absent
    // binding is silent rather than reported as unbound: absence is valid at
    // the engine level, and whether it is acceptable is the consuming skills'
    // call, not this validator's.
    const engineNote = config.engine?.cli
      ? `, engine.cli: ${config.engine.cli}`
      : '';
    process.stdout.write(
      `ok: "${path}" is a valid wave config (store.kind=${config.store.kind}${verifyNote}${engineNote})\n`,
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
