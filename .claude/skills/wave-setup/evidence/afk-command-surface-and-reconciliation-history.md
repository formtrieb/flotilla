# AFK command surface and allowlist reconciliation — history and derivation

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#afk-harness-config-scaffold-env-block--permission-allowlist-claudesettingsjson) (issue #1030, 2026-09-27, the third wave-setup residual-form diet pass) so the AFK harness config scaffold section — and its "Scaffold-vs-live allowlist reconciliation" and "2026-07-31 pass" subsections — keep only their residual rule form; this file is the incident narrative, the alias/seeded-legacy removal history, and the transcript-scan method and findings behind them.

## The overnight stall that established the measured command block

The first multi-wave overnight run measured the full AFK worker command surface for real: the workspace mechanic (`git fetch`/`reset`/`checkout`/`add`/`commit`), the wave-branch push, the Reviewer's probe-worktree creation, the sibling merge-tree prediction, and the verify-gate commands (`npm ci`, `npx vitest run`, `npx tsc --noEmit`) — and found **none of it** on the tracked allowlist scaffolded at the time. Consequence: 2–4 human approvals landed mid-dispatch over one night, one of which suspended a wave for roughly seven hours until the operator woke and clicked approve (docs/retros/2026-07-29-overnight-triple-wave.md, finding NF-F1). That finding is why the scaffold carries the full measured command block rather than only the engine-CLI invocation form.

## The alias entrypoint history (issue #269)

`cli.ts`'s own router keeps three pre-unification entrypoints alive as documented ALIASES to the identical runner (its own in-source NOTE: they "survive as documented ALIASES only because live skill call-sites still spell them that way") — `resume-cli.ts`, `cli-store.ts` (its `preflight` op), and `spine-cli.ts`. This repo's allowlist used to carry two extra vendored-path pairs for the first and third, because two of its own skill docs still spelled them as SEPARATE entrypoints. Both call-sites have since been respelled to the unified `{{wave-cli}} <sub>` form — `wave-resume`'s SKILL.md invokes the reconciler as `{{wave-cli}} resume`, and `wave-close`'s close-mechanics.md documents spine ops as `{{wave-cli}} spine <op>` only — and those four entries were removed from the live tracked settings in the same change. No skill doc now spells any retained alias, so none of them needs an allowlist entry: `cli-store.ts`'s alias form never had one here either, which is now the uniform state rather than a gap. Deleting the aliases from the router itself is a separate engine question — they carry their own in-source contract and a third alias with its own consumers — not an allowlist one.

## The #345 jq entry gap

The on-disk PR-URL-confirmation fallback entry (`Bash(jq -e -r '.url':*)`) did not exist before issue #345: the fallback recipe had prescribed `jq` to a worktree-isolated Worker with no matching allow entry since the recipe was first written, and nothing had confirmed why an observed dispatch using it ran clean regardless — see "Why the gap produced zero prompts" below for the masking mechanism that made that possible. Issue #345 closed the gap in the "add the entry" direction, leaving the recipe text itself unchanged.

## The Wave 6 mkdir finding

The archive-directory `mkdir -p` call (`wave-close`'s archive phase) is not a hypothetical safeguard: a *missing* `mkdir -p` in that exact snippet was a live-reproduced Reviewer finding in Wave 6, predating this scaffold (`docs/retros/2026-07-19-hardening-w6.md`, FOR-21). Both the `wave-create` and `wave-close` `mkdir -p` calls rode along in the same NF-F1 commit as the dispatched-agent entries (see "The overnight stall" above) even though neither runs inside a Worker/Reviewer worktree — untraced as Coordinator-side calls until the entry's own bullet named them explicitly.

## The Convention 8 occurrence list as of this pass

Convention 8's own live-occurrences catalogue kept growing past whatever prose the previous occurrence had hardened: a Worker's flawed value-substituting-expansion echo, a Worker's `printenv` whole-environment dump, a Reviewer's `cat` of the gitignored `.claude/settings.local.json` while hunting a config precedent, and more since. wave-shared's Convention 8 reference carries the current, still-growing count; this list here is the layer of occurrences the reference file's own reconciliation carried at the time of this diet pass, moved out to keep the anchor bullet in setup-mechanics.md pointing at the live count rather than re-narrating it.

## The original #269 pass and the #345 removal

The original #269 reconciliation pass diffed the live `.claude/settings.json` file against a scaffold that then named six engine-CLI forms (since collapsed to one, ADR-0032) and found 20 live-only entries: 4 became this repo's documented vendored exception, 16 were stale pre-router (`src/*-cli.ts`) entrypoints handed to an operator PR for removal. Issue #345 performed that removal — none of the 16 remain live today.

## The seeded-legacy allowance and its #345 removal

`.claude/settings.json` sat outside issue #291's own declared Files globs, so its four seeded entries — the `npx @formtrieb/flotilla-engine` pair and the bare `npx tsx tools/wave/src/cli.ts` pair — waited for a later operator PR to actually remove them. Issue #345 declared that file in its own Files globs and performed the removal: `tools/wave/src/allowlist-scaffold-guard.spec.ts`'s `SEEDED_LEGACY_ALLOW` records the disposition of each, and the constant's own comment names which pair fell under which reason (the `npx @formtrieb/flotilla-engine` pair was a pre-setup bootstrap form never meant as an ongoing entry; the bare `npx tsx` pair was a third, never-scaffolded engine-invocation spelling).

## The 2026-07-31 transcript scan method

Every `Bash` tool call in this repo's session transcripts since 2026-07-26 was extracted from the on-disk JSONL — coordinator sessions *and* the per-worktree AFK Worker/Reviewer transcripts (their own `~/.claude/projects/<worktree-path>/` roots, missed entirely by a scan of the coordinator's directory alone). 694 transcripts, 644 worker-side, 12,337 Bash calls, each matched against the live `permissions.allow`.

