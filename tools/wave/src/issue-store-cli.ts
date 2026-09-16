#!/usr/bin/env node
/**
 * issue-store-cli.ts — store-agnostic CLI runner exposing the IssueStore surface.
 *
 * The flotilla skills (to-issues, wave-create, wave-start, wave-close, wave-resume)
 * mutate the tracker by shelling into the engine via `npx tsx` against THIS runner,
 * so every skill stays tracker-agnostic — the store is chosen from `wave.config.json`
 * via `buildStore`/`loadWaveConfig`, never hard-coded into a skill. The `close` op is
 * the done-reconcile wire (FOR-18): wave-close/wave-resume call it on a merged row to
 * land it `done` — idempotent no-op-or-reconcile, plus the FOR-13 `doneState` fallback.
 *
 * Usage:
 *   npx tsx tools/wave/src/issue-store-cli.ts <op> [...args] [--config <path>]
 *
 * Ops (each maps 1:1 onto an IssueStore method). The OUTPUT FORMAT tag on each
 * — (text)/(JSON)/(nothing) — answers "how do I consume this?" without probing
 * (issue #505 — the `dor`-prints-text surprise class, generalized: five sibling
 * ops here print JSON via `printJson`, so nothing said which of the other
 * fourteen didn't):
 *   create   --input <CreateInput.json>            → prints the opaque id (text, not JSON)
 *              DECORATED (the to-issues path): the full Header-Block — risk, worker,
 *              files, blockedBy, acceptanceCriteria — plus title/filingHint.
 *              BARE (ADR-0027 `filed:`): title + filingHint + bodySections, plus
 *              an OPTIONAL blockedBy (ADR-0044) — files an undecorated issue
 *              with no eligibility marker and no Header-Block; wave-readiness
 *              comes later via `annotate` (decorate). A bare `blockedBy` is
 *              realized NATIVELY (GitHub issue dependency, Linear issue
 *              relation) and writes no header line, so the bare shape is
 *              unchanged; `"none"`/`[]` declare nothing and file exactly the
 *              blockedBy-less bare issue. A store that cannot represent the
 *              edge natively — the markdown store, whose only blocker
 *              representation IS the Header-Block line — REFUSES it (exit 1,
 *              the store threw) naming both sanctioned routes, rather than
 *              writing a partial header or dropping the dependency.
 *              A half-written Header-Block is a usage error (exit 2), never a
 *              silently-completed one. A BARE input whose `bodySections` is
 *              absent/empty/all-blank is ALSO a usage error (exit 2, #278):
 *              a bare issue has no Header-Block to fall back on, so an empty
 *              `bodySections` means the filed issue carries no body at all —
 *              exactly the defect that landed 10/10 disclosure filings with
 *              0 body chars on the tracker.
 *   read     <id>                                  → prints the IssueView (JSON)
 *   parse-ref <id>                                 → prints the IssueRef {slug?, issue} (JSON)
 *   annotate <id> --patch <AnnotatePatch.json>     → decorates an existing issue (ADR-0010); nothing on stdout (a receipt with --json)
 *   amend    <id> --patch <AmendPatch.json>        → amends title / free-prose sections (ADR-0025); nothing on stdout (a receipt with --json)
 *   transition <id> <queued|in-flight|in-review>   → writes one claim rung; nothing on stdout (a receipt with --json)
 *   unclaim  <id>                                  → drops the claim (queued→available); nothing on stdout (a receipt with --json)
 *   close    <id> <prUrl> [--acked 0,2,3]          → records closing facts (done-reconcile; FOR-13 doneState fallback),
 *              then probes + prints the resulting ClosingState (JSON, same
 *              shape as `read-closing`) and — whenever that probe still reads
 *              `open` — ALSO writes an unmistakable `STILL OPEN:` line to
 *              stderr (#399): the satisfied-but-not-by-PR case (e.g. a
 *              release) leaves the issue open after this call, and that is
 *              no longer a silent exit 0.
 *   read-closing <id>                              → prints the ClosingState (JSON): open|merged|closed-unmerged|closed-unknown
 *   listOpen                                       → prints IssueView[] (JSON)
 *   listClaimed                                    → prints IssueView[] (JSON)
 *   publishDocument --input <PublishDocumentInput.json> → prints the opaque PRD id (text, not JSON; ADR-0011)
 *   readDocument <id>                              → prints the DocumentView (JSON)
 *   listDocuments                                  → prints DocumentView[] (JSON)
 *   triage-read <id>                               → prints the TriageView (JSON)
 *   triage-apply <id> --input <ApplyTriageInput.json> → set state/category, post comment (ADR-0015); nothing on stdout (a receipt with --json)
 *   triage-close <id> --comment <text>             → wontfix + native close (ADR-0015); nothing on stdout (a receipt with --json)
 *   flag     <id> --kind <recoverable-stop|terminal-failure> --question <q> --option <o> [--option <o> ...]  → raises needs-attention (ADR-0006); nothing on stdout (a receipt with --json)
 *   clear-flag <id>                                → clears needs-attention; nothing on stdout (a receipt with --json)
 *
 * Goal facet ops (ADR-0044 / ADR-0045). Each addresses the native container
 * bound by `store.goal.container` in wave.config.json — GitHub defaults to
 * `milestone` and the markdown store to its goal file, while LINEAR HAS NO
 * DEFAULT, so a goal op against a linear store with no binding declared fails
 * (exit 1) naming the missing key rather than silently picking a container.
 *
 * **The MEMBER-id ops below take a member id whose KIND follows that binding**
 * (ADR-0045 decision 1): an issue id under `milestone`/`project`/`goal-file`, a
 * PROJECT id under `initiative`. An issue-shaped id passed under an initiative
 * binding is refused (exit 1) before any write:
 *   goal-create --input <CreateGoalInput.json>     → prints the opaque goal id (text, not JSON)
 *   goal-read <goalId>                             → prints the GoalView (JSON)
 *   goal-list                                      → prints GoalView[] (JSON)
 *   goal-assign <goalId> <memberId>                → joins a member by curation; nothing on stdout (a receipt with --json)
 *   goal-create-member <goalId> --input <CreateGoalMemberInput.json>
 *                                                  → mints a BARE direct member and joins it in
 *              one act; prints the opaque new member id (text, not JSON). The
 *              member is bare on purpose — no eligibility marker — so nothing it
 *              files can be drawn by a wave until a person sharpens it.
 *   goal-publish-update <goalId> [--input <PublishGoalUpdateInput.json>]
 *                                                  → the MIRROR PASS (ADR-0046): publishes the
 *                                                    goal's derived accounting to its container's
 *                                                    native update surface; prints the receipt (JSON).
 *                                                    The engine derives the frontier fresh at write
 *                                                    time and renders the anchor — no flag supplies,
 *                                                    edits or omits it. github/markdown refuse typed.
 *   goal-frontier <goalId>                         → prints the GoalFrontier (JSON): per member
 *              done | in-motion | actionable | blocked | unready, plus counts,
 *              the open remainder, and `complete`. READ-ONLY — it reports that
 *              the frontier is empty and never closes the container, which is
 *              the Operator's act in the tracker (ADR-0044).
 *
 * There is deliberately NO goal-close op and NO goal-dispatch op: the facet
 * exposes neither, so neither has a runner here (sight, never permission).
 *
 * `--json` on a SILENT WRITE (ADR-0051 decision 7, #648's settled shape). The
 * nine ops tagged "nothing on stdout" above — annotate, amend, transition,
 * unclaim, flag, clear-flag, triage-apply, triage-close, goal-assign — are this
 * group's `silent-write` output class, and each answers the router-global
 * `--json` with exactly ONE receipt:
 *
 *     { "op": "<op>", "id": "<id>", "sent": { ...what the engine sent... } }
 *
 * A receipt says what was SENT, never what the tracker now reads. Every value in
 * `sent` is one this runner already held before it called the store, so no op
 * gains a read-back and none gains a second network call to produce one — see
 * {@link WriteReceipt}. Without `--json` the stdout of all nine stays
 * byte-identical to what it has always been (empty), and `--json` never changes
 * an exit code: a refused write still exits non-zero and prints no receipt. Each
 * op's own contract section below names its receipt shape.
 *
 * Exit codes:
 *   0 — success (result on stdout — see the per-op output-format tag above)
 *   1 — domain failure (store threw)
 *   2 — usage error, or unreadable/malformed --input file (message on stderr).
 *       A usage error on a KNOWN op (a missing/invalid flag, a malformed
 *       --input/--patch file) prints that op's OWN contract section — its
 *       usage line, a compact worked input-shape example where one applies,
 *       and its output format — instead of the full op-list dump below; the
 *       full dump is reserved for a missing or unknown op, where the caller
 *       hasn't told us which contract they meant yet (issue #505).
 */

