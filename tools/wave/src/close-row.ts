/**
 * close-row.ts — the done-reconcile for ONE merged row, as one verb that prints
 * one result.
 *
 * ## What this replaces
 *
 * Landing a merged row used to be a shell program carried twice, as prose, in
 * two skills: `wave-close`'s phase-5 reference and `wave-resume`'s merged-row
 * paths. Twelve executable lines — capture `verdict-acked` into a shell
 * variable, guard the capture against `''` / `null` / `undefined`, parse the
 * JSON with `node -e`, then `issue-store close <id> <prUrl> --acked "$ACKED"`
 * — annotated by the block itself with the five-occurrence Convention-12 class
 * ("a command held in a shell variable, exit 127"). Two verbs that always run
 * together, glued by a shell program whose one failure mode is a silent wrong
 * answer: an empty capture derives an empty `--acked`, and `close` accepts that
 * as a legitimate "nothing met".
 *
 * This verb performs the same derivation and the same close in one process, and
 * the shell — with the failure class it was guarding against — disappears: no
 * value crosses a call boundary, because there are no call boundaries left to
 * cross. It is ADR-0034's promotion ladder applied to done-reconcile, exactly
 * as `route-tuple` applied it to the post-return sequence.
 *
 * ## …and the two spine sections that were rendered and never written
 *
 * `renderSpine` emits a `## PR-Log` heading and a `## Closed-by` section on
 * every fresh spine, and nothing in any skill or driver ever wrote into either
 * one: 102 of 102 archived spines in this repo carry both sections empty. The
 * PR-Log writer existed ({@link SpineStore.upsertPrLogRow}) and threw on exactly
 * the bare heading the renderer produces, so the library path could not write a
 * fresh spine's PR-Log at all; `spine replace-closed-by` shipped and was called
 * by nothing. The two facts those sections want — which PR closed which row —
 * are in hand at precisely this moment, so this is where they are written.
 *
 * ## The order, and why the spine goes first
 *
 *   1. `## PR-Log`    — upsert the row's line, keyed by id
 *   2. `## Closed-by` — upsert the row's line, keyed by id
 *   3. `verdict-acked` — the MAX-iter valid verdict sidecar → the met-AC indexes
 *   4. `close`        — the store records the closing facts and the cosmetic tick
 *
 * **Both spine writes precede the store call**, and that is the write-ahead
 * property (ADR-0002): the spine is the durable WAL a resume reconstructs from,
 * so a crash between 2 and 4 leaves a spine that names the closing PR and a
 * tracker that has not moved — the recoverable direction. A crash the other way
 * round would land the tracker with no local record of which PR did it, which is
 * the state the 102 empty archives are already in.
 *
 * Step 3 sits between them on purpose: it is a READ, and putting it after the
 * writes means the two spine sections are durable even when the verdict sidecar
 * turns out to be missing or corrupt (which is never a failure here — the tick
 * is cosmetic, ADR-0004).
 *
 * ## What it deliberately does NOT do
 *
 * **It does not decide `merged`.** The evidence hierarchy (ADR-0023: tracker
 * attachment > host PR state > nothing) is judgment about probes, and it stays
 * in the skill where it is written. This verb is handed a row whose merge the
 * caller has already established, and its own refusal is narrower and purely
 * mechanical: the PR cell must classify as a real PR URL under the closed-by
 * classifier. A pre-fill, a placeholder, a bare sha, prose or an empty cell is
 * refused with nothing written.
 *
 * **It does not flag, unclaim, park or archive.** Those are the Coordinator's
 * separate acts, exactly as `route-tuple` leaves `issue-store flag` outside
 * itself.
 *
 * ## Idempotence
 *
 * Every step reports which of three it did: `performed` (it acted now),
 * `performed-before` (it found the work already done and did nothing) or
 * `skipped` (this run never owed the step). A second run for the same id leaves
 * exactly one PR-Log row and exactly one Closed-by line for that id, and calls
 * `close` again with the same arguments — `close` is itself an idempotent
 * no-op-or-reconcile, so re-running it is not an error and is not reported as
 * one. Landing a SECOND id afterwards leaves the first id's two lines
 * byte-identical: both spine writes are read-then-upsert keyed by id, never a
 * rewrite of the whole section.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { ClosingState, IssueStore } from './adapters/issue-store';
import { classifyClosedBy, type ClosedByClass } from './closed-by';
import { flag, printJson } from './cli-utils';
import { resolveStore } from './cli-store';
import { closePhraseFor, slugFromSpinePath } from './compose-driver';
import { stillOpenLine } from './issue-store-cli';
import { metAcIndexes } from './reviewer-verdict-schema';
import { readSidecars, type SidecarReader } from './sidecar';
import { createSpineStore, defaultSpineIo, type SpineIo, type SpineStore } from './spine-store';
import { loadWaveConfig, type WaveConfig } from './wave-config';
import type { PlanTableRow, PrLogRowInput } from './wave-md-rw';
import {
  defineVerb,
  helpRequested,
  printVerbHelp,
  refuseUndeclared,
  type VerbContract,
} from './verb-contract';
// The printed step vocabulary is `route-tuple`'s, imported rather than
// re-declared: both verbs print a `steps[]` a Coordinator reads the same way,
// and two copies of the same three-word union is how they drift apart.
import type { StepResult, StepStatus } from './route-tuple';

// ─── The two spine lines this verb owns ──────────────────────────────────────

/**
 * The `## Closed-by` line for one row, keyed by its id.
 *
 * Paired with {@link closedByLineKey} (ADR-0016): the writer renders this shape
 * and the upsert finds it back by the same prefix, so a re-run replaces its own
 * line rather than appending a second one.
 *
 * The id is BOLD and leads the line for one reason: it is what makes the line
 * addressable. A `## Closed-by` body that is prose — which is what every
 * archived spine carries — can only ever be replaced wholesale, and replacing
 * it wholesale is exactly the defect this section is written to avoid (row 2
 * deleting row 1's line).
 */
