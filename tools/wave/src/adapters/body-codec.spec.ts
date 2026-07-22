import { describe, it, expect } from 'vitest';
import { serializeBody, parseBody, upsertLine, tickAcs, upsertSection } from './body-codec';

describe('body-codec round-trip', () => {
  it('serializes + parses files / blockedBy / unblocks / AC / wallclock', () => {
    const body = serializeBody({
      files: ['a/b.ts', 'c/*.ts'],
      blockedBy: [{ issue: 13 }, { slug: 'other', issue: 5 }],
      unblocks: [{ issue: 20 }],
      acceptanceCriteria: [
        { text: 'first', checked: false },
        { text: 'second', checked: false },
      ],
      estimatedWallclock: '2h',
      bodySections: [{ heading: 'What to build', markdown: 'the thing' }],
    });
    const p = parseBody(body);
    expect(p.files).toEqual(['a/b.ts', 'c/*.ts']);
    expect(p.blockedBy).toEqual([{ issue: 13 }, { slug: 'other', issue: 5 }]);
    expect(p.unblocks).toEqual([{ issue: 20 }]);
    expect(p.acceptanceCriteria.map((a) => a.text)).toEqual(['first', 'second']);
    expect(p.estimatedWallclock).toBe('2h');
    expect(p.closedBy).toBeUndefined();
  });

  it('blockedBy "none" round-trips to none', () => {
    const body = serializeBody({ files: ['x'], blockedBy: 'none', acceptanceCriteria: [] });
    expect(parseBody(body).blockedBy).toBe('none');
  });

  // ── regression: tickAcs trimmed-vs-untrimmed index mismatch ────────────────
  it('tickAcs indexes agree with parseAcs even for indented AC lines', () => {
    const body = ['## Acceptance criteria', '', '  - [ ] indented one', '- [ ] normal two'].join('\n');
    // parseBody sees indexes 0,1 in order
    expect(parseBody('## Files\n- x\n\n## Blocked by\nnone\n\n' + body).acceptanceCriteria.map((a) => a.text))
      .toEqual(['indented one', 'normal two']);
    // ticking index 0 must tick "indented one" (and preserve its indentation)
    const ticked = tickAcs(body, [0]);
    expect(ticked).toContain('  - [x] indented one');
    expect(ticked).toContain('- [ ] normal two');
  });

  // ── regression: a value-less **Closed-by:** line reads as absent ───────────
  it('a value-less Closed-by line parses as undefined, not empty string', () => {
    const body = '**Closed-by:**\n\n## Files\n- x\n\n## Blocked by\nnone\n\n## Acceptance criteria\n- [ ] a\n';
    expect(parseBody(body).closedBy).toBeUndefined();
  });

  it('upsertLine then a second upsert replaces in place (idempotent close)', () => {
    let body = '## Files\n- x\n\n## Blocked by\nnone\n\n## Acceptance criteria\n- [ ] a\n';
    body = upsertLine(body, 'Closed-by', 'https://pr/1');
    body = upsertLine(body, 'Closed-by', 'https://pr/1');
    expect((body.match(/\*\*Closed-by:\*\*/g) || []).length).toBe(1);
    expect(parseBody(body).closedBy).toBe('https://pr/1');
  });
});

