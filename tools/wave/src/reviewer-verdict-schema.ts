/**
 * reviewer-verdict-schema.ts — typed, schema-validated Reviewer-Verdict contract.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md
 * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 2-3, US-4/5)
 * Mirrors:        .claude/agents/wave-reviewer.md §"Output schema"
 *                 (synced copy: .claude/skills/wave-shared/references/reviewer-brief-template.md)
 *
 * The Wave-Reviewer subagent emitted its Verdict as free-text Markdown the
 * Coordinator chat re-read by eye to derive the routing event (G3: a forgotten
 * `riskClass` silently fast-pathed a public-API approve past the human STOP).
 * The #61 Workflow driver dispatches the Reviewer as
 * `agent({ agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_JSON_SCHEMA })`
 * — so the Verdict comes back **typed and tool-validated**, and the routing
 * reads `verdict.verdict` + `verdict.riskClass` straight into the tested
 * `verdictToEvent(verdict, iteration, risk)` adapter (#64) → `transition()`.
 * No prose re-parse, no hand-synthesised event, `riskClass` always present.
 *
 * The Verdict enum (`approve | changes-requested | questions-blocking`) and the
 * Risk enum are imported from their existing canonical homes
 * (`verdict-to-event.ts`, `header-parser.ts`) — never redefined — so the schema
 * stays in lockstep with the adapter it feeds.
 */

import { RISK_VALUES, type Risk } from './header-parser';
import { VERDICT_VALUES, type Verdict } from './verdict-to-event';
import type { SchemaValidation } from './types';

// ─── enums local to the Verdict shape ───────────────────────────────────────

// (removed) BRIEF_PROFILE_VALUES / BriefProfile — ADR-0016 uniform reviewer:
// there is no per-Risk brief profile any more.

/** Per-AC verification status from the Reviewer's AC table. */
export const AC_STATUS_VALUES = [
  'met',
  'partial',
  'not-met',
  'deferred',
] as const;
export type AcStatus = (typeof AC_STATUS_VALUES)[number];

// ─── TS view of the verdict ─────────────────────────────────────────────────

/** One row of the Reviewer's AC-verification table. */
export interface AcVerification {
  /** Short AC text or `#N`. */
  ac: string;
  /** Verification status. */
  met: AcStatus;
  /** `file:line`, `commit-sha`, or "deferred per marker". */
  evidence: string;
}

/**
 * The structured Reviewer-Verdict the driver routes on. `verdict` is the
 * routing discriminator; `riskClass` is the bifurcator `verdictToEvent()`
 * requires (its absence was the G3 bug). The remaining fields preserve the
 * Output-schema's structured sections so the Coordinator sees the same
 * evidence the prose Verdict carried, without re-parsing Markdown.
 */
export interface ReviewerVerdict {
  /** Routing discriminator — one of {@link VERDICT_VALUES}. */
  verdict: Verdict;
  /** Branch the Reviewer verified. */
  branchReviewed: string;
  /** Risk class — fed straight to `verdictToEvent()` so routing never omits it. */
  riskClass: Risk;
  /** One-line digest of the Worker report ("Worker reports X/Y green, 0 judgment calls"). */
  workerReportDigest: string;
  /** AC-verification table; `[]` allowed only when the issue declares no ACs. */
  acVerification: AcVerification[];
  /** Reviewer-focus items for the Coordinator — surfaced even on `approve`; `[]` when none. */
  reviewerFocusItems: string[];
  /** Lint/test re-verification summary (Reviewer re-ran, not re-read). */
  lintTestSummary?: string;
  /** Git-state sanity (globs match, AC ticks consistent with diff, Closed-by well-formed). */
  gitStateSane?: boolean;
}

// ─── met-AC index derivation (FOR-17 — the dead --acked wire) ──────────────

