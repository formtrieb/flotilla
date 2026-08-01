/**
 * reviewer-verdict-schema.ts — typed, schema-validated Reviewer-Verdict contract.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md
 * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 2-3, US-4/5)
 * Mirrors:        .claude/agents/wave-reviewer.md §"Output schema", restated at
 *                 dispatch time by `reviewerBrief()` in the wave-start skill's
 *                 workflow driver. Named, not pathed: the standalone
 *                 reviewer-brief-template document this line used to cite as the
 *                 synced copy was folded into that driver and exists under no
 *                 spelling (`shipped-citation-guard.spec.ts`).
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

/**
 * What raised the Documented-Form Comparison duty for this row
 * ([ADR-0030](../../../docs/adr/0030-deferred-core-path-requires-documented-form-comparison.md)).
 *
 * Three first-class raisers, **any one of which triggers; none is a
 * precondition**:
 * - `issue-declared` — an acceptance criterion asked for the comparison
 *   outright (it then also rides the ordinary per-AC machinery);
 * - `worker-declared` — the Worker declared an unexecutable core path in
 *   `judgmentCalls`, mirrored into `reviewerFocusItems`, and the focus sweep
 *   turned it into a directed check;
 * - `deferred-core-path` — the **backstop that fires when nobody remembered**:
 *   the ACs covering the row's core path landed in the `deferred` valve
 *   (outcome unreachable from the review environment, probe license
 *   exhausted), so the documented form is the only evidence left.
 *
 * Deliberately NOT a fourth "the Reviewer ruled this row unexecutable" value:
 * that would re-create the could-not/cannot conflation as a second, abstract
 * judgment layer, when the ADR-0004-Amendment per-AC line (a failing probe is
 * `not-met`; unreachable is `deferred`) already draws it operationally.
 */
