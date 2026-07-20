#!/usr/bin/env node
/**
 * spine-cli.ts — the thin shell the wave skills (wave-create/start/close) call
 * via `npx tsx` to read + mutate the WAVE.md orchestration spine. It is a pure
 * router over the byte-preserving {@link SpineStore} (spine-store.ts): every op
 * builds a disk-backed store, delegates the single mutation, and flushes. The
 * CLI adds no spine logic of its own — the spine parser (wave-md-rw) validates.
 *
 * Usage:
 *   npx tsx tools/wave/src/spine-cli.ts read <spine-path>
 *   npx tsx tools/wave/src/spine-cli.ts set-row-state <spine-path> <id> <state>
 *   npx tsx tools/wave/src/spine-cli.ts set-row-pr <spine-path> <id> <pr-cell>
 *   npx tsx tools/wave/src/spine-cli.ts set-branch <spine-path> <id> <branch> [--model <m>]
 *   npx tsx tools/wave/src/spine-cli.ts replace-closed-by <spine-path> <body-file>
 *
 * Ops:
 *   read              Print the current spine source to stdout (+ trailing \n).
 *   set-row-state     setRowState(id, state) then flush. The state token is
 *                     validated against ROW_STATES at this CLI boundary (the
 *                     spine writer writes any string verbatim, so an unchecked
 *                     typo would silently corrupt durable state — "fail loud").
 *   set-row-pr        setRowPrCell(id, prCell) then flush.
 *   set-branch        upsertDispatchLogEntry(id, branch) — records the durable
 *                     branch home (ADR-0021) resume() reads via branchesByIssueId;
 *                     optional `--model <m>` also upsertDispatchLogModel(id, m)
 *                     (ADR-0012). Then flush.
 *   replace-closed-by Read <body-file> from disk and replaceClosedByBlock(body)
 *                     then flush. The body lives in a file (not argv) so it can
 *                     carry newlines / a multi-line `## Closed-By` block.
 *
 * Exit codes:
 *   0 — success
 *   1 — domain failure: a spine mutator threw (bad row id, missing section)
 *   2 — usage error (missing op/path/args, unknown op, bad state token) or
 *       body-file read error
 */

import { createSpineStore, type SpineIo, defaultSpineIo } from './spine-store';
import {
  ROW_STATES,
  SPINE_STATUSES,
  renderSpine,
  type RowState,
  type SpineMeta,
  type SpineRosterRow,
  type ConflictMap,
} from './wave-md-rw';

function printUsage(): void {
  process.stderr.write(
    [
      'usage:',
      '  spine create <out-path> <payload-file>',
      '  spine read <spine-path>',
      '  spine set-row-state <spine-path> <id> <state>',
      '  spine set-row-pr <spine-path> <id> <pr-cell>',
      '  spine set-branch <spine-path> <id> <branch> [--model <m>]',
      '  spine replace-closed-by <spine-path> <body-file>',
      '  spine set-status <spine-path> <status>',
      '',
    ].join('\n'),
  );
}

