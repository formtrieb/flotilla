#!/usr/bin/env node
/**
 * spine-cli.ts — the thin shell the wave skills (wave-create/start/close) call
 * via `npx tsx` to read + mutate the WAVE.md orchestration spine. Most ops are
 * a pure router over the byte-preserving {@link SpineStore} (spine-store.ts):
 * they build a disk-backed store, delegate the single mutation, and flush.
 * `set-row-iter` is the one exception — it has no SpineStore method (yet), so
 * it calls the byte-preserving `wave-md-rw` writer directly against the file.
 * The CLI adds no spine logic of its own — the spine parser (wave-md-rw) validates.
 *
 * ── One entrypoint (issue #77) ────────────────────────────────────────────────
 * `cli.ts` has always ALSO routed `spine` here, which left two ways to reach the
 * same runner. The standalone path is now COLLAPSED onto the router case: the
 * direct-run block at the bottom of this file no longer dispatches on its own —
 * it forwards `process.argv` to `cli.ts`'s `main(['spine', …])`, which routes
 * straight back to {@link runSpine}. So `npx tsx tools/wave/src/spine-cli.ts
 * <op> …` survives as a documented ALIAS (the `wave-close` mechanics still spell
 * it that way) while there is exactly ONE dispatch path in the engine.
 *
 * Usage (canonical router spelling — the alias takes the same ops/args):
 *   {{wave-cli}} spine read <spine-path>
 *   {{wave-cli}} spine set-row-state <spine-path> <id> <state>
 *   {{wave-cli}} spine set-row-iter <spine-path> <id> <n>
 *   {{wave-cli}} spine set-row-pr <spine-path> <id> <pr-cell>
 *   {{wave-cli}} spine set-branch <spine-path> <id> <branch> [--model <m>]
 *   {{wave-cli}} spine replace-closed-by <spine-path> <body-file>
 *   {{wave-cli}} spine add-disclosure <spine-path> <row-id> --iter <n> --source <s> --text <t>
 *   {{wave-cli}} spine set-disposition <spine-path> <disclosure-ref> <disposition>
 *   {{wave-cli}} spine check-disclosures <spine-path>
 *
 * Ops:
 *   read              Print the current spine source to stdout (+ trailing \n).
 *   set-row-state     setRowState(id, state) then flush. The state token is
 *                     validated against ROW_STATES at this CLI boundary (the
 *                     spine writer writes any string verbatim, so an unchecked
 *                     typo would silently corrupt durable state — "fail loud").
 *   set-row-iter      setRowIter(id, n) then flush — bumps the Plan-Table
 *                     `Iter` cell and re-renders the `Reports → Verdicts`
 *                     sidecar-link cell to the <id>-<n> paths (FOR-53,
 *                     observability-only; the reconciler still reads the
 *                     max-iter sidecar off disk, ADR-0024). `wave-start` calls
 *                     this alongside `set-row-state <id> re-dispatched` at
 *                     cap=1 re-dispatch. `n` must be a positive integer — "fail
 *                     loud" at this CLI boundary, same stance as set-row-state.
 *                     Reads/writes the file directly (no SpineStore method for
 *                     this verb yet), so it is handled before the generic
 *                     store/apply/flush flow below.
 *   set-row-pr        setRowPrCell(id, prCell) then flush.
 *   set-branch        upsertDispatchLogEntry(id, branch) — records the durable
 *                     branch home (ADR-0021) resume() reads via branchesByIssueId;
 *                     optional `--model <m>` also upsertDispatchLogModel(id, m)
 *                     (ADR-0012). Then flush.
 *   replace-closed-by Read <body-file> from disk and replaceClosedByBlock(body)
 *                     then flush. The body lives in a file (not argv) so it can
 *                     carry newlines / a multi-line `## Closed-By` block.
 *
 * ── Disclosures (ADR-0027) ────────────────────────────────────────────────────
 *   add-disclosure    Capture one disclosure — a Convention-9 wiring gap, a
 *                     Convention-10 runtime residue, or a same-shaped
 *                     Reviewer/Coordinator finding — against <row-id> at
 *                     disposition `open`, then flush. Materializes the
 *                     `## Disclosures` section on a spine that predates it.
 *                     Prints the created disclosure-ref (`<row-id>.<ordinal>`)
 *                     to stdout AFTER the flush — that ref is what
 *                     `set-disposition` addresses.
 *   set-disposition   Set exactly one entry's disposition. The vocabulary is
 *                     exactly `resolved-in-slice | scope-extension | filed:<id>
 *                     | dropped:<reason>`; anything else (including `open`, the
 *                     capture default) is refused loud with NOTHING written.
 *   check-disclosures The fail-closed archive gate. Exits 0 iff no `open`
 *                     disclosure remains, non-zero otherwise — `wave-close`
 *                     reads the EXIT CODE, never this output's prose (ADR-0027
 *                     rejects a grep-the-markdown gate explicitly). Non-mutating,
 *                     and it needs its own exit code, so it is handled ahead of
 *                     the generic store/apply/flush flow (which always returns 0).
 *
 * NOTE on WHERE the disclosure vocabularies are validated. `set-row-state` /
 * `set-status` check their token HERE, at the CLI boundary, because their writer
 * stamps any string verbatim into the spine — this is the only place a typo can
 * be caught. The disclosure verbs are different: `spine-store.ts` OWNS the
 * `## Disclosures` section and its constructors enforce their own invariants, so
 * a bad `--source` / `<disposition>` / `<row-id>` throws in the DOMAIN and
 * surfaces here as exit 1 — the check cannot be bypassed by reaching the store
 * through another front end. Only shape errors argv alone can show (a missing
 * flag, a non-integer `--iter`) are caught at this boundary as usage 2.
 *
 * Exit codes:
 *   0 — success (for `check-disclosures`: the archive gate is clear)
 *   1 — domain failure: a spine mutator threw (bad row id, missing section,
 *       out-of-vocabulary disclosure source/disposition, unknown disclosure-ref)
 *       — or, for `check-disclosures`, at least one `open` disclosure remains.
 *       Both are "not clear": the gate is fail-closed, so an unreadable or
 *       corrupt spine blocks the archive exactly like an open disclosure does.
 *   2 — usage error (missing op/path/args, unknown op, bad state token, or a
 *       non-positive-integer `set-row-iter` / `add-disclosure --iter` <n>) or
 *       body-file read error
 */

