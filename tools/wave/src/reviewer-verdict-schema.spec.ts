/**
 * Spec for the ReviewerVerdict schema (wave-orch #61).
 *
 * Two surfaces:
 *   1. `validateReviewerVerdict()` — a well-formed verdict parses; each
 *      load-bearing malformation is rejected. The headline guard is **the
 *      missing `riskClass`**: its omission was the G3 bug (a public-API approve
 *      silently fast-pathed past the human STOP). The schema makes it required.
 *   2. End-to-end routing: a validated verdict's `{ verdict, riskClass }` feed
 *      straight into the tested `verdictToEvent()` → `transition()` chain with
 *      no hand-synthesis — proving the typed return wires the existing router.
 */

import { describe, expect, it } from 'vitest';
import { RISK_VALUES, type Risk } from './header-parser';
import { transition } from './stop-condition-state-machine';
import {
  VERDICT_VALUES,
  verdictToEvent,
  type Verdict,
} from './verdict-to-event';
import {
  AC_STATUS_VALUES,
  DOCUMENTED_FORM_TRIGGER_VALUES,
  REVIEWER_VERDICT_JSON_SCHEMA,
  metAcIndexes,
  neutralizeForeignTrackerIds,
  renderVerdictSection,
  validateReviewerVerdict,
  type DocumentedFormComparison,
  type DocumentedFormTrigger,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';
// Same surface, but imported through the PACKAGE ROOT rather than the module
// file directly — proves the barrel actually re-exports the Documented-Form
// Comparison names (issue #216's acceptance criteria), aliased to avoid
// colliding with the direct-module imports above.
import {
  DOCUMENTED_FORM_TRIGGER_VALUES as DOCUMENTED_FORM_TRIGGER_VALUES_FROM_ROOT,
  type DocumentedFormTrigger as DocumentedFormTriggerFromRoot,
  type DocumentedFormComparison as DocumentedFormComparisonFromRoot,
  type DocumentedFormDivergence as DocumentedFormDivergenceFromRoot,
} from './index';

// ─── fixture ────────────────────────────────────────────────────────────────

function validVerdict(over: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: 'approve',
    branchReviewed: 'wave-orch/61-wave-start-workflow-driver',
    riskClass: 'cross-feature-refactor',
    workerReportDigest: 'Worker reports 20/20 green, 1 judgment call',
    acVerification: [
      { ac: '#1', met: 'met', evidence: 'tools/wave/src/worker-report-schema.ts' },
    ],
    reviewerFocusItems: ['(advisory) consider a stall-watchdog follow-up'],
    lintTestSummary: '1/1 green',
    gitStateSane: true,
    ...over,
  };
}

// ─── validateReviewerVerdict — well-formed ──────────────────────────────────

