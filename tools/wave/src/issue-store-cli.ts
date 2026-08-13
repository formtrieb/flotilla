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
 *              BARE (ADR-0027 `filed:`): title + filingHint + bodySections ONLY —
 *              files an undecorated issue with no eligibility marker and no
 *              Header-Block; wave-readiness comes later via `annotate` (decorate).
 *              A half-written Header-Block is a usage error (exit 2), never a
 *              silently-completed one. A BARE input whose `bodySections` is
 *              absent/empty/all-blank is ALSO a usage error (exit 2, #278):
 *              a bare issue has no Header-Block to fall back on, so an empty
 *              `bodySections` means the filed issue carries no body at all —
 *              exactly the defect that landed 10/10 disclosure filings with
 *              0 body chars on the tracker.
 *   read     <id>                                  → prints the IssueView (JSON)
 *   parse-ref <id>                                 → prints the IssueRef {slug?, issue} (JSON)
 *   annotate <id> --patch <AnnotatePatch.json>     → decorates an existing issue (ADR-0010); nothing on stdout
 *   amend    <id> --patch <AmendPatch.json>        → amends title / free-prose sections (ADR-0025); nothing on stdout
 *   transition <id> <queued|in-flight|in-review>   → writes one claim rung; nothing on stdout
 *   unclaim  <id>                                  → drops the claim (queued→available); nothing on stdout
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
 *   triage-apply <id> --input <ApplyTriageInput.json> → set state/category, post comment (ADR-0015); nothing on stdout
 *   triage-close <id> --comment <text>             → wontfix + native close (ADR-0015); nothing on stdout
 *   flag     <id> --kind <recoverable-stop|terminal-failure> --question <q> --option <o> [--option <o> ...]  → raises needs-attention (ADR-0006); nothing on stdout
 *   clear-flag <id>                                → clears needs-attention; nothing on stdout
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
} from './adapters/issue-store';
import type { ApplyTriageInput } from './contract';
import { flag, printJson } from './cli-utils';
import { resolveStore } from './cli-store';

const VALID_RUNGS: readonly ClaimRung[] = ['queued', 'in-flight', 'in-review'];

const NA_KINDS: readonly NeedsAttentionPayload['kind'][] = [
  'recoverable-stop',
  'terminal-failure',
];

/** Collect EVERY value of a repeated flag (flag() returns only the first). */
function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) out.push(args[i + 1]);
  }
  return out;
}

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
  | 'read-closing';

const FULL_OP_LIST =
  'issue-store <create|read|parse-ref|annotate|amend|transition|unclaim|flag|clear-flag|close|read-closing|listOpen|listClaimed|publishDocument|readDocument|listDocuments|triage-read|triage-apply|triage-close> [...args] [--config <path>]';

/**
 * Every op's own contract section (issue #505) — printed INSTEAD OF the full
 * op-list dump (`FULL_OP_LIST`) once the op is known, so a wrong or missing
 * flag on (say) `triage-apply` teaches ONLY `triage-apply`'s own shape, not
 * all nineteen. Each entry states its output format, and the `--input`/
 * `--patch` ops (plus `flag`, whose "input" is individual flags rather than a
 * file) carry a compact WORKED EXAMPLE of the shape inline (≤6 lines) —
 * `triage-apply`'s `{state, category, comment}` shape is the reference case:
 * discovering it used to cost a `contract.ts` read.
 */