import {
  createSpineStore,
  ensureDisclosuresSection,
  DISPOSITION_VOCABULARY,
  type SpineIo,
  type DisclosureSource,
  defaultSpineIo,
} from './spine-store';
import {
  ROW_STATES,
  SPINE_STATUSES,
  renderSpine,
  setRowIter,
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
      '  spine set-row-iter <spine-path> <id> <n>',
      '  spine set-row-pr <spine-path> <id> <pr-cell>',
      '  spine set-branch <spine-path> <id> <branch> [--model <m>]',
      '  spine replace-closed-by <spine-path> <body-file>',
      '  spine set-status <spine-path> <status>',
      '  spine add-disclosure <spine-path> <row-id> --iter <n> --source <worker|reviewer|coordinator> --text <t>',
      `  spine set-disposition <spine-path> <disclosure-ref> <${DISPOSITION_VOCABULARY}>`,
      '  spine check-disclosures <spine-path>',
      '',
    ].join('\n'),
  );
}

/** Value of a `--flag <value>` pair, or `undefined` when absent/valueless. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
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
    // ADR-0027: every freshly created wave carries the `## Disclosures` section
    // from birth, so the routing-time capture verb never has to grow one and the
    // archive gate always has a section to count. Composed here rather than
    // inside `renderSpine` because `wave-md-rw.ts` is outside this slice's
    // declared Files — `ensureDisclosuresSection` is idempotent, so folding the
    // call into `renderSpine` later is a pure move, not a behaviour change.
    // `spine create` is the ONLY path that produces a real wave's spine, so
    // every wave gets the section either way.
    const source = ensureDisclosuresSection(
      renderSpine(payload.meta, payload.roster, payload.conflict, payload.dorCheck),
    );
    io.write(outPath, source);
    return 0;
  }

  const path = args[1];

  if (!op || !path) {
    printUsage();
    return 2;
  }

  // `set-row-iter` has no SpineStore method (spine-store.ts is unchanged by
  // FOR-53) — it reads + writes the file directly through the wave-md-rw
  // writer, so it is handled here, ahead of the generic
  // createSpineStore/apply/store.flush() flow below (which would otherwise
  // flush the STORE's pristine, unmutated source over this op's own write).
  if (op === 'set-row-iter') {
    const id = args[2];
    const iterRaw = args[3];
    if (!id || iterRaw === undefined) {
      printUsage();
      return 2;
    }
    const iter = Number(iterRaw);
    // Fail loud at the CLI boundary — mirrors set-row-state's token check:
    // the writer accepts any number, so an unvalidated typo (non-numeric,
    // zero, negative, fractional) would silently corrupt durable state.
    if (!Number.isInteger(iter) || iter < 1) {
      process.stderr.write(
        `error: invalid iter "${iterRaw}"; expected a positive integer\n`,
      );
      return 2;
    }
    try {
      const next = setRowIter(io.read(path), id, iter);
      io.write(path, next);
      return 0;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      return 1;
    }
  }

  // `check-disclosures` is the fail-closed archive gate (ADR-0027). It mutates
  // nothing and — unlike every op below — its RESULT is the exit code, which the
  // generic flow (always 0 on success) cannot express. So it is handled here,
  // alongside `set-row-iter`, ahead of that flow.
  //
  // Fail-closed in both directions: an open disclosure blocks the archive, and so
  // does a spine that cannot be read or parsed. `wave-close` branches on this
  // code alone — it never reads the prose below (ADR-0027 rejected the
  // grep-the-markdown gate: the #141 class).
  if (op === 'check-disclosures') {
    try {
      const store = createSpineStore(path, io);
      const open = store.openDisclosures();
      const total = store.disclosures().length;
      if (open.length === 0) {
        process.stdout.write(
          `disclosures: 0 open of ${total} — archive gate CLEAR\n`,
        );
        return 0;
      }
      process.stdout.write(
        [
          `disclosures: ${open.length} open of ${total} — archive gate BLOCKED (ADR-0027)`,
          ...open.map(
            (d) =>
              `  ${d.ref}  row ${d.rowId}  iter ${d.iter}  (${d.source})  ${d.text}`,
          ),
          `disposition each: spine set-disposition ${path} <ref> <${DISPOSITION_VOCABULARY}>`,
          '',
        ].join('\n'),
      );
      return 1;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      return 1;
    }
  }

  // ── Arg-presence + token validation FIRST (all usage errors → 2). These run
  // before the try/catch so a usage 2 is never reclassified as a domain 1. The
  // `apply` closure carries the validated mutation into the single try/catch
  // below, where any spine-mutator throw (bad row id, missing section) becomes a
  // clean domain-failure exit 1 — never an uncaught stack trace.
  let apply: (store: ReturnType<typeof createSpineStore>) => void;

  // `add-disclosure` reports the ref it minted — captured here and printed only
  // AFTER the flush succeeds, so stdout never advertises a ref that never landed.
  let createdRef: string | null = null;

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

    case 'add-disclosure': {
      const rowId = args[2];
      const iterRaw = flagValue(args, '--iter');
      const sourceRaw = flagValue(args, '--source');
      const text = flagValue(args, '--text');
      // A `--`-prefixed token in the positional slot means <row-id> was OMITTED
      // and the first flag slid into its place — a usage error, not a domain
      // one ("no Plan-Table row with id --iter" would be a baffling exit 1).
      if (
        !rowId ||
        rowId.startsWith('--') ||
        iterRaw === undefined ||
        sourceRaw === undefined ||
        text === undefined
      ) {
        printUsage();
        return 2;
      }
      const iter = Number(iterRaw);
      if (!Number.isInteger(iter) || iter < 1) {
        process.stderr.write(
          `error: invalid --iter "${iterRaw}"; expected a positive integer\n`,
        );
        return 2;
      }
      // `--source` / `--text` / `<row-id>` are NOT checked here — the store's
      // constructor owns those invariants (see the NOTE in this file's header);
      // an out-of-vocabulary source throws there and lands as exit 1.
      apply = (store) => {
        createdRef = store.addDisclosure({
          rowId,
          iter,
          source: sourceRaw as DisclosureSource,
          text,
        }).ref;
      };
      break;
    }

    case 'set-disposition': {
      const ref = args[2];
      const disposition = args[3];
      if (!ref || !disposition) {
        printUsage();
        return 2;
      }
      // The vocabulary check lives in the store and throws → exit 1 with the
      // spine untouched (the throw happens before flush).
      apply = (store) => store.setDisposition(ref, disposition);
      break;
    }

    default:
      process.stderr.write(
        `unknown op: ${op}; available: create, read, set-row-state, set-row-iter, set-row-pr, set-branch, replace-closed-by, set-status, add-disclosure, set-disposition, check-disclosures\n`,
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
    if (createdRef) process.stdout.write(createdRef + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
//
// COLLAPSED onto the router (issue #77): rather than dispatching a second time
// here, the direct-module invocation is forwarded to `cli.ts`'s `spine` case —
// which routes straight back to `runSpine` above. `npx tsx
// tools/wave/src/spine-cli.ts <op> …` therefore stays a working ALIAS for
// `{{wave-cli}} spine <op> …` (the `wave-close` mechanics still document it),
// with exactly one dispatch path in the engine instead of two.
//
// `require` (not a static `import`) on purpose: `cli.ts` imports THIS module for
// its `spine` case, so a top-level import would be a load-order cycle. This line
// runs only when this file is the process entrypoint, after its own exports are
// fully initialised, so the require resolves a complete module either way.
if (require.main === module) {
  const { main } = require('./cli') as typeof import('./cli');
  process.exit(main(['spine', ...process.argv.slice(2)]));
}
