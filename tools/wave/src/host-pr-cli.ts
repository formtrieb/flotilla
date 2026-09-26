/**
 * host-pr-cli.ts — the `host-pr create | arm | merge | status | preflight` verb
 * group (ADR-0019 PR-open + ADR-0023 landing + amendment).
 *
 * The whole host boundary, exposed as ONE narrow CLI surface. Why a CLI verb at
 * all: a Workflow driver cannot import the engine, and `gh` left the host path
 * entirely (sandbox-denied creds + TLS failing under the sandbox, live-proven
 * in runs 1 and 3, mechanism unmeasured beyond that — ADR-0015) — so the
 * permission classifier gets one auditable verb instead of a broad
 * `gh pr create` / `gh pr merge` bash rule. `create` is the staged
 * second half of ADR-0023 ("every host write goes through the engine host
 * seam"): it retires the Worker terminator's last `gh pr create`.
 *
 * This runner is a THIN router, in the house style — it holds no host logic:
 *
 *   detect-host  → routes by host. `github` and `bitbucket` are the two shipped
 *                  implementations; `unknown` fails LOUD and typed for EVERY
 *                  verb. Routing is the ROUTER's decision, never the caller's:
 *                  an injected adapter is honoured only for a host that HAS one,
 *                  so it can never smuggle an unrecognised remote onto a
 *                  host path.
 *   create       → `createOrReusePr` (host-pr.ts owns the whole
 *                  find-before-create decision, in ONE function this runner and
 *                  the `route-tuple` terminator both call): an existing open PR for the
 *                  branch is REUSED — and its title/body are RE-WRITTEN to the
 *                  passed values via `updateOpenPr` (PATCH), so the terminator's
 *                  composed render lands on a Worker-opened PR (`updated:true`
 *                  discloses it) — a missing one is created. Idempotent about
 *                  CREATION only — a cap=1 re-dispatch onto the same branch never
 *                  opens a second PR — and emphatically NOT read-only about
 *                  CONTENT: running it twice with different arguments changes the
 *                  live PR twice. Callers who only want to know whether a branch
 *                  has a PR belong on the read-only `status` verb. The one rewrite
 *                  `create` refuses (exit 1, `outcome: "reuse-refused"`) is one
 *                  that would drop the close phrase the live body carries;
 *                  `--allow-close-phrase-loss` is the deliberate override. This
 *                  is the ADR-0019 cross-host Basic-auth seam (`HttpProbe` +
 *                  `Creds`), NOT the ADR-0023 `LandingHost` seam.
 *                  The body arrives EITHER inline (`--body`) OR from a file
 *                  (`--body-file <path>`) — exactly one, never both, never
 *                  neither. The file form exists because the inline one cannot
 *                  carry a real PR body from every caller: a worktree-isolated
 *                  Worker's `host-pr create` has been REFUSED in the field by an
 *                  agent harness's worktree-isolation guard when `--body` was a
 *                  long multi-paragraph string with blank lines, while the same
 *                  shape from the Coordinator's own un-isolated checkout went
 *                  through unrefused — a failure invisible from the place the
 *                  Worker brief is authored. That guard is harness-side, and its
 *                  predicate is neither documented nor stable across harness
 *                  versions: measured from one worktree-isolated flotilla
 *                  dispatch, it did NOT fire on the refused shape, at ~900 bytes
 *                  or at several kilobytes. That is an argument FOR the file
 *                  form, not against it — a caller cannot tell from inside
 *                  whether its own call will be refused, so the fix has to be
 *                  structural rather than a rule about how to phrase a body.
 *                  `--body-file` takes the body off
 *                  the command line entirely, so it is a structural fix whatever
 *                  that guard's predicate turns out to be, and it also retires
 *                  the shell-quoting hazard and the command-length advisory a
 *                  multi-KB quoted argument carries. The file is read VERBATIM —
 *                  blank lines, indentation and any trailing newline preserved —
 *                  because the close-phrase guard needs the phrase to own its
 *                  own line, and everything downstream (the guard, the reuse
 *                  rewrite, the printed JSON) sees a string that is
 *                  byte-identical to the same content passed inline.
 *   arm          → `armPullRequest` (host-pr.ts owns the arm intent). `--delete-branch`
 *                  (consumer KW-F6, threaded onto arm's own merge call-sites, #140)
 *                  deletes the head branch when the arm decision resolves to an
 *                  IMMEDIATE merge (a `clean` PR, or a refused-arm controlled
 *                  degrade) — best-effort, reported on `branchDeletion`, never an
 *                  arm failure. When the decision instead ARMS (auto-merge
 *                  enabled, the host completes the merge later, out of process)
 *                  there is no synchronous merge to delete after — nothing is
 *                  deleted at this call, and the `armed` outcome's `reason` says
 *                  so explicitly rather than staying silent about it.
 *   merge        → `mergePullRequestNow`. `--delete-branch` (consumer KW-F6)
 *                  deletes the PR's remote head branch after a successful merge
 *                  through `LandingHost.deleteBranch`; a failed delete is a
 *                  structural `branchDeletion` degradation, never a merge
 *                  failure. `arm` accepts the same flag independently — see above.
 *   arm | merge  `--commit-message pr|host` (ADR-0053, default `pr`, built like
 *                  `--method`): `pr` lands the PR's own title (plus the host's
 *                  number suffix) and body, read when the verb runs and frozen
 *                  at arming; `host` sends neither, so the repository's own
 *                  merge setting composes the commit. The verbs stay store-blind
 *                  — the flag, never a config read, carries the choice; the
 *                  skills compose it from `landing.commitMessage`. Both verbs
 *                  echo `commitMessage` and report `landingMessage` (the title
 *                  handed over and the body's UTF-8 byte count). Two exceptions
 *                  under `pr`, named in the help rather than detected: a merge
 *                  queue composes its own commit and ignores the message, and
 *                  `--method rebase` replays the commits, so there is no single
 *                  message to shape ({@link PR_MESSAGE_EXCEPTIONS}).
 *   arm | merge  `--expect-head <sha>` (ADR-0055, a full commit SHA): the PR
 *                  lands only at that head, else `refused` with both commits
 *                  named. Threaded to `ArmOptions`/`MergeOptions.expectHead`;
 *                  GitHub pins it natively, and on every host the verb first
 *                  compares its own status read ({@link EXPECT_HEAD_NOTE}).
 *   status       → `LandingHost.getPrStatus`
 *   preflight    → `preflightHost` (host-pr.ts owns the posture grading): reports
 *                  the three code-host checks (pr-merge-token, allow-auto-merge,
 *                  required-checks), plus ONE create-verb check fourth, because
 *                  `host-pr create` has a precondition the landing verbs do not
 *                  share on BOTH shipped hosts — `create-credentials` on Bitbucket
 *                  Cloud (create needs BITBUCKET_EMAIL, the landing verbs do not)
 *                  and `pr-create-token` on GitHub (create needs the Pull requests
 *                  grant, which `pr-merge-token`'s repository-role read does not
 *                  cover on a fine-grained token). Store-BLIND (no
 *                  `--config`, no `--branch`) — identical on every store kind,
 *                  because landing is always on the code host (ADR-0023 amendment /
 *                  W10-F1). Builds the posture reader from the resolved host
 *                  credential, like arm/merge/status, reads the ambient half
 *                  from `deps.env`, and probes the GitHub create right with the
 *                  `create` verb's own credential over `deps.http`.
 *
 * Exit codes:
 *   0 — the op succeeded (`create`: the PR was created or an open one reused;
 *       `arm`/`merge`: merged, armed, or already-merged; `status`: the probe
 *       answered — read `state` for the answer, which may legitimately be `none`;
 *       `preflight`: every check passed / advisory / unknown — read `checks`).
 *   1 — the op did not land the row (`create`: the PR-create failed —
 *       `outcome: "create-failed"` with a `fallbackPrefillUrl` — or the reuse was
 *       refused by the close-phrase guard — `outcome: "reuse-refused"` with a
 *       `reason`; `arm`/`merge`: `no-pr`, `refused`; `preflight`: a check `fail`ed
 *       — read `checks`), the host has no adapter
 *       (`code: "adapter-not-implemented"`), or the host errored.
 *   2 — usage error.
 *
 * stdout is ALWAYS a single JSON object carrying `ok` + the outcome, so the
 * caller can branch on either the exit code or the payload.
 *
 * PR url/number field names are ALIGNED across every verb (FOR-54): a PR URL is
 * carried under BOTH `url` and `prUrl`, and a PR number under BOTH `number` and
 * `prNumber`, so a single field name resolves on `create | status | arm | merge`
 * alike. The alignment is additive — no historical name was renamed — so the
 * live consumers keep reading what they always did (the Worker terminator reads
 * `create.url`; wave-close reads `status`/`arm` url+number). `create` still
 * carries no PR number (a deliberate omission: find-before-create only
 * round-trips the URL). See {@link alignedPrRef}, the single owner of the shape.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  detectHost,
  armPullRequest,
  mergePullRequestNow,
  createOrReusePr,
  preflightHost,
  alignedPrRef,
  LandingNotImplementedError,
  DEFAULT_MERGE_METHOD,
  DEFAULT_COMMIT_MESSAGE_SOURCE,
  type CommitMessageSource,
  type Host,
  type HostInfo,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type Creds,
  type HttpProbe,
} from './host-pr';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import {
  createBitbucketApiFromEnv,
  bitbucketCreateCreds,
  BITBUCKET_TOKEN_VAR,
  BITBUCKET_EMAIL_VAR,
} from './adapters/bitbucket/bitbucket-api';
import { resolveCredential } from './credential-resolver';
import { flag, printJson } from './cli-utils';
import {
  defineVerb,
  hasFlag,
  helpRequested,
  printVerbHelp,
  refuseUndeclared,
  type VerbContract,
} from './verb-contract';

const VERBS = ['create', 'arm', 'merge', 'status', 'preflight'] as const;
type Verb = (typeof VERBS)[number];

/**
 * The hosts with a shipped adapter. Everything else — today only `unknown` —
 * gets the typed {@link LandingNotImplementedError} exit on EVERY verb. Named
 * once so the router, the `create` credential edge, and the injected-adapter
 * gate below cannot drift apart on which hosts are supported.
 */