import { readFileSync } from 'node:fs';
import { classifyCreateInput, CreateInputError } from './adapters/issue-store';
import type {
  IssueStore,
  CreateInput,
  AnnotatePatch,
  AmendPatch,
  ClaimRung,
  NeedsAttentionPayload,
  PublishDocumentInput,
  CreateGoalInput,
  CreateGoalMemberInput,
  PublishGoalUpdateInput,
} from './adapters/issue-store';
import type { ApplyTriageInput } from './contract';
import { flag, flagAll, printJson } from './cli-utils';
import { resolveStore, resolveGoalContainer } from './cli-store';
import {
  hasFlag,
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  type FlagContract,
  type OutputClass,
  type VerbContract,
} from './verb-contract';

const VALID_RUNGS: readonly ClaimRung[] = ['queued', 'in-flight', 'in-review'];

const NA_KINDS: readonly NeedsAttentionPayload['kind'][] = [
  'recoverable-stop',
  'terminal-failure',
];

/** Every op this runner dispatches — mirrors the switch's case labels exactly. */
type Op =
  | 'create'
  | 'read'
  | 'parse-ref'
  | 'annotate'
  | 'amend'
  | 'transition'
  | 'unclaim'
  | 'close'
  | 'listOpen'
  | 'listClaimed'
  | 'publishDocument'
  | 'readDocument'
  | 'listDocuments'
  | 'triage-read'
  | 'triage-apply'
  | 'triage-close'
  | 'flag'
  | 'clear-flag'
  | 'read-closing'
  | 'goal-create'
  | 'goal-read'
  | 'goal-list'
  | 'goal-assign'
  | 'goal-create-member'
  | 'goal-frontier'
  | 'goal-publish-update';

const FULL_OP_LIST =
  'issue-store <create|read|parse-ref|annotate|amend|transition|unclaim|flag|clear-flag|close|read-closing|listOpen|listClaimed|publishDocument|readDocument|listDocuments|triage-read|triage-apply|triage-close|goal-create|goal-read|goal-list|goal-assign|goal-create-member|goal-frontier|goal-publish-update> [...args] [--config <path>]';

/**
 * `--config <path>` — the ONE flag every op of this group accepts. It selects
 * the store config `resolveStore` builds from, and it is per verb rather than
 * router-global (ADR-0051 decision 7) for the reason that decision gives: not
 * every verb has a store, and a flag every verb pretended to accept would be a
 * lie on the ones that resolve none.
 */
const CONFIG_FLAG: FlagContract = { canonical: '--config', value: 'one', valueType: 'path' };

/** `--input <path>` on the ops that require a payload file. */
const INPUT_REQUIRED: FlagContract = {
  canonical: '--input',
  value: 'one',
  valueType: 'path',
  required: true,
};

/** `--input <path>` on `goal-publish-update`, where it ADDS prose rather than satisfying the op. */
const INPUT_OPTIONAL: FlagContract = { canonical: '--input', value: 'one', valueType: 'path' };

/** `--patch <path>` on the two patch ops. */
const PATCH_REQUIRED: FlagContract = {
  canonical: '--patch',
  value: 'one',
  valueType: 'path',
  required: true,
};

/**
 * One op's shape, minus the verb name (which {@link ISSUE_STORE_CONTRACTS}
 * derives from the table key, so the two can never disagree). `--config` is
 * appended to every op here rather than repeated 26 times.
 */
