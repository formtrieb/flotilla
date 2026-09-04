/**
 * route-tuple.ts — the post-return write-ahead sequence for ONE row, as one
 * verb that prints one result.
 *
 * ## What this replaces
 *
 * Landing a single returned `{ id, risk, iteration, report, verdict }` tuple
 * used to be ten guarded shell calls: a sidecar existence probe, `route-outcome`,
 * `route-verdict`, `render-verdict` captured and consumed inside the same Bash
 * call as `host-pr create`, then `host-pr status` plus two `spine` writes plus
 * `issue-store transition` inside a second guarded call, then read-backs. The
 * mechanics reference explains at length why each capture has to be guarded
 * where it is — five live shell-variable incidents are recorded behind that
 * rule — and it worked. What it also did was re-implement a state machine in
 * shell, once per wave, with the guards as the only thing standing between a
 * mis-typed `$VAR` and a row that reads as landed with nothing behind it.
 *
 * This verb performs the same sequence, in the same order, in one process. The
 * shell disappears and the failure class it was guarding against disappears
 * with it: no value crosses a call boundary, because there are no call
 * boundaries left to cross.
 *
 * ## What it deliberately does NOT do
 *
 * **Disclosure capture stays a separate call.** Step 7.0a is judgment — reading
 * a Worker's `judgmentCalls`, a Reviewer's `reviewerFocusItems` and the
 * Coordinator's own observation, and deciding which of them is a disclosure and
 * what its disposition is. A verb that swept all three into the spine
 * mechanically would file noise as findings and, worse, would make the
 * Coordinator's own observation — the one source no payload carries — the only
 * one still needing a hand-written call. `spine add-disclosure` is unchanged and
 * stays where it is.
 *
 * **Nothing here dispatches, and nothing flags.** A `stop` outcome is REPORTED,
 * with its reason; the `issue-store flag` that follows it is the Coordinator's
 * separate act (start-mechanics step 8), and so is the re-dispatch itself.
 *
 * ## The order, and the one place it is not "spine first"
 *
 * The sequence is `start-mechanics.md` §"Routing a tuple" 7.0 → 7c, verbatim:
 *
 *   1. sidecar presence + validation (7.0)
 *   2. outcome routing        — `outcomeToEvent` → `transition` (7a)
 *   3. verdict routing        — `verdictToEvent` → `transition` (7b)
 *   4. verdict render         — the max-iter sidecar → the PR-body section (7c)
 *   5. create-or-reuse the PR — find-before-create (7c)
 *   6. status re-query        — ask the host again (7c)
 *   7. spine row state        — `pr-created` (7c)
 *   8. spine PR cell          — the URL the re-query answered (7c)
 *   9. rung transition        — `in-review` on the tracker (7c)
 *
 * The write-ahead property that matters is **the spine is written before the
 * tracker**: the spine is the durable WAL a resume reconstructs from (ADR-0002),
 * and a crash between 8 and 9 leaves a row the reconciler reads as `pr-created`
 * with a PR cell, which it correctly treats as terminal (`keep`) and heals the
 * tracker from. The HOST write cannot move behind the spine writes, and not for
 * convenience: step 8 records the PR's URL, which does not exist until step 5
 * has run. A crash between 5 and 7 is the one gap, and it is the gap the
 * sequence already had — the host holds a PR the spine does not name yet, which
 * `resume`'s host fallback (`host-pr status --branch`) is written to find, and
 * which a re-run of THIS verb resolves by reusing that PR rather than opening a
 * second one.
 *
 * ## The Operator-ruled round (`--ruling`)
 *
 * A second `changes-requested` exhausts the re-dispatch cap and stops the row.
 * The documented recovery is an Operator ruling — fix the world, re-dispatch the
 * **Reviewer only**, outside the cap — with the spine row bumped so the sidecars
 * land at the third iteration. `--ruling "<the Operator's reason>"` is what
 * admits that round here, and it had to reach THIS verb: the whole post-return
 * sequence runs through it on the ordinary dispatch path, so a ruled round
 * admitted only by the single `route-verdict` verb would land on a resume and
 * nowhere else. Without the flag an above-cap `--iter` is refused with the
 * adapter's own pre-existing message, unchanged. With it, the `route-verdict`
 * step and the top-level result both carry a `ruled` object naming the cell and
 * quoting the ruling. Cap accounting is untouched: the ruled approve reaches the
 * state an ordinary approve reaches, and a ruled changes-requested lands on the
 * cap-exhaustion STOP rather than buying the row another round.
 *
 * ## What a reuse preserves — one rule for the body AND the title
 *
 * On a reuse this verb keeps the LIVE PR's authored content and writes its own
 * section beneath it: the body's summary half survives
 * ({@link workerSummaryFromBody}) and so does the title ({@link resolveTitle}).
 * The two used to disagree — the body was preserved by acceptance criterion
 * while the title was overwritten from the spine row in the same call — and the
 * disagreement was visible in the field as one change wearing three titles: the
 * Worker's commit subject and PR title, the row title written over it here, and
 * the Worker's again on the squash commit that landed. Whatever argument keeps
 * the body keeps the title, because a title is the same claim in one line.
 * `--title` is the deliberate override, and the printed `titleSource`
 * (`flag | live-pr | row`) says which of the three the call used.
 *
 * ## Idempotence
 *
 * Every step is re-runnable and reports which of the two it did:
 * `performed` (it acted now) or `performed-before` (it found the work already
 * done and did nothing). A second run reuses the open PR instead of creating
 * another, does not append a second verdict section to the body it composes,
 * writes back the same title it found, and does not re-transition a rung
 * already at `in-review`. None of those is an error, and none is reported as
 * one.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { IssueStore } from './adapters/issue-store';
import { flag, printJson } from './cli-utils';
import { resolveStore } from './cli-store';
import { closePhraseFor, slugFromSpinePath, stripBareIds } from './compose-driver';
import {
  createOrReusePr,
  detectHost,
  findOpenPrRef,
  type Creds,
  type HostInfo,
  type HttpProbe,
  type LandingHost,
  type OpenPrRef,
  type PrLandingStatus,
} from './host-pr';
import { createCredsFor, gitRemoteUrl, landingHostFor } from './host-pr-cli';
import type { Risk } from './header-parser';
import { reconcileReportIssue, renderSidecarBody } from './route-cli';
import {
  readSidecars,
  type CorruptSidecar,
  type SidecarReader,
} from './sidecar';
import {
  renderVerdictSection,
  validateReviewerVerdict,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';
import { createSpineStore, defaultSpineIo, type SpineIo, type SpineStore } from './spine-store';
import { transition, type IssueState, type Outcome } from './stop-condition-state-machine';
import { verdictToRouting, type RuledRound, type Verdict } from './verdict-to-event';
import {
  outcomeToEvent,
  validateWorkerReport,
  type WorkerOutcome,
  type WorkerReport,
} from './worker-report-schema';
import { loadWaveConfig, type WaveConfig } from './wave-config';
import type { PlanTableRow } from './wave-md-rw';

// ─── The printed shape ───────────────────────────────────────────────────────

/**
 * What a step did. `performed-before` is the idempotence answer AC3 asks for —
 * a re-run finds the work done and says so, which is a different fact from
 * `skipped` (this branch never owed the step at all) and from an error.
 */
