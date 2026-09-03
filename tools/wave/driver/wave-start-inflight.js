// wave-start-inflight — the Workflow dispatch driver, shipped as a package asset.
//
// THIS FILE IS THE SOURCE OF TRUTH FOR THE DISPATCH SCRIPT. It is not pasted
// from anywhere and it is not transcribed by hand: the engine verb
// `compose-driver` reads it, substitutes the compose-time constants below
// (REPO_ROOT, WAVE_CLI, REPORTS_DIR, VERDICTS_DIR, REVIEWER_AGENT) and the
// per-row ISSUES array, and writes the finished script to the path the
// Coordinator hands the harness Workflow tool as its `scriptPath`. The design
// rationale — why the pipeline decomposes this way, why the schema copies drop
// a top-level combinator, why the Scribe observes its cwd instead of setting
// it — lives beside this file in the wave-start skill's workflow-driver
// reference document; what actually runs lives here.
//
// Handing the harness a FILE (`scriptPath`) is a deliberate departure from the
// workflow authoring reference's default, which is to pass the script inline.
// The file form is what makes the composed script inspectable before it runs
// and replayable afterwards (`Workflow({ scriptPath, resumeFromRunId })` re-runs
// the same bytes), and it is the point of composing at all: nothing is pasted
// by hand. The file must sit where the session may read it — inside the repo,
// under the gitignored `.flotilla/tmp/` — or the harness refuses to start it.
//
// The engine never dispatches anything. It writes this file out with its
// constants filled; the HARNESS runs the result. The schema-validated-return
// guarantee (a dispatched agent cannot silently fabricate a result) is a
// property of THIS script's `agent({ schema })` calls, and stays one — the
// engine calls no agent-harness primitive to compose it (ADR-0009).
//
// The placeholder VALUES below are deliberate: every one of them is replaced at
// compose time, and a placeholder reaching a dispatch is a compose bug, never a
// default. Do not fill one in by hand.

export const meta = {
  name: 'wave-start-inflight',
  description: 'Dispatch + review one ready wave; return schema-validated reports + verdicts',
  phases: [{ title: 'Dispatch' }, { title: 'Review' }],
}

// ── inlined from wave-shared (copy of WORKER_REPORT_SCHEMA) ──
// anyOf-free by design (agent tool's input_schema rejects a top-level anyOf/oneOf/allOf,
// W5-F1) — the prUrl-on-done/done-with-concerns invariant is BRIEF-enforced below, not
// schema-enforced. See "Why this copy drops anyOf" above; skill-schema-drift.spec.ts pins
// both halves — no top-level combinator, AND every other property deep-equals the engine
// const modulo exactly that stripped anyOf, so a content drift here (e.g. a lost minLength)
// fails loud too.
const WORKER_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome','issue','branch','commitShas','filesChanged','tests','lint','judgmentCalls','reviewerFocusItems'],
  properties: {
    outcome: { type: 'string', enum: ['done','done-with-concerns','needs-context','blocked'] },
    issue: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 },
    worktree: { type: 'string' },
    commitShas: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    prUrl: { type: 'string', minLength: 1 },
    filesChanged: { type: 'object', additionalProperties: false, required: ['new','modified','renamed'],
      properties: { new: { type: 'integer', minimum: 0 }, modified: { type: 'integer', minimum: 0 }, renamed: { type: 'integer', minimum: 0 } } },
    tests: { type: 'string', minLength: 1 }, regressionSweep: { type: 'string' },
    lint: { type: 'string', minLength: 1 }, conflictMarkers: { type: 'string' },
    judgmentCalls: { type: 'array', items: { type: 'string' } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
  },
}

// ── inlined from wave-shared (copy of REVIEWER_VERDICT_SCHEMA — uniform Reviewer: NO briefProfile) ──
const REVIEWER_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict','branchReviewed','riskClass','workerReportDigest','acVerification','reviewerFocusItems'],
  properties: {
    verdict: { type: 'string', enum: ['approve','changes-requested','questions-blocking'] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: ['mechanical','isolated-refactor','cross-feature-refactor','public-API-change'] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ac','met','evidence'],
      properties: { ac: { type: 'string', minLength: 1 }, met: { type: 'string', enum: ['met','partial','not-met','deferred'] }, evidence: { type: 'string' } } } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' }, gitStateSane: { type: 'boolean' },
    // Documented-Form Comparison (ADR-0030) — FLAT + OPTIONAL. The duty is
    // conditional ("required when a trigger fired"), and the schema ROOT is the
    // wrong home for it — NOT because this boundary refuses the shape. Measured
    // with positive and negative controls: a root anyOf/oneOf/allOf IS rejected
    // outright (W5-F1), a root if/then is ACCEPTED and genuinely enforced. It
    // stays out because the antecedent is `trigger`, a field the Reviewer itself
    // authors: cornered on a consequent it cannot satisfy, an author changes the
    // antecedent rather than failing, so a root conditional buys shape and never
    // truth (ADR-0034 Amendment 2026-08-14 — engine refusal and schema boundary
    // are separate rungs, and engine refusal outranks the boundary for exactly
    // this case). So the condition lives in the Reviewer contract prose
    // (.claude/agents/wave-reviewer.md, Check 6), exactly as the prUrl invariant
    // above is brief-enforced rather than schema-enforced on this copy — a
    // placement decision, never a cue to "fix" it into a root if/then.
    // `sources` minItems:1 is the STRUCTURAL half of the no-restatement rule:
    // a comparison must cite a document the Reviewer read itself.
    documentedFormComparison: {
      type: 'object', additionalProperties: false,
      required: ['trigger','sources','divergences'],
      properties: {
        trigger: { type: 'string', enum: ['issue-declared','worker-declared','deferred-core-path'] },
        sources: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        divergences: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['description','deliberate'],
          properties: { description: { type: 'string', minLength: 1 }, deliberate: { type: 'boolean' } } } },
      },
    },
  },
}

// ── Scribe result — DRIVER-LOCAL, deliberately NOT drift-pinned (ADR-0024) ──
// No engine const corresponds to this; do NOT add it to skill-schema-drift.
// Boundary-safe: a plain object, no top-level anyOf/oneOf/allOf (W5-F1).
const SCRIBE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'path'],
  properties: {
    ok: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' },
    // `notice` carries an EXIT-0 finding through — a normalized decorated id or
    // misnamed litter the write verb printed on stderr, and (brief step 1) a cwd
    // that did not match the compose-time REPO_ROOT even though the write still
    // succeeded, which on a path-free engine binding is the ONLY signal that the
    // wrong engine copy may have answered. Without it the only channel the Scribe
    // has is `error`, which it may only set on failure, so an exit-0 finding would
    // be dropped at exactly the stage that saw it.
    notice: { type: 'string' },
  },
}

