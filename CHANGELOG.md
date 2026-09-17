# Changelog

All notable changes to flotilla are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two artifacts are versioned together and released as one unit — the npm package
`@formtrieb/flotilla-engine` (`tools/wave/package.json`) and the Claude Code plugin
(`.claude-plugin/plugin.json`). A single entry below covers both. How a release is cut
is documented separately in [docs/RELEASING.md](docs/RELEASING.md).

## [2.7.0] — 2026-09-17

Every engine verb now declares its own contract ([ADR-0051](docs/adr/0051-a-verb-declares-its-own-contract-one-canonical-spelling-per-flag-silent-aliases-and-a-refusal-for-everything-undeclared.md)): one canonical spelling per flag, every old spelling a silent alias, exit 2 for anything undeclared, `--help` on every verb, `--json` receipts on the silent write ops. The text a Coordinator loads is a pinned, guarded measure ([ADR-0050](docs/adr/0050-the-loaded-corpus-is-a-pinned-measure-and-a-rules-enforcement-tier-decides-its-reading-class.md)): −42 KB standing load, −70 KB corpus, 171 KB moved into `evidence/` files no dispatch loads. Three waves, 27 rows. Nothing removed.

### Upgrading

1. **Plugin/marketplace:** update the plugin to 2.7.0. Marketplace listing unchanged.
2. **Engine pin:** `@formtrieb/flotilla-engine` 2.6.0 → 2.7.0. Vendored form: re-copy `tools/wave/`.
3. **Config keys:** none added or changed.
4. **Hook re-copy:** none — `hooks/` is unchanged. The setup scaffold now writes **both** guard hooks into one `hooks.PreToolUse` block; a consumer set up before 2.7.0 carries only the Echo-Guard and re-runs that step to add the Convention-12 guard (#762).
5. **Allowlist parity:** none.
6. **Behaviour heads-ups** (same input, different outcome):
   - An undeclared flag exits 2 on every verb, naming the nearest declared spelling. Every spelling that worked in 2.6.0 still works (#821).
   - An unknown op with an unreadable config exits 2, not 1 (#758).
   - `--help` is answered by every verb and op — stdout, exit 0. The zero-arg router prints the named verb's usage instead of the whole roster; two roster placeholders changed (`--body <text>`, `--expect <version>`) (#758).
   - `--json` goes **after** the op on every group (`config validate <path> --json`); before it, it is read as the op and exits 2. The six prose verbs (`dor`, `config validate`, `validate-report`, `validate-verdict`, `write-report`, `write-verdict`) answer `--json` as JSON; their `notice:`/`warning:` findings stay on stderr (#825).
   - Nine `issue-store` and seven `spine` write ops answer `--json` with a receipt of what was sent or written. Without `--json` they print nothing, as before (#822, #823).
   - `config validate` prints one `warning:` line per unknown key or non-object value on stderr; the `ok:` line grows conditional segments; `store-preflight`'s JSON gains a `goalBinding` key (#761).
   - `conflict-map` (path form) and `config validate` answer a missing file with `merge-order`'s prefixed one-line shape (#759).
   - The markdown store refuses a reserved heading (`## Files`, `## Acceptance criteria`) in `bodySections`, like the other stores (#760).
   - `GhStateReason` carries `duplicate`: the GitHub adapter reads a duplicate-closed issue as that instead of `null`, and `read-closing` derives the same class as `not_planned`. The write path still sends only `completed` / `not_planned` (#851).
7. **Implementer heads-ups** (additive; nothing renamed or removed): the Verb-contract surface is root-exported — the types (`VerbContract`, `FlagContract`, `PositionalArity`, `OutputClass`, …), the readers (`scanArgs`, `checkUndeclared`, `refuseUndeclared`, `printVerbHelp`, …), `verbContracts()`, `contractForArgv()`, every module's `*_CONTRACT(S)` constant, and `flagAll` (#821, #844). Optional members: `StorePreflightReport.goalBinding?` (#761), `PositionalArity.fixed.min?` (#758), `GhStateReason` gains `duplicate`, and `runSpine` takes an optional third parameter — a store factory defaulting to `createSpineStore` (#851).

### Added

- ADR-0051 — a verb declares its own contract; amendment to ADR-0035; glossary group **Engine surface** (#763, PR #826).
- Verb contracts on all 68 verbs and ops, beside their runners, with a drift spec that proves every routed subcommand has exactly one (#821, #844).
- Receipts under `--json` for the 16 silent write ops (#822, #823).
- `--help` everywhere; the router roster rendered from the contracts; a guard that every contract section names every parser flag — it found three real omissions (#758).
- The six prose verbs under `--json` (#825).
- Skills, agents and the shipped driver invoke every verb by its canonical spelling, pinned by a spec (#824).
- ADR-0050 implemented: `**Enforced by:**` line on every convention file; the standing load and the loaded corpus as two pinned byte ceilings in `loaded-corpus-guard.spec.ts`, ratcheted to the landed measure at each wave's close (#806, #815, #858).
- Eleven `evidence/` files: derivations and incident histories out of the files a dispatch loads (Conventions 4, 8, 12, 13; wave-close phase 3; wave-start driver and start mechanics). wave-close's phase files are step load (PRs #831–#838).
- `wave-setup` scaffolds both guard hooks (#762).
- `config validate` warns on what it used to read past; `store-preflight` exercises the goal binding (#761).
- wave-start step 7c says how to read the scoped sweep's answer: exit 1 plus `erroredStillListed` is a denied removal, not an empty selection; teardown under the write-deny is an Operator act (#842).

### Changed

- Standing load 200,915 → 158,998 B; loaded corpus 1,289,381 → 1,219,868 B (measured by the guard on the release commit's parent).
- Exit codes and output channels — see Upgrading 6.

### Fixed

- The still-open close line tells the reader what to do instead of naming a maintainer-only file (#801).
- `issue-store annotate` usage states replace-vs-append per key (#760).
- Linear wording: `not_planned` is GitHub's, `In Review` is not a stock Linear status, `Backlog`/`Todo` are configured names (#797).
- ADR-0051's table: 45 group ops not 39, `host-pr` was never an unknown-flag refuser, `--json` position settled, usage-rendering status stated (#845).
- Convention 12's promoted prose paid back (#809).
- Missing-file messages unified; `describeConfigLoadError` docblock names its caller (#759).
- Six residues: the `goal-assign` receipt's `container` key is pinned; the spine receipts are proven not a re-parse through an injectable store; two stale "silently tolerated" sentences (`wave-config.ts`, ADR-0020) now say `config validate` warns; the Convention 8 evidence file cites the current heading; the bare-id strip no longer leaves a dangling `'s` in a PR title (#851).

### Not yet proven

- The Catalog (contracts as JSON) is decided, not built; no out-of-tree reader of the exported contracts yet.
- Each verb's own usage section is hand-written and guarded, not rendered (#856); the two spine gates answer `--json` with their exit code only (#859).
- The ceilings sit at 2 B (standing load) and 132 B (corpus) headroom by design — the next prose row pays in its own diff.
- Unchanged since 2.6.0: Bitbucket `host-pr status` title/body (#816), driver-template parse gate (#819), `close-row` on a tracked `.flotilla/`, the Linear retry window, the readiness gate's fail arm, `capability-gated` end-to-end, the `sandbox` block's reach, the Reviewer-only cell above cap, the inherited-WIP retry, the clean-room probe, `files-drift` (#707), headless.
- Filed bare or ready from the closes: #828, #830, #840, #856, #859.

## [2.6.0] — 2026-09-16

**The release that gives every fact one owner.** One wave since 2.5.0 — seven rows, five
serial rounds, two rows sent back once and approved at their second iteration, four
landing rulings and one blocking question — plus one decision record, and every line
below takes a fact that lived in two or three places and gives it a single home. The
terminal partition of the row-state vocabulary was spelled in three copies and one of them
was an untyped set; it is one exported constant now. A row's model tier was derived twice
— recorded by the Coordinator and silently re-derived by the composer — and the composer
now echoes the recorded value or refuses. Two Linear state keys were honoured at runtime
and typed nowhere; they are typed and documented. The done-reconcile program was prose in
two skills and the two spine sections it should have written stayed empty in a hundred and
two archives; it is one verb, and this release's own wave is the first whose spine carries
them. The Reviewer's host-seam sentence said three different things in three copies; it
says one thing, pinned. Minor: one value joins the package root, four optional members
join two exported types, one root export changes an observable outcome, one compose-time
default becomes a refusal — each named under Upgrading below — nothing is removed.

### Upgrading

Second entry with this section — the seven items [docs/RELEASING.md](docs/RELEASING.md)
prescribes, in its order, each answered. Items 1–5 are read from the diff since `v2.5.0`;
items 6 and 7 from the `## Heads-up` sections the wave wrote onto its row issues at
disposition (#751, #753, #755, #772, #777 — the carrier rule's first use as designed) and
from the package-root export ledger.

- **Plugin/marketplace update:** the plugin manifest moves to 2.6.0 and nothing else in
  it changes; the marketplace listing is byte-identical to 2.5.0. Update the installed
  plugin to 2.6.0.
- **Engine dependency pin** (vendored-form re-copy equivalent): `@formtrieb/flotilla-engine`
  moves from 2.5.0 to 2.6.0 — bump the pin (the `store-preflight --expect` lockstep
  advisory reads the pair). A vendor-copy consumer re-copies `tools/wave/` at this tag;
  that is the equivalent action, not a variant of the install phrasing.
- **Config keys added or changed:** two, both optional, both on the Linear store's
  `states` map (issue #755): `states.unclaimTarget` (default `Backlog` — where `unclaim()`
  and the triage cosmetic move land) and `states.unplanned` (default `Canceled` — where
  `closeUnplanned()` lands). Both were honoured at runtime before; they are typed on
  `LinearStateMapConfig` and documented in the setup tables now, and `store-preflight`'s
  `state-catalog` check verifies the *configured* names for all five required states. A
  consumer that already sets either key changes nothing; one that does not gets the same
  defaults it always had. No config that loaded before is refused.
- **Hook re-copy:** none — `hooks/` is unchanged since 2.5.0.
- **Allowlist parity:** none — the tracked permission-allowlist scaffold `wave-setup`
  writes is unchanged since 2.5.0 (its `states` and `store.goal` tables moved; the
  `permissions.allow` block did not).
- **Behaviour heads-ups** — four, each a changed outcome for an unchanged input, each
  ruled minor under ADR-0035 with the heads-up as the condition:
  1. **`compose-driver` refuses a row with no recorded model where it used to fall back
     silently** (issue #753). The composer fills a row's model from the `--row-meta`
     `model` override, else from the dispatch-log entry `spine set-branch --model`
     recorded, else it refuses before writing anything (exit 1, naming the row id, its
     Risk-derived tier and the `spine set-branch --model` remedy). The `wave-start` skill
     has always recorded `--model` at its flip step, so the operated path is unaffected;
     a hand-built spine, or a caller driving `compose-driver` directly without a recorded
     model, now gets a refusal instead of an opus/sonnet default. The Risk-derived helper
     returns only the abstract tier marker (`heavy` / `standard`); binding a tier to a
     concrete model id is the Coordinator's recorded act, and a config key for it is a
     deferred follow-on (ADR-0012 Amendment 2026-09-16; #803).
  2. **`upsertPrLogRow` no longer throws on the bare `## PR-Log` heading `renderSpine`
     produces** (issue #751) — it scaffolds the six-column header and separator and
     inserts the row. Anything that caught or asserted that throw sees a written table
     instead. The row's `Merged` cell records when the done-reconcile landed the row, not
     a verified merge date.
  3. **A Reviewer may read a PR's title and body through the engine** (issue #777). The
     Reviewer's host-seam clause — in the agent definition, in Convention 7, and in the
     composed brief the driver template renders — now names the read-only
     `host-pr status` read as allowed while still forbidding every host write and any raw
     host CLI. An acceptance criterion about a PR body becomes checkable by the role that
     checks everything else — from the first wave composed on this release (the composer
     builds the driver from the installed package asset, so a wave in flight on 2.5.0
     keeps the old brief). The Operator rule of 2026-09-16 that kept acceptance criteria
     off PR bodies is lifted with this release.
  4. **`store-preflight`'s `state-catalog` check verifies the configured state names, not
     the defaults** (issue #755). A Linear team whose catalog lacks the configured
     `unclaimTarget`/`unplanned` name now fails preflight naming that state where it used
     to pass on the default's presence. And, stated plainly because the row was reopened
     over the opposite claim: a typo in a `states` key is caught by the TypeScript type
     for a TypeScript author only — `config validate` still tolerates it by design, and
     the catalog probe verifies the default in its place.
- **Implementer heads-ups:** additive surface, nothing renamed or removed, the package
  barrel's diff since `v2.5.0` is one added line. **One new package-root value:**
  `TERMINAL_ROW_STATES: ReadonlySet<RowState>` — the terminal partition of the row-state
  vocabulary (`pr-created`, `approved`, `failed`, `abandoned`, `parked`), promoted onto the
  spine reader beside `ROW_STATES` (unchanged at eleven members and order); the CLI's
  terminal-wave verdict and the resume reconciliation read it instead of their own copies
  (issue #772). **Optional members on already-exported types:** `PrLandingStatus.title?`
  and `.body?` (issue #777); `LinearStateMapConfig.unclaimTarget?` and `.unplanned?`
  (issue #755). **A changed outcome on a root export:** `upsertPrLogRow`, above. **A new
  verb with allowlisted exports, not root ones:** `close-row` (issue #751) — its module's
  exports sit in the barrel-drift allowlist with stated reasons, modelled on
  `runRouteTuple`. **A module-local helper's return value:** `modelForRisk` (allowlisted,
  not root-exported) keeps its name and signature but returns the tier marker instead of
  a model id (issue #753). The Linear adapter's `LinearStateMap`, `DEFAULT_LINEAR_STATES`
  and `LinearIssuesStoreOptions` are unchanged.

### Added

- **`close-row` — the done-reconcile is one verb, and the two spine sections it writes are
  finally written** (issue #751). The program that landed a merged row — capture
  `verdict-acked` into a shell variable, guard it, parse it with `node -e`, call
  `issue-store close --acked` — stood as prose in the wave-close phase-5 reference and
  again in the wave-resume skill, in exactly the command-in-a-shell-variable shape the
  conventions warn about; and the spine's `## PR-Log` and `## Closed-by` sections were
  rendered by every spine and written by nothing — a hundred and two archived spines
  carried both empty. `close-row --spine <spine> --id <id>` upserts the row's PR-Log line
  and its Closed-by line (keyed by id, read-then-upsert, so a second row never deletes the
  first), derives the acked acceptance-criterion indexes from the latest valid verdict
  sidecar, then calls the store's `close(id, prUrl, acked)` — both spine writes before the
  store call, proven with an injected store and spine io that record call order. It prints
  JSON with a per-step `performed` / `performed-before` / `skipped` status and the closing
  state, refuses with exit 2 when the PR URL does not classify as a real PR, and forwards
  the `STILL OPEN:` line unchanged. Both skills call it; the derivation program is gone
  from both. Eight falsifications shipped with it, five re-run by the Reviewer.
- **The terminal partition has one typed owner** (issue #772). `TERMINAL_ROW_STATES` is
  exported from the spine reader, typed against `RowState`, and the CLI's terminal-wave
  verdict for the sweeps and the resume reconciliation read it. The row that motivated
  it: the CLI's copy was an untyped `Set<string>`, and a Reviewer's probe that replaced
  `parked` with a typo left the entire suite green — a parked-only wave would have read
  non-terminal and spared its residue forever. A parked-only `--orphans` case now pins the
  fifth literal, and the same typo turns thirteen cases and the type gate red
  (`Did you mean "parked"?`).
- **`host-pr status` prints `title` and `body`** (issue #777) — as strings equal to the
  host's current values on an open or merged PR, absent when the state is `none` or the
  host omits them, never empty strings, from the read the verb already performs (no
  additional host call; falsified, including four pre-existing exact-shape tests). Both
  shipped hosts surface them: GitHub live-proven by the row's own Worker running the
  shipped verb against its own PR; Bitbucket proven against the injectable seam only —
  see Unsettled. Four Reviewers in the same wave reported the gap this closes: a PR-body
  claim they could not check.
- **Two Linear state keys, typed and documented** (issue #755) — `states.unclaimTarget`
  and `states.unplanned` on `LinearStateMapConfig`, the setup skill's `states` table with
  all six keys and their defaults, `store.goal.container` and the verify `needs` classes
  in each store kind's setup table, and the preflight's catalog check verifying the
  configured names. Filed from a consumer whose `unclaimTarget: "Todo"` had been honoured
  at runtime and named in no type and no table.
- **A decision record for the loaded corpus** (PR #805,
  [ADR-0050](docs/adr/0050-the-loaded-corpus-is-a-pinned-measure-and-a-rules-enforcement-tier-decides-its-reading-class.md),
  the #714 / FOR-370 grill). Three reading classes — **Standing load**, **Step load**,
  **Evidence** — never called tiers; a rule's enforcement tier decides which class its
  prose belongs in, declared in a fixed `**Enforced by:**` line per convention file; the
  shared standing load and the loaded corpus become pinned byte measures in the guard
  (lowered freely, raised only in a diff that says so); wave-close's phase files become
  step load; `evidence/` is per skill. Amendments to ADR-0028 and ADR-0034, three glossary
  terms, and the charter's index lines for ADR-0049 and ADR-0050. Its ten implementation
  rows are filed bare (#806–#815) and are the next wave.
- **The candidate-id derivation's fail-safe null arm has a spec** (issue #780) — the arm
  that protects any future store with a different id shape, exercised once by a Reviewer's
  probe in the last wave and pinned now for all three shipped id shapes, asserting the
  store's closing probe is never reached on that path.
- **The composed Worker brief single-quotes the PR title** (issue #753, folded from #776).
  An inner single quote is escaped as `'\''`, the brief tells the Worker to run the line
  exactly as printed, and `prTitle` in the composed row stays the plain title — a title
  beginning with a backtick token no longer triggers command substitution, which it did
  live.

### Fixed

- **A branch slug ending in `model` no longer shadows the dispatched tier** (issue #767).
  The dispatch-log reader's `MODEL_REF` matched on `\b`, so a slug such as
  `…-view-model` followed by the real ` model sonnet` token captured the literal word
  `model` as the row's model — the shape the bug report showed as `"model": "model"`. It
  anchors on whitespace or string start now, with a positive and a negative case and the
  re-tuning path proven byte-identical.
- **Four pointers that taught something false** (issue #753): the Reviewer brief no longer
  cites a "policy clause 11" numbered only in the Worker brief; the DoR gate module and its
  specs spell the Gate-8 origin issue `#127`, not `FOR-127`; the wave-start skill no
  longer says the spine is flipped to `in-flight` (the frontmatter is confirmed `ready`
  and each row's State is flipped to `dispatched`); and the wave-shared and wave-start
  references name the shipped driver script — not the reference document — as the home
  of the anyOf-free schema copy. The issue's own "checked and not a defect" note on that
  last item was itself wrong, and the Worker showed it from the code.
- **The composer's model-id fallback is retired** (issue #753) — no string literal naming
  a model brand remains in the composer or the driver template's row fields (a spec scans
  both for the two retired literals); ADR-0012 carries the dated amendment. One concrete
  id survives by construction — the Scribe stage's own `agent()` argument — and is #803's.
- **The close skill's prose spells the terminal partition from the constant** (issue
  #772): the load-gate reference, the archive reference's terminality bullet, the
  worktree-cleanup reference's terminal-wave rule (both places) and the skill body's
  terminality-gate section name `TERMINAL_ROW_STATES` as the source of the five.
- **`cli-store.ts` no longer promises a "future config" that had shipped** (issue #755):
  the state-catalog comment that read "unless a future config exposes them" names the
  five configurable required states.
- **The Reviewer's host-seam sentence agrees with itself across all three copies**
  (issue #777): the agent definition, Convention 7 and the composed brief say the same
  thing, and a drift pin holds all three — the third copy, in the driver template, was
  outside the row's declared Files and reached it through a scope extension granted at
  the Reviewer's blocking question and projected into the iteration-2 brief.

### Changed

- **Four behaviours change for the same input — the heads-ups.** The composer refuses a
  row without a recorded model (issue #753); `upsertPrLogRow` scaffolds instead of
  throwing (issue #751); a Reviewer may read a PR's title and body through `host-pr
  status` (issue #777); the Linear preflight verifies configured state names (issue
  #755). Each is stated once, with what a dependent consumer does, under Upgrading above.
- **A merged row's done-reconcile writes the spine** (issue #751). Before this release a
  wave's close wrote the tracker and left the spine's PR-Log and Closed-by sections as
  bare headings; from this release on, a wave closed through phase 5 carries one PR-Log
  row and one Closed-by line per landed row. A consumer that tracks `.flotilla/` in git
  sees those writes in the close's commit.
- **The implementer heads-up is real but small.** One root value, four optional members,
  one changed outcome, one allowlisted module (Upgrading, item 7). The barrel's diff since
  `v2.5.0` is one added line and no removed line.

### Proven since 2.5.0

- **The half-applied re-dispatch checkout clause, twice live.** Landed in 2.5.0 with no
  live occurrence after it; both iteration-2 Workers of this wave hit it — `checkout -B`
  refused to unlink tracked skill files under the harness write-deny, reported the switch
  as successful, left the working copies stale — and both recovered exactly as the clause
  prescribes: compared every declared path against the branch tip, restored through the
  file-editing tool, re-asserted, never escalated. The second time the auto-mode
  classifier refused the first file-tool edit and the retry succeeded (#792's shape). The
  Reviewers measured that neither episode reverted anything.
- **The cleanup's exhaust-then-judge, a third positive read.** Seven Worker worktrees at
  the close: run 1 EXHAUSTED on every one, two survivors each (`.claude/agents`,
  `.vscode`), `exclusivelyDenied: true`, `manualRecovery` present, seven deferred branches
  named; after seven sandbox-off removes and a prune, run 2 deleted fourteen branches
  with nothing deferred. Decision 6 stands after three closes.
- **A terminal wave sweeps its own residue, a second read.** Nine own review refs and the
  composed-driver directory went on run 1 of the same close, with `liveRowIds: []`.
- **`close-row`'s first live use** — landed by this wave's own row 751, pulled before
  phase 5, and used to land all seven rows: every step `performed`, the acked indexes
  derived from the second-iteration verdict where one existed, every tracker row `done`.
  The archived spine is the first in this repository with a filled PR-Log and Closed-by.
- **The heads-up carrier, as designed.** Five `## Heads-up` sections written at
  disposition onto the row issues and read into this entry's Upgrading section — the
  rule 2.5.0 introduced, used for the first time without a hand-carried item.
- **The partial-coverage advisory pointed at the finding again.** Row 755's one blocking
  finding — a false "config validate sees a typo" claim — sat in its single inspection-only
  file (ADR-0020), where the advisory told the Reviewer to read by hand. Third wave in a
  row where the one defect landed in the file no verify profile backs. The claim's premise
  came from the issue text the Coordinator wrote; the iteration-2 brief said not to
  re-derive from it, and the Worker derived the replacement from the code and measured
  both halves.
- **The Reviewer falsified the Coordinator twice and the Worker falsified the issue
  once.** A routing note misquoted an agent-definition sentence (the Worker read the file
  instead); an issue body's "checked and not a defect" note was wrong (the Worker showed
  it from the anchor); the composer's stripped PR title was malformed for one row (the
  Worker reworded it, and the Coordinator's landing path learned to preserve the live
  title). None reached a landed artifact.
- **The public-API landing STOP resolved four times through the hand path, and a
  blocking question once through a scope grant.** The scope extension recorded on the
  spine at routing reached the iteration-2 brief through the composer (`scopeGrants: 1`),
  and the row's Reviewer confirmed the diff was exactly the two files the grant named.
- **No install-form failure in thirty-four dispatched agents.** Since the repo-relative
  prefix landed (2.5.0), every Worker and Reviewer of this wave installed clean; the
  Reviewers that chose absolute paths used the physical `/private/tmp` form.
- **Serial rounds re-anchored on the moved default branch, every round.** Five rounds,
  four re-anchors, every later Worker starting from a main that already contained its
  predecessors; the file-overlap map's four-row serial chain landed without one merge
  conflict.

### Unsettled by construction, and what is not yet proven

The list is 2.5.0's, re-read against the one wave since, plus what this release adds.

- **The Reviewer's PR read takes effect only from the first wave composed on this release
  — `verify`: that wave's first PR-body acceptance criterion.** Every Reviewer of the wave
  that landed it, including the one that reviewed it, still carried the old brief: the
  composer builds the driver from the installed package asset, not from the branch under
  review.
- **The Bitbucket half of `host-pr status`'s title/body is spec-proven only — `verify`:
  the next live Bitbucket `status` run** (#816). No Bitbucket credential is reachable in
  this repository; the adapter reads the fields off the collection response with no
  `fields` selector, which Atlassian documents as omitting verbose fields; the vendor
  document lists a third body spelling the fallback chain does not read.
- **The driver template has no parse gate** (#819). `node --check` cannot parse it in
  either module mode and every spec reads it as text, so an unbalanced template literal in
  a brief would ship with every test green. Two rows of this wave edited that literal
  structure; both verified their edits by rendering the function out of the file.
- **The composer's refusal has no live occurrence** — this repository's own dispatch path
  records `--model` on every row, so the refusal ran under test only. `verify`: a consumer
  driving `compose-driver` without a recorded model.
- **`close-row` on a consumer whose `.flotilla/` is git-tracked** — here it is ignored, so
  the spine writes never entered a commit. `verify`: the first consumer close on 2.6.0.
- **The Linear retry window still has no live read** (every wave since 2.4.0 ran on the
  GitHub store), **the readiness gate's fail arm has not held a live row** (no row filed
  since declares a resolvable blocker), **the `capability-gated` path has not run
  end-to-end**, **the tracked `sandbox` block's reach is open**, **the ruled Reviewer-only
  cell above cap has no live round**, and **the inherited-work-in-progress default has
  had no harness retry** — each unchanged since its last entry.
- **The `${CLAUDE_SKILL_DIR}` clean-room probe is still outstanding**, **the sandboxed
  `gh` mechanism is unmeasured by design**, **`files-drift` is run-or-retire for the #707
  grill**, and **headless is designed, not built** — unchanged.
- **ADR-0050's pinned byte measures are a decision, not yet a guard.** The ten rows that
  build the Enforced-by lines, the reading-class split and the two pinned constants are
  filed bare (#806–#815); until they land, the loaded corpus is measured in a decision
  record and enforced by nothing.
- **Filed from the wave's close, bare:** Linear wording residue (#797 — `not_planned` is
  GitHub vocabulary, `In Review` is not a stock Linear status, one fixed-name sentence
  left), engine residue (#800 — the `STILL OPEN:` sentence in two modules held together by
  a source-reading spec, a distance-shaped guard, a sixth hand-spelled copy of the terminal
  partition, the worktree-isolation guard's undocumented size threshold, one file-wide
  assertion, the composer's bare-id strip leaving a dangling possessive), maintainer
  mechanics in the consumer skill surface (#801 — three surfaces name `docs/RELEASING.md`,
  a file no consumer has), the last concrete model id and the deferred tier→id config key
  (#803), and the two above (#816, #819).

## [2.5.0] — 2026-09-16

**The release that checks before it judges.** Four waves since 2.4.0 — twenty rows,
twenty-two pull requests, nineteen rows approved at their first iteration and the
twentieth sent back once by a Reviewer who falsified the Coordinator's own triage claim
against the shipped SDK header — and every line below replaces a verdict that was being
reached before the evidence was in. The cleanup judged an aborted tree and read
`TRANSIENT` on a first run that was structurally unable to say `EXHAUSTED`; the readiness
gate deferred the cross-issue question before looking at a single declared blocker; the
Linear guard declared a write dropped after one immediate read; the release notes carried
no upgrade checklist and had already lost two heads-ups; an error code was attributed to
three different causes across the corpus without one measurement behind any of them.
Minor: eighteen values and twenty-six types join the package root, four behaviours change
for the same input and each is named under Upgrading below, nothing is removed and no
existing export moves.

### Upgrading

The first release entry to carry this section — the seven items
[docs/RELEASING.md](docs/RELEASING.md) prescribes, in its order, each answered. Items
1–5 are read from the diff since `v2.4.0`; items 6 and 7 from the `## Heads-up` sections
the waves wrote onto their carrier issue (#757) and the one ruling that predates the
carrier (#726), plus the package-root export ledger.

- **Plugin/marketplace update:** the plugin manifest moves to 2.5.0 and nothing else in
  it changes; the marketplace listing is byte-identical to 2.4.0. Update the installed
  plugin to 2.5.0.
- **Engine dependency pin** (vendored-form re-copy equivalent): `@formtrieb/flotilla-engine`
  moves from 2.4.0 to 2.5.0 — bump the pin (the `store-preflight --expect` lockstep
  advisory reads the pair). A vendor-copy consumer re-copies `tools/wave/` at this tag;
  that is the equivalent action, not a variant of the install phrasing.
- **Config keys added or changed:** none. `WaveConfig` has no new or changed key; the
  only movement under it is documentation on `engine.install` (its directory argument
  wants to be repo-relative — see Fixed) and the export of its validator.
- **Hook re-copy:** none — `hooks/` is unchanged since 2.4.0.
- **Allowlist parity:** one entry. The tracked permission-allowlist scaffold `wave-setup`
  writes gains `"Bash(git show:*)"` (issue #744): the Worker brief's refused-reset remedy
  now prescribes `git show <anchorSha>:<path>` as the source of a file-tool restore, and
  without the entry that read stalls an unattended row on a permission prompt. A consumer
  whose tracked `.claude/settings.json` mirrors the scaffold adds that one line
  (`permissions.allow`); the scaffold guard counts sixteen entries now. `git clean` is
  the scaffold's second deliberate absence — no prefix of it can be confined to the
  agent's own worktree — so do not add one when a dispatched agent asks.
- **Behaviour heads-ups** — eight, each a changed outcome for an unchanged input, every
  one ruled minor under ADR-0035 with the heads-up as the condition:
  1. **`worktree-cleanup` run 1 now reads EXHAUSTED on a harness-denied tree**
     (issue #621). The physical delete exhausts its permissions before the survivor
     set is judged, so `manualRecovery` is present on the *first* run instead of the
     second. If you scripted around `manualRecovery` appearing only on a retry,
     expect it as early as the first call.
  2. **A physically exhausted tree is now selected, not skipped** (issue #621). A
     dirty worktree whose surviving content is exclusively harness-denied is
     disposable at plan time (`WorktreeEntry.physicallyExhausted`, additive). If you
     treated every `skipped` entry as never-disposable, some of them are selected
     now.
  3. **A second call on an already-gutted tree now exits 1** (issue #621). It used
     to land in `skipped` (reason `dirty`, not a failure term) and exit 0 while the
     worktree stayed stuck; it now lands in `erroredStillListed` and exits 1. If a CI
     wrapper read exit 0 as "nothing to do" on a re-run, it now sees exit 1 and
     `manualRecovery` instead.
  4. **A terminal wave's own close now removes its review refs and composed-driver
     directory** (issue #748). Previously every ref a wave produced read `live-row`
     at its own close and became sweepable only at the *next* wave's close, and a
     `<slug>/` scratch directory was never swept at all. If you inspected those refs
     or that directory after your own wave's close, they are gone at that close now
     instead of surviving to the next one.
  5. **`manualRecovery.commands` on an EXHAUSTED `erroredStillListed` entry now has
     three entries instead of two** (issue #748). The third is an inert shell
     comment naming the re-run rule. If you asserted the array's length or exact
     contents, that assertion breaks.
  6. **The store-backed readiness check (`dor --id`) can now fail where it used to
     defer** (issue #750, PR #774). It used to push the cross-issue gate to
     `deferred` unconditionally; it now resolves each declared blocker — no
     blockers, or all closed, passes; at least one resolvable and still-open
     *fails*; a ref that cannot be resolved at all still defers. Anything scripted
     around `dor --id`'s exit code on a row that declares blockers needs a look — it
     may now exit 1 where it exited 0.
  7. **That same readiness check now makes network calls, and fails open to
     `deferred`** (issue #750, PR #774). Resolution issues one closing-probe call per
     declared ref; any failure (rate limit, timeout, refusal) degrades to
     unresolvable and therefore `deferred`. If you assumed `dor --id` touches no
     network, expect one probe call per declared blocker on a hosted tracker — and
     note that a transiently unreachable tracker silently turns a hold back off
     rather than surfacing an error.
  8. **The Linear store's verify-after-write guard re-reads before it declares a
     write dropped** (issue #726, PR #735 — the ruling the carrier rule names as its
     second lost occurrence, carried here by hand). The claim transition used to
     throw after one immediate read-back that still showed the old state; it now
     takes up to four read-backs 500 ms apart and throws only when every one still
     shows it. Three consequences on a Linear store: a genuinely dropped write now
     costs four reads and about a second and a half before it throws where it threw
     at once (the happy path is unchanged — the first read is still immediate); the
     thrown message changed shape and now states the attempt count and the elapsed
     bound (`4 read-back(s) over 1500ms still show state …`), so anything matching
     the old "reading the issue back immediately shows state" wording needs
     updating; and a transition that verified only on a retry is no longer silent —
     the store posts an advisory comment on the issue (marker
     `<!-- wave-transition-verify-retry -->`, failures to post swallowed) so a
     workspace whose reads lag its writes leaves evidence.
- **Implementer heads-ups:** additive surface only — nothing renamed, nothing removed,
  the package barrel's diff since `v2.4.0` is additions only, and an out-of-tree
  implementer compiles unchanged. Eighteen new package-root values and twenty-six new
  types, all barrel-enumerated and pinned by the export ledger:
  - from issue #732, the review-ref sweep: `REVIEW_REF_NAMESPACE_PREFIXES`,
    `listReviewRefs`, `planReviewRefSweep`, `executeReviewRefSweep`, `sweepReviewRefs`,
    `defaultReviewRefOps`, and the types `ReviewRefNamespace`, `ReviewRefSkipReason`,
    `ReviewRef`, `ReviewRefListing`, `ReviewRefSweepPlan`, `ReviewRefSweepResult`,
    `ReviewRefOps`, `ReviewRefSweepOptions`;
  - from issue #748, the composed-driver sweep and the deferred-branch accounting:
    `WAVE_ARCHIVE_RELATIVE_DIR`, `listComposedDriverDirs`, `planComposedDriverSweep`,
    `executeComposedDriverSweep`, `sweepComposedDrivers`, `defaultComposedDriverRemover`,
    and the types `ComposedDriverSkipReason`, `ComposedDriverFinishedRoute`,
    `ComposedDriverDir`, `ComposedDriverListing`, `ComposedDriverSweepPlan`,
    `ComposedDriverSweepResult`, `ComposedDriverRemover`, `ComposedDriverSweepOptions`,
    `DeferredBranch`, `DeferredBranchReason`, `ReviewRefPlanOptions`;
  - from issue #724, the twelve promotions: `normalizeEngineInstall`,
    `renderMisnamedSidecarWarning`, `resolveTitle`, `resolveDepsSetup`, `bindingPaths`,
    `gitignoredBindingPath`, and the types `VerifyCommandNeeds`, `BlockingPaths`,
    `ResolvedTitle`, `TitleSource`, `DepsSetupResolution`, `DepsSetupSource` — each a
    new name for an existing declaration, the indexed spellings
    (`NonNullable<VerifyCommand['needs']>`, `NonNullable<WorktreeEntry['blockingPaths']>`)
    still resolving to the same declaration;
  - from issue #750: the type `BlockerResolution`.
  Optional fields, all additive: `WorktreeEntry.physicallyExhausted` (#621);
  `OrphanBranchSweepPlan`/`Result.branchHygieneDeferred`,
  `OrphanBranchSweepOps.checkedOutWorktreePaths?()` (an optional member, so an existing
  implementation of the seam still compiles and yields `worktreePath: null`),
  `liveRowsDeclared` on both `ReviewRefSweepOptions` and the new `ReviewRefPlanOptions`
  (`planReviewRefSweep`'s optional third parameter; two arguments behave byte-identically
  to before) (#748); `ValidateViewOptions.blockerResolutions` (#750);
  `LinearIssuesStoreOptions.sleep` — a test seam for the retry pause; and two optional,
  defaulted constructor parameters on `LinearTransitionVerifyError` (`attempts`,
  `windowMs`), stamped as readonly fields, so a caller constructing it with the original
  three arguments still compiles (#726). The retry bounds themselves stay module-private:
  a caller that needs them reads them off the thrown error. On the CLI's JSON,
  `worktree-cleanup --orphans` gains `orphans.reviewRefs` (#732) and `orphans.drivers`
  (#748), `branchHygieneDeferred` sits beside `branchesDeleted` (#748), and `dor --id`'s
  cross-issue line can now read `pass` or `fail` (#750).

### Added

- **The cleanup exhausts its permissions before it judges** (issue #621,
  [ADR-0042 Amendment 2026-09-08](docs/adr/0042-the-sweep-owes-accounting-for-what-it-could-not-do.md)
  decisions 6 and 7). Phase 1 of the physical delete was a loop that the first refusal
  ended, so what stood afterwards was an *aborted tree*, never the *refused set*, and the
  "every survivor is harness-denied" verdict could not fire on a first run — three earlier
  fixes in this class each read evidence that exists only as a result of the first
  failure, and each was falsified on its first live read. The delete now attempts every
  top-level entry and, inside a refused subtree, every entry it can still reach; refusals
  are collected and thrown once as an aggregate carrying the shared errno when they agree
  on one; `.git` stays last and stays untouched when anything was refused; a symlink is
  never descended. What stands when the pass finishes *is* the survivor set, so run 1
  reads EXHAUSTED with `manualRecovery` on the input run 2 used to need. And an exhausted
  tree stays the sweep's own: a dirty worktree whose physical survivors are exclusively
  harness-denied is a second route to disposability at plan time, asked with the same walk
  the verdict uses, so the engine's own deletions cannot turn the worktree into a
  `dirty`-skip on the next run.
- **The sweep names what it defers, a terminal wave sweeps its own residue, and composed
  drivers are a population** (issue #748, decisions 9–11). A `wave/*` or
  `worktree-wf_*` branch a still-registered worktree holds is reported under
  `branchHygieneDeferred` (`branch`, `worktreePath`, `reason: 'checked-out-in-worktree'`)
  instead of silently dropped at the safety floor — the three-step sequence
  (sweep → manual removal → sweep) was always structural; the defect was that an empty
  branch list read exactly like a clean one, and it left twelve branches behind at one
  close. When the `--wave` spine's every row is terminal (`pr-created`, `approved`,
  `failed`, `abandoned`, `parked`) the wave's own refs are removed across all three
  namespaces — wave-level, never per-row, because a sibling that finishes first must not
  have its `refs/sib/<id>` swept out from under a Worker still predicting against it. And
  the per-wave `<slug>/` directory `wave-start` composes its driver into — reported
  `not-a-scribe-payload` and left standing, wave after wave, while two references promised
  it was swept — is a sixth sweep population under `orphans.drivers`, removed on either of
  two routes (`wave-terminal`, `spine-archived`) and refused on two (`live-wave`,
  `unknown-wave` — reported, never touched). `WAVE_ARCHIVE_RELATIVE_DIR` is the one new
  constant, and the single one both wave locations derive from.
- **The review-ref namespaces are swept** (issue #732). `refs/review/<id>`,
  `refs/review/sib/<id>` and `refs/sib/<id>` — the refs a Reviewer fetches a branch tip
  into — outlive the worktree, the local branch and the remote branch alike, and no pass
  reached them: 187 had accumulated in one shared `.git` since early August before a human
  swept them by hand. `worktree-cleanup --orphans` now lists, plans and removes them,
  shipped whole as list → plan → execute plus the one-shot and the injectable git seam.
  A ref belonging to a row of the `--wave` spine is spared `live-row`; a name that does
  not yield exactly one row id is left `unresolvable-row`; without a spine the pass
  removes nothing and reports `live-rows-unknown` — fail-closed, because the alternative
  deletes a sibling wave's refs out from under its Reviewer mid-diff. Deletion failures
  are collected under `orphans.reviewRefs.errors` and exit 1.
- **The store-backed readiness gate resolves declared blockers** (issue #750, PR #774).
  `dor --id` — the form `wave-create` and `wave-start` use — answered the cross-issue gate
  with a fixed `deferred` before it looked at anything; the "P2a re-home" ADR-0014
  promised never happened, and nine of twelve consumer waves resolved the question by
  hand. It now resolves each declared `Blocked by:` ref through the closing probe already
  on the store contract: no blockers or all closed passes, an open one fails naming the
  offending refs, an unresolvable one (cross-repo, cross-slug, unreadable, or an id shape
  the store cannot invert) defers — no evidence never counterfeits a clear answer. The
  pure gate function stays synchronous and store-blind: the CLI entry point that already
  holds the store resolves, and the outcome arrives as an optional field it branches on
  exactly as it already branches on a repo root. Recorded at the landing stop: the
  candidate-id derivation does parse one id forward, against ADR-0001's letter; the
  Operator ruled it acceptable as a single guarded self-check with a fail-safe null exit,
  and the reviewer drove that exit itself.
- **The Linear verify-after-write guard retries within a bounded window** (issue #726,
  PR #735) — a consumer's field report filed through the `report` skill: the guard aborted
  a wave dispatch mid-roster on a write that had landed, because its single immediate
  read-back raced Linear's own read-after-write lag, and the abort manufactured exactly
  the torn spine-written/rung-not state the write-ahead ordering exists to recover from.
  Bounded, never open-ended — a retry loop with no ceiling would quietly re-acquire the
  silence the guard was built to break — with both bounds pinned by tests that record the
  requested pauses instead of living through them. Confirmed at triage from the code: the
  claim transition is the only Linear write verb with a read-back guard at all.
- **The Worker brief handles what a harness retry leaves behind, a refused reset, and a
  half-applied re-dispatch checkout.** A retry re-runs a dispatched agent in the *same*
  worktree its earlier attempt was already working in — `isolation: 'worktree'` requests
  a worktree, not a fresh one — so the iteration-1 setup now reads the status before the
  reset and names the two honest options for inherited work-in-progress, discarding as
  the default and adoption only behind a recorded line-by-line review against every
  acceptance criterion (issue #731); it accounts for the untracked leftover a hard reset
  does not remove instead of contradicting its own "must be empty"; it gives the refused
  reset a branch — restore each surviving tracked path through the file-editing surface,
  sourcing the anchor's copy with `git show <anchorSha>:<path>` now that the read is
  allowlisted (issue #744), and STOP at `blocked` if the tree still does not hold; and a
  wave branch that already exists is taken over at the anchor with a tracking-free
  `checkout -B`. The re-dispatch setup gains the matching clause for a checkout the
  harness write-deny half-applied — `Operation not permitted` per denied path, then a
  reported-successful branch switch with those working copies silently kept at their
  pre-checkout content, which the checkout's own asserts read as clean and the
  corpus-scanning guards then validate as if committed (issue #778): compare every
  declared path against the branch tip, restore through the file tool, re-assert,
  never stage through the object store (the guards read the working tree, not the
  index). Every clause is a capability refusal under the no-escalation rule: no retry
  with the sandbox off, no request for one.
- **Twelve package-root promotions** (issue #724). The barrel names what was reachable
  structurally but not nameable — `VerifyCommand.needs` and `WorktreeEntry.blockingPaths`
  as `VerifyCommandNeeds` and `BlockingPaths`, the PR-title precedence ladder
  (`resolveTitle`), the install-step ladder (`resolveDepsSetup`), the gitignored-binding
  measurement (`bindingPaths`, `gitignoredBindingPath`), the install binding's validator
  beside its `cli` twin (`normalizeEngineInstall`), and the misnamed-sidecar warning's
  one renderer beside its already-exported detector. Twelve rather than the ten the issue
  named — the two result types ride along — ruled at the landing stop on the discriminator
  applied symbol by symbol: a symbol moves only where the module already exports the
  neighbouring half of the same rule.
- **A guard that keeps the engine free of `gh`, and the rule for the sandboxed `gh`
  failure** (issue #749). Measured with controls: `gh` fails with x509 in *any* nested
  shell context under the sandbox — a loop, a `$( )`, a subshell, a script file — and
  passes as a plain top-level call; `curl`, `git` over HTTPS and Node's `fetch` pass in
  the identical nested form, and the sandbox-off arm passes the identical failing `gh`
  form. The sandbox is the layer; the mechanism is unmeasured and the corpus now says so
  (see Fixed). The engine is structurally immune because no module spawns `gh`, and a
  spec-only guard keeps that true with positive and negative controls; convention 12
  carries the operator rule with its evidence sidecar; ADR-0015 carries the measurement.
- **Every release from this one carries an `### Upgrading` checklist** (issue #757) —
  the section above. Seven items, always in that order, every one answered explicitly;
  the behaviour heads-ups reach it through a fixed `## Heads-up` section on a tracker
  issue that the Coordinator writes at disposition and the release step reads, instead of
  through a spine that is archived the moment the wave closes. `README.md` and
  `docs/ONBOARDING.md` each point an existing install at the entry's Upgrading section in
  one sentence.
- **Three guard rows for surfaces the last wave shipped unguarded** (issues #741, #742,
  #743). The trigger-list corpus check moves to the prose-guard spec and now sees the
  elided spelling (`merge-, prod- and human-gated`) it exists to catch — one such statement
  already shipped in ADR-0049 §4 and read four triggers only by accident of adjacency; the
  partial-coverage advisory is pinned not to name a profile that matched nothing; the
  `route-tuple --title` catalog line and the verb's own usage text are asserted to carry
  the same precedence rule, and the review-ref sweep is driven through the CLI under test
  rather than only through a Reviewer's throwaway probe.

### Fixed

- **`npm ci --prefix` must be repo-relative — a symlinked prefix makes npm accuse a package
  that does not exist** (issue #725). `EUSAGE Missing: wave@<version> from lock file` —
  `wave` being the directory's basename, not the package's name — had hit dispatched
  agents since 1.0.1 and was reported only now; it fired once in twenty dispatches on
  2.4.0, in a Reviewer's own worktree. Reproduced deliberately with a positive and a
  negative control on the same directory differing only in the path's spelling, and read
  out of npm's arborist: an absolute prefix that resolves through a symlink
  (`/tmp` → `/private/tmp`) makes the install tree's root a *link* at a location the
  lockfile has no entry for, named from the folder. A relative prefix cannot reach that
  state, so the composed install line and the brief now spell it repo-relative. The form
  is narrowed, not replaced: no `npm ci` flag rescues the symlinked spelling, and
  `npm install` survives it only by never running the lockfile comparison — trading away
  the guarantee instead of satisfying it. `normalizeEngineInstall` still validates the
  absolute argument form (widening it would refuse a config that validates today); the
  gap is pinned in a test and folded into #761.
- **ADR-0049 follow-through** (issue #723): the Scribe brief carries the no-escalation
  clause too; the deferred valve reads four triggers in every remaining copy; the
  clause-presence spec bites on the clause *body*, not only its headline — a diff that
  keeps the bold line and deletes the instruction under it now fails; the Reviewer reads a
  PR's state through the engine's `host-pr status`, never through raw `gh`; and ADR-0049
  gains the amendment line for the harness fact the first live exercise found: a
  file-editing tool and a shell call carry different write rights on the same tracked
  path, so the write-deny is scoped per tool surface, not per path.
- **`verify.ts` no longer contains a NUL byte** (issue #724). The de-duplication key's
  separator was a control character that made the file diff as binary; it is a
  length-prefixed printable separator now, pinned by a whole-file control-character scan
  and by a collision case where a command itself contains the separator.
- **`wave-resume` step 5 levels with `wave-close` phase 4a** (issue #752). The two copies
  of the self-repair pull had drifted: the resume's pre-pull check knew two of the
  harness's three write-denied path classes (not `.claude/agents/`), named neither face of
  a half-applied pull, and prescribed `reset --hard origin/main` — which walks into the
  same denied unlink a second time. It now states both faces, the three-step recovery in
  phase 4a's order, and names the sandbox-toggle actor as the operator or the unsandboxed
  runner, never the skill's own agent (ADR-0009); a drift spec holds the two copies to the
  byte-identical pattern in both directions.
- **ADR-0040 follow-ups** (issue #537). `${CLAUDE_SKILL_DIR}` — the harness-documented
  per-skill anchor, never on the table when the sibling-path read was decided — is
  evaluated in a dated amendment and named as the remedy the still-outstanding clean-room
  probe decides; the plugin-root option's stale rejection reason is corrected against the
  fetched documentation. `wave-reviewer`'s "Related" note no longer argues that the
  Reviewer's dispatch name is a reasoned inference: it is `compose-driver`'s
  `REVIEWER_AGENT`, derived once per wave per distribution form and filled into the
  driver, never hand-spelled. `wave-resume`'s two leftover "load by name" lines read the
  sibling path like every other back-half skill.
- **`files-drift` is named honestly** (issue #754). CLAUDE.md, the charter, `to-issues`,
  ADR-0028, ADR-0041 and the driver template called it the runtime guarantor of a row's
  declared globs; no skill, agent definition or driver ever invokes it. The guard that
  actually holds a Worker inside its globs is the Reviewer's hand-run
  diff-against-declared-globs check, and every sentence now says so; `files-drift`
  computes the same arithmetic for a markdown issue file and is called by nothing. Whether
  to wire it or retire it is the #707 grill's question, deliberately not this row's.
- **The x509 attribution is retracted across the corpus** (issue #779, and issue #749's
  own second round). ADR-0023, ADR-0005, the charter, four retros, four skill files and
  five further carriers — one of them the sentence that rendered into every Worker's own
  termination brief — explained the sandboxed `gh` failure as the keychain and the proxy's
  interception certificate; the 2026-09-08 measurement's own controls (`curl` and
  `git ls-remote` through the identical proxy, same session, both green) contradict both.
  Retracted, never reassigned: no changed sentence names a new cause, retros keep their
  text with a dated correction beside it, the decision itself (`gh` leaves every
  host-write path) stands on its independent reasons. The same discipline caught the first
  round of #749 naming `-26276` as `errSecInternalComponent`: that constant is `-2070`,
  the literal appears nowhere in the macOS SDK, and no replacement is guessed.
- **ADR-0042 Amendment 2026-09-08** (PR #765, Coordinator-direct) records decisions 6–11
  with the falsification condition stated *before* the live read, and CONTEXT.md gains
  **Terminal wave** beside a post-exhaustion **Survivor set** and a **Manual recovery**
  that names its owner. Decision 8 is the one a consumer feels: the sandbox-off step
  belongs to whoever runs unsandboxed — the Operator interactively, the runner script
  around a headless pulse — never an agent, and a pulse reports it as *hygiene owed*.
- **`dor-gate`'s cross-issue deferral text** no longer promises a re-home that never
  happened; it names the store-backed form that now performs it (issue #750).

### Changed

- **Four behaviours change for the same input — the heads-ups.** Run 1 of the cleanup
  reads EXHAUSTED and a re-run over a gutted tree exits 1 (issue #621); a terminal wave's
  close removes its own refs and driver directory and the recovery block has a third line
  (issue #748); `dor --id` can fail, and it makes one probe call per declared blocker
  (issue #750); the Linear verify error's message states its bounds and a dropped write
  costs four reads before it throws (issue #726). Each is stated once, with what a
  dependent consumer does, under Upgrading above rather than a second time here.
- **`planCleanup` is no longer pure** (issue #621). The default probe touches the
  filesystem — asked only for an entry the junk route already refused, asked last, and an
  inconclusive walk answers `false` — so every hand-built fixture is unaffected, which the
  suite confirms.
- **`liveRowIds` has three readings now, not two** (issue #748): a non-empty list (live
  wave, rows spared), `[]` (terminal wave, own refs swept), `null` (never declared,
  nothing removed). An accidentally empty set still fails closed; only a *declared* empty
  set sweeps.
- **The implementer heads-up is real this time.** 2.4.0's barrel was byte-identical to
  2.3.0; this one adds eighteen values and twenty-six types (Upgrading, item 7) and
  widens seven option or result shapes with optional members. Additions only — the
  barrel's diff since `v2.4.0` contains no removed line.

### Proven since 2.4.0

- **The exhaust-then-judge falsification condition, read live twice** (issue #773). The
  baseline at the anchor, engine still pre-fix: five Worker worktrees, each
  `erroredStillListed` with `survivors.total` 1724 exact, `exclusivelyDenied: false`,
  ordinary content in the sample, no `manualRecovery`, an empty branch list. The first
  close after #621 and #748 landed: run 1 EXHAUSTED with `manualRecovery` on both of that
  wave's worktrees, two survivors (`.claude/agents`, `.vscode`), `exclusivelyDenied: true`,
  deferred branches named. The 2026-09-16 close read the same on seven. Decision 6 stands;
  ADR-0042 stays closed.
- **Decisions 10 and 11 in their first live read.** At the 2026-09-08 close the terminal
  wave's own nine review refs were removed (`reviewRefs.live: []`) and both composed-driver
  directories fell — the previous wave's `finishedBy: spine-archived`, its own
  `wave-terminal`; `branchHygieneDeferred: []`. At the close before that, the fresh review-ref
  sweep had correctly spared all ten of its own wave's refs as `live-row` — the one-wave lag
  the amendment then removed.
- **The `--prefix` failure reproduced under control.** Once in twenty dispatched agents on
  2.4.0 — deliberately unshielded so the measurement could arrive — then a constructed
  positive/negative pair on one directory, then the mechanism read out of npm's source
  with arborist instrumented. Four earlier operator-shell attempts to reproduce it had all
  succeeded, which is what the symlinked-spelling finding explains.
- **The preserved reuse title, against a real host** — 2.4.0's open item. Every
  `route-tuple` reuse since reported `titleSource: live-pr`, and no PR carried a second
  title; one squash inherited a raw ticket title precisely because the verb no longer
  rewrote what the Worker set.
- **The no-escalation clause, under a half-applied checkout and a refused reset.** A
  re-dispatched Worker whose `checkout -B` the harness half-applied probed the deny
  value-free, routed through the git object store, verified the staged delta, and neither
  disabled the sandbox nor asked for it (issue #778 was filed from that disclosure). A
  Worker whose reset was refused on four skill paths restored them through the
  file-editing tool from `git show <anchor>:<path>` — the exact read #744 prescribes,
  working live one round before its own PR merged.
- **The partial-coverage advisory earned its keep.** The one defect a Reviewer found in
  the blocker-truth wave — the Coordinator's own misidentification of `-26276` — sat in
  the single inspection-only file of its row, exactly where the advisory said to look, and
  the Reviewer falsified it against Apple's shipped `SecBase.h` rather than recalling it.
- **The public-API pairing advisory, checked rather than believed.** Two
  reconciled-merge verifies (a scratch worktree on the moved `main`, the pending row merged
  `--no-ff`, the full gates) found no rework; one semantic collision — #621's two-entry
  recovery assertion against #748's third line — was textually clean, predicted by Worker
  and Reviewer both, and fixed at rebase.
- **The `report` skill carried a consumer's finding upstream in the house format**
  (issue #726): provenance, reproduction, a hypothesis marked not verified, and one open
  question the triage pass answered from the code. It landed as a row with its facts
  intact.
- **The checklist's motivating hop is real.** One consumer's move onto 2.4.0 touched
  exactly the surfaces the checklist enumerates — marketplace ref, plugin update, engine
  pin, the two config keys 2.4.0 introduced, the hook re-copy, an allowlist-parity commit —
  worked out from the CHANGELOG and from error messages. That hop is why this entry opens
  with an Upgrading section.

### Unsettled by construction, and what is not yet proven

The list is 2.4.0's, re-read against the four waves since, plus what this release adds.

- **This checklist is its own first instance — `verify`: the first consumer hop onto
  2.5.0.** The section above was composed by the procedure it describes, and the fold of
  `## [Unreleased]` into a versioned entry happened for the first time; whether a hop is
  actually driven from it rather than from errors is the consumer's reading, not ours.
- **The Linear retry window has no live read — `verify`: the next Linear consumer wave's
  dispatch flip.** Every wave since 2.4.0 ran on the GitHub store; neither the retry nor
  the advisory comment has fired outside the suite.
- **The readiness gate's fail arm has not held a live row — `verify`: the first decorated
  row with an open declared blocker.** No row filed since declares one the store can
  resolve — nothing writes `Blocked by` after filing (#622) — so the arm has run under
  test and under a Reviewer's probe only; the pass-with-no-blockers arm ran on every row
  of the last wave.
- **The `capability-gated` path still has not run end-to-end.** Four more waves, every
  verify command ran, none refused for a capability reason.
- **Whether a project-tracked `sandbox` block widens a dispatched agent's own sandbox is
  still open by construction — `verify`: the first consumer setup that runs the new
  interview's live gate.** Unchanged since 2.4.0.
- **The ruled Reviewer-only cell above cap still has no live round.** Two public-API
  landing stops and one Reviewer-only recovery round at the *same* iteration occurred;
  none was above cap.
- **The half-applied re-dispatch clause (#778) has had no re-dispatch since it landed, and
  the inherited-work-in-progress default (#731) has had no harness retry since.** Both
  were built from a live occurrence; neither has a live occurrence *after*.
- **The `${CLAUDE_SKILL_DIR}` clean-room probe is still outstanding** (ADR-0040): the
  amendment names the remedy, and no load line switches until the probe decides.
- **The sandboxed `gh` mechanism is unmeasured by design.** The corpus now says so instead
  of naming a cause; the guard keeps the engine immune; the rule keeps `gh` out of nested
  shell contexts. A measurement that names the mechanism would be a new finding, not a
  retraction of this one.
- **`files-drift`, run or retire** — the #707 grill's question; until it is answered the
  verb is live, correct, and invoked by nothing.
- **Headless is designed, not built; Bitbucket's `arm` and `merge`, the Linear attachment
  upsert, the `prUrl` notice's forwarding, the team-key casing and the health-less mirror
  publish — unchanged since their last entries.**
- **Filed from the four closes, open:** the model tier read off a branch slug that
  contains the word `model` (#767), the terminal-row-state partition in three copies with
  an unpinned `parked` literal (#772), an acceptance criterion about a PR body being
  structurally unverifiable by a Reviewer that may not call the host (#777), the
  candidate-id derivation's null arm shipping without a spec (#780), `compose-driver`'s
  `siblingBranches` naming only the rows of the same round so a wave run in rounds hides
  its already-PR-created siblings from the merge-tree denominator (#791), a fresh dispatch
  worktree starting at `origin/main` rather than the wave anchor — so landing sibling PRs
  mid-wave forces every later-round Worker into a refused reset across harness-denied
  skill files, with the auto-mode classifier refusing the file-tool remedy
  non-deterministically (#792) — and an opt-in heads-up capture at disposition, decided at
  `wave-setup` and never a prescribed release procedure (#786). Beside them the
  hygiene pass that opens the next milestone: no engine verb answers `--help` (#758),
  three shapes of missing-file error (#759), `annotate`'s replace-versus-append usage
  (#760), `config validate`'s blind spots (#761), and `conv12-guard` reaching consumers
  unscaffolded with no re-copy step written anywhere (#762).

## [2.4.0] — 2026-09-04

**The release the consumers wrote.** Three repositories ran their first waves on 2.3.0
within a day of its publish, and every line below answers something one of them hit: a
build gate that needed the sandbox off and hung an unattended wave for five hours on a
prompt nobody could answer; a brief that asserted "nothing gitignored here" to a Swift
consumer whose engine binary lives in `node_modules`; a coverage gate that read a
half-tested row as fully tested; a pull request that ended up with three titles; a cleanup
that refused every worktree and named no reason. The answers were grilled into one
decision record and landed in two waves the same day, eight rows, sixteen agents each,
every row approved in its first iteration. Minor: a config field, a binding, two
dispositions, a routing cell and a flag join the surface; one reuse default changes and
one dogfood-store value changes, both under Changed below; nothing is removed, and the
package-root export list is byte-identical to 2.3.0.

### Added

- **A verify command declares what it needs, and a dispatched agent never escalates to
  get it** (issue #709, [ADR-0049](docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md)).
  `VerifyCommand` gains an optional `needs` — a closed set of three requirement classes,
  `writes` (paths outside the worktree), `network` (hosts) and `host` (a daemon socket,
  a simulator, a device: the class that cannot be narrowed) — validated at `config
  validate`, which refuses any other key and now reports how many commands declare a
  need. Both composed briefs render each command with its needs as data. The Worker brief
  states the rule in its own words — a dispatched agent never escalates its own
  permissions, attended or not — and retires the retry-with-the-sandbox-off path by name:
  a command refused for a sandbox reason whose need is unprovided is reported as not run,
  never re-run un-sandboxed, never dropped silently. The Reviewer runs under at most the
  Worker's rights, and its deferred valve gains `capability-gated` as a fourth trigger, so
  the acceptance criteria such a gate would have backed land `deferred` and the row
  continues: the human act moves from a blocking click to a disposition at close.
- **`wave-setup` provides what a gate declares** (issue #716). The verify interview asks
  per command which of the three classes it needs and records the answer as that
  command's `needs`; the AFK harness-config scaffold derives a tracked `sandbox` block
  (write paths and allowed domains, path-exact) from the declared `writes` and `network`
  entries; `host` never enters the tracked file — the docker note is rewritten as the rule
  for the whole class; setup runs each needs-bearing command once inside the scaffolded
  sandbox and records pass or refused, a refused declared-and-scaffolded need being a
  setup STOP. A parity spec holds the tracked block and the declared needs in step in
  both directions, the way the allowlist guard already does for `permissions.allow`.
- **The install step is a setup-time binding: `engine.install`** (issue #717,
  ADR-0032 amendment). The command that makes the engine binary exist in a tracked-files-
  only worktree now has a config home beside `engine.cli`, validated by the same
  repo-relative rule and reported by `config validate`. The composer's precedence is
  stated and pinned — row metadata, then the `--deps-setup` flag, then `engine.install`,
  then the step derived from the verify profile, then nothing — and each composed row's
  receipt names which level answered (`depsSetupSource`). When `engine.cli` resolves
  through a path the repository gitignores and no source offers an install step, the
  composer refuses instead of composing a brief that cannot run. The driver's three
  workspace-setup fallback sites no longer manufacture a confirmation: an absent install
  step renders as a deferral — none recorded, verify before the first engine call — never
  as "consumer confirmed: nothing gitignored here".
- **`upstream:<ref>` is a fifth disclosure disposition** (issue #683). A consumer's finding
  about the toolkit itself now has an honest exit at the archive gate — filed upstream,
  referenced — instead of `dropped:` with a reason that was never true. The reference is
  free-form and non-empty; the `report` skill files, the Coordinator records.
- **The Operator-ruled Reviewer-only round has its own routing cell** (issue #684).
  `route-verdict --ruling "<reason>"` and `route-tuple --ruling` admit an iteration above
  the re-dispatch cap — the one round the cap does not govern, because it re-reviews a
  fixed world rather than re-running the Worker. The reason is mandatory and quoted back
  in the result; a bare token is refused; cap accounting is untouched.
- **`host-pr create --body-file <path>`** (issue #702). A PR body read verbatim from a
  file, so a Worker can write more than one paragraph and a worktree-isolated caller
  survives the harness guard that refused a multi-paragraph `--body`. Exactly one of the
  two forms per call; a reuse that would drop the live close phrase is still refused.
- **A dirty cleanup entry names what blocked it** (issue #718). `worktree-cleanup`'s
  `dirty` entries carry `blockingPaths` — tracked-deleted, untracked and other-tracked
  survivors listed separately, bounded to twenty per bucket with an overflow marker — in
  the JSON and the text summary, so an operator sees which paths kept a worktree from
  being disposable without re-running `git status` by hand. The measurement the finding
  asked for was run with controls: none of the three path classes it could not explain is
  refused on this harness, so the classifier's denied set was correctly left alone; the
  hooks directory it named as missing had been in that set since the carve-out itself.
- **`route-tuple`'s result reports where the PR title came from** (`titleSource`:
  `live-pr` | `row` | `flag`), beside the body's existing summary source (issue #713).

### Fixed

- **Partial verify coverage is its own outcome** (issue #711). The `verify-profile-coverage`
  DoR gate read `pass` as soon as one declared file matched a profile; a row half in tested
  sources and half in untested application targets was indistinguishable from a fully
  verify-backed one. It now `warn`s, naming the uncovered files and the profiles that did
  match, and wave-create carries the uncovered files into the row's reviewer hint. The
  all-covered and all-uncovered texts are byte-identical to before.
- **`route-tuple` preserves the live PR title on reuse** (issue #713). One change carried
  three titles: the Worker's, the row's the verb wrote over it, and the Worker's again on
  the squash. The body was preserved by acceptance criterion; the title is the same claim
  in one line and is now preserved the same way — byte-identically, no strip, no trim —
  with `--title` as the explicit override and the create path's default unchanged.
- **The to-prd filing reference names the document verbs as `issue-store` subverbs**
  (issue #704) — the bare form printed the top-level usage and published nothing — and its
  store sentence names all three shipped stores, a PRD being a native Document on Linear.
- **Five reconciliation residues of the first-ten-minutes wave** (issue #699): ADR-0009
  carries the dated amendment line CLAUDE.md and the charter already carried; triage's
  boundary line enumerates the planning header as Files, Risk, Worker *and* Acceptance
  criteria, matching what the body codec requires on read; the shipped driver's
  `meta.phases` agrees with the script's phase usage; `closePhraseFor` on the markdown
  store composes a close line the reuse guard accepts (see Changed); `route-tuple`'s
  sidecar recovery runs the misnamed-sidecar sweep the dispatch path had stopped running.
- **The wave-close phase-3 reference names the classifier's denied set by its constants**
  instead of restating a stale subset, and says plainly that untracked build residue is the
  consumer's `cleanup.disposableNames` to declare; `wave-setup`'s disposable-names
  question names macOS/Xcode residue beside `.build` and `node_modules` (issue #718).
- **A decision record and a glossary term for the escalation seam** (PR #715). ADR-0049
  settles six forks — brief clause as the floor and setup coverage as the optimisation, no
  escalation ever, the need declared as a class and never a knob, the withheld gate
  through the Reviewer's existing valve, tracked for writes/network and local for host,
  enforcement as a brief clause — and CONTEXT.md gains **Capability requirement** beside
  *Scope extension*, with the ruling that "deferred" has three moments and a withheld gate
  is deliberately not a fourth sense.
- **The README header is drawn from a real wave** (PR #703): branches leaving `main`,
  running side by side, landing back — a consumer's actual wave, plotted, with the caption
  that says so.

### Changed

- **A reuse default changes — the heads-up.** `route-tuple` on a branch with an open pull
  request and no `--title` previously wrote the spine row's title over the live one and
  now leaves the live title standing. A caller that relied on the rewrite passes `--title`
  explicitly. Ruled at the public-API STOP with the strip deliberately *not* applied to
  the live title: the bare-id strip belongs on the row title, which comes off the tracker;
  the live title is Worker-authored text under mention discipline and is not the verb's
  to edit.
- **A dogfood-store value changes.** `closePhraseFor` on the markdown store composed
  `Closes #<slug>#NN` for a compound id, which the reuse guard refused; it now composes
  `Closes #NN`. Module-local, the GitHub and Linear paths byte-identical; only the local
  markdown store — dev and dogfood, never a consumer's tracker — sees the new value. Read
  against ADR-0035 at review and judged below the public surface; recorded here so the
  judgment is not rediscovered.
- **A blank install step no longer wins its precedence level.** An explicit empty
  `--deps-setup` or row-meta `depsSetup` used to resolve to an empty step; it now falls
  through to the next source. No documented recipe ever spelled a blank.
- **No implementer heads-up this time.** Every interface widening is optional —
  `VerifyCommand.needs`, `EngineConfig.install`, `OpenPrRef.title`,
  `WorktreeEntry.blockingPaths` — an out-of-tree implementer compiles unchanged, and
  `index.ts` is byte-identical to 2.3.0.

### Proven since 2.3.0

- **An installed-form dispatch from a composed driver, with the Reviewer resolving by
  its namespaced name — the read 2.3.0 said was missing.** Three consumers ran waves on
  2.3.0 the day after its publish; the one whose findings opened this release ran one row,
  four agents, zero agent errors, approve at iteration one, PR merged and archived, on the
  installed form with a Linear store. Issue #697 closes with this release on that evidence.
- **`route-tuple` in the dispatch path: eight returned tuples across the two waves of
  2026-09-04.** Among them a public-API STOP that wrote nothing, a transient host fetch
  failure whose re-run found every earlier step `performed-before` and wrote only the
  rest, and a Reviewer-only recovery round at the same iteration after a Worker reported
  a thirty-nine-character commit SHA — corrected through `write-report`, re-reviewed,
  routed, landed.
- **`--body-file` opened every PR of both waves** — eight Worker-authored, multi-paragraph
  bodies, none refused by the isolation guard, each preserved by the terminator.
- **The partial-coverage warn fired live the same day it landed**, at the second wave's
  cut, on two rows whose only uncovered file was the decision record each owed an
  amendment line — and each Reviewer stated the inspection-only half in its verdict.
- **The no-escalation clause in its first live exercise, on both roles.** A Reviewer's
  scratch-worktree removal was refused by the sandbox and it did not force it; a Worker's
  `git reset` was refused on tracked skill paths and it used its file-editing tool
  instead. Both disclosed; neither escalated.

### Unsettled by construction, and what is not yet proven

The list is 2.3.0's, re-read against the two waves of 2026-09-04, plus what this release
adds to it.

- **The `capability-gated` path has not run end-to-end — `verify`: a consumer wave with a
  declared need that setup did not provide.** Every verify command in both waves ran; no
  command was refused for a capability reason; the acceptance criteria that shipped the
  path are artifact-level. The first live exercise is a consumer's.
- **Whether a project-tracked `sandbox` block widens a dispatched worktree agent's own
  sandbox is open by construction — `verify`: the first consumer that runs the new setup
  interview's live gate.** No dispatch can observe it: neither agent may write the tracked
  settings file, and a successful write needs a fresh session to observe. The setup half
  grounds its go/no-go on the vendor's documented settings scope, re-fetched independently
  by both agents, and states the deferral in the row's own report.
- **No consumer has declared `engine.install` or a `needs` yet — `verify`: the next
  consumer setup on 2.4.0.**
- **The preserved reuse title has not been exercised against a real host — `verify`: the
  next wave's first reuse.** Both reuses of 2026-09-04 preceded the fix landing; the
  vendor list-PR shapes are confirmed from the documented forms (GitHub by the Worker,
  Bitbucket by the Reviewer from the downloaded OpenAPI spec).
- **The ruled Reviewer-only cell has no live above-cap round yet, and `upstream:` has no
  consumer use yet.** Both landed in the wave that opened this release; neither situation
  arose since.
- **The residue-probing worktree classification: two more negative reads (2026-09-04,
  both closes).** The sandboxed sweep reported every agent worktree `erroredStillListed`
  with survivors; the documented sandbox-off removal cleared them each time. The new
  `blockingPaths` field was not observed on those entries — they were refusals of the
  removal itself, not junk-classification misses — so its first live read is still owed.
- **Headless is designed, not built; Bitbucket's `arm` and `merge`, the Linear attachment
  upsert, the `prUrl` notice's forwarding, the team-key casing and the health-less mirror
  publish — unchanged since their last entries.** Sixteen more Scribe rounds completed
  clean without a notice arising.
- **Filed from the two closes, bare:** the ADR-0049 follow-through bundle (#723 — the
  Scribe brief's missing clause, two stale copies of the valve, a headline-only clause
  spec, a reviewer reaching for raw `gh`, and the harness fact that a file-editing tool and
  a shell call carry different write rights on the same tracked path), the engine-hygiene
  bundle (#724 — the module-private types and helpers the barrel should name, a NUL-byte separator
  that makes `verify.ts` diff as binary, a missing negative assertion), a fresh-worktree
  `npm ci` failure at the lockfile (#725), a retried Worker inheriting its own earlier
  attempt's uncommitted work (#731), and the review-ref namespaces no sweep reaches — 187
  stale refs at one close (#732).

## [2.3.0] — 2026-09-03

**The release after the first ten minutes.** Everything in it was found by measuring a
stranger's first hour on a throwaway consumer
([`docs/retros/2026-09-03-quickstart-probe.md`](docs/retros/2026-09-03-quickstart-probe.md))
and fixed before the demo is recorded, so the package a stranger installs matches what the
recording will show: no hand-typed label loop, no hand-transcribed dispatch script, no
guessed Reviewer name, the ten guarded shell calls per landed row collapsed into one verb,
and a quarter less to read before the first agent runs. Minor, because a flag and two verbs
join the CLI surface and two interface widenings earn the implementer heads-up below;
nothing is removed.

### Added

- **`store-preflight --create-missing-labels`** (issue #675). The GitHub label set a wave
  reads — the claim rungs, `needs-attention`, the triage states — is created through the
  engine credential, opt-in and idempotent: a label that exists is left byte-untouched, a
  missing one is created with the engine's colour and description, and the receipt names
  both sets. Setup no longer sends a stranger through a hand-typed label loop.
  `wave-setup`'s credential-scope table names the write (`POST /repos/{owner}/{repo}/labels`
  — Issues: read and write) and `docs/ONBOARDING.md` names the flag as the setup act.
- **The Workflow dispatch driver ships as a package asset, and `compose-driver` composes
  it** (issue #680). `driver/wave-start-inflight.js` is the source of truth for the
  dispatch script — nothing is pasted from a reference document or filled by hand any
  more. `compose-driver --spine <spine> --config <cfg> --anchor <sha> --out <path>
  [--row-meta <json|path>] [--reviewer-agent <name>] [--plugin-manifest <path>]` reads the
  spine's dispatchable rows and the dispatch-log, re-reads each row's spec through the
  store on every run, fills the five compose-time constants and the per-row roster,
  projects the verify gate, the dependency install and the store-kind close phrase from
  the config, writes the file the harness Workflow tool takes as its `scriptPath`, and
  prints one JSON receipt. The Reviewer agent name is **derived per distribution form**
  from the plugin manifest and the agent definition — bare `wave-reviewer` in the source
  form, `flotilla:wave-reviewer` in the installed form — with an explicit override and a
  loud refusal where neither is available; this closes the agent-name gap the first
  installed-form run hit (issue #677). The required-row-fields and human-gate assertions
  move into the engine, joined by a `foreground` refusal and the anchor-resolvability
  gate; the compose-currency checklist and the compose-fresh-or-verify rule retire with
  the transcription they policed. The engine still calls no agent-harness primitive: it
  writes a file, the harness runs it — ADR-0009's principle, clarified by one dated
  sentence each in `CLAUDE.md` and the charter. The composed file lives **inside the
  repo**, under the gitignored `.flotilla/tmp/`, because the harness can only start a
  workflow from a file the session is already allowed to read.
- **`route-tuple` lands one returned tuple in a single verb** (issue #681).
  `route-tuple --spine <spine> --id <id> --iter <n> --report <path> --verdict <path>
  --anchor <sha> --config <cfg> [--title <text>]` performs the post-return write-ahead
  sequence the mechanics prescribed as ten guarded shell calls — sidecar presence and
  validation (a missing or corrupt sidecar is recovered from the payload), outcome
  routing, verdict routing with both `--state` values derived rather than typed, the
  verdict render, create-or-reuse of the PR, the status re-query, the two spine writes,
  the rung transition — and prints exactly one JSON result naming every step and what it
  returned. A stop prints the stop and performs no spine, host or tracker write; a
  re-dispatch writes the row state and the iteration bump only; disclosure capture stays
  a separate, judgment-carrying call. Re-runnable: a second run reuses the open PR,
  appends no second verdict section, re-transitions no rung, and reports each step as
  performed-before. An existing Worker-authored PR body is preserved with the verdict
  section placed beneath it; the verdict digest is only the fallback when no PR exists.
  `createOrReusePr` is lifted into the host-pr library so the CLI and the verb call one
  function. wave-start step 7 shrinks to the verb call and the reading of its result.
- **triage and to-issues say, in the same words, that `ready-for-agent` is a two-skill
  state** (issue #679). triage's `ready-for-agent` outcome names to-issues (decorate) as
  the next step, never wave-plan; to-issues' decorate rule is conditional — never replace
  an existing `## Acceptance criteria` section, lift the brief's criteria verbatim into
  the body when it has none — in the SKILL body, its Common Mistakes bullet and the
  filing-mechanics reference; wave-plan's hand-off and the README quickstart name the
  order. Prose only; the one-gate readiness redesign is deferred to a decision record.

### Fixed

- **`listOpen` and `listClaimed` union the native blocked-by the way `read` does**
  (issue #654). On both the GitHub and the Linear store the scan path returned only the
  body-codec edges, so a dependency drawn natively — GitHub's issue-dependencies API,
  Linear's blocked-by relation — was visible to `read` and invisible to the candidate
  table wave-plan draws from. Both scans now return codec ∪ native, and the conformance
  suite gains an `addNativeDependency` hook so every store proves it the same way.
- **`dor`'s `verify-profile-coverage` tells "no config reached this check" from "config
  loaded, no verify block"** (issue #676). The CLI normalises an absent `verify` to
  `{ profiles: [] }`; a loaded config with no profiles is a `pass` with a note, and only
  a call that never saw a config defers. Two facts that shared one `deferred` text no
  longer do.
- **Conventions 13, 12 and 8 moved their occurrence narratives to `evidence/`**
  (issue #689): a quarter less across the three files (46.7 → 30.0 KB, 27.7 → 20.2 KB,
  29.7 → 27.7 KB), the wave-shared reference directory from 183 KB to 157 KB, every rule
  and every cited occurrence still resolvable one hop away.

### Changed

- **Two interface widenings, both implementer-facing — the heads-up.** `GitHubApi` gains
  `createLabel` (issue #675) and `SpineStore` gains a required `setRowIter` member
  (issue #681): any out-of-tree implementer of either interface must add the method. A
  consumer merely *using* the engine sees nothing — no runtime export moves or changes
  shape — and only the type gate sees it. Minor per the house rule, the same shape as the
  widenings 1.5.0, 2.1.0 and 2.2.0 carried and ruled on. Additive at the package root:
  the `CreateLabelInput` type, and `createOrReusePr` with its four types.
- **The documented dispatch and routing sequences shrink to two verbs.** wave-start step 6
  is one `compose-driver` call and its receipt; step 7 is one `route-tuple` call and its
  result; the compose-currency gate, the compose-fresh-or-verify rule and the
  four-hundred-line script fence are gone from the reading a Coordinator loads.
  wave-resume names the same two verbs where it re-composes and re-routes; the
  wave-shared routing-mechanics reference describes the whole-tuple verb and keeps the
  single-verb pages as the resume path's building blocks; conventions 4 and 5 name the
  verb where they cited the shell sequence it replaced.

### Proven since 2.2.0

- **`compose-driver` composed the driver that dispatched its own successor row,
  2026-09-03, source form.** The last row of the wave that shipped it (issue #681) was
  dispatched from a driver the verb wrote: receipt read, twenty-five currency assertions
  green over the composed file, four agents, zero errors, PR merged. The installed form's
  *compose* is proven by a packed-tarball run in a throwaway consumer that produced a
  byte-identical script (the Reviewer's simulation on the #680 branch); an installed-form
  *dispatch* from a composed driver is not yet on record — that is what the demo
  recording on a fresh throwaway consumer will be.
- **Every row of the wave that built this release landed in iteration one.** Seven rows
  in three tiers, twenty-eight agents, zero agent errors, two public-API rulings each
  resolved by one Coordinator commit on the branch, and every Worker-authored PR body
  preserved through the terminator — the first wave where that held from the second tier
  on (the first tier's bodies had to be recovered from agent transcripts, which is why
  `route-tuple` preserves an existing body by construction).

### Unsettled by construction, and what is not yet proven

The list below is 2.2.0's, re-read against the wave of 2026-09-03 that built this
release. Each item lands as one of three things: a dated proof naming its evidence, a
dated *still not proven*, or `verify` naming the one read that would settle it.

- **`route-tuple` has no live dispatch-path use yet — `verify`: the next wave's first
  returned tuple.** It landed in the last row of its own wave, so every tuple of that
  wave was routed with the single verbs it replaces. Its specs pin every branch against
  the in-memory host and store fakes, and three falsifications were reproduced by the
  Reviewer; a real tuple through the verb is the read that is still missing.
- **The harness's refusal to start a workflow from a path outside the working directory
  is documentation-read, not observed.** It is why the composed driver now lives under
  `.flotilla/tmp/`; the session that built this release ran composed drivers from an
  allow-listed scratch path without ever meeting the refusal. `verify`: unnecessary —
  the in-repo path sidesteps the question by construction.
- **Headless is designed, not built.** Unchanged since 2.2.0: ADR-0047 and ADR-0048
  remain `proposed`; no engine verb, skill or branch from either record exists yet.
- **Bitbucket's write half is proven for `create` and `status`; `arm` and `merge` are
  not, and will gain no further evidence on this line.** Unchanged since 2.2.0.
- **The Linear attachment upsert — `verify`: the next Linear-store consumer close, read
  for the closing-PR attachment on the closed issue.** Unchanged since 2.1.0; this
  release's wave ran on GitHub Issues.
- **The `prUrl` notice's agent-mediated half — fourteen more Scribe rounds completed
  clean on 2026-09-03, and still no notice arose in any of them.** The forwarding itself
  remains unread; `verify` is unchanged: the next wave in which a notice actually fires.
- **The residue-probing worktree classification is still not proven, and a third
  negative read is now on record (2026-09-03).** In this release's wave the sandboxed
  removal of the agent worktrees reported `erroredStillListed` with survivors on the
  first tier, and the documented sandbox-off removal cleared every worktree on all three
  tiers. The manual sandbox-off force-removal remains the ordinary path.
- **The grant-in-brief plugin half — still not proven, and the gap is unchanged: a
  mid-wave `issue-store annotate` followed by a re-compose on an installed-form
  consumer.** This wave's re-composes were per tier on the source form, none after a
  mid-wave annotate.
- **The uppercase-team-key assumption — `verify`: record the actual team-key casing the
  first initiative-bound live pass encounters.** Unchanged since 1.5.0.
- **A health-less mirror publish may still move the container's own health — `verify`:
  the first live `goal-publish-update` call with `health` omitted, read against the
  container afterward.** Unchanged since 2.1.0.
- **`LINEAR_UPDATE_HEALTH_VALUES` is still schema-read, not live-proven — `verify`: the
  same first live mirror publish.** Unchanged since 2.1.0.

## [2.2.0] — 2026-09-03

**The release the public step lands on.** No new station ships here: this is the version
a stranger meets, so the work went into the seams a stranger actually hits. Two
merge-order defects — both found by reading a real consumer's spine, not by a test — are
fixed. An unknown engine verb now answers with the whole roster and a reason to pick each
entry, instead of a bare name to re-guess from. `wave-setup` closes by offering the
consumer's own agent a standing orientation block. And the reading a visitor lands on — a
dated capability matrix, the second-audience README sections, the community files — is
here rather than promised. One widening earns the implementer heads-up below; it is the
whole reason this is not a patch.

### Added

- **An unknown verb or op prints the verb list, one line each** (issue #650). An unknown
  top-level subcommand — and an unknown op under `issue-store`, `spine`, or `host-pr` —
  now prints the full roster one entry per line, each with a one-line purpose sourced
  from that group's own parser-paired usage table, instead of a single joined name list.
  The pre-existing summary line, the exit code (`2`), and every *known* op's own
  usage-error contract survive **byte-for-byte**; only the unknown path's text grows. The
  top-level purpose table is typed `Record<Subcommand, string>` over the very union the
  router dispatches on, so a verb added to one without the other is a compile error — the
  roster cannot drift from the dispatcher it documents.
- **`wave-setup` offers the consumer a standing orientation block** (plugin side, issue
  #653). Setup's last step previews a short, plain-language block for the consumer's
  `CLAUDE.md` (or `AGENTS.md`) and writes it **only on an explicit yes**: the one binding
  config file, the skills by name, the protected-branch / PR-only rule, the claim labels
  and states as engine-owned, the triage state as the readiness signal, and the `report`
  skill as the route for feedback. A marker comment makes a re-run idempotent without
  touching a block the consumer has since edited; a decline leaves every consumer file
  untouched, and setup still completes.
- **A dated capability matrix per tracker and code host**
  ([`docs/CAPABILITIES.md`](docs/CAPABILITIES.md), issue #642), summarised in the README
  and pointed at from `ONBOARDING.md` and `llms.txt`. Every cell is either a dated fact
  naming its evidence or the word `verify` naming the one read that would settle it —
  including the two footnotes a consumer has to plan around: Bitbucket Cloud has no
  arm API (BCLOUD-22062, open since 2023), and arming on GitHub requires branch
  protection, which on the Free plan exists only for public repositories.
- **The reading a visitor actually does.** README sections for the second audiences —
  using the engine on its own, the `report` skill as the upstream feedback funnel, the
  cross-repo capability named (#646); the files a public repository owes a contributor —
  `CONTRIBUTING.md`, `SECURITY.md` naming the direct advisory link, a code of conduct,
  three issue forms, a plain-language PR template, `llms.txt` (#652, #665); and
  ADR-0047 / ADR-0048 recording the headless design as `proposed` (see the first
  not-yet-proven item below).
- **Keywords on the npm package.** The package carried none, so it was unfindable by
  registry search.

### Fixed

- **`parseWaveSpine`'s Plan-Table fallback no longer numeric-tail-matches a
  tracker-backed row** (issue #635). The #84 fallback matched *any* Plan-Table row id — a
  tracker-backed `TEAM-89` included — against `.scratch/**/issues/{,done/}<NN>-*.md`. A
  coincidental digit match against a frozen predecessor `.scratch/` corpus silently
  rerouted merge-order onto foreign issue files, dropped every real row, and returned
  **"Empty wave" with zero warnings** — a wrong answer that looked like a clean one. The
  fallback now runs only when *every* Plan-Table id is fs-form (bare digits, or
  `slug/NN`): a single non-numeric-prefix id is proof by construction that the spine is
  tracker-backed, so the `.scratch/` corpus is never consulted and the existing
  spine-self-contained path is taken instead. When the fallback does legitimately rebind
  an fs-form row, that rebinding is now reported in `warnings` instead of happening
  silently. Reproduced as a failing regression spec against the pre-fix code before the
  gate was written.
- **`parked` rows leave the algorithmic merge order and the branch-recovery warning**
  (issue #636). ADR-0022 makes `parked` a claim-releasing terminal — a row deliberately
  taken out of *this* wave, held before dispatch or released at a STOP — and its own text
  already excludes it from the advisory order. But `buildSpinePrs` filtered only
  `neverDispatched`, so a parked row fell through into the branch-null "in play" arm,
  rode into `algorithmic`, and raised a "no branch could be recovered from the spine"
  warning that sent operators hunting for a dispatch-log entry that was never supposed to
  exist. Parked rows now join the existing `notInPlay` bucket unconditionally —
  `MergeOrderResult` gains no field — regardless of whether a stale branch from an
  earlier failed dispatch happens to be on file. The branch-recovery warning for a
  genuinely dispatched row is untouched, byte-for-byte.

### Changed

- **`ParsedSpine` widens by ONE required field — the implementer heads-up.**
  `warnings: string[]` is now required on `ParsedSpine`, a package-root exported type, so
  the Plan-Table fallback's rebinding notice can travel out of `parseWaveSpine` and be
  merged into `MergeOrderResult.warnings`. **Breaking for any consumer that *constructs* a
  `ParsedSpine` itself** — a hand-built fixture, a test double — and invisible to any
  consumer merely *using* the engine: `MergeOrderResult` and the CLI surface are
  unchanged, no runtime export moves, and only the type gate sees it. Minor per the house
  rule, the same shape as the widenings 1.5.0 and 2.1.0 carried and ruled on. The fix at
  a call site is one line: add `warnings: []` to the literal.

### Proven since 2.1.0

- **The installed form ran end to end on a fresh consumer, 2026-09-03 — the first
  measured stranger's arc.** Plugin `flotilla@formtrieb` and engine
  `@formtrieb/flotilla-engine`, both 2.1.0, on a throwaway GitHub-Issues repository with
  no prior flotilla state: install → `wave-setup` → `triage` → `to-issues` → `wave-plan`
  → `wave-create` → `wave-start` → `wave-close --auto`; one issue, one PR, merged and
  archived. 59 minutes wall clock, 4 agents, **0 permission prompts and 0 Coordinator
  misfires during the wave itself**, 3 operator hand steps (all three now documented
  steps rather than surprises). The credential indirection held — the token appeared in
  no output — every read-back matched its write, and `host-pr arm` on a check-less PR
  returned `merged` with a usable reason. The full measurement, its thirteen findings and
  where each one was filed:
  [`docs/retros/2026-09-03-quickstart-probe.md`](docs/retros/2026-09-03-quickstart-probe.md).
  That probe is also what corrected the README quickstart, `docs/ONBOARDING.md` and
  `wave-setup` in this release.

### Unsettled by construction, and what is not yet proven

The list below is 2.1.0's, corrected against live operation on 2026-09-02 (issue #641)
and re-read against the consumer probe of 2026-09-03. Each item lands as one of three
things: a dated proof naming its evidence, a dated *still not proven*, or `verify` naming
the one read that would settle it.

- **Headless is designed, not built.** The answer half of `needs-attention` and the
  headless run are settled as two `proposed` records — ADR-0047 (a typed **Answer** bound
  to a spine-anchored **Ask**) and ADR-0048 (a finite **Pulse** on a leased `spine/<slug>`
  branch) — grilled 2026-09-01/02 against the shipped records and the code. Four premises
  of the original sketch fell to that reading and are recorded there. No engine verb,
  skill, or branch from either record exists yet; the glossary marks each new term
  accordingly.
- **Bitbucket's write half is proven for `create` and `status`, live-proven 2026-08-17;
  `arm` and `merge` are not, and will gain no further evidence on this line.** A spine
  reading (2026-08-31) of a consumer wave run 2026-08-17 shows `host-pr create` (the
  Basic-auth path, five PRs) and `host-pr status` (mergeability reads) running live
  against Bitbucket Cloud. `arm` and `merge` have no live reading on record, and that
  consumer moves to GitHub in September 2026 — this corrects 2.1.0's line, which named
  the whole write half unproven without separating the two verbs actually exercised from
  the two that were not. `docs/CAPABILITIES.md` now carries the same split per cell.
- **The Linear attachment upsert — `verify`: the next Linear-store consumer close, read
  for the closing-PR attachment on the closed issue.** Unchanged since 2.1.0 (issue
  #511): no consumer close is on record since, and the 2026-09-03 probe ran on GitHub
  Issues, so the URL-uniqueness upsert semantics against a real workspace are still
  unread.
- **The `prUrl` notice's agent-mediated half — a completed Scribe round is now on record,
  and no notice arose in it, so the forwarding itself is still unread (2026-09-03).** The
  probe's wave completed both Scribe stages clean, with `write-report` and `write-verdict`
  validating — which is the round 2.1.0's line was waiting for. But no notice was raised
  during it, so a real notice forwarded by a real Scribe has still never been observed.
  The engine side stays live-measured; `verify` is now narrower than it was: the next wave
  in which a notice actually fires.
- **The residue-probing worktree classification is still not proven, 2026-09-03, and
  unchanged.** Measured negative twice against two different implementations, exactly as
  2.1.0 recorded; no third read is on record, and the manual sandbox-off force-removal
  remains the documented ordinary path. The 2026-09-03 probe's cleanup ran through
  `wave-close --auto`'s branch deletion and did not exercise it.
- **The grant-in-brief plugin half — still not proven, 2026-09-03, but the gap has
  narrowed to the timing.** `verify` was "a mid-wave `issue-store annotate` followed by a
  re-compose, exercised on an installed-form consumer". The installed-form consumer now
  exists and is measured — but its `annotate` ran during `to-issues` decoration, *before*
  `wave-create`, and no re-compose followed. What is still outstanding is precisely a
  mid-wave annotate on that form.
- **The uppercase-team-key assumption — `verify`: record the actual team-key casing the
  first initiative-bound live pass encounters.** `isIssueShapedId`'s
  `/^[A-Z][A-Z0-9]*-\d+$/` narrowing is unconfirmed against a live workspace; the goal
  skill's own reference still carries this as a pending-first-live-run note, unchanged
  since 1.5.0.
- **A health-less mirror publish may still move the container's own health — `verify`:
  the first live `goal-publish-update` call with `health` omitted, read against the
  container afterward.** No live mirror publish is on record since 2.1.0 shipped the
  verb; the question the engine deliberately declined to answer is still open.
- **`LINEAR_UPDATE_HEALTH_VALUES` is still schema-read, not live-proven — `verify`: the
  same first live mirror publish, cross-checked against the values Linear's workspace
  actually accepts.** Unchanged since 2.1.0.

## [2.1.0] — 2026-08-17

**The goal station learns to publish.** The mirror pass ships whole — a sixth store verb
that publishes a goal's derived frontier accounting to the bound container's own native
update surface, and the goal skill's fourth pass that drives it — on top of a frontier
whose members now each carry their native state and their own health. Additive throughout:
nothing removed, renamed, or re-typed. One widening earns the implementer heads-up below;
it is the whole reason this is not a patch.

### Added

- **`publishGoalUpdate` — the sixth `IssueStore` verb** (CLI: `issue-store
  goal-publish-update`). Publishes the goal's derived accounting — per-member state lines,
  the distribution sentence, the unresolved-blocker rendering — to the container's native
  update surface (a Linear project or initiative update). The anchor is **engine-owned and
  unsupplyable**: the caller contributes a narrative, an optional health value, and an
  optional operator note, and can neither supply, edit, nor omit the accounting itself.
  The `GoalUpdateReceipt` reports **what the engine sent** — an empty-string health is
  treated as absence at the gate, so the receipt always matches the wire. A goal with
  **zero members** publishes only the "no members yet" sentence; the finish-line sentence
  renders only for a goal that has members and has closed every one of them — empty
  membership and completion are distinguishable on the published surface, mirroring the
  status pass's own precedent. A container with no native update surface refuses loudly
  with a new, typed member of the goal-binding refusal family.
- **Every frontier member carries its native state and its own health.**
  `GoalMemberNativeState` and `GoalMemberHealth` ride each reading — one derivation, two
  consumers (the status report and the mirror anchor). Health is read the way the vendor
  actually derives it: from the container's most recent update, with an explicit null when
  none was ever reported — a roll-up, never a field a person sets on the node.
- **Seven new root runtime exports** — `GOAL_MEMBER_STATE_PROSE`,
  `GOAL_UPDATE_ANCHOR_HEADING`, `GOAL_UPDATE_EMPTY_FRONTIER_SENTENCE`,
  `GOAL_UPDATE_PROVENANCE_LINE`, `LINEAR_UPDATE_HEALTH_VALUES`,
  `refuseGoalUpdateSurface`, `renderGoalUpdateBody` — and seven new exported types:
  `PublishGoalUpdateInput`, `GoalUpdateReceipt`, `GoalUpdateMemberIdentity`,
  `GoalMemberNativeState`, `GoalMemberHealth`, `LinearUpdateInput`, `LinearUpdateResult`.
- **The goal skill teaches the mirror pass** (plugin side): a per-pass preview that shows
  the full body verbatim with an explicit confirm that inherits nothing from any earlier
  pass, a narrative drafted sentence by sentence in the consumer's own house form (flotilla
  pins no template), and a health-proposal round with exactly two sanctioned sources and
  one prohibition — transcribe an operator-supplied value, or propose a source-attributed
  aggregation of the members' own healths, and never propose from the frontier itself. The
  station's boundary is unchanged and restated where it matters most: it reports, it never
  dispatches, and it never declares the finish line reached — not even from the pass that
  writes.

### Changed

- **`LinearApi` widens by TWO required methods — the implementer heads-up.**
  `createProjectUpdate` and `createInitiativeUpdate` are now required on the seam. Breaking
  for any consumer that *implements* `LinearApi` itself — a custom transport, a recording
  double — and invisible to any consumer merely *using* the engine: no runtime export count
  moves, only the type gate sees it. Minor per the house rule, same shape as the widening
  1.5.0 carried and ruled on.
- The project-relation decision record now carries **one house lesson with a dated
  nuance** (the vendor's prose misled — only a live measurement settles a vendor value —
  with the recoverable-in-hindsight reading recorded as a dated amendment, and the record
  and the code's read-stamp pointing at each other). Both vendor-schema citations are
  pinned to the commit they were read at, and the issue arm's relation-type read filter now
  matches through the same module-local constant its create half uses.

### Unsettled by construction, and what is not yet proven

- **A health-less mirror publish may still move the container's own health.** The vendor's
  create input marks `health` optional while the created node declares it non-null, so the
  server assigns a value when the key is omitted — a fixed default, or the previous
  update's health carried forward, is a pure value question no schema read can answer. The
  engine's response is the conservative one: it omits the key entirely, and the receipt
  deliberately reports what was sent and claims nothing about what the container reads
  afterwards. The first live mirror publish is the read that settles it.
- **`LINEAR_UPDATE_HEALTH_VALUES` is schema-read, not live-proven** — but published as a
  real GraphQL enum, unlike the free-`String` pair 2.0.0 corrected, so that specific
  failure mode cannot repeat in that form. The engine authors no health value; the list is
  documentation and a validation aid, and a workspace that ever disagrees fails loudly.
- **Carried forward, still not live-proven:** the Linear attachment upsert; the `prUrl`
  notice's agent-mediated half; the residue-probing worktree classification (now measured
  negative twice, against two different implementations); the grant-in-brief plugin half;
  Bitbucket's write half; and the uppercase-team-key assumption in the issue-vs-project id
  check.

## [2.0.0] — 2026-08-16

**A live measurement falsified two constants 1.5.0 had shipped as unproven, and repairing
them removed a published export.** That removal is the whole reason for the major: one root
export is gone by name, with no alias. Everything else in this release is a repair or a
correction, and the practical blast radius is as close to zero as a breaking change gets —
but the rule is written about the *shape* of the change, not about how many people it hurts,
and this is a removal.

If you do not use the Linear goal facet's initiative binding, upgrading is a rename in one
import line, or nothing at all.

### The migration, in full

| 1.5.0 | 2.0.0 |
|---|---|
| `PROJECT_RELATION_ANCHOR_TYPE` (a `string`, `'project'`) | **`PROJECT_RELATION_ANCHOR_PAIR`** (a frozen object, `{ anchorType: 'end', relatedAnchorType: 'start' }`) |
| — | `ProjectRelationAnchorPair` (new exported type) |
| `PROJECT_BLOCKS_RELATION_TYPE === 'blocks'` | `PROJECT_BLOCKS_RELATION_TYPE === 'dependency'` (same name, new value) |

Nothing else on the package root, the `wave.config.json` schema, or the CLI surface changed.

### Removed

- **`PROJECT_RELATION_ANCHOR_TYPE` — renamed, with no alias left behind.** It named a single
  symmetric anchor value; the live API has no such thing, so the symbol had no correct value
  to hold and keeping the name would have been keeping a lie. The replacement is a **frozen
  wire-keyed pair** spread whole into the relation input, which makes the one dangerous
  mistake unspellable rather than merely discouraged: a project dependency is finish-to-start
  — the blocker's `end` anchored to the blocked project's `start` — and two loose scalars
  could be swapped silently, because both values are valid enum members in both fields and
  Linear would happily record a backwards dependency without complaint. The alias was
  considered and deliberately not shipped: the retired constant's only value was one the API
  refuses, so an alias would preserve a name whose meaning was never usable.

### Fixed

- **Both project-relation constants were wrong, and the initiative-bound `blockedBy` arm
  could not succeed against any live workspace.** 1.5.0 listed these values under *Not yet
  proven*; that was too kind. Every attempt to draw a native project dependency failed with
  `Argument Validation Error`. `type` had to be `'dependency'` — not `'blocks'` — and the two
  anchor fields had to be `'end'` and `'start'`, not `'project'`. The arm now works; before,
  it never could.
- **The `-heavy` failure underneath it is worth more than the fix, because it will recur on
  the next vendor field.** The published schema types all three fields as free `String`, so a
  schema read pins their *shape* and can say nothing about their *values* — and the API
  validates them as enums anyway, one layer behind GraphQL, surfacing only in a rejection
  payload. Worse, the vendor's own field documentation gives `blocks` as its example, which
  is precisely the value the API refuses. The read-stamp on these constants now records that
  in full, including the sharpest explanation for why the wrong guess was plausible: the
  schema *does* define an enum for the **issue** relation arm and none at all for the
  **project** arm, so a real enum member was carried across from the neighbouring arm. It
  also records where that enum actually binds — the create input only; the relation's own
  `type` field and the update input are bare `String`.

### Added

- **`ProjectRelationAnchorPair`**, the exported shape of the replacement constant. Its two
  members are literal-typed (`'end'` / `'start'`), so a symmetric collapse fails at the type
  gate before any test runs.

### Changed

- **The goal station's documentation gained the usage mode it was actually being used in.**
  The cut pass was framed as greenfield placeholder-filing; the archetypal use — a release
  cut — is a **collecting lens over a pool that already exists**, which the skill now names in
  its own right. Two questions the docs previously left open are settled rather than
  surveyed: whether one preview under one confirm may cover a combined cut-plus-curation pass,
  and whether the ship-member-with-edges shape is taught or rejected.
- **Two skill descriptions were repaired, one of which was silently truncating at runtime.**
  A space-hash inside a trigger phrase read as a YAML comment introducer, so the document
  parsed *cleanly* and the description ended 55 characters early — visible to nobody, since
  nothing errored. The other was a colon-space that failed strict parsing outright, in the
  reviewer agent file: a sixth carrier that falsified the original diagnosis's
  SKILL.md-only correlation. The in-repo guard now reaches both, which matters more than
  usual because the platform's own validator stopped reporting this class entirely between
  two releases — this guard is now its only owner.

### Not yet proven

Everything below ships tested against fakes, falsification specs, and vendors' published
schemas — and has never made the live round-trip. Unchanged from 1.5.0 except where noted.

- **The Linear attachment upsert has never run live.** First Linear-store consumer close
  after this release is the first live read.
- **The `prUrl` notice's agent-mediated half has never completed end-to-end.** The engine side
  is live-measured; no real Scribe has yet forwarded a real notice.
- **The grant-in-brief mechanism's plugin half** — exercised for the first time during this
  release's own work, but on the source form rather than an installed consumer.
- **Bitbucket's write half** (unchanged since 1.3.0; the read half is live-verified).
- **The uppercase-team-key assumption** in the issue-vs-project id check.
- **Dropped from this list, because they were measured:** the project-relation constants
  (measured, and falsified — see Fixed) and the four direction facts that came back correct
  (values round-trip verbatim with `projectMilestone: null`; `projectId` is the blocker and
  `relatedProjectId` the blocked project; the relation surfaces on the blocked project's
  `inverseRelations` and never its `relations`; and Linear's own blocking/blocked-by filters
  agree with that direction). Uniqueness is enforced per project-pair-and-type, not per
  anchor pair.

### Known issues

- **The worktree sweep's classification still needs two runs on a sandboxed harness.** A
  deterministically-denied clean worktree reads as *transient* on the first run and only
  reads *exhausted* — carrying the manual recovery commands — on the second. Two separate
  fixes have now been measured live against this, and both failed the same way; the current
  hypothesis is that the distinguishing evidence only comes into existence *as a result of*
  the first failed attempt, which no discriminator reading that attempt can see. The manual
  sandbox-off force-removal remains the documented ordinary path.
- **The mirror pass is designed but not built** (unchanged from 1.5.0).

## [1.5.0] — 2026-08-16

The **goal station** release: flotilla gains a fourth planning station, and with it the
one thing the pipeline could not previously express — a *named finish line* on the
tracker, its curated membership, and the derived remainder of work still open before it.
The station is deliberately **sight, never permission** (ADR-0044): it files placeholders
that carry no readiness marker, it has no dispatch verb, and it has no close verb, so
nothing it creates can reach a background agent unsharpened and no agent can write itself
a release authorization. Around it, the release carries the **consumer boundary** work
(the operator register, the sibling-path skill read), a worktree sweep that **accounts**
for everything it could not remove rather than staying silent about it, a credential
resolver that names a previously-mute failure mode, and a skill-description surface that
a guard now keeps honest.

**Minor per ADR-0035.** Nothing was removed, renamed, or re-meant on any of the three
frozen contracts: the package root only gains exports, the `wave.config.json` schema only
gains an optional key, and the CLI only gains verbs. Two exported *interfaces* gain
required members, which is a compile-time break for anyone **implementing** them — never
for anyone **consuming** them — and both get their own loud heads-up under Changed below,
the same treatment 1.4.0 gave the `Disclosure.iter` widening.

### Added

- **The Goal facet on `IssueStore` — a finish line bound to a native container
  (ADR-0044, issue #570).** A Goal is one container on your tracker plus its derived
  Frontier. Six verbs cross the barrel: `createGoal`, `readGoal`, `listGoals`,
  `assignToGoal`, `createGoalMember`, `readGoalFrontier`, with `goal-create`,
  `goal-read`, `goal-list`, `goal-assign`, `goal-create-member` and `goal-frontier` as
  their CLI projection. Which native container realizes a Goal is a **config fact**, not
  a call-time choice: GitHub defaults to its Milestone, the markdown store to its goal
  file, and **Linear binds no default at all** — it refuses with a typed
  `GoalBindingError` naming `store.goal.container`, because live consumer conventions
  genuinely disagree about what a Linear project means. Members are filed **bare** —
  authored prose, no planning header, no eligibility marker — so the cut records that a
  workstream exists without implying anything about whether an agent may pick it up.
- **A Goal's members are the container's direct native members (ADR-0045, issue #573).**
  The member *kind* follows the binding rather than the caller's intent: an issue under
  `milestone`/`project`/`goal-file`, a **project** under a Linear `initiative`, because
  an initiative holds projects and not issues. `createGoalMember` is one act — mint the
  bare member and join it — since under `initiative` there is no two-call route at all.
  Passing an issue-shaped id where the binding wants a project is refused with
  `GoalMemberKindError` **before any write**; a join that fails after a successful mint
  reports the residue through `GoalMemberJoinError` naming the minted id and which half
  failed, rather than inventing a rollback this facet has no right to perform.
- **The Frontier — derived on every read, never stored (ADR-0044 decision 5).**
  `computeGoalFrontier`/`classifyGoalMember` are pure and store-blind, turning what an
  adapter can see about each member into exactly one of five readings: `done`,
  `in-motion`, `actionable`, `blocked`, `unready`. Because it is derived, there is no
  durable marker anywhere for an agent to author — the structural answer to the failure
  mode this station was designed against.
- **`store.goal.container` is a typed contract field (issue #578).** The binding joins
  the `wave.config.json` schema with `config validate` coverage, three refusal shapes
  (`unbound`, `unknown-container`, `unrealized-container`), and `readGoalContainer` /
  `resolveGoalContainer` at the root for a consumer resolving it themselves. A malformed
  declaration fails loudly instead of being quietly read as unbound and defaulted past.
- **The BARE `create` form gains a `blockedBy` arm, realized as native dependencies
  (issue #572).** A placeholder may depend on another placeholder before either is
  specifiable — that is the whole reason the arm exists. Each edge becomes a real tracker
  relation (a GitHub issue dependency, a Linear issue relation, or a Linear **project**
  relation under an initiative binding) and writes **no header line**, so the member stays
  bare. The local markdown store, whose only dependency representation *is* the header
  line a bare issue does not have, **refuses** rather than faking it.
- **The sweep owes accounting, never removal (ADR-0042, issues #557 and #560).** Two
  additive report fields close the two ways the worktree sweep used to lose evidence: an
  incomplete removal now **names its survivors** (the walk already computed them; they
  were being discarded), and the report accounts for **registered worktrees the sweep
  never enumerates** — a worktree git knows about that the sweep's own globs never reach
  no longer vanishes from the accounting. Nothing new is removed; the sweep's removal
  behaviour is byte-unchanged.
- **The credential resolver detects `security(1)`'s trailing-newline hex mangling and
  refuses with guidance (issue #597).** A keychain secret retrieved through the hex path
  can come back with a mangled trailing byte — previously a mute, mystifying auth
  failure downstream. It is now caught at the resolver seam and refused with a typed
  `CredentialFailure` member and a message that says what to do about it.
- **Every CLI usage error teaches the complete first lesson (issue #505).** A usage error
  on a known op prints **that op's** contract section rather than the full op list, so a
  wrong flag teaches one shape instead of two dozen. Exit codes and JSON shapes are
  untouched.
- **The Linear store's `close()` upserts the closing PR as a native attachment
  (issue #511).** The closing pull request becomes a first-class Linear attachment on the
  issue rather than prose nobody's tooling can read.
- **User-visible engine and hook messages carry themselves (ADR-0039, issue #502).** The
  operator register reaches the engine's own output: a message a person reads explains
  itself without a decision-record number, a convention number, or an internal id in it.
- **Convention 16 — the operator register (issue #499)**, its byte-identical clause in
  every skill, and a drift guard that keeps the clause from decaying. Widened later in
  the same release to the **reference tier** (issue #514), so the register reaches one
  level down into the files skills read.
- **The close report counts the Coordinator's own misfires (issue #506).** A wave close
  now reports how often the Coordinator itself mis-stepped — the number nobody was
  keeping, and the one that says whether the driver's prose is converging.
- **A finishing report without a usable PR URL is a loud exit-0 notice at the sidecar
  write (issue #556).** The sidecar is still written; a `notice:` line on stderr names
  what is missing, so the recurring "the PR exists but the report does not know its URL"
  class stops being silent.
- **A granted scope extension travels in the brief (ADR-0041, issue #516).** A mid-wave
  scope grant rides as data on the row and every re-compose re-fetches, so an agent's
  authority is read from the row rather than remembered from a conversation.
- **Bitbucket's merge-checks refusal names the scope it needs (issue #543).**
- **The skill-description surface gets a guard that can actually fail (issues #500, #526,
  #548, #555, #602).** Descriptions read consumer-first and in third person; a
  cross-reference anchor is **verified** rather than stripped; a guard's subject path is
  declared **guard-side** so the checked text can never carry its own exemption
  (ADR-0043); and frontmatter is validated as **strict YAML** by two parsers that must
  agree — a colon-space in an unquoted description silently truncated a live skill's
  description at runtime, and the platform's own validator lost this whole class between
  two CLI releases, which makes this guard its only remaining owner.

### Changed

- **`IssueStore` gains six required members — the heads-up (ADR-0044).** The Goal facet's
  verbs are required, not optional, so a **third-party adapter implementing `IssueStore`
  no longer typechecks** until it implements them. Every *consumer* of a store handle is
  unaffected: nothing was removed, renamed, or re-typed, and all three shipped adapters
  implement the facet. The whole vocabulary an implementer needs is root-exported for
  exactly this reason — `GoalContainer`/`GOAL_CONTAINERS`, `GoalMemberKind`/
  `GOAL_MEMBER_KIND_BY_CONTAINER`/`goalMemberKind`, `CreateGoalInput`/
  `CreateGoalMemberInput`/`GoalView`, the typed failures, and the two shared rule
  implementations `requireGoalContainer` and `requireGoalMemberKind`, so a fourth adapter
  applies the same rule rather than re-deriving one that can drift.
- **`LinearApi` gains thirteen required members — the heads-up (issue #511 and
  ADR-0045).** `upsertAttachment` plus the project and initiative surface
  (`createProject`, `getProject`, `listProjects`, `setIssueProject`, `listProjectIssues`,
  `createInitiative`, `getInitiative`, `listInitiatives`, `listInitiativeProjects`,
  `addProjectToInitiative`, `getProjectBlockedBy`, `addProjectBlockedBy`). Same shape as
  above: external *implementers* of the interface break at compile time, external
  *consumers* do not. This is the first post-1.0.0 release in which an exported interface
  gains required members, and the ruling is recorded here: the three frozen contracts are
  read as contracts with their **consumers**, so an implementer-only break is Minor plus
  a loud heads-up — not a major bump.
- **`CredentialFailure` gains the member `'lookup-hex-mangled'` (issue #597).** Additive
  widening of an exported union: a consumer switching exhaustively over it gains a new
  case and finds out at compile time.
- **`CreateInputFailure` gains the member `'bare-blocked-by-unrepresentable'`
  (issue #572)** — the markdown store's refusal of a bare dependency it cannot represent.
  Same additive-union shape as above.
- **`GoalFrontier`'s `unresolvedBlockers` are `IssueRef | string`.** A project member's
  blocker is another project, and a Linear project id is a UUID with no honest `IssueRef`
  spelling — so the blocker shape carries both. New type, no existing shape changed.
- **Skills load `wave-shared` by sibling-path read, not by name (ADR-0040, issue #501).**
  This closes the known issue 1.4.0 shipped with: `wave-shared` declares
  `disable-model-invocation: true`, which removed it from what a model may load by name,
  so the by-name instruction the execution skills carried was never executable and the
  first fully-external consumer run needed a manual `/flotilla:wave-shared` invocation to
  get past it. **No release after 1.4.0 needs that workaround.**
- **The `report` skill files in English, whatever the session speaks (issue #497).** The
  artifact that reaches flotilla's maintainers is English; the operator's own language
  stays in the chat, which is where Convention 16 puts it.

### Fixed

- **The worktree sweep classifies a deterministic denial on evidence, not on an errno
  (issues #528 and #542).** A clean worktree the harness deterministically refuses to
  delete reads **exhausted on run 1** — carrying `manualRecovery` with the real
  sandbox-off commands — instead of advising a retry against an obstruction that will
  never clear. The first fix split on whether the removal error was ENOTEMPTY-family and
  missed the live shape (the denied *children* make the directory undeletable, so the
  errno is byte-indistinguishable from the transient race the retry exists for); the
  shipped classification probes the **residue** instead, which is the signal errno cannot
  carry.
- **`manualRecovery` shell-quotes every printed path (issue #515).** A copy-pasteable
  command stops being a lie for any path with a space in it — which is every path in a
  worktree under a directory a human named.
- **Bare `create` refuses a `bodySections` entry missing `heading` or `markdown`
  (issue #530)** — a usage error naming the field, instead of a crash.
- **A 404 on Bitbucket's post-merge branch delete reads as already-gone, not as a failed
  deletion (issue #495).** Landing no longer reports a failure for work that succeeded.
- **`store-preflight` stops asserting a code-host conclusion it cannot know
  (issue #493).** The tracker-host integration check now answers only the question it can
  actually answer.
- **The reviewer phase picks its state from the verdict (issues #513 and #527)** — in the
  routing itself and in the step-7 summary that reports it, which had drifted apart.
- **`wave-close`'s phase-4a engine surface covers the Bitbucket adapter (issue #517)**,
  and phase 4a now **predicts the half-applied sandboxed pull before it runs**
  (issue #531) — the failure signature where a git command under sandbox reports success
  having done only half its work.
- **The driver's report-schema copy regains its `prUrl` floor (issue #562)**, pinned
  modulo the boundary combinator so the copy cannot silently drift from the schema again.

### Docs

- **ONBOARDING teaches the goal station (issue #580)** — the fourth planning station
  reaches a consumer's first read rather than existing only in the skill.
- **`wave-setup` was re-measured against reality across five passes:** the Credentials
  section goes host-aware (issue #492), the AFK scaffold verifies its own files are
  **trackable** (issue #494), the keychain first-read prompt was **measured** and all
  three documents reconciled against the measurement (issue #544), the credential set
  gained a scan table with three corrected Bitbucket scope facts (issue #539), and the
  Bitbucket minimal scope set was re-measured against the vendor spec — pull-request
  operations move to their own scope pair (issue #559). Promoted prose pays its debt back:
  the setup read shrinks to residual forms (issue #509).
- **`wave-start`'s auth preflight checks the credential the engine actually uses
  (issue #549)** — it was checking a different one.
- **The Scribe briefs carry their payload's provenance and the filing-clerk framing
  (issue #577)**, and the classifier refusal becomes a **named, counted** failure class
  rather than an anecdote.
- **Occurrence catalogues move to evidence sidecars (issue #510)**, keeping the skills
  themselves teachable while the measurements stay addressable.
- **Nine decision records** land or are amended: ADR-0039 (operator register), ADR-0040
  (sibling-path read), ADR-0041 (granted scope extension), the ADR-0034 amendment
  (promotion pays its prose back) and its **rung split** — a schema boundary constrains an
  author, an engine check inspects an artefact, with the reason carried to all six
  boundary-conditional sites (issue #563) — ADR-0042 (the sweep owes accounting),
  ADR-0043 (the checked text never carries its own exemption), ADR-0044 (a goal binds a
  native container and derives its frontier), ADR-0045 (a goal's members are the
  container's direct native members), and ADR-0046 (the mirror pass — designed, **not
  shipped in this release**; its engine and skill halves are tracked as open work).
- **The Apache copyright holder is filled in** — Michael Helmbrecht, 2026.

### Not yet proven

Everything below ships tested against fakes, falsification specs, and the vendors' own
published schemas — and has **never made the live round-trip**. Stated so a consumer
knows which edge they are the first to walk.

- **The Goal facet's two Linear arms have never run against a live workspace.** Both the
  `project` and the `initiative` binding are hermetic-fake-backed and schema-compared. The
  weakest point is named and **exported** so a disagreeing workspace can report exactly
  which strings to change: `PROJECT_BLOCKS_RELATION_TYPE` (`"blocks"`) and
  `PROJECT_RELATION_ANCHOR_TYPE` (`"project"`) are typed `String` by Linear, not enums —
  the schema pins their *shape*, not their *values* — and `anchorType` in particular is an
  inference from the field's own prose rather than a quoted example. The first
  initiative-bound cut that draws a dependency is the confirmation; a rejected value
  surfaces loudly as a typed failure naming the minted member, never a silent drop.
- **The issue-vs-project id check assumes uppercase team keys.** `goal-assign`'s kind
  check narrows an id with `/^[A-Z][A-Z0-9]*-\d+$/`. No document states every Linear
  workspace's team keys are uppercase-only. The failure direction is benign — a
  lowercase-keyed id still refuses, just via Linear's plainer "unknown project" error
  instead of the typed `GoalMemberKindError` — so this is a confirm-on-first-contact note,
  not a blocker.
- **The Linear attachment upsert has never run live.** Fake-backed, falsification-tested,
  and schema-compared — but the live round-trip, including the URL-uniqueness upsert
  semantics on a real workspace, is unstamped. The first Linear-store consumer close after
  this release is the first live read.
- **The `prUrl` notice's agent-mediated half has never completed end-to-end.** The engine
  side is live-measured across three payload shapes including a negative control, and the
  Scribe carrier is verified by reading. What no run has exercised is a real Scribe
  forwarding a real notice: the one natural occurrence so far was **voided** because the
  session checkout still ran the pre-gate engine and the un-gated code answered.
- **The evidence-based worktree classification has no live read on record.** Its
  predecessor was measured live twice and failed both times, which is why it was replaced;
  the replacement's own first live read has not been captured. The manual sandbox-off
  force-removal remains the documented ordinary path on a sandboxed harness regardless.
- **The grant-in-brief mechanism (plugin half) has never been exercised in a live wave.**
  The first mid-wave `issue-store annotate` followed by a re-compose is the first live
  read.
- **Bitbucket's write half remains unproven** (unchanged since 1.3.0; the read half is
  live-verified).

### Known issues

- **The mirror pass is designed but not built.** ADR-0046 settles how a goal's derived
  accounting would be published to the container's native update surface — with the engine
  deriving the frontier itself at write time so a caller cannot lie about it. Neither half
  ships here; both are open work.

## [1.4.0] — 2026-08-11

Same-day follow-through on ADR-0038: the Disclosure capture window now spans the whole
wave — a Coordinator find that surfaces during a close phase is captured where it
surfaces, wave-scoped and first-class — and the chronically-manual worktree removal is
promoted from documented exception to designed path, on its doc half and its report half
alike. Minor per ADR-0035: one additive CLI input form, three new root exports, and one
public-type widening that gets its own heads-up below because a root-only consumer's
arithmetic on it breaks at compile time.

### Added

- **`spine add-disclosure --wave` — a wave-scoped Disclosure is first-class (ADR-0038).**
  A find about the wave's own machinery — the sweep, a preflight posture, the merge-order
  tool — is owned by no Plan-Table row and no iteration; the new boolean flag replaces the
  `<row-id>` positional and `--iter` on the same op. A wave-scoped entry renders as row
  `wave` with an em-dash Iter cell, round-trips byte-preserving, is addressable by
  `set-disposition` via its printed `wave.<ordinal>` ref, and is counted by the
  `check-disclosures` archive gate exactly like a row-scoped entry (open blocks, terminal
  clears). Mixing `--wave` with a `<row-id>` or `--iter` is a usage error with nothing
  written; a spine whose Plan-Table actually holds a row named `wave` gets a defensive
  refusal on the wave-scoped path only. Three new root exports carry the form:
  `addWaveDisclosureToSource`, `WAVE_SCOPE_ROW`, `WAVE_SCOPE_ITER_CELL`. The row-scoped
  form keeps byte-identical shape, validation, and output — verified at review by a
  differential probe against the pre-change tree.
- **The wave-close skill teaches the close-phase capture doctrine (ADR-0038).**
  Capture-at-discovery in the skill body's judgment layer, one backstop line ahead of the
  phase-6 disclosure gate, and the capture verb's rows — both forms — in the
  close-mechanics command table. The capture window ends hard at the archive: a
  post-archive find files directly as a bare tracker issue.
- **An exhausted `erroredStillListed` entry says a re-run cannot succeed (issue #483).**
  A worktree the engine already classified disposable, still listed after its bounded
  retry AND the scoped `--force` fallback, now carries an additive
  `manualRecovery { message, commands }`: the message states the obstruction is
  deterministic, the commands are copy-pasteable and name that worktree's actual path.
  Transient-shaped entries keep the previous reading; no existing key or exit-code
  meaning changed.

### Changed

- **`Disclosure.iter` widens `number` → `number | null` at the package root — the
  heads-up (issue #489).** `null` is the wave-scoped form's not-applicable marker. Every
  row-scoped entry still parses and renders an integer, so no runtime behaviour changed
  for the existing form — but a root-only consumer doing arithmetic on `d.iter` now fails
  at compile time rather than reading a silent `null`. That loud failure is deliberate;
  the rejected alternative was an `iter: 0` sentinel hidden inside a numeric type.
- **The phase-3 close reference prescribes the sandbox-off force-removal as the ordinary
  path (issue #483).** Three consecutive closes proved the manual step is not the
  exception on a sandboxed harness — a fourth occurred while this release's own wave
  closed. One canonical sequence: sandbox-off `git worktree remove --force` per worktree,
  then `git worktree prune`; the `prune` + `rm -rf` variant is demoted to the fallback
  when force-removal itself fails. The step stays manual and privilege-escalating by
  design — the human stays in the escalation.
- **CONTEXT.md's Disclosure entry and ADR-0038** (`docs/adr/0038-a-find-is-captured-where-it-surfaces.md`)
  carry the full window: capture where the find surfaces, from verdict-routing through
  every close phase, measurement points pre-captured at routing, archive as the hard
  boundary.

### Not yet proven

- **`manualRecovery` has never been read live.** The wave that shipped it hit its own
  trigger (`erroredStillListed`, the fourth consecutive occurrence) with the pre-merge
  engine still running the sweep. The next close on a sandboxed harness is the field's
  first live read.
- **A consumer-side wave-scoped capture has not yet occurred.** The form is exercised
  live through the real CLI on scratch spines (worker and reviewer independently), and
  this repo's own close exercised the gate half on a row-scoped entry — but no genuine
  close-phase Coordinator find has ridden the new form end-to-end yet.
- **Bitbucket's write half remains unproven** (unchanged since 1.3.0; the read half is
  live-verified).

### Known issues

- **First `wave-start` on an installed-form consumer needs one manual `/flotilla:wave-shared`
  invocation (every release ≤ 1.4.0).** `wave-shared` declares `disable-model-invocation:
  true`, which removes it from what a model may load by name in any context — so the
  by-name load instruction wave-start and wave-close carried was never actually
  executable. Project-local this stayed hidden behind a working cwd read; the first
  fully-external consumer run hit it live and the operator had to invoke
  `/flotilla:wave-shared` by hand to get past it. Fixed going forward: the execution
  skills read `wave-shared` as a sibling file instead of loading it by name, so no
  release after 1.4.0 needs the workaround.

## [1.3.1] — 2026-08-11

The night after the Bitbucket landing host shipped, this release closes its first
field-reported gap, grades its one unstated precondition at the preflight, and settles —
in an ADR with a structural guard — the import-cycle precedent that check created on its
way in. Patch per ADR-0035: no export, config, or CLI *input* changes; the one additive
*output* change (a fourth preflight check) gets its own heads-up below because an
exhaustive `switch` in a consumer breaks on it.

### Added

- **`host-pr preflight` reports a fourth check on a Bitbucket host: `create-credentials`.**
  It grades `host-pr create`'s own precondition — the account-email half of the
  Basic-auth pair — by asking the create path's own helper (the predicate is "did it
  throw?", and the advisory quotes the refusal verbatim), so the check and the verb it
  predicts cannot drift apart. Advisory-never-fail: the landing verbs authenticate with
  Bearer and keep working; what refuses without the email is `create`, on every Worker
  terminator, after the work is done — which is exactly why it is worth knowing at
  preflight. Absent on non-Bitbucket hosts. **Heads-up: the exported `HostCheckName`
  union widens from three members to four — additive, but a consumer switching
  exhaustively over it stops compiling.** Not yet proven: exercised against synthetic
  environments only, never live Bitbucket — the adapter's write half still awaits its
  pilot wave.
- **The call-time-only cycle doctrine, settled and spec-guarded (ADR-0037).** An engine
  module may import an adapter-owned canonical fact when the alternative is re-spelling
  it (the parallel-rule drift class); the edge must be call-time-only in both
  directions; a second cycle — not the first — is the named trigger for extracting a
  shared leaf module. The one accepted cycle (`host-pr` ⇄ the Bitbucket adapter) now
  carries a load-order drift-spec: both load orders, each in a genuinely fresh module
  registry, asserting all four crossing runtime bindings. Falsified during development,
  not assumed — a temporary top-level read across one edge failed only the
  adapter-first order, the silent-in-production shape the spec exists to catch.

### Fixed

- **`credential-probe --all` discovers the Bitbucket credential** — the pilot's
  field-reported gap: the discovery list now imports the adapter's own variable name
  rather than not knowing it, so `--all` probes what the adapter actually resolves;
  a call-site drift spec guards the coupling.
- **The create-credentials advisory tells the truth about an empty email:** a
  SET-but-empty `BITBUCKET_EMAIL` used to be told it "is not set" — right consequence
  (the helper refuses empty exactly like absent), wrong fact. It now reads "is not set,
  or is set to an empty string", the wording is pinned by a spec assertion, and a
  maintenance comment binds the advisory's leading sentence to the helper's precondition
  set so a future second precondition cannot make it state a wrong fact while quoting a
  right one. Grading is unchanged on every path.

### Docs (plugin half)

- All four skill-doc enumerations of the host preflight now count **four** checks,
  naming `create-credentials` with its Bitbucket-only, advisory-never-fail semantics —
  the onboarding step, both setup-mechanics surfaces, and the close-mechanics reference.
- The wave-close phase-4a self-repair detection surface caught up twice: widened by the
  archive gates, the credential seam and three more modules, then by the disclosures
  gate's own module (`spine-store.ts`) — closing the gap where a wave fixing that gate's
  parser would have run its own archive gate on the pre-fix code, undetected. The
  maintenance comment now records that the two fail-closed archive gates live in
  different modules (correcting an inaccurate shared-module claim on the way).
- ADR-0029's consumer count catches up with the shipped adapters; ADR-0037 records the
  import-cycle precedent in full.

## [1.3.0] — 2026-08-10

The third release of one day, and the fastest field-report-to-shipped-feature arc yet:
the Bitbucket+Linear pilot ADR-0023 named in July ran its first live wave on 1.2.0, filed
the landing-seam refusal as its field report the same evening, and this release ships the
adapter that answers it. The package-root export surface and the `wave.config.json`
schema are untouched; minor per ADR-0035 — `host-pr` accepts a new host, an additive
relaxation of the CLI contract.

### Added

- **`host-pr` works on Bitbucket Cloud.** The blanket non-github gate becomes per-verb
  host routing. `create` runs the cross-host find-before-create/update path that had
  been shipped behind the gate all along — over the measured credential shape: an
  Atlassian API token paired with the account email (`BITBUCKET_TOKEN` through the
  ADR-0029 lookup seam, `BITBUCKET_EMAIL` beside it; app passwords are measured dead,
  not deprecated-someday). `status`, `merge`, and branch deletion ride a real
  `LandingHost` implementation against REST v2. `arm` throws the typed
  auto-merge-unavailable refusal on the **measured** basis that Bitbucket Cloud has no
  per-pull-request arming call — so `wave-close --auto` direct-merges the ready rows and
  the pending tail keeps the advisory merge-order. `preflight` reads the posture for
  real, including the `allow_auto_merge_when_builds_pass` branch restriction (read,
  never hardcoded) with host-aware grading — a visible `off` is advisory here, not a
  fail, because the setting names a UI affordance, not an engine capability. `unknown`
  hosts keep the loud, typed refusal on every verb. Mergeability is derived from
  Atlassian's own merge-check sentence: zero reported builds against a required minimum
  reads `blocked`, never `clean` — the check-attach latency window stays closed on this
  host. The ADR-0023 amendment records every measurement.
- **A find-before-create bug died on the way in:** the Bitbucket open-PR query had been
  URL-encoding `&state=OPEN` into the BBQL `q` expression, so the host rejected the
  query, "no open PR" was inferred, and every re-run against a Bitbucket repo would have
  silently opened a duplicate PR. The query now carries `state` as the documented
  first-class parameter.

### Fixed

- **The cross-host teaching texts stop teaching the pre-adapter world** (#464): the
  create-path notes in the shipped skill references now route a Bitbucket Worker
  terminator to `BITBUCKET_TOKEN` + `BITBUCKET_EMAIL` instead of `GITHUB_TOKEN`, and
  the merge-capability posture read leaves the vendor-deprecated unscoped permissions
  endpoint for the workspace-scoped one (no-evidence semantics unchanged).

### Docs (plugin half)

- The 1.2.0 entry's first Not-yet-proven item fell the same day it shipped: the unbound
  Document arms are live-verified from the second external consumer's workspace —
  ADR-0017's "one unproven spot" now records the verification, and the `[Internal]`
  annotation is documented as a visibility marker, not a functional reservation.

### Not yet proven

- **The Bitbucket writes have never run against a live workspace.** Every request shape
  is hermetic over the injectable seam and pinned to Atlassian's documented forms
  (OpenAPI and support pages, read in-dispatch); the two residual hazards are deliberate
  and commented at their points of departure (the merge body's omitted discriminator
  field, and the unpolled 202 merge task). The pilot's first wave on this release is the
  intended live reading — create, status, merge, and the `doneState` reconcile in one
  pass.
- #418 (`npm ci --prefix` failing spuriously in dispatched contexts) stays open and
  falsifiable, unchanged from the 1.2.0 entry.

## [1.2.0] — 2026-08-10

A minor release cut the same day as 1.1.0 — the delivery half of the facet-unlock wave
that landed hours after that release was tagged. The package-root export surface and
the `wave.config.json` schema are untouched. The change the version number is chosen
against (ADR-0035) is a relaxation on an exported class: the Linear store's Document
facet stops refusing to work without a project binding.

### Added

- **The Document facet works without a project binding.** On a Linear store with no
  `project` configured, `publishDocument` now parents the PRD Document on the
  configured **team** — where it previously refused to mint an orphan — and
  `listDocuments` narrows **server-side** to that team via the schema-verified
  `DocumentFilter.team` predicate, replacing an unfiltered workspace-wide listing.
  Both with-project paths are byte-unchanged. Driven by the second external consumer's
  team-central PRD-home decision, implemented upstream the same day. One structural
  consequence is stated everywhere the facet is taught rather than left implicit:
  Linear documents `Document.team` as null for any non-team parent, so the
  team-filtered panel can never return a *project-attached* Document — deliberately
  accepted by the team-central convention.

### Fixed

- **The DoR staleness advisory stops trusting mtime for tracked markdown issues.** The
  MarkdownFs store's tracker timestamp now derives from git history for tracked issue
  files (committer date, aligned with the staleness gate's own clock), keeps mtime for
  untracked scratch files, and stays absent where neither signal is derivable — so the
  advisory defers instead of false-passing on a fresh clone. Both edges 1.1.0's entry
  put on record as #443 are closed by this.
- **`cleanup.extraRoots` reaches the detached sweep from the config.** The key
  `config validate` accepted and the docs taught was never threaded from `--config`
  into the `worktree-cleanup` CLI's `--detached` sweep — a config-declared containment
  root now takes effect with no further wiring.

### Docs (plugin half)

- **The Reviewer's sibling tips ride per-sibling named refs.** 1.1.0 left the
  per-sibling tip reads on `FETCH_HEAD` as an undecided question (#445); the answer is
  the fix: the literal leaves the last two teaching sites, and the drift pin inverts —
  it now fails on a `FETCH_HEAD` read *appearing*, not on the named-ref form missing.
- **README and ONBOARDING rebuilt consumer-first.** Live version/CI badges replace the
  hardcoded status line — the drift class that went stale after every release now has
  no number left in the file to drift. The pipeline and the two-layer architecture
  become diagrams, every skill is tabled with its phase (the `report` skill reaches
  the README for the first time), and ONBOARDING's adoption path and preconditions
  wall become tables — doctrine unchanged throughout.
- **The facet-unlock text debt is cleared.** `wave-setup` unlearns the removed
  publishDocument refusal, `cleanup.extraRoots` joins the authoring-time config table,
  the team-null consequence is stated at every teaching site, and the `save_document`
  citation names its real source (the tool description Linear's MCP server serves —
  no stable public URL, so the comment says so; re-verified verbatim,
  schema-corroborated).

### Not yet proven

- **The unbound Document arms have never run against a live Linear workspace.** Every
  spec is hermetic over the HTTP fake; the published schema read pins both shapes
  (`DocumentCreateInput.teamId`, `DocumentFilter.team`). The first live exercise
  should publish one PRD from an unbound consumer and confirm the team-filtered
  listing returns it — the second external consumer's onboarding is the intended
  first reading (ADR-0030 disclosure, carried in the row's review).
- The loud `STILL OPEN:` close line remains unread in anger — this release, too,
  resolves no still-open issue at the playbook's step-7 close.
- #418 (`npm ci --prefix` failing spuriously in dispatched contexts) stays open, now
  falsifiable: the stray `$HOME` npm project the probe matrix suspected was moved out,
  and the issue carries the prediction that the failure does not recur. A future
  dispatched context proves or refutes it.

## [1.1.0] — 2026-08-10

A minor release. The package-root export surface and the `wave.config.json` schema are
untouched; what grows is the CLI's *output* surface — and per ADR-0035 the CLI is now
the explicitly-named third semver contract, with everything here additive against it.
The theme: the engine stops keeping its judgments to itself. Pre-dispatch staleness,
close-time end-states, advisory numbers and coverage denominators are now said out loud
where an operator — human or agent — actually reads them.

### Added

- **The DoR gate learns staleness.** A row whose declared `Files` have seen `main` move
  since the issue's last tracker update now draws an advisory naming the drift — the
  premise-currency check that until now lived only in an operator's discipline.
  Advisory, never a gate-fail: the gate still passes, the operator decides. Two edges
  are on record as #443: the MarkdownFs store derives the tracker timestamp from file
  mtime (a fresh clone reads as current where a defer belongs — the GitHub and Linear
  stores read API metadata and are unaffected), and one defer path carries no
  regression spec yet.
- **`issue-store close` reports the native end-state loudly.** After recording
  `Closed-by:`, close re-probes the tracker and prints the resulting closing state; an
  issue that is natively still open earns an unmistakable `STILL OPEN:` line on stderr
  naming the id and the recorded PR. The silent exit-0 that twice let a
  release-resolved issue stay open unnoticed (#339 at 1.0.0, #397 at 1.0.1) cannot
  recur silently.
- **The CLI surfaces the advisory numbers the engine already computed** — per-string
  advisory indices and the dry-run population — instead of swallowing them.
- **The GitHub store reads `blockedBy` as the union of the body-codec and GitHub's
  native issue dependencies, and mirrors writes back natively** — the read-union the
  Linear adapter shipped with from day one, now on both tracker adapters. The mirror's
  operating envelope (secondary rate limits, per-call API cost) is documented rather
  than throttled.
- **A new consumer-side skill: `report`.** A consumer repo's agent that has fully
  analyzed a finding about flotilla itself can file it upstream at flotilla's own repo
  in the house format — prose-only, and consent-first: it never files without the
  human's explicit go.
- **Convention 12's silent half gets a structural tier.** The tarball ships a second
  PreToolUse guard beside the echo-guard (`hooks/conv12-guard.cjs`): it blocks unquoted
  `$VAR` expansions on the Coordinator surface before they run — the class where zsh's
  no-word-split turns a command held in a variable into a silent no-op behind a
  true-reading success echo.
- **The Reviewer's sibling merge-tree prediction names its coverage denominator**, so
  "no conflicts predicted" is legible as full or partial coverage. Its
  branch-under-review diff base now rides a stable named ref with a SHA assert —
  `FETCH_HEAD` is never read for it. The per-sibling tip reads deliberately remain on
  `FETCH_HEAD` at advisory-only stakes; on record as #445, undecided between fix and
  documented acceptance.

### Fixed

- **A prerelease publishes under the `beta` dist-tag instead of `latest`.** The release
  workflow derives the dist-tag from the version string, so a future beta can no longer
  shadow the stable line for every plain `npm install`.
- **A failed Scribe-payload removal reaches the worktree-cleanup exit code** instead of
  disappearing inside a green sweep.
- **Wave scratch directories are created owner-only, and the planning-pass path is
  session-scoped** rather than a fixed name in a shared tmp.
- **Shipped-text currency, three passes.** Five lines a wave's own changes had made
  false were returned to true; unlabeled canonical-spec citations left five engine
  modules; the drift-guard's command-line advisory subsection attributes its own
  failures. The resolution guard now covers the prose shape as well.
- An accidental `node:path` re-export left the DoR-gate module, together with the
  barrel-drift allowlist entry that excused it — module-local either way; the package
  root never carried it.

### Docs (plugin half)

- The doctrine grill of 2026-08-09 landed three ADRs and an amendment: the
  enforcement-tier ladder with its promotion triggers (ADR-0034), **the CLI as the
  third semver contract** (ADR-0035 — the contract this release's version number is
  chosen against), the claim-safe `awaiting-human` gate (ADR-0036), and
  simulable = executable at both Check-6 sites (ADR-0030 amendment).
- Operator docs caught up across the back half: worktree-cleanup's exit fold, scratch
  preview and dry-run discipline; the Convention-13 catalog's loop shape and
  script-file remedy; the scratch sweep in `wave-resume` and the gitignore scaffold
  route in `wave-setup`; the unified store-preflight verb; the release playbook's
  step-7 close procedure. CLAUDE.md now names the `report` skill.

### Not yet proven

- The loud `STILL OPEN:` close line has passed its specs but has not yet been read in
  anger — and this release cannot read it: no open issue is resolved by this publish,
  so the playbook's step-7 close has nothing to close this time. The first live
  reading waits for the next release that ships a fix whose issue is still open.
- One operational report stays open and unreproduced after a six-probe matrix (two
  filesystem locations × three npm versions): `npm ci --prefix` failing spuriously in
  dispatched contexts (#418). The capture playbook on the issue is the current state
  of knowledge.

## [1.0.1] — 2026-08-01

A patch release, and the **delivery half of work that was already done**: every fix below
landed on `main` before this release existed, which means a consumer installed at 1.0.0
has been running without them the whole time. The package-root export surface and the
`wave.config.json` schema are untouched — this release adds no public API and removes
none.

Most of it comes from the first external consumer's field reports.

### Fixed

- **The echo-guard's refusal no longer sends the reader to a path only this repository
  resolves.** The shipped `PreToolUse` hook rejects a credential-echo command with a
  teaching message; that message cited a source-form skills path that does not exist in
  an installed form, so the one reader it is written for could not follow it. The refusal
  now carries its reason inline instead of pointing anywhere.

- **The shipped hook module's own documentation stopped describing only the repository it
  was written in.** Its paste-ready `hooks.PreToolUse` block and the verify line beneath
  it named flotilla's vendored guard path unqualified; both now name the consumer's own
  scaffold destination, with flotilla's repo recorded as the documented exception it
  already is elsewhere. The same docstring also still announced that the consumer scaffold
  was *not* shipped, while the setup reference recorded that gate as met — the shipped
  artifact contradicted the shipped documentation about its own distribution.

- **Ten dead header pointers left the shipped engine sources.** Comment lines citing
  canonical specs, PRD sources, audit sources and playbooks under directories that have
  never existed in this repository — and that reach no consumer's tarball under any
  circumstances. A resolution guard now keeps them out. It asks *does this document
  exist* rather than matching a list of banned directories, so it does not go stale
  against the next tree that gets retired, and it now covers spec files as well as
  shipped sources.

- **`wave-plan` stopped claiming more than it can know.** Its PRD panel flagged a
  fully-shipped PRD identically to a never-sliced one; the flag now states what it
  actually derives and prescribes a *check* rather than a slice. Its `blockedBy` guidance
  now warns that the field is a union whose `'none'` sentinel has a length of four — so a
  bare `.length` reports four blockers for a row that has none, and reads as internally
  consistent beside a genuine count.

- **The awaiting-human archive gate no longer cites an ADR that does not describe it.**
  The citations now point at the reference that actually documents the gate; the many
  correct citations of that same ADR, which are about the Worker vocabulary, are
  untouched.

### Changed

- The onboarding walk-through teaches the setup-time engine binding instead of call-time
  resolution, at all three sites that taught the old model, and its allowlist guidance
  names the form the scaffold actually writes rather than the exploration-only one. The
  exploration form is still documented — with its lack of pinning and its cost — as what
  it is. The beta framing is gone.

- The charter names the conflict map's structural boundary: the dependency class where
  resolving one piece of work reshapes *what another piece even is* is invisible to the
  map, because the second piece does not exist at check time. That is the edge of the
  promise, not a defect.

### Not yet proven at release — since verified

- **The consumer-facing hop of the guard fix has been simulated, not observed.** During
  review it was exercised end to end by packing the engine, installing it into a
  throwaway repository outside this tree, and running the scaffold's copy and verify line
  verbatim — the guard refused as expected. What has *not* happened is that same path
  through a **published** install of this version: fetching 1.0.1 from the registry into
  a real consumer repository and reading the message there. That check belongs to a human
  after this release is published.

  **Verified 2026-08-01, after the publish.** That exact path was run against the
  published artifact — `npm install` of `1.0.1` from the registry into a throwaway
  repository, then the shipped header's own copy and verify lines verbatim: the guard
  refused with exit 2, and every path the shipped docstring names resolves in that
  repository. The same run against `1.0.0` reproduced the defect this release fixes and
  surfaced one more instance of it than was known: `1.0.0`'s refusal message ended by
  citing a doctrine file under `.claude/skills/`, a tree the tarball does not ship at
  all — a dead pointer in the one place a consumer meets this text at runtime rather
  than by reading a file. Both versions refuse identically, so the fix was legibility
  only, exactly as claimed. Recorded in full on issue #397.

## [1.0.0] — 2026-07-31

The first stable release. What changes with the number: **the package-root export
surface and the `wave.config.json` schema are now semver contracts** — from here,
removing or reshaping either is a major bump. What made the freeze possible is that the
surface is now *deliberate*: every engine module export is either public at the package
root or named on a reason-carrying module-local allowlist, and a drift spec fails on any
symbol that is neither.

### Added

- **The deliberate public API.** ~85 previously root-unreachable symbols are exported
  on purpose — the `IssueStore` contract itself, `GitHubIssuesStore`, `MarkdownFsStore`,
  `RealGitHubApi`, the host-pr landing family, and the route/config/DoR CLI runners among
  them. An installed-form consumer imports the engine's real seams by name instead of
  reaching through module paths.
- **Barrel-drift guard**: a spec comparing every source module's exports against the
  package root via TypeScript-compiler **symbol identity** (not name matching, which two
  real re-export/alias cases in this repo would defeat), with permanent negative
  controls. A new module with neither barrel nor allowlist coverage fails loudly, naming
  module and symbol.
- **Reuse-refusal semantics reach the caller docs** (plugin half): `host-pr create`'s
  close-phrase guard (`reuse-refused`) is documented at both PR-opening call sites, with
  the exit-code interpretation that keeps a refused rewrite from reading as success —
  the refusal payload deliberately still carries the PR URL, and a later existence
  re-query is not proof the rewrite landed.
- **Compose-currency rule** (plugin half): a composed workflow driver is coupled to the
  document it was extracted from — compose fresh, or walk the seeded currency-assertion
  checklist before reuse; the dispatch mechanics carry it as a named gate step, with
  host-side anchor-resolvability beside it (a fabricated SHA fails once at compose, not
  in every brief).

### Fixed

- **The verify-profile scaffold pins both halves of resolution** — the binary
  (lockfile-pinned local form) *and* the discovery root — with a live measurement of
  what each half's absence does (a registry-fetched runner at a different version; a
  repo-root test-file sweep failing the suite). The three-occurrence recurrence arc is
  recorded: a prose warning demonstrably does not close this class; the profile itself
  must name the pinned form.

### Not yet proven

- The stable contract covers the engine package root and the `wave.config.json` schema.
  The plugin's skill prose is versioned in lockstep but keeps evolving at minor cadence —
  it is operating guidance, not API.
- The beta line was exercised by one external consumer stack (Linear store, nested Node
  tree) across live waves; the 1.0.0 surface as frozen here has not yet been imported by
  an external consumer.

## [0.1.0-beta.2] — 2026-07-31

The release that makes the **bundled echo-guard current** — and the floor version for
the stage-2 guard scaffold. beta.1's tarball shipped `hooks/echo-guard.cjs` from before
the family-3 quote-nesting carve-outs: the scaffold's `cp` succeeded and silently
installed a materially weaker guard (present-but-stale, the failure mode the scaffold
docs only half-covered). This release ships the current guard, and the scaffold now
names the stale case and pins this version as the minimum for the guard copy.

### Fixed

- **Bundled echo-guard is current** — includes the quote-nesting state machine (an
  embedded quote inside a quoted substitution wrapper no longer re-exposes trailing
  prose) and the dead-code removal.
- **The Worker brief's PR-URL capture recipe is executable again** for dispatched
  roles: the primary form is the read-only `host-pr status` re-query whose exit
  status is the verdict; the file-based fallback survives only in its variable-free
  spelling. (Measured: shell state — variables, functions, cwd — persists for no
  dispatched role between Bash calls, and an `isolation: worktree` dispatch refuses
  any `$VAR` expansion in any position.)
- The Scribe brief no longer rests on incidental cwd safety (observe-never-set; all
  path arguments absolute and shell-quoted); the Reviewer dispatch binds to the row's
  model tier instead of inheriting the session model.
- Every worked `dor` call-site threads `--config`, so the verify-profile-coverage
  gate returns real verdicts in live waves instead of deferring.

### Added

- **Package-root surface:** the store-preflight family, the typed create rejection,
  and the command-line E2BIG advisory family are importable from the package root.
- **Command-line E2BIG advisory** beside the worktree-count advisory — models the
  exec-argument total *and* the per-string limit, reported apart.
- **Allowlist reconciliation guard:** a spec-level check diffing the tracked
  permission allowlist against the verify gates in both directions.
- **Skill-pipeline guidance** (plugin half): risk-routed reviewer model tier,
  disclosure disposition defaults (triviality predicate, thematic bundles),
  premise-currency verification at triage with pull-triggered cadence, the
  coordinator-direct boundary (Convention 15), a per-set dispatch-cost estimate in
  wave-plan with a foreground carve-out, and a measured verify-command baseline
  recorded at wave-setup.

## [0.1.0-beta.1] — 2026-07-30

The release that makes the **npm-first invocation form operational**. Every skill's
engine-CLI resolution block states the published-package form first (`npx
@formtrieb/flotilla-engine`, ADR-0031), but `0.1.0-beta.0` predates the credential
seam entirely: on a consumer using the keychain indirection it could not resolve a
credential and therefore could not execute the landing seam at all. This beta closes
that gap; the vendored in-repo form remains the documented fallback.

### Added

- **Per-project credential resolution (ADR-0029).** Credentials resolve lazily through
  a per-project lookup command — `<VAR>_CMD` environment variables
  (`GITHUB_TOKEN_CMD`, `LINEAR_API_KEY_CMD`) name a command whose stdout is the
  secret (OS keychain, any secret manager). A configured command wins over the ambient
  variable and fails loud; the ambient variable remains the fallback when no command
  is configured. One resolver module serves both tracker stores and the host seam.
- **`credential-probe` verb** — the value-free AFK preflight: probes each configured
  lookup command (exit status only, never the output) so a broken or prompting
  resolver surfaces before dispatch instead of mid-wave.
- **`hooks/` in the published tarball** — the PreToolUse Echo-Guard
  (`hooks/echo-guard.cjs`), the structural speed bump against credential-echo forms
  in Bash commands; a packaging spec now pins every runtime directory into the npm
  file set so a shipped directory cannot silently drop out again.
- **Documented-form comparison types re-exported from the package root (ADR-0030)** —
  the `documentedFormComparison` verdict types are importable without deep paths.

### Notes for consumers

- With this release the dual-form resolution blocks' npm-first ordering is
  operationally true on credential-indirection consumers. `0.1.0-beta.0`'s known
  failure shapes there — `credential-probe` as an unknown subcommand and
  `host-pr create` failing with a missing-token error despite a configured keychain
  lookup — are resolved by upgrading.

## [0.1.0-beta.0] — 2026-07-27

The first public release. flotilla has existed and been used to build itself for some
time; what is new here is that it is **installable by someone else** — the engine as a
package on the public registry, the skills as a Claude Code plugin, rather than a
directory to be copied by hand.

This is a beta because the distribution is new, not because the orchestration is. The
pipeline has been driving flotilla's own development across thirty-plus live waves; the
install path in front of it is what has not yet been walked by a stranger. See
*Not yet proven* below for exactly which parts that qualifier applies to.

### Added

**Distribution**

- `@formtrieb/flotilla-engine` on the public npm registry, published from CI through
  npm trusted publishing (OIDC) — no long-lived registry credential exists in the
  repository, and the package is configured to refuse token-based publishes entirely.
  Releases carry a provenance attestation linking the artifact to the workflow run and
  commit that produced it.
- A Claude Code plugin manifest (`.claude-plugin/plugin.json`) exposing the full skill
  set and the Reviewer agent, plus a marketplace manifest
  (`.claude-plugin/marketplace.json`) so the plugin is installable by name.
- The skills resolve the engine CLI through the published package rather than a
  relative path into a vendored checkout, which is what makes them work from an
  installed plugin at all.

**Orchestration pipeline**

- Planning skills — `triage`, `to-prd`, `to-issues` — turning a raw idea or bug report
  into wave-eligible issues that carry a declared file scope.
- Wave lifecycle skills — `wave-setup`, `wave-plan`, `wave-create`, `wave-start`,
  `wave-reviewer`, `wave-close`, `wave-resume`.
- Universal Reviewer dispatch: every row is reviewed before its PR opens, and the
  verdict is schema-validated rather than free prose, so routing to
  approve / request-changes / stop is deterministic instead of inferred.
- Worktree-isolated Worker dispatch with schema-validated reports, a cap of one
  re-dispatch per row, and `needs-attention` as the terminal state for a row that
  stopped.

**Engine**

- `computeConflictMap` — wave-agnostic glob-set math answering whether a candidate wave
  can run alongside everything already queued or in-flight. This is the part that is
  meant to outlive any particular tracker or stack.
- `files-drift` as the runtime guarantor that an issue's declared globs actually held.
- DoR (definition-of-ready) gating, advisory merge-order computation, and the coarse
  status projection (`available → queued → in-flight → in-review → done`, plus an
  orthogonal `needs-attention`) written back to the tracker.
- `SpineStore` — the per-wave orchestration spine as durable local markdown, which is
  the write-ahead log `wave-resume` reconstructs from when a Coordinator is killed
  mid-wave.

**Trackers**

- Three `IssueStore` implementations — `MarkdownFsStore` (local dev and dogfooding),
  `GitHubIssuesStore`, and `LinearIssuesStore` — with one conformance suite that passes
  unchanged across all three.

### Notes for consumers

- **The engine ships raw TypeScript and has no build step.** The `flotilla-engine`
  binary handles this for you. Importing the package programmatically does not: it
  requires a TypeScript-aware loader in the host process, and there is no compiled
  entry point to fall back on. This is a deliberate design choice, not an omission.
- Node `>=20.11.0`. Publishing a release additionally requires npm `>=11.5.1`, which is
  above what Node 22 bundles — the release workflow installs it explicitly.
- The published tarball contains only what a consumer executes: sources minus specs and
  fixtures, the binary, `LICENSE`, and `README.md`.

### Not yet proven

Stated plainly, because a beta that hides this is worth less than one that does not:

- The end-to-end live gate for the GitHub-Issues adapter **through the installed plugin
  and published package** has not been run yet ([#83](https://github.com/formtrieb/flotilla/issues/83)).
  Every wave to date drove the adapter from an in-repo checkout. The adapter itself is
  exercised; the install path in front of it is not.
- ~~`README.md` and `docs/ONBOARDING.md` still describe the vendor-copy adoption path and
  not the plugin install~~ — rewritten after this release
  ([#84](https://github.com/formtrieb/flotilla/issues/84)). Note that the published
  `0.1.0-beta.0` tarball still carries the older `README.md`; the repository does not.
- Cross-skill references are still by bare name, which is not what plugin distribution
  namespaces them to ([#81](https://github.com/formtrieb/flotilla/issues/81)).
- Automatic worktree cleanup skips any worktree the agent harness has written into,
  which is all of them in practice — cleanup currently happens by hand
  ([#111](https://github.com/formtrieb/flotilla/issues/111)).

[0.1.0-beta.1]: https://github.com/formtrieb/flotilla/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/formtrieb/flotilla/releases/tag/v0.1.0-beta.0
