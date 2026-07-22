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
  REVIEWER_VERDICT_JSON_SCHEMA,
  metAcIndexes,
  neutralizeForeignTrackerIds,
  renderVerdictSection,
  validateReviewerVerdict,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';

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
});
