import { describe, it, expect } from 'vitest';
import {
  parseHeaderBlock,
  serializeHeaderBlock,
  type HeaderBlock,
} from './header-parser';

const FIXTURES: Array<{ name: string; header: HeaderBlock }> = [
  {
    name: 'minimal required only',
    header: {
      risk: 'mechanical',
      worker: 'background',
      files: ['libs/features/shared/src/lib/_internal/format-validators.ts'],
      blockedBy: 'none',
    },
  },
  {
    name: 'files with globs + multi-entry',
    header: {
      risk: 'isolated-refactor',
      worker: 'background',
      files: [
        'libs/features/tasks/*/strings.ts',
        'libs/example-ds/src/lib/components/00-composition-helpers/icon/icon-registry.ts',
      ],
      blockedBy: 'none',
    },
  },
  {
    name: 'same-slug blockers',
    header: {
      risk: 'cross-feature-refactor',
      worker: 'background-heavy',
      files: ['libs/features/pages/institution-detail/'],
      blockedBy: [{ issue: 4 }, { issue: 7 }],
    },
  },
  {
    name: 'cross-slug blockers + estimated wallclock',
    header: {
      risk: 'public-API-change',
      worker: 'HITL-required',
      files: ['libs/example-ds/src/lib/components/2-input-and-form-controls/'],
      blockedBy: [{ slug: 'task-save-controller', issue: 1 }, { issue: 3 }],
      estimatedWallclock: '4-6h',
    },
  },
  {
    name: 'all fields including unblocks',
    header: {
      risk: 'isolated-refactor',
      worker: 'foreground',
      files: [
        '.claude/skills/wave-validate/SKILL.md',
        'tools/wave/src/header-parser.ts',
      ],
      blockedBy: [{ issue: 1 }],
      estimatedWallclock: '2h',
      unblocks: [{ issue: 7 }, { slug: 'wave-orchestration', issue: 11 }],
    },
  },
];

describe('parseHeaderBlock / serializeHeaderBlock — round-trip property', () => {
  for (const fixture of FIXTURES) {
    it(`round-trips: ${fixture.name}`, () => {
      const serialized = serializeHeaderBlock(fixture.header);
      const parsed = parseHeaderBlock(serialized);
      expect(parsed.ok, JSON.stringify(parsed, null, 2)).toBe(true);
      if (parsed.ok) {
        expect(parsed.header).toEqual(fixture.header);
      }
    });
  }
});

describe('parseHeaderBlock — required fields', () => {
  it('parses a minimal valid header out of a full issue body', () => {
    const source = [
      '# 99 — Example issue',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- libs/features/shared/src/lib/_internal/format-validators.ts',
      '**Blocked by:** none',
      '',
      '## What to build',
      '',
      'Body text.',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.risk).toBe('mechanical');
      expect(result.header.worker).toBe('background');
      expect(result.header.files).toEqual([
        'libs/features/shared/src/lib/_internal/format-validators.ts',
      ]);
      expect(result.header.blockedBy).toBe('none');
    }
  });

  it('rejects when a required field is missing', () => {
    const source = [
      '**Status:** ready-for-agent',
      '**Worker:** background',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.errors.map((e) => e.message).join('\n');
      expect(messages).toMatch(/Risk/);
    }
  });

  it('rejects an invalid Risk enum value with a clear error', () => {
    const source = [
      '**Risk:** super-risky',
      '**Worker:** background',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.field === 'Risk' && /not a valid Risk/.test(e.message),
        ),
      ).toBe(true);
    }
  });

  it('rejects an invalid Worker enum value with a clear error', () => {
    const source = [
      '**Risk:** mechanical',
      '**Worker:** rogue-claude',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.field === 'Worker' && /not a valid Worker/.test(e.message),
        ),
      ).toBe(true);
    }
  });
});

describe('parseHeaderBlock — ignores fenced code blocks', () => {
  it('does not pick up header-shaped lines inside ```…``` schema examples', () => {
    const source = [
      '# 01 — Example with schema in body',
      '',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- real/file.ts',
      '**Blocked by:** none',
      '',
      '## Schema example',
      '',
      '```markdown',
      '**Risk:** mechanical | isolated-refactor | …',
      '**Worker:** background | …',
      '**Files:**',
      '- libs/features/shared/src/lib/_internal/format-validators.ts',
      '**Blocked by:** none   (or: #04, #07)',
      '```',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    if (result.ok) {
      expect(result.header.risk).toBe('mechanical');
      expect(result.header.files).toEqual(['real/file.ts']);
    }
  });
});

describe('parseHeaderBlock — list-form Files with annotation arrows', () => {
  it('strips trailing arrow annotations from list entries', () => {
    const source = [
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- libs/features/shared/src/lib/_internal/format-validators.ts',
      '- libs/features/tasks/*/strings.ts        ← Globs allowed',
      '**Blocked by:** none',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.files).toEqual([
        'libs/features/shared/src/lib/_internal/format-validators.ts',
        'libs/features/tasks/*/strings.ts',
      ]);
    }
  });
});