// ── FOR-63 / consumer KW-F1: codec-own metadata lines tolerated in Blocked-by ─
//
// Defect: serializeBody emitted its `**Parent:**` / `**Estimated wallclock:**`
// bold metadata lines AFTER the last `##` section. Without an `## Unblocks`
// section in between (unblocks absent), they landed textually INSIDE
// `## Blocked by`, where the strict fail-loud ref parser rejected them as
// unparseable refs — the codec threw on its own output for the combination
// refs + parent + no unblocks. The canonical round-trip test above carries
// `unblocks` (which shields the strict section) and no test carried `parent`,
// which is why the suite missed it.
describe('body-codec metadata-in-Blocked-by tolerance (FOR-63 / consumer KW-F1)', () => {
  const wrapBlocked = (blocked: string) =>
    [
      '## Files',
      '- src/a.ts',
      '',
      '## Blocked by',
      blocked,
      '',
      '## Acceptance criteria',
      '- [ ] a',
      '',
    ].join('\n');

  it('serialize+parse refs + parent + estimatedWallclock with NO unblocks — the exact consumer combination', () => {
    const body = serializeBody({
      files: ['a.ts'],
      blockedBy: [{ issue: 7 }, { slug: 'other', issue: 9 }],
      parent: 'PRD-1',
      estimatedWallclock: '1h',
      acceptanceCriteria: [{ text: 'do it', checked: false }],
    });
    const p = parseBody(body);
    expect(p.blockedBy).toEqual([{ issue: 7 }, { slug: 'other', issue: 9 }]);
    expect(p.parent).toBe('PRD-1');
    expect(p.estimatedWallclock).toBe('1h');
  });

  it('parseRefs filters bold-metadata lines: a metadata-only Blocked-by section reads as none', () => {
    const body = wrapBlocked('**Parent:** #1\n\n**Estimated wallclock:** 30min');
    expect(parseBody(body).blockedBy).toBe('none');
  });

  it('parses a LEGACY-ORDER body (metadata after the last section, no Unblocks to shield it)', () => {
    // Pre-fix serializeBody emitted Parent/Estimated-wallclock AFTER
    // `## Blocked by` when there was no `## Unblocks` section — landing them
    // textually inside `## Blocked by`. A body already filed in that shape
    // must still parse.
    const legacyBody = [
      '## Files',
      '- a.ts',
      '',
      '## Blocked by',
      'FOR#7, other#9',
      '',
      '**Parent:** #PRD-1',
      '',
      '**Estimated wallclock:** 1h',
      '',
      '## Acceptance criteria',
      '- [ ] do it',
      '',
    ].join('\n');
    const p = parseBody(legacyBody);
    expect(p.blockedBy).toEqual([
      { slug: 'FOR', issue: 7 },
      { slug: 'other', issue: 9 },
    ]);
    expect(p.parent).toBe('PRD-1');
    expect(p.estimatedWallclock).toBe('1h');
  });

  it('fail-loud is preserved: a hand-written wrong-form ref token in Blocked-by still throws naming it', () => {
    expect(() => parseBody(wrapBlocked('FOR-23\n\n**Parent:** #1'))).toThrow(/FOR-23/);
  });

  it('compose-side belt: serializeBody emits Parent / Estimated-wallclock BEFORE the Files section', () => {
    const body = serializeBody({
      files: ['a.ts'],
      blockedBy: 'none',
      parent: 'PRD-2',
      estimatedWallclock: '2h',
      acceptanceCriteria: [{ text: 'x', checked: false }],
    });
    const parentIdx = body.indexOf('**Parent:**');
    const wallclockIdx = body.indexOf('**Estimated wallclock:**');
    const filesIdx = body.indexOf('## Files');
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(wallclockIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeLessThan(filesIdx);
    expect(wallclockIdx).toBeLessThan(filesIdx);
  });
});

// ── FOR-31 / W4-F2: parseBlockedBy fails loud, never fabricates `none` ────────
//
// The pre-FOR-31 defect: a `## Blocked by` section that is non-empty, is not the
// literal `none`, and contains no parseable ref decoded to `blockedBy: 'none'` —
// absence read as fact. Found live: re-scoping FOR-20 wrote the human-readable
// `FOR-23` (the codec's wire form is `FOR#23`), the engine read it back as
// `none`, and `dor` reported PASS on a still-blocked row. "I found nothing" and
// "there is nothing" are different claims; only one of them is evidence.
describe('body-codec blocked-by fail-loud (FOR-31 / W4-F2)', () => {
  const wrap = (blocked: string) =>
    [
      '## Files',
      '- src/a.ts',
      '',
      '## Blocked by',
      blocked,
      '',
      '## Acceptance criteria',
      '- [ ] a',
      '',
    ].join('\n');

  it('rejects the exact live case (`FOR-23` where `FOR#23` was meant) instead of decoding to none', () => {
    expect(() => parseBody(wrap('FOR-23'))).toThrow(/FOR-23/);
    // and specifically NOT the fabricated-none behaviour
    expect(() => parseBody(wrap('FOR-23'))).toThrow();
  });

  it('rejects a partially-parseable list rather than silently dropping the bad entry', () => {
    // `FOR#23` parses; `FOR-24` does not — the section must fail loud, not decode to just [FOR#23].
    expect(() => parseBody(wrap('FOR#23, FOR-24'))).toThrow(/FOR-24/);
  });

  it('the rejection names the section and points to the canonical spelling / inversion', () => {
    let msg = '';
    try {
      parseBody(wrap('FOR-23'));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Blocked by/);
    expect(msg).toMatch(/FOR#23|<slug>#NN|parse-ref/);
  });

  it('the legitimate forms still round-trip unchanged (not weakened): none, single ref, comma list, slug-less #NN', () => {
    expect(parseBody(wrap('none')).blockedBy).toBe('none');
    expect(parseBody(wrap('FOR#23')).blockedBy).toEqual([{ slug: 'FOR', issue: 23 }]);
    expect(parseBody(wrap('FOR#23, other#5')).blockedBy).toEqual([
      { slug: 'FOR', issue: 23 },
      { slug: 'other', issue: 5 },
    ]);
    expect(parseBody(wrap('#42')).blockedBy).toEqual([{ issue: 42 }]);
  });

  it('a bullet-list of legitimate refs still round-trips', () => {
    expect(parseBody(wrap('- FOR#23\n- other#5')).blockedBy).toEqual([
      { slug: 'FOR', issue: 23 },
      { slug: 'other', issue: 5 },
    ]);
  });
});

// ── upsertSection (the Amend facet's section writer, ADR-0025 / FOR-33) ───────
describe('upsertSection', () => {
  const withSection = serializeBody({
    files: ['a.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'ac one', checked: false }],
    bodySections: [{ heading: 'What to build', markdown: 'the ORIGINAL brief' }],
  });

  it('REPLACES an existing section content in place (no shadow duplicate)', () => {
    const out = upsertSection(withSection, 'What to build', 'the NEW brief');
    // exactly one `## What to build` heading line — the append-based path left two
    const headings = out.split('\n').filter((l) => /^##\s+What to build\s*$/.test(l));
    expect(headings.length).toBe(1);
    expect(out).toContain('the NEW brief');
    expect(out).not.toContain('the ORIGINAL brief');
    // the managed sections still parse (files / blockedBy / AC untouched)
    const p = parseBody(out);
    expect(p.files).toEqual(['a.ts']);
    expect(p.blockedBy).toBe('none');
    expect(p.acceptanceCriteria.map((a) => a.text)).toEqual(['ac one']);
  });

  it('read-back reads the REPLACED content, not a shadowed old copy', () => {
    // regression against the appendBodySections hazard: appending a same-heading
    // section leaves the OLD one first, which sectionBody (parseBody) reads.
    const twice = upsertSection(
      upsertSection(withSection, 'What to build', 'first replacement'),
      'What to build',
      'second replacement',
    );
    const headings = twice.split('\n').filter((l) => /^##\s+What to build\s*$/.test(l));
    expect(headings.length).toBe(1);
    expect(twice).toContain('second replacement');
    expect(twice).not.toContain('first replacement');
    expect(twice).not.toContain('the ORIGINAL brief');
  });

  it('APPENDS an absent section, preserving every managed section', () => {
    const out = upsertSection(withSection, 'Notes', 'a fresh note');
    expect(out).toContain('## Notes');
    expect(out).toContain('a fresh note');
    expect(out).toContain('the ORIGINAL brief'); // the pre-existing prose survives
    const p = parseBody(out);
    expect(p.files).toEqual(['a.ts']);
    expect(p.acceptanceCriteria.map((a) => a.text)).toEqual(['ac one']);
  });

  it('matches the heading case-insensitively (same as sectionBody)', () => {
    const out = upsertSection(withSection, 'WHAT TO BUILD', 'case-insensitive replace');
    const headings = out.split('\n').filter((l) => /^##\s+/i.test(l) && /what to build/i.test(l));
    expect(headings.length).toBe(1);
    expect(out).toContain('case-insensitive replace');
    expect(out).not.toContain('the ORIGINAL brief');
  });

  it('THROWS on each reserved heading, naming annotate', () => {
    for (const reserved of ['Files', 'Blocked by', 'Unblocks', 'Acceptance criteria']) {
      expect(() => upsertSection(withSection, reserved, 'x')).toThrow(/annotate/i);
    }
    // case-insensitively too
    expect(() => upsertSection(withSection, 'acceptance criteria', 'x')).toThrow(/annotate/i);
  });

  it('preserves multi-line markdown content verbatim', () => {
    const md = 'line one\n\n- bullet a\n- bullet b';
    const out = upsertSection(withSection, 'What to build', md);
    expect(out).toContain('line one');
    expect(out).toContain('- bullet a');
    expect(out).toContain('- bullet b');
  });
});