describe('validateReviewerVerdict — well-formed', () => {
  it('accepts a complete verdict', () => {
    expect(validateReviewerVerdict(validVerdict())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts every verdict value', () => {
    for (const verdict of VERDICT_VALUES) {
      expect(validateReviewerVerdict(validVerdict({ verdict })).valid).toBe(
        true,
      );
    }
  });

  it('accepts an empty acVerification list (issue with no ACs)', () => {
    expect(
      validateReviewerVerdict(validVerdict({ acVerification: [] })).valid,
    ).toBe(true);
  });
});

// ─── validateReviewerVerdict — malformed ────────────────────────────────────

describe('validateReviewerVerdict — rejects malformed verdicts', () => {
  it('rejects a non-object', () => {
    expect(validateReviewerVerdict(undefined).valid).toBe(false);
  });

  it('rejects an out-of-enum verdict', () => {
    const r = validateReviewerVerdict(
      validVerdict({ verdict: 'approved' as Verdict }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/verdict .* not in/);
  });

  it('rejects a MISSING riskClass — the G3 fast-path guard', () => {
    const bad = { ...validVerdict() } as Partial<ReviewerVerdict>;
    delete bad.riskClass;
    const r = validateReviewerVerdict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/riskClass/);
    expect(r.errors.join(' ')).toMatch(/G3/);
  });

  it('rejects an out-of-enum riskClass', () => {
    const r = validateReviewerVerdict(
      validVerdict({ riskClass: 'public-api' as Risk }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/riskClass/);
  });

  it('rejects a malformed acVerification row (bad met status)', () => {
    const r = validateReviewerVerdict(
      validVerdict({
        acVerification: [
          {
            ac: '#1',
            met: 'passed' as ReviewerVerdict['acVerification'][number]['met'],
            evidence: 'x',
          },
        ],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/acVerification\[0\]\.met/);
  });

  it('rejects a non-array reviewerFocusItems', () => {
    const bad = { ...validVerdict(), reviewerFocusItems: 'none' };
    const r = validateReviewerVerdict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/reviewerFocusItems/);
  });
});

// ─── end-to-end routing: validated verdict → verdictToEvent → transition ────

describe('a validated verdict routes through the tested chain without hand-synthesis', () => {
  it('approve + cross-feature-refactor → reviewer-approve → approved', () => {
    const v = validVerdict({
      verdict: 'approve',
      riskClass: 'cross-feature-refactor',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    const event = verdictToEvent(v.verdict, 1, v.riskClass);
    expect(event).toBe('reviewer-approve');
    expect(transition('reviewing', event, v.riskClass)).toEqual({
      type: 'transition',
      nextState: 'approved',
    });
  });

  it('approve + public-API-change → STOP (the human gate is preserved)', () => {
    const v = validVerdict({
      verdict: 'approve',
      riskClass: 'public-API-change',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    const event = verdictToEvent(v.verdict, 1, v.riskClass);
    expect(event).toBe('reviewer-approve-public-api');
    expect(transition('reviewing', event, v.riskClass)).toEqual({
      type: 'stop',
      reason: 'public-api-approval-required',
      severity: 'blocking',
    });
  });

  it('changes-requested (iter 1) → re-dispatched; (iter 2) → STOP cap-exhausted', () => {
    const v = validVerdict({
      verdict: 'changes-requested',
      riskClass: 'isolated-refactor',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    expect(
      transition('reviewing', verdictToEvent(v.verdict, 1, v.riskClass)),
    ).toEqual({
      type: 'transition',
      nextState: 're-dispatched',
    });
    expect(
      transition('re-dispatched', verdictToEvent(v.verdict, 2, v.riskClass)),
    ).toEqual({
      type: 'stop',
      reason: 're-dispatch-cap-exhausted',
      severity: 'error',
    });
  });
});

// ─── briefProfile is removed — it must NOT be required, and is now rejected ────

describe('briefProfile is removed (ADR-0016 uniform reviewer)', () => {
  it('a verdict without briefProfile is well-formed', () => {
    const v = validVerdict();
    expect('briefProfile' in v).toBe(false);
    expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
  });

  it('briefProfile is absent from required[] and properties', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.required).not.toContain('briefProfile');
    expect('briefProfile' in REVIEWER_VERDICT_JSON_SCHEMA.properties).toBe(false);
  });

  it('the schema is closed so a stray briefProfile would be rejected', () => {
    // additionalProperties:false is the enforcement surface (the Workflow tool
    // validates against the JSON Schema, not validateReviewerVerdict).
    expect(REVIEWER_VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

// ─── metAcIndexes — the single-owner met-AC derivation (FOR-17) ────────────
//
// This is the ONE engine owner of "which AC indexes does wave-close tick at
// close?" — the wire `IssueStore.close(id, prUrl, ackedAcIndexes)` has taken
// since ADR-0004, dead until this. Covered here so no skill ever re-derives
// it by ad-hoc parsing acVerification[] itself.

/**
 * Render a ReviewerVerdict exactly as `write-verdict` (route-cli.ts) writes a
 * real sidecar to `<verdictsDir>/<id>-<iter>.md` — a fenced ```json block
 * under a heading — and extract it back the way the resume-path reader
 * (sidecar.ts's `readSidecars`) does. Round-tripping through this on-disk
 * shape (rather than handing `metAcIndexes` an in-memory object straight from
 * the test) is the "real verdict sidecar fixture" the derivation is proven
 * against — the exact bytes wave-close's engine verb reads off disk.
 */
function renderSidecar(id: string, iter: number, verdict: ReviewerVerdict): string {
  return (
    `# ReviewerVerdict ${id} iter ${iter}\n\n` +
    '```json\n' +
    JSON.stringify(verdict, null, 2) +
    '\n```\n'
  );
}

function parseSidecarJson(raw: string): unknown {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(raw);
  return JSON.parse(m ? m[1] : raw);
}

describe('metAcIndexes — met-AC index derivation (FOR-17, the dead --acked wire)', () => {
  it('returns the 0-based indexes of ONLY the `met` rows — partial/not-met/deferred excluded', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'partial', evidence: 'b' },
        { ac: '#3', met: 'not-met', evidence: 'c' },
        { ac: '#4', met: 'met', evidence: 'd' },
        { ac: '#5', met: 'deferred', evidence: 'e' },
      ],
    });
    expect(metAcIndexes(v)).toEqual([0, 3]);
  });

  it('returns [] when no AC is met', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'partial', evidence: 'a' },
        { ac: '#2', met: 'not-met', evidence: 'b' },
      ],
    });
    expect(metAcIndexes(v)).toEqual([]);
  });

  it('returns [] on an empty acVerification (issue with no ACs)', () => {
    expect(metAcIndexes(validVerdict({ acVerification: [] }))).toEqual([]);
  });

  it('derives against a REAL verdict sidecar fixture — the on-disk write-verdict shape', () => {
    const written = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'tools/wave/src/cli.ts:42' },
        { ac: '#2', met: 'partial', evidence: 'reviewed, one edge case missing' },
        { ac: '#3', met: 'met', evidence: 'tools/wave/src/reviewer-verdict-schema.ts:99' },
      ],
    });
    const sidecar = renderSidecar('17', 1, written);
    const parsed = parseSidecarJson(sidecar);
    const check = validateReviewerVerdict(parsed);
    expect(check).toEqual({ valid: true, errors: [] });
    expect(metAcIndexes(parsed as ReviewerVerdict)).toEqual([0, 2]);
  });

  it('after a changes-requested → re-dispatch cycle, indexes come from the LATEST iteration', () => {
    // iter 1: changes-requested, only AC #1 verified met so far.
    const iter1 = validVerdict({
      verdict: 'changes-requested',
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'not-met', evidence: 'missing test' },
      ],
    });
    // iter 2 (post re-dispatch): approve, both ACs now met.
    const iter2 = validVerdict({
      verdict: 'approve',
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'met', evidence: 'fixed in re-dispatch' },
      ],
    });
    const sidecar1 = parseSidecarJson(renderSidecar('17', 1, iter1)) as ReviewerVerdict;
    const sidecar2 = parseSidecarJson(renderSidecar('17', 2, iter2)) as ReviewerVerdict;

    expect(metAcIndexes(sidecar1)).toEqual([0]);
    // The engine's sidecar reader (sidecar.ts's readSidecars/verdictFor) is the
    // MAX-iter selector wave-close's `verdict-acked` CLI verb calls before
    // handing the verdict to metAcIndexes — this proves the derivation itself
    // reflects whichever verdict it is given, so the LATEST iteration's verdict
    // (never the stale one) is what must reach it.
    expect(metAcIndexes(sidecar2)).toEqual([0, 1]);
  });
});

// ─── renderVerdictSection — the PR-body render (FOR-16) ─────────────────────
//
// AC1: renders verdict + iteration, the per-AC table (met/partial/not-met with
// evidence), re-run verify counts, anchor SHA, and advisory notes — proven
// against a REAL verdict sidecar fixture (the same on-disk round-trip
// `metAcIndexes` above is proven against, not an in-memory object handed
// straight to the function under test).
// AC3: after a changes-requested → re-dispatch cycle, the render carries the
// LATEST iteration's verdict, not the first.

