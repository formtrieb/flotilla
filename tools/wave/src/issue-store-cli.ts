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
 * Ops (each maps 1:1 onto an IssueStore method):
 *   create   --input <CreateInput.json>            → prints the opaque id (plain text)
 *   read     <id>                                  → prints the IssueView (JSON)
 *   parse-ref <id>                                 → prints the IssueRef {slug?, issue} (JSON)
 *   annotate <id> --patch <AnnotatePatch.json>     → decorates an existing issue (ADR-0010)
 *   amend    <id> --patch <AmendPatch.json>        → amends title / free-prose sections (ADR-0025)
 *   transition <id> <queued|in-flight|in-review>   → writes one claim rung
 *   unclaim  <id>                                  → drops the claim (queued→available)
 *   close    <id> <prUrl> [--acked 0,2,3]          → records closing facts (done-reconcile; FOR-13 doneState fallback)
 *   read-closing <id>                              → prints the ClosingState (JSON): open|merged|closed-unmerged|closed-unknown
 *   listOpen                                       → prints IssueView[] (JSON)
 *   listClaimed                                    → prints IssueView[] (JSON)
 *   publishDocument --input <PublishDocumentInput.json> → prints the opaque PRD id (ADR-0011)
 *   readDocument <id>                              → prints the DocumentView (JSON)
 *   listDocuments                                  → prints DocumentView[] (JSON)
 *   triage-read <id>                               → prints the TriageView (JSON)
 *   triage-apply <id> --input <ApplyTriageInput.json> → set state/category, post comment (ADR-0015)
 *   triage-close <id> --comment <text>             → wontfix + native close (ADR-0015)
 *   flag     <id> --kind <recoverable-stop|terminal-failure> --question <q> --option <o> [--option <o> ...]  → raises needs-attention (ADR-0006)
 *   clear-flag <id>                                → clears needs-attention
 *
 * Exit codes:
 *   0 — success (result on stdout)
 *   1 — domain failure (store threw)
 *   2 — usage error, or unreadable/malformed --input file (message on stderr)
 */

import { readFileSync } from 'node:fs';
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