/**
 * Derive the 0-based `acVerification` indexes the Reviewer marked `met` —
 * the SINGLE-OWNER engine derivation `IssueStore.close(id, prUrl,
 * ackedAcIndexes)` expects (ADR-0004: `ackedAcIndexes` are "stable AC indexes
 * from the reviewer verdict"). `acVerification[]` is positional 1:1 with the
 * issue's declared `acceptanceCriteria[]` (ADR-0004's re-based AC-count gate),
 * so the index into this array IS the stable AC index `tickAcs()` consumes —
 * no separate id/ordinal field is needed.
 *
 * `partial` / `not-met` / `deferred` rows are excluded — only an
 * unambiguous `met` earns the cosmetic tick, so the issue's checklist reads
 * as done for exactly what the Reviewer verified with evidence, never more.
 *
 * COSMETIC ONLY (ADR-0004 boundary): this is the human-visibility tick wired
 * at `wave-close`'s done-reconcile step, at CLOSE time — never at verdict-in,
 * since an approved-but-later-closed-unmerged PR would otherwise overstate
 * what landed. The result is never fed back as gate input; `acVerification[]`
 * itself remains the ground truth the DOR/reviewer gates read.
 */
export function metAcIndexes(verdict: ReviewerVerdict): number[] {
  const indexes: number[] = [];
  verdict.acVerification.forEach((row, i) => {
    if (row.met === 'met') indexes.push(i);
  });
  return indexes;
}

// ─── PR-body render (FOR-16 — the seam where the human actually stands) ────

/**
 * The two facts a `ReviewerVerdict` sidecar does NOT itself carry, but that the
 * render needs: which routing iteration produced it, and the wave anchor SHA
 * (the diff base the Reviewer verified against) — both live on the routing
 * tuple / spine row, never on the typed verdict.
 */
export interface RenderVerdictOptions {
  /** The routing iteration this verdict was produced at (1 or 2, cap=1). */
  iteration: number;
  /** Wave anchor SHA — the diff base the Reviewer verified against. */
  anchorSha: string;
  /**
   * The row's OWN tracker id (the close target). Every OTHER tracker-id-shaped
   * token in the rendered evidence is neutralized (see
   * {@link neutralizeForeignTrackerIds}) so a native tracker integration cannot
   * linkify+act on a stray foreign id in a merged PR body (the mention footgun,
   * wave-shared Convention 4). The own id passes through untouched — linking it
   * is intended. **Omitted → fail-safe:** every id-shaped token is neutralized,
   * since with no own id the render cannot know which one is the close target.
   */
  ownId?: string;
}

/** Escape a markdown-table cell: pipes/newlines would otherwise break the row. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Word joiner (U+2060) inserted immediately before the numeric run of a
 * neutralized tracker-id token. It is zero-width, so the id still renders
 * byte-for-byte the same to a human (`FOR-16` stays visually `FOR-16`), but the
 * digits are no longer adjacent to the id's sigil/hyphen — so a native tracker
 * integration's id scan (`#\d+` for a GitHub ref, `[A-Z]+-\d+` for a Linear
 * team id) no longer matches. It is a non-breaking, non-ignorable character
 * (not whitespace, not a combinator), so it survives markdown rendering as an
 * ordinary text character: the neutralization holds in the rendered HTML the
 * integration scans, not only in the markdown source.
 */
const ID_JOINER = '\u2060';

/**
 * A tracker-id-shaped token: a Linear-style team id (`FOR-16` — an
 * uppercase-led prefix + `-` + digits) or a GitHub-style issue ref (`#42`).
 * These are the two shapes a native GitHub/Linear integration linkifies and
 * acts on when it finds them in a merged PR's title or body. Deliberately
 * broad: with the neutralization being visually identical (a zero-width
 * joiner), catching an incidental non-id lookalike (`UTF-8`, `SHA-256`,
 * `ADR-0024`) is harmless — it renders unchanged — so no prefix allow-listing
 * is needed to stay safe.
 */