function issueStoreOp(
  positionals: number,
  output: OutputClass,
  flags: readonly FlagContract[],
  usage: readonly string[],
): Omit<VerbContract, 'verb'> {
  return {
    flags: [...flags, CONFIG_FLAG],
    positionals: { kind: 'fixed', count: positionals },
    output,
    usage,
  };
}

/**
 * Every op's own contract section (issue #505) — printed INSTEAD OF the full
 * op-list dump (`FULL_OP_LIST`) once the op is known, so a wrong or missing
 * flag on (say) `triage-apply` teaches ONLY `triage-apply`'s own shape, not
 * all nineteen. Each entry states its output format, and the `--input`/
 * `--patch` ops (plus `flag`, whose "input" is individual flags rather than a
 * file) carry a compact WORKED EXAMPLE of the shape inline (≤6 lines) —
 * `triage-apply`'s `{state, category, comment}` shape is the reference case:
 * discovering it used to cost a `contract.ts` read.
 *
 * ADR-0051 decision 2 EXTENDED this table rather than adding a second one
 * beside it: the `usage` array of every entry below is that table's former
 * value, byte for byte, and what is new is the declaration around it — the
 * flags with their canonical spellings and value kinds, the positional arity
 * (this group's positional grammar IS its canonical spelling — decision 6 gives
 * a verb group no named twin), and the output class.
 */
const ISSUE_STORE_OP_SHAPES: Readonly<Record<Op, Omit<VerbContract, 'verb'>>> = {
  create: issueStoreOp(
    0,
    'product',
    [INPUT_REQUIRED],
    [
      'usage: issue-store create --input <CreateInput.json> [--config <path>]',
      '  bare shape (ADR-0027):      { "title": "...", "filingHint": "...",',
      '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
      '  bare MAY also add (ADR-0044): "blockedBy": [{ "issue": 41 }] — realized natively (no Header-Block written)',
      '  decorated ALSO adds:        "risk", "worker", "files": [...], "blockedBy": "none", "acceptanceCriteria": [...]',
      'output: the opaque new id, as plain text (not JSON)',
    ],
  ),
  read: issueStoreOp(
    1,
    'json',
    [],
    ['usage: issue-store read <id> [--config <path>]', 'output: the IssueView, as JSON'],
  ),
  'parse-ref': issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store parse-ref <id> [--config <path>]',
      'output: the IssueRef {slug?, issue}, as JSON',
    ],
  ),
  annotate: issueStoreOp(
    1,
    'silent-write',
    [PATCH_REQUIRED],
    [
      'usage: issue-store annotate <id> --patch <AnnotatePatch.json> [--config <path>]',
      '  input shape (every key optional — supply at least one): { "risk": "...", "worker": "...",',
      '    "files": ["..."], "acceptanceCriteria": [{ "text": "...", "checked": false }],',
      '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent } — sent names the header fields written:',
      '    risk?, worker?, parent?, files?, acceptanceCriteria?, bodySections?',
    ],
  ),
  amend: issueStoreOp(
    1,
    'silent-write',
    [PATCH_REQUIRED],
    [
      'usage: issue-store amend <id> --patch <AmendPatch.json> [--config <path>]',
      '  input shape (title and/or sections — non-empty):',
      '    { "title": "...", "sections": [{ "heading": "...", "markdown": "..." }] }',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: { title?, sections? } } — what was written',
    ],
  ),
  transition: issueStoreOp(
    2,
    'silent-write',
    [],
    [
      `usage: issue-store transition <id> <${VALID_RUNGS.join('|')}> [--config <path>]`,
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: { rung } } — the rung swapped to',
    ],
  ),
  unclaim: issueStoreOp(
    1,
    'silent-write',
    [],
    [
      'usage: issue-store unclaim <id> [--config <path>]',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: {} } — the id IS the whole call',
    ],
  ),
  close: issueStoreOp(
    2,
    'json',
    [{ canonical: '--acked', value: 'one', valueType: 'list' }],
    [
      'usage: issue-store close <id> <prUrl> [--acked 0,2,3] [--config <path>]',
      'output: the resulting ClosingState, as JSON — plus a stderr "STILL OPEN:" line',
      '  whenever the tracker still reports the issue open after recording the closing facts',
    ],
  ),
  listOpen: issueStoreOp(
    0,
    'json',
    [],
    ['usage: issue-store listOpen [--config <path>]', 'output: IssueView[], as JSON'],
  ),
  listClaimed: issueStoreOp(
    0,
    'json',
    [],
    [
      'usage: issue-store listClaimed [--config <path>]',
      'output: IssueView[], as JSON',
    ],
  ),
  publishDocument: issueStoreOp(
    0,
    'product',
    [INPUT_REQUIRED],
    [
      'usage: issue-store publishDocument --input <PublishDocumentInput.json> [--config <path>]',
      '  input shape: { "title": "...", "filingHint": "...",',
      '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
      'output: the opaque new PRD id, as plain text (not JSON)',
    ],
  ),
  readDocument: issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store readDocument <id> [--config <path>]',
      'output: the DocumentView, as JSON',
    ],
  ),
  listDocuments: issueStoreOp(
    0,
    'json',
    [],
    [
      'usage: issue-store listDocuments [--config <path>]',
      'output: DocumentView[], as JSON',
    ],
  ),
  'triage-read': issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store triage-read <id> [--config <path>]',
      'output: the TriageView, as JSON',
    ],
  ),
  'triage-apply': issueStoreOp(
    1,
    'silent-write',
    [INPUT_REQUIRED],
    [
      'usage: issue-store triage-apply <id> --input <ApplyTriageInput.json> [--config <path>]',
      '  input shape (every key optional — supply at least one):',
      '    { "state": "...", "category": "...", "comment": "..." }',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: { state?, category?, commentPosted } }',
    ],
  ),
  'triage-close': issueStoreOp(
    1,
    'silent-write',
    [{ canonical: '--comment', value: 'one', valueType: 'text', required: true }],
    [
      'usage: issue-store triage-close <id> --comment <text> [--config <path>]',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: { commentPosted } }',
    ],
  ),
  flag: issueStoreOp(
    1,
    'silent-write',
    [
      { canonical: '--kind', value: 'one', valueType: 'enum', required: true },
      { canonical: '--question', value: 'one', valueType: 'text', required: true },
      { canonical: '--option', value: 'repeatable', valueType: 'text', required: true },
    ],
    [
      'usage: issue-store flag <id> --kind <recoverable-stop|terminal-failure> --question <q> --option <o> [--option <o> ...] [--config <path>]',
      '  example: flag 42 --kind recoverable-stop --question "Which branch?" --option main --option develop',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: { kind, question, options } }',
    ],
  ),
  'clear-flag': issueStoreOp(
    1,
    'silent-write',
    [],
    [
      'usage: issue-store clear-flag <id> [--config <path>]',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id, sent: {} } — the id IS the whole call',
    ],
  ),
  'read-closing': issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store read-closing <id> [--config <path>]',
      'output: the ClosingState, as JSON',
    ],
  ),
  'goal-create': issueStoreOp(
    0,
    'product',
    [INPUT_REQUIRED],
    [
      'usage: issue-store goal-create --input <CreateGoalInput.json> [--config <path>]',
      '  input shape: { "title": "...", "filingHint": "...", "description": "..." }',
      '  the container comes from wave.config.json "store.goal.container" —',
      '    github defaults to "milestone", markdown to its goal file, linear has NO default',
      'output: the opaque new goal id, as plain text (not JSON)',
    ],
  ),
  'goal-read': issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store goal-read <goalId> [--config <path>]',
      'output: the GoalView {id, title, description, container, memberIds}, as JSON',
    ],
  ),
  'goal-list': issueStoreOp(
    0,
    'json',
    [],
    [
      'usage: issue-store goal-list [--config <path>]',
      'output: GoalView[], as JSON',
    ],
  ),
  'goal-assign': issueStoreOp(
    2,
    'silent-write',
    [],
    [
      'usage: issue-store goal-assign <goalId> <memberId> [--config <path>]',
      "  <memberId>'s KIND follows the binding (ADR-0045): an issue id under",
      '    "milestone" | "project" | "goal-file"; a PROJECT id under "initiative"',
      'output: nothing on success (exit 0, empty stdout)',
      '  --json receipt: { op, id: <memberId>, sent: { goalId, container? } }',
    ],
  ),
  'goal-create-member': issueStoreOp(
    1,
    'product',
    [INPUT_REQUIRED],
    [
      'usage: issue-store goal-create-member <goalId> --input <CreateGoalMemberInput.json> [--config <path>]',
      '  input shape: { "title": "...", "filingHint": "...",',
      '    "bodySections": [{ "heading": "...", "markdown": "..." }],',
      '    "blockedBy": ["<memberId>", ...] }        ← optional; MEMBER ids, not refs',
      '  mints a BARE direct member (no eligibility marker) and joins it in one act;',
      '    the member KIND follows the binding — an issue, or a project under "initiative"',
      'output: the opaque new member id, as plain text (not JSON)',
    ],
  ),
  'goal-frontier': issueStoreOp(
    1,
    'json',
    [],
    [
      'usage: issue-store goal-frontier <goalId> [--config <path>]',
      'output: the GoalFrontier, as JSON — one reading per member',
      '  (done | in-motion | actionable | blocked | unready), plus counts,',
      '  the open remainder, and `complete`. Read-only: it never closes the goal.',
    ],
  ),
  'goal-publish-update': issueStoreOp(
    1,
    'json',
    [INPUT_OPTIONAL],
    [
      'usage: issue-store goal-publish-update <goalId> [--input <PublishGoalUpdateInput.json>] [--config <path>]',
      '  --input is OPTIONAL: {"narrative"?, "health"?, "operatorNote"?}',
      '  the ENGINE derives the frontier fresh and renders the accounting anchor;',
      '    there is no way to supply, edit or omit it — that is the whole guarantee',
      '  health is transcribed, never derived: pass an Operator-confirmed value or',
      '    none at all. Omitted means the update publishes without one.',
      '  needs a container with a native update surface (linear project/initiative);',
      '    github and markdown refuse with GoalBindingError "unrealized-update-surface"',
      'output: the GoalUpdateReceipt, as JSON — the update id and url, the exact',
      '  body published, and the frontier the anchor was derived from',
    ],
  ),
};

