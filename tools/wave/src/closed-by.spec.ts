/**
 * Table-driven spec for the closed-by classifier (wave-orchestration #55).
 *
 * Covers all six classes (`real-pr`, `pre-fill`, `placeholder`, `sha`,
 * `prose`, `empty`), the `needsPin` predicate, and `renderPinned`.
 *
 * Key signal-precedence cases are each given an explicit named test:
 *   - A real PR URL embedded inside prose → `real-pr` (strongest signal wins)
 *   - A pre-fill URL embedded inside prose → `pre-fill` (second-strongest signal)
 *   - Both full-line and prefixed forms are tested throughout.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyClosedBy,
  needsPin,
  renderPinned,
  type ClosedByClass,
} from './closed-by';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GITHUB_REAL_PR = 'https://github.com/org/repo/pull/42';
const GITHUB_REAL_PR_WITH_ANCHOR =
  'https://github.com/org/repo/pull/42#pullrequestreview-12345';
const BITBUCKET_REAL_PR =
  'https://bitbucket.org/acme-team/nx-ui-angular-lib/pull-requests/27';
const BITBUCKET_PRE_FILL =
  'https://bitbucket.org/acme-team/nx-ui-angular-lib/pull-requests/new?source=wave-orch/55-closed-by&t=1';

// ─── classifyClosedBy — table-driven matrix ──────────────────────────────────

type ClassifyRow = { input: string; expected: ClosedByClass; label: string };

const classifyMatrix: ClassifyRow[] = [
  // ── real-pr: GitHub ────────────────────────────────────────────────────────
  {
    label: 'GitHub real PR — bare URL value',
    input: GITHUB_REAL_PR,
    expected: 'real-pr',
  },
  {
    label: 'GitHub real PR — with **Closed-by:** prefix',
    input: `**Closed-by:** ${GITHUB_REAL_PR}`,
    expected: 'real-pr',
  },
  {
    label: 'GitHub real PR — with anchor fragment',
    input: `**Closed-by:** ${GITHUB_REAL_PR_WITH_ANCHOR}`,
    expected: 'real-pr',
  },

  // ── real-pr: Bitbucket ─────────────────────────────────────────────────────
  {
    label: 'Bitbucket real PR — bare URL value',
    input: BITBUCKET_REAL_PR,
    expected: 'real-pr',
  },
  {
    label: 'Bitbucket real PR — with **Closed-by:** prefix',
    input: `**Closed-by:** ${BITBUCKET_REAL_PR}`,
    expected: 'real-pr',
  },

  // ── real-pr: embedded in prose (strongest signal wins) ────────────────────
  {
    label: 'real PR URL embedded in prose → real-pr (strongest signal wins)',
    input: `**Closed-by:** See ${GITHUB_REAL_PR} for the merged work`,
    expected: 'real-pr',
  },
  {
    label: 'Bitbucket real PR URL embedded in prose → real-pr',
    input: `**Closed-by:** Merged via ${BITBUCKET_REAL_PR} — approved by reviewer`,
    expected: 'real-pr',
  },

  // ── pre-fill ───────────────────────────────────────────────────────────────
  {
    label: 'Bitbucket pre-fill URL — bare value',
    input: BITBUCKET_PRE_FILL,
    expected: 'pre-fill',
  },
  {
    label: 'Bitbucket pre-fill URL — with **Closed-by:** prefix',
    input: `**Closed-by:** ${BITBUCKET_PRE_FILL}`,
    expected: 'pre-fill',
  },

  // ── pre-fill: embedded in prose (second-strongest signal wins) ────────────
  {
    label:
      'pre-fill URL embedded in prose → pre-fill (second-strongest signal)',
    input: `**Closed-by:** Click ${BITBUCKET_PRE_FILL} to open the PR`,
    expected: 'pre-fill',
  },

  // ── placeholder ───────────────────────────────────────────────────────────
  {
    label: 'literal <PR-URL pending> placeholder',
    input: '**Closed-by:** <PR-URL pending>',
    expected: 'placeholder',
  },
  {
    label: 'generic angle-bracket placeholder',
    input: '**Closed-by:** <pending>',
    expected: 'placeholder',
  },
  {
    label: 'placeholder without prefix',
    input: '<PR-URL pending>',
    expected: 'placeholder',
  },

  // ── sha ───────────────────────────────────────────────────────────────────
  {
    label: 'bare 7-char SHA — bare value',
    input: 'abc1234',
    expected: 'sha',
  },
  {
    label: 'bare 40-char SHA — with plain Closed-by: prefix',
    input: 'Closed-by: a3f1e9d2c8b4070605e1f2a3b4c5d6e7f8a9b0c1',
    expected: 'sha',
  },
  {
    label: 'bare 12-char SHA — bare value',
    input: 'deadbeefcafe',
    expected: 'sha',
  },

  // ── prose ─────────────────────────────────────────────────────────────────
  {
    label: 'free-text prose without any URL',
    input: '**Closed-by:** manually closed — no PR opened',
    expected: 'prose',
  },
  {
    label: 'prose with only plain URL (not a PR URL)',
    input: '**Closed-by:** https://bitbucket.org/org/repo/commits/abc1234',
    expected: 'prose',
  },

  // ── empty ─────────────────────────────────────────────────────────────────
  {
    label: 'empty string',
    input: '',
    expected: 'empty',
  },
  {
    label: 'whitespace-only string',
    input: '   \t  ',
    expected: 'empty',
  },
  {
    label: '**Closed-by:** prefix with no value',
    input: '**Closed-by:**',
    expected: 'empty',
  },
  {
    label: '**Closed-by:** prefix with only whitespace after it',
    input: '**Closed-by:**   ',
    expected: 'empty',
  },
];

describe('classifyClosedBy — all six classes', () => {
  for (const { label, input, expected } of classifyMatrix) {
    it(label, () => {
      expect(classifyClosedBy(input)).toBe(expected);
    });
  }
});

// ─── Signal-precedence guard (explicit named tests) ──────────────────────────

describe('classifyClosedBy — strongest-signal-wins precedence', () => {
  it('real PR URL + surrounding prose → real-pr (NOT prose)', () => {
    const line = `**Closed-by:** See ${GITHUB_REAL_PR} for the merged work`;
    expect(classifyClosedBy(line)).toBe('real-pr');
    expect(classifyClosedBy(line)).not.toBe('prose');
  });

  it('pre-fill URL + surrounding prose → pre-fill (NOT prose)', () => {
    const line = `**Closed-by:** Click ${BITBUCKET_PRE_FILL} to open the PR`;
    expect(classifyClosedBy(line)).toBe('pre-fill');
    expect(classifyClosedBy(line)).not.toBe('prose');
  });

  it('real PR URL wins over pre-fill URL when both appear in the same line', () => {
    // Degenerate but possible — a line that somehow has both URLs.
    // real-pr is the strongest signal and must win.
    const line = `**Closed-by:** ${GITHUB_REAL_PR} (was ${BITBUCKET_PRE_FILL})`;
    expect(classifyClosedBy(line)).toBe('real-pr');
  });
});

// ─── needsPin ────────────────────────────────────────────────────────────────

type NeedsPinRow = { input: string; expected: boolean; label: string };

const needsPinMatrix: NeedsPinRow[] = [
  // Must pin
  {
    label: 'pre-fill URL → needs pin',
    input: `**Closed-by:** ${BITBUCKET_PRE_FILL}`,
    expected: true,
  },
  {
    label: '<PR-URL pending> placeholder → needs pin',
    input: '**Closed-by:** <PR-URL pending>',
    expected: true,
  },
  {
    label: 'generic placeholder → needs pin',
    input: '**Closed-by:** <pending>',
    expected: true,
  },
  {
    label: 'pre-fill URL embedded in prose → needs pin',
    input: `**Closed-by:** Create PR here: ${BITBUCKET_PRE_FILL}`,
    expected: true,
  },

  // Must NOT pin
  {
    label: 'real PR URL (GitHub) → no pin needed',
    input: `**Closed-by:** ${GITHUB_REAL_PR}`,
    expected: false,
  },
  {
    label: 'real PR URL (Bitbucket) → no pin needed',
    input: `**Closed-by:** ${BITBUCKET_REAL_PR}`,
    expected: false,
  },
  {
    label: 'prose → no pin needed',
    input: '**Closed-by:** manually closed',
    expected: false,
  },
  {
    label: 'bare SHA → no pin needed',
    input: 'Closed-by: abc1234',
    expected: false,
  },
  {
    label: 'empty → no pin needed',
    input: '',
    expected: false,
  },
];

describe('needsPin — true only for pre-fill and placeholder', () => {
  for (const { label, input, expected } of needsPinMatrix) {
    it(label, () => {
      expect(needsPin(input)).toBe(expected);
    });
  }

  it('real-pr, prose, sha, empty all return false', () => {
    const nonPinCases = [
      GITHUB_REAL_PR,
      BITBUCKET_REAL_PR,
      'manually closed',
      'abc1234',
      '',
    ];
    for (const line of nonPinCases) {
      expect(needsPin(line)).toBe(false);
    }
  });
});

// ─── renderPinned ────────────────────────────────────────────────────────────

describe('renderPinned — canonical pinned line format', () => {
  it('produces the canonical **Closed-by:** <url> format for a GitHub PR', () => {
    expect(renderPinned(GITHUB_REAL_PR)).toBe(
      `**Closed-by:** ${GITHUB_REAL_PR}`,
    );
  });

  it('produces the canonical **Closed-by:** <url> format for a Bitbucket PR', () => {
    expect(renderPinned(BITBUCKET_REAL_PR)).toBe(
      `**Closed-by:** ${BITBUCKET_REAL_PR}`,
    );
  });

  it('the output classifies as real-pr when the input is a real PR URL', () => {
    const pinned = renderPinned(GITHUB_REAL_PR);
    expect(classifyClosedBy(pinned)).toBe('real-pr');
  });

  it('the output of renderPinned is never needsPin', () => {
    expect(needsPin(renderPinned(GITHUB_REAL_PR))).toBe(false);
    expect(needsPin(renderPinned(BITBUCKET_REAL_PR))).toBe(false);
  });
});