describe('renderVerdictSection — the PR-body render (FOR-16)', () => {
  const ANCHOR = '94437315bfd3ffd4ec8651626240a0d60c33d03b';

  it('renders verdict + iteration + risk class + anchor SHA', () => {
    const v = validVerdict({ verdict: 'approve', riskClass: 'isolated-refactor' });
    const out = renderVerdictSection(v, { iteration: 2, anchorSha: ANCHOR });
    expect(out).toContain('## Reviewer verdict');
    expect(out).toContain('**Verdict:** approve (iteration 2)');
    expect(out).toContain('**Risk class:** isolated-refactor');
    expect(out).toContain(`**Anchor SHA:** \`${ANCHOR}\``);
  });

  it('renders the per-AC verification table with met/partial/not-met + evidence', () => {
    // Non-id-shaped AC labels (`AC1`, not `#1`) so this row-rendering test is not
    // entangled with the foreign-id scrub — that is covered on its own below.
    const v = validVerdict({
      acVerification: [
        { ac: 'AC1', met: 'met', evidence: 'tools/wave/src/cli.ts:42' },
        { ac: 'AC2', met: 'partial', evidence: 'reviewed, one edge case missing' },
        { ac: 'AC3', met: 'not-met', evidence: 'not implemented' },
      ],
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('| AC | Status | Evidence |');
    expect(out).toContain('| AC1 | met | tools/wave/src/cli.ts:42 |');
    expect(out).toContain('| AC2 | partial | reviewed, one edge case missing |');
    expect(out).toContain('| AC3 | not-met | not implemented |');
  });

  it('renders "no acceptance criteria declared" for an empty acVerification', () => {
    const v = validVerdict({ acVerification: [] });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('_No acceptance criteria declared._');
    expect(out).not.toContain('| AC | Status | Evidence |');
  });

  it('renders the re-run verify counts (lintTestSummary)', () => {
    const v = validVerdict({ lintTestSummary: '1548/1548 green, 0 type errors' });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('**Verify:** 1548/1548 green, 0 type errors');
  });

  it('renders "not reported" when lintTestSummary is absent (optional field)', () => {
    const bad = { ...validVerdict() } as Partial<ReviewerVerdict>;
    delete bad.lintTestSummary;
    const out = renderVerdictSection(bad as ReviewerVerdict, {
      iteration: 1,
      anchorSha: ANCHOR,
    });
    expect(out).toContain('**Verify:** not reported');
  });

  it('renders advisory notes (reviewerFocusItems) as a bullet list', () => {
    // Id-free advisory text so this bullet-list test is not entangled with the
    // foreign-id scrub (covered on its own below).
    const v = validVerdict({
      reviewerFocusItems: [
        '(advisory) consider a stall-watchdog follow-up',
        'a sibling branch touches the same file — merge-tree overlap',
      ],
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('**Advisories:**');
    expect(out).toContain('- (advisory) consider a stall-watchdog follow-up');
    expect(out).toContain('- a sibling branch touches the same file — merge-tree overlap');
  });

  it('renders "- none" when there are no advisory notes', () => {
    const v = validVerdict({ reviewerFocusItems: [] });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('**Advisories:**\n- none');
  });

  it('escapes a pipe in an evidence cell so it cannot break the markdown table', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'ambiguous cell | with a pipe' },
      ],
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('ambiguous cell \\| with a pipe');
  });

  it('renders against a REAL verdict sidecar fixture — the on-disk write-verdict shape', () => {
    const written = validVerdict({
      verdict: 'approve',
      acVerification: [
        { ac: 'AC1', met: 'met', evidence: 'tools/wave/src/cli.ts:42' },
        { ac: 'AC2', met: 'met', evidence: 'tools/wave/src/reviewer-verdict-schema.ts:99' },
      ],
      lintTestSummary: '1548/1548 green, 0 type errors',
    });
    const sidecar = renderSidecar('16', 1, written);
    const parsed = parseSidecarJson(sidecar);
    const check = validateReviewerVerdict(parsed);
    expect(check).toEqual({ valid: true, errors: [] });

    const out = renderVerdictSection(parsed as ReviewerVerdict, {
      iteration: 1,
      anchorSha: ANCHOR,
    });
    expect(out).toContain('**Verdict:** approve (iteration 1)');
    expect(out).toContain('| AC1 | met | tools/wave/src/cli.ts:42 |');
    expect(out).toContain('**Verify:** 1548/1548 green, 0 type errors');
  });

  it('after a changes-requested → re-dispatch cycle, the render carries the LATEST iteration — not the first (AC3)', () => {
    // iter 1: changes-requested, one AC still failing. (Non-id-shaped AC labels
    // — `AC1`/`AC2`, not `#1`/`#2` — keep this iteration-selection test out of
    // the foreign-id scrub, covered on its own below.)
    const iter1 = validVerdict({
      verdict: 'changes-requested',
      acVerification: [
        { ac: 'AC1', met: 'met', evidence: 'a' },
        { ac: 'AC2', met: 'not-met', evidence: 'missing test' },
      ],
      reviewerFocusItems: ['add the missing test for the second AC'],
      lintTestSummary: '20/21 green',
    });
    // iter 2 (post re-dispatch): approve, both ACs now met.
    const iter2 = validVerdict({
      verdict: 'approve',
      acVerification: [
        { ac: 'AC1', met: 'met', evidence: 'a' },
        { ac: 'AC2', met: 'met', evidence: 'fixed in re-dispatch' },
      ],
      reviewerFocusItems: [],
      lintTestSummary: '21/21 green',
    });
    const sidecar1 = parseSidecarJson(renderSidecar('16', 1, iter1)) as ReviewerVerdict;
    const sidecar2 = parseSidecarJson(renderSidecar('16', 2, iter2)) as ReviewerVerdict;

    // The PR-open step renders whichever verdict the sidecar reader's max-iter
    // selection hands it (sidecar.ts's readSidecars/verdictFor) — proving THIS
    // is iter 2's verdict, never iter 1's stale one, is the render-level half
    // of AC3 (the reader-level half is already proven in sidecar.spec.ts).
    const stale = renderVerdictSection(sidecar1, { iteration: 1, anchorSha: ANCHOR });
    const latest = renderVerdictSection(sidecar2, { iteration: 2, anchorSha: ANCHOR });

    expect(latest).toContain('**Verdict:** approve (iteration 2)');
    expect(latest).toContain('| AC2 | met | fixed in re-dispatch |');
    expect(latest).toContain('**Verify:** 21/21 green');
    expect(latest).toContain('**Advisories:**\n- none');

    expect(stale).not.toEqual(latest);
    expect(stale).toContain('**Verdict:** changes-requested (iteration 1)');
  });
});

// ─── foreign-tracker-id scrub in the render (the mention-footgun backstop) ──
//
// On a tracker with a native GitHub integration EVERY bare tracker id in a
// merged PR's title/body is linkable and actable (the mention footgun,
// wave-shared Convention 4 — burned live twice). The render is the single-owner
// composition of the `## Reviewer verdict` PR-body section, so it is the
// structural place to neutralize a foreign id that slipped into the Reviewer's
// evidence. The row's OWN id is the intended close target and passes through;
// every OTHER id-shaped token is neutralized into a spelling that stays
// human-readable but a native integration's id scan can no longer match.

// The word joiner the render inserts before the digits of a neutralized id. It
// is zero-width, so the id renders unchanged to a human; but the digits are no
// longer adjacent to the id's sigil/hyphen, so `#\d+` / `[A-Z]+-\d+` no longer
// matches. Strip it back out and the original human-readable token returns.
const WJ = '\u2060';
const stripJoiner = (s: string): string => s.replace(new RegExp(WJ, 'g'), '');

/**
 * A native tracker integration's id scan: bare Linear team ids (`[A-Z]+-\d+`)
 * and bare GitHub issue refs (`#\d+`). The test asserts the render output holds
 * NO scannable token (except an exempt own id) — i.e. this scan, run over the
 * rendered markdown, finds nothing to linkify.
 */
function integrationIdScan(rendered: string): string[] {
  return rendered.match(/[A-Z][A-Z0-9]*-\d+|#\d+/g) ?? [];
}

describe('neutralizeForeignTrackerIds — the unit transform', () => {
  it('breaks a Linear team id so an integration scan misses it, yet a human still reads it', () => {
    const out = neutralizeForeignTrackerIds('see FOR-16 for context', 'FOR-74');
    expect(out).not.toContain('FOR-16'); // the contiguous scannable token is gone
    expect(out).toContain(`FOR-${WJ}16`); // broken by the joiner
    expect(stripJoiner(out)).toBe('see FOR-16 for context'); // human still reads FOR-16
    expect(integrationIdScan(out)).toEqual([]);
  });

  it('breaks a GitHub issue ref the same way', () => {
    const out = neutralizeForeignTrackerIds('same failure as #99', 'FOR-74');
    expect(out).not.toContain('#99');
    expect(out).toContain(`#${WJ}99`);
    expect(stripJoiner(out)).toBe('same failure as #99');
    expect(integrationIdScan(out)).toEqual([]);
  });

  it('leaves the row OWN id untouched — it is the intended close target', () => {
    const out = neutralizeForeignTrackerIds('this is FOR-74, the close target', 'FOR-74');
    expect(out).toBe('this is FOR-74, the close target');
    expect(integrationIdScan(out)).toEqual(['FOR-74']); // own id is deliberately still scannable
  });

  it('a bare-number own id (GitHub store) also exempts its `#N` link form', () => {
    // The GitHub store mints a bare-number id ("42"); its linkable spelling is
    // "#42". Both are the own close target; a foreign "#99" is not.
    const out = neutralizeForeignTrackerIds('own #42 vs foreign #99', '42');
    expect(out).toContain('#42'); // own link form passes through
    expect(out).not.toContain('#99');
    expect(out).toContain(`#${WJ}99`);
  });

  it('with NO own id, neutralizes ALL id-shaped tokens (fail-safe default)', () => {
    const out = neutralizeForeignTrackerIds('FOR-74 and FOR-16 and #99');
    expect(out).not.toContain('FOR-74'); // even the would-be own id — nothing is exempt
    expect(out).not.toContain('FOR-16');
    expect(out).not.toContain('#99');
    expect(integrationIdScan(out)).toEqual([]);
    expect(stripJoiner(out)).toBe('FOR-74 and FOR-16 and #99'); // all still human-readable
  });

  it('neutralizes multiple foreign ids of both shapes in one string', () => {
    const out = neutralizeForeignTrackerIds(
      'blocked like FOR-16, mirrors EX-3, cf #99',
      'FOR-74',
    );
    expect(integrationIdScan(out)).toEqual([]);
    expect(stripJoiner(out)).toBe('blocked like FOR-16, mirrors EX-3, cf #99');
  });
});

describe('renderVerdictSection — neutralizes foreign tracker ids in evidence (mention footgun, Convention 4)', () => {
  const ANCHOR = '94437315bfd3ffd4ec8651626240a0d60c33d03b';

  // A verdict whose Reviewer-authored free-text fields each smuggle a foreign
  // tracker id — the exact W19 shape (an evidence string named a sibling id).
  function verdictWithForeignIds(): ReviewerVerdict {
    return validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'same fix as FOR-16, see tools/wave/src/cli.ts:42' },
        { ac: '#2', met: 'partial', evidence: 'mirrors the approach in #99' },
      ],
      reviewerFocusItems: ['sibling wave/FOR-55 touches the same file — merge-tree overlap'],
      lintTestSummary: 'green, but note the flake tracked in FOR-30',
    });
  }

  it('AC1/AC2: neutralizes every OTHER id-shaped token, own id passes through, spec-covered with representative evidence', () => {
    const out = renderVerdictSection(verdictWithForeignIds(), {
      iteration: 1,
      anchorSha: ANCHOR,
      ownId: 'FOR-74',
    });
    // No foreign id survives an integration scan of the rendered markdown...
    expect(out).not.toContain('FOR-16');
    expect(out).not.toContain('FOR-55');
    expect(out).not.toContain('FOR-30');
    expect(out).not.toContain('#99');
    expect(out).not.toContain('| #1 |'); // the AC-ordinal label `#1` is id-shaped too
    // ...but every one stays human-readable once the invisible joiner is stripped.
    expect(stripJoiner(out)).toContain('same fix as FOR-16');
    expect(stripJoiner(out)).toContain('mirrors the approach in #99');
    expect(stripJoiner(out)).toContain('sibling wave/FOR-55 touches the same file');
    expect(stripJoiner(out)).toContain('flake tracked in FOR-30');
    // The render carries NO scannable foreign id — the own id is not present in
    // this fixture's evidence, so the scan comes back empty.
    expect(integrationIdScan(out)).toEqual([]);
  });

  it("AC2: the row's own id in an evidence string passes through the render untouched", () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'closes FOR-74 (this row) alongside sibling FOR-16' },
      ],
      reviewerFocusItems: [],
      lintTestSummary: undefined,
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR, ownId: 'FOR-74' });
    expect(out).toContain('FOR-74'); // own id: intact and still linkable (intended)
    expect(out).not.toContain('FOR-16'); // sibling: neutralized
    expect(integrationIdScan(out)).toEqual(['FOR-74']); // only the own id is scannable
  });

  it('AC2: a render invoked WITHOUT an own id neutralizes ALL id-shaped tokens — the fail-safe default', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'closes FOR-74 alongside FOR-16' },
      ],
      reviewerFocusItems: [],
      lintTestSummary: undefined,
    });
    // No ownId option → nothing is exempt, not even a would-be own id.
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).not.toContain('FOR-74');
    expect(out).not.toContain('FOR-16');
    expect(integrationIdScan(out)).toEqual([]);
    expect(stripJoiner(out)).toContain('closes FOR-74 alongside FOR-16');
  });

  it('the neutralization survives the markdown-table escaping (both transforms compose)', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'FOR-16 | note the pipe' },
      ],
      reviewerFocusItems: [],
      lintTestSummary: undefined,
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR, ownId: 'FOR-74' });
    expect(out).toContain('\\|'); // pipe still escaped
    expect(out).not.toContain('FOR-16'); // id still neutralized
    expect(integrationIdScan(out)).toEqual([]);
  });
});

