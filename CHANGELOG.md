# Changelog

All notable changes to flotilla are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two artifacts are versioned together and released as one unit — the npm package
`@formtrieb/flotilla-engine` (`tools/wave/package.json`) and the Claude Code plugin
(`.claude-plugin/plugin.json`). A single entry below covers both. How a release is cut
is documented separately in [docs/RELEASING.md](docs/RELEASING.md).

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

### Not yet proven

- **The consumer-facing hop of the guard fix has been simulated, not observed.** During
  review it was exercised end to end by packing the engine, installing it into a
  throwaway repository outside this tree, and running the scaffold's copy and verify line
  verbatim — the guard refused as expected. What has *not* happened is that same path
  through a **published** install of this version: fetching 1.0.1 from the registry into
  a real consumer repository and reading the message there. That check belongs to a human
  after this release is published.

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