// ── Scribe compose-time constants (Coordinator-filled, like depsSetup) ──
// REPO_ROOT is the one ABSOLUTE-by-necessity constant: Scribes run in the
// session cwd (no worktree isolation), so their brief carries this literal
// twice — as the cwd its step-1 `pwd` is compared against, and as the base of
// the ABSOLUTE payload path its step-3 engine call passes. It is NEVER a
// directory the Scribe changes into: a `cd` cannot reach step 3 (cwd is reset
// to the dispatch root before every Bash call), and the brief names that
// retired step as a dead end rather than leaving it to be re-derived
// (§The Scribe's cwd, above). Fill it from `git rev-parse --show-toplevel` in
// the Coordinator's own session — the same root the wave is dispatched from.
// It is interpolated SHELL-QUOTED wherever it reaches a brief — always
// shell-quoted, never bare — because an absolute repo path is precisely where
// spaces and non-ASCII characters live, and an unquoted interpolation breaks
// silently on one: the Scribe stage logs loud and passes its payload through
// rather than failing the wave (ADR-0024 exists so the sidecar becomes durable
// the moment the work does; an unquoted REPO_ROOT quietly reopens exactly that
// window). Live-verified against a checkout path containing both a space and a
// typographic en-dash (this repo's own worktree path) — the unquoted form
// fails outright (`No such file or directory`) on the retired `cd` and on any
// path argument built from it alike; the quoted form succeeds. That is why the
// payload path below is quoted too, not only the sidecar `--dir`.
const REPO_ROOT = '<absolute repo root, e.g. "/abs/path/to/flotilla">'
// WAVE_CLI IS FILLED FROM THE CONSUMER'S CONFIGURED BINDING — `engine.cli` in
// its `wave.config.json`, read once at compose time and pasted here verbatim.
// It has NO DEFAULT OF ITS OWN and states NO INVOCATION FORM: the binding lives
// in exactly one place per repo, and this constant reads it (ADR-0032). An
// ABSENT `engine.cli` is a STOP — `wave-setup` has not finished in that repo —
// never a cue to pick a spelling and never a chain to walk. If the configured
// binding fails at runtime, that is a needs-attention finding about a broken
// install, config or release; a Worker reports it, it does not route around it.
//
// The config layer validates the value as REPO-RELATIVE AND NON-ABSOLUTE, which
// is precisely the property this constant needs. The tracked
// `.claude/settings.json` permission allowlist a dispatched agent inherits can
// only match REPO-RELATIVE invocation prefixes — an absolute form would embed a
// machine- and client-specific path a public repo's tracked settings must never
// carry. Worker AND Reviewer worktrees carry tracked files only (see "A worktree
// carries tracked files only" above) — that tracked allowlist is the ONLY
// permission source they inherit, so an absolute-form engine call from a
// Worker's termination step or a Scribe would hit the permission gate mid-wave
// and break AFK dispatch. A Worker's post-checkout cwd already IS a
// repo-relative root, so the configured binding resolves there unchanged.
//
// Two live findings shaped the field's validation and are why "just try the
// other form" is not on offer here. A marketplace plugin consumer has no
// vendored `tools/wave` and no local `tsx` binary, so a vendored-form
// invocation resolved to nothing on every Worker termination step and every
// Scribe call (DA-F1). Going the other way, an unpinned `npx` invocation costs
// ~82 s per call against ~1.2 s for a pinned local binary, and contends on the
// shared npm cache lock under fan-out (`ECOMPROMISED`, KW-F7). Neither is a
// form to rank above the other: each is simply wrong for a repo whose install
// posture says so, which is what makes the binding a SETUP-TIME decision.
// depsSetup (Worker step 4, the FIRST step) installs whatever the configured
// binding resolves through, so the binary exists before the terminator's
// WAVE_CLI call — keep depsSetup first for this reason as well as the
// verify-gate one.
// (Provenance: ADR-0032; `docs/retros/2026-07-27-plugin-consumer-w1.md` DA-F1.)
//
// WAVE_CLI also carries an explicit NODE_USE_ENV_PROXY=1 prefix (wave-shared
// Convention 1's raw-fetch-vs-proxied-sandbox fix). The tracked settings `env`
// block — scaffolded by wave-setup, and set the same way in flotilla's own
// tracked `.claude/settings.json` — is the STANDING source for this flag once
// it applies: every command the harness runs already inherits it, which makes
// this prefix REDUNDANT-BUT-HARMLESS wherever that block is present. The
// prefix stays on the constant anyway because it is LOAD-BEARING for any
// consumer WITHOUT that tracked block yet (a fresh repo before wave-setup has
// run, or a harness without settings-env support) — the driver has no way to
// know which posture a given consumer is in, so it keeps the belt-and-braces
// form rather than assume the block is present.
//
// WAVE_CLI IS A COMPOSE-TIME JS CONSTANT — IT MUST NEVER BECOME A SHELL
// VARIABLE (wave-shared Convention 12). It is interpolated into brief TEXT by
// this script, before any shell exists, so every rendered brief carries the
// literal command string and no expansion ever happens. That is what makes it
// safe. Reading the value out of config does NOT change that shape: what moves
// is where the string comes from, not what it is. The failure this note
// forecloses is the "helpful" refactor that turns the constant into a runtime
// lookup in the agent's shell — `CLI=$(… engine.cli …); $CLI verb` — under zsh
// an unquoted expansion is NOT word-split, so that looks for a command whose
// name is the whole configured string, exits 127, and runs NOTHING. That exact
// line has broken a wave four times before the guard below existed (W4-F10 /
// W5-F5 / W18-F3 and the gate run that filed Convention 12). If a shell
// binding is genuinely wanted somewhere, it is a FUNCTION —
// `wave_cli() { NODE_USE_ENV_PROXY=1 <the configured value> "$@"; }` — never a
// variable in command position. That remedy is bounded, and stated no wider
// than it holds: a shell function is a fix only WITHIN the one Bash call
// that defines it — a function is session state exactly like a variable,
// and no shell state survives between a dispatched role's Bash calls, on
// either dispatch posture (measured live, wave-shared Convention 13,
// §Splitting is not always a preceding `cd`). Defining `wave_cli()` in call
// N buys nothing in call N+1; it is not a substitute for carrying a value
// across calls, which nothing here is.
const WAVE_CLI = 'NODE_USE_ENV_PROXY=1 <engine.cli from wave.config.json, verbatim>'
// REPORTS_DIR / VERDICTS_DIR stay ABSOLUTE regardless — sidecar dirs are
// addressed independent of the cwd the Scribe was dispatched into, and there is
// no `cd` anywhere in its brief for that cwd to have been moved by: the Scribe
// OBSERVES its cwd once and never sets it (§The Scribe's cwd, above). Absolute
// is what makes these two dirs indifferent to the observation's outcome — a
// cwd mismatch is a finding to report, never a reason `--dir` resolves
// somewhere else. Like REPO_ROOT, both are interpolated SHELL-QUOTED wherever
// they reach a brief (the Scribe's `--dir "${dir}"` call, below) for the same
// reason.
const REPORTS_DIR = '<absolute .flotilla/waves/<slug>/reports>'
const VERDICTS_DIR = '<absolute .flotilla/waves/<slug>/verdicts>'

// REVIEWER_AGENT IS FILLED FROM THE FORM THE SKILLS ARE RUNNING IN, exactly as
// WAVE_CLI is filled from the configured binding — and for the same reason: the
// name a dispatch must use is a per-repo INSTALL fact, not something this script
// may state. In flotilla's own SOURCE form the Reviewer is registered under its
// bare definition name (the `name:` in the agent definition's frontmatter); in
// the INSTALLED form the plugin registers it NAMESPACED under the plugin
// manifest's own `name`, as `<plugin>:<agent>`. A Coordinator that pasted the
// bare name into an installed-form dispatch had its Stage-3 `agent()` call fail
// to resolve — the gap this constant closes. `compose-driver` derives the value
// from those two files plus the configured `engine.cli` form discriminator, and
// honours an explicit `--reviewer-agent` override; nothing here picks a
// spelling, exactly as WAVE_CLI states no invocation form (ADR-0032).
const REVIEWER_AGENT = '<agent name — bare in the source form, <plugin>:<agent> in the installed form>'

const j = (items) => (items.length ? items : ['none']).map(s => `- ${s}`).join('\n')

// Renders a row's granted scope extensions (ADR-0041) — a projection of this
// row's scope-extension disclosures in the spine, never authored by hand
// (§Per-row data, "The recompose-refetch rule" above). Absent or empty alike
// render as "- none", matching j()'s own stance on an empty reviewerHints.
const renderGrants = (grants) =>
  (grants && grants.length ? grants : ['none']).map((g) =>
    typeof g === 'string'
      ? `- ${g}`
      : `- **${g.paths.join(', ')}** — granted at iteration ${g.grantedAtIteration} (disclosure \`${g.disclosureRef}\`): ${g.reason}`
  ).join('\n')

// ── Per-row data — Coordinator fills this from the spine before invoking ──
// Each: { id, slug, worker, risk, iteration, model, anchorSha, coordinatorBranch,
//         depsSetup, issueSpec, prTitle, closePhrase, reviewerHints, siblingBranches,
//         iteration1HeadSha?, scopeGrants? }
// `worker` is copied straight off the row's Plan-Table Worker cell. It is not
// interpolated into any brief — it exists so `assertNotHumanGated` below can
// refuse to compose a row no agent may pick up (see §The human gate).
// `branch` is NOT authored here — it is DERIVED, once, immediately below (see
// its own comment) from `id` + `slug`, the same two fields already in this
// list. Never add a hand-authored `branch:` to a row literal; the derivation
// step overwrites it regardless, and a hand-authored value is exactly the
// "Coordinator sets it, forgets to wire it into the array the driver reads"
// shape this whole assertion exists to make impossible.
// iteration1HeadSha is OPTIONAL and iteration>1-only (a re-dispatch, §Re-dispatch
// above): the iteration-1 Worker's last commit SHA, read off the iteration-1
// WorkerReport's `commitShas` (last entry) — the Coordinator already holds that
// report when composing the re-dispatch (it is the same `report` in the routed
// `{ id, risk, iteration, report, verdict }` tuple). Absent on iteration 1.
// scopeGrants is OPTIONAL and array-valued, like reviewerHints (ADR-0041): each
// entry is { paths: string[], reason: string, grantedAtIteration: number,
// disclosureRef: string } — a PROJECTION of this row's `scope-extension`-
// disposition disclosures in the spine (`spine add-disclosure` / `set-disposition`,
// ADR-0027), built fresh at EVERY compose by "The recompose-refetch rule" above.
// The spine stays the sole durable record: this field is never authored by hand
// and never a second source of truth, only the compose-time READING of what the
// spine already holds for this row. Absent, or an empty array, on a row with no
// scope-extension disclosures yet — both render as "none" in both briefs
// (renderGrants below), which is the ordinary case.
const ISSUES = [
  {
    id: 'NN',
    slug: 'short-slug',
    // The row's Plan-Table Worker cell, verbatim. A human-gated value here is a
    // compose-time throw, never a dispatch — the row should have been excluded
    // upstream at start-mechanics.md step 3b (§The human gate, below).
    worker: 'background',          // background | background-heavy | foreground | HITL-required
    risk: 'mechanical',            // mechanical | isolated-refactor | cross-feature-refactor | public-API-change
    iteration: 1,
    // Binds BOTH the Worker (Stage 1) and the Reviewer (Stage 3, ADR-0007
    // Amendment 2026-07-31) — one Risk-derived tier for the whole row.
    model: 'sonnet',               // 'opus' for cross-feature-refactor / public-API-change, else 'sonnet'
    anchorSha: '<COORDINATOR_HEAD_SHA>',   // git rev-parse HEAD at dispatch time — the wave anchor
    coordinatorBranch: 'feat/<slug>',
    // The consumer's own dependency-install command(s) — from the wave-setup
    // preconditions answer for "is the dependency dir gitignored?". Empty
    // string only if the consumer confirmed nothing is gitignored there.
    // COMPOSE IT UNFUSED (wave-shared Convention 13): this string is the FIRST
    // command every Worker and Reviewer runs, so a fused `cd <depsDir> &&
    // <installCmd>` here teaches the shape the briefs' own clause forbids —
    // and hits both mechanisms it names (a permission gate that requires every
    // subcommand of a compound to match a rule independently; a worktree-
    // isolation guard that can reject a fused command as too complex to
    // verify). Prefer the installer's own directory flag, which is also the
    // form that survives a cwd reset between an agent's Bash calls.
    depsSetup: '<consumer dependency-install command, directory carried BY the command, e.g. "npm ci --prefix <depsDir>" / "composer install -d <depsDir>">',
    // The FULL issue spec embedded verbatim — title, body, acceptance criteria,
    // declared Files globs, risk. NOT a tracker id/path: the store config that
    // would resolve one may itself be gitignored and absent from this worktree.
    issueSpec: '<embed title + body + acceptance criteria + Files globs + risk here>',
    // OPTIONAL (ADR-0041) — this row's granted scope extensions, projected from
    // the spine's scope-extension disclosures AT THIS COMPOSE (see "The
    // recompose-refetch rule" above). Omit, or leave [], on a row with none yet.
    scopeGrants: [
      // { paths: ['<path>'], reason: '<why the touch was forced>', grantedAtIteration: 1, disclosureRef: '<row-id>.<ordinal>' },
    ],
    // The PR-open inputs the Worker passes to `host-pr create` (the Worker has no
    // wave.config.json in its worktree, so the Coordinator supplies both):
    //   prTitle     — the PR title. Composed WITHOUT any bare tracker id
    //                 (mention discipline, wave-shared Convention 4).
    //   closePhrase — the store-kind close phrase, derived from wave.config.json's
    //                 store.kind: github → 'Closes #<N>', linear → 'Fixes <TEAM-NN>'.
    //                 It is the ONLY tracker id allowed anywhere in the PR title/body.
    prTitle: '<PR title — no bare tracker id>',
    closePhrase: '<Closes #NN | Fixes TEAM-NN — store-kind-derived (Convention 4)>',
    reviewerHints: ['Verify <thing 1>.', 'Confirm <thing 2>.'],
    siblingBranches: '(none — last in-flight issue)',
  },
]

