#!/usr/bin/env node
/**
 * config-cli.ts — `config validate <path>` runner.
 *
 * Store-INDEPENDENT: it calls loadWaveConfig (which validates `store`, `verify`
 * — including each command's ADR-0049 `needs` declaration against its closed set
 * of three — `cleanup` and the ADR-0032 `engine.cli` binding)
 * but never buildStore, so it validates a `github` config too — buildStore throws
 * the pre-P8 GitHub deferral, loadWaveConfig does not. This is how `wave-setup`
 * proves a freshly-written config loads (ADR-0016 skill-half grill 2026-06-18).
 *
 * Exit codes: 0 valid · 1 invalid/unreadable · 2 usage.
 */

import { loadWaveConfig } from './wave-config';
import type { VerifyConfig } from './verify';

function printUsage(): void {
  process.stderr.write(['usage:', '  config validate <path>', ''].join('\n'));
}

/**
 * `[commands that declare a capability requirement, commands in total]` across
 * every verify profile (ADR-0049).
 *
 * Defensive by design: `loadWaveConfig` guarantees only that `verify.profiles`
 * is an ARRAY, and holds a command's `needs` to the closed set only where the
 * surrounding shapes were readable. So this counter walks past everything it
 * cannot read rather than throwing on it — a `config validate` that exited 1
 * from its own REPORTING line, on a config the validator itself just accepted,
 * would be a worse answer than a conservative count.
 */
function countDeclaredNeeds(verify: VerifyConfig): [declared: number, total: number] {
  let declared = 0;
  let total = 0;
  for (const profile of verify.profiles as readonly unknown[]) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    const commands: unknown = (profile as { commands?: unknown }).commands;
    if (!Array.isArray(commands)) continue;
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) continue;
      total += 1;
      if ((cmd as { needs?: unknown }).needs !== undefined) declared += 1;
    }
  }
  return [declared, total];
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
    // ADR-0049 — report the declared capability requirements beside the profile
    // count, with their denominator. An operator running this line after
    // `wave-setup` is asking "did the needs I declared actually land?", and a
    // count of 0 out of 3 answers it where silence would not. Deliberately
    // CONDITIONAL: a config that declares no needs prints exactly the line it
    // printed before this field existed, so nothing that reads this output has
    // to learn a new shape for the ordinary case.
    const [needsDeclared, needsTotal] = config.verify
      ? countDeclaredNeeds(config.verify)
      : [0, 0];
    const needsNote = needsDeclared > 0
      ? `, ${needsDeclared} of ${needsTotal} verify command(s) declare a sandbox need`
      : '';
    const verifyNote = config.verify
      ? `, verify: ${config.verify.profiles.length} profile(s)${needsNote}`
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