/**
 * Every op's full Verb contract — the shapes above, each given the verb name
 * the CALLER types (`issue-store <op>`) derived from its own table key, so the
 * name and the declaration can never disagree.
 *
 * Root-exported (and collected by `cli.ts`'s aggregate reader) so the skill-side
 * pin and the later Catalog read ONE thing.
 */
export const ISSUE_STORE_CONTRACTS: Readonly<Record<Op, VerbContract>> =
  Object.fromEntries(
    (Object.keys(ISSUE_STORE_OP_SHAPES) as Op[]).map((op) => [
      op,
      { verb: `issue-store ${op}`, ...ISSUE_STORE_OP_SHAPES[op] },
    ]),
  ) as Readonly<Record<Op, VerbContract>>;

/**
 * Every registered op, in the order {@link ISSUE_STORE_CONTRACTS} declares them
 * — derived, never a second hand-typed roster (issue #650: the same discipline
 * `SPINE_OPS`/`Object.keys(SPINE_OP_ARGS)` already uses in spine-cli.ts).
 * The table is `Record<Op, ...>`, so this list is exactly the `Op` union the
 * switch below dispatches — it cannot omit or invent an op without a compile
 * error.
 */
const ALL_OPS = Object.keys(ISSUE_STORE_CONTRACTS) as Op[];

/**
 * Render a usage error. With a KNOWN `op`, prints ONLY that op's own contract
 * section (`OP_CONTRACT`) — its usage line, an inline worked input-shape
 * example where one applies, and its output format — never the full op-list
 * dump (issue #505: the `host-pr arm --pr` misfire answered a one-flag mistake
 * with the entire multi-verb usage; this runner's per-op dump was smaller but
 * the same imprecision). Without a known `op` (no op at all, or an unknown
 * one) the full dump is what teaches — the caller hasn't told us which
 * contract they meant yet.
 *
 * Issue #650 — that full dump used to be the single joined `usage: <op1|op2|
 * ...>` line and nothing else. It now ALSO lists every op on its own line,
 * each naming its own usage (`OP_CONTRACT[op][0]`, the same first line a
 * KNOWN op's own contract leads with) — sourced from `ALL_OPS`/`OP_CONTRACT`,
 * so the roster cannot drift from what the switch above actually dispatches.
 * The original single-line summary survives byte-for-byte (existing specs
 * read it back); the per-op block is additive.
 */