// ─── JSON-Schema shape (the artefact the Workflow tool enforces) ────────────

describe('REVIEWER_VERDICT_JSON_SCHEMA shape', () => {
  it('is a closed object (additionalProperties: false)', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.type).toBe('object');
    expect(REVIEWER_VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('requires riskClass (the G3 floor) alongside verdict', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.required).toEqual(
      expect.arrayContaining(['verdict', 'riskClass']),
    );
  });

  it('constrains verdict / riskClass to their canonical enums', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.properties.verdict.enum).toEqual([
      ...VERDICT_VALUES,
    ]);
    expect(REVIEWER_VERDICT_JSON_SCHEMA.properties.riskClass.enum).toEqual([
      ...RISK_VALUES,
    ]);
  });
});

// ─── enum sanity ────────────────────────────────────────────────────────────

describe('local enums', () => {
  it('AC_STATUS_VALUES is the four verification states', () => {
    expect([...AC_STATUS_VALUES]).toEqual([
      'met',
      'partial',
      'not-met',
      'deferred',
    ]);
  });

  it('DOCUMENTED_FORM_TRIGGER_VALUES is the three raisers — and no Reviewer-ruling value (ADR-0030)', () => {
    expect([...DOCUMENTED_FORM_TRIGGER_VALUES]).toEqual([
      'issue-declared',
      'worker-declared',
      'deferred-core-path',
    ]);
    // The rejected fourth option: an abstract "the Reviewer ruled this row
    // unexecutable" trigger would re-create the could-not/cannot conflation as
    // a second judgment layer, when the per-AC deferred valve already draws it.
    expect([...DOCUMENTED_FORM_TRIGGER_VALUES]).not.toContain(
      'reviewer-ruled-unexecutable',
    );
  });
});