const IMPLEMENTED_HOSTS: Host[] = ['github', 'bitbucket'];

/**
 * Impure inputs for the `create` and `preflight` verbs, injectable for tests. In
 * production all default: the network seam is host-pr's `defaultHttpProbe`
 * (global `fetch`, the same path arm/merge/status use), the token is read from
 * `process.env`, and the posture reader is a `GitHubApi` built from the env.
 */
export interface HostPrDeps {
  /**
   * `create` + `preflight`: injectable network seam (tests). Defaults inside
   * `findOpenPr`/`createPr`.
   *
   * `preflight` uses it for the GitHub `pr-create-token` check, which PROBES the
   * create right with two read-only requests rather than inferring it — so a
   * spec that injects a posture reader and no probe leaves that check `unknown`
   * and issues no request, and a spec that wants to grade it injects a fixture
   * probe here.
   */
  http?: HttpProbe;
  /**
   * `create` + `preflight`: the environment the host credential is RESOLVED
   * from (ADR-0029) — `<VAR>_CMD` (a lookup command) or the ambient `<VAR>`
   * (`GITHUB_TOKEN` / `BITBUCKET_TOKEN`). Defaults to `process.env`.
   *
   * `preflight` reads it for a SECOND, non-secret purpose: it is the environment
   * `preflightHost`'s `create-credentials` check grades `BITBUCKET_EMAIL` in.
   * One injectable seam for both, so that check is drivable from a spec without
   * any spec ever touching the real process environment.
   */
  env?: NodeJS.ProcessEnv;
  /** `preflight`: a posture reader to probe (tests). Production builds a `GitHubApi` from the env. */
  posture?: LandingPosture;
}

const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];

/**
 * How `--method`'s value is spelled in the three landing verbs' own sections —
 * the merge-method vocabulary itself, off {@link MERGE_METHODS}, never a second
 * copy of it. The roster prints the value TYPE (`<value>`) instead, the way it
 * does for every enum flag in the engine.
 */
const METHOD_PLACEHOLDER = `<${MERGE_METHODS.join('|')}>`;

/**
 * `--commit-message`'s vocabulary (ADR-0053) — who composes the landed commit:
 * `pr` (flotilla, from the PR's own title and body) or `host` (the repository's
 * own merge setting). Built exactly like {@link MERGE_METHODS}: one list, read
 * by the validator and by the placeholder, never spelled twice.
 */
const COMMIT_MESSAGE_SOURCES: CommitMessageSource[] = ['pr', 'host'];

/** How `--commit-message`'s value is spelled in the two landing verbs' own sections. */
const COMMIT_MESSAGE_PLACEHOLDER = `<${COMMIT_MESSAGE_SOURCES.join('|')}>`;

/**
 * The two exceptions to "under `pr` the PR's title and body land" (ADR-0053,
 * dated note 2026-09-25) — one wording, printed wherever this module's help
 * states what lands, each caller indenting it to its own column.
 *
 * Wording only: nothing detects a merge queue or reads the method back. The
 * two facts are the host's own: GitHub's GraphQL schema notes on
 * `EnablePullRequestAutoMergeInput` that "when merging with a merge queue any
 * input value for commit headline is ignored" (and the same for the body and
 * the method), and `REBASE` adds the commits "individually", so no single
 * commit exists for a title and body to shape.
 */
const PR_MESSAGE_EXCEPTIONS = [
  "Two exceptions under 'pr': a merge queue composes its own commit and ignores the message, and",
  '--method rebase replays the commits, so there is no single message to shape.',
] as const;

/**
 * `--expect-head`'s value (ADR-0055): a FULL commit SHA — 40 hex digits
 * (SHA-1) or 64 (SHA-256). An abbreviation is refused at the flag, because
 * GitHub's pins (`sha`, `expectedHeadOid: GitObjectID`) take a full object id
 * and the skills read one (`git rev-parse refs/review/<id>`). The comparison
 * on the other side still tolerates a HOST that reports an abbreviated head
 * (`headsMatch`, host-pr.ts).
 */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The two lines both landing verbs print about `--expect-head` (ADR-0055) —
 * one copy, because the rule is the same on both. The second line is the
 * stated check-then-act window the decision record requires: on a host without
 * a native pin the verb's own status read is the whole check.
 */
const EXPECT_HEAD_NOTE = [
  "  --expect-head <sha> refuses unless the PR's head is that full commit SHA (ADR-0055); the reason names both.",
  '  GitHub pins it itself (merge sha, expectedHeadOid); elsewhere this verb compares its own status read — a check-then-act window.',
] as const;

/**
 * The FULL multi-verb usage dump — every verb's usage line, its prose, and the
 * shared credential-resolution + flag-default footer. Reserved for when the
 * caller hasn't named a verb we recognize yet (no verb at all, or an unknown
 * one): with no verb to narrow by, the whole contract is the only thing that
 * teaches. See {@link VERB_CONTRACT} for the per-verb alternative (issue #505)
 * — the `host-pr arm --pr` misfire this replaces answered a ONE-FLAG mistake
 * with this entire ~60-line dump; correct lesson, oversized price.
 */