const OP_CONTRACT: Record<Op, readonly string[]> = {
  create: [
    'usage: issue-store create --input <CreateInput.json> [--config <path>]',
    '  bare shape (ADR-0027):      { "title": "...", "filingHint": "...",',
    '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
    '  decorated ALSO adds:        "risk", "worker", "files": [...], "blockedBy": "none", "acceptanceCriteria": [...]',
    'output: the opaque new id, as plain text (not JSON)',
  ],
  read: ['usage: issue-store read <id> [--config <path>]', 'output: the IssueView, as JSON'],
  'parse-ref': [
    'usage: issue-store parse-ref <id> [--config <path>]',
    'output: the IssueRef {slug?, issue}, as JSON',
  ],
  annotate: [
    'usage: issue-store annotate <id> --patch <AnnotatePatch.json> [--config <path>]',
    '  input shape (every key optional — supply at least one): { "risk": "...", "worker": "...",',
    '    "files": ["..."], "acceptanceCriteria": [{ "text": "...", "checked": false }],',
    '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  amend: [
    'usage: issue-store amend <id> --patch <AmendPatch.json> [--config <path>]',
    '  input shape (title and/or sections — non-empty):',
    '    { "title": "...", "sections": [{ "heading": "...", "markdown": "..." }] }',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  transition: [
    `usage: issue-store transition <id> <${VALID_RUNGS.join('|')}> [--config <path>]`,
    'output: nothing on success (exit 0, empty stdout)',
  ],
  unclaim: [
    'usage: issue-store unclaim <id> [--config <path>]',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  close: [
    'usage: issue-store close <id> <prUrl> [--acked 0,2,3] [--config <path>]',
    'output: the resulting ClosingState, as JSON — plus a stderr "STILL OPEN:" line',
    '  whenever the tracker still reports the issue open after recording the closing facts',
  ],
  listOpen: ['usage: issue-store listOpen [--config <path>]', 'output: IssueView[], as JSON'],
  listClaimed: [
    'usage: issue-store listClaimed [--config <path>]',
    'output: IssueView[], as JSON',
  ],
  publishDocument: [
    'usage: issue-store publishDocument --input <PublishDocumentInput.json> [--config <path>]',
    '  input shape: { "title": "...", "filingHint": "...",',
    '    "bodySections": [{ "heading": "...", "markdown": "..." }] }',
    'output: the opaque new PRD id, as plain text (not JSON)',
  ],
  readDocument: [
    'usage: issue-store readDocument <id> [--config <path>]',
    'output: the DocumentView, as JSON',
  ],
  listDocuments: [
    'usage: issue-store listDocuments [--config <path>]',
    'output: DocumentView[], as JSON',
  ],
  'triage-read': [
    'usage: issue-store triage-read <id> [--config <path>]',
    'output: the TriageView, as JSON',
  ],
  'triage-apply': [
    'usage: issue-store triage-apply <id> --input <ApplyTriageInput.json> [--config <path>]',
    '  input shape (every key optional — supply at least one):',
    '    { "state": "...", "category": "...", "comment": "..." }',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  'triage-close': [
    'usage: issue-store triage-close <id> --comment <text> [--config <path>]',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  flag: [
    'usage: issue-store flag <id> --kind <recoverable-stop|terminal-failure> --question <q> --option <o> [--option <o> ...] [--config <path>]',
    '  example: flag 42 --kind recoverable-stop --question "Which branch?" --option main --option develop',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  'clear-flag': [
    'usage: issue-store clear-flag <id> [--config <path>]',
    'output: nothing on success (exit 0, empty stdout)',
  ],
  'read-closing': [
    'usage: issue-store read-closing <id> [--config <path>]',
    'output: the ClosingState, as JSON',
  ],
};

/**
 * Render a usage error. With a KNOWN `op`, prints ONLY that op's own contract
 * section (`OP_CONTRACT`) — its usage line, an inline worked input-shape
 * example where one applies, and its output format — never the full op-list
 * dump (issue #505: the `host-pr arm --pr` misfire answered a one-flag mistake
 * with the entire multi-verb usage; this runner's per-op dump was smaller but
 * the same imprecision). Without a known `op` (no op at all, or an unknown
 * one) the full dump is what teaches — the caller hasn't told us which
 * contract they meant yet.
 */
function usage(message: string, op?: Op): number {
  const contract = op !== undefined ? OP_CONTRACT[op] : undefined;
  process.stderr.write(
    [`error: ${message}`, ...(contract ?? [`usage: ${FULL_OP_LIST}`]), ''].join('\n'),
  );
  return 2;
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
        const inputPath = flag(args, '--input');
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
        const id = args[1];
        if (id === undefined) return usage('read requires an <id>', 'read');
        printJson(await store.read(id));
        return 0;
      }

      case 'parse-ref': {
        const id = args[1];
        if (id === undefined) return usage('parse-ref requires an <id>', 'parse-ref');
        printJson(store.parseRef(id)); // sync, pure; throws on a non-numeric id → caught as domain failure (1)
        return 0;
      }

      case 'annotate': {
        const id = args[1];
        if (id === undefined) return usage('annotate requires an <id>', 'annotate');
        const patchPath = flag(args, '--patch');
        if (patchPath === undefined) return usage('annotate requires --patch <path>', 'annotate');
        let patch: AnnotatePatch;
        try {
          patch = JSON.parse(readFileSync(patchPath, 'utf-8')) as AnnotatePatch;
        } catch (err) {
          return usage(`cannot read --patch ${patchPath}: ${(err as Error).message}`, 'annotate');
        }
        await store.annotate(id, patch);
        return 0;
      }

      case 'amend': {
        const id = args[1];
        if (id === undefined) return usage('amend requires an <id>', 'amend');
        const patchPath = flag(args, '--patch');
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
        return 0;
      }

      case 'transition': {
        const id = args[1];
        const rung = args[2];
        if (id === undefined) return usage('transition requires an <id>', 'transition');
        if (rung === undefined || !(VALID_RUNGS as readonly string[]).includes(rung)) {
          return usage(
            `transition requires a rung ∈ {${VALID_RUNGS.join(', ')}}; got "${rung ?? ''}"`,
            'transition',
          );
        }
        await store.transition(id, rung as ClaimRung);
        return 0;
      }

      case 'unclaim': {
        const id = args[1];
        if (id === undefined) return usage('unclaim requires an <id>', 'unclaim');
        await store.unclaim(id);
        return 0;
      }

      case 'close': {
        const id = args[1];
        const prUrl = args[2];
        if (id === undefined) return usage('close requires an <id>', 'close');
        if (prUrl === undefined) return usage('close requires a <prUrl>', 'close');
        const ackedRaw = flag(args, '--acked');
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
        // rescued by hand; see docs/RELEASING.md step 7). Probe the SAME
        // evidence `read-closing` exposes and print it: additive under
        // ADR-0035 (a wholly new stdout shape where `close` printed nothing
        // before; no existing key renamed/removed, exit-code meaning
        // unchanged — 0 either way, a still-open issue after `close` is a
        // documented, non-domain-failure outcome). When the probe still
        // reads `open`, ALSO write an unmistakable line so a human running
        // this by hand cannot mistake exit 0 for "closed" — the documented
        // operator procedure (docs/RELEASING.md step 7 / this repo's
        // close-mechanics.md) is the path from here; no new close verb.
        const closing = await store.readClosing(id);
        printJson(closing);
        if (closing.state === 'open') {
          process.stderr.write(
            `STILL OPEN: issue ${id} recorded closing facts (${prUrl}) but the ` +
              `tracker still reports it OPEN — this call does not natively close ` +
              `an issue whose satisfying act was not a merged PR carrying its own ` +
              `close phrase. See docs/RELEASING.md step 7 for the documented ` +
              `operator procedure.\n`,
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
        const inputPath = flag(args, '--input');
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
        const id = args[1];
        if (id === undefined) return usage('readDocument requires an <id>', 'readDocument');
        printJson(await store.readDocument(id));
        return 0;
      }

      case 'listDocuments': {
        printJson(await store.listDocuments());
        return 0;
      }

      case 'triage-read': {
        const id = args[1];
        if (id === undefined) return usage('triage-read requires an <id>', 'triage-read');
        printJson(await store.readTriage(id));
        return 0;
      }

      case 'triage-apply': {
        const id = args[1];
        if (id === undefined) return usage('triage-apply requires an <id>', 'triage-apply');
        const inputPath = flag(args, '--input');
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
        return 0;
      }

      case 'triage-close': {
        const id = args[1];
        if (id === undefined) return usage('triage-close requires an <id>', 'triage-close');
        const comment = flag(args, '--comment');
        if (comment === undefined) {
          return usage('triage-close requires --comment <text>', 'triage-close');
        }
        await store.closeUnplanned(id, comment);
        return 0;
      }

      case 'flag': {
        const id = args[1];
        if (id === undefined) return usage('flag requires an <id>', 'flag');
        const kind = flag(args, '--kind');
        if (kind === undefined || !(NA_KINDS as readonly string[]).includes(kind)) {
          return usage(
            `flag requires --kind ∈ {${NA_KINDS.join(', ')}}; got "${kind ?? ''}"`,
            'flag',
          );
        }
        const question = flag(args, '--question');
        if (question === undefined) return usage('flag requires --question <q>', 'flag');
        const options = flagAll(args, '--option');
        if (options.length === 0) {
          return usage('flag requires at least one --option <o>', 'flag');
        }
        await store.flag(id, {
          kind: kind as NeedsAttentionPayload['kind'],
          question,
          options,
        });
        return 0;
      }

      case 'clear-flag': {
        const id = args[1];
        if (id === undefined) return usage('clear-flag requires an <id>', 'clear-flag');
        await store.clearFlag(id);
        return 0;
      }

      case 'read-closing': {
        const id = args[1];
        if (id === undefined) return usage('read-closing requires an <id>', 'read-closing');
        printJson(await store.readClosing(id));
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