// ── Derive the row's own branch name ONCE (AC5, FOR-139) ──
// Every call site below — the Worker's `git checkout -b`, its `git push
// origin`, its `host-pr create --branch`, and the Reviewer's stated review
// target — reads `issue.branch`; none of them re-interpolates
// `wave/${issue.id}-${issue.slug}` separately. A DERIVED value cannot
// silently diverge from the id/slug it derives from the way a hand-authored
// SECOND field could — which is exactly the shape a live recurrence took: a
// Coordinator set `branch` on its own row objects and never copied it into
// the array the driver reads, so `${issue.branch}` rendered the literal
// string "undefined" at all five of its call sites (the four here plus the
// sibling-branch list every Reviewer uses for merge-tree prediction). Six
// Workers each invented their own branch name rather than create one
// literally called `undefined`; three Reviewers correctly halted at input
// validation; the spine's dispatch log recorded six branches that never
// existed. This formula MUST byte-match the Coordinator's own `spine
// set-branch "$SPINE" "$ID" "wave/$ID-$ROW_SLUG"` call (start-mechanics.md
// step 5) — same id, same slug, same `wave/<id>-<slug>` shape — because
// $ID/$ROW_SLUG there are bound from the SAME roster row that fills
// issue.id/issue.slug here (start-mechanics.md's own note on that line).
// Demonstrably the same value, not merely conventionally the same: both
// read off one roster row, and REQUIRED_ROW_FIELDS below refuses to let
// either half of that row be missing/blank/"undefined".
ISSUES.forEach((issue) => { issue.branch = `wave/${issue.id}-${issue.slug}` })

// ── Compose-time required-field assertion — run BEFORE any agent() fan-out ──
// Generalizes the original W2-F1 fix, which validated ONLY anchorSha: the
// anchor SHA was defined as a constant but never wired into the per-row
// objects, so every brief interpolated the literal string "undefined" as its
// diff base. The IDENTICAL failure recurred one wave-generation later, on
// `branch` instead (see the derivation comment above), with a WIDER blast
// radius. A guard shaped like `assert(oneNamedField)` does not generalize by
// being read; it generalizes by covering the set. REQUIRED_ROW_FIELDS below
// IS that set, named in exactly ONE place a Coordinator can check a composed
// row against — instead of leaving the set to be inferred by reading every
// brief for its `${issue.*}` interpolations (Authoring constraint #7 above).
//
// Deliberately EXCLUDED, with reasons (not merely forgotten):
//   - depsSetup, iteration1HeadSha — legitimately optional; both briefs
//     guard their interpolation with `|| <fallback text>` already.
//   - reviewerHints — an array, not a scalar. An EMPTY array is valid ("no
//     hints yet" — `j()` already renders it as `- none`); a naive
//     string-emptiness check would wrongly reject that valid empty case
//     (`String([]) === ''`), so it is out of scope for this assertion.
//   - scopeGrants (ADR-0041) — an array, not a scalar, exactly like
//     reviewerHints above: an EMPTY array or an ABSENT field are both valid
//     ("no grants yet" — `renderGrants()` below renders either as `- none`),
//     so the identical string-emptiness objection applies and it is out of
//     scope for this assertion for the same reason.
//   - iteration — a number compared (`issue.iteration > 1`), not rendered
//     into text on the path that would ever see it; an absent value
//     misroutes to the iteration-1 branch rather than rendering "undefined",
//     a different failure shape from the one this assertion targets.
//   - worker — a DIFFERENT predicate with a DIFFERENT remedy, so it gets its
//     own assertion (assertNotHumanGated, below) rather than a slot here.
//     This list asks "is the field present enough to interpolate?" and its
//     fix is to wire the value in; the worker check asks "may this row be
//     dispatched at all?" and its fix is to REMOVE the row from ISSUES.
//     Folding the two together would let a missing worker read as a pass and
//     a human-gated one read as a wiring bug.
const REQUIRED_ROW_FIELDS = [
  'id', 'slug', 'branch', 'risk', 'model', 'anchorSha', 'coordinatorBranch',
  'issueSpec', 'prTitle', 'closePhrase', 'siblingBranches',
]

// A template renders a missing/undefined property as the LITERAL STRING
// "undefined" — never a thrown error, never a blank interpolation. Both live
// occurrences (W2-F1's anchorSha, and the branch recurrence above) took
// exactly this shape. An absent key is therefore not the only failure shape
// worth rejecting: the literal "undefined" and an empty/whitespace-only
// string are the two others a template can silently produce, and each must
// fail exactly as loud as an absent key.
function isMissingField(value) {
  return (
    value === undefined ||
    value === null ||
    value === 'undefined' ||
    String(value).trim() === ''
  )
}

function assertRequiredRowFields(issue) {
  for (const field of REQUIRED_ROW_FIELDS) {
    if (isMissingField(issue[field])) {
      throw new Error(`wave-start: row ${issue.id} has no valid ${field} (got ${JSON.stringify(issue[field])}) — wire ${field} into ISSUES before dispatch`)
    }
  }
}
ISSUES.forEach(assertRequiredRowFields)

// ── Compose-time HUMAN GATE — also BEFORE any agent() fan-out (§The human gate) ──
// A human-gated Worker means no agent may pick the row up until a human acts
// (ADR-0012). start-mechanics.md step 3b already excludes such a row from ISSUES;
// this is the structural backstop for that exclusion, in the same place and for
// the same reason as the assertion above — an instruction a Coordinator can
// forget becomes a throw the fan-out cannot get past. A held row that reaches
// here has no failure of its own to hit: every brief interpolates fine, the
// Worker runs, and it burns a full agent budget on the one blocker an agent
// cannot clear by construction.
// The default token is the engine's HUMAN_GATED_WORKER (tools/wave/src/wave-md-rw.ts);
// a consumer that re-spelled or trimmed its config-governed Worker vocabulary
// fills its own token(s) in here at compose time, exactly like WAVE_CLI.
const HUMAN_GATED_WORKERS = ['HITL-required']

function assertNotHumanGated(issue) {
  if (HUMAN_GATED_WORKERS.includes(issue.worker)) {
    throw new Error(`wave-start: row ${issue.id} has a human-gated worker (${issue.worker}) and must not be dispatched — hold it in the human lane and remove it from ISSUES`)
  }
}
ISSUES.forEach(assertNotHumanGated)

// The iteration-1 (default) workspace setup — unchanged from before the
// re-dispatch teardown/tracking-free-checkout fix (W26-F1) except for its
// checkout target, which now reads the derived `issue.branch` (FOR-139)
// rather than re-interpolating `wave/${issue.id}-${issue.slug}` inline.
const WORKSPACE_SETUP_ITER1 = (issue) => `## Workspace setup (do first)
1. \`pwd\` — confirm you are in a worktree (not the parent path). **This is the one cwd
   check you need and the only one you can have:** your cwd is reset to this same dispatch
   root before EVERY Bash call you make, so what \`pwd\` prints here is where each step
   below starts — the git commands in step 2, the checkout, the install, every verify
   command, and every Termination step alike. It is a constant you OBSERVE, not state you
   can SET: a \`cd\` in one call is invisible in the next (wave-shared Convention 13,
   §Splitting is not always a preceding \`cd\`), so never issue one to set up a later step,
   and never fuse one onto the command that matters.
2. Anchor to the wave anchor SHA:
   \`\`\`bash
   git fetch origin ${issue.coordinatorBranch} 2>&1 | tail -3
   git reset --hard ${issue.anchorSha}
   git status --porcelain      # MUST be empty
   git rev-parse HEAD          # MUST equal ${issue.anchorSha}
   \`\`\`
3. \`git checkout -b ${issue.branch}\`
4. Install dependencies. A worktree checkout carries **tracked files only** — if
   this consumer's dependency directory is gitignored (the ordinary case for a
   lockfile-managed tree), it is **absent here, not merely un-installed**, and
   the verify gate below cannot run at all — and, wherever this consumer's
   configured \`engine.cli\` binding resolves through that same directory (the
   ordinary case: a pinned local binary), the terminator's engine CLI call (see
   Termination step 3) has nothing to resolve either — without this step first:
   \`\`\`bash
   ${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
   \`\`\``