// ─── package-root re-export (issue #216) ────────────────────────────────────
//
// The trigger vocabulary constant, the trigger type, the comparison type and
// the divergence type were engine-complete but reachable only via a deep
// import into this module — the same barrel-gap class as the disclosure
// surface (issue #177). This proves a consumer can type a ReviewerVerdict's
// `documentedFormComparison` field from a PACKAGE-ROOT import alone, with no
// deep import into './reviewer-verdict-schema' anywhere in this block.

describe('the Documented-Form Comparison surface is reachable from the package root (issue #216)', () => {
  it('DOCUMENTED_FORM_TRIGGER_VALUES imported from the root is the same vocabulary', () => {
    expect([...DOCUMENTED_FORM_TRIGGER_VALUES_FROM_ROOT]).toEqual([
      ...DOCUMENTED_FORM_TRIGGER_VALUES,
    ]);
  });

  it('a root-only import types a well-formed comparison and a divergence within it', () => {
    const trigger: DocumentedFormTriggerFromRoot = 'deferred-core-path';
    const divergence: DocumentedFormDivergenceFromRoot = {
      description: 'no --provenance flag on the publish step',
      deliberate: true,
    };
    const comparison: DocumentedFormComparisonFromRoot = {
      trigger,
      sources: ['vendor docs, root-typed'],
      divergences: [divergence],
    };

    expect(DOCUMENTED_FORM_TRIGGER_VALUES_FROM_ROOT).toContain(comparison.trigger);
  });

  it('a root-typed comparison round-trips through validateReviewerVerdict (imported directly, per this file convention)', () => {
    const documentedFormComparison: DocumentedFormComparisonFromRoot = {
      trigger: 'worker-declared',
      sources: ['README.md — "Publishing" section, root-typed fixture'],
      divergences: [],
    };
    const verdict: Partial<ReviewerVerdict> = {
      verdict: 'approve',
      branchReviewed: 'wave/216-documented-form-type-reexports',
      riskClass: 'isolated-refactor',
      workerReportDigest: 'root-typed fixture for the barrel-gap regression',
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'tools/wave/src/index.ts' },
      ],
      reviewerFocusItems: [],
      lintTestSummary: '1/1 green',
      gitStateSane: true,
      documentedFormComparison,
    };

    expect(validateReviewerVerdict(verdict as ReviewerVerdict)).toEqual({
      valid: true,
      errors: [],
    });
  });
});