export function renderClosedByLine(id: string, prUrl: string): string {
  return `- **${id}** — ${prUrl}`;
}

/** The addressable prefix of {@link renderClosedByLine} — the upsert's key. */
function closedByLineKey(id: string): string {
  return `- **${id}** —`;
}

/** True for ANY id-keyed Closed-by line, whoever's row it belongs to. */
function isClosedByLine(trimmed: string): boolean {
  return trimmed.startsWith('- **') && trimmed.includes('** — ');
}

/** What {@link upsertClosedByLine} did, and the body it produced. */
export interface ClosedByUpsert {
  /** The whole `## Closed-by` body, ready for `replaceClosedByBlock`. */
  body: string;
  /** `false` when the wanted line was already there, byte for byte. */
  changed: boolean;
}

/**
 * Read-then-upsert one id-keyed line into a `## Closed-by` body.
 *
 * **Never deletes.** Every line the body already carries survives — another
 * row's line, a hand-written paragraph, the `_(written at close time)_`
 * placeholder every archived spine has. The three cases, in the order they are
 * tried:
 *
 *   1. the wanted line is already there → return the body untouched
 *      (`changed: false`, which the verb reports as `performed-before`);
 *   2. a line keyed by THIS id is there with a different URL → replace that one
 *      line in place;
 *   3. no line for this id → insert after the LAST id-keyed line (so the keyed
 *      lines stay together), else after the last non-blank line of the body
 *      (so hand-written prose keeps the top), else — on the empty body
 *      `renderSpine` produces — become the body, padded by one blank line at
 *      each end in the spine's house style.
 *
 * Pure: it decides and returns bytes; the caller writes them.
 */