// The iteration≥2 (re-dispatch) workspace setup (W26-F1, §Re-dispatch above):
// the wave branch ALREADY EXISTS, carrying the iteration-1 commits — this
// worker continues on it, it does not re-anchor to anchorSha and branch fresh.
// The checkout is TRACKING-FREE (fetch + checkout -B against FETCH_HEAD, or the
// explicit iteration-1 head SHA) so it never writes upstream-tracking into the
// shared .git/config of the main repo (sandbox-write-denied for a worktree-
// isolated agent — a tracking checkout half-applies and strands the switch).
// The Coordinator has already deregistered the iteration-1 worktree that held
// this branch (start-mechanics.md step 7d), so the checkout below is never
// blocked by a stale `git worktree` registration.
const WORKSPACE_SETUP_REDISPATCH = (issue) => `## Workspace setup (do first) — RE-DISPATCH, iteration ${issue.iteration}
1. \`pwd\` — confirm you are in a worktree (not the parent path). **This is the one cwd
   check you need and the only one you can have:** your cwd is reset to this same dispatch
   root before EVERY Bash call you make, so what \`pwd\` prints here is where each step
   below starts — the fetch and checkout in step 2, the install, every verify command, and
   every Termination step alike. It is a constant you OBSERVE, not state you can SET: a
   \`cd\` in one call is invisible in the next (wave-shared Convention 13, §Splitting is
   not always a preceding \`cd\`), so never issue one to set up a later step, and never
   fuse one onto the command that matters.
2. This is a re-dispatch: \`${issue.branch}\` ALREADY EXISTS,
   carrying your iteration-1 commits — do not discard them, do not re-anchor to
   the wave anchor SHA and branch fresh. Land on the existing branch with a
   TRACKING-FREE checkout — never \`git checkout -B <branch> origin/<branch>\`,
   which writes upstream-tracking into the SHARED .git/config of the MAIN repo
   (sandbox-write-denied for a worktree-isolated agent; that form half-applies
   and strands the switch mid-way — live occurrence W26-F1, recovered only by
   hand via \`git symbolic-ref\`):
   \`\`\`bash
   git fetch origin ${issue.branch} 2>&1 | tail -3
   git checkout -B ${issue.branch} FETCH_HEAD
   git status --porcelain      # MUST be empty
   git rev-parse HEAD          # MUST equal ${issue.iteration1HeadSha || 'the fetched branch tip (see step 2)'}
   \`\`\`
   (The Coordinator already deregistered the iteration-1 worktree that held
   this branch before this dispatch — start-mechanics.md step 7d — so this
   checkout is never blocked by a stale worktree registration.)
3. Install dependencies. A worktree checkout carries **tracked files only** — if
   this consumer's dependency directory is gitignored (the ordinary case for a
   lockfile-managed tree), it is **absent here, not merely un-installed**, and
   the verify gate below cannot run at all — and, wherever this consumer's
   configured \`engine.cli\` binding resolves through that same directory (the
   ordinary case: a pinned local binary), the terminator's engine CLI call (see
   Termination step 3) has nothing to resolve either — without this step first:
   \`\`\`bash
   ${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
   \`\`\``