function fullUsageLines(): string[] {
  return [
    // The per-verb signatures below are each verb's OWN contract line (issue
    // #758), not a second shortened copy of it. The copy they replace said
    // "deliberately NO --config" and listed none — while every verb of this
    // group declares `--config` and the parser accepts it (store-blind, so the
    // value is read by nothing). A usage text that DENIES a flag its parser
    // takes is the omission class at its loudest, and it is not expressible
    // from here any more.
    `usage: host-pr <${VERBS.join('|')}>`,
    ...VERBS.flatMap((v) => [
      `         ${HOST_PR_CONTRACTS[v].usage[0].replace(/^usage: /, '')}`,
      ...(v === 'create'
        ? ['                 (a WRITE: the PR body carries the store-kind close phrase, and a reuse rewrites both fields)']
        : []),
    ]),
    '',
    '  create    Open the PR for --branch (find-before-create): an existing OPEN PR on the branch is reused',
    '            (never duplicated) and a missing one is created. Requires --title, plus EXACTLY ONE of',
    '            --body <body> and --body-file <path> — both, or neither, is a usage error naming both flags.',
    '            --body-file reads the body from that file VERBATIM (blank lines, indentation and any trailing',
    '            newline preserved) and is otherwise indistinguishable from passing the same bytes inline.',
    '            Reach for it whenever the body is more than one paragraph. A multi-paragraph --body has been',
    '            refused in the field by an agent harness\'s worktree-isolation guard (not by every such guard —',
    '            which is the trouble: the caller cannot tell from inside whether theirs will), and a multi-KB',
    '            quoted argument is a shell-quoting and command-length hazard wherever it runs. A file has',
    '            neither problem, because the body never reaches the command line at all.',
    '            NOT a read-only probe. "Idempotent" describes CREATION only: reuse RE-WRITES the live PR\'s',
    '            title AND body to the --title/--body you pass (last-writer-wins), so running this twice with',
    '            different arguments changes the PR twice. To ask whether a branch already has a PR without',
    '            touching it, use the read-only `status` verb instead.',
    '            A reuse that would drop the close phrase the live body carries — replacing it with a body',
    '            that has none — is REFUSED (exit 1, outcome reuse-refused, with a reason) rather than',
    '            silently merging a PR that closes nothing; --allow-close-phrase-loss overrides it.',
    '            Output: a single JSON object on stdout.',
    '  arm       Land the PR by deciding per-PR from its live merge state: pending checks → enable auto-merge;',
    '            already clean → direct merge. Idempotent. With --delete-branch, deletes the head branch',
    '            on the decision paths that merge IMMEDIATELY (clean, or a refused-arm controlled degrade)',
    '            — best-effort, reported in `branchDeletion`, never an arm failure. When the decision instead',
    '            ARMS (auto-merge enabled, the host merges later out of process), nothing is deleted at this',
    '            call — the deferral is recorded explicitly in the armed outcome\'s `reason`.',
    '            The landed commit carries the PR\'s own title (plus the host\'s number suffix) and body, read',
    '            when this runs — except under a merge queue or --method rebase (see --commit-message below).',
    '            Arming FREEZES them at the host, so an edit to the PR after arming lands only if arm runs',
    '            again — which refreshes the frozen message. `landingMessage` reports what was handed over:',
    '            the title, and the body\'s length in bytes.',
    '            Output: a single JSON object on stdout.',
    '  merge     Merge the PR now, no arm intent (the caller has already decided). Idempotent.',
    '            With --delete-branch, deletes the PR head branch after a successful merge (branch hygiene,',
    '            consumer KW-F6) — best-effort: a failed delete is reported in `branchDeletion`, never a merge',
    '            failure. `arm` accepts the same flag with its own (partially deferred) semantics — see above.',
    '            Lands with the PR\'s own title (plus the host\'s number suffix) and body, read when this runs —',
    '            except under a merge queue or --method rebase (see --commit-message below).',
    '            Output: a single JSON object on stdout.',
    '  status    Report the PR for a branch: open | merged | closed-unmerged | none (+ url). Read-only.',
    '            Also prints the PR\'s live `title` and `body` when the host surfaces them — read off the same',
    '            response the state comes from, no extra host call. Both keys are ABSENT on state none and',
    '            whenever the host does not surface them, and never an empty string. This is how a role that',
    '            may not write reads what a PR says (the close phrase included), instead of `gh pr view`.',
    '            Output: a single JSON object on stdout.',
    '  preflight Report the code-host landing posture: pr-merge-token, allow-auto-merge, required-checks.',
    '            Each host adds one CREATE-verb check fourth, because `host-pr create` has a precondition the',
    '            landing verbs do not share and a wave calls create on every row. Both are ADVISORY — neither',
    '            ever changes the exit code, so read `checks`, not `$?`, for them.',
    '            On bitbucket: create-credentials, stating whether BITBUCKET_EMAIL is set (create refuses',
    '            without it; the landing verbs authenticate with Bearer and do not).',
    '            On github: pr-create-token, which PROBES the create right with two read-only requests (the',
    '            identity read, then the open-PR list) using create\'s own credential. pr-merge-token does not',
    '            cover it — that check reads the repository role, and a fine-grained token can hold the role',
    '            while being scoped away from Pull requests entirely.',
    '            Store-blind (no --branch; --config is accepted and ignored) — identical on every store kind.',
    '            Output: a single JSON object on stdout.',
    '',
    '  --remote defaults to `git remote get-url origin`.',
    `  --method defaults to '${DEFAULT_MERGE_METHOD}' (arm | merge only).`,
    `  --commit-message defaults to '${DEFAULT_COMMIT_MESSAGE_SOURCE}' (arm | merge only): the landed commit carries the PR's own`,
    "    title and body. 'host' sends neither, so the repository's own merge setting composes the message —",
    '    for a consumer whose history is machine-read (ADR-0053).',
    ...PR_MESSAGE_EXCEPTIONS.map((line) => `    ${line}`),
    '  --expect-head <sha> (arm | merge only, ADR-0055): the PR lands only while its head is that full commit SHA;',
    '    otherwise the outcome is refused, and the reason names both commits. GitHub pins it itself (the merge\'s',
    '    sha, expectedHeadOid when arming). On a host without such a pin the verb compares the head in its own status',
    '    read first — a check-then-act window: a push between that read and the merge request is not seen.',
    '  --allow-close-phrase-loss (create only) permits a reuse rewrite that drops the live PR body\'s close',
    '    phrase. Deliberate overwrites only — the terminator never needs it (a composed render carries one).',
    '  --body-file <path> (create only) is the alternative to --body: the file\'s bytes become the PR body,',
    '    unchanged. The close phrase must still own its own line INSIDE the file.',
    '  Every verb resolves its host credential through the engine credential seam:',
    '    <VAR>_CMD (a lookup command, run via the shell, 60s budget) wins over the ambient <VAR>.',
    '    A configured command that fails is a loud typed error naming the command — never its output,',
    '    never a fallback to the ambient variable. The secret itself is never printed.',
    '    github    → GITHUB_TOKEN / GITHUB_TOKEN_CMD.',
    '    bitbucket → BITBUCKET_TOKEN / BITBUCKET_TOKEN_CMD, plus BITBUCKET_EMAIL (the Atlassian account',
    '                email, not a secret) as the Basic-auth username. Without BITBUCKET_EMAIL the landing',
    '                verbs fall back to Bearer auth (a repository/workspace access token) and `create`,',
    '                which can only speak Basic, refuses loudly. App passwords no longer work at all.',
  ];
}

/**
 * Every verb's OWN contract section (issue #505) — printed INSTEAD OF
 * {@link fullUsageLines} once the verb is known, so a wrong or missing flag on
 * (say) `arm` teaches only `arm`'s own shape. Each ends with an explicit
 * output-format line: every verb's stdout is a single JSON object (the module
 * docblock's own guarantee), stated here per verb so a caller never has to go
 * looking for that guarantee.
 */
/**
 * The flags every host-pr verb accepts, whatever it is. `--remote` overrides the
 * `git remote get-url origin` default and is read on every path.
 */
const HOST_PR_COMMON_FLAGS = [
  { canonical: '--remote', value: 'one', valueType: 'url' },
  // Accepted and DISCARDED — the FOR-87/W25-F2 uniform-wrapper tolerance, the
  // same precedent `credential-probe` and `worktree-cleanup` already carry. This
  // verb group is store-BLIND (it probes the code host, never a tracker) and
  // reads no wave config, but a Coordinator wrapper appends `--config <path>` to
  // every engine invocation uniformly, and `wave-close --auto` runs the same
  // command on a github, linear or markdown wave. Declaring it is what keeps
  // ADR-0051's refusal from turning that tolerance into an exit 2; nothing here
  // reads the value.
  { canonical: '--config', value: 'one', valueType: 'path' },
] as const satisfies readonly VerbContract['flags'][number][];

// ─── What each verb's single JSON object IS (issue #913) ─────────────────────
//
// `output: 'json'` on all five said the stdout was JSON and stopped there. Each
// shape below was read off this module's own `printJson` call sites — never off
// a TypeScript return type, because every one of them is an object literal with
// conditional spreads over a discriminated union, so the keys a run carries and
// the keys an interface declares are different lists.
//
// Two facts hold across all five and are therefore stated once, here, rather
// than five times in five clauses:
//
//   - **`ok`, `verb` and `host` open every answer**, success and failure alike;
//     a failure adds `error` and (on the not-implemented path) `code`. The
//     failure envelope is `{ ok: false, verb, host, branch?, error }`, and the
//     per-verb clauses below state the SUCCESS shape.
//   - **The PR reference is doubled**, by `alignedPrRef` (FOR-54): a known url
//     prints as BOTH `url` and `prUrl`, a known number as BOTH `number` and
//     `prNumber`, and an unknown one prints neither key. That is why the
//     clauses say `url+prUrl?` rather than naming one spelling.