export function runSpine(args: string[], io: SpineIo = defaultSpineIo()): number {
  const op = args[0];

  // `create` renders a NEW spine — there is no existing file to load, so it
  // cannot use the shared createSpineStore(path) path below.
  if (op === 'create') {
    const outPath = args[1];
    const payloadFile = args[2];
    if (!outPath || !payloadFile) {
      printUsage();
      return 2;
    }
    let payload: { meta: SpineMeta; roster: SpineRosterRow[]; conflict: ConflictMap; dorCheck: string };
    try {
      payload = JSON.parse(io.read(payloadFile));
    } catch (err) {
      process.stderr.write(`error: could not read/parse payload "${payloadFile}": ${(err as Error).message}\n`);
      return 2;
    }
    const source = renderSpine(payload.meta, payload.roster, payload.conflict, payload.dorCheck);
    io.write(outPath, source);
    return 0;
  }

  const path = args[1];

  if (!op || !path) {
    printUsage();
    return 2;
  }

  // ── Arg-presence + token validation FIRST (all usage errors → 2). These run
  // before the try/catch so a usage 2 is never reclassified as a domain 1. The
  // `apply` closure carries the validated mutation into the single try/catch
  // below, where any spine-mutator throw (bad row id, missing section) becomes a
  // clean domain-failure exit 1 — never an uncaught stack trace.
  let apply: (store: ReturnType<typeof createSpineStore>) => void;

  switch (op) {
    case 'read': {
      apply = (store) => process.stdout.write(store.source() + '\n');
      break;
    }

    case 'set-row-state': {
      const id = args[2];
      const state = args[3];
      if (!id || !state) {
        printUsage();
        return 2;
      }
      // Validate the state token at the CLI boundary: the spine writer writes
      // ANY string verbatim, so an unvalidated typo would silently corrupt
      // durable state. Mirror issue-store-cli's rung check — fail loud (return 2).
      if (!(ROW_STATES as readonly string[]).includes(state)) {
        process.stderr.write(
          `error: invalid state "${state}"; expected one of: ${ROW_STATES.join(', ')}\n`,
        );
        return 2;
      }
      apply = (store) => store.setRowState(id, state as RowState);
      break;
    }

    case 'set-row-pr': {
      const id = args[2];
      const prCell = args[3];
      if (!id || prCell === undefined) {
        printUsage();
        return 2;
      }
      apply = (store) => store.setRowPrCell(id, prCell);
      break;
    }

    case 'replace-closed-by': {
      const bodyFile = args[2];
      if (!bodyFile) {
        printUsage();
        return 2;
      }
      let body: string;
      try {
        body = io.read(bodyFile);
      } catch (err) {
        process.stderr.write(
          `error: could not read body-file "${bodyFile}": ${(err as Error).message}\n`,
        );
        return 2;
      }
      apply = (store) => store.replaceClosedByBlock(body);
      break;
    }

    case 'set-branch': {
      // Records a dispatched row's branch (the DURABLE branch home, ADR-0021) in
      // the Resume-Metadata dispatch-log — resume() joins worktrees to rows by
      // this branch. Optional `--model <m>` co-records the dispatched model
      // (ADR-0012). Mirrors set-row-pr's exit semantics (0/1/2).
      const id = args[2];
      const branch = args[3];
      if (!id || !branch) {
        printUsage();
        return 2;
      }
      let model: string | undefined;
      const mi = args.indexOf('--model');
      if (mi !== -1) {
        model = args[mi + 1];
        if (!model) {
          printUsage();
          return 2;
        }
      }
      apply = (store) => {
        store.upsertDispatchLogEntry(id, branch);
        if (model) store.upsertDispatchLogModel(id, model);
      };
      break;
    }

    case 'set-status': {
      const status = args[2];
      if (!status) {
        printUsage();
        return 2;
      }
      if (!(SPINE_STATUSES as readonly string[]).includes(status)) {
        process.stderr.write(
          `error: invalid status "${status}"; expected one of: ${SPINE_STATUSES.join(', ')}\n`,
        );
        return 2;
      }
      apply = (store) => store.setFrontmatterStatus(status);
      break;
    }

    default:
      process.stderr.write(
        `unknown op: ${op}; available: create, read, set-row-state, set-row-pr, set-branch, replace-closed-by, set-status\n`,
      );
      return 2;
  }

  // ── Store construction + the (possibly throwing) mutation + flush. A throw
  // here is a domain failure (bad row id, missing section) → clean exit 1.
  try {
    const store = createSpineStore(path, io);
    apply(store);
    // `read` is non-mutating; flushing it is a harmless byte-identical no-op.
    if (op !== 'read') store.flush();
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
if (require.main === module) {
  process.exit(runSpine(process.argv.slice(2)));
}