function workerBrief(issue) {
  const workspaceSetup = issue.iteration > 1
    ? WORKSPACE_SETUP_REDISPATCH(issue)
    : WORKSPACE_SETUP_ITER1(issue)

  return `You are a Wave Worker executing issue #${issue.id} in an isolated worktree.

${workspaceSetup}

## Task spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so the complete issue spec — title, body,
acceptance criteria, declared Files globs, risk — is embedded below rather than
pointed at by id. Implement it fully, satisfying every acceptance criterion, and
stay strictly within the declared Files globs.

${issue.issueSpec}

## Granted scope extension
${renderGrants(issue.scopeGrants)}
A grant above is PURPOSE-BOUND and ROW-SCOPED (ADR-0041) — it sanctions the
stated reason at the granted paths for this row's remaining rounds, never a
blanket pass for the file. Treat each granted path as in-scope ONLY for the
purpose stated beside it; a change at a granted path serving a DIFFERENT
reason is still an out-of-glob touch and still needs its own disclosure
(Policy clause 7 / wave-shared Convention 9 below) — a grant is a decision
about one forcing reason, not a standing exemption for the path.

## Policy clauses (obey verbatim)
1. AC-vs-repo-policy conflict: repo policy wins; flag under Judgment calls.
2. Commit policy: new commits only — never \`git commit --amend\` on a pushed commit.
3. PR-only: push your branch + open a PR; NEVER push to the protected default branch.
4. Conflict-marker check before committing:
   \`\`\`bash
   git diff --cached --name-only | xargs -I{} grep -l '^<<<<<<<\\|^>>>>>>>\\|^=======$' {} 2>/dev/null | head
   \`\`\`
5. SECRET-SAFE: never echo any environment variable's VALUE — not even with fallback syntax like \${VAR:-no}. Never run whole-environment dumps (\`printenv\`, \`env\`, bare \`set\`). Never read a gitignored settings/secret file (e.g. \`cat .claude/settings.local.json\`, any \`.env\`-class file) — not even "to check config". Check availability value-free only: \`[ -n "$GITHUB_TOKEN" ] && echo set\`. Tool output must never contain a secret. **AS A WORKTREE-ISOLATED ROLE, YOU DO NOT RUN THIS PRESENCE TEST AT ALL — sanctioned form or not.** The Coordinator's own value-free credential-probe preflight already proved every configured credential resolves, once, before you were dispatched — there is nothing left here for you to check. If a credential nonetheless fails to resolve mid-slice, the call that needed it (\`host-pr create\`, Termination step 3) returns a typed error; report that as \`blocked\`, never pre-empt it with a presence check of your own (wave-shared Convention 8's isolated-role rule — the same worktree-isolation guard policy clause 11 names has rejected this exact sanctioned form, live, when a worktree-isolated role ran it).
6. MENTION DISCIPLINE: the PR title and body must not contain ANY bare tracker id except the single close phrase (\`${issue.closePhrase}\`, Termination step 3 below) — reference ADR numbers or doc slugs instead.
7. WIRING DISCLOSURE (wave-shared Convention 9): if your slice introduces a new verb, subcommand, or exported interface, name the consuming call-site(s) that now invoke it in your report — or explicitly disclose under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`) that the wiring lies outside your declared Files globs, so the Coordinator can grant a scope extension or plan the wiring before the review round.
8. RUNTIME RESIDUE (wave-shared Convention 10): if your slice starts any runtime resource — a compose project, a container, a background server, anything holding a port, a volume, or a network — tear it down before termination, or explicitly disclose the surviving resource under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`) so the Coordinator can clean up after landing.
9. PROVE THE CHECK CAN FAIL (wave-shared Convention 11): if your slice introduces a NEW check — a test, an assertion, a guard, a smoke probe, a lint rule, a CI gate, a preflight, a validator — break the thing that check exists to catch, run the check, and observe its own FAIL state; then restore the original state and re-verify green. Report the falsification under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`): which check, what you broke, the observed failing output verbatim, and that you restored it. A green check is compatible with "the check works" AND "the check cannot fail", and no acceptance criterion distinguishes them. Two mechanical questions decide whether you are in this class — does a pass/fail check exist after your diff, and is its failing condition new with this slice — and "is the falsification worth the time" is deliberately NOT one of them: an expensive falsification belongs in the disclosure, not outside the class. A check observed only as \`deferred\`/\`skipped\` has NOT been proven to fail (it has been proven not to run) — that is a failed falsification attempt, not a demonstration. If you could not falsify it, say so in the same channel with the reason and what input WOULD falsify it — "could not falsify, and here is why" is a legitimate reported outcome; silence and an unevidenced claim are not. A slice that only changes behaviour already covered by EXISTING checks is not in this class.
10. UNEXECUTABLE CORE PATH — DECLARE, THEN SELF-COMPARE (ADR-0030): if the core path of your change **cannot be executed from this environment** — it needs a real release, a production credential, a merged PR, a human action, an external service you cannot reach — declare it explicitly under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`), naming WHICH path is unreachable and WHY. Then find the authoritative documented form for that mechanism — the vendor's own documentation, the spec, the reference example — **read it in this dispatch, do not recall it from memory** — compare your change against it, and report EVERY divergence in the same channel, each marked deliberate (you departed on purpose AND commented the reason at the point of departure) or not. A divergence is NOT automatically a defect: deliberate, commented departures are legitimate and must survive review intact. What is not legitimate is an undeclared one. Live occurrence: a release workflow shipped with three divergences from the registry vendor's documented example — a missing \`registry-url\`, dependency caching left on in a release build (which the vendor advises against on supply-chain grounds), and an outdated action version. Every acceptance criterion was verified and every one held; the core path (an OIDC credential exchange that cannot run before a real release exists) was reachable by no test, no local run and no reviewer, so the documented form was the only evidence available — and no acceptance criterion asked for it, because ACs describe what a change should DO and this is a question about what it should LOOK LIKE. Your self-comparison is defense-in-depth; the Reviewer runs its own comparison independently, and that one is the anchor.
11. ONE BASH CALL PER STEP (wave-shared Convention 13): never fuse a setup step onto the command that matters — \`cd X && <command>\` — into one compound Bash call. **Two unrelated mechanisms break on that shape, with opposite signatures, and knowing only one of them is how the other bites.** (a) **The permission gate.** The harness splits a command on \`&&\`, \`||\`, \`;\`, \`|\`, \`|&\`, \`&\` and newlines and requires EVERY subcommand to match a permission rule independently — so the tracked-allowlist entry covering your engine or verify call carries only THAT subcommand past the gate, never the \`cd\` glued in front of it; and \`cd\` paired with \`git\`, or with an output redirect, prompts even when both halves are read-only commands. A permission dialog mid-AFK-dispatch has nobody to answer it and stalls your row. (b) **The worktree-isolation guard.** A fused command can come back REJECTED as too complex to verify that it stays inside your worktree — no dialog, nothing pending, nothing run. That refusal is about the command's SHAPE, never about the check being unrunnable here: re-issue it as separate calls. **NEVER silently skip a step because its fused form was refused** — a Worker did exactly that, dropping the check it was running and continuing; a verification step that did not run, in a report that reads as complete, is the defect (same family as Convention 12's empty capture). And do not "fix" either mechanism by asking for a \`cd\` allowlist entry — splitting costs nothing, and mechanism (b) would reject the fused form regardless. **Carry the directory IN the command wherever a flag exists** (\`npm ci --prefix <dir>\`, \`git -C <dir> …\`, \`--root\`/\`--cwd\`): your cwd is reset to your dispatch root before every Bash call, so a \`cd\` issued as its own call does NOT reach the next one — splitting a fused \`cd X && <cmd>\` into two calls leaves the command running in the wrong directory, which is a quieter defect than the fusion was. Your workspace-setup \`pwd\` is the one cwd fact you have, it holds for every call, and you never buy anything back by re-fusing. **Mechanism (b) is not limited to \`&&\`, and most refusals are not fusion at all.** Three shapes have been live-reproduced as refused with nothing fused onto them: a bare \`case\`/\`esac\`; an \`if\`-guard testing a shell variable; and any other command naming a shell variable, including a lone \`test -n "$VAR"\` — whether that variable was set in an earlier Bash call or in the same one. **The discriminator is the \`$VAR\` expansion, not the punctuation**, so "split it" is not a general remedy and re-fusing is not either. Your cwd and every shell variable are reset between your Bash calls regardless, which is why a value must never be carried from one call to the next: re-query its source in the call that needs it (your own Termination step 4 below does exactly that, via \`host-pr status\`), or use a single command whose exit status is the answer. Before re-deriving a fix by hand, read the "Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch" section in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\` — entry 1's evidence arc records three remedies that looked right and could not run, so you do not re-adopt one of them.

## Verification gates (run the consumer's verify profile — from wave.config.json verify)
Run the commands the VerifyGate selects for your changed files; report exact counts.
**Carry the directory IN each command** — \`npm test --prefix <dir>\`, \`npx vitest run --root <dir>\`, \`git -C <dir> …\` — because every one of these calls starts at the dispatch root your workspace-setup \`pwd\` printed, never wherever a previous call ended up. A verify command written as \`cd <dir> && <cmd>\` is two faults at once: a fusion (policy clause 11, both mechanisms) AND a cwd-persistence assumption — and re-issuing it as \`cd <dir>\` then \`<cmd>\` in two calls fixes neither, because the second call starts back at the dispatch root and runs the gate in the wrong directory (live: a \`cd <worktree>/tools/wave\` returned success and the very next call's \`npm ci\` still ran at the worktree root). If the consumer's profile hands you a fused or \`cd\`-prefixed command, run its flag-carrying equivalent and say so in your report — but never drop a gate because its literal form was refused, and never report a count for a command that did not run.

## Termination
1. Commit all work in one commit.
2. \`git push origin ${issue.branch}\` (never \`-u\`, never to default).
3. Open the PR **through the engine — never \`gh pr create\`** (\`gh\`'s creds are sandbox-denied and its TLS fought the proxy in every live run; this verb uses the same \`fetch\` path the landing verbs do). Find-before-create is idempotent: a PR already open on this branch (e.g. a cap=1 re-dispatch onto the same branch) is **reused, never duplicated — and its title/body are re-written to the \`--title\`/\`--body\` you pass** (\`updated: true\` in the JSON discloses it), so the body you compose reliably lands on the live PR (last-writer-wins). Compose a PR body whose last line is the store-kind close phrase, then run:
   \`\`\`bash
   # WAVE_CLI carries this consumer's configured engine.cli binding, which the
   # config layer validated as repo-relative — so it resolves from this
   # worktree's own root: a worktree checkout is a full copy of tracked files,
   # and step 4 above (depsSetup) already installed whatever binary the binding
   # resolves through. That root is where THIS call starts too, because every
   # Bash call of yours starts there (workspace setup step 1) — not because an
   # earlier call left you in it. Do not prefix a cd; there is nothing to set up.
   ${WAVE_CLI} host-pr create \\
     --branch ${issue.branch} \\
     --title "${issue.prTitle}" \\
     --body "<one-paragraph summary of what you changed>

${issue.closePhrase}"
   # exit 0 → stdout is one JSON object; its .url (outcome: created | reused) is your prUrl.
   #
   # exit NON-ZERO → READ .outcome IN THAT SAME JSON BEFORE DOING ANYTHING ELSE.
   # This is not a case step 4 papers over — see "PR-open reuse-refusal" earlier
   # in this document.
   #   outcome create-failed → the create attempt itself failed; .fallbackPrefillUrl
   #     is the manual-open fallback. Report blocked.
   #   outcome reuse-refused → the close-phrase guard stopped a REWRITE: the body
   #     you just passed above is missing ${issue.closePhrase} (re-read it — the
   #     guard checks the body YOU pass, never the live one). .url still names
   #     the branch's existing PR, but the refusal made NO write at all — the PR
   #     is exactly as it was before this call, and that URL is not evidence
   #     anything landed. Never reach for --allow-close-phrase-loss to get past
   #     this: it deliberately discards the close phrase, the one outcome this
   #     guard exists to stop, and your composed body above is supposed to carry
   #     it already. Fix the body so it genuinely carries the close phrase and
   #     re-run create (idempotent, find-before-create); if it refuses again,
   #     report blocked with the printed .reason — never let step 4's re-query
   #     of that same URL read as success for a rewrite that never happened.
   \`\`\`
   The body MUST carry the close phrase \`${issue.closePhrase}\` on its own line (wave-shared Convention 4 — reads GITHUB_TOKEN from your env, never printed), and that is the **only** tracker id the title or body may name (mention discipline, policy clause 6): do not reference any other issue id anywhere.

   Run that command **bare** — no \`|\`, no \`$( )\`, no assignment. Its JSON lands in your tool output, where you can read it; you do not need it in a shell variable, and step 4 explains why you must not put it in one.
4. **Confirm the PR by asking the HOST, in a separate Bash call — never by carrying a value from step 3** (wave-shared Convention 12, half two). A finishing report with a missing or empty \`prUrl\` is the live failure this step exists to stop. **The confirmation is a re-query, not a guard on a capture**, because in your dispatch a guard on a capture cannot run at all:
   \`\`\`bash
   ${WAVE_CLI} host-pr status --branch ${issue.branch}
   # → { ok, verb, host, branch, state: open|merged|closed-unmerged|none, url?, prUrl? }
   \`\`\`
   Read the answer off that JSON:
   - \`state\` is \`open\` (or \`merged\`/\`closed-unmerged\`) **and** \`url\` is present → the PR exists and the host says so. **That \`url\` is your prUrl — carry it into your Report verbatim (see below).**
   - \`state\` is \`none\`, or no \`url\` came back → **no PR was created.** Step 3 did not do what it looked like it did. Re-run \`host-pr create\` (it is find-before-create, so re-running is safe and never duplicates) and re-query; if it still reports \`none\`, report \`blocked\` with what the two calls printed.

   **This step confirms the PR EXISTS — it is not, on its own, proof that step 3's rewrite landed as intended.** A \`reuse-refused\` outcome at step 3 makes NO write, so of course the PR is still there and this re-query still finds it — that is expected, not evidence of success. If step 3 returned a non-zero exit or \`outcome: reuse-refused\`, this step's \`state: open\`/\`url\`-present answer does not override that: carry step 3's own outcome forward (see its comment above), never let this step's mere confirmation that a PR exists stand in for "my rewrite succeeded."

   Never report \`done\`/\`done-with-concerns\` with a missing or empty \`prUrl\` — an honest \`blocked\` is a correct answer where a blank URL is not, and the engine's \`write-report\` gate emits a loud \`notice:\` on one that reaches the sidecar write anyway.

   **Why a re-query and not a capture guard — read this before you improvise a shorter form.** Three earlier versions of this step prescribed a capture plus a guard, and all three were unrunnable from a worktree-isolated dispatch. \`case\`/\`esac\` is refused standing alone. Splitting the capture into call 1 and the guard into call 2 fails twice over: shell state does not survive between your Bash calls, so the guard would inspect an unset variable — and the isolation check refuses that guard call outright for naming a variable it cannot resolve. Fusing them back into one call is refused too. The discriminator is not fusion and not the control structure: it is the **\`$VAR\` expansion**, refused in any position, in any call. The full station-by-station reproduction is Catalog entry 1 in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\`. \`host-pr status\` sidesteps every one of them by carrying nothing across a call boundary — the host is asked again, and answers again.

   If you need the URL on disk rather than in your tool output, redirect the re-query to a relative-path file in your worktree — it lands in your dispatch root, which is where the reading call starts too — and read it back with a **single command whose exit status is the verdict** — still no shell variable: \`${WAVE_CLI} host-pr status --branch ${issue.branch} > pr-status.json\` in one call, then \`jq -e -r '.url' pr-status.json\` in the next (it exits non-zero when \`.url\` is absent or null). Delete the file before you commit. \`jq\` carries its own tracked allow entry (\`Bash(jq -e -r '.url':*)\`, issue #345) — this fallback no longer risks an un-allowlisted mid-AFK permission prompt on the one command in this step that never had a citation; see setup-mechanics.md's AFK harness config scaffold for the entry and its rationale.

## Report — emit as your FINAL message, matching the WorkerReport schema:
outcome, issue, branch, worktree, commitShas, prUrl, filesChanged{new,modified,renamed},
tests, lint, conflictMarkers, judgmentCalls[], reviewerFocusItems[].

**\`issue\` MUST be the BARE opaque tracker id — exactly \`${issue.id}\`, and nothing else.**
Not \`#${issue.id}\`, not \`${issue.id} — <the issue title>\`, not a URL, not a branch name.
That field is the key your own durable record is filed and resolved under: a row id is
OPAQUE (ADR-0001), which means the reader never parses it — it matches it LITERALLY. A
decorated value is the one field on this report that can make your finished work
unfindable, and it fails in the quietest way available: the file exists, an \`ls\` shows
it, and a resume asking for row \`${issue.id}\` gets nothing back. Live occurrence: three
of six Workers in one wave decorated this field; two records landed under a name nothing
could resolve, and the third was not written at all.

**On \`done\`/\`done-with-concerns\`, \`prUrl\` MUST be the \`url\` Termination step 4's re-query
answered, verbatim.** Omitting it blinds the Reviewer's PR-body check and invites a
duplicate PR. The rule is enforced below this prose: \`write-report\` emits a loud
\`notice:\` when a finishing report reaches the sidecar write without a usable URL, and the
Coordinator reads it at routing.

## Reviewer-handoff hints (from Coordinator)
${j(issue.reviewerHints)}`
}