export function upsertClosedByLine(body: string, id: string, prUrl: string): ClosedByUpsert {
  const want = renderClosedByLine(id, prUrl);
  const key = closedByLineKey(id);
  const lines = body.split('\n');

  let mine = -1;
  let lastKeyed = -1;
  let lastContent = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    lastContent = i;
    if (isClosedByLine(trimmed)) lastKeyed = i;
    if (trimmed === want) return { body, changed: false };
    if (trimmed.startsWith(key)) mine = i;
  }

  if (mine !== -1) {
    lines[mine] = want;
    return { body: lines.join('\n'), changed: true };
  }
  if (lastKeyed !== -1) {
    lines.splice(lastKeyed + 1, 0, want);
    return { body: lines.join('\n'), changed: true };
  }
  if (lastContent !== -1) {
    lines.splice(lastContent + 1, 0, '', want);
    return { body: lines.join('\n'), changed: true };
  }
  // A body with no content at all — the shape `renderSpine` produces. One blank
  // line at each end matches the spine's house style for every other section.
  return { body: ['', want, ''].join('\n'), changed: true };
}

// ─── The PR URL this verb will close with ────────────────────────────────────

/** Where the closing PR URL came from, and what the classifier made of it. */
export interface ResolvedClosingPr {
  /** The URL to close with — non-null iff `classification` is `real-pr`. */
  url: string | null;
  /** `flag` = the explicit argument, `row` = the spine row's PR cell. */
  source: 'flag' | 'row';
  /** The closed-by classifier's verdict on the candidate. */
  classification: ClosedByClass;
  /** The raw candidate, for the refusal message. */
  candidate: string;
}

/**
 * Resolve the PR URL this close records: the explicit argument when one was
 * passed, else the spine row's own PR cell.
 *
 * The cell is read the way `route-tuple` WRITES it and the way a hand-edited
 * spine may carry it — `prUrl` is the href of a markdown-link cell
 * (`[PR#8](https://…)`) and `null` for the bare-URL cell `route-tuple` and
 * `spine set-row-pr` both write, so both forms resolve.
 *
 * The classifier is {@link classifyClosedBy}, and it is the SAME one `closed-by`
 * already answers with — this verb refuses everything that is not `real-pr`
 * (pre-fill, placeholder, sha, prose, empty), because every one of those is a
 * cell that would land on the tracker as a closing "PR" that is not one. Pure:
 * it decides, the caller refuses.
 */
export function resolveClosingPr(input: {
  explicit?: string;
  row: Pick<PlanTableRow, 'prCell' | 'prUrl'>;
}): ResolvedClosingPr {
  const fromFlag = typeof input.explicit === 'string' && input.explicit.trim() !== '';
  const candidate = fromFlag
    ? input.explicit!.trim()
    : (input.row.prUrl ?? input.row.prCell ?? '').trim();
  const classification = classifyClosedBy(candidate);
  return {
    url: classification === 'real-pr' ? candidate : null,
    source: fromFlag ? 'flag' : 'row',
    classification,
    candidate,
  };
}

// ─── Injected seams ──────────────────────────────────────────────────────────

/** Everything impure this verb touches, injectable so every branch is spec-drivable. */
export interface CloseRowDeps {
  /** The tracker. Production resolves it from `--config`. */
  store?: IssueStore;
  /** The spine's disk seam. */
  spineIo?: SpineIo;
  /** The verdict-sidecar directory reader. */
  sidecarReader?: SidecarReader;
  /**
   * Today, as `YYYY-MM-DD` — the PR-Log row's `Created` and `Merged` cells on a
   * FIRST write. Injectable so a spec's row is deterministic; a re-run never
   * reads it, because both cells are preserved from the row already on disk.
   */
  today?: string;
}

/**
 * Node fs-backed {@link SidecarReader} — the same shape `verdict-acked` and the
 * resume path use, and for the same reason: an absent dir holds no sidecars,
 * which is an answer, never an error.
 */