/** The PR-reference pair every landing verb carries when the host knows it. */
const HOST_PR_REF_SHAPE = 'url+prUrl?, number+prNumber?';

/**
 * The `arm` / `merge` success shape — the {@link LandingOutcome} union spread
 * flat onto the envelope, so `outcome` is the discriminant and the keys after
 * it follow from it.
 */
const HOST_PR_LANDING_SHAPE =
  `{ ok, verb, host, branch, method, commitMessage, outcome, reason, ${HOST_PR_REF_SHAPE}, ` +
  'sha?, branchDeletion?: { branch, deleted, error? }, landingMessage?: { title, bodyBytes } }';

/**
 * The continuation line both landing verbs print about `landingMessage`
 * (ADR-0053) — one copy, because the rule is the same on both. "Frozen" and
 * "landed" carry the same two exceptions as {@link PR_MESSAGE_EXCEPTIONS}: the
 * report says what was HANDED OVER, which under a merge queue or a rebase
 * landing is not what lands. Still two lines — `arm`'s own section sits under
 * a line ceiling (host-pr-cli.spec.ts, the `--pr` misfire test).
 */
const LANDING_MESSAGE_SHAPE_NOTE = [
  '         `landingMessage` is what a landing write handed the host (title; body as UTF-8 bytes): frozen on `armed`,',
  "         landed on `merged` — not under a merge queue or --method rebase; absent under 'host' or with no PR title (the reason says so).",
];

/**
 * Every host-pr verb's Verb contract (ADR-0051 decision 2), EXTENDING the
 * per-verb usage table this file already carried (issue #505) rather than
 * duplicating it: the `usage` array of each entry below IS that table's former
 * value, byte for byte. What is new is everything around it — the flags with
 * their canonical spellings and value kinds, the positional arity (none: every
 * host-pr verb is all-flags), and the output class (JSON on every verb, which
 * was already this module's own stated guarantee).
 *
 * This is the shape ADR-0051 decision 2 points at when it says the contract
 * "lives in the verb's own `*-cli` module — the shape `host-pr`'s
 * `VERB_CONTRACT` and `issue-store`'s op table already have".
 */
export const HOST_PR_CONTRACTS: Readonly<Record<Verb, VerbContract>> = {
  create: defineVerb({
    verb: 'host-pr create',
    flags: [
      { canonical: '--branch', value: 'one', valueType: 'branch', required: true },
      { canonical: '--title', value: 'one', valueType: 'text', required: true, placeholder: '<title>' },
      { canonical: '--body', value: 'one', valueType: 'text', placeholder: '<body>' },
      { canonical: '--body-file', value: 'one', valueType: 'path' },
      { canonical: '--base', value: 'one', valueType: 'branch' },
      { canonical: '--allow-close-phrase-loss', value: 'none', valueType: 'none' },
      ...HOST_PR_COMMON_FLAGS,
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    // The one relationship this group has, and the one the flag list could not
    // state: the body comes from EXACTLY ONE of the two, and a call with both
    // or neither is a usage error naming both flags. Declared, it renders as
    // the alternation it is instead of as two independent optionals.
    groups: [{ kind: 'exactly-one', branches: [['--body'], ['--body-file']] }],
    notes: [
      '  Opens the PR for --branch (find-before-create): an existing OPEN PR is REUSED — and its title AND body',
      '  are RE-WRITTEN to the values you pass (last-writer-wins) — so this is NOT a read-only probe; use `status`',
      '  for that. A reuse that would drop the live body\'s close phrase is REFUSED (exit 1, reuse-refused) unless',
      '  --allow-close-phrase-loss is passed.',
      '  The body comes from EXACTLY ONE of --body (inline) and --body-file (a path, read verbatim). Prefer the',
      '  file whenever the body runs to more than one paragraph — a worktree-isolated caller\'s multi-paragraph',
      '  --body has been refused in the field by an agent harness\'s isolation guard (not by every such guard), and',
      '  a long quoted argument is a quoting hazard everywhere. The close phrase must own its own line in the file.',
    ],
    outputNote: 'a single JSON object on stdout',
    json: {
      shape: `{ ok, verb, host, branch, outcome, updated?, ${HOST_PR_REF_SHAPE} }`,
      trail: 'outcome is created | reused | create-failed | reuse-refused',
      continuation: [
        '         `updated` rides only on a REUSE, and says whether the live title/body were re-written.',
        '         The two failing outcomes exit 1 and add `error`; create-failed adds `fallbackPrefillUrl`,',
        '         reuse-refused adds `reason` and re-states `updated: false` — it wrote NOTHING.',
        '         This verb never carries a PR number, even on a reuse where it knows one.',
      ],
    },
  }),
  arm: defineVerb({
    verb: 'host-pr arm',
    flags: [
      { canonical: '--branch', value: 'one', valueType: 'branch', required: true },
      { canonical: '--method', value: 'one', valueType: 'enum', placeholder: METHOD_PLACEHOLDER },
      { canonical: '--commit-message', value: 'one', valueType: 'enum', placeholder: COMMIT_MESSAGE_PLACEHOLDER },
      { canonical: '--delete-branch', value: 'none', valueType: 'none' },
      { canonical: '--expect-head', value: 'one', valueType: 'sha', placeholder: '<sha>' },
      ...HOST_PR_COMMON_FLAGS,
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  Lands the PR by deciding per-PR from its live merge state: pending checks → enable auto-merge; already clean → direct',
      '  merge. Idempotent. --delete-branch deletes the head branch only on the paths that merge IMMEDIATELY.',
      `  --commit-message '${DEFAULT_COMMIT_MESSAGE_SOURCE}' (default) lands the PR's own title (+ number suffix) and body, FROZEN at arming —`,
      "  arm again after editing the PR to refresh them; 'host' sends neither: the repository's setting composes it.",
      ...PR_MESSAGE_EXCEPTIONS.map((line) => `  ${line}`),
      ...EXPECT_HEAD_NOTE,
    ],
    outputNote: 'a single JSON object on stdout',
    json: {
      shape: HOST_PR_LANDING_SHAPE,
      trail: 'outcome is merged | armed | already-merged | refused | no-pr',
      continuation: [
        '         `sha` rides only on `merged`; `branchDeletion` only where --delete-branch was passed AND the',
        '         path merged immediately. A `no-pr` outcome carries no PR reference at all. ok is true for',
        '         merged | armed | already-merged, false otherwise — and the exit code mirrors it.',
        ...LANDING_MESSAGE_SHAPE_NOTE,
      ],
    },
  }),
  merge: defineVerb({
    verb: 'host-pr merge',
    flags: [
      { canonical: '--branch', value: 'one', valueType: 'branch', required: true },
      { canonical: '--method', value: 'one', valueType: 'enum', placeholder: METHOD_PLACEHOLDER },
      { canonical: '--commit-message', value: 'one', valueType: 'enum', placeholder: COMMIT_MESSAGE_PLACEHOLDER },
      { canonical: '--delete-branch', value: 'none', valueType: 'none' },
      { canonical: '--expect-head', value: 'one', valueType: 'sha', placeholder: '<sha>' },
      ...HOST_PR_COMMON_FLAGS,
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  Merges the PR now, no arm intent (the caller has already decided). Idempotent. --delete-branch deletes',
      '  the PR head branch after a successful merge (best-effort).',
      `  --commit-message '${DEFAULT_COMMIT_MESSAGE_SOURCE}' (default) lands the PR's own title (+ number suffix) and body, read now;`,
      "  'host' sends neither: the repository's setting composes it (ADR-0053).",
      ...PR_MESSAGE_EXCEPTIONS.map((line) => `  ${line}`),
      ...EXPECT_HEAD_NOTE,
    ],
    outputNote: 'a single JSON object on stdout',
    json: {
      shape: HOST_PR_LANDING_SHAPE,
      trail: 'the same shape `arm` prints — `armed` is the one outcome this verb never returns',
      continuation: [...LANDING_MESSAGE_SHAPE_NOTE],
    },
  }),
  status: defineVerb({
    verb: 'host-pr status',
    flags: [
      { canonical: '--branch', value: 'one', valueType: 'branch', required: true },
      // Accepted and validated (never silently downgraded) though `status`
      // merges nothing: the router reads `--method` on all three landing verbs
      // from one branch, and refusing it here would break a caller that appends
      // it uniformly.
      { canonical: '--method', value: 'one', valueType: 'enum', placeholder: METHOD_PLACEHOLDER },
      ...HOST_PR_COMMON_FLAGS,
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  --method is accepted and validated here though `status` merges nothing: the router reads it on all',
      '  three landing verbs from one branch. --config is accepted and IGNORED on every host-pr verb (this',
      '  group is store-blind); a Coordinator wrapper appends it to every engine invocation uniformly.',
      '  Reports the PR for a branch: open | merged | closed-unmerged | none (+ url). Read-only — never writes.',
      '  Also reports the PR\'s live `title` and `body` off that same response (no extra host call): absent on',
      '  state none and wherever the host does not surface them, and never an empty string.',
    ],
    outputNote: 'a single JSON object on stdout',
    json: {
      shape:
        `{ ok, verb, host, branch, state, ${HOST_PR_REF_SHAPE}, ` +
        'mergeability?, headSha?, baseRef?, title?, body? }',
      trail: 'state is open | merged | closed-unmerged | none',
      continuation: [
        '         Every key after `state` is present only where the host surfaced it — `state: none` carries',
        '         none of them. `title`/`body` are two-valued: an empty description is an ABSENT key, never `""`.',
        '         `state: none` is an ANSWER and exits 0; the caller reads `state`, not the exit code.',
      ],
    },
  }),
  preflight: defineVerb({
    verb: 'host-pr preflight',
    flags: [...HOST_PR_COMMON_FLAGS],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  Takes no --branch — it is a repo-level probe.',
      '  Reports the code-host landing posture: pr-merge-token, allow-auto-merge, required-checks, plus one',
      '  CREATE-verb check fourth — create-credentials on bitbucket, pr-create-token on github. Both are',
      '  advisory and never change the exit code. pr-create-token probes the create right with two read-only',
      '  requests: pr-merge-token grades the repository role, which a fine-grained token can hold while being',
      '  scoped away from Pull requests. Store-blind — identical on every store kind.',
    ],
    outputNote: 'a single JSON object on stdout',
    json: {
      shape: '{ ok, verb, host, checks: [ { name, status, detail } ] }',
      trail: 'no branch key — this is a repo-level probe',
      continuation: [
        '         `ok` is true iff no check is `fail`, and the exit code mirrors it. The two advisory checks',
        '         (create-credentials, pr-create-token) never grade `fail`, so read `checks` and not `$?` for them.',
      ],
    },
  }),
};