// reviewerBrief only ever reads `issue.anchorSha` / `issue.branch` off the same
// ISSUES row object assertRequiredRowFields already validated — including on a
// re-dispatch (cap=1 Worker re-run, or the bad-anchor Reviewer-only recovery
// below): there is no second code path that could re-derive or re-interpolate
// an unasserted anchor or branch.
function reviewerBrief(issue, report) {
  return `You are the Wave Reviewer for issue #${issue.id} (${issue.slug}).

## What to review
Branch: \`${issue.branch}\`
Risk class: \`${issue.risk}\`   (dispatch is universal — Risk does NOT gate whether you run)
Wave anchor SHA (diff base — NOT main): \`${issue.anchorSha}\`
Sibling in-flight branches: ${issue.siblingBranches}

## Resolve the branch — a stable named ref, never \`FETCH_HEAD\`

**\`FETCH_HEAD\` is a single ref shared by the whole checkout** — every \`git fetch\` overwrites it, including a concurrent sibling Reviewer's own fetch mid-dispatch. Live occurrence: a Reviewer diffing \`<anchor>..FETCH_HEAD\` briefly got another row's two-file diff — nothing failed loudly, the wrong tree was plausible, and a Reviewer who didn't happen to look twice would have verified it and reported it as verified. Fetch this row's branch into a stable named ref instead, keyed on the row id so a sibling's own fetch cannot collide with it, and confirm it before trusting it:

\`\`\`bash
git fetch origin ${issue.branch}:refs/review/${issue.id} 2>&1 | tail -3
\`\`\`
\`\`\`bash
git rev-parse refs/review/${issue.id}
\`\`\`
The printed SHA MUST equal the Worker-reported commit above (\`Commit SHAs: ${report.commitShas.join(', ')}\` — the LAST entry is the branch tip). **A mismatch is \`questions-blocking\`** — name both SHAs and stop; do not review a tree you have not confirmed. Every check below diffs against \`refs/review/${issue.id}\`, never a bare local branch name and never \`FETCH_HEAD\` — FETCH_HEAD is never read, here or anywhere else in this review. (ADR-0034 — the SHA assert is what turns this plausible, silent hazard into a loud stop; full mechanics: \`wave-reviewer/reference/reviewer-checks.md\` "The branch ref" section.)

## Workspace setup (do first)
Your own worktree also carries **tracked files only**. If this consumer's
dependency directory is gitignored, it is absent here too, and you cannot
re-run the verify commands below without installing first:
\`\`\`bash
${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
\`\`\`

**ONE BASH CALL PER STEP** (wave-shared Convention 13) — it binds you exactly as it binds the Worker, and this install is the first place it bites. Never fuse a setup step onto the command that matters (\`cd X && <command>\`) into one compound Bash call. Two unrelated mechanisms break on that shape, with opposite signatures: **the permission gate** splits a command on \`&&\`/\`||\`/\`;\`/\`|\`/\`&\`/newlines and requires EVERY subcommand to match a rule independently — so an allowlisted verify command carries only itself past the gate, never the \`cd\` in front of it, and a dialog mid-dispatch has nobody to answer it; and **the worktree-isolation guard** can REJECT a fused command as too complex to verify that it stays inside your worktree — no dialog, nothing run. A refusal is about the command's SHAPE, not about the check: re-issue it as separate calls. **NEVER drop a verify command or a floor check because its fused form was refused** — reporting a check as run when it was skipped is the exact failure this clause exists to stop, and it is yours to avoid as well as to catch in the Worker's evidence. Your cwd is reset to your dispatch root before every one of your Bash calls, so one \`pwd\` characterizes all of them and a preceding \`cd\` characterizes none: carry the directory in the command where a flag exists (\`npm ci --prefix <dir>\`, \`git -C <dir> …\`, \`--root\`/\`--cwd\`) rather than trusting a \`cd\` to reach the next call. **A bare newline joining two statements in one call is the same shape as \`&&\`, just quieter — and most refusals are not fusion at all:** \`case\`/\`esac\` has been observed refused standing entirely alone, and so has any command naming a **shell variable** — an \`if\`-guard on one, or a lone \`test -n "$VAR"\` — whether the variable was set in an earlier Bash call or in the same one. Shell state does not survive between your Bash calls either, so a value must be re-queried in the call that needs it rather than carried. Before re-deriving a split by hand, check the "Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch" section in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\` for what was actually verified — entry 1's evidence arc records three remedies that looked right and could not run. When reviewing a Worker's evidence for THIS convention, treat a Worker's own citation of that catalog as legitimate rather than a shortcut — including a Worker reporting it COULD NOT verify a working form for a cataloged shape (the catalog's own heredoc-spec-append entry is exactly that outcome, honestly reported rather than guessed). **And check what the Worker's PR evidence rests on:** its Termination step now confirms the PR with a \`host-pr status --branch\` re-query, so a report whose \`prUrl\` traces back to a shell-variable capture is following a recipe the brief no longer carries.

**SECRET-SAFE** (wave-shared Convention 8): never echo any environment variable's VALUE — not even with fallback syntax like \${VAR:-no}. Never run whole-environment dumps (\`printenv\`, \`env\`, bare \`set\`). Never read a gitignored settings/secret file (e.g. \`cat .claude/settings.local.json\`, any \`.env\`-class file) — not even "to check config". Tool output must never contain a secret. **YOU DO NOT PROBE, EITHER** (wave-shared Convention 8's isolated-role rule): you never check whether a credential is set — sanctioned presence-test form or not. The Coordinator's own value-free credential-probe preflight already proved every configured credential resolves, once, before this row was dispatched, so there is nothing left here for you to check. **This is a policy rule, not a guard-driven one — say so precisely, per the measured posture (wave-shared Convention 13's Catalog entry 1):** unlike the Worker, whose \`agent()\` call sets \`isolation: 'worktree'\` explicitly (Stage 1), your own \`agent()\` call carries no \`isolation\` key at all (Stage 3) — the worktree-isolation guard's command-complexity refusal is established from the Worker's dispatch, not from yours. That sanctioned form (\`[ -n "$VAR" ] && echo set\`) is exactly the command the guard has rejected outright, live, when a Worker ran it (policy clause 11 above) — but that refusal is not established for your own dispatch, so the reason you skip this check is the policy rule itself, never a guard you are relying on to reject the form here. Nothing in your own review touches a credential regardless: you never call \`host-pr\` and never read a secret.

## Original issue spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so you cannot look the issue up yourself
either — the full spec (title, body, acceptance criteria, declared Files
globs, risk) is embedded below; use it for the per-AC verification.

${issue.issueSpec}

## Granted scope extension
${renderGrants(issue.scopeGrants)}
Verify a change at a granted path AGAINST THE STATED REASON above — never flag
a granted path as a Files-glob overrun, and never re-derive whether the touch
was forced: that judgment was already made when the grant was recorded
(ADR-0041), and re-deriving it here is exactly the duplicated work this field
exists to remove. A change AT a granted path but serving a DIFFERENT purpose
than the stated reason is still reportable — the grant covers the reason, not
the path unconditionally. A change at a path with NO grant listed above is
reviewed exactly as before this row ever had one: an ordinary files-drift
check, Convention 9's wiring-disclosure duty included.

## Worker Report digest
Outcome: ${report.outcome}
Commit SHAs: ${report.commitShas.join(', ')}
PR URL: ${report.prUrl || '<pending>'}
Tests: ${report.tests}
Lint: ${report.lint}
Conflict markers: ${report.conflictMarkers || 'clean'}
Judgment calls:
${j(report.judgmentCalls)}
Reviewer focus items (Worker-appended):
${j(report.reviewerFocusItems)}

## Your checks
Run the wave-reviewer contract (see .claude/agents/wave-reviewer.md): re-run the verify
commands + the floor checks against \`${issue.anchorSha}..refs/review/${issue.id}\`
(the stable named ref resolved above — never \`${issue.branch}\` as a bare local branch
name, never \`FETCH_HEAD\`), per-AC met/partial/not-met with evidence (against the
embedded spec above), sibling merge-tree prediction.

**SIBLING MERGE-TREE PREDICTION REPORTS ITS COVERAGE DENOMINATOR.** The sibling list above is
the DENOMINATOR, and every branch on it gets exactly ONE outcome: \`predicted-clean\` |
\`predicted-conflict\` | \`not-on-origin\` | \`at-anchor\`. The rows run with NO barrier — row
B's Worker is still running while row A's Reviewer already runs — so a sibling may simply not
be on \`origin\` when you reach for it. Partial coverage is ordinary and honest; what is not
honest is a verdict that reports the conflicts it found and stays silent about the siblings it
never reached. **\`at-anchor\` is the sharp one:** a sibling branch that IS on \`origin\` but
whose tip still EQUALS this row's wave anchor SHA (\`${issue.anchorSha}\`) has an empty diff, so
\`git merge-tree\` exits 0 and prints one tree hash — byte-identical to a genuinely clean
prediction. Nothing in that output tells them apart. So per sibling, \`git fetch origin <branch>:refs/review/sib/<sibling-id>\`
then \`git rev-parse refs/review/sib/<sibling-id>\` — never \`FETCH_HEAD\`, the same shared-ref
hazard the branch-under-review resolution above already closed — and compare that tip against
\`${issue.anchorSha}\` BEFORE you read the merge-tree result: equal → record \`at-anchor\`, which
is VACUOUS and is never \`predicted-clean\`. Then put ONE coverage line in \`reviewerFocusItems\` naming the denominator
and every uncovered sibling by outcome — \`(advisory) Sibling merge-tree coverage: 3/5 predicted
— …; NOT covered: <d> not-on-origin, <e> at-anchor (tip == wave anchor, prediction vacuous).\`
\`0/N\` is a legitimate coverage line; silence is not. **All of it stays \`(advisory)\`** — a
predicted conflict is never \`changes-requested\`, and missing coverage is never
\`questions-blocking\`; the coverage line lives INSIDE the existing advisory strings, so
NOTHING here adds a field to the ReviewerVerdict schema. (Contract detail:
\`wave-reviewer/reference/reviewer-checks.md\` Check 5.)

**If this slice ships a NEW check** — a test, an assertion, a guard, a smoke probe, a
lint rule, a CI gate, a preflight, a validator — the Worker owed a falsification note
(wave-shared Convention 11): which check, what was broken, the observed failing output,
and confirmation that the original state was restored. It arrives in the Judgment calls /
Reviewer focus items above. Read it and check it against the diff. Two things it is not:
a note that reports only a green check has not falsified anything, and a check observed
only as \`deferred\`/\`skipped\` has been proven not to run, not proven able to fail.
An explicit "could not falsify, and here is why" is a legitimate Worker outcome — treat
it as a disclosure to carry forward, never as a defect to request changes over. Its
TOTAL absence on a slice that ships a new check is a finding: say so under
\`reviewerFocusItems\` rather than filling the gap silently yourself. And an AC phrased
as an outcome ("the check exists", "the guard is enforced") earns \`met\` only on
outcome-exercising evidence — the Worker's falsification, or your own probe.

**If this row's core path cannot be executed from your review environment**, the
DOCUMENTED-FORM COMPARISON is required (ADR-0030, agent contract Check 6). Three
raisers, any one of which fires it and none of which is a precondition: the ACs
covering that path landed \`deferred\`; an issue AC asked for the comparison; or the
Worker declared the unexecutable path above. Identify the authoritative documented
form for the mechanism (vendor documentation, spec), **read it yourself in this
dispatch**, compare the change on the branch against it, and report EVERY divergence
via the \`documentedFormComparison\` field — each marked \`deliberate\` (a commented
departure) or not. It is its own reported outcome: never fold it into
\`acVerification[]\`, and never flip the verdict on a divergence alone. \`sources\`
must name what YOU read — a comparison whose only source is the Worker's report is
invalid, and the schema rejects an empty \`sources\` at this boundary.

## Evidence discipline (mention footgun — wave-shared Convention 4)
Your \`acVerification[].evidence\` and \`reviewerFocusItems[]\` are folded verbatim into
the PR body at the terminator. On a tracker with a native GitHub integration, every bare
tracker id there is linkable and actable — a stray sibling id closes/links the wrong row.
**Reference ADR numbers or doc slugs (\`ADR-0024\`, \`2026-07-19-hardening-w6\`), never a
foreign tracker id, when you name related work.** The row's own id (\`${issue.id}\`, the
close target) is the one id that belongs there. The engine's render-side scrub neutralizes
any other id-shaped token as a structural backstop — treat that as a safety net, not a
license to reach for a bare id.

Return a JSON object matching the ReviewerVerdict schema:
verdict, branchReviewed, riskClass, workerReportDigest, acVerification[], reviewerFocusItems[]
— plus documentedFormComparison{trigger, sources[], divergences[]} whenever a trigger fired.`
}

