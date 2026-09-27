# Guard-hooks version floor — why it moved off the beta line

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#guard-hooks-scaffold--hookspretooluse-block--script-copies-echo-guard--convention-12-guard-convention-8-stage-2--gate-met) (issue #1030, 2026-09-27, the third wave-setup residual-form diet pass) so the guard-hooks subsection keeps only the standing rule for when the floor moves; this file is the derivation behind the current `>=1.0.0` value.

## Why the floor moved off the beta line (issue #391)

The floor read `>=0.1.0-beta.2` until the 1.0.0 contract freeze made that value stale in two ways at once: a prerelease of a superseded pre-1.0 line is not an install target this scaffold should still be blessing, and — because a prerelease comparator is the loosest thing a floor can say — it told a consumer that the *older* of two supported answers was acceptable. `1.0.0` carries every carve-out `0.1.0-beta.2` did, so raising the floor loses nothing and drops the beta line from the supported set.

## Measured, not argued (issue #397)

The pointer-free refusal that landed with issue #391 is exactly the case the "moves with the release era, not with every guard change" rule describes — a legibility fix, not a detection-strength one — so the floor stayed at the era's own number when `1.0.1` shipped that fix. This was measured rather than argued (2026-08-01, issue #397, against both published artifacts): `1.0.0` and `1.0.1` refuse the same command identically — exit 2, same family-3 match — so a consumer pinned at the floor runs a guard of full strength with worse text, which is precisely the trade the rule exists to allow.

## Landing-order package-currency history (issue #215)

Step 1 of the guard-hooks copy (both hooks) assumes the published `@formtrieb/flotilla-engine` package's installed tarball ships its `hooks/` directory — true of the package's own `files` manifest (`tools/wave/package.json`) at the time of writing, but a fact about the *published* artifact's currency on a given consumer, not about the doc. On a consumer whose installed package predates that fix, the `cp` source is simply absent and the copy fails loudly (a missing-file error), never silently — re-run `npm install` against a current version first.
