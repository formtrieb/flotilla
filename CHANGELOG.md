# Changelog

All notable changes to flotilla are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two artifacts are versioned together and released as one unit — the npm package
`@formtrieb/flotilla-engine` (`tools/wave/package.json`) and the Claude Code plugin
(`.claude-plugin/plugin.json`). A single entry below covers both. How a release is cut
is documented separately in [docs/RELEASING.md](docs/RELEASING.md).

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