// ─── the Documented-Form Comparison (ADR-0030) ──────────────────────────────
//
// A row whose CORE PATH cannot be executed before something outside the wave
// happens (a real release, a production credential, a human action) has no
// executable evidence available at all — so "does this match the form the
// vendor documents" stops being one source among several and becomes the only
// one. The founding incident is the worked example at the bottom of this block.

/** A well-formed comparison, overridable per test. */
function validComparison(
  over: Partial<DocumentedFormComparison> = {},
): DocumentedFormComparison {
  return {
    trigger: 'deferred-core-path',
    sources: [
      'actions/setup-node docs/advanced-usage.md — "Publishing to npm with Trusted Publisher (OIDC)"',
    ],
    divergences: [
      { description: 'no --provenance flag on the publish step', deliberate: true },
    ],
    ...over,
  };
}

describe('documentedFormComparison — the field is optional and flat (ADR-0030)', () => {
  it('is absent from required[] — a row with an executable core path pays nothing', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.required).not.toContain(
      'documentedFormComparison',
    );
  });

  it('is present in properties as a plain object — flat, no top-level combinator anywhere', () => {
    const schema = REVIEWER_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>;
    // The W5-F1 lesson: the agent tool's input_schema validation rejects a
    // top-level anyOf/oneOf/allOf outright — this test's own positive control
    // below. A top-level if/then, by contrast, IS accepted and genuinely
    // enforced at that boundary, so the field's flatness is not boundary-
    // forced. It stays flat because `trigger` — the antecedent a root
    // if/then would need — is a field the Reviewer itself authors: cornered
    // on a consequent it cannot satisfy, an author changes the antecedent
    // rather than failing, so a root conditional would buy shape and never
    // truth (ADR-0034 Amendment — engine refusal and schema boundary are
    // separate rungs). "required WHEN a trigger fired" lives in the Reviewer
    // contract prose instead — a placement decision, not a boundary-forced
    // one.
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      expect(schema).not.toHaveProperty(key);
    }
    const field = REVIEWER_VERDICT_JSON_SCHEMA.properties
      .documentedFormComparison as unknown as Record<string, unknown>;
    expect(field.type).toBe('object');
    expect(field.additionalProperties).toBe(false);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      expect(field).not.toHaveProperty(key);
    }
  });

  it('requires trigger/sources/divergences within the block, and pins sources to minItems 1', () => {
    const field = REVIEWER_VERDICT_JSON_SCHEMA.properties
      .documentedFormComparison;
    expect([...field.required]).toEqual(['trigger', 'sources', 'divergences']);
    expect([...field.properties.trigger.enum]).toEqual([
      ...DOCUMENTED_FORM_TRIGGER_VALUES,
    ]);
    // minItems: 1 is the STRUCTURAL half of the no-restatement rule — the
    // agent({ schema }) boundary itself refuses a source-less comparison.
    expect(field.properties.sources.minItems).toBe(1);
    expect([...field.properties.divergences.items.required]).toEqual([
      'description',
      'deliberate',
    ]);
  });

  it('a verdict WITHOUT the field is well-formed (the common case)', () => {
    const v = validVerdict();
    expect('documentedFormComparison' in v).toBe(false);
    expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
  });

  it('a verdict WITH a well-formed comparison is valid, for every trigger', () => {
    for (const trigger of DOCUMENTED_FORM_TRIGGER_VALUES) {
      const v = validVerdict({
        documentedFormComparison: validComparison({ trigger }),
      });
      expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
    }
  });

  it('accepts an EMPTY divergences list — "I compared and found nothing" is a real outcome', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({ divergences: [] }),
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
  });
});

describe('documentedFormComparison — the duty cannot be discharged by restating the Worker (ADR-0030)', () => {
  it('rejects an EMPTY sources[] — a comparison must cite what the Reviewer read itself', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({ sources: [] }),
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/sources/);
    expect(r.errors.join(' ')).toMatch(/THIS dispatch/);
  });

  it('rejects a blank sources entry — an empty citation is no citation', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({ sources: ['   '] }),
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/sources/);
  });

  it('rejects a non-array sources', () => {
    const v = validVerdict({
      documentedFormComparison: {
        ...validComparison(),
        sources: 'the Worker report' as unknown as string[],
      },
    });
    expect(validateReviewerVerdict(v).valid).toBe(false);
  });
});