const TRACKER_ID_RE = /([A-Z][A-Z0-9]*-)(\d+)|(#)(\d+)/g;

/**
 * Neutralize every tracker-id-shaped token in `text` into a human-readable but
 * non-integration-linkable spelling — EXCEPT the row's own id, which passes
 * through untouched (linking the close target is intended).
 *
 * The exemption compares the matched token to `ownId` with any leading `#`
 * stripped from both, so a bare-number own id (`42`, the GitHub store's opaque
 * id) also exempts its link form `#42`, while a Linear own id (`FOR-74`) exempts
 * exactly itself. `ownId` omitted (or `undefined`) exempts nothing — the
 * fail-safe default that neutralizes every id-shaped token.
 *
 * Neutralization is a single {@link ID_JOINER} inserted before the digits (see
 * that const for why it is invisible-yet-un-scannable and survives markdown).
 */
export function neutralizeForeignTrackerIds(
  text: string,
  ownId?: string,
): string {
  const ownBare = ownId === undefined ? undefined : ownId.replace(/^#/, '');
  return text.replace(
    TRACKER_ID_RE,
    (
      match: string,
      linearPrefix: string | undefined,
      linearDigits: string | undefined,
      hashSigil: string | undefined,
      hashDigits: string | undefined,
    ): string => {
      if (ownBare !== undefined && match.replace(/^#/, '') === ownBare) {
        return match; // the row's own id — the intended close target
      }
      return linearPrefix !== undefined
        ? `${linearPrefix}${ID_JOINER}${linearDigits}`
        : `${hashSigil}${ID_JOINER}${hashDigits}`;
    },
  );
}

/**
 * Render the human-facing `## Reviewer verdict` PR-body section from a typed
 * `ReviewerVerdict` sidecar — the single-owner rendering step so the human who
 * merges the PR sees what the LLM reviewer found (verdict, the per-AC table,
 * re-run verify counts, advisories) instead of re-reviewing blind or trusting
 * the Coordinator's word. The engine owns the FORMAT so it is testable and
 * cannot drift per skill-author (mirrors `write-report`/`write-verdict` owning
 * the sidecar format, ADR-0024).
 *
 * Deliberately compact (wave-shared: "a render lives where its reader lives"):
 * this is the PR's single human-facing render, not the full sidecar — a
 * re-dispatch Worker or a rebase resolver reading PR context should not have
 * to wade through the full typed payload. The sidecar (machine-read, never
 * trimmed) remains the full authority; this is a projection of it.
 *
 * Called once per PR-open — at `approved → pr-created` (wave-start's routing
 * terminator, `{{wave-cli}} host-pr create --body`) — against the MAX-iter
 * valid verdict sidecar (`sidecar.ts`'s `readSidecars`/`verdictFor`, the same
 * reader `verdict-acked` uses), so a changes-requested → re-dispatch cycle's
 * final PR body always carries the LATEST iteration's verdict, never the
 * first — the sidecar reader's max-iter selection is what guarantees this,
 * not anything in this render itself.
 *
 * Every Reviewer-authored free-text field this render emits (the AC label +
 * evidence cells, the verify summary, the advisories) is passed through
 * {@link neutralizeForeignTrackerIds} with `opts.ownId` — so a foreign tracker
 * id that slipped into an evidence string cannot linkify+act on a merged PR
 * body (the mention footgun, wave-shared Convention 4). The structural fields
 * (verdict/riskClass enums, iteration, anchor SHA) are engine-owned and carry
 * no id-shaped tokens, so they are rendered verbatim. This is the structural
 * backstop; the Reviewer brief's evidence-discipline clause is the first line.
 */
export function renderVerdictSection(
  verdict: ReviewerVerdict,
  opts: RenderVerdictOptions,
): string {
  const scrub = (s: string): string =>
    neutralizeForeignTrackerIds(s, opts.ownId);

  const lines: string[] = [
    '## Reviewer verdict',
    '',
    `**Verdict:** ${verdict.verdict} (iteration ${opts.iteration})`,
    `**Risk class:** ${verdict.riskClass}`,
    `**Anchor SHA:** \`${opts.anchorSha}\``,
    '',
  ];

  if (verdict.acVerification.length > 0) {
    lines.push('| AC | Status | Evidence |');
    lines.push('|---|---|---|');
    for (const row of verdict.acVerification) {
      lines.push(
        `| ${escapeCell(scrub(row.ac))} | ${row.met} | ${escapeCell(scrub(row.evidence))} |`,
      );
    }
  } else {
    lines.push('_No acceptance criteria declared._');
  }
  lines.push('');

  lines.push(`**Verify:** ${scrub(verdict.lintTestSummary ?? 'not reported')}`);
  lines.push('');

  lines.push('**Advisories:**');
  if (verdict.reviewerFocusItems.length > 0) {
    for (const item of verdict.reviewerFocusItems) {
      lines.push(`- ${scrub(item)}`);
    }
  } else {
    lines.push('- none');
  }

  return lines.join('\n');
}

// ─── JSON Schema (enforced by the Workflow tool at the agent() boundary) ─────

/**
 * The JSON Schema the Workflow driver passes as
 * `agent({ agentType: 'wave-reviewer', schema })`. The tool validates the
 * subagent's return against this before the driver routes — so a Verdict
 * missing `riskClass` (the G3 failure) cannot reach `verdictToEvent()`; the
 * model is forced to supply it. `additionalProperties: false` keeps the
 * subagent from returning un-modelled fields the router would ignore.
 */
export const REVIEWER_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'branchReviewed',
    'riskClass',
    'workerReportDigest',
    'acVerification',
    'reviewerFocusItems',
  ],
  properties: {
    verdict: { type: 'string', enum: [...VERDICT_VALUES] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: [...RISK_VALUES] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ac', 'met', 'evidence'],
        properties: {
          ac: { type: 'string', minLength: 1 },
          met: { type: 'string', enum: [...AC_STATUS_VALUES] },
          evidence: { type: 'string' },
        },
      },
    },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' },
    gitStateSane: { type: 'boolean' },
  },
} as const;