/**
 * The UNION of every host-pr verb's flags — used only to ask "was this flag
 * present at all?" while deciding the CROSS-VERB refusals below
 * (`--delete-branch` on `status`, `--body-file` on `arm`, …).
 *
 * Those refusals run BEFORE the generic undeclared-token refusal on purpose: a
 * flag this verb group knows, on a verb that has no use for it, deserves the
 * sentence that says WHICH verbs own it — `unknown flag --delete-branch — did
 * you mean --branch?` would be a worse answer, not a better one. The generic
 * refusal then catches everything the group does not know at all.
 */
const HOST_PR_ANY_CONTRACT: VerbContract = {
  verb: 'host-pr',
  flags: [
    { canonical: '--branch', value: 'one', valueType: 'branch' },
    { canonical: '--title', value: 'one', valueType: 'text' },
    { canonical: '--body', value: 'one', valueType: 'text' },
    { canonical: '--body-file', value: 'one', valueType: 'path' },
    { canonical: '--base', value: 'one', valueType: 'branch' },
    { canonical: '--allow-close-phrase-loss', value: 'none', valueType: 'none' },
    { canonical: '--method', value: 'one', valueType: 'enum' },
    { canonical: '--commit-message', value: 'one', valueType: 'enum' },
    { canonical: '--delete-branch', value: 'none', valueType: 'none' },
    { canonical: '--expect-head', value: 'one', valueType: 'sha' },
    ...HOST_PR_COMMON_FLAGS,
  ],
  positionals: { kind: 'fixed', count: 0 },
  output: 'json',
  usage: fullUsageLines(),
};

/**
 * Render a usage error. With a KNOWN `verb`, prints ONLY that verb's own
 * contract section ({@link HOST_PR_CONTRACTS}) — never the full multi-verb dump
 * (issue #505: the `arm --pr` flag-typo misfire that answered a one-flag
 * mistake with the entire ~60-line usage). Without a known verb (none given,
 * or an unrecognized one) {@link fullUsageLines} is what teaches — the caller
 * hasn't told us which contract they meant yet.
 */
function usage(message: string, verb?: Verb): number {
  const contract = verb !== undefined ? HOST_PR_CONTRACTS[verb].usage : undefined;
  process.stderr.write(
    [`error: ${message}`, ...(contract ?? fullUsageLines()), ''].join('\n'),
  );
  return 2;
}

/**
 * The unknown-verb usage error (issue #650) — the first misgrip a stranger's
 * Coordinator makes (a plausible spelling: `land` for `arm`, `open` for
 * `create`). Keeps {@link fullUsageLines}'s full multi-verb dump byte-for-byte
 * (issue #505's teaching value for a caller who has named no verb we
 * recognise survives unchanged) and ADDS, sourced from
 * {@link HOST_PR_CONTRACTS} — the exact table {@link VERBS}/the switch above
 * are typed against — one line per verb naming its own usage
 * (`HOST_PR_CONTRACTS[verb].usage[0]`), so this list cannot drift from what the
 * router actually dispatches.
 */
function usageUnknownVerb(verb: string): number {
  process.stderr.write(
    [
      `error: unknown verb "${verb}" — expected one of: ${VERBS.join(', ')}`,
      ...fullUsageLines(),
      '',
      'verbs:',
      ...VERBS.map((v) => `  ${HOST_PR_CONTRACTS[v].usage[0]}`),
      '',
    ].join('\n'),
  );
  return 2;
}

/**
 * Run the `host-pr` CLI (FOR-26 / FOR-28 / ADR-0019 + ADR-0023).
 *
 * @param args - CLI args; `args[0]` is the verb.
 * @param injected - a {@link LandingHost} to drive the landing verbs
 *   (`arm`/`merge`/`status`) in tests. It is used ONLY once the detected host
 *   has a shipped adapter ({@link IMPLEMENTED_HOSTS}): routing is the ROUTER's
 *   decision, never the caller's, so an injected adapter can never smuggle an
 *   unrecognised remote onto a host path. When absent, the host's own adapter is
 *   built from the env (impure — the credential resolver + a construction-time
 *   preflight). The `create` and `preflight` verbs do not use this seam
 *   (`create` is on the ADR-0019 `HttpProbe`/`Creds` boundary; `preflight` reads
 *   the posture via `deps.posture`).
 * @param deps - impure inputs for `create` (network seam + env) and `preflight`
 *   (posture reader + env); tests inject them, production defaults to real
 *   `fetch`, `process.env`, and a `GitHubApi` built from the env.
 * @returns the process exit code (see the module docblock).
 */