function usage(message: string, op?: Op): number {
  const contract = op !== undefined ? ISSUE_STORE_CONTRACTS[op].usage : undefined;
  const body =
    contract ?? [
      `usage: ${FULL_OP_LIST}`,
      '',
      'ops:',
      ...ALL_OPS.map((o) => `  ${ISSUE_STORE_CONTRACTS[o].usage[0]}`),
    ];
  process.stderr.write([`error: ${message}`, ...body, ''].join('\n'));
  return 2;
}

// ─── The `--json` receipt of a silent write (ADR-0051 decision 7, #648) ─────

/**
 * What one `silent-write` op answers `--json` with: the op, the id it addressed,
 * and `sent` — the fields this runner HANDED THE STORE.
 *
 * **A receipt states what was SENT, never what the tracker now reads.** Every
 * value in `sent` is one this runner already held before it called the store, so
 * no op gains a read-back and none gains a second network call to produce one.
 * That is the whole guarantee, and it is the same one `GoalUpdateReceipt` makes
 * one facet over (ADR-0046) — the house precedent this shape follows rather than
 * a second one invented beside it.
 *
 * What it deliberately does NOT carry: the resulting status, the native state,
 * the tracker's own copy of the issue. Those are READINGS, and a reading here
 * would be a second call whose answer could differ from what went out — the one
 * claim a receipt exists not to make. The gap it closes is narrower and real: a
 * failed write and a successful one printed exactly the same thing (nothing), so
 * the only positive evidence a write landed as intended was a second read.
 *
 * `sent` is EMPTY for the two ops that carry no payload at all (`unclaim`,
 * `clear-flag`): the id IS the whole call, and an empty object says exactly
 * that. Naming a resulting state there would be a claim about the store's own
 * config-governed target (`unclaimTarget`), not about what this runner sent.
 *
 * Contract from the day it lands (ADR-0035): `issue-store-cli.spec.ts` pins
 * every one of the nine shapes across all three shipped stores. Deliberately
 * MODULE-LOCAL rather than exported — a receipt is a CLI projection, not a store
 * fact, and the package-root barrel every exported symbol must reach is outside
 * this row's declared Files globs.
 */
interface WriteReceipt {
  /** The op as the caller spelled it — the switch's own case label. */
  readonly op: Op;
  /**
   * The id the write addressed. For the eight issue-scoped ops that is the
   * `<id>` positional; for `goal-assign` it is the MEMBER, because the member is
   * what the join writes to and the goal it was joined to is the sent field.
   */
  readonly id: string;
  /** What the engine handed the store — never a value read back after the write. */
  readonly sent: Readonly<Record<string, unknown>>;
}

/**
 * `fields` minus every key whose value is `undefined` — a field the caller did
 * not supply is ABSENT from the receipt rather than present as `null`. The
 * receipt names what went out, and a key that went out as nothing did not go
 * out.
 */
function sentFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

/**
 * Print one {@link WriteReceipt} when `--json` was passed, and NOTHING when it
 * was not — so the default stdout of all nine silent writes stays byte-identical
 * to what it has always been (empty, exit 0).
 *
 * Every call site sits AFTER its `await store.*(...)` has resolved, which is
 * what makes the other half of decision 7's promise structural rather than
 * asserted: a refused write throws past this line into the runner's outer catch,
 * which exits 1 having printed no receipt. `--json` therefore never changes an
 * exit code and never prints on a failure.
 */
function writeReceipt(
  wantJson: boolean,
  op: Op,
  id: string,
  sent: Record<string, unknown>,
): void {
  if (!wantJson) return;
  const receipt: WriteReceipt = { op, id, sent };
  printJson(receipt);
}

/**
 * Run the issue-store CLI.
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`)
 * @param injected - an IssueStore to use directly (tests); when absent the store
 *   is built from `--config` (default `wave.config.json`) via resolveStore.
 * @returns exit code: 0 success, 1 domain failure, 2 usage / bad input file.
 */