function usage(message: string): number {
  process.stderr.write(
    [
      `error: ${message}`,
      'usage: issue-store <create|read|parse-ref|annotate|amend|transition|unclaim|flag|clear-flag|close|read-closing|listOpen|listClaimed|publishDocument|readDocument|listDocuments|triage-read|triage-apply|triage-close> [...args] [--config <path>]',
      '',
    ].join('\n'),
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
        if (inputPath === undefined) return usage('create requires --input <path>');
        let input: CreateInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as CreateInput;
        } catch (err) {
          process.stderr.write(
            `error: cannot read --input ${inputPath}: ${(err as Error).message}\n`,
          );
          return 2;
        }
        const id = await store.create(input);
        process.stdout.write(id + '\n');
        return 0;
      }

      case 'read': {
        const id = args[1];
        if (id === undefined) return usage('read requires an <id>');
        printJson(await store.read(id));
        return 0;
      }

      case 'parse-ref': {
        const id = args[1];
        if (id === undefined) return usage('parse-ref requires an <id>');
        printJson(store.parseRef(id)); // sync, pure; throws on a non-numeric id → caught as domain failure (1)
        return 0;
      }

      case 'annotate': {
        const id = args[1];
        if (id === undefined) return usage('annotate requires an <id>');
        const patchPath = flag(args, '--patch');
        if (patchPath === undefined) return usage('annotate requires --patch <path>');
        let patch: AnnotatePatch;
        try {
          patch = JSON.parse(readFileSync(patchPath, 'utf-8')) as AnnotatePatch;
        } catch (err) {
          process.stderr.write(
            `error: cannot read --patch ${patchPath}: ${(err as Error).message}\n`,
          );
          return 2;
        }
        await store.annotate(id, patch);
        return 0;
      }

      case 'amend': {
        const id = args[1];
        if (id === undefined) return usage('amend requires an <id>');
        const patchPath = flag(args, '--patch');
        if (patchPath === undefined) return usage('amend requires --patch <path>');
        let patch: AmendPatch;
        try {
          patch = JSON.parse(readFileSync(patchPath, 'utf-8')) as AmendPatch;
        } catch (err) {
          process.stderr.write(
            `error: cannot read --patch ${patchPath}: ${(err as Error).message}\n`,
          );
          return 2;
        }
        // Whole-patch validation BEFORE any write; an empty patch is a usage
        // error (exit 2) — a change-nothing amend is a caller bug. A reserved
        // heading / unknown id is a domain failure (exit 1, the store throws).
        if (
          patch.title === undefined &&
          (patch.sections === undefined || patch.sections.length === 0)
        ) {
          return usage('amend requires a non-empty patch (title and/or sections)');
        }
        await store.amend(id, patch);
        return 0;
      }

      case 'transition': {
        const id = args[1];
        const rung = args[2];
        if (id === undefined) return usage('transition requires an <id>');
        if (rung === undefined || !(VALID_RUNGS as readonly string[]).includes(rung)) {
          return usage(
            `transition requires a rung ∈ {${VALID_RUNGS.join(', ')}}; got "${rung ?? ''}"`,
          );
        }
        await store.transition(id, rung as ClaimRung);
        return 0;
      }

      case 'unclaim': {
        const id = args[1];
        if (id === undefined) return usage('unclaim requires an <id>');
        await store.unclaim(id);
        return 0;
      }

      case 'close': {
        const id = args[1];
        const prUrl = args[2];
        if (id === undefined) return usage('close requires an <id>');
        if (prUrl === undefined) return usage('close requires a <prUrl>');
        const ackedRaw = flag(args, '--acked');
        const acked =
          ackedRaw === undefined || ackedRaw.trim() === ''
            ? []
            : ackedRaw.split(',').map((s) => Number(s.trim()));
        await store.close(id, prUrl, acked);
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
          return usage('publishDocument requires --input <path>');
        }
        let input: PublishDocumentInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as PublishDocumentInput;
        } catch (err) {
          process.stderr.write(
            `error: cannot read --input ${inputPath}: ${(err as Error).message}\n`,
          );
          return 2;
        }
        const id = await store.publishDocument(input);
        process.stdout.write(id + '\n');
        return 0;
      }

      case 'readDocument': {
        const id = args[1];
        if (id === undefined) return usage('readDocument requires an <id>');
        printJson(await store.readDocument(id));
        return 0;
      }

      case 'listDocuments': {
        printJson(await store.listDocuments());
        return 0;
      }

      case 'triage-read': {
        const id = args[1];
        if (id === undefined) return usage('triage-read requires an <id>');
        printJson(await store.readTriage(id));
        return 0;
      }

      case 'triage-apply': {
        const id = args[1];
        if (id === undefined) return usage('triage-apply requires an <id>');
        const inputPath = flag(args, '--input');
        if (inputPath === undefined) return usage('triage-apply requires --input <path>');
        let input: ApplyTriageInput;
        try {
          input = JSON.parse(readFileSync(inputPath, 'utf-8')) as ApplyTriageInput;
        } catch (err) {
          process.stderr.write(
            `error: cannot read --input ${inputPath}: ${(err as Error).message}\n`,
          );
          return 2;
        }
        await store.applyTriage(id, input);
        return 0;
      }

      case 'triage-close': {
        const id = args[1];
        if (id === undefined) return usage('triage-close requires an <id>');
        const comment = flag(args, '--comment');
        if (comment === undefined) return usage('triage-close requires --comment <text>');
        await store.closeUnplanned(id, comment);
        return 0;
      }

      case 'flag': {
        const id = args[1];
        if (id === undefined) return usage('flag requires an <id>');
        const kind = flag(args, '--kind');
        if (kind === undefined || !(NA_KINDS as readonly string[]).includes(kind)) {
          return usage(
            `flag requires --kind ∈ {${NA_KINDS.join(', ')}}; got "${kind ?? ''}"`,
          );
        }
        const question = flag(args, '--question');
        if (question === undefined) return usage('flag requires --question <q>');
        const options = flagAll(args, '--option');
        if (options.length === 0) return usage('flag requires at least one --option <o>');
        await store.flag(id, {
          kind: kind as NeedsAttentionPayload['kind'],
          question,
          options,
        });
        return 0;
      }

      case 'clear-flag': {
        const id = args[1];
        if (id === undefined) return usage('clear-flag requires an <id>');
        await store.clearFlag(id);
        return 0;
      }

      case 'read-closing': {
        const id = args[1];
        if (id === undefined) return usage('read-closing requires an <id>');
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