// ─── dependency-free structural validator (for the spec) ─────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Dependency-free validator asserting the load-bearing `ReviewerVerdict`
 * constraints: `verdict` and `riskClass` within their enums (the two routing
 * inputs that must never be wrong), required strings present, `acVerification`
 * rows well-formed. Not a full JSON-Schema engine — {@link REVIEWER_VERDICT_JSON_SCHEMA}
 * is what the Workflow tool enforces; this lets the spec prove well-formed/malformed
 * without an ajv dependency.
 *
 * @returns `{ valid, errors }` — `errors` is empty iff `valid`.
 */
export function validateReviewerVerdict(value: unknown): SchemaValidation {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { valid: false, errors: ['verdict is not an object'] };
  }

  if (
    !(VERDICT_VALUES as readonly string[]).includes(value.verdict as string)
  ) {
    errors.push(
      `verdict ${JSON.stringify(value.verdict)} not in ${VERDICT_VALUES.join(' | ')}`,
    );
  }
  if (!(RISK_VALUES as readonly string[]).includes(value.riskClass as string)) {
    errors.push(
      `riskClass ${JSON.stringify(value.riskClass)} not in ${RISK_VALUES.join(' | ')} ` +
        '(its absence was the G3 fast-path bug)',
    );
  }
  for (const key of ['branchReviewed', 'workerReportDigest'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (!isStringArray(value.reviewerFocusItems)) {
    errors.push('reviewerFocusItems must be a string[]');
  }
  if (!Array.isArray(value.acVerification)) {
    errors.push('acVerification must be an array');
  } else {
    value.acVerification.forEach((row, i) => {
      if (!isPlainObject(row)) {
        errors.push(`acVerification[${i}] must be an object`);
        return;
      }
      if (typeof row.ac !== 'string' || row.ac.length === 0) {
        errors.push(`acVerification[${i}].ac must be a non-empty string`);
      }
      if (
        !(AC_STATUS_VALUES as readonly string[]).includes(row.met as string)
      ) {
        errors.push(
          `acVerification[${i}].met ${JSON.stringify(row.met)} not in ${AC_STATUS_VALUES.join(' | ')}`,
        );
      }
      if (typeof row.evidence !== 'string') {
        errors.push(`acVerification[${i}].evidence must be a string`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