const fsSidecarReader: SidecarReader = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (dir, file) => readFileSync(join(dir, file), 'utf-8'),
};

// ─── Usage ───────────────────────────────────────────────────────────────────

/**
 * `close-row`'s Verb contract (ADR-0051 decision 2) — declared here, beside
 * its runner, like every other verb's. It moved here from `verb-contract.ts`'s
 * central map of the three verbs whose runner module is not a `*-cli.ts`
 * module (ADR-0051 row 1's stated exception) in the mechanical follow-up row
 * that deleted that exception; the content is unchanged.
 */
export const CLOSE_ROW_CONTRACT: VerbContract = defineVerb({
  verb: 'close-row',
  flags: [
    { canonical: '--spine', value: 'one', valueType: 'path', required: true, placeholder: '<spine>' },
    { canonical: '--id', value: 'one', valueType: 'id', required: true },
    { canonical: '--pr-url', value: 'one', valueType: 'url' },
    { canonical: '--config', value: 'one', valueType: 'path', placeholder: '<cfg>' },
    { canonical: '--repo-root', value: 'one', valueType: 'dir' },
    { canonical: '--verdicts-dir', value: 'one', valueType: 'dir' },
  ],
  positionals: { kind: 'fixed', count: 0 },
  notes: [
    '  Lands ONE merged row: upserts its `## PR-Log` row and its `## Closed-by`',
    '  line, derives the met-AC indexes from the MAX-iter valid verdict sidecar,',
    "  then calls the store's close(id, prUrl, acked). Both spine writes happen",
    '  BEFORE the store call (the spine is the WAL a resume reconstructs from).',
    "  --pr-url overrides the spine row's PR cell. Whichever is used must",
    '  classify as a real PR URL; a pre-fill, placeholder, sha, prose or empty',
    '  cell is refused with nothing written.',
    '  It does NOT decide whether the PR merged — the evidence hierarchy',
    '  (ADR-0023) stays with the caller — and it never flags, unclaims or parks.',
  ],
  output: 'json',
  outputNote: 'a single JSON result on stdout',
});

/**
 * The usage refusal: `error: …`, then this verb's OWN rendered section, exit 2
 * (issue #856).
 *
 * The private copy it replaces taught MORE than `--help` did, not less — four
 * paragraphs about the write order, the `--pr-url` precedence and what this
 * verb deliberately does not decide, reachable only by getting the call wrong.
 * Those are the contract's declared notes now, so `--help` carries them too.
 */
function usage(message: string): number {
  process.stderr.write([`error: ${message}`, ...CLOSE_ROW_CONTRACT.usage, ''].join('\n'));
  return 2;
}

// ─── The runner ──────────────────────────────────────────────────────────────

/**
 * `close-row` — land one merged row and print one JSON result.
 *
 * Exit codes:
 *   0 — the sequence completed. Read `closing.state`: a state still reading
 *       `open` is a documented, non-failing outcome (the facts were recorded;
 *       the tracker did not natively close), and the `STILL OPEN:` line on
 *       stderr says so — the same contract `issue-store close` has.
 *   1 — a domain failure: the spine has no `## Closed-by` or `## PR-Log`
 *       section to write into, a spine write threw, or the store's close threw.
 *   2 — usage: a missing `--spine`/`--id`, an unreadable config or spine, a row
 *       id that is not in the Plan-Table, or a PR cell that is not a real PR
 *       URL. Nothing is written to the spine or the store on any of them.
 */
