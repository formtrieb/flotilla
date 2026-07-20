/**
 * checks.ts — the Pre-PR check layer (CHARTER §VerifyGate, M1-PRD §2e).
 *
 * Two engine-universal FLOOR checks (conflict-marker grep + AC-coverage) plus a
 * flat `checks[]` array a consumer extends with project-specific checks
 * (the Ur's ADR-0005 Pure-I/O check becomes ONE entry in *its* config, not
 * engine code). It is a flat array consumed by {@link runChecks} — NOT a
 * plugin-registry framework (the rejected over-build).
 *
 * The AC-coverage check sources the TYPED reviewer `acVerification[]` (1:1 with
 * the declared ACs), NOT a re-parsed issue file — adapter-agnostic for both
 * stores and the removal of the engine's last issue-file re-read (ADR-0004/0001).
 */

import micromatch from 'micromatch';
import type { AcVerification } from './reviewer-verdict-schema';

export interface CheckContext {
  /** Paths changed by the worker (relative to the repo root). */
  changedFiles: string[];
  /** Reads a changed file's content; injectable so checks stay pure/testable. */
  readFile(path: string): string;
  /** The reviewer's typed AC verifications (ADR-0004 ground truth). */
  acVerification: AcVerification[];
  /** How many ACs the issue declared (for the 1:1 coverage floor). */
  declaredAcCount: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Check {
  name: string;
  /** Globs; when set, the check runs only if a changed file matches. Undefined = always. */
  appliesTo?: string[];
  run(ctx: CheckContext): CheckResult;
}

// Only the UNAMBIGUOUS git markers `<<<<<<<` / `>>>>>>>`. `=======` is dropped
// deliberately — it always co-occurs with the other two, and matching it would
// false-positive on a Markdown setext-H1 underline (`=======` under a heading).
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;

/** Floor check: no leftover merge-conflict markers in any changed file. */
export const conflictMarkerCheck: Check = {
  name: 'conflict-markers',
  run(ctx) {
    const hits: string[] = [];
    for (const file of ctx.changedFiles) {
      let content: string;
      try {
        content = ctx.readFile(file);
      } catch {
        continue; // a deleted file can't carry markers
      }
      if (CONFLICT_MARKER.test(content)) hits.push(file);
    }
    return {
      name: 'conflict-markers',
      ok: hits.length === 0,
      detail: hits.length === 0 ? 'clean' : `conflict markers in: ${hits.join(', ')}`,
    };
  },
};

/**
 * Floor check: the reviewer verified every declared AC 1:1 and none is `not-met`.
 * Sources the typed `acVerification[]`, never the cosmetic issue checklist (ADR-0004).
 */
export const acCoverageCheck: Check = {
  name: 'ac-coverage',
  run(ctx) {
    const verified = ctx.acVerification.length;
    const notMet = ctx.acVerification.filter((a) => a.met === 'not-met').map((a) => a.ac);
    if (verified !== ctx.declaredAcCount) {
      return {
        name: 'ac-coverage',
        ok: false,
        detail: `reviewer verified ${verified} ACs but the issue declares ${ctx.declaredAcCount} (must be 1:1)`,
      };
    }
    return {
      name: 'ac-coverage',
      ok: notMet.length === 0,
      detail: notMet.length === 0 ? `${verified}/${verified} ACs met` : `not-met: ${notMet.join(', ')}`,
    };
  },
};

/** The engine-universal Pre-PR floor — always run, before any consumer checks. */
export const FLOOR_CHECKS: readonly Check[] = [conflictMarkerCheck, acCoverageCheck];

/**
 * Run the floor checks plus the consumer's flat `checks[]`, skipping any whose
 * `appliesTo` globs match no changed file. Returns one result per executed check.
 */
export function runChecks(
  ctx: CheckContext,
  consumerChecks: readonly Check[] = [],
): CheckResult[] {
  const all = [...FLOOR_CHECKS, ...consumerChecks];
  const results: CheckResult[] = [];
  for (const check of all) {
    if (check.appliesTo && !ctx.changedFiles.some((f) => micromatch.isMatch(f, check.appliesTo!))) {
      continue;
    }
    results.push(check.run(ctx));
  }
  return results;
}