// ── Scribe: persist ONE sidecar at agent-return through the paired write verb ──
// The brief carries the already-validated payload byte-exact (JSON.stringify) —
// nothing is re-typed. The Scribe writes it to a temp file VERBATIM, runs the
// engine verb (engine-computed <id>-<iter>.md name, fenced json, mkdir -p,
// last-writer-wins), retries once on a non-zero exit, and returns { ok, path }.
function scribeBrief(kind, issue, iter, payload) {
  const dir = kind === 'report' ? REPORTS_DIR : VERDICTS_DIR
  const verb = kind === 'report' ? 'write-report' : 'write-verdict'
  // The producing agent's OWN pipeline label — Stage 1 (`worker:<id>`) for a
  // report, Stage 3 (`review:<id>`) for a verdict — always the stage
  // immediately before this Scribe's own in the SAME pipeline() fan-out
  // (§Dispatch loop, below). Script-knowable at compose+dispatch time from the
  // same `issue` this brief already carries; nothing new is asked of the
  // Coordinator. Feeds the provenance clause immediately below.
  const producer = kind === 'report' ? `worker:${issue.id}` : `review:${issue.id}`
  // The wave slug, read back off the already-filled sidecar dir rather than
  // asked for as a fresh compose-time constant — REPORTS_DIR/VERDICTS_DIR are
  // always `<REPO_ROOT>/.flotilla/waves/<slug>/reports|verdicts` (§Scribe
  // compose-time constants, above), so the path segment second from the end is
  // the slug regardless of which of the two dirs this call filled `dir` from.
  const waveSlug = dir.split('/').slice(-2, -1)[0]
  return `You are a Wave Scribe. Persist one ${kind} sidecar THROUGH THE ENGINE — do not reformat, re-type, or "fix" anything in the payload.

**Provenance, stated once so a transcript reading only this brief can see it.** This
\`${kind}\` payload was produced by \`${producer}\` — the same workflow run, one stage
earlier, journal-recorded — not by you. You did not produce this payload and are not
endorsing it: wave \`${waveSlug}\`, row \`${issue.id}\`, iteration \`${iter}\` are the
compose-time facts that place it; the workflow run's own id is not one of them, because
nothing in this script can read it. **The filing-clerk framing.** The review is not the
Scribe's — it was never asked of you, and nothing here asks for one now. Altering the
payload — reformatting it, re-typing it, or "fixing" anything in it, in either direction —
is the only act this brief forbids. If this payload carries a verdict and that verdict
reads \`approve\`, persisting it through \`${verb}\` below is not approval by the writer:
whatever approval happened, happened one stage earlier, at \`${producer}\`; this write
makes that record durable, it does not make it yours.

**\`--id\` IS NOT YOURS TO VARY.** It is fixed below as \`${issue.id}\` — the compose-time
row id, straight off the wave spine — and it alone decides which row this sidecar is filed
under. If the verb refuses, the refusal IS the answer: report it and let the Coordinator's
routing-time recovery handle it. Do NOT re-run with a different \`--id\` — not the payload's
own id field, not a decorated form, not anything you derived. A varied \`--id\` does not
rescue the write; it files a real, well-formed record under a name the reader can never
resolve for row \`${issue.id}\` — present to an \`ls\`, absent to a resume, silent both ways.
That substitution, made once as a reasonable-looking workaround after a refusal, is the
whole reason this clause exists. (The engine now refuses a decorated \`--id\` outright with
exit 2, so the workaround fails loudly instead of half-working — do not go hunting for a
spelling that gets past it. A decorated id in the PAYLOAD is a different matter: the verb
normalizes that one itself and tells you it did.)

1. **Read your working directory — one bare \`pwd\`, as its own Bash call, and never a \`cd\`.**
   Expected output, exactly: \`${REPO_ROOT}\` (the compose-time absolute repo root).
   Your cwd is **reset to your dispatch root before every Bash call you make**, so it is a
   constant you OBSERVE, not state you can SET: this one \`pwd\` characterizes step 3 as
   surely as it characterizes this step, and nothing you run here can change what step 3
   starts in. That is also why the retired form of this step — \`cd "${REPO_ROOT}"\` as
   call 1, the engine call as call 3 — is a DEAD END and must not be re-added: it never
   reached step 3 (it only ever looked like it did, because the dispatch root already was
   the repo root), and fusing it onto step 3 so that it would reach is refused twice over
   (wave-shared Convention 13, both mechanisms — the standing rule for every dispatched
   role). The permission gate splits a command on \`&&\`/\`||\`/\`;\`/\`|\`/\`&\`/newlines and
   requires EVERY subcommand to match a rule independently — the tracked
   \`.claude/settings.json\` allowlist covers the WAVE_CLI invocation exactly, but that
   entry covers only THAT subcommand and never a \`cd\` fused in front of it, so the fused
   form can raise a permission dialog mid-AFK-dispatch with nobody there to answer it
   (same class as the \`env -u ... gh\` wrapper footgun that defeats a \`gh *\` allowlist
   prefix, wave-shared Convention 1's KW-F6 sandbox-footgun note — now observed on our
   own allowlist); and the worktree-isolation guard can REJECT a fused command outright as
   too complex to verify, with no dialog and nothing run.
   **If \`pwd\` prints anything else:** do NOT \`cd\`, do NOT vary the command, and do NOT
   skip the write — every path argument in step 3 is absolute, so the only cwd-sensitive
   part left is the WAVE_CLI binding itself. Run step 3 anyway and report the mismatch
   verbatim: in \`notice\` (prefixed \`cwd-mismatch:\`) if the verb still exits 0, in
   \`error\` if it does not. A repo-relative binding fails loud there and writes nothing;
   a path-free one may quietly succeed against a DIFFERENT engine copy than this repo's,
   and your \`notice\` is then the only trace it happened. Either way the fix is the
   Coordinator's precondition — dispatch the wave from the repo root — never a workaround
   of yours.
2. Write the payload below — the single line that follows this paragraph — EXACTLY,
   byte-for-byte (no edits), to this ABSOLUTE path, spelled here shell-quoted exactly
   as step 3 spells it:
   \`"${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json"\`
   ABSOLUTE because the verb reads that argument against the process cwd, so a bare
   relative name would put back into step 3 exactly the dependency step 1 exists to
   retire. QUOTED because an absolute repo root is precisely where spaces and non-ASCII
   characters live — this repo's own checkout path carries both a space and a
   typographic en-dash — and an unquoted path argument breaks on one; every shell
   position this path reaches therefore keeps its quotes, the payload file no less than
   the sidecar \`--dir\`. Prefer your file-writing TOOL over a shell heredoc: it takes
   the path directly — WITHOUT those quotes, which are the shell spelling and not part
   of the filename — creates the parent directory, and involves no shell at all, which
   also sidesteps the heredoc-to-file-with-braces shape Convention 13's Catalog records
   as refused (and every JSON payload carries braces by construction). If you do use a
   heredoc, its redirect target is that same path, quoted —
   \`cat > "${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json" <<'EOF'\` — and
   the directory must already exist, from an equally quoted
   \`mkdir -p "${REPO_ROOT}/.flotilla/tmp"\` in its own prior call. The name is
   deterministic, so a retry overwrites rather than accumulates.

   **The heredoc alternative is measured, not merely asserted.** The
   three write shapes on record for an echo-guard false positive on this exact
   write path — a quoted heredoc (the fallback form above), an inline node-eval
   string literal, and a tee-fed heredoc — were re-run against the CURRENT
   \`tools/wave/hooks/echo-guard.cjs\` with a guarded-pattern payload (a sidecar
   whose own evidence text quotes the guard's dump-word examples — \`$(printenv)\`,
   \`\`printenv\`\` — as prose, mirroring the live #347 trigger). All three passed
   unmodified: the guard's quote-nesting fix and its quoted-heredoc-body
   inertness fix (both documented in Convention 8) together clear every one of
   them for this payload class, and each write also verified byte-exact once
   allowed through. The pre-settled decision rule for this measurement (if any
   shape still blocked, the payload write would become unconditionally
   file-first for the guarded-pattern class, with the heredoc alternative
   removed) therefore does not fire — the prefer-file-first text above stays
   exactly as written, and this paragraph is where the measurement is recorded,
   per that rule. A negative control (the identical payload through an
   UNQUOTED heredoc delimiter, where the guard's quoted-body inertness fix does
   NOT apply) was blocked as expected, confirming the harness can observe a
   block and the all-pass result above is not an artifact of a check that
   cannot fail.
${JSON.stringify(payload)}
3. As a SEPARATE Bash call — its text starting EXACTLY with the WAVE_CLI form,
   so it matches the allowlist prefix from token one — run:
   ${WAVE_CLI} ${verb} "${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json" --dir "${dir}" --id ${issue.id} --iter ${iter}
   (exit 0 → the absolute written path is printed on stdout; exit 1 → invalid payload, or a payload naming a DIFFERENT row than --id; exit 2 → usage/unreadable, or a --id that is not a bare id)
   Every path in that command is absolute and shell-quoted; nothing in it depends on a
   previous call having moved you anywhere.
4. If the exit code is non-zero, retry the SAME command ONCE, BYTE-IDENTICAL — same --id, same --dir, same --iter. If it fails again, report the failure; never vary an argument to buy a zero.
Return { ok: <true iff the verb exited 0>, path: <the absolute path it printed, or ''>, error: <stderr, only on failure — and the step-1 cwd mismatch too, if there was one>, notice: <on an EXIT-0 run only: any \`notice:\` or \`warning:\` line the verb printed, verbatim, plus a \`cwd-mismatch:\` line if step 1 found one — a normalized decoration, a misnamed leftover in the sidecar dir, or a write made from the wrong cwd is a finding the Coordinator's routing step must not lose, and an exit-0 run is exactly where it would otherwise be dropped> }.`
}

