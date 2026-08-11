/**
 * load-order-drift.spec.ts — the structural guard for the host-pr.ts /
 * adapters/bitbucket/bitbucket-api.ts module cycle's call-time-only invariant
 * (ADR-0037: "An adapter-owned canonical fact is imported, not re-spelled").
 *
 * ## The failure class this guards
 *
 * `host-pr.ts` imports `BITBUCKET_EMAIL_VAR` and `bitbucketCreateCreds` from
 * the Bitbucket adapter; the adapter imports `AutoMergeUnavailableError` and
 * `DEFAULT_MERGE_METHOD` back from `host-pr.ts` — a genuine module cycle,
 * accepted at a G3 gate and settled by ADR-0037 on the condition that the edge
 * stays CALL-TIME-ONLY in both directions. The danger the condition guards
 * against: a MODULE-EVALUATION-TIME (top-level) read of a binding across
 * either cycle edge resolves to `undefined` under whichever load order
 * happens to arrive first — not an error, not a crash, just a silently wrong
 * value baked into whichever side read it too early (ADR-0034's silent-failure
 * promotion class). Which edge is exposed depends on which module is entered
 * first, which is exactly why a single manual probe (the Reviewer's, run once
 * by hand ahead of ADR-0037) is not enough: production CJS consumers of the
 * shipped npm package can produce either load order, and the suite before this
 * file existed only ever exercised one of them by accident (import order of
 * the spec files themselves, never asserted, never chosen on purpose).
 *
 * ## What this spec does NOT need to prove
 *
 * Today neither file reads the other's binding at module evaluation — both
 * crossing values are read lazily, inside function bodies / default
 * parameters (see the cycle comment atop host-pr.ts). So under CORRECT code,
 * this spec is expected to pass in both orders; it exists to CATCH a future
 * regression that adds an eager top-level read, not to demonstrate today's
 * code is broken.
 *
 * ## Mechanism
 *
 * `vi.resetModules()` + dynamic `import()` per test — Vitest's documented way
 * to force a genuinely fresh module registry per case, so the two tests below
 * cannot share a module instance and mask the reverse order (the failure mode
 * a spec that imports both modules top-level, once, would have: by the time
 * ANY test file's static imports resolve, both modules are already fully
 * evaluated and cached — there is no "first" left to observe). Each test
 * below resets the registry, then imports ONE module first and the other
 * second, and reads the crossing bindings off the freshly-evaluated modules.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('load-order drift — host-pr.ts / adapters/bitbucket/bitbucket-api.ts cycle (ADR-0037)', () => {
  beforeEach(() => {
    // Fresh module registry per test — without this, the SECOND test below
    // would see both modules already cached from the FIRST test's imports,
    // and "host-pr first" would silently degrade into "whatever order the
    // first test happened to establish", never truly re-exercising the cycle.
    vi.resetModules();
  });

  it('adapter-first: the adapter-imported host-pr bindings resolve and behave', async () => {
    // Enter the module graph through the adapter — the order the Reviewer's
    // manual probe drove ahead of ADR-0037, now structural.
    const adapterMod = await import('./adapters/bitbucket/bitbucket-api');
    const hostPrMod = await import('./host-pr');

    expect(adapterMod).toBeTruthy();

    // The two host-pr-owned runtime bindings the adapter imports (see its
    // `from '../../host-pr'` import block): both must have resolved to real
    // values, not `undefined` left over from a partially-evaluated exports
    // object caught mid-cycle.
    expect(hostPrMod.DEFAULT_MERGE_METHOD).toBe('squash');
    expect(typeof hostPrMod.AutoMergeUnavailableError).toBe('function');
    const err = new hostPrMod.AutoMergeUnavailableError('not-allowed', 'drift-spec probe');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('not-allowed');
    expect(err.message).toBe('drift-spec probe');
  });

  it('host-pr-first: the host-pr-imported adapter bindings resolve and behave', async () => {
    // Enter the module graph through host-pr.ts this time — the reverse of
    // the case above, and the order the pre-ADR-0037 suite never exercised.
    const hostPrMod = await import('./host-pr');
    const adapterMod = await import('./adapters/bitbucket/bitbucket-api');

    expect(hostPrMod).toBeTruthy();

    // The two adapter-owned runtime bindings host-pr.ts imports (see its
    // top-of-file cycle comment / `from './adapters/bitbucket/bitbucket-api'`
    // import): both must have resolved to real values under this reversed
    // order too.
    expect(adapterMod.BITBUCKET_EMAIL_VAR).toBe('BITBUCKET_EMAIL');
    expect(typeof adapterMod.bitbucketCreateCreds).toBe('function');
    expect(adapterMod.bitbucketCreateCreds('a-token', 'someone@example.com')).toBe(
      'someone@example.com:a-token',
    );
  });
});