export async function runCloseRow(args: string[], deps: CloseRowDeps = {}): Promise<number> {
  if (helpRequested(CLOSE_ROW_CONTRACT, args)) return printVerbHelp(CLOSE_ROW_CONTRACT);
  const contractRefusal = refuseUndeclared(CLOSE_ROW_CONTRACT, args);
  if (contractRefusal !== 0) return contractRefusal;

  const spinePath = flag(args, '--spine');
  const id = flag(args, '--id');

  if (!spinePath) return usage('close-row requires --spine <spine>');
  if (!id) return usage('close-row requires --id <id>');

  const configPath = flag(args, '--config') ?? 'wave.config.json';
  let config: WaveConfig;
  try {
    config = loadWaveConfig(configPath);
  } catch (err) {
    return usage(`close-row: could not load --config ${configPath}: ${(err as Error).message}`);
  }

  const repoRoot = resolve(flag(args, '--repo-root') ?? process.cwd());
  const spineAbs = isAbsolute(spinePath) ? spinePath : resolve(repoRoot, spinePath);
  const slug = slugFromSpinePath(spineAbs);

  const spineIo = deps.spineIo ?? defaultSpineIo();
  let spineStore: SpineStore;
  try {
    spineStore = createSpineStore(spineAbs, spineIo);
  } catch (err) {
    return usage(`close-row: could not read --spine ${spineAbs}: ${(err as Error).message}`);
  }

  const row = spineStore.spine().planTable.find((r) => r.id === id);
  if (row === undefined) {
    return usage(`close-row: no Plan-Table row with id ${JSON.stringify(id)} in ${spineAbs}`);
  }

  // ── the PR URL, decided BEFORE anything is written ────────────────────────
  const pr = resolveClosingPr({ explicit: flag(args, '--pr-url'), row });
  if (pr.url === null) {
    process.stderr.write(
      `error: close-row: the PR cell for row ${JSON.stringify(id)} classifies as ` +
        `${JSON.stringify(pr.classification)}, not a real PR URL ` +
        `(candidate: ${JSON.stringify(pr.candidate)}, source: ${pr.source}). A close records WHICH PR ` +
        'closed the row, so a pre-fill link, a `<PR-URL pending>` placeholder, a bare sha, free prose ' +
        'or an empty cell is refused rather than written to the tracker. Pass --pr-url <url>, or land ' +
        'the row through `route-tuple` first so the spine carries the real URL. Nothing written.\n',
    );
    return 2;
  }
  const prUrl = pr.url;

  // The `## Closed-by` section has to exist before the FIRST write happens:
  // `replaceClosedByBlock` throws without it, and discovering that after the
  // PR-Log row is already on disk would make a refusal into a half-write.
  if (spineStore.spine().closedBy.headingLine === null) {
    process.stderr.write(
      `error: close-row: ${spineAbs} has no "## Closed-by" section — this verb writes the row's ` +
        'closing line into it, and will not invent the section on a spine that was not rendered with ' +
        'one. Nothing written.\n',
    );
    return 1;
  }

  const steps: StepResult[] = [];
  const push = (step: string, status: StepStatus, detail: Record<string, unknown> = {}): void => {
    steps.push({ step, status, ...detail });
  };

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  let spineWrote = false;

  try {
    // ── 1. the `## PR-Log` row, keyed by id ─────────────────────────────────
    //
    // `Created` and `Merged` are preserved from a row already on disk: they
    // record WHEN this row first landed, so a re-run on a later day must not
    // move them — which is also what makes the whole line byte-stable, and so
    // the re-run reportable as `performed-before` rather than as a write of
    // identical-looking-but-different bytes.
    const existing = spineStore.spine().prLog.find((r) => r.id === id);
    const prLogInput: PrLogRowInput = {
      created: existing ? existing.created : today,
      id,
      prCell: prUrl,
      closes: closePhraseFor(config.store.kind, id),
      merged: existing ? existing.merged : today,
      notes: existing ? existing.notes : '—',
    };
    const prLogUnchanged =
      existing !== undefined &&
      existing.created === prLogInput.created &&
      existing.prCell === prLogInput.prCell &&
      existing.closes === prLogInput.closes &&
      existing.merged === prLogInput.merged &&
      existing.notes === prLogInput.notes;

    if (prLogUnchanged) {
      push('spine-pr-log', 'performed-before', { id, prCell: prLogInput.prCell });
    } else {
      spineStore.upsertPrLogRow(prLogInput);
      spineStore.flush();
      spineWrote = true;
      push('spine-pr-log', 'performed', {
        id,
        prCell: prLogInput.prCell,
        closes: prLogInput.closes,
        created: prLogInput.created,
        merged: prLogInput.merged,
      });
    }

    // ── 2. the `## Closed-by` line, keyed by id ─────────────────────────────
    //
    // Read-then-upsert, never a whole-section replace: a second row landing
    // afterwards must leave this one's line byte-identical.
    const closedBy = upsertClosedByLine(spineStore.spine().closedBy.body, id, prUrl);
    if (closedBy.changed) {
      spineStore.replaceClosedByBlock(closedBy.body);
      spineStore.flush();
      spineWrote = true;
      push('spine-closed-by', 'performed', { line: renderClosedByLine(id, prUrl) });
    } else {
      push('spine-closed-by', 'performed-before', { line: renderClosedByLine(id, prUrl) });
    }

    // ── 3. the met-AC indexes (the derivation `verdict-acked` prints) ───────
    //
    // Same reader, same derivation, same three-valued honesty: the MAX-iter
    // VALID verdict sidecar for this id (so a changes-requested → re-dispatch
    // cycle's stale iter-1 verdict is never picked over the latest), through
    // `metAcIndexes`. A missing or schema-invalid sidecar is NOT a failure —
    // `acked: []`, and `corrupt` tells "no verdict yet" apart from "a verdict
    // exists and failed to parse". The tick is cosmetic (ADR-0004) and is never
    // re-read as gate input, so nothing here may block the close.
    const verdictsDir =
      flag(args, '--verdicts-dir') ?? join(repoRoot, '.flotilla', 'waves', slug, 'verdicts');
    // readSidecars indexes both kinds together; only `verdictFor` is read here,
    // so point the reports half at a path guaranteed absent under the verdicts
    // dir rather than duplicating the reader (the same sidestep `verdict-acked`
    // and `render-verdict` make).
    const index = readSidecars(
      join(verdictsDir, '.close-row-no-reports'),
      verdictsDir,
      deps.sidecarReader ?? fsSidecarReader,
    );
    const hit = index.verdictFor(id);
    const acked = hit ? metAcIndexes(hit.verdict) : [];
    const verdictIter = hit ? hit.iter : null;
    const corrupt = index.corruptFor(id).filter((c) => c.kind === 'verdict').length;
    push('verdict-acked', hit ? 'performed' : 'skipped', {
      acked,
      iter: verdictIter,
      corrupt,
      verdictsDir,
      ...(hit
        ? {}
        : {
            why: 'no valid ReviewerVerdict sidecar for this id — nothing to tick (the tick is cosmetic, ADR-0004)',
          }),
    });

    // ── 4. the store's close — the ONLY tracker write, and it is last ───────
    const store = await resolveStore(args, deps.store);
    await store.close(id, prUrl, acked);
    const closing: ClosingState = await store.readClosing(id);
    push('store-close', 'performed', { prUrl, acked, closingState: closing.state });

    if (closing.state === 'open') {
      process.stderr.write(stillOpenLine(id, prUrl));
    }

    printJson({
      ok: true,
      verb: 'close-row',
      id,
      prUrl,
      prUrlSource: pr.source,
      acked,
      verdictIter,
      corruptVerdicts: corrupt,
      closing,
      steps,
      wrote: { spine: spineWrote, tracker: true },
    });
    return 0;
  } catch (err) {
    process.stderr.write(
      `error: close-row: ${(err as Error).message ?? String(err)}` +
        `${spineWrote ? ' (the spine writes that had already completed are on disk — this verb is re-runnable)' : ' — nothing written'}\n`,
    );
    return 1;
  }
}

// Only execute when this file is run directly (not when imported by cli.ts/tests).
if (require.main === module) {
  runCloseRow(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