describe('documentedFormComparison — malformed blocks are rejected', () => {
  it('rejects an out-of-enum trigger', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({
        trigger: 'reviewer-hunch' as DocumentedFormTrigger,
      }),
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/documentedFormComparison\.trigger/);
  });

  it('rejects a non-object comparison', () => {
    const v = validVerdict({
      documentedFormComparison:
        'compared, looked fine' as unknown as DocumentedFormComparison,
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/documentedFormComparison must be an object/);
  });

  it('rejects a divergence missing its deliberate classification', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({
        divergences: [
          { description: 'caching left on' } as unknown as {
            description: string;
            deliberate: boolean;
          },
        ],
      }),
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(
      /documentedFormComparison\.divergences\[0\]\.deliberate/,
    );
  });

  it('rejects a divergence with an empty description', () => {
    const v = validVerdict({
      documentedFormComparison: validComparison({
        divergences: [{ description: '', deliberate: false }],
      }),
    });
    const r = validateReviewerVerdict(v);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(
      /documentedFormComparison\.divergences\[0\]\.description/,
    );
  });

  it('rejects a non-array divergences', () => {
    const v = validVerdict({
      documentedFormComparison: {
        ...validComparison(),
        divergences: 'three' as unknown as [],
      },
    });
    expect(validateReviewerVerdict(v).valid).toBe(false);
  });
});

describe('documentedFormComparison — reporting, never routing (ADR-0030)', () => {
  it('an approve carrying UNCOMMENTED divergences still validates and still routes to approved', () => {
    // The duty adds required REPORTING, not new ROUTING: no divergence — not
    // even three uncommented ones — auto-flips the verdict. The Reviewer may
    // still choose changes-requested on ordinary judgment; nothing does it for
    // them, and nothing does it behind their back.
    const v = validVerdict({
      verdict: 'approve',
      riskClass: 'isolated-refactor',
      documentedFormComparison: validComparison({
        divergences: [
          { description: 'registry-url is not set', deliberate: false },
          { description: 'dependency caching is enabled', deliberate: false },
          { description: 'action pinned to an outdated major', deliberate: false },
        ],
      }),
    });
    expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
    const event = verdictToEvent(v.verdict, 1, v.riskClass);
    expect(event).toBe('reviewer-approve');
    expect(transition('reviewing', event, v.riskClass)).toEqual({
      type: 'transition',
      nextState: 'approved',
    });
  });

  it('the comparison is its OWN outcome — it never becomes acVerification rows, so metAcIndexes is untouched', () => {
    const base = validVerdict({
      acVerification: [
        { ac: 'AC1', met: 'met', evidence: 'a' },
        { ac: 'AC2', met: 'deferred', evidence: 'core path unreachable pre-release' },
      ],
    });
    const withComparison = {
      ...base,
      documentedFormComparison: validComparison({
        divergences: [
          { description: 'registry-url is not set', deliberate: false },
          { description: 'dependency caching is enabled', deliberate: false },
          { description: 'action pinned to an outdated major', deliberate: false },
        ],
      }),
    };
    // Same AC rows in, same met-indexes out — three divergences add zero AC
    // rows and tick zero extra boxes. The founding incident's lesson is that
    // the ACs were not where the risk lived; folding it in would re-enact it.
    expect(withComparison.acVerification).toEqual(base.acVerification);
    expect(metAcIndexes(withComparison)).toEqual(metAcIndexes(base));
    expect(metAcIndexes(withComparison)).toEqual([0]);
  });
});

// ─── the worked example: the founding incident (ADR-0030, AC5) ──────────────
//
// The release-workflow row as it stood AT REVIEW TIME. Its core path — the
// OIDC credential exchange with the registry — cannot execute before a real
// release exists, so no test, no local run and no Reviewer could reach it;
// every acceptance criterion was verified and every one held. Three
// divergences from the registry vendor's documented example survived that
// review: a missing `registry-url`, dependency caching left on in a release
// build (vendor-advised-against on supply-chain grounds), and an outdated
// action version. One was flagged as arguable by the Worker; one was reported
// by nobody and surfaced only because the Coordinator happened to open the
// vendor's documentation for an unrelated question.

/** The vendor's documented example for trusted publishing (the authority). */
const VENDOR_DOCUMENTED_FORM = `
- uses: actions/setup-node@v6
  with:
    node-version: "22"
    registry-url: "https://registry.npmjs.org"
    package-manager-cache: false
- run: npm publish
`;

/** The release-workflow step AS IT STOOD AT REVIEW TIME — the reviewed diff. */
const RELEASE_WORKFLOW_AT_REVIEW_TIME = `
- uses: actions/setup-node@v4
  with:
    node-version: "22"
    cache: npm
- run: npm publish
`;

/**
 * The comparison a Reviewer running Check 6 against that change produces: the
 * vendor page as the source, and all three divergences, each classified
 * `deliberate: false` because none of them carried a comment at the time.
 */
const FOUNDING_INCIDENT_COMPARISON: DocumentedFormComparison = {
  trigger: 'deferred-core-path',
  sources: [
    'actions/setup-node docs/advanced-usage.md — "Publishing to npm with Trusted Publisher (OIDC)"',
  ],
  divergences: [
    {
      description:
        'registry-url is not set on the setup-node step; the vendor example sets it to the public registry',
      deliberate: false,
    },
    {
      description:
        'dependency caching is left on (cache: npm) in a release build; the vendor advises against it on supply-chain grounds — a poisoned cache can expose the OIDC credential this workflow rests on',
      deliberate: false,
    },
    {
      description:
        'actions/setup-node is pinned to v4; the vendor example pins the current major (v6)',
      deliberate: false,
    },
  ],
};