export type StepStatus = 'performed' | 'performed-before' | 'skipped';

/** One entry in the printed `steps[]` — the step's name, what it did, what it returned. */
export interface StepResult {
  step: string;
  status: StepStatus;
  /** Everything the step returned, flattened alongside the two fields above. */
  [detail: string]: unknown;
}

/** Where the sequence ended up. */
export type RouteTupleDisposition = 'pr-created' | 're-dispatched' | 'stop';

// ─── Pure derivations (the shell arithmetic this verb retires) ───────────────

/**
 * The state the WORKER-phase route is keyed from — iteration-keyed, because the
 * question is "which attempt just returned?": `dispatched` on the first,
 * `re-dispatched` on a cap=1 second (start-mechanics §7a's `WSTATE`).
 */
export function workerStateForIteration(iteration: number): IssueState {
  return iteration > 1 ? 're-dispatched' : 'dispatched';
}

/**
 * The state the REVIEWER-phase route is keyed from — **verdict-keyed, not
 * iteration-keyed** (start-mechanics §7b's `RSTATE`, and the single most
 * misread line in the whole routing section).
 *
 * `re-dispatched` is the ONLY state the 2nd `changes-requested`'s
 * cap-exhaustion STOP is reachable from; every other verdict/iteration cell
 * routes from `reviewing` — including an `approve` at iteration 2, which is a
 * noop FROM `re-dispatched` because `transition()` has no case for it there.
 * Keying this on the iteration alone silently turns a legitimate second-round
 * approval into a noop, which is why the derivation lives in code now rather
 * than in a `$( [ ... ] && echo ... )` a Coordinator retypes each wave.
 */
export function reviewerStateForVerdict(verdict: Verdict, iteration: number): IssueState {
  return verdict === 'changes-requested' && iteration > 1 ? 're-dispatched' : 'reviewing';
}

/** The `## Reviewer verdict` heading this verb writes and, on a re-run, cuts back off. */
const VERDICT_HEADING = '## Reviewer verdict';

/**
 * The Worker-authored summary inside a live PR body: everything ABOVE the
 * rendered verdict section, with a trailing close phrase trimmed.
 *
 * This is what makes a re-run idempotent about the body rather than merely
 * about the PR. The reuse path composes `summary + verdict + close phrase`, so
 * a second run that treated the whole live body as "the summary" would stack a
 * second verdict section (and a second close phrase) under the first, every
 * time. Cutting at the FIRST verdict heading is deliberate: a Worker who wrote
 * their own `## Reviewer verdict` prose above ours would lose it, and that is
 * the safe direction — the section this verb owns is the one it must not
 * duplicate.
 *
 * Pure, and blind to what a body means: it never invents a summary, it only
 * declines to keep the part this verb wrote.
 */
export function workerSummaryFromBody(body: string): string {
  const at = body.indexOf(VERDICT_HEADING);
  const head = at === -1 ? body : body.slice(0, at);
  // A close phrase always owns its own line (wave-shared Convention 4), so the
  // trailing-line trim is exact rather than a guess about prose.
  return head
    .split('\n')
    .filter((line) => !CLOSE_PHRASE_LINE_RE.test(line))
    .join('\n')
    .trim();
}

/**
 * A close phrase on a line it owns. Deliberately the same own-line anchoring
 * `host-pr`'s guard uses, for the same reason: a mid-sentence `resolves UTF-8 …`
 * is structurally identical to a genuine `Fixes EX-8`, and only the line
 * ownership separates them.
 */
