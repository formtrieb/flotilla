/**
 * 5-Gate Definition-of-Ready validator for a single wave-eligible issue.
 *
 * Spec is canonical in `.scratch/wave-orchestration/PRD.md` §S2 and in
 * `.scratch/wave-orchestration/issues/05-wave-validate-skill.md`. The gates:
 *
 *   1. Header-Block present + parseable (delegates to header-parser)
 *   2. `Files:` globs expand without error against the repo file tree
 *   3. AC-section internally consistent (heuristic; warn-only)
 *   4. Risk-class consistent with file count (warn-only)
 *   5. `Blocked by:` chain resolves to issues that exist
 *   6. AC bodies do not mention file paths absent from `Files:` header (warn-only)
 *
 * Pure function modulo two side-effects: file-glob expansion (`fastGlob`) and
 * blocked-by file-existence check (`statSync`). Both honor the `repoRoot`
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

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

  const failed = gates.some((g) => g.status === 'fail');
  return {
    overall: failed ? 'FAIL' : 'PASS',
    gates,
    header,
  };
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
 */
const NPM_SCRIPT_PATTERNS: RegExp[] = [
  // `[^\w\s]*` tolerates a wrapping backtick/quote directly against `npm`
  // (e.g. "wired into `npm run test:hooks`") with no space in between.
  /\bwire(?:d)?\s+(?:into|in)\s+(?:\S+\s+)*[^\w\s]*npm\s+run\s+[\w:.-]+/i,
  /\badd(?:ed)?\s+(?:(?:\S+\s+)*)?[^\w\s]*npm\s+run\s+[\w:.-]+/i,
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

export { resolve, dirname };