describe('worked example — the founding release-workflow row (ADR-0030, AC5)', () => {
  const ANCHOR = '94437315bfd3ffd4ec8651626240a0d60c33d03b';

  it('the comparison is well-formed and its trigger is the deferred valve on the unexecutable core path', () => {
    const v = validVerdict({
      verdict: 'approve',
      acVerification: [
        {
          ac: 'the package publishes via trusted publishing',
          met: 'deferred',
          evidence:
            'core path is the OIDC exchange — unreachable before a real release exists; probe license exhausted',
        },
      ],
      documentedFormComparison: FOUNDING_INCIDENT_COMPARISON,
    });
    expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
    expect(v.documentedFormComparison?.trigger).toBe('deferred-core-path');
  });

  it('surfaces ALL THREE divergences — and each is grounded in the two texts, not merely asserted', () => {
    const { divergences } = FOUNDING_INCIDENT_COMPARISON;
    expect(divergences).toHaveLength(3);

    // 1. registry-url: in the documented form, absent from the reviewed change.
    expect(VENDOR_DOCUMENTED_FORM).toContain('registry-url');
    expect(RELEASE_WORKFLOW_AT_REVIEW_TIME).not.toContain('registry-url');
    expect(divergences[0].description).toContain('registry-url');

    // 2. caching: the documented form disables it; the reviewed change enables it.
    expect(VENDOR_DOCUMENTED_FORM).toContain('package-manager-cache: false');
    expect(RELEASE_WORKFLOW_AT_REVIEW_TIME).toContain('cache: npm');
    expect(RELEASE_WORKFLOW_AT_REVIEW_TIME).not.toContain(
      'package-manager-cache: false',
    );
    expect(divergences[1].description).toContain('caching');

    // 3. action version: the documented form pins v6; the reviewed change v4.
    expect(VENDOR_DOCUMENTED_FORM).toContain('actions/setup-node@v6');
    expect(RELEASE_WORKFLOW_AT_REVIEW_TIME).toContain('actions/setup-node@v4');
    expect(divergences[2].description).toContain('v4');

    // None of the three was commented at the time — so none is deliberate, and
    // the classification is a fact about the diff, not a judgment about merit.
    expect(divergences.every((d) => d.deliberate === false)).toBe(true);
  });

  it('all three reach the human PR-body brief as their own section — not as AC rows', () => {
    const v = validVerdict({
      verdict: 'approve',
      acVerification: [
        {
          ac: 'the package publishes via trusted publishing',
          met: 'deferred',
          evidence: 'OIDC exchange unreachable before a real release',
        },
      ],
      reviewerFocusItems: [],
      lintTestSummary: 'no verify profile',
      documentedFormComparison: FOUNDING_INCIDENT_COMPARISON,
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });

    expect(out).toContain('**Documented-form comparison** (trigger: deferred-core-path)');
    expect(out).toContain('_Sources read in this review:_');
    expect(out).toContain('- actions/setup-node docs/advanced-usage.md');
    expect(out).toContain('_Divergences from the documented form:_');
    expect(out).toContain('- (divergence) registry-url is not set');
    expect(out).toContain('- (divergence) dependency caching is left on');
    expect(out).toContain('- (divergence) actions/setup-node is pinned to v4');
    // Its own section, never folded into the AC table.
    expect(out).toContain('| AC | Status | Evidence |');
    expect(out).not.toContain('| registry-url is not set');
    // ...and the verdict itself is untouched by the three findings.
    expect(out).toContain('**Verdict:** approve (iteration 1)');
  });

  it('a deliberate, commented departure renders as surviving review — not as a defect', () => {
    // The same workflow's real deliberate departures: `--provenance` absent and
    // no auth environment variable on the publish step, each commented in place.
    const v = validVerdict({
      reviewerFocusItems: [],
      documentedFormComparison: validComparison({
        divergences: [
          { description: 'no --provenance flag on the publish step', deliberate: true },
          { description: 'no auth environment variable on the publish step', deliberate: true },
        ],
      }),
    });
    const out = renderVerdictSection(v, { iteration: 1, anchorSha: ANCHOR });
    expect(out).toContain('- (deliberate) no --provenance flag on the publish step');
    expect(out).toContain('- (deliberate) no auth environment variable on the publish step');
    expect(out).not.toContain('(divergence) no --provenance');
  });
});

describe('renderVerdictSection — the documented-form section', () => {
  const ANCHOR = '94437315bfd3ffd4ec8651626240a0d60c33d03b';

  it('renders NO section at all when the field is absent (the common case)', () => {
    const out = renderVerdictSection(validVerdict(), {
      iteration: 1,
      anchorSha: ANCHOR,
    });
    expect(out).not.toContain('Documented-form comparison');
    expect(out).toContain('**Advisories:**');
  });

  it('renders "none" divergences distinctly from an omitted comparison', () => {
    const out = renderVerdictSection(
      validVerdict({ documentedFormComparison: validComparison({ divergences: [] }) }),
      { iteration: 1, anchorSha: ANCHOR },
    );
    expect(out).toContain('**Documented-form comparison**');
    expect(out).toContain('- none — the change matches the documented form');
  });

  it('scrubs foreign tracker ids out of sources and divergence descriptions (Convention 4)', () => {
    const out = renderVerdictSection(
      validVerdict({
        reviewerFocusItems: [],
        lintTestSummary: undefined,
        acVerification: [],
        documentedFormComparison: validComparison({
          sources: ['vendor doc, as cited in FOR-16'],
          divergences: [{ description: 'same shape as #99', deliberate: false }],
        }),
      }),
      { iteration: 1, anchorSha: ANCHOR, ownId: 'FOR-74' },
    );
    expect(out).not.toContain('FOR-16');
    expect(out).not.toContain('#99');
    expect(stripJoiner(out)).toContain('vendor doc, as cited in FOR-16');
    expect(stripJoiner(out)).toContain('same shape as #99');
    expect(integrationIdScan(out)).toEqual([]);
  });

  it('the section sits between the verify line and the advisories, in that order', () => {
    const out = renderVerdictSection(
      validVerdict({ documentedFormComparison: validComparison() }),
      { iteration: 1, anchorSha: ANCHOR },
    );
    expect(out.indexOf('**Verify:**')).toBeLessThan(
      out.indexOf('**Documented-form comparison**'),
    );
    expect(out.indexOf('**Documented-form comparison**')).toBeLessThan(
      out.indexOf('**Advisories:**'),
    );
  });
});