## The three spellings table and measured counts

The scan found the two verify gates had three spellings, and the allowlist carried only one:

| Source | Spelling | On the live allowlist before this pass |
|---|---|---|
| `wave.config.json` → `verify.profiles[].commands` | `npx vitest run` / `npx tsc --noEmit` (cwd `tools/wave`) | yes — both |
| Root `CLAUDE.md` → **Verify** | `npm test` / `npm run typecheck` (from `tools/wave/`) | **no — neither** |
| Measured Worker practice (KW-F7: parallel `npx` contends on the npm cache lock) | `./tools/wave/node_modules/.bin/vitest run`, `./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit` | **no — neither** |

An agent that reads `CLAUDE.md` — the file every session is told to read first — and runs the gate it names was running an un-allowlisted command. Measured: `npm run typecheck` 111×, `npm test` 52×, the local-binary vitest form 135×, the local-binary `tsc` form 23×, `npm ci --prefix <path>` 61×.

## Why the gap produced zero prompts

Zero prompts landed across all 12,337 calls — the gap was masked end-to-end by two allowlists outside the dispatch contract, the operator's own user-level `~/.claude/settings.json` (`Bash(npm *)`, `Bash(npx *)`, …) and the gitignored `.claude/settings.local.json`. Neither reaches a fresh consumer, and the gitignored one does not even reach this repo's own Worker worktrees — a masked-but-incomplete tracked file passes a "no new prompt" live gate for the wrong reason.

## Exact-form matching against a redirected command

Still open. The exact-form entries (`Bash(npm test)`, `Bash(npm run typecheck)`, `Bash(./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit)`, `Bash(npx tsc --noEmit)`) assume the permission matcher splits on pipe/redirection before matching, rather than requiring the whole invoked string to equal the entry byte-for-byte — every measured call in practice carries a suffix (`npm test 2>&1 | tail -40`). A live measurement ran the exact-form `tsc` entry both bare and with a redirect+pipe suffix from a worktree-isolated dispatch and found no observable difference — not a clean falsification, since that dispatch class showed zero friction on every command it ran that session, entry or no entry, so a masking layer independent of the tracked allowlist cannot be ruled out.

**What would actually falsify this:** an environment provably running with *only* the tracked `.claude/settings.json` as its permission source — the piped branch should prompt there if the assumption is wrong and the bare branch should not; if a future wave ever sees that asymmetry, the fix is a `:*` suffix on the entry that prompted.

## Deny-parity divergence

The live `permissions.deny` no longer matches the scaffold exactly: `Read(.claude/settings.local.json)` / `Read(**/.claude/settings.local.json)` were removed by the operator after ADR-0029 moved every credential into the keychain lookup path, leaving that file holding no secret. The scaffold deliberately keeps **both** lines regardless — a generic consumer's `settings.local.json` may still hold live credentials, and the vector Convention 8 catalogues is universal. The two `Read` lines are a **pair by necessity**, root form plus `**/` form — `**/` alone does not match the repo-root path (observed directly). The `.env` anchors in the scaffold are the same pair for the same reason; do not simplify either pair to its `**/` half.