export async function runIssueStore(
  args: string[],
  injected?: IssueStore,
): Promise<number> {
  const op = args[0];
  if (op === undefined) return usage('an op is required');

  // `issue-store --help` — no op named yet, so the answer is the whole op
  // roster, on stdout, exit 0. It is answered HERE, ahead of `resolveStore`:
  // asking this verb group for help used to build a tracker client and resolve
  // a credential first (issue #758), because the op check lived in the switch's
  // `default:` case at the far end of that call.
  if (op === '--help') {
    process.stdout.write(
      [
        `usage: ${FULL_OP_LIST}`,
        '',
        'ops:',
        ...ALL_OPS.map((o) => `  ${ISSUE_STORE_CONTRACTS[o].usage[0]}`),
        '',
      ].join('\n'),
    );
    return 0;
  }

  // ── Everything decidable from argv alone is decided BEFORE the store ──────
  //
  // `resolveStore` builds a tracker client — on `github`/`linear` that resolves
  // a credential and can reach the network. An unknown op, a `--help`, or an
  // undeclared flag are all answerable without any of it, and used to pay for
  // it anyway: the op check lived in the switch's `default:` case, i.e. AFTER
  // the store was standing (issue #758, ADR-0051 decision 7).
  const contract = ISSUE_STORE_CONTRACTS[op as Op] as VerbContract | undefined;
  if (contract === undefined) return usage(`unknown op "${op}"`);
  const opArgs = args.slice(1);
  if (helpRequested(contract, opArgs)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, opArgs);
  if (refusal !== 0) return refusal;

  // The op's positional arguments, read through the contract rather than as raw
  // `args[1]`/`args[2]`: the contract knows which tokens are a flag's VALUE, so
  // `issue-store read --config wave.config.json 42` now finds `42` where the
  // index form found `--config`.
  const positionals = positionalsOf(contract, opArgs);

  // `--json` is router-global (ADR-0051 decision 7) and this group's nine
  // `silent-write` ops are where it MEANS something: each prints one receipt of
  // what the engine sent. Read through the SAME contract-aware scan the
  // positionals came from, so a `--question "--json"` prose value can never be
  // mistaken for the flag itself.
  const wantJson = hasFlag(contract, opArgs, 'json');

  const store = await resolveStore(args, injected);

  // One try/catch wraps the WHOLE switch: any store.* throw is a domain failure
  // → exit 1 (documented contract; P7.2 calls read/transition/close against ids
  // that may not exist). Usage guards inside use `return 2`, and a `return` is
  // NOT intercepted by try/catch — so those stay usage-2, never reclassified.
  // The `create --input` read keeps its OWN inner try/catch returning 2: a bad
  // input file is a usage error, and that inner catch wins before the outer one.
  try {
    switch (op) {
      case 'create': {
        const inputPath = flag(args, contract, 'input');
        if (inputPath === undefined) return usage('create requires --input <path>', 'create');
        let input: CreateInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as CreateInput;
        } catch (err) {
          return usage(`cannot read --input ${inputPath}: ${(err as Error).message}`, 'create');
        }
        // Whole-input validation BEFORE the write (the same discipline as
        // `amend`, and the same classifier the adapters run as the first
        // statement of `create`): a BARE input — title + filingHint +
        // non-blank bodySections, no Header-Block (ADR-0027) — is accepted and
        // files an undecorated issue; a HALF-WRITTEN Header-Block, a bare input
        // with a decoration-only stowaway, and a bare input with no authored
        // body content are caller bugs, so each is a usage error (exit 2)
        // naming the offending fields, not a domain failure.
        //
        // #309: this CLI OWNS NONE of those rules — it renders them. The whole
        // create-shape invariant (bare-body included, #278) lives in
        // `classifyCreateInput`, so a non-CLI caller of `store.create` inherits
        // the identical rejection instead of routing around a predicate that
        // only ever ran here. All this layer decides is the exit code and the
        // stderr line, which is why the catch narrows on the TYPED error:
        // anything else thrown from the classifier is not a caller-input
        // verdict and must not be laundered into a usage message — it falls to
        // the outer catch as a domain failure (exit 1).
        try {
          classifyCreateInput(input);
        } catch (err) {
          if (err instanceof CreateInputError) return usage(err.message, 'create');
          throw err;
        }
        const id = await store.create(input);
        process.stdout.write(id + '\n');
        return 0;
      }

      case 'read': {
        const id = positionals[0];
        if (id === undefined) return usage('read requires an <id>', 'read');
        printJson(await store.read(id));
        return 0;
      }

      case 'parse-ref': {
        const id = positionals[0];
        if (id === undefined) return usage('parse-ref requires an <id>', 'parse-ref');
        printJson(store.parseRef(id)); // sync, pure; throws on a non-numeric id → caught as domain failure (1)
        return 0;
      }

      case 'annotate': {
        const id = positionals[0];
        if (id === undefined) return usage('annotate requires an <id>', 'annotate');
        const patchPath = flag(args, contract, 'patch');
        if (patchPath === undefined) return usage('annotate requires --patch <path>', 'annotate');
        let patch: AnnotatePatch;
        try {
          patch = JSON.parse(readFileSync(patchPath, 'utf-8')) as AnnotatePatch;
        } catch (err) {
          return usage(`cannot read --patch ${patchPath}: ${(err as Error).message}`, 'annotate');
        }
        await store.annotate(id, patch);
        writeReceipt(
          wantJson,
          'annotate',
          id,
          sentFields({
            risk: patch.risk,
            worker: patch.worker,
            parent: patch.parent,
            files: patch.files,
            acceptanceCriteria: patch.acceptanceCriteria,
            bodySections: patch.bodySections,
          }),
        );
        return 0;
      }

      case 'amend': {
        const id = positionals[0];
        if (id === undefined) return usage('amend requires an <id>', 'amend');
        const patchPath = flag(args, contract, 'patch');
        if (patchPath === undefined) return usage('amend requires --patch <path>', 'amend');
        let patch: AmendPatch;
        try {
          patch = JSON.parse(readFileSync(patchPath, 'utf-8')) as AmendPatch;
        } catch (err) {
          return usage(`cannot read --patch ${patchPath}: ${(err as Error).message}`, 'amend');
        }
        // Whole-patch validation BEFORE any write; an empty patch is a usage
        // error (exit 2) — a change-nothing amend is a caller bug. A reserved
        // heading / unknown id is a domain failure (exit 1, the store throws).
        if (
          patch.title === undefined &&
          (patch.sections === undefined || patch.sections.length === 0)
        ) {
          return usage('amend requires a non-empty patch (title and/or sections)', 'amend');
        }
        await store.amend(id, patch);
        writeReceipt(
          wantJson,
          'amend',
          id,
          sentFields({ title: patch.title, sections: patch.sections }),
        );
        return 0;
      }

      case 'transition': {
        const id = positionals[0];
        const rung = positionals[1];
        if (id === undefined) return usage('transition requires an <id>', 'transition');
        if (rung === undefined || !(VALID_RUNGS as readonly string[]).includes(rung)) {
          return usage(
            `transition requires a rung ∈ {${VALID_RUNGS.join(', ')}}; got "${rung ?? ''}"`,
            'transition',
          );
        }
        await store.transition(id, rung as ClaimRung);
        writeReceipt(wantJson, 'transition', id, { rung });
        return 0;
      }

      case 'unclaim': {
        const id = positionals[0];
        if (id === undefined) return usage('unclaim requires an <id>', 'unclaim');
        await store.unclaim(id);
        // No payload at all: the id IS the call. The state the store lands on is
        // its own `unclaimTarget`, a config fact this runner never sent.
        writeReceipt(wantJson, 'unclaim', id, {});
        return 0;
      }

      case 'close': {
        const id = positionals[0];
        const prUrl = positionals[1];
        if (id === undefined) return usage('close requires an <id>', 'close');
        if (prUrl === undefined) return usage('close requires a <prUrl>', 'close');
        const ackedRaw = flag(args, contract, 'acked');
        const acked =
          ackedRaw === undefined || ackedRaw.trim() === ''
            ? []
            : ackedRaw.split(',').map((s) => Number(s.trim()));
        await store.close(id, prUrl, acked);
        // #399: `close` is deliberately no-op-or-reconcile — it records the
        // closing facts but does NOT natively close an issue whose satisfying
        // act was not a merged PR carrying its own close phrase (a release, a
        // hand action). Left bare, that read as success on exit 0 with the
        // issue silently still open (#339 at 1.0.0, #397 at 1.0.1 — both
        // rescued by hand). Probe the SAME evidence `read-closing` exposes
        // and print it: additive under ADR-0035 (a wholly new stdout shape
        // where `close` printed nothing before; no existing key
        // renamed/removed, exit-code meaning unchanged — 0 either way, a
        // still-open issue after `close` is a documented,
        // non-domain-failure outcome). When the probe still reads `open`,
        // ALSO write an unmistakable line so a human running this by hand
        // cannot mistake exit 0 for "closed". That line speaks in the
        // READER'S terms — the issue stays open until the native close
        // happens, and the reader flips it by hand in the tracker — and it
        // names no document, because the caller may be any consumer repo and
        // this repo's own release procedure is not a file they have (#801).
        // No new close verb, here or there.
        const closing = await store.readClosing(id);
        printJson(closing);
        if (closing.state === 'open') {
          process.stderr.write(
            `STILL OPEN: issue ${id} recorded closing facts (${prUrl}) but the ` +
              `tracker still reports it OPEN — this call does not natively close ` +
              `an issue whose satisfying act was not a merged PR carrying its own ` +
              `close phrase. It stays open until that native close happens, and ` +
              `there is no further close verb to reach for: close it by hand in ` +
              `the tracker.\n`,
          );
        }
        return 0;
      }

      case 'listOpen': {
        printJson(await store.listOpen('wave-ready'));
        return 0;
      }

      case 'listClaimed': {
        printJson(await store.listClaimed());
        return 0;
      }

      case 'publishDocument': {
        const inputPath = flag(args, contract, 'input');
        if (inputPath === undefined) {
          return usage('publishDocument requires --input <path>', 'publishDocument');
        }
        let input: PublishDocumentInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as PublishDocumentInput;
        } catch (err) {
          return usage(
            `cannot read --input ${inputPath}: ${(err as Error).message}`,
            'publishDocument',
          );
        }
        const id = await store.publishDocument(input);
        process.stdout.write(id + '\n');
        return 0;
      }

      case 'readDocument': {
        const id = positionals[0];
        if (id === undefined) return usage('readDocument requires an <id>', 'readDocument');
        printJson(await store.readDocument(id));
        return 0;
      }

      case 'listDocuments': {
        printJson(await store.listDocuments());
        return 0;
      }

      case 'triage-read': {
        const id = positionals[0];
        if (id === undefined) return usage('triage-read requires an <id>', 'triage-read');
        printJson(await store.readTriage(id));
        return 0;
      }

      case 'triage-apply': {
        const id = positionals[0];
        if (id === undefined) return usage('triage-apply requires an <id>', 'triage-apply');
        const inputPath = flag(args, contract, 'input');
        if (inputPath === undefined) {
          return usage('triage-apply requires --input <path>', 'triage-apply');
        }
        let input: ApplyTriageInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as ApplyTriageInput;
        } catch (err) {
          return usage(
            `cannot read --input ${inputPath}: ${(err as Error).message}`,
            'triage-apply',
          );
        }
        await store.applyTriage(id, input);
        // `commentPosted` rather than the comment's text, and it mirrors the rule
        // all three adapters share: a comment goes out iff `comment` is present.
        // The text is prose the caller already holds; whether a comment was
        // actually posted is the fact that was invisible.
        writeReceipt(
          wantJson,
          'triage-apply',
          id,
          sentFields({
            state: input.state,
            category: input.category,
            commentPosted: input.comment !== undefined,
          }),
        );
        return 0;
      }

      case 'triage-close': {
        const id = positionals[0];
        if (id === undefined) return usage('triage-close requires an <id>', 'triage-close');
        const comment = flag(args, contract, 'comment');
        if (comment === undefined) {
          return usage('triage-close requires --comment <text>', 'triage-close');
        }
        await store.closeUnplanned(id, comment);
        // `--comment` is required, so a comment always goes out. The unplanned
        // STATE this lands on is the store's own triage schema, not something
        // this runner sent — so it is not in the receipt.
        writeReceipt(wantJson, 'triage-close', id, { commentPosted: true });
        return 0;
      }

      case 'flag': {
        const id = positionals[0];
        if (id === undefined) return usage('flag requires an <id>', 'flag');
        const kind = flag(args, contract, 'kind');
        if (kind === undefined || !(NA_KINDS as readonly string[]).includes(kind)) {
          return usage(
            `flag requires --kind ∈ {${NA_KINDS.join(', ')}}; got "${kind ?? ''}"`,
            'flag',
          );
        }
        const question = flag(args, contract, 'question');
        if (question === undefined) return usage('flag requires --question <q>', 'flag');
        const options = flagAll(args, contract, 'option');
        if (options.length === 0) {
          return usage('flag requires at least one --option <o>', 'flag');
        }
        await store.flag(id, {
          kind: kind as NeedsAttentionPayload['kind'],
          question,
          options,
        });
        writeReceipt(wantJson, 'flag', id, { kind, question, options });
        return 0;
      }

      case 'clear-flag': {
        const id = positionals[0];
        if (id === undefined) return usage('clear-flag requires an <id>', 'clear-flag');
        await store.clearFlag(id);
        writeReceipt(wantJson, 'clear-flag', id, {});
        return 0;
      }

      case 'read-closing': {
        const id = positionals[0];
        if (id === undefined) return usage('read-closing requires an <id>', 'read-closing');
        printJson(await store.readClosing(id));
        return 0;
      }

      // ── Goal facet ops (ADR-0044) ──────────────────────────────────────
      //
      // Each resolves the container binding from the SAME `--config` the store
      // came from (`resolveGoalContainer` mirrors `resolveStore`'s own
      // injected-store short-circuit), then hands it to the verb. A binding the
      // store cannot honour — absent on linear, or a role it does not realize —
      // throws `GoalBindingError` from the store and lands as a domain failure
      // (exit 1) naming `store.goal.container`, never a silent container pick.

      case 'goal-create': {
        const inputPath = flag(args, contract, 'input');
        if (inputPath === undefined) {
          return usage('goal-create requires --input <path>', 'goal-create');
        }
        let input: CreateGoalInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as CreateGoalInput;
        } catch (err) {
          return usage(
            `cannot read --input ${inputPath}: ${(err as Error).message}`,
            'goal-create',
          );
        }
        if (typeof input?.title !== 'string' || input.title.trim() === '') {
          return usage('goal-create requires a non-empty "title"', 'goal-create');
        }
        if (typeof input.filingHint !== 'string' || input.filingHint.trim() === '') {
          return usage('goal-create requires a non-empty "filingHint"', 'goal-create');
        }
        const id = await store.createGoal(input, resolveGoalContainer(args, injected));
        process.stdout.write(id + '\n');
        return 0;
      }

      case 'goal-read': {
        const goalId = positionals[0];
        if (goalId === undefined) return usage('goal-read requires a <goalId>', 'goal-read');
        printJson(await store.readGoal(goalId, resolveGoalContainer(args, injected)));
        return 0;
      }

      case 'goal-list': {
        printJson(await store.listGoals(resolveGoalContainer(args, injected)));
        return 0;
      }

      case 'goal-assign': {
        const goalId = positionals[0];
        const memberId = positionals[1];
        if (goalId === undefined) return usage('goal-assign requires a <goalId>', 'goal-assign');
        if (memberId === undefined) {
          return usage('goal-assign requires a <memberId>', 'goal-assign');
        }
        const assignContainer = resolveGoalContainer(args, injected);
        await store.assignToGoal(goalId, memberId, assignContainer);
        // The id is the MEMBER — the entity the join writes to — and the goal it
        // was joined to is the sent field. `container` is present only when one
        // was actually passed to the store; an absent binding sent nothing.
        writeReceipt(
          wantJson,
          'goal-assign',
          memberId,
          sentFields({ goalId, container: assignContainer }),
        );
        return 0;
      }

      case 'goal-create-member': {
        const goalId = positionals[0];
        if (goalId === undefined) {
          return usage('goal-create-member requires a <goalId>', 'goal-create-member');
        }
        const inputPath = flag(args, contract, 'input');
        if (inputPath === undefined) {
          return usage('goal-create-member requires --input <path>', 'goal-create-member');
        }
        let memberInput: CreateGoalMemberInput;
        try {
          memberInput = JSON.parse(readFileSync(inputPath, 'utf-8')) as CreateGoalMemberInput;
        } catch (err) {
          return usage(
            `cannot read --input ${inputPath}: ${(err as Error).message}`,
            'goal-create-member',
          );
        }
        // The same shallow shape guards `goal-create` applies, and for the same
        // reason: a missing title/filingHint is a CALLER bug (exit 2), not a
        // store failure. The BODY rule is deliberately not restated here — it is
        // `classifyCreateInput`'s (`bare-without-body`), which every adapter runs
        // as its first act, so a bodyless input is refused once by the owner of
        // that rule rather than twice by two predicates that could drift.
        if (typeof memberInput?.title !== 'string' || memberInput.title.trim() === '') {
          return usage(
            'goal-create-member requires a non-empty "title"',
            'goal-create-member',
          );
        }
        if (
          typeof memberInput.filingHint !== 'string' ||
          memberInput.filingHint.trim() === ''
        ) {
          return usage(
            'goal-create-member requires a non-empty "filingHint"',
            'goal-create-member',
          );
        }
        const memberId = await store.createGoalMember(
          goalId,
          memberInput,
          resolveGoalContainer(args, injected),
        );
        process.stdout.write(memberId + '\n');
        return 0;
      }

      case 'goal-frontier': {
        const goalId = positionals[0];
        if (goalId === undefined) {
          return usage('goal-frontier requires a <goalId>', 'goal-frontier');
        }
        printJson(await store.readGoalFrontier(goalId, resolveGoalContainer(args, injected)));
        return 0;
      }

      // The mirror pass (ADR-0046). The ONLY goal op that writes to the
      // container itself, and the only one whose input file is optional — an
      // anchor-only update is a complete artifact, so `--input` is how a caller
      // ADDS prose rather than how it satisfies the op.
      //
      // Note what this op cannot express, which is the point: there is no
      // `--body`, no `--anchor` and no `--frontier` flag. The accounting is
      // derived inside the store at write time, so not even the CLI — the one
      // surface a human types at directly — offers a way to hand one in.
      case 'goal-publish-update': {
        const goalId = positionals[0];
        if (goalId === undefined) {
          return usage('goal-publish-update requires a <goalId>', 'goal-publish-update');
        }
        let updateInput: PublishGoalUpdateInput = {};
        const inputPath = flag(args, contract, 'input');
        if (inputPath !== undefined) {
          try {
            updateInput = JSON.parse(readFileSync(inputPath, 'utf-8')) as PublishGoalUpdateInput;
          } catch (err) {
            return usage(
              `cannot read --input ${inputPath}: ${(err as Error).message}`,
              'goal-publish-update',
            );
          }
          if (updateInput === null || typeof updateInput !== 'object') {
            return usage(
              'goal-publish-update --input must contain a JSON object',
              'goal-publish-update',
            );
          }
        }
        printJson(
          await store.publishGoalUpdate(
            goalId,
            updateInput,
            resolveGoalContainer(args, injected),
          ),
        );
        return 0;
      }

      default:
        return usage(`unknown op "${op}"`);
    }
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when this file is run directly (not when imported by tests).
if (require.main === module) {
  runIssueStore(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