// The stage wrapper ALWAYS returns `passthrough` — a throw here would drop the
// row to null (→ a spurious worker-failed STOP that discards finished work). A
// Scribe failure is logged loud; the Coordinator's routing-time existence check
// (SKILL.md step 7) writes any missing sidecar through the same verb.
async function scribe(kind, issue, iter, payload, passthrough) {
  try {
    const r = await agent(scribeBrief(kind, issue, iter, payload), {
      label: `scribe-${kind}:${issue.id}`, phase: 'Dispatch',
      model: 'haiku', effort: 'low', schema: SCRIBE_RESULT_SCHEMA,
    })
    if (!r.ok) log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${r.error || 'unknown'}`)
    else if (r.notice) log(`SIDECAR-WRITE NOTICE ${kind} ${issue.id}: ${r.notice}`)
  } catch (e) {
    log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${e.message}`)
  }
  return passthrough
}

// ── Dispatch loop (worker → scribe(report) → reviewer → scribe(verdict)) ──
phase('Dispatch')
const results = await pipeline(
  ISSUES,
  // Stage 1 — Worker: worktree-isolated, schema-validated WorkerReport
  (issue) => agent(workerBrief(issue), {
    label: `worker:${issue.id}`, phase: 'Dispatch',
    isolation: 'worktree', schema: WORKER_REPORT_SCHEMA,
    model: issue.model,
  }),
  // Stage 2 — Scribe(report): durable BEFORE the review even starts. Passes the
  // report through unchanged so the Reviewer stage still receives it.
  (report, issue) => scribe('report', issue, issue.iteration, report, report),
  // Stage 3 — Reviewer: universal dispatch, schema-validated ReviewerVerdict.
  // Risk routes the Reviewer's model tier: standard for mechanical/isolated-
  // refactor, heavy otherwise; scope, checklist, and universal dispatch stay
  // unchanged — this binds WHICH model, never WHETHER or WHAT the Reviewer
  // reviews, and decouples the Reviewer's cost from whichever model happens
  // to coordinate the session (ADR-0007 Amendment 2026-07-31).
  //
  // CURRENCY CHECK for a re-extracted/reused copy of this script: this call
  // must carry `model: issue.model` verbatim, mirroring the Worker's Stage-1
  // binding above. A Stage-3 `agent()` call with no `model` key at all is the
  // tell for a copy that predates this binding — it silently re-inherits the
  // Coordinator's own session model for every Reviewer, mechanical rows
  // included, which was a first-order driver of the 2026-07-30 cost
  // measurement this amendment answers.
  (report, issue) => agent(reviewerBrief(issue, report), {
    label: `review:${issue.id}`, phase: 'Review',
    agentType: REVIEWER_AGENT, schema: REVIEWER_VERDICT_SCHEMA,
    model: issue.model,
  }).then((verdict) => ({ report, verdict })),
  // Stage 4 — Scribe(verdict): persist the verdict, then build the routing tuple.
  (rv, issue) => scribe('verdict', issue, issue.iteration, rv.verdict,
    { id: issue.id, risk: issue.risk, iteration: issue.iteration, report: rv.report, verdict: rv.verdict }),
)
return results.filter(Boolean)