describe('parseHeaderBlock — Blocked by refs', () => {
  it('parses "none"', () => {
    const result = parseHeaderBlock(minimalSource('**Blocked by:** none'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.header.blockedBy).toBe('none');
  });

  it('parses same-slug refs', () => {
    const result = parseHeaderBlock(minimalSource('**Blocked by:** #04, #07'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.blockedBy).toEqual([{ issue: 4 }, { issue: 7 }]);
    }
  });

  it('parses cross-slug refs', () => {
    const result = parseHeaderBlock(
      minimalSource('**Blocked by:** task-save-controller#01, #05'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.blockedBy).toEqual([
        { slug: 'task-save-controller', issue: 1 },
        { issue: 5 },
      ]);
    }
  });

  it('rejects malformed refs', () => {
    const result = parseHeaderBlock(
      minimalSource('**Blocked by:** 04, issue-7'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === 'Blocked by')).toBe(true);
    }
  });
});

describe('parseHeaderBlock — duplicate-field guard scoped to header region (#71)', () => {
  it('parses cleanly when an in-body Agent Brief restates a header field-label (wo#65 shape)', () => {
    // Mirrors the empirical wo#65 case: `**Category:**` appears once in the
    // header region (above the first `## `) and again in the Agent Brief below
    // it. Pre-#71 the whole-file dedup rejected this as a Duplicate field; the
    // header-region-scoped guard must let it parse.
    const source = [
      '# 65 — Example with an Agent Brief that restates header labels',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** isolated-refactor',
      '**Worker:** background-heavy',
      '**Files:**',
      '- tools/wave/src/header-parser.ts',
      '**Blocked by:** none',
      '**Category:** enhancement',
      '**Type:** skill',
      '',
      '## What to build',
      '',
      'Some body prose.',
      '',
      '## Agent Brief',
      '',
      '**Category:** enhancement',
      '**Summary:** Restating header labels as bold Markdown in the brief.',
      '**Acceptance criteria:**',
      '- something',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    if (result.ok) {
      expect(result.header.risk).toBe('isolated-refactor');
      expect(result.header.worker).toBe('background-heavy');
      expect(result.header.files).toEqual(['tools/wave/src/header-parser.ts']);
      expect(result.header.blockedBy).toBe('none');
    }
  });

  it('emits a non-fatal advisory warning when a body label shadows a header field', () => {
    const source = [
      '# 65 — Shadowing body label',
      '',
      '**Risk:** isolated-refactor',
      '**Worker:** background-heavy',
      '**Files:**',
      '- tools/wave/src/header-parser.ts',
      '**Blocked by:** none',
      '**Category:** enhancement',
      '',
      '## Agent Brief',
      '',
      '**Category:** enhancement',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toBeDefined();
      expect(
        result.warnings?.some(
          (w) =>
            w.field === 'Category' && /shadows a header field/.test(w.message),
        ),
      ).toBe(true);
    }
  });

  it('still hard-errors on a genuine duplicate WITHIN the header region', () => {
    // Two `**Risk:**` lines above the first `## ` is a real authoring mistake
    // and must remain a Duplicate field error.
    const source = [
      '# 99 — Genuine header-region duplicate',
      '',
      '**Risk:** mechanical',
      '**Risk:** isolated-refactor',
      '**Worker:** background',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
      '',
      '## What to build',
      '',
      'Body.',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.field === 'Risk' && /Duplicate field/.test(e.message),
        ),
      ).toBe(true);
    }
  });

  it('does not let a body field satisfy a missing required header field', () => {
    // `**Worker:**` only appears below the first `## ` — it must NOT be picked
    // up as the required header field; the header is incomplete → reject.
    const source = [
      '# 99 — Required field only present in body',
      '',
      '**Risk:** mechanical',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
      '',
      '## Agent Brief',
      '',
      '**Worker:** background',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.field === 'Worker' && /missing/.test(e.message),
        ),
      ).toBe(true);
    }
  });

  it('still rejects a duplicate that straddles a fenced code block in the header region', () => {
    // A fence does NOT close the header region; a real second `**Risk:**` after
    // the fence (but still above the first H2) is a genuine duplicate.
    const source = [
      '# 99 — Duplicate around a fence, no H2',
      '',
      '**Risk:** mechanical',
      '',
      '```markdown',
      '**Risk:** isolated-refactor   (schema example — must be ignored)',
      '```',
      '',
      '**Risk:** isolated-refactor',
      '**Worker:** background',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.field === 'Risk' && /Duplicate field/.test(e.message),
        ),
      ).toBe(true);
    }
  });
});

describe('parseHeaderBlock — optional fields', () => {
  it('parses Estimated wallclock + Unblocks when present', () => {
    const source = [
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- some/path.ts',
      '**Blocked by:** none',
      '**Estimated wallclock:** 30min',
      '**Unblocks:** #07, wave-orchestration#11',
    ].join('\n');

    const result = parseHeaderBlock(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.estimatedWallclock).toBe('30min');
      expect(result.header.unblocks).toEqual([
        { issue: 7 },
        { slug: 'wave-orchestration', issue: 11 },
      ]);
    }
  });

  it('omits optional fields cleanly when absent', () => {
    const result = parseHeaderBlock(minimalSource('**Blocked by:** none'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.header.estimatedWallclock).toBeUndefined();
      expect(result.header.unblocks).toBeUndefined();
    }
  });
});

function minimalSource(blockedByLine: string): string {
  return [
    '**Risk:** mechanical',
    '**Worker:** background',
    '**Files:**',
    '- some/path.ts',
    blockedByLine,
  ].join('\n');
}