const CLOSE_PHRASE_LINE_RE =
  /^[ \t]*(?:[-*+][ \t]+)?(?:[Cc][Ll][Oo][Ss][Ee][SsDd]?|[Ff][Ii][Xx](?:[Ee][SsDd])?|[Rr][Ee][Ss][Oo][Ll][Vv][Ee][SsDd]?)[ \t]*:?[ \t]+(?:#\d+|[A-Z][A-Z0-9]{0,9}-\d+|https?:\/\/\S+\/issues\/\d+)(?![\w-])[ \t\r]*[.,;:!?)\]}]*[ \t\r]*$/;

/** The three parts a routed PR body is composed from, in the order they appear. */
export interface PrBodyParts {
  /**
   * The Worker's own summary. On a REUSE this is the live PR body's own
   * summary half — the Worker opened the PR and wrote it, and the terminator's
   * job is to place the verdict UNDER that, never to replace it with a digest.
   * On a CREATE there is no live body, so the verdict's `workerReportDigest`
   * stands in.
   */
  summary: string;
  /** The engine-rendered `## Reviewer verdict` section (tracker ids already neutralised). */
  verdictSection: string;
  /** The store-kind close phrase — the ONE tracker id the body may name. */
  closePhrase: string;
}

/**
 * Compose the PR body: summary, then the rendered verdict section, then the
 * close phrase on the last line.
 *
 * The order is the mechanics' order and the close phrase is last for a reason
 * beyond taste — `host-pr`'s reuse guard reads the body it is handed for that
 * phrase, and a body that carries it is a body the guard lets through.
 */
export function composePrBody(parts: PrBodyParts): string {
  return [parts.summary.trim(), parts.verdictSection.trim(), parts.closePhrase.trim()]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

/**
 * Where the PR title this verb writes came from — the title's `summarySource`.
 *
 * Module-local, like every other type in this file that only ever reaches a
 * consumer as a JSON string (`StepStatus`, `RouteTupleDisposition`): the value
 * is read off the printed result, never imported.
 */
type TitleSource = 'flag' | 'live-pr' | 'row';

/** The title the reuse/create writes, and the provenance the result discloses. */
interface ResolvedTitle {
  title: string;
  titleSource: TitleSource;
}

/**
 * Resolve the PR title: `--title` if passed, else the LIVE PR's own title on a
 * reuse, else the spine row's title with bare tracker ids stripped.
 *
 * **Why the live title comes before the row title — the asymmetry this closes.**
 * One change used to carry three titles: the Worker's commit subject and the
 * title it opened the PR with (from the driver's `prTitle`), the row title this
 * verb wrote over it on reuse, and — because a single-commit squash takes its
 * subject from the commit — the Worker's again on the default branch. The
 * middle one was the odd one out, and it was odd against this verb's OWN rule:
 * {@link workerSummaryFromBody} preserves the live BODY on reuse precisely
 * because a Worker's account of its change outranks a generated summary. A
 * title is that same claim in one line, so whatever argument keeps the body
 * keeps the title. It now does.
 *
 * The three-way precedence, and what each rung is for:
 *   - `flag`    — `--title` is the Coordinator saying it means to rename the PR.
 *                 An explicit override outranks preservation, always.
 *   - `live-pr` — a reuse with no flag preserves what is on the PR, byte for
 *                 byte. Only a non-empty STRING counts: `OpenPrRef.title` is
 *                 three-valued (absent = "not readable here", never "no title"),
 *                 and an empty live title is not a claim worth preserving.
 *   - `row`     — the create path, and the reuse whose live title was
 *                 unreadable. Unchanged from what this verb always did: the
 *                 spine row's title with bare ids stripped (mention discipline),
 *                 the same narrow strip `compose-driver` applies to `prTitle`.
 *
 * Pure: it decides, it never writes. `existing` is the find the caller already
 * paid for, so this costs no second query.
 *
 * **Module-local on purpose, unlike its two body-side neighbours.**
 * {@link workerSummaryFromBody} and {@link composePrBody} are exported so their
 * properties can be pinned without a whole run; this one is not, because every
 * cell it decides is observable in the printed result (`titleSource` plus the
 * title the host was handed), so the spec drives it end to end and no new
 * module export — nor the barrel-drift allowlist entry an export would need —
 * has to be minted for a rule the JSON already discloses.
 */
function resolveTitle(input: {
  args: string[];
  existing: OpenPrRef | null;
  rowTitle: string;
  id: string;
}): ResolvedTitle {
  const flagged = flag(input.args, '--title');
  if (flagged !== undefined) return { title: flagged, titleSource: 'flag' };

  const live = input.existing?.title;
  if (typeof live === 'string' && live.trim().length > 0) {
    // Byte-identical: no strip, no trim, no re-composition. Preserving a title
    // means writing back exactly what the host reported, and a strip here would
    // silently edit a Worker-authored title on every re-run.
    return { title: live, titleSource: 'live-pr' };
  }

  return { title: stripBareIds(input.rowTitle, input.id), titleSource: 'row' };
}

// ─── Injected seams ──────────────────────────────────────────────────────────

/** Everything impure this verb touches, injectable so every branch is spec-drivable. */
export interface RouteTupleDeps {
  /** The tracker. Production resolves it from `--config`. */
  store?: IssueStore;
  /** The cross-host Basic-auth network seam `createOrReusePr` uses (ADR-0019). */
  http?: HttpProbe;
  /** The landing seam the status re-query asks (ADR-0023). Production builds it per host. */
  landingHost?: LandingHost;
  /** The environment the host credential is RESOLVED from (ADR-0029). Never printed. */
  env?: NodeJS.ProcessEnv;
  /** The spine's disk seam. */
  spineIo?: SpineIo;
  /** The sidecar directory reader. */
  sidecarReader?: SidecarReader;
  /** How a recovered sidecar reaches disk. */
  sidecarWriter?: (dir: string, file: string, content: string) => void;
  /** The git remote, when there is no repo to ask (or `--remote` was passed). */
  remoteUrl?: string;
  /** The host credential, pre-built. Production derives it per host from `env`. */
  creds?: Creds;
}

const fsSidecarReader: SidecarReader = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return []; // an absent dir holds no sidecars — never an error
    }
  },
  read: (dir, file) => readFileSync(join(dir, file), 'utf-8'),
};

function fsSidecarWriter(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, 'utf-8');
}

// ─── Usage + small readers ───────────────────────────────────────────────────

