# Verify-command resolution — the two-halves measurement, and the recurrence arc

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#measure-before-recording--resolution-proven-by-execution-not-inspection) (issue #817, 2026-09-26) so the measure-before-recording rule stays in the reference as its own compact form; this file is the measured proof behind it and the three separate occasions the identical gap recurred.

## The two halves

Naming the pinned local binary closes only which vitest *executable* runs — it says nothing about which *files* that executable then goes looking for. Evidence, measured live (issue #372): the pinned local binary, invoked from the repo root with **no discovery root**, resolves vitest 4.1.8 and runs — but sweeps in `scripts/check-client-refs.test.mjs`, a repo-root `node:test` file the vitest runner cannot parse as a suite, and reports **63 test files (1 failed, 62 passed)** while all **2789** vitest-owned tests still pass — a failed-suite verdict for a reason that has nothing to do with the code under test. Pinning the discovery root (`--root tools/wave`) removes the stray file from the walk entirely: **62 test files, 2789 passing tests**, matching baseline exactly.

## flotilla's own repo, confirmed live

Confirmed by execution 2026-07-31 (issue #372): with the discovery root pinned, the vitest form resolved **vitest 4.1.8** and ran **62 test files, 2789 passing tests**; the tsc form resolved and exited **0**. (A stale prior recording here — 2675 tests — predates the repo-root file whose presence is exactly the two-halves gap above; it is superseded by this measurement, not merely refreshed.)

The bare, unpinned form (`npx vitest run` / `npx tsc --noEmit`) resolves to nothing on this repo's own shape:

```json
{
  "verify": {
    "profiles": [
      {
        "name": "engine",
        "appliesTo": ["tools/wave/**"],
        "commands": [
          { "command": "npm ci --prefix tools/wave" },
          { "command": "npx vitest run" },
          { "command": "npx tsc --noEmit" }
        ]
      }
    ]
  }
}
```

## The recurrence arc — why the profile itself has to name the pinned form, not a prose warning beside it (issue #372)

The identical underlying gap — an unpinned or under-specified verify spelling standing in for the pinned one — recurred in three distinct shapes, on three separate occasions, and a warning survived none of them:

1. **The compose trap.** A bare `npx vitest run` / `npx tsc --noEmit` form, composed straight from the profile description and never measured, resolved to **nothing** on this repo's nested dependency directory (Wave `2026-07-30-arm-and-wiring`, coordinator disclosure 254.3).
2. **An unpinned download, even where the bare form DOES resolve.** The original filing of this issue observed the verify profile's literal `npx vitest run --root tools/wave` — note it already named the discovery root — still reach past the pinned local binary and download **vitest 4.1.10** from the network, against **4.1.8** installed under `tools/wave/node_modules`; independently reproduced by the row's own Reviewer, who re-ran both. Both versions agreed on counts that day (2760/2760 across 62 files), so no verdict was affected then — but the root half being correct did nothing to pin the binary half: the two halves fail independently, not sequentially.
3. **A Reviewer re-spelled the bare form anyway, despite a verbatim warning in hand.** On 2026-07-31, a wave Reviewer issued a bare `npx vitest run` mid-review — again fetching the unpinned 4.1.10 — before re-running the identical spec through the pinned `npm test` form (4.1.8, lockfile); both agreed on counts, so no verdict was affected this time either. What makes this occurrence the decisive one: the Reviewer's own brief *carried the warning against exactly this form*, and the bare form was reached for anyway.

Three occurrences, one root cause, and the third happened to someone who had just read the warning. A prose warning demonstrably does not close this — the fix has to remove the bare spelling from reach entirely, which is exactly what naming the pinned, discovery-rooted form directly inside `commands` does: there is no shorter, more-obvious-looking alternative left to compose or reach for, because the command that actually runs already **is** the correct one.

Three further spellings of this same pair, measured from the allowlist-reconciliation angle (which spellings are *used* vs. *allowlisted*, rather than which spelling *resolves*), are in setup-mechanics.md's "2026-07-31 pass" section.