export const DOCUMENTED_FORM_TRIGGER_VALUES = [
  'issue-declared',
  'worker-declared',
  'deferred-core-path',
] as const;
export type DocumentedFormTrigger =
  (typeof DOCUMENTED_FORM_TRIGGER_VALUES)[number];

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
 * One divergence between the change on the branch and the authoritative
 * documented form of the mechanism it implements (ADR-0030).
 *
 * `deliberate` is the whole reason this is a *list* and not a verdict input: a
 * commented departure from a vendor's documented form is a legitimate, common
 * shape (flotilla's own release workflow carries several), and it must survive
 * review intact. An uncommented divergence is ordinary Reviewer judgment like
 * any other finding — the duty adds required *reporting*, not new *routing*.
 * **Nothing here auto-flips `verdict`.**
 */
export interface DocumentedFormDivergence {
  /** What differs, in one line — the change's form vs. the documented form. */
  description: string;
  /**
   * `true` iff the departure is deliberate AND commented at the point of
   * departure. A departure that is merely *plausible* is not deliberate: the
   * classification is a fact about the diff (is the reason written down?), not
   * a judgment about whether the divergence is defensible.
   */
  deliberate: boolean;
}

/**
 * The **Documented-Form Comparison** — the Reviewer's required substitute
 * evidence for a row whose core path is unreachable from the review
 * environment (ADR-0030).
 *
 * Founding incident: a release workflow was approved with three divergences
 * from the registry vendor's documented example still in it (a missing
 * `registry-url`, dependency caching left on in a release build — vendor-
 * advised-against on supply-chain grounds — and an outdated action version).
 * Nothing malfunctioned: every acceptance criterion was verified and every one
 * held. The core path (the OIDC exchange with the registry) simply **cannot be
 * executed before a real release exists**, so "does this match the form the
 * vendor documents" was not one evidence source among several — it was the
 * only one available, and no AC asked for it, because ACs describe what a
 * change should *do* and this is a question about what it should *look like*.
 *
 * `sources` is what makes the no-restatement constraint **structural** rather
 * than hortatory: the operating contract's evidence-from-this-dispatch clause
 * extends to documents, so a comparison cites what the Reviewer itself read.
 * A comparison whose only source is the Worker's report is invalid by
 * construction — {@link validateReviewerVerdict} rejects an empty `sources`,
 * and the schema's `minItems: 1` rejects it at the `agent({ schema })`
 * boundary. (The related live finding this guards: a factual misstatement in a
 * Worker report travelled through the Reviewer unchallenged and into the human
 * decision brief.)
 */
export interface DocumentedFormComparison {
  /** Which raiser fired — see {@link DOCUMENTED_FORM_TRIGGER_VALUES}. */
  trigger: DocumentedFormTrigger;
  /**
   * The authoritative document(s) the Reviewer read **in this dispatch** —
   * vendor documentation, a spec, an RFC. Non-empty by construction; the
   * Worker's report is never a valid entry.
   */
  sources: string[];
  /** Every divergence found, classified. `[]` = the change matches the form. */
  divergences: DocumentedFormDivergence[];
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
  /**
   * The Documented-Form Comparison — **its own reported outcome**, never folded
   * into `acVerification[]` (ADR-0030).
   *
   * **Flat and optional, deliberately.** The requirement is conditional ("when
   * a trigger fired"), but encoding that condition in the schema would mean a
   * top-level `anyOf`/`if` — exactly the shape the agent tool's `input_schema`
   * validation rejects outright at the `agent({ schema })` boundary (live:
   * W5-F1, which failed every Worker dispatch of a wave instantly, 0 tokens).
   * So the schema keeps the field flat-optional and the **contract prose**
   * (`.claude/agents/wave-reviewer.md` Check 6) carries the requirement — the
   * same brief-enforced-not-schema-enforced division the driver copy's `prUrl`
   * invariant already uses.
   *
   * Absent on the common case: a row whose core path is executable fires no
   * trigger and pays nothing.
   */
  documentedFormComparison?: DocumentedFormComparison;
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

  // The Documented-Form Comparison renders as its OWN section (ADR-0030) —
  // never as extra rows in the AC table above, because the whole point of the
  // duty is that the acceptance criteria were not where the risk lived. Absent
  // on a row that fired no trigger: the section simply does not appear, so the
  // common case adds nothing to the human's PR-body brief.
  const dfc = verdict.documentedFormComparison;
  if (dfc !== undefined) {
    lines.push(`**Documented-form comparison** (trigger: ${dfc.trigger})`);
    lines.push('');
    lines.push('_Sources read in this review:_');
    if (dfc.sources.length > 0) {
      for (const source of dfc.sources) lines.push(`- ${scrub(source)}`);
    } else {
      // Unreachable through the schema (`minItems: 1`) — rendered rather than
      // silently dropped so a hand-built/legacy payload is visibly wrong to
      // the human instead of looking like a sourced comparison.
      lines.push('- none cited — INVALID, a comparison must cite what it read');
    }
    lines.push('');
    lines.push('_Divergences from the documented form:_');
    if (dfc.divergences.length > 0) {
      for (const d of dfc.divergences) {
        // The classification is rendered as a visible prefix, not a column:
        // a deliberate, commented departure must read as surviving review
        // intact, and a divergence is never an automatic defect.
        const tag = d.deliberate ? '(deliberate)' : '(divergence)';
        lines.push(`- ${tag} ${scrub(d.description)}`);
      }
    } else {
      lines.push('- none — the change matches the documented form');
    }
    lines.push('');
  }

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
    // The Documented-Form Comparison (ADR-0030). FLAT + OPTIONAL: the field is
    // absent from `required` above and carries no top-level combinator of its
    // own, so the whole schema stays boundary-safe (W5-F1 — the agent tool's
    // input_schema validation rejects a top-level anyOf/oneOf/allOf outright,
    // which is why the "required WHEN a trigger fired" half lives in contract
    // prose, not in the schema). `sources` is `minItems: 1` — that is the
    // structural half of the no-restatement rule: a comparison must cite at
    // least one document the Reviewer read in its own dispatch.
    documentedFormComparison: {
      type: 'object',
      additionalProperties: false,
      required: ['trigger', 'sources', 'divergences'],
      properties: {
        trigger: {
          type: 'string',
          enum: [...DOCUMENTED_FORM_TRIGGER_VALUES],
        },
        sources: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
        },
        divergences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['description', 'deliberate'],
            properties: {
              description: { type: 'string', minLength: 1 },
              deliberate: { type: 'boolean' },
            },
          },
        },
      },
    },
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
 * rows well-formed, and — when present — the `documentedFormComparison` block
 * well-formed with a non-empty `sources` (ADR-0030's no-restatement rule). Not
 * a full JSON-Schema engine — {@link REVIEWER_VERDICT_JSON_SCHEMA} is what the
 * Workflow tool enforces; this lets the spec prove well-formed/malformed
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

  // documentedFormComparison — OPTIONAL (a row with an executable core path
  // fires no trigger), but ill-formed when present is an error like any other.
  if (value.documentedFormComparison !== undefined) {
    validateDocumentedFormComparison(value.documentedFormComparison, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the optional `documentedFormComparison` block in place, appending to
 * `errors` (ADR-0030). Split out so the no-restatement rule — `sources` must be
 * non-empty — reads as its own named constraint rather than as one line buried
 * in the main validator.
 */
function validateDocumentedFormComparison(
  value: unknown,
  errors: string[],
): void {
  if (!isPlainObject(value)) {
    errors.push('documentedFormComparison must be an object');
    return;
  }

  if (
    !(DOCUMENTED_FORM_TRIGGER_VALUES as readonly string[]).includes(
      value.trigger as string,
    )
  ) {
    errors.push(
      `documentedFormComparison.trigger ${JSON.stringify(value.trigger)} not in ` +
        DOCUMENTED_FORM_TRIGGER_VALUES.join(' | '),
    );
  }

  if (!isStringArray(value.sources)) {
    errors.push('documentedFormComparison.sources must be a string[]');
  } else if (value.sources.length === 0) {
    // The structural half of the no-restatement rule (ADR-0030): the duty
    // cannot be discharged by restating what the Worker already claimed, so a
    // comparison MUST cite at least one document the Reviewer read itself.
    errors.push(
      'documentedFormComparison.sources must name at least one document the ' +
        'Reviewer read in THIS dispatch — a comparison sourced only from the ' +
        "Worker's report is invalid (ADR-0030)",
    );
  } else if (value.sources.some((s) => s.trim() === '')) {
    errors.push(
      'documentedFormComparison.sources entries must be non-empty strings',
    );
  }

  if (!Array.isArray(value.divergences)) {
    errors.push('documentedFormComparison.divergences must be an array');
    return;
  }
  value.divergences.forEach((row, i) => {
    if (!isPlainObject(row)) {
      errors.push(`documentedFormComparison.divergences[${i}] must be an object`);
      return;
    }
    if (typeof row.description !== 'string' || row.description.length === 0) {
      errors.push(
        `documentedFormComparison.divergences[${i}].description must be a non-empty string`,
      );
    }
    if (typeof row.deliberate !== 'boolean') {
      errors.push(
        `documentedFormComparison.divergences[${i}].deliberate must be a boolean ` +
          '(a commented departure is deliberate and survives review intact)',
      );
    }
  });
}