function usage(message: string): number {
  process.stderr.write(
    `error: ${message}\n` +
      'usage: flotilla-engine route-tuple --spine <spine> --id <id> --iter <n>\n' +
      '         --report <path> --verdict <path> --anchor <sha> --config <cfg>\n' +
      '         [--title <text>] [--repo-root <dir>] [--remote <url>] [--base <branch>]\n' +
      '         [--reports-dir <dir>] [--verdicts-dir <dir>] [--ruling <text>]\n' +
      '  --title renames the PR. Without it, a REUSE preserves the live PR title\n' +
      '  byte-identically (the Worker opened it and named its own change), exactly as\n' +
      '  the body preserves the live PR body; a CREATE falls back to the spine row\n' +
      '  title with bare tracker ids stripped. The result reports which of the three\n' +
      '  it used as `titleSource` (flag | live-pr | row).\n' +
      '  --ruling is the Operator\'s stated reason for a Reviewer-only round ABOVE the\n' +
      '  re-dispatch cap, and the only thing that admits an --iter above it.\n',
  );
  return 2;
}

function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** A typed refusal: the verb stops, names why, and has written nothing since. */
class RouteTupleRefusal extends Error {
  readonly name = 'RouteTupleRefusal';
  constructor(message: string) {
    super(message);
  }
}

// ─── The sidecar step (7.0) ──────────────────────────────────────────────────

/**
 * What the sidecar step found and, when it had to, restored.
 *
 * **Why this step can write, when a `stop` writes nothing.** The two are not in
 * tension: the sidecar is the DURABLE RECORD of work that already happened
 * (ADR-0024), not a routing consequence. A stopped row needs its report and
 * verdict on disk more than a landed one does — that record is what `resume`
 * reconstructs the row from, and dropping it because the routing said "stop"
 * would re-create exactly the P-1 loss the Scribe stages exist to prevent. So
 * the sequence's "performs no write at all" is about the three writes routing
 * OWNS — the spine, the host, the tracker — and this step re-materialises a
 * record that was already owed, from the very payload it was handed, never new
 * information.
 */
interface SidecarStepResult {
  report: WorkerReport;
  verdict: ReviewerVerdict;
  /** The iteration the max-iter verdict sidecar was read from (what the render is of). */
  verdictIter: number;
  detail: Record<string, unknown>;
}

function loadSidecars(input: {
  id: string;
  iter: number;
  reportsDir: string;
  verdictsDir: string;
  reportPayloadPath: string;
  verdictPayloadPath: string;
  reader: SidecarReader;
  writer: (dir: string, file: string, content: string) => void;
}): SidecarStepResult {
  const recovered: string[] = [];

  const readIndex = () => readSidecars(input.reportsDir, input.verdictsDir, input.reader);
  let index = readIndex();

  const corruptAt = (kind: 'report' | 'verdict'): CorruptSidecar | undefined =>
    index.corruptFor(input.id).find((c) => c.kind === kind && c.iter === input.iter);

  // ── the report half ──
  let reportHit = index.reportFor(input.id);
  const reportUsable = reportHit !== null && reportHit.iter >= input.iter;
  if (!reportUsable) {
    const payload = readJsonOrNull(input.reportPayloadPath);
    if (payload === null) {
      throw new RouteTupleRefusal(
        `no valid WorkerReport sidecar for row ${JSON.stringify(input.id)} at iteration ${input.iter} under ` +
          `${input.reportsDir}${corruptAt('report') ? ` (the one on disk is CORRUPT: ${corruptAt('report')!.reason})` : ''}, ` +
          `and --report ${JSON.stringify(input.reportPayloadPath)} is unreadable or is not JSON. ` +
          'Nothing has been written. Recover the record first — `write-report <payload> --dir <reportsDir> ' +
          '--id <id> --iter <n>` — then re-run this verb.',
      );
    }
    const valid = validateWorkerReport(payload);
    if (!valid.valid) {
      throw new RouteTupleRefusal(
        `--report ${JSON.stringify(input.reportPayloadPath)} is not a valid WorkerReport, so the missing ` +
          `sidecar for row ${JSON.stringify(input.id)} iter ${input.iter} cannot be recovered from it — ` +
          `nothing written:\n  - ${valid.errors.join('\n  - ')}`,
      );
    }
    const reconciled = reconcileReportIssue(payload, input.id);
    if ('error' in reconciled) {
      throw new RouteTupleRefusal(`--report: ${reconciled.error} — nothing written`);
    }
    input.writer(
      input.reportsDir,
      `${input.id}-${input.iter}.md`,
      renderSidecarBody('WorkerReport', input.id, input.iter, reconciled.payload),
    );
    recovered.push('report');
    index = readIndex();
    reportHit = index.reportFor(input.id);
  }

  // ── the verdict half ──
  let verdictHit = index.verdictFor(input.id);
  const verdictUsable = verdictHit !== null && verdictHit.iter >= input.iter;
  if (!verdictUsable) {
    const payload = readJsonOrNull(input.verdictPayloadPath);
    if (payload === null) {
      throw new RouteTupleRefusal(
        `no valid ReviewerVerdict sidecar for row ${JSON.stringify(input.id)} at iteration ${input.iter} under ` +
          `${input.verdictsDir}${corruptAt('verdict') ? ` (the one on disk is CORRUPT: ${corruptAt('verdict')!.reason})` : ''}, ` +
          `and --verdict ${JSON.stringify(input.verdictPayloadPath)} is unreadable or is not JSON. ` +
          'Nothing has been written. Recover the record first — `write-verdict <payload> --dir <verdictsDir> ' +
          '--id <id> --iter <n>` — then re-run this verb.',
      );
    }
    const valid = validateReviewerVerdict(payload);
    if (!valid.valid) {
      throw new RouteTupleRefusal(
        `--verdict ${JSON.stringify(input.verdictPayloadPath)} is not a valid ReviewerVerdict, so the missing ` +
          `sidecar for row ${JSON.stringify(input.id)} iter ${input.iter} cannot be recovered from it — ` +
          `nothing written:\n  - ${valid.errors.join('\n  - ')}`,
      );
    }
    input.writer(
      input.verdictsDir,
      `${input.id}-${input.iter}.md`,
      renderSidecarBody('ReviewerVerdict', input.id, input.iter, payload),
    );
    recovered.push('verdict');
    index = readIndex();
    verdictHit = index.verdictFor(input.id);
  }

  // Unreachable through the branches above (a recovery either wrote a record the
  // reader accepts or threw), but the reader's contract is three-valued and a
  // silent `null!` here would be the worst possible place to be optimistic.
  if (reportHit === null || verdictHit === null) {
    throw new RouteTupleRefusal(
      `the sidecars for row ${JSON.stringify(input.id)} could not be read back after recovery — ` +
        `report ${reportHit === null ? 'missing' : 'ok'}, verdict ${verdictHit === null ? 'missing' : 'ok'}. ` +
        'Nothing further was written.',
    );
  }

  return {
    report: reportHit.report,
    verdict: verdictHit.verdict,
    verdictIter: verdictHit.iter,
    detail: {
      reportsDir: input.reportsDir,
      verdictsDir: input.verdictsDir,
      reportIter: reportHit.iter,
      verdictIter: verdictHit.iter,
      recovered,
      corrupt: index.corruptFor(input.id).length,
    },
  };
}

