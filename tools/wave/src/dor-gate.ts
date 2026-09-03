/**
 * 5-Gate Definition-of-Ready validator for a single wave-eligible issue.
 *
 * Provenance:     the wave-orchestration PRD's §S2 (issue #05's
 *                 wave-validate-skill slice), planned in the predecessor
 *                 wave-orchestration system flotilla was seeded from. Named,
 *                 not pathed: that system's planning tree (previously cited
 *                 here by two direct paths) never existed in THIS repo and is
 *                 in no published tarball, so the citations resolved only
 *                 where they were written. The live specification is the
 *                 gate list below plus this module's spec
 *                 (`shipped-citation-guard.spec.ts`).
 *
 * The gates:
 *
 *   1. Header-Block present + parseable (delegates to header-parser)
 *   2. `Files:` globs expand without error against the repo file tree
 *   3. AC-section internally consistent (heuristic; warn-only)
 *   4. Risk-class consistent with file count (warn-only)
 *   5. `Blocked by:` chain resolves to issues that exist
 *   6. AC bodies do not mention file paths absent from `Files:` header (warn-only)
 *   7. Literal `Files:` entries exist on disk (advisory warn-only)
 *   8. Declared `Files:` intersect at least one configured verify profile's
 *      `appliesTo` (advisory warn-only) — see {@link checkVerifyProfileCoverage}.
 *      A row whose files match no profile is not wrong (some work has no
 *      automated gate) but it must be *stated*, not silently equivalent to a
 *      fully verify-backed approve (FOR-127).
 *   9. The **staleness advisory**: has the repo's default branch touched any of
 *      the row's declared `Files:` since the tracker last recorded a change to
 *      the row? — see {@link checkFilesTouchedSinceTrackerUpdate}. Advisory
 *      warn-only in every path, by decision, never a FAIL.
 *
 * Pure function modulo three side-effects: file-glob expansion (`fastGlob`),
 * blocked-by / literal-file existence checks (`statSync`/`existsSync`), and — for
 * gate 9 only — read-only `git` invocations against the checkout (`execFileSync`,
 * the same shape `files-drift` already uses). All three honor the `repoRoot`
 * option, so tests can point at a fixtures dir.
 *
 * Two entrypoints (ADR-0014):
 *   - {@link validateIssue} — the file path: re-parses a raw markdown `source`.
 *   - {@link validateIssueView} — the non-file (`dor --id`) path: runs over a
 *     structured, store-agnostic `IssueView`. Store-blind — it branches only on
 *     the capabilities present (`repoRoot`), so the gates fall into three classes:
 *     **self-content** (run anywhere), **working-tree** (run iff a checkout is
 *     given, else `'deferred'`), and **cross-issue** (`blocked-by`, `'deferred'`
 *     on a bare id in M1 — re-homed onto the IssueStore in P2a).
 *
 * A *malformed* `Blocked by:` (non-empty, not `none`, no parseable ref — e.g. the
 * human-readable `FOR-23` where the wire form is `FOR#23`) never reaches Gate 5
 * as a fabricated `'none'` (FOR-31 / W4-F2). On the {@link validateIssue} file
 * path the header-parser rejects it, so Gate 1 (`header-parseable`) FAILs. On the
 * {@link validateIssueView} path the store's `read()` already threw in the body
 * codec's fail-loud `parseBlockedBy`, so the `dor --id` verb surfaces the loud
 * read error instead of ever constructing a PASS view. Absence is not evidence:
 * a row that cannot state its dependencies is not grabbable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import fastGlob from 'fast-glob';
import micromatch from 'micromatch';
import {
  parseHeaderBlock,
  DEFAULT_WAVE_SCHEMA,
  type HeaderBlock,
  type IssueRef,
  type ParseError,
} from './header-parser';
import { validateHeaderBlock, type IssueView, type WaveSchema } from './contract';
import { verifyCommands, type VerifyConfig } from './verify';

/**
 * `'deferred'` (ADR-0014): a gate that cannot run in the current context because
 * its data source is absent — neither pass nor fail, and distinct from a `'warn'`
 * (which means the gate *ran* and found a soft issue). Like `'warn'`, it never
 * flips `overall` to FAIL. Emitted by {@link validateIssueView} for the
 * working-tree gates when no `repoRoot` is supplied and for the cross-issue gate.
 */
export type GateStatus = 'pass' | 'fail' | 'warn' | 'deferred';

export interface GateResult {
  name: string;
  status: GateStatus;
  reason?: string;
}

export interface DorResult {
  overall: 'PASS' | 'FAIL';
  gates: GateResult[];
  header?: HeaderBlock;
}

/**
 * A single WARN-level finding from the AC-files-coverage check (gate 6).
 * Returned by `acFilesCoverageCheck()`; also surfaced in `DorResult.gates`
 * as a rolled-up `GateResult` when warnings are present.
 */
export interface AcFilesCoverageWarn {
  level: 'warn';
  /** Human-readable description including the offending AC bullet (≤80 chars). */
  message: string;
  /** Normalised path(s) that should be added to the `Files:` header. */
  suggestions: string[];
}

export interface ValidateOptions {
  /** Absolute path to the repo root. Files globs + blocked-by refs resolve relative to it. */
  repoRoot: string;
  /** Absolute path to the issue markdown file. Drives the same-slug blocked-by lookup. */
  issuePath: string;
  /** Issue body source. Required (the caller already read the file). */
  source: string;
  /**
   * Optional consumer verify profiles (`wave.config.json`'s `verify`, ADR-0016).
   * Drives Gate 8 ({@link checkVerifyProfileCoverage}). Absent → the gate
   * `defer`s (this call was never handed a config at all — resolvable by
   * passing one, see {@link DEFER_NO_VERIFY_CONFIG}) rather than silently
   * passing or spamming a warn — distinct from a consumer that legitimately
   * configured zero profiles (`{ profiles: [] }`), which is a real "no
   * automated gate anywhere" state and stays a `pass` carrying a note
   * ({@link NOTE_VERIFY_PROFILES_EMPTY}, issue #676) rather than a silent one
   * (AC4 — the check is about a profile existing and not matching, not about
   * the absence of profiles).
   */
  verify?: VerifyConfig;
  /**
   * ISO-8601 instant of the row's last TRACKER update — the `since` the
   * staleness advisory (gate 9) measures from. Optional override for the file
   * path: absent, the gate falls back to the issue file's own mtime, which IS
   * the markdown store's tracker-update signal (there is no other tracker
   * behind a `.scratch/` file). Unreadable/unparseable either way → the gate
   * `defer`s, never passes.
   */
  trackerUpdatedAt?: string;
}