export async function runHostPr(
  args: string[],
  injected?: LandingHost,
  deps: HostPrDeps = {},
): Promise<number> {
  // ── Usage is decided FIRST — before any routing, host build, or network. ──
  const verb = args[0] as Verb | undefined;
  if (verb === undefined) return usage('a verb is required');
  // `host-pr --help` — no verb named yet, so the answer is the whole multi-verb
  // contract, on stdout, exit 0 (ADR-0051 decision 7). Before any routing, any
  // credential resolve and any network call, as every usage decision here is.
  if ((verb as string) === '--help') {
    process.stdout.write([...fullUsageLines(), ''].join('\n'));
    return 0;
  }
  if (!VERBS.includes(verb)) {
    return usageUnknownVerb(verb);
  }

  // `--help` is answered here, BEFORE any branch check, credential resolve or
  // host build (ADR-0051 decision 7): a help request must never reach the
  // network. The verb is already known, so the answer is that verb's own
  // contract section rather than the full multi-verb dump.
  const contract = HOST_PR_CONTRACTS[verb];
  if (helpRequested(contract, args.slice(1))) return printVerbHelp(contract);

  // `--allow-close-phrase-loss` is create's deliberate-overwrite override: it
  // permits the ONE reuse rewrite the guard refuses (dropping the close phrase
  // the live PR body carries). Rejected on every other verb rather than silently
  // ignored — the same discipline `--delete-branch` gets below, and for the same
  // reason: a flag that looks accepted but does nothing is a footgun.
  const allowClosePhraseLoss = hasFlag(HOST_PR_ANY_CONTRACT, args, 'allow-close-phrase-loss');
  if (allowClosePhraseLoss && verb !== 'create') {
    return usage(
      `--allow-close-phrase-loss is only supported by 'create' (it governs the reuse rewrite); '${verb}' never rewrites a PR body`,
      verb,
    );
  }

  // `--body-file` is create's file form of `--body`. Rejected on every other
  // verb rather than silently ignored — the same discipline
  // `--allow-close-phrase-loss` and `--delete-branch` get, for the same reason:
  // a flag that looks accepted but does nothing is a footgun, and this one
  // would look like it had supplied a body to a verb that composes none.
  const bodyFileGiven = hasFlag(HOST_PR_ANY_CONTRACT, args, 'body-file');
  if (bodyFileGiven && verb !== 'create') {
    return usage(
      `--body-file is only supported by 'create' (it supplies the PR body); '${verb}' composes no PR body`,
      verb,
    );
  }

  // `--delete-branch` is a branch-hygiene flag (consumer KW-F6): on a
  // successful `merge` it deletes the PR's remote head branch through the host
  // API. `arm` accepts it too (issue #140, wiring the engine's own
  // `ArmOptions.deleteBranch`, landed in #132): threaded through only on the
  // decision paths that resolve to an IMMEDIATE merge (a `clean` PR, or a
  // refused-arm controlled degrade) — `armPullRequest` itself defers the
  // deletion (and says so in `reason`) when the decision instead ARMS and
  // hands the merge to the host. Reject it on any other verb rather than
  // silently ignore it (the arm-delete footgun).
  const deleteBranch = hasFlag(HOST_PR_ANY_CONTRACT, args, 'delete-branch');
  if (deleteBranch && verb !== 'merge' && verb !== 'arm') {
    return usage(
      `--delete-branch is only supported by 'arm' and 'merge' (branch-hygiene steps); '${verb}' does not delete branches`,
      verb,
    );
  }

  // `--commit-message` (ADR-0053) chooses who composes the LANDED commit, so it
  // belongs to the two verbs that land — the same cross-verb refusal
  // `--delete-branch` gets, for the same reason. Unlike `--method`, `status`
  // does not accept-and-ignore it: `--method` is tolerated there because the
  // router has always read it on all three landing verbs from one branch,
  // while this flag is new and only the arm/merge call sites compose it.
  if (hasFlag(HOST_PR_ANY_CONTRACT, args, 'commit-message') && verb !== 'merge' && verb !== 'arm') {
    return usage(
      `--commit-message is only supported by 'arm' and 'merge' (it chooses who composes the landed commit); '${verb}' lands nothing`,
      verb,
    );
  }

  // `--expect-head` (ADR-0055) pins WHICH commit lands, so it belongs to the
  // two verbs that land — the same cross-verb refusal `--commit-message` gets.
  if (hasFlag(HOST_PR_ANY_CONTRACT, args, 'expect-head') && verb !== 'merge' && verb !== 'arm') {
    return usage(
      `--expect-head is only supported by 'arm' and 'merge' (it pins the commit that lands); '${verb}' lands nothing`,
      verb,
    );
  }

  // The ONE refusal path (ADR-0051 decision 4), run AFTER the cross-verb
  // refusals above (each of which teaches which verbs own the flag) and BEFORE
  // any required-flag read, host build, credential resolve or network call:
  // anything this verb's contract does not declare — an unknown flag, a stray
  // positional — exits 2 with this verb's own usage and never the group roster.
  const refusal = refuseUndeclared(contract, args.slice(1));
  if (refusal !== 0) return refusal;

  // `preflight` is a REPO-level probe — it takes no --branch (it reads required
  // checks against the DEFAULT branch). Every other verb needs one.
  const branch = flag(args, contract, 'branch');
  if (verb !== 'preflight' && (branch === undefined || branch.length === 0)) {
    return usage('--branch <branch> is required', verb);
  }

  // `create`'s own required flags are decided here, before any host build or
  // network — same "usage first" discipline. That includes READING the
  // `--body-file`: an unreadable path is a usage error, decided before any
  // routing, credential resolve or request. `--method` is landing-only and is
  // neither read nor validated for `create` or `preflight`.
  let title: string | undefined;
  let body: string | undefined;
  let base = 'main';
  if (verb === 'create') {
    title = flag(args, contract, 'title');
    if (title === undefined || title.length === 0) {
      return usage('--title <title> is required for create', verb);
    }

    // The body arrives by exactly ONE of the two routes. Presence is decided on
    // the FLAG TOKEN, not on its value, so `--body ""` is an empty body (the
    // refusal below) rather than "no --body at all" (a different refusal that
    // would teach the wrong fix). Both-at-once and neither-at-all are the two
    // ways a caller can be ambiguous about which route they meant, and both
    // errors name BOTH flags — a message naming only the one they omitted
    // cannot teach a caller who passed the other one twice over.
    const bodyInlineGiven = hasFlag(contract, args, 'body');
    if (bodyInlineGiven && bodyFileGiven) {
      return usage(
        'pass exactly ONE of --body <body> and --body-file <path> for create — both were given',
        verb,
      );
    }
    if (!bodyInlineGiven && !bodyFileGiven) {
      return usage(
        'exactly ONE of --body <body> and --body-file <path> is required for create (the body carries the store-kind close phrase)',
        verb,
      );
    }

    if (bodyFileGiven) {
      const bodyFile = flag(args, contract, 'body-file');
      if (bodyFile === undefined || bodyFile.length === 0) {
        return usage(
          '--body-file <path> needs a path (the file whose bytes become the PR body)',
          verb,
        );
      }
      try {
        // VERBATIM — no trim, no normalisation. The close-phrase guard is
        // line-anchored, so trimming a trailing newline would be a silent
        // rewrite of the one property the guard reads; and the equivalence this
        // flag promises ("the same content, either way, byte-identical
        // downstream") only holds if nothing here touches the bytes.
        body = readFileSync(bodyFile, 'utf-8');
      } catch (err) {
        // Missing, a directory, unreadable — one message, and it names the
        // PATH, because the path is the thing the caller can fix.
        return usage(
          `could not read --body-file "${bodyFile}": ${(err as Error).message}`,
          verb,
        );
      }
      if (body.length === 0) {
        // Same rule as an empty `--body`, stated against the file so the caller
        // knows WHICH empty thing to fix.
        return usage(
          `--body-file "${bodyFile}" is empty — the PR body carries the store-kind close phrase`,
          verb,
        );
      }
    } else {
      body = flag(args, contract, 'body');
      if (body === undefined || body.length === 0) {
        // The body carries the store-kind close phrase (Convention 4); an empty
        // one would open a PR that closes nothing. Refuse, do not default.
        return usage(
          '--body <body> is required for create (it carries the store-kind close phrase)',
          verb,
        );
      }
    }
    base = flag(args, contract, 'base') ?? 'main';
  }

  let method: MergeMethod = DEFAULT_MERGE_METHOD;
  if (verb === 'arm' || verb === 'merge' || verb === 'status') {
    const rawMethod = flag(args, contract, 'method');
    if (rawMethod !== undefined && !MERGE_METHODS.includes(rawMethod as MergeMethod)) {
      // Never silently downgrade to the default: a caller who asked for a merge
      // method flotilla does not know must be told, not quietly squash-merged.
      return usage(
        `invalid --method "${rawMethod}" — expected one of: ${MERGE_METHODS.join(', ')}`,
        verb,
      );
    }
    method = (rawMethod as MergeMethod) ?? DEFAULT_MERGE_METHOD;
  }

  // `--commit-message` is validated exactly as `--method` is, and for the same
  // reason: a value flotilla does not know is a usage error (exit 2), never a
  // silent fall-back to the default — a caller who asked for `hsot` must not
  // quietly get the PR-authored message it was trying to opt out of.
  let commitMessage: CommitMessageSource = DEFAULT_COMMIT_MESSAGE_SOURCE;
  if (verb === 'arm' || verb === 'merge') {
    const rawCommitMessage = flag(args, contract, 'commit-message');
    if (
      rawCommitMessage !== undefined &&
      !COMMIT_MESSAGE_SOURCES.includes(rawCommitMessage as CommitMessageSource)
    ) {
      return usage(
        `invalid --commit-message "${rawCommitMessage}" — expected one of: ${COMMIT_MESSAGE_SOURCES.join(', ')}`,
        verb,
      );
    }
    commitMessage = (rawCommitMessage as CommitMessageSource) ?? DEFAULT_COMMIT_MESSAGE_SOURCE;
  }

  // `--expect-head` (ADR-0055) is validated before any host build, like the
  // two flags above: a value that is not a full commit SHA is a usage error
  // (exit 2), never a pin quietly dropped or quietly compared as a prefix.
  let expectHead: string | undefined;
  if (verb === 'arm' || verb === 'merge') {
    expectHead = flag(args, contract, 'expect-head');
    if (expectHead !== undefined && !FULL_SHA_RE.test(expectHead)) {
      return usage(
        `invalid --expect-head "${expectHead}" — expected a full commit SHA (40 or 64 hex digits), e.g. the output of \`git rev-parse refs/review/<id>\``,
        verb,
      );
    }
  }

  let remoteUrl: string;
  try {
    remoteUrl = flag(args, contract, 'remote') ?? gitRemoteUrl();
  } catch (err) {
    return usage(
      `could not read the git remote (pass --remote <url>): ${(err as Error).message}`,
      verb,
    );
  }

  // ── Route by host. github + bitbucket ship adapters; others fail loud+typed. ──
  const info = detectHost(remoteUrl);
  if (!IMPLEMENTED_HOSTS.includes(info.host)) {
    return notImplemented(verb, info.host, branch);
  }

  // ── preflight: the ADR-0023-amendment posture probe (LandingPosture seam). ──
  // NB: the `injected` LandingHost is the LANDING seam (arm/merge/status); the
  // posture reader is a different capability set, injected via `deps.posture`.
  if (verb === 'preflight') {
    return runPreflight(info, remoteUrl, deps);
  }

  // ── create: the ADR-0019 find-before-create seam (HttpProbe/Creds). ──
  if (verb === 'create') {
    return runCreate(
      info,
      branch as string,
      title as string,
      body as string,
      base,
      allowClosePhraseLoss,
      deps,
    );
  }

  // ── arm | merge | status: build the LandingHost adapter + run the verb. ──
  try {
    const host: LandingHost = injected ?? (await landingHostFor(info, remoteUrl, deps));
    return await dispatch(verb, host, branch as string, method, info.host, deleteBranch, commitMessage, expectHead);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb,
      host: info.host,
      branch,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

/**
 * Build the host's own {@link LandingHost} adapter. One switch, so `arm`,
 * `merge`, `status` — and, since the routing terminator landed, `route-tuple`'s
 * own status re-query — cannot each grow their own idea of which adapter a host
 * gets. Both factories resolve their credential through the ADR-0029 seam and
 * run a construction-time preflight, so a bad credential fails HERE rather than
 * mid-landing.
 *
 * Exported for that fourth caller alone: `route-tuple` asks the host the same
 * "what is the PR for this branch?" question `status` asks, and a second switch
 * built beside this one is precisely the drift this comment has always warned
 * about.
 */
export async function landingHostFor(
  info: HostInfo,
  remoteUrl: string,
  deps: HostPrDeps,
): Promise<LandingHost & LandingPosture> {
  if (info.host === 'bitbucket') {
    return createBitbucketApiFromEnv({
      remoteUrl,
      workspace: info.workspace,
      repo: info.repo,
      env: deps.env,
    });
  }
  return createGitHubApiFromEnv({ remoteUrl, env: deps.env });
}

/**
 * The `create` verb — find-before-create, idempotently, over host-pr's
 * cross-host Basic-auth seam. An OPEN PR already on the branch is reused (exit 0,
 * `outcome: "reused"`) AND its title/body are re-written to the passed values
 * (`updated:true` when the PATCH landed) — the reuse re-pins the same PR and now
 * also carries the terminator's composed render onto it; a missing one is
 * created (exit 0, `outcome: "created"`); a create failure returns the pre-fill
 * fallback signal (exit 1, `outcome: "create-failed"` with `fallbackPrefillUrl`).
 *
 * The one reuse that does NOT proceed is the one whose damage would be silent: a
 * rewrite that drops the close phrase the live PR body carries (exit 1,
 * `outcome: "reuse-refused"` with a `reason`, and no write at all). It is a
 * refusal precisely because the alternative — a PR that merges normally while
 * closing nothing — leaves the wave looking finished with one row quietly open.
 * `allowClosePhraseLoss` is the deliberate override.
 *
 * `body` arrives here as a plain string with its provenance already resolved by
 * the caller — `--body` inline or `--body-file` read verbatim. That is WHY the
 * two routes are indistinguishable downstream: there is no second code path for
 * a file-sourced body to travel, so the close-phrase guard, the reuse rewrite
 * and the printed JSON cannot tell (or treat) them apart.
 *
 * The host token is RESOLVED through the engine credential seam (ADR-0029) and
 * never printed; every way that can fail — nothing configured, a lookup command
 * that exits non-zero, times out, or prints nothing — fails loud (exit 1) with
 * an error naming the command, mirroring `createGitHubApiFromEnv`. The Basic-auth
 * credential is `x-access-token:<token>` on GitHub and
 * `<atlassian-account-email>:<api-token>` on Bitbucket Cloud — see
 * {@link createCredsFor}, which owns the per-host pairing.
 */
async function runCreate(
  info: HostInfo,
  branch: string,
  title: string,
  body: string,
  base: string,
  allowClosePhraseLoss: boolean,
  deps: HostPrDeps,
): Promise<number> {
  // One resolver seam (ADR-0029): `<VAR>_CMD` (a lookup command) wins over the
  // ambient `<VAR>`, and a configured command that fails is a typed LOUD error
  // here — never a silent fallback to the ambient variable. Only `.message` is
  // ever printed: it names the command, never its output. The Bitbucket arm can
  // also fail for a SECOND reason — no account email to pair the token with —
  // and that refusal is loud and typed in exactly the same place.
  let creds: Creds;
  try {
    creds = createCredsFor(info.host, deps.env);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    process.stderr.write(`error: ${message}\n`);
    printJson({ ok: false, verb: 'create', host: info.host, branch, error: message });
    return 1;
  }

  const opts = deps.http ? { http: deps.http } : {};

  try {
    // find-before-create, in ONE library call (host-pr.ts's `createOrReusePr`).
    // The decision used to be spelled out here; it is shared with the
    // `route-tuple` terminator, which performs the same sequence in-process, so
    // it lives in the library and this runner is the thin router it always
    // claimed to be. The four outcomes below are the four it returns, projected
    // onto the JSON shape this verb has always printed — nothing about that
    // shape moved with the logic.
    //
    // Only the reuse-time update reads the guard override; find/create ignore it.
    const result = await createOrReusePr(
      info.host,
      creds,
      { branch, title, body, destination: base },
      info,
      { ...opts, allowClosePhraseLoss },
    );

    if (result.outcome === 'reuse-refused') {
      // The close-phrase guard stopped the rewrite BEFORE any write: the live
      // body carries a phrase this body would have dropped. Loud + typed, not
      // a silent success — the whole point is that the damage is undetectable
      // afterwards. The PR's URL is still reported (it genuinely is this
      // branch's PR), but `ok:false` + exit 1 keep it out of a success path.
      process.stderr.write(`error: ${result.reason}\n`);
      printJson({
        ok: false,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'reuse-refused',
        // Unchanged meaning: the live PR body/title were NOT re-written.
        updated: false,
        error: result.reason,
        reason: result.reason,
        ...alignedPrRef({ url: result.url }),
      });
      return 1;
    }

    if (result.outcome === 'reused') {
      printJson({
        ok: true,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'reused',
        // Disclose whether the reuse re-wrote the live PR body/title (FOR-58).
        updated: result.updated,
        // Aligned url/number field names across every verb (FOR-54): `url` +
        // `prUrl`. `create` carries no PR number (documented omission) — even on
        // reuse, where the number is known internally but deliberately not emitted.
        ...alignedPrRef({ url: result.url }),
      });
      return 0;
    }

    if (result.outcome === 'created') {
      printJson({
        ok: true,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'created',
        // Aligned url/number field names across every verb (FOR-54): `url` +
        // `prUrl`. `create` carries no PR number (documented omission).
        ...alignedPrRef({ url: result.url }),
      });
      return 0;
    }

    // A create failure is a returned signal, not a throw (ADR-0019): surface the
    // pre-fill fallback so the caller can open the PR by hand and continue.
    process.stderr.write(`error: ${result.error}\n`);
    printJson({
      ok: false,
      verb: 'create',
      host: info.host,
      branch,
      outcome: 'create-failed',
      error: result.error,
      fallbackPrefillUrl: result.fallbackPrefillUrl,
    });
    return 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb: 'create',
      host: info.host,
      branch,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

/**
 * The Basic-auth `user:secret` pair `host-pr create` sends, per host. ONE owner
 * for the pairing, because the two hosts genuinely differ and a per-call copy is
 * how such a rule drifts:
 *
 *   - **GitHub** — `x-access-token:<token>`, the form host-pr.ts's `HttpProbe`
 *     documents.
 *   - **Bitbucket Cloud** — `<atlassian-account-email>:<api-token>`. Measured,
 *     not assumed (this slice's AC): app passwords, the old
 *     `username:password` pairing, stopped working on 2026-06-09 and were
 *     removed on 2026-07-28, and Atlassian's replacement pairs the ACCOUNT
 *     EMAIL with an API token. So Bitbucket needs a second, non-secret input —
 *     `BITBUCKET_EMAIL` — and its absence is a loud typed refusal rather than a
 *     request that would 401 with nothing to read.
 *
 * Throws (never returns a partial credential); the caller turns the throw into
 * the exit-1 JSON payload.
 */
export function createCredsFor(host: Host, env: NodeJS.ProcessEnv | undefined): Creds {
  if (host === 'bitbucket') {
    const token = resolveCredential(BITBUCKET_TOKEN_VAR, {
      env,
      purpose: 'open a PR through `host-pr create` on Bitbucket Cloud',
    });
    return { auth: bitbucketCreateCreds(token, (env ?? process.env)[BITBUCKET_EMAIL_VAR]) };
  }
  const token = resolveCredential('GITHUB_TOKEN', {
    env,
    purpose: 'open a PR through `host-pr create`',
  });
  return { auth: `x-access-token:${token}` };
}

/**
 * The `preflight` verb — the code-host posture probe (ADR-0023 amendment). It is
 * store-BLIND: no `--config`, no store, no `--branch`. It builds a posture reader
 * from the RESOLVED host credential (ADR-0029 — the same construction-time
 * token preflight as arm/merge/status), then grades the code-host checks
 * via `preflightHost`.
 * Reports on every store kind identically — landing is always on the code host.
 *
 * Exit 0 = every check passed / advisory / unknown (a probe answer, not a block);
 * exit 1 = a check `fail`ed (allow-auto-merge OFF with required checks present, or
 * the token cannot merge PRs), or the host build/probe threw. The Bitbucket
 * `create-credentials` check and the GitHub `pr-create-token` check are both
 * graded `advisory`/`unknown` by construction and therefore never reach this
 * exit code — read `checks`, not `$?`, for either.
 */
async function runPreflight(info: HostInfo, remoteUrl: string, deps: HostPrDeps): Promise<number> {
  try {
    // The posture reader IS the landing adapter on both shipped hosts — one
    // construction, one credential preflight, three posture reads.
    const posture: LandingPosture = deps.posture ?? (await landingHostFor(info, remoteUrl, deps));
    // `deps.env` is threaded through as the ONE environment this verb reads:
    // the `create-credentials` check grades an ambient variable rather than a
    // posture read, and routing it through the same injectable seam the
    // credential resolve already uses keeps it exercisable from a spec instead
    // of adding a second `process.env` read site. `undefined` → the engine's
    // own `process.env` default.
    const report = await preflightHost(info.host, posture, deps.env, createRightProbe(info, deps));
    printJson({ ok: report.ok, verb: 'preflight', host: report.host, checks: report.checks });
    return report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb: 'preflight',
      host: info.host,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

/**
 * The inputs `preflightHost`'s GitHub `pr-create-token` check probes the CREATE
 * right with — resolved HERE, from this verb's own seams, because the credential
 * is the `create` verb's and {@link createCredsFor} is its single owner. Calling
 * that owner is what makes the probe send exactly what `host-pr create` sends:
 * `x-access-token:<token>` Basic, never the landing adapter's Bearer.
 *
 * Returns `undefined` — never throws — when the credential cannot be resolved,
 * and the check then grades `unknown` and issues no request. That is the honest
 * answer rather than an exit: `preflight` is an advisory probe, and a resolve
 * failure here says nothing about the token's rights. In PRODUCTION the branch
 * is effectively unreachable on either host, because `landingHostFor` has
 * already resolved the same variable through the same seam one line above and
 * would have failed loud first; it is reached by a spec that injects a posture
 * reader and no credential, which is exactly the shape that must issue no
 * network call.
 */
function createRightProbe(
  info: HostInfo,
  deps: HostPrDeps,
): { creds: Creds; info: HostInfo; http?: HttpProbe } | undefined {
  try {
    return { creds: createCredsFor(info.host, deps.env), info, http: deps.http };
  } catch {
    return undefined;
  }
}

async function dispatch(
  verb: Verb,
  host: LandingHost,
  branch: string,
  method: MergeMethod,
  hostName: Host,
  deleteBranch: boolean,
  commitMessage: CommitMessageSource,
  expectHead?: string,
): Promise<number> {
  if (verb === 'status') {
    const status = await host.getPrStatus(branch);
    // A successful probe is exit 0 even when the answer is `none`: "there is no
    // PR" is an ANSWER (the done-reconcile evidence hierarchy consumes it), not
    // a failure. The caller reads `state`.
    printJson({
      ok: true,
      verb,
      host: hostName,
      branch,
      ...status,
      // Aligned url/number field names across every verb (FOR-54): `status`
      // natively carries `url`/`number`; add the `prUrl`/`prNumber` aliases so
      // the shape matches arm/merge/create.
      ...alignedPrRef({ url: status.url, number: status.number }),
    });
    return 0;
  }

  const outcome =
    verb === 'arm'
      ? // `host: hostName` is REFUSAL PROSE and the landing title's NUMBER
        // SUFFIX only (ArmOptions.host) — the arm intent itself stays
        // host-neutral. Without it, a Bitbucket refusal would teach GitHub's
        // "tick Allow auto-merge" remedy for a control Bitbucket has no
        // equivalent of, on this host's most common outcome, and a Bitbucket
        // landing would carry GitHub's ` (#N)` instead of its own suffix.
        await armPullRequest(host, branch, method, { deleteBranch, host: hostName, commitMessage, expectHead })
      : await mergePullRequestNow(host, branch, method, { deleteBranch, host: hostName, commitMessage, expectHead });

  const ok = outcome.outcome === 'merged' || outcome.outcome === 'armed' || outcome.outcome === 'already-merged';
  // Aligned url/number field names across every verb (FOR-54): the landing
  // outcomes natively carry `prUrl`/`prNumber`; add the `url`/`number` aliases so
  // the shape matches status/create. A `no-pr` outcome carries neither → `{}`.
  const prRef = outcome.outcome === 'no-pr' ? {} : { url: outcome.prUrl, number: outcome.prNumber };
  // `commitMessage` is echoed beside `method`, the flag it is built like: the
  // SOURCE this call was asked for. What was actually handed over is
  // `landingMessage`, present only when there was one.
  printJson({ ok, verb, host: hostName, branch, method, commitMessage, ...outcome, ...alignedPrRef(prRef) });
  return ok ? 0 : 1;
}

/** The typed adapter-not-implemented exit — a distinct, machine-readable answer. */
function notImplemented(verb: Verb, host: Host, branch: string | undefined): number {
  const err = new LandingNotImplementedError(host);
  process.stderr.write(`error: ${err.message}\n`);
  // `preflight` carries no branch — omit the key rather than emit `branch: null`.
  printJson({ ok: false, code: err.code, verb, host, ...(branch !== undefined ? { branch } : {}), error: err.message });
  return 1;
}

/** Read the origin remote URL (a local git read — not a gh-creds call, sandbox-OK). */
export function gitRemoteUrl(): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
}

// Only execute when this file is run directly (not when imported by cli.ts/tests).
if (require.main === module) {
  runHostPr(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