// ─── The runner ──────────────────────────────────────────────────────────────

/**
 * `route-tuple` — perform the whole post-return sequence for one row and print
 * one JSON result.
 *
 * Exit codes:
 *   0 — the sequence completed. Read `disposition`: `pr-created` landed the PR
 *       and the rung, `re-dispatched` wrote the spine only, and `stop` is a
 *       ROUTED outcome (the row halts; `issue-store flag` is the Coordinator's
 *       separate next act), not a failure of this verb.
 *   1 — a refusal or a domain failure: an unrecoverable sidecar, a routing
 *       `noop` (a caller bug — see below), a create that failed, a status
 *       re-query that found no PR, a spine or tracker write that threw.
 *   2 — usage, an unreadable/invalid config, or an unreadable spine.
 *
 * A routing `noop` is exit 1 on purpose. With the two `--state` values derived
 * here rather than typed by hand, every verdict/iteration cell a row can reach
 * maps to a transition or a stop, so a noop means the pair that produced it is
 * not one this row could be in — a caller bug to investigate, never something
 * to log and continue past.
 */
export async function runRouteTuple(args: string[], deps: RouteTupleDeps = {}): Promise<number> {
  const spinePath = flag(args, '--spine');
  const id = flag(args, '--id');
  const iterRaw = flag(args, '--iter');
  const reportPath = flag(args, '--report');
  const verdictPath = flag(args, '--verdict');
  const anchor = flag(args, '--anchor');

  if (!spinePath) return usage('route-tuple requires --spine <spine>');
  if (!id) return usage('route-tuple requires --id <id>');
  if (iterRaw === undefined) return usage('route-tuple requires --iter <n>');
  if (!reportPath) return usage('route-tuple requires --report <path>');
  if (!verdictPath) return usage('route-tuple requires --verdict <path>');
  if (!anchor) return usage('route-tuple requires --anchor <sha>');

  const iter = Number(iterRaw);
  if (!Number.isInteger(iter) || iter < 1) {
    return usage(`route-tuple: --iter must be a positive integer, got ${JSON.stringify(iterRaw)}`);
  }

  // The Operator-ruled round reaches the whole-tuple path too, and had to: this
  // verb is what the ordinary dispatch path runs, so a ruled round admitted only
  // by the single `route-verdict` verb would work on a resume and nowhere else.
  // The flag is carried, unread, all the way to the verdict route below — the
  // adapter owns every judgment about it, including the refusal when it is
  // absent, so there is nothing here to keep in step with it.
  const ruling = flag(args, '--ruling');
  if (ruling === undefined && args.includes('--ruling')) {
    return usage(
      "route-tuple: --ruling takes the Operator's reason as its value — the ruling IS the reason, " +
        'so pass it as a quoted sentence a reader can quote back',
    );
  }

  const configPath = flag(args, '--config') ?? 'wave.config.json';
  let config: WaveConfig;
  try {
    config = loadWaveConfig(configPath);
  } catch (err) {
    process.stderr.write(
      `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
    );
    return 2;
  }

  const repoRoot = resolve(flag(args, '--repo-root') ?? process.cwd());
  const spineAbs = isAbsolute(spinePath) ? spinePath : resolve(repoRoot, spinePath);
  const slug = slugFromSpinePath(spineAbs);

  const spineIo = deps.spineIo ?? defaultSpineIo();
  let spineStore: SpineStore;
  try {
    spineStore = createSpineStore(spineAbs, spineIo);
  } catch (err) {
    process.stderr.write(`error: could not read --spine ${spineAbs}: ${(err as Error).message}\n`);
    return 2;
  }

  const row: PlanTableRow | undefined = spineStore
    .spine()
    .planTable.find((r) => r.id === id);
  if (row === undefined) {
    process.stderr.write(
      `error: route-tuple: no Plan-Table row with id ${JSON.stringify(id)} in ${spineAbs}\n`,
    );
    return 1;
  }

  const steps: StepResult[] = [];
  const push = (step: string, status: StepStatus, detail: Record<string, unknown> = {}): void => {
    steps.push({ step, status, ...detail });
  };

  try {
    // ── 1. Sidecar presence + validation (7.0) ──────────────────────────────
    const reportsDir =
      flag(args, '--reports-dir') ?? join(repoRoot, '.flotilla', 'waves', slug, 'reports');
    const verdictsDir =
      flag(args, '--verdicts-dir') ?? join(repoRoot, '.flotilla', 'waves', slug, 'verdicts');

    const sidecars = loadSidecars({
      id,
      iter,
      reportsDir,
      verdictsDir,
      reportPayloadPath: isAbsolute(reportPath) ? reportPath : resolve(repoRoot, reportPath),
      verdictPayloadPath: isAbsolute(verdictPath) ? verdictPath : resolve(repoRoot, verdictPath),
      reader: deps.sidecarReader ?? fsSidecarReader,
      writer: deps.sidecarWriter ?? fsSidecarWriter,
    });
    const recovered = sidecars.detail.recovered as string[];
    push('sidecar-check', recovered.length === 0 ? 'performed-before' : 'performed', sidecars.detail);

    const report = sidecars.report;
    const verdict = sidecars.verdict;

    // ── 2. Worker-phase routing (7a) ────────────────────────────────────────
    const workerState = workerStateForIteration(iter);
    const workerEvent = outcomeToEvent(report.outcome as WorkerOutcome);
    const workerOutcome = transition(workerState, workerEvent);
    push('route-outcome', 'performed', {
      from: workerState,
      workerOutcome: report.outcome,
      event: workerEvent,
      outcome: workerOutcome,
    });

    if (workerOutcome.type === 'stop') {
      return finishStop(steps, id, iter, 'route-outcome', workerOutcome);
    }
    if (workerOutcome.type !== 'transition') {
      throw new RouteTupleRefusal(
        `route-outcome resolved a ${workerOutcome.type} for outcome ${JSON.stringify(report.outcome)} ` +
          `from state ${JSON.stringify(workerState)} — with --state derived from the iteration, every ` +
          'reachable cell maps to a transition or a stop, so this is a caller bug to investigate. ' +
          'Nothing written.',
      );
    }
    if (workerOutcome.nextState === 're-dispatched') {
      // `needs-context` / a transient failure short-circuits review entirely.
      return finishRedispatch({
        steps,
        push,
        spineStore,
        id,
        iter,
        row,
        reason: `worker outcome ${report.outcome}`,
      });
    }

    // ── 3. Reviewer-phase routing (7b) ──────────────────────────────────────
    // The `--state` derivation is unchanged by the ruled round, and deliberately:
    // it is verdict-keyed, so an above-cap approve routes from `reviewing` (the
    // state an ordinary approve routes from) and an above-cap changes-requested
    // from `re-dispatched` (the one state the cap-exhaustion STOP is reachable
    // from). The ruling widens what the ADAPTER accepts, never what this derives.
    const reviewerState = reviewerStateForVerdict(verdict.verdict, iter);
    const reviewerRouting = verdictToRouting(
      verdict.verdict as Verdict,
      iter,
      verdict.riskClass as Risk,
      ruling,
    );
    const reviewerEvent = reviewerRouting.event;
    const ruled: RuledRound | undefined = reviewerRouting.ruled;
    const reviewerOutcome = transition(reviewerState, reviewerEvent, verdict.riskClass as Risk);
    push('route-verdict', 'performed', {
      from: reviewerState,
      verdict: verdict.verdict,
      riskClass: verdict.riskClass,
      event: reviewerEvent,
      outcome: reviewerOutcome,
      ...(ruled === undefined ? {} : { ruled }),
    });

    if (reviewerOutcome.type === 'stop') {
      return finishStop(steps, id, iter, 'route-verdict', reviewerOutcome, ruled);
    }
    if (reviewerOutcome.type !== 'transition') {
      throw new RouteTupleRefusal(
        `route-verdict resolved a ${reviewerOutcome.type} for verdict ${JSON.stringify(verdict.verdict)} ` +
          `at iteration ${iter} from state ${JSON.stringify(reviewerState)} — with --state derived by ` +
          'verdict rather than by iteration, every reachable cell maps to a transition or a stop, so this ' +
          'is a caller bug to investigate. Nothing written.',
      );
    }
    if (reviewerOutcome.nextState === 're-dispatched') {
      return finishRedispatch({
        steps,
        push,
        spineStore,
        id,
        iter,
        row,
        reason: `reviewer verdict ${verdict.verdict} at iteration ${iter}`,
      });
    }

    // ── 4-9. The approved terminator (7c) ───────────────────────────────────
    return await finishApproved({
      steps,
      push,
      args,
      deps,
      config,
      spineStore,
      id,
      iter,
      row,
      anchor,
      verdict,
      verdictIter: sidecars.verdictIter,
      report,
      ruled,
    });
  } catch (err) {
    process.stderr.write(
      `error: route-tuple: ${(err as Error).message ?? String(err)}\n`,
    );
    return 1;
  }
}

// ─── The three terminal branches ─────────────────────────────────────────────

/**
 * A `stop` — print it with its reason and perform NOTHING. Exit 0: the routing
 * ran and answered; the answer is that this row halts. `issue-store flag` is
 * the Coordinator's separate act, deliberately (start-mechanics step 8), and
 * the `next` line below says so rather than leaving it implied.
 *
 * `ruled` rides along on the two branches an Operator-ruled round can end in, so
 * the ruling is quotable off the top-level result and not only out of `steps[]`
 * — a ruled changes-requested lands HERE, on the cap-exhaustion STOP, which is
 * exactly the round whose reason a closing report most needs.
 */
function finishStop(
  steps: StepResult[],
  id: string,
  iter: number,
  phase: 'route-outcome' | 'route-verdict',
  outcome: Extract<Outcome, { type: 'stop' }>,
  ruled?: RuledRound,
): number {
  printJson({
    ok: true,
    verb: 'route-tuple',
    id,
    iter,
    disposition: 'stop' satisfies RouteTupleDisposition,
    stop: { phase, reason: outcome.reason, severity: outcome.severity },
    ...(ruled === undefined ? {} : { ruled }),
    steps,
    wrote: { spine: false, host: false, tracker: false },
    next:
      `flag the row for a human: issue-store flag ${id} --kind ` +
      `${outcome.severity === 'blocking' && outcome.reason !== 'reviewer-questions-blocking' && outcome.reason !== 'public-api-approval-required' ? 'terminal-failure' : 'recoverable-stop'} ` +
      '--question "<the decision needed>" --option "<A>" --option "<B>"',
  });
  return 0;
}

/**
 * A cap=1 re-dispatch — write the spine row state and the iteration bump,
 * touch neither the host nor the tracker, and print what the Coordinator must
 * do next (the worktree teardown, then the re-compose).
 *
 * Both spine writes go through ONE store and ONE flush. That is not tidiness:
 * mixing the store (for the state) with the raw `setRowIter` writer (for the
 * bump) flushes the store's pristine source over the raw write, which is the
 * documented reason `spine set-row-iter` handles itself ahead of the CLI's
 * generic store flow. The op now lives on the store, so the pair is atomic.
 */
function finishRedispatch(input: {
  steps: StepResult[];
  push: (step: string, status: StepStatus, detail?: Record<string, unknown>) => void;
  spineStore: SpineStore;
  id: string;
  iter: number;
  row: PlanTableRow;
  reason: string;
}): number {
  const { steps, push, spineStore, id, iter, row, reason } = input;
  const nextIter = iter + 1;

  const alreadyRedispatched = row.state === 're-dispatched';
  const alreadyBumped = Number(row.iter) >= nextIter;

  if (alreadyRedispatched && alreadyBumped) {
    push('spine-row-state', 'performed-before', { state: 're-dispatched' });
    push('spine-row-iter', 'performed-before', { iter: Number(row.iter) });
  } else {
    if (alreadyRedispatched) {
      push('spine-row-state', 'performed-before', { state: 're-dispatched' });
    } else {
      spineStore.setRowState(id, 're-dispatched');
      push('spine-row-state', 'performed', { from: row.state, state: 're-dispatched' });
    }
    if (alreadyBumped) {
      push('spine-row-iter', 'performed-before', { iter: Number(row.iter) });
    } else {
      spineStore.setRowIter(id, nextIter);
      push('spine-row-iter', 'performed', { from: row.iter, iter: nextIter });
    }
    spineStore.flush();
  }

  push('pr-create-or-reuse', 'skipped', { why: 'a re-dispatch opens no PR' });
  push('rung-transition', 'skipped', { why: 'a re-dispatch changes no tracker rung' });

  printJson({
    ok: true,
    verb: 'route-tuple',
    id,
    iter,
    disposition: 're-dispatched' satisfies RouteTupleDisposition,
    reason,
    nextIteration: nextIter,
    steps,
    wrote: { spine: !(alreadyRedispatched && alreadyBumped), host: false, tracker: false },
    next: [
      `tear down the iteration-${iter} worktree BEFORE dispatching again: worktree-cleanup --branches ${row.branch ?? `wave/${id}-<slug>`}`,
      're-compose the driver over this same spine (compose-driver), which re-reads the row and re-projects its scope grants',
    ],
  });
  return 0;
}

/**
 * The approved terminator: render, create-or-reuse, re-query, two spine writes,
 * the rung transition.
 */
async function finishApproved(input: {
  steps: StepResult[];
  push: (step: string, status: StepStatus, detail?: Record<string, unknown>) => void;
  args: string[];
  deps: RouteTupleDeps;
  config: WaveConfig;
  spineStore: SpineStore;
  id: string;
  iter: number;
  row: PlanTableRow;
  anchor: string;
  verdict: ReviewerVerdict;
  verdictIter: number;
  report: WorkerReport;
  /** Present iff this landing came through an Operator-ruled above-cap round. */
  ruled?: RuledRound;
}): Promise<number> {
  const { steps, push, args, deps, config, spineStore, id, iter, row, anchor, verdict, report, ruled } =
    input;

  const branch = row.branch;
  if (!branch) {
    throw new RouteTupleRefusal(
      `no branch is recorded for row ${JSON.stringify(id)} in the spine — the dispatch WAL records it ` +
        'BEFORE the Worker spawns (ADR-0021), so its absence means the row was never dispatched through ' +
        'this spine. Run `spine set-branch` first. Nothing written.',
    );
  }

  // ── 4. render-verdict ────────────────────────────────────────────────────
  // The row's own id is threaded in so it passes through as the close target
  // while every OTHER tracker-id-shaped token in the Reviewer's evidence is
  // neutralised. Same render the `render-verdict` verb runs — never a second one.
  const verdictSection = renderVerdictSection(verdict, {
    iteration: input.verdictIter,
    anchorSha: anchor,
    ownId: id,
  });
  push('render-verdict', 'performed', {
    fromIteration: input.verdictIter,
    anchor,
    bytes: Buffer.byteLength(verdictSection, 'utf8'),
  });

  // ── 5. create-or-reuse ───────────────────────────────────────────────────
  const remoteUrl = deps.remoteUrl ?? flag(args, '--remote') ?? gitRemoteUrl();
  const info: HostInfo = detectHost(remoteUrl);
  if (info.host === 'unknown') {
    throw new RouteTupleRefusal(
      `the git remote ${JSON.stringify(remoteUrl)} resolves to no host flotilla ships an adapter for ` +
        '(github, bitbucket). Nothing written.',
    );
  }
  const creds = deps.creds ?? createCredsFor(info.host, deps.env);
  const httpOpts = deps.http ? { http: deps.http } : {};

  // The find runs HERE rather than inside create-or-reuse because the body this
  // verb passes is composed FROM what the find returns: a Worker-authored body
  // on an already-open PR IS the summary, and only the find can supply it. The
  // answer is handed straight back so the create-or-reuse pays no second query.
  const existing: OpenPrRef | null = await findOpenPrRef(info.host, creds, branch, info, httpOpts);

  const summary =
    existing !== null && typeof existing.body === 'string' && workerSummaryFromBody(existing.body).length > 0
      ? workerSummaryFromBody(existing.body)
      : verdict.workerReportDigest;

  const closePhrase = closePhraseFor(config.store.kind, id);
  const body = composePrBody({ summary, verdictSection, closePhrase });
  const { title, titleSource } = resolveTitle({ args, existing, rowTitle: row.title, id });

  const prResult = await createOrReusePr(
    info.host,
    creds,
    { branch, title, body, destination: flag(args, '--base') ?? 'main' },
    info,
    { ...httpOpts, existing },
  );

  if (prResult.outcome === 'create-failed') {
    push('pr-create-or-reuse', 'performed', { outcome: prResult.outcome, error: prResult.error });
    throw new RouteTupleRefusal(
      `host-pr create failed for ${branch}: ${prResult.error}. Open it by hand from ` +
        `${prResult.fallbackPrefillUrl} and re-run this verb (find-before-create will reuse it). ` +
        'No spine or tracker write happened.',
    );
  }
  if (prResult.outcome === 'reuse-refused') {
    push('pr-create-or-reuse', 'performed', { outcome: prResult.outcome, reason: prResult.reason });
    throw new RouteTupleRefusal(
      `the close-phrase guard REFUSED the rewrite of ${prResult.url}: ${prResult.reason}. NO write was ` +
        'made — the PR is exactly as it was, and no spine or tracker write happened. The guard refuses ' +
        'exactly one thing: a live body that carries a close phrase being replaced by one that carries ' +
        `none. The body composed here ends with ${JSON.stringify(closePhrase)}, so if that was not ` +
        'recognised as a phrase, the row id is not a shape a tracker resolves (the guard reads `#<digits>`, ' +
        '`TEAM-<digits>` or an issue URL, on a line it owns). Fix the id or the store kind rather than ' +
        'reaching for --allow-close-phrase-loss, which discards the very phrase this refusal is protecting.',
    );
  }
  push('pr-create-or-reuse', prResult.outcome === 'created' ? 'performed' : 'performed-before', {
    outcome: prResult.outcome,
    url: prResult.url,
    ...(prResult.updated === undefined ? {} : { updated: prResult.updated }),
    summarySource: existing !== null && summary !== verdict.workerReportDigest ? 'live-pr-body' : 'workerReportDigest',
    // The title's own provenance, reported the way the body reports its summary
    // source — because the two are now decided by the same rule and a reader
    // who can see one and not the other cannot tell a preserved title from a
    // coincidentally identical one.
    titleSource,
  });

  // ── 6. status re-query ───────────────────────────────────────────────────
  // Ask the HOST, do not trust the value the create just handed back. This is
  // the same re-query the shell sequence made, and it survives the collapse into
  // one process for a reason that outlives the shell: `create`'s answer is about
  // the call, the re-query's answer is about the PR.
  const landing: LandingHost = deps.landingHost ?? (await landingHostFor(info, remoteUrl, { env: deps.env }));
  const status: PrLandingStatus = await landing.getPrStatus(branch);
  push('pr-status', 'performed', { state: status.state, url: status.url });

  const prUrl = status.url;
  if (status.state === 'none' || !prUrl) {
    throw new RouteTupleRefusal(
      `host-pr status reports ${JSON.stringify(status.state)} and no URL for ${branch} — the host does not ` +
        'know a PR for this branch, so the row is NOT flipped to pr-created and the PR cell stays empty. ' +
        'No spine or tracker write happened.',
    );
  }

  // ── 7. spine row state ───────────────────────────────────────────────────
  const alreadyPrCreated = row.state === 'pr-created';
  // Both cell forms count as "already recorded". `prUrl` is the href of a
  // MARKDOWN-LINK cell (`[PR#8](https://…)`) and is `null` for the bare-URL cell
  // this verb and `spine set-row-pr` both write — so comparing only the parsed
  // href would report `performed` on every re-run of a row this verb itself
  // landed, which is precisely the idempotence claim being made here.
  const alreadyPrCell = row.prCell === prUrl || row.prUrl === prUrl;
  if (alreadyPrCreated) {
    push('spine-row-state', 'performed-before', { state: 'pr-created' });
  } else {
    spineStore.setRowState(id, 'pr-created');
    push('spine-row-state', 'performed', { from: row.state, state: 'pr-created' });
  }

  // ── 8. spine PR cell ─────────────────────────────────────────────────────
  if (alreadyPrCell) {
    push('spine-row-pr', 'performed-before', { prCell: prUrl });
  } else {
    spineStore.setRowPrCell(id, prUrl);
    push('spine-row-pr', 'performed', { from: row.prCell, prCell: prUrl });
  }
  const spineWrote = !alreadyPrCreated || !alreadyPrCell;
  if (spineWrote) spineStore.flush();

  // ── 9. rung transition ───────────────────────────────────────────────────
  // The spine is flushed FIRST: it is the WAL a resume reconstructs from, and a
  // crash between the two leaves a row the reconciler reads as terminal and
  // heals the tracker from — the recoverable direction.
  const store = await resolveStore(args, deps.store);
  const before = await store.read(id);
  let rungStatus: StepStatus;
  if (before.status === 'in-review' || before.status === 'done') {
    rungStatus = 'performed-before';
    push('rung-transition', 'performed-before', { rung: 'in-review', trackerStatus: before.status });
  } else {
    await store.transition(id, 'in-review');
    const after = await store.read(id);
    rungStatus = 'performed';
    push('rung-transition', 'performed', {
      from: before.status,
      rung: 'in-review',
      trackerStatus: after.status,
    });
  }

  printJson({
    ok: true,
    verb: 'route-tuple',
    id,
    iter,
    disposition: 'pr-created' satisfies RouteTupleDisposition,
    branch,
    prUrl,
    title,
    titleSource,
    ...(ruled === undefined ? {} : { ruled }),
    steps,
    wrote: {
      spine: spineWrote,
      host: prResult.outcome === 'created' || prResult.updated === true,
      tracker: rungStatus === 'performed',
    },
    reportOutcome: report.outcome,
  });
  return 0;
}

// Only execute when this file is run directly (not when imported by cli.ts/tests).
if (require.main === module) {
  runRouteTuple(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