/**
 * Run all five gates and aggregate. `fail` on any single gate flips overall to
 * FAIL; `warn` does not.
 */
export function validateIssue(opts: ValidateOptions): DorResult {
  const gates: GateResult[] = [];

  // Gate 1 — Header parseable
  const parsed = parseHeaderBlock(opts.source);
  if (!parsed.ok) {
    gates.push({
      name: 'header-parseable',
      status: 'fail',
      reason: formatParseErrors(parsed.errors),
    });
    return { overall: 'FAIL', gates };
  }
  gates.push({ name: 'header-parseable', status: 'pass' });
  const header = parsed.header;

  // Gate 2 — Files-glob valid
  gates.push(checkFilesGlobs(header, opts.repoRoot));

  // Gate 3 — AC-section consistency (heuristic, warn-only)
  gates.push(checkAcSection(opts.source));

  // Gate 4 — Risk consistent with file count (warn-only)
  gates.push(checkRiskFileCount(header));

  // Gate 5 — Blocked-by chain resolves
  gates.push(checkBlockedByChain(header, opts.issuePath, opts.repoRoot));

  // Gate 6 — AC bodies do not mention uncovered file paths (warn-only)
  gates.push(checkAcFilesCoverage(header, opts.source));

  // Gate 7 — Literal Files: entries exist on disk (advisory warn-only)
  gates.push(checkLiteralFilesExistence(header, opts.repoRoot));

  // Gate 8 — Files intersect at least one configured verify profile (advisory warn-only)
  gates.push(
    checkVerifyProfileCoverage(header.files, opts.verify, opts.repoRoot),
  );

  // Gate 9 — staleness advisory (advisory warn-only). The file path has no
  // tracker behind it, so the issue FILE's own mtime is the tracker-update
  // signal (exactly what MarkdownFsStore reports as `trackerUpdatedAt`); an
  // explicit `opts.trackerUpdatedAt` overrides it.
  gates.push(
    checkFilesTouchedSinceTrackerUpdate(
      header.files,
      opts.trackerUpdatedAt ?? fileMtimeIso(opts.issuePath),
      opts.repoRoot,
    ),
  );

  const failed = gates.some((g) => g.status === 'fail');
  return {
    overall: failed ? 'FAIL' : 'PASS',
    gates,
    header,
  };
}

/** The issue file's own mtime as an ISO instant, or `undefined` if it cannot be stat'd. */
function fileMtimeIso(issuePath: string): string | undefined {
  try {
    return statSync(issuePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** Options for the structured (non-file) entrypoint {@link validateIssueView}. */
export interface ValidateViewOptions {
  /** Enum vocabulary for the Gate-1 schema-membership check. Defaults to {@link DEFAULT_WAVE_SCHEMA}. */
  schema?: WaveSchema;
  /**
   * Absolute repo-checkout path. When present, the working-tree gates run against
   * it; when absent they `defer` (capability-conditional — ADR-0014).
   */
  repoRoot?: string;
  /**
   * Optional consumer verify profiles (`wave.config.json`'s `verify`, ADR-0016).
   * Drives Gate 8 ({@link checkVerifyProfileCoverage}). See {@link ValidateOptions.verify}
   * for the absent-vs-zero-profiles distinction (AC4).
   */
  verify?: VerifyConfig;
}

const DEFER_NO_WORKTREE =
  'No repo checkout in this context — runs at wave-create, where a worktree exists.';
const DEFER_CROSS_ISSUE =
  'Cross-issue gate — resolving blocked-by on a bare id needs an IssueStore membership lookup (re-homed in P2a, ADR-0001).';

/**
 * Definition-of-Ready over a structured {@link IssueView} — the non-file
 * entrypoint (`dor --id`, ADR-0014). Store-blind: it branches only on the
 * capabilities present (`repoRoot`), never on the issue's tracker of origin.
 *
 * Self-content gates run on the view's fields; working-tree gates `defer`
 * unless a `repoRoot` is supplied; the cross-issue gate `defer`s in M1.
 */
export function validateIssueView(
  view: IssueView,
  opts: ValidateViewOptions = {},
): DorResult {
  const schema = opts.schema ?? DEFAULT_WAVE_SCHEMA;
  const { repoRoot } = opts; // capture for narrowing — working-tree gates need it
  const gates: GateResult[] = [];

  // Gate 1 — header-parseable → schema-membership on the structured fields
  const hv = validateHeaderBlock(
    { risk: view.risk, worker: view.worker },
    schema,
  );
  if (!hv.valid) {
    gates.push({
      name: 'header-parseable',
      status: 'fail',
      reason: hv.errors.join('; '),
    });
    return { overall: 'FAIL', gates };
  }
  gates.push({ name: 'header-parseable', status: 'pass' });

  // Gate 2 — Files-glob valid: working-tree gate (defer without a checkout)
  gates.push(
    repoRoot !== undefined
      ? checkFilesGlobs({ files: view.files }, repoRoot)
      : { name: 'files-glob-valid', status: 'deferred', reason: DEFER_NO_WORKTREE },
  );

  // Gate 3 — AC-section consistency (heuristic, warn-only) — structured form
  gates.push(checkAcSectionView(view.acceptanceCriteria));

  // Gate 4 — Risk consistent with file count (warn-only) — helper reused verbatim
  gates.push(checkRiskFileCount({ risk: view.risk, files: view.files }));

  // Gate 5 — cross-issue gate: deferred on a bare id in M1 (re-home is P2a)
  gates.push({
    name: 'blocked-by-chain-resolves',
    status: 'deferred',
    reason: DEFER_CROSS_ISSUE,
  });

  // Gate 6 — AC bodies do not mention uncovered file paths (warn-only).
  // The coverage check wants raw bullet prose; rebuild it from the structured
  // AC array (the same text that the markdown `- [ ]` wrapper would carry).
  gates.push(acCoverageGate(view.files, reconstructAcBody(view.acceptanceCriteria)));

  // Gate 7 — literal Files: entries exist (advisory warn-only): working-tree gate
  gates.push(
    repoRoot !== undefined
      ? checkLiteralFilesExistence({ files: view.files }, repoRoot)
      : { name: 'literal-files-exist', status: 'deferred', reason: DEFER_NO_WORKTREE },
  );

  // Gate 8 — Files intersect at least one configured verify profile (advisory warn-only)
  gates.push(checkVerifyProfileCoverage(view.files, opts.verify, repoRoot));

  // Gate 9 — staleness advisory (advisory warn-only): working-tree gate, and
  // additionally conditioned on the view carrying a tracker-update timestamp at
  // all. Nothing is threaded through the options here — the `since` rides on the
  // canonical contract itself (`IssueView.trackerUpdatedAt`), so a store-backed
  // caller gets it for free and the entrypoint stays store-blind.
  gates.push(
    checkFilesTouchedSinceTrackerUpdate(
      view.files,
      view.trackerUpdatedAt,
      repoRoot,
    ),
  );

  const failed = gates.some((g) => g.status === 'fail');
  return { overall: failed ? 'FAIL' : 'PASS', gates };
}

/**
 * Rebuild a markdown AC-section body from the structured {@link IssueView}
 * acceptance-criteria array, so the source-string gate helpers (Gate 6) can run
 * on the non-file path. Mirrors the `- [ ] <text>` wrapper a markdown issue carries.
 */
function reconstructAcBody(
  acs: { text: string; checked: boolean }[],
): string {
  return acs.map((ac) => `- [${ac.checked ? 'x' : ' '}] ${ac.text}`).join('\n');
}

/**
 * Structured form of {@link checkAcSection} (Gate 3) for the non-file path:
 * the heuristic on the raw `## Acceptance criteria` section becomes a check on
 * the parsed array — at least one criterion, none with empty text. Warn-only.
 */
function checkAcSectionView(
  acs: { text: string; checked: boolean }[],
): GateResult {
  if (acs.length === 0) {
    return {
      name: 'ac-section-consistent',
      status: 'warn',
      reason: 'Issue has no acceptance criteria.',
    };
  }
  const empty = acs.filter((ac) => ac.text.trim().length === 0);
  if (empty.length > 0) {
    return {
      name: 'ac-section-consistent',
      status: 'warn',
      reason: `${empty.length} empty acceptance-criterion text(s) found.`,
    };
  }
  return { name: 'ac-section-consistent', status: 'pass' };
}

function formatParseErrors(errors: ParseError[]): string {
  return errors
    .map((e) => `line ${e.line}${e.field ? ` [${e.field}]` : ''}: ${e.message}`)
    .join('; ');
}

// ─── Gate 2: Files-glob valid ──────────────────────────────────────────────

function checkFilesGlobs(
  header: { files: readonly string[] },
  repoRoot: string,
): GateResult {
  const empty: string[] = [];
  for (const entry of header.files) {
    if (isLikelyGlob(entry)) {
      const matches = fastGlob.sync(entry, {
        cwd: repoRoot,
        dot: true,
        onlyFiles: false,
      });
      if (matches.length === 0) empty.push(entry);
    } else {
      // Concrete path — either it already lives in the repo or it's a net-new
      // file the issue will create. The DOR-Gate cannot tell which; missing
      // concrete paths are NOT a failure. We still poke fastGlob so a
      // malformed pattern (unbalanced brackets, etc.) gets reported.
      try {
        fastGlob.sync(entry, { cwd: repoRoot, dot: true, onlyFiles: false });
      } catch (err) {
        return {
          name: 'files-glob-valid',
          status: 'fail',
          reason: `"${entry}" is not a valid glob: ${(err as Error).message}`,
        };
      }
    }
  }
  if (empty.length > 0) {
    return {
      name: 'files-glob-valid',
      status: 'warn',
      reason: `Glob(s) match nothing: ${empty.join(', ')} (acceptable if the issue creates these files; verify before dispatch).`,
    };
  }
  return { name: 'files-glob-valid', status: 'pass' };
}

function isLikelyGlob(entry: string): boolean {
  return /[*?[\]{}]/.test(entry);
}

// ─── Gate 3: AC-section consistency (heuristic, warn-only) ─────────────────

function checkAcSection(source: string): GateResult {
  const sectionMatch = /^##\s+Acceptance\s+criteria\s*$/im.exec(source);
  if (!sectionMatch) {
    return {
      name: 'ac-section-consistent',
      status: 'warn',
      reason:
        'No "## Acceptance criteria" section found — heuristic check skipped.',
    };
  }
  const after = source.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = /^##\s+/m.exec(after);
  const body = nextSection ? after.slice(0, nextSection.index) : after;

  const boxes = [...body.matchAll(/^- \[([ x])\]\s*(.*)$/gm)];
  if (boxes.length === 0) {
    return {
      name: 'ac-section-consistent',
      status: 'warn',
      reason: 'Acceptance criteria section has no `- [ ]` / `- [x]` boxes.',
    };
  }
  const empty = boxes.filter((m) => m[2].trim().length === 0);
  if (empty.length > 0) {
    return {
      name: 'ac-section-consistent',
      status: 'warn',
      reason: `${empty.length} empty acceptance-criterion box(es) found.`,
    };
  }
  return { name: 'ac-section-consistent', status: 'pass' };
}

// ─── Gate 4: Risk consistent with file count (warn-only) ───────────────────

function checkRiskFileCount(header: {
  risk: string;
  files: readonly string[];
}): GateResult {
  const count = header.files.length;
  if (header.risk === 'mechanical' && count > 5) {
    return {
      name: 'risk-file-count-consistent',
      status: 'warn',
      reason: `Risk=mechanical but ${count} files listed — typically mechanical issues touch ≤5 files. Reconsider classification.`,
    };
  }
  if (header.risk === 'cross-feature-refactor' && count === 1) {
    return {
      name: 'risk-file-count-consistent',
      status: 'warn',
      reason: `Risk=cross-feature-refactor but only 1 file listed — typically cross-feature work touches multiple files. Reconsider classification.`,
    };
  }
  return { name: 'risk-file-count-consistent', status: 'pass' };
}

// ─── Gate 5: Blocked-by chain resolves ─────────────────────────────────────

function checkBlockedByChain(
  header: HeaderBlock,
  issuePath: string,
  repoRoot: string,
): GateResult {
  if (header.blockedBy === 'none') {
    return { name: 'blocked-by-chain-resolves', status: 'pass' };
  }

  const ownSlug = extractSlugFromIssuePath(issuePath, repoRoot);
  const unresolved: string[] = [];

  for (const ref of header.blockedBy) {
    const slug = ref.slug ?? ownSlug;
    if (!slug) {
      unresolved.push(formatRef(ref));
      continue;
    }
    if (!issueExists(repoRoot, slug, ref.issue)) {
      unresolved.push(formatRef(ref));
    }
  }

  if (unresolved.length > 0) {
    return {
      name: 'blocked-by-chain-resolves',
      status: 'fail',
      reason: `Blocked-by reference(s) do not resolve to an existing issue file: ${unresolved.join(', ')}.`,
    };
  }
  return { name: 'blocked-by-chain-resolves', status: 'pass' };
}

function extractSlugFromIssuePath(
  issuePath: string,
  repoRoot: string,
): string | null {
  const rel = relative(repoRoot, issuePath).replace(/\\/g, '/');
  const match = /^\.scratch\/([^/]+)\/issues\//.exec(rel);
  return match ? match[1] : null;
}

function issueExists(
  repoRoot: string,
  slug: string,
  issueNumber: number,
): boolean {
  const padded = String(issueNumber).padStart(2, '0');
  const candidates = [
    join(repoRoot, '.scratch', slug, 'issues'),
    join(repoRoot, '.scratch', slug, 'issues', 'done'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      if (files.some((f) => f.startsWith(`${padded}-`) && f.endsWith('.md'))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function formatRef(ref: IssueRef): string {
  return ref.slug ? `${ref.slug}#${ref.issue}` : `#${ref.issue}`;
}

// ─── Gate 6: AC bodies do not mention uncovered file paths (warn-only) ────────

/** Recognised file extensions for path detection in AC bodies. */
const FILE_EXT_PATTERN =
  /\.(md|ts|tsx|js|jsx|scss|css|html|sh|yaml|yml|json|toml)\b/;

/**
 * Strip leading ./ and trim whitespace. Returns null for URLs and anchors.
 */
function normalisePathToken(raw: string): string | null {
  const token = raw.trim().replace(/^`|`$/g, '').trim();
  // Reject URLs, anchors, and shell/code fragments (contain $, (, ), <, >, ")
  if (/^https?:\/\/|^#|[$()<>"]/.test(token)) return null;
  return token.replace(/^\.\//, '');
}

/**
 * Extract file-path-like tokens from a single AC bullet's text.
 * Handles three forms: backtick paths, markdown-link targets, bare paths.
 */
function extractPathMentions(bulletText: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  // Form 1: backtick-wrapped paths
  const backtickRe = /`([^`]+)`/g;
  while ((m = backtickRe.exec(bulletText)) !== null) {
    const candidate = normalisePathToken(m[1]);
    if (candidate && FILE_EXT_PATTERN.test(candidate)) found.add(candidate);
  }

  // Form 2: markdown link targets [text](path)
  const mdLinkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  while ((m = mdLinkRe.exec(bulletText)) !== null) {
    const candidate = normalisePathToken(m[1]);
    if (candidate && FILE_EXT_PATTERN.test(candidate)) found.add(candidate);
  }

  // Form 3: bare paths containing '/' with a recognised extension
  const barePathRe = /(?:[\w.-]+\/)+[\w.-]+(?:\.[a-z]+)+/g;
  while ((m = barePathRe.exec(bulletText)) !== null) {
    const candidate = normalisePathToken(m[0]);
    if (candidate && FILE_EXT_PATTERN.test(candidate)) found.add(candidate);
  }

  return [...found];
}

/**
 * Extract the body text of the `## Acceptance criteria` section.
 * Returns null if the section is absent.
 */
export function extractAcBody(source: string): string | null {
  const sectionMatch = /^##\s+Acceptance\s+criteria\s*$/im.exec(source);
  if (!sectionMatch) return null;
  const after = source.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = /^##\s+/m.exec(after);
  return nextSection ? after.slice(0, nextSection.index) : after;
}

/**
 * Returns true if `mentionedPath` is covered by at least one entry in `files`.
 *
 * Coverage is determined in two steps:
 * 1. micromatch glob test (exact / glob match against the full path).
 * 2. Basename fallback — if no glob matches, check whether any Files: entry
 *    shares the same basename as `mentionedPath`. This suppresses the
 *    false-positive that arises when an AC mentions a file by its bare
 *    basename (e.g. `wave-playbook.md`) while Files: declares the full path
 *    (e.g. `docs/agents/wave-playbook.md`).
 *
 * A common basename that appears in multiple Files: entries still resolves to
 * "covered" — the intent is to suppress false-positives, not to introduce
 * ambiguity errors.
 */
function isPathCovered(mentionedPath: string, files: string[]): boolean {
  // Step 1: exact / glob match
  if (
    files.some((glob) => micromatch.isMatch(mentionedPath, glob, { dot: true }))
  ) {
    return true;
  }
  // Step 2: basename fallback — bare filename covered by a full-path Files: entry
  const mentionedBase = basename(mentionedPath);
  return files.some((entry) => basename(entry) === mentionedBase);
}

/**
 * Patterns that signal an AC bullet describes a *change* to `package.json`
 * (a new/rewired script), as opposed to merely *running* one — indicating
 * `package.json` should be in the Files: header.
 *
 * Matches only prose that pairs a change-verb ("wire(d)", "add(ed)") with
 * the change target:
 *  - "wired into … `npm run test:hooks`" / "add … npm run <name>" — a script
 *    is being introduced or rewired, i.e. package.json's `scripts` map changes.
 *  - "wired into … package.json" / "add … to package.json" — package.json
 *    named directly.
 *  - "wire … into … script" — script wiring named without "npm run".
 *
 * Deliberately NOT matched: a bare `npm run <name>` / `npm test` / `npx …`
 * mention with no change-verb. That is a **run-only** reference — the AC is
 * describing a *gate* ("tests pass", "typecheck clean"), not a change surface,
 * and package.json is not being edited. Demanding it in Files: would be a
 * false positive (W25-F3): the standard verify-floor AC ("npm test and npm
 * run typecheck clean from tools/wave/") runs this way on every issue and
 * package.json is never actually touched by it.
 *
 * When in doubt this stays conservative: a bullet naming *both* a run-only
 * command and a concrete changed file still gets file coverage demanded on
 * the file half via Refinement 2 below — only the package.json inference is
 * narrowed here.
 *
 * NOTE: A bare `<word>:<word>` pattern was intentionally dropped previously.
 * It was over-broad — firing on `nx run ds:test`, `file:line` refs, ratios
 * (`1:1`), and JSON tokens (`ff:true`). Empirical scan of 457 `.scratch/*.md`
 * files found 33 false-positive fires.
 *
 * NOTE (iteration 2 of W25-F3): the `add(ed) … npm run` pairing below requires
 * PROXIMITY, not just co-occurrence — its word-gap is capped at a small fixed
 * count (0–3 tokens). An earlier, unbounded gap let an unrelated `add(ed)` at
 * the start of a bullet pair with a later, unrelated run-only `npm run`
 * mention in the *same* bullet, e.g. "Add error handling for the empty-input
 * case; npm run test stays green." — the change-verb and the npm-run mention
 * belong to different clauses there and must NOT warn. Genuine proximate
 * phrasing ("add(ed) npm run <name>", "add an npm run <name>") still matches
 * within the bound.
 *
 * NOTE (iteration 3, W26-F3): the `wire(d) into/in … npm run` pairing carried
 * the identical structurally unbounded gap — self-reported by the iteration-2
 * worker as out-of-scope there because the reviewer's blocking finding was
 * scoped to `add(ed)` only. Same fix, same rationale: bounded to 0–3 tokens
 * so an unrelated, earlier `wired`/`wire in` no longer pairs with a distant,
 * unrelated run-only `npm run` mention in the same bullet. Genuine proximate
 * phrasing ("wired into npm run <name>", "wired into `npm run <name>`" with
 * the backtick tolerance) still matches within the bound.
 */
const NPM_SCRIPT_PATTERNS: RegExp[] = [
  // `[^\w\s]*` tolerates a wrapping backtick/quote directly against `npm`
  // (e.g. "wired into `npm run test:hooks`") with no space in between.
  /\bwire(?:d)?\s+(?:into|in)\s+(?:\S+\s+){0,3}[^\w\s]*npm\s+run\s+[\w:.-]+/i,
  /\badd(?:ed)?\s+(?:\S+\s+){0,3}[^\w\s]*npm\s+run\s+[\w:.-]+/i,
  /\bwire(?:d)?\s+(?:into|in)\s+(?:\S+\s+)*package\.json/i,
  /\badd(?:ed)?\s+(?:(?:\S+\s+)*)?(?:to\s+)?package\.json/i,
  /\bwire(?:d)?\s+(?:into|in)\s+(?:\S+\s+)*script/i,
];

/**
 * Returns true if the bullet text describes a package.json/script *change*
 * (not merely running an existing script — see {@link NPM_SCRIPT_PATTERNS}).
 */
function bulletMentionsNpmScript(bulletText: string): boolean {
  return NPM_SCRIPT_PATTERNS.some((re) => re.test(bulletText));
}

/**
 * Returns true if `package.json` is already covered by the Files: header
 * (literal entry or glob matching `package.json`).
 */
function packageJsonCovered(files: string[]): boolean {
  return isPathCovered('package.json', files);
}

/**
 * Public gate function. Parses the AC section and warns for every file-path
 * mention in a bullet that is NOT covered by any Files: glob.
 *
 * Two refinements applied here:
 *
 * Refinement 1 — npm-script *change* → `package.json` coverage:
 *   When any AC bullet describes a script being introduced or rewired (via
 *   "wire(d) into npm run <name>", "add(ed) npm run <name>", or prose like
 *   "wire into package.json") and `package.json` is absent from `Files:`,
 *   emit a warn suggesting it be added. A bullet that merely *runs* a script
 *   (`npm test`, `npm run <name>`, `npx …` with no change-verb attached) is a
 *   gate, not a change surface, and does not trigger this warn — see
 *   {@link NPM_SCRIPT_PATTERNS}.
 *
 * Refinement 2 — basename↔fullpath false-positive:
 *   A Files: entry is considered to cover an AC mention if either a full
 *   micromatch test passes OR the entry's basename equals the mention's basename.
 *   This removes the false-positive when AC text names a file by its basename
 *   (e.g. `wave-playbook.md`) while Files: has the full path
 *   (`docs/agents/wave-playbook.md`).
 *
 * @param _issuePath - Kept for API symmetry; unused.
 * @param header - Parsed header block providing the Files: glob list.
 * @param acBody - Raw text of the ## Acceptance criteria section.
 */
export function acFilesCoverageCheck(
  _issuePath: string,
  header: { files: string[] },
  acBody: string,
): AcFilesCoverageWarn[] {
  const warns: AcFilesCoverageWarn[] = [];

  const bullets = [...acBody.matchAll(/^- \[[ x]\]\s*(.*)$/gm)];

  // Refinement 1: check once across all bullets whether any references an npm
  // script without package.json in Files:.
  let npmScriptBullet: string | null = null;
  for (const match of bullets) {
    const bulletText = match[1] ?? '';
    if (
      bulletMentionsNpmScript(bulletText) &&
      !packageJsonCovered(header.files)
    ) {
      npmScriptBullet = bulletText;
      break;
    }
  }
  if (npmScriptBullet !== null) {
    const snippet =
      npmScriptBullet.length > 80
        ? npmScriptBullet.slice(0, 77) + '...'
        : npmScriptBullet;
    warns.push({
      level: 'warn',
      message: [
        'ac-files-coverage: AC text references an npm script but `package.json` is not in the Files: header.',
        `  AC bullet: "${snippet}"`,
        '  Suggest adding `package.json` to Files: header so Conflict-Map stays accurate.',
      ].join('\n'),
      suggestions: ['package.json'],
    });
  }

  // Refinement 2 (+ existing): per-bullet path-mention coverage with basename fallback.
  for (const match of bullets) {
    const bulletText = match[1] ?? '';
    const mentions = extractPathMentions(bulletText);
    for (const mentionedPath of mentions) {
      if (!isPathCovered(mentionedPath, header.files)) {
        const snippet =
          bulletText.length > 80 ? bulletText.slice(0, 77) + '...' : bulletText;
        warns.push({
          level: 'warn',
          message: [
            `ac-files-coverage: AC text mentions \`${mentionedPath}\` but no Files: glob covers it.`,
            `  AC bullet: "${snippet}"`,
            `  Suggest adding to Files: header, or confirm the mention is narrative-only.`,
          ].join('\n'),
          suggestions: [mentionedPath],
        });
      }
    }
  }

  return warns;
}

/**
 * Map an AC-section body + a Files: list onto the `ac-files-coverage` gate.
 * Shared by both the file path ({@link checkAcFilesCoverage}, which gets `acBody`
 * from raw source) and the structured path ({@link validateIssueView}, which
 * rebuilds `acBody` from the `IssueView` AC array).
 */
function acCoverageGate(files: string[], acBody: string): GateResult {
  const warns = acFilesCoverageCheck('', { files }, acBody);
  return warns.length === 0
    ? { name: 'ac-files-coverage', status: 'pass' }
    : {
        name: 'ac-files-coverage',
        status: 'warn',
        reason: warns.map((w) => w.message).join('\n'),
      };
}

/** Internal gate wrapper — converts acFilesCoverageCheck results to GateResult. */
function checkAcFilesCoverage(header: HeaderBlock, source: string): GateResult {
  const acBody = extractAcBody(source);
  if (acBody === null) {
    return { name: 'ac-files-coverage', status: 'pass' };
  }
  return acCoverageGate(header.files, acBody);
}

// ─── Gate 7: Literal Files: entries exist on disk (advisory warn-only) ────────

/**
 * For each Files: entry that is a literal path (no glob metacharacters),
 * check whether the path exists on disk relative to the repo root. Emit a
 * warn advisory on a miss — the file may have been renamed or the path may be
 * a typo. Glob entries are skipped because they legitimately may match zero
 * files at authoring time.
 *
 * This is advisory only — it does NOT add a 6th hard gate and does NOT change
 * the pass/fail (draft → ready) result.
 */
function checkLiteralFilesExistence(
  header: { files: readonly string[] },
  repoRoot: string,
): GateResult {
  const missing: string[] = [];
  for (const entry of header.files) {
    if (isLikelyGlob(entry)) continue;
    const abs = join(repoRoot, entry);
    if (!existsSync(abs)) {
      missing.push(entry);
    }
  }
  if (missing.length > 0) {
    return {
      name: 'literal-files-exist',
      status: 'warn',
      reason: missing
        .map((p) => `Files: entry \`${p}\` does not exist — renamed or typo?`)
        .join('\n'),
    };
  }
  return { name: 'literal-files-exist', status: 'pass' };
}

// ─── Gate 8: Files intersect at least one verify profile (advisory warn-only) ─

/**
 * Emitted when this call received no verify config to check against at all —
 * distinct from a consumer that legitimately configured zero profiles (AC4:
 * "not about the absence of profiles"). The caller simply did not supply
 * `verify`, so this gate cannot compute anything here and must not guess.
 *
 * This is the "resolvable" deferral (issue #676): the CLI never reached a
 * `--config` at all, so re-running with that flag is what would change the
 * outcome — distinct from {@link NOTE_VERIFY_PROFILES_EMPTY}, where a config
 * DID load and simply declares no profiles (the "genuinely nothing to check"
 * case, which no flag resolves).
 */
const DEFER_NO_VERIFY_CONFIG =
  'No verify config reached this check — pass --config <path> so this call can read the consumer wave.config.json (its `verify` profiles drive Gate 8).';

/**
 * Emitted when a verify config DID reach this call and it declares zero
 * profiles — either because the consumer's `wave.config.json` carries no
 * `verify` block at all (the CLI substitutes `{ profiles: [] }` in that case,
 * issue #676) or because it explicitly configured `verify: { profiles: [] }`.
 * Both mean the same thing from this gate's vantage point: there is nothing
 * to check, and no flag or re-run changes that — distinct from
 * {@link DEFER_NO_VERIFY_CONFIG}, where the call never saw a config at all and
 * IS resolvable by passing `--config`.
 */
const NOTE_VERIFY_PROFILES_EMPTY =
  'Verify config loaded — it declares no profiles, so nothing gates this row (inspection-only).';

/**
 * Expand a `Files:` entry list the same way Gate 2 ({@link checkFilesGlobs})
 * does: a glob entry expands via `fastGlob` against `repoRoot` (matches only —
 * a zero-match glob contributes nothing here; Gate 2 already warns on that
 * separately), a literal entry passes through as-is because it may be a
 * net-new file the issue will create (same tolerance as Gates 2 and 7).
 */
function resolveDeclaredFiles(
  files: readonly string[],
  repoRoot: string,
): string[] {
  const out: string[] = [];
  for (const entry of files) {
    if (isLikelyGlob(entry)) {
      const matches = fastGlob.sync(entry, {
        cwd: repoRoot,
        dot: true,
        onlyFiles: false,
      });
      out.push(...matches);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Gate 8 — a row whose declared `Files:` intersect no configured verify
 * profile's `appliesTo` currently lands `approve` with nothing compiled or
 * tested (the defect this gate exists to surface — see issue FOR-127). This is
 * cheap to detect: the declared files are known at DoR time and the verify
 * profiles' `appliesTo` globs are in the config; reusing {@link verifyCommands}
 * — the EXACT selection logic the Worker/Reviewer verify re-run will use —
 * guarantees "this gate passes" implies "verifyCommands would actually select
 * at least one command", not a parallel, potentially-drifting reimplementation.
 *
 * Advisory only (AC2): a row with no automated gate is not necessarily wrong —
 * some work genuinely has none — so this WARNs, it never FAILs. A row must
 * stay dispatchable either way; what changes is that the gap is now *stated*
 * instead of silently indistinguishable from a fully verify-backed approve.
 *
 * Three-way ADR-0014 capability classification, mirroring Gates 2/7:
 *   - `verify` absent from this call        → `'deferred'` (this invocation
 *     was not given the consumer's verify config at all — a capability gap,
 *     not evidence of anything about the row). Resolvable: passing `--config`
 *     is what would change the outcome ({@link DEFER_NO_VERIFY_CONFIG}).
 *   - `verify.profiles` present but EMPTY   → `'pass'`, with a note (issue
 *     #676; previously silent): a config DID load here and it legitimately
 *     declares zero profiles — whether because the consumer's config carries
 *     no `verify` block at all, or explicitly configured `{ profiles: [] }` —
 *     so nothing gates this row (AC4: this check is about a profile existing
 *     and NOT matching, not about the absence of profiles). Genuinely nothing
 *     to check: unlike the deferred case above, no flag resolves this one
 *     further ({@link NOTE_VERIFY_PROFILES_EMPTY}).
 *   - `repoRoot` absent (structured/`validateIssueView` path only) → `'deferred'`
 *     (working-tree gate: `Files:`/`appliesTo` globs cannot be expanded to
 *     determine overlap without a checkout).
 *   - otherwise: expand the row's declared files (same policy as Gate 2) and
 *     ask `verifyCommands` whether any profile would fire on them.
 */
function checkVerifyProfileCoverage(
  files: readonly string[],
  verify: VerifyConfig | undefined,
  repoRoot: string | undefined,
): GateResult {
  const name = 'verify-profile-coverage';
  if (verify === undefined) {
    return { name, status: 'deferred', reason: DEFER_NO_VERIFY_CONFIG };
  }
  if (verify.profiles.length === 0) {
    return { name, status: 'pass', reason: NOTE_VERIFY_PROFILES_EMPTY };
  }
  if (repoRoot === undefined) {
    return { name, status: 'deferred', reason: DEFER_NO_WORKTREE };
  }

  const resolved = resolveDeclaredFiles(files, repoRoot);
  const commands = verifyCommands(resolved, verify);
  if (commands.length > 0) {
    return { name, status: 'pass' };
  }

  const profileNames = verify.profiles.map((p) => p.name).join(', ');
  return {
    name,
    status: 'warn',
    reason:
      `Declared files (${files.join(', ')}) match no configured verify profile ` +
      `(${profileNames}) — this row has no automated build/test gate behind it. ` +
      `An approve here is inspection-only, not verify-backed: state that ` +
      `explicitly in the Worker/Reviewer brief rather than letting it read the ` +
      `same as a row a full verify run actually backed.`,
  };
}

// ─── Gate 9: the staleness advisory (advisory warn-only) ─────────────────────

/**
 * Gate 9's one spelling. Both entrypoints emit it under this name and the specs
 * assert on it; nothing else in the engine reads a gate name.
 */
const STALENESS_GATE = 'files-touched-since-tracker-update';

/**
 * The row carries no {@link IssueView.trackerUpdatedAt} (or an unparseable one),
 * so there is no `since` to measure from. `'deferred'`, never `'pass'`: "I do
 * not know when this row was last touched" must not read the same as "nothing
 * moved" — the false-pass this gate exists to make impossible.
 */
const DEFER_NO_TRACKER_TIMESTAMP =
  'No usable tracker-update timestamp on this row — the staleness advisory has no `since` to measure from. ' +
  'This is a capability gap (the adapter did not state one), NOT evidence that nothing moved.';

/** The supplied `repoRoot` is not a git checkout, so there is no history to read. */
const DEFER_NOT_A_GIT_CHECKOUT =
  'The supplied repo root is not a git checkout — the staleness advisory reads the default branch\'s history and cannot here.';

/** A git checkout with no resolvable default-branch ref (fresh clone, no commits, exotic layout). */
const DEFER_NO_DEFAULT_BRANCH_REF =
  'No default-branch ref resolves in this checkout (tried origin/HEAD, origin/main, origin/master, main, master, HEAD) — nothing to compare against.';

/**
 * Upper bound on the commits `git log` is asked for. `--since` already bounds
 * the window in practice; this bounds the pathological case (a very old row on a
 * very busy branch) so a large stdout can never turn a real advisory into a
 * `'deferred'` buffer overflow. A capped answer is reported as `N+`.
 */
const STALENESS_COMMIT_CAP = 200;

/** How many touching commits are NAMED inline before the tail is summarised. */
const STALENESS_COMMITS_SHOWN = 8;

/** Field separator inside the `git log --format` record (US, never in a subject line). */
const GIT_FIELD_SEP = '\u001f';

interface TouchingCommit {
  /** Abbreviated sha (`%h`). */
  sha: string;
  /** Author date, strict ISO-8601 (`%aI`). */
  date: string;
  /** Subject line (`%s`). */
  subject: string;
}

type StalenessProbe =
  | { ok: true; ref: string; commits: TouchingCommit[]; capped: boolean }
  | { ok: false; reason: string };

/**
 * One read-only `git` invocation, same shape `files-drift` already uses: no
 * shell, arguments passed as an array, a bounded timeout, and a buffer wide
 * enough that {@link STALENESS_COMMIT_CAP} commits always fit. stderr is
 * discarded — every failure here is turned into a `'deferred'` gate by the
 * caller, and git's own diagnostic would only be noise on a CLI whose output is
 * a gate table.
 */
function readOnlyGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * The ref the advisory compares against, resolved from the checkout rather than
 * configured (the slice takes no new required config). `origin/HEAD` is the
 * authoritative answer where the remote publishes it; the named candidates cover
 * a checkout that never fetched it, and bare `HEAD` is the last resort.
 *
 * The resolved ref is NAMED in the advisory text — a reader must be able to see
 * WHICH branch was compared, because "HEAD" on a feature branch and "origin/main"
 * are very different evidence.
 */
function resolveDefaultBranchRef(repoRoot: string): string | undefined {
  try {
    const symbolic = readOnlyGit(repoRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]).trim();
    if (symbolic.length > 0) return symbolic;
  } catch {
    // no published origin/HEAD — fall through to the named candidates
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'HEAD']) {
    try {
      readOnlyGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Declared `Files:` entries as git pathspecs. A glob entry gets `:(glob)` magic
 * so `**`/`*` mean what they mean everywhere else in this engine (fast-glob /
 * micromatch semantics); a literal entry is passed bare, keeping git's own
 * file-or-directory-prefix meaning — which is what a bare directory entry in a
 * `Files:` header intends.
 */
function toPathspecs(files: readonly string[]): string[] {
  return files.map((entry) => (isLikelyGlob(entry) ? `:(glob)${entry}` : entry));
}

/**
 * Normalise a tracker timestamp into the form git's date parser takes verbatim:
 * UTC, second precision, `Z`-suffixed. Truncating DOWN to the second is
 * deliberate — `--since` is exclusive, so a commit landing in the same second as
 * the tracker update is REPORTED rather than missed, the conservative direction
 * for an advisory. Returns `undefined` for absent/blank/unparseable input, which
 * the gate turns into `'deferred'`.
 */
function toGitSince(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** `git log <default-branch> --since=<ts> -- <declared files>`, failures folded into `ok:false`. */
function commitsTouchingSince(
  repoRoot: string,
  since: string,
  files: readonly string[],
): StalenessProbe {
  try {
    readOnlyGit(repoRoot, ['rev-parse', '--git-dir']);
  } catch {
    return { ok: false, reason: DEFER_NOT_A_GIT_CHECKOUT };
  }

  const ref = resolveDefaultBranchRef(repoRoot);
  if (ref === undefined) return { ok: false, reason: DEFER_NO_DEFAULT_BRANCH_REF };

  let out: string;
  try {
    out = readOnlyGit(repoRoot, [
      'log',
      ref,
      `--since=${since}`,
      `--max-count=${STALENESS_COMMIT_CAP}`,
      '--format=%h%x1f%aI%x1f%s',
      '--',
      ...toPathspecs(files),
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: `The default-branch history read failed (${(err as Error).message}) — the staleness advisory could not run.`,
    };
  }

  const commits = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(GIT_FIELD_SEP);
      return {
        sha: parts[0] ?? '',
        date: parts[1] ?? '',
        subject: parts.slice(2).join(GIT_FIELD_SEP),
      };
    });

  return { ok: true, ref, commits, capped: commits.length >= STALENESS_COMMIT_CAP };
}

/** The advisory's human-facing text: what moved, where to look, and what it does NOT mean. */
function renderStalenessAdvisory(
  probe: { ref: string; commits: TouchingCommit[]; capped: boolean },
  since: string,
  files: readonly string[],
): string {
  const shown = probe.commits.slice(0, STALENESS_COMMITS_SHOWN);
  const rest = probe.commits.length - shown.length;
  const total = `${probe.commits.length}${probe.capped ? '+' : ''}`;
  const lines = [
    `The default branch (${probe.ref}) has moved over this row's declared Files since its last tracker update (${since}): ` +
      `${total} commit(s) touched ${files.join(', ')}.`,
    `RE-READ the row body against the default branch before dispatch: a declared file moving is where a stale premise hides — ` +
      `acceptance criteria can go on naming a mechanism that has already been retired, and triage, decoration and both DoR gates all pass it through.`,
    `ADVISORY ONLY: a moved file is NOT proof the premise broke. This gate never FAILs and never blocks a wave; the premise judgment is the Coordinator's, not the engine's.`,
    'Touching commits:',
    ...shown.map((c) => `  ${c.sha} ${c.date} ${c.subject}`),
  ];
  if (rest > 0) lines.push(`  ... and ${rest}${probe.capped ? '+' : ''} more`);
  return lines.join('\n');
}

/**
 * Gate 9 — the **staleness advisory**. Nothing re-checks a decorated row's
 * premise between decoration and dispatch: a row's acceptance criteria can go
 * stale under it while the row itself is untouched on the tracker, and every
 * existing gate reads only the row. The one mechanical signal that the ground
 * moved is the default branch's own history over the row's declared `Files:`.
 *
 * The engine closes the DETECTION half and leaves the JUDGMENT human (ADR-0034's
 * born-structural case, decided 2026-08-09). Concretely:
 *
 *   - it never returns `'fail'` — there is no code path here that can, so a
 *     hard stop cannot be reintroduced by a config or a caller;
 *   - a `'warn'` says only WHERE re-reading pays, naming the ref, the window and
 *     the touching commits. Files having moved does not prove a premise broke.
 *
 * ADR-0014 capability classification, mirroring Gates 2/7/8:
 *   - `repoRoot` absent            → `'deferred'` (working-tree gate: the
 *     default branch's history is a property of a checkout).
 *   - no/unparseable timestamp     → `'deferred'` ({@link DEFER_NO_TRACKER_TIMESTAMP}).
 *   - not a git checkout, or no
 *     resolvable default-branch ref → `'deferred'`.
 *   - no declared `Files:`          → `'pass'`, vacuously and SAID so in the
 *     reason: with nothing declared there is nothing the branch could have moved
 *     over. (It also keeps the pathspec list non-empty — a bare `git log --`
 *     would report every commit on the branch as a hit.)
 *   - otherwise                     → `'pass'` when nothing touched the files in
 *     the window, `'warn'` naming the commits when something did.
 */
function checkFilesTouchedSinceTrackerUpdate(
  files: readonly string[],
  trackerUpdatedAt: string | undefined,
  repoRoot: string | undefined,
): GateResult {
  const name = STALENESS_GATE;
  if (repoRoot === undefined) {
    return { name, status: 'deferred', reason: DEFER_NO_WORKTREE };
  }
  const since = toGitSince(trackerUpdatedAt);
  if (since === undefined) {
    return { name, status: 'deferred', reason: DEFER_NO_TRACKER_TIMESTAMP };
  }
  if (files.length === 0) {
    return {
      name,
      status: 'pass',
      reason: 'Row declares no Files — nothing the default branch could have moved over.',
    };
  }

  const probe = commitsTouchingSince(repoRoot, since, files);
  if (!probe.ok) return { name, status: 'deferred', reason: probe.reason };
  if (probe.commits.length === 0) return { name, status: 'pass' };

  return {
    name,
    status: 'warn',
    reason: renderStalenessAdvisory(probe, since, files),
  };
}
