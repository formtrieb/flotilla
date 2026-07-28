import { describe, it, expect } from 'vitest';
import {
  spineStoreFromSource,
  readDisclosures,
  renderDisclosureRow,
  renderDisclosuresSection,
  ensureDisclosuresSection,
  addDisclosureToSource,
  setDispositionInSource,
  openDisclosures,
  isSettableDisposition,
  normalizeDisclosureText,
  DISCLOSURE_SOURCES,
  OPEN_DISPOSITION,
} from './spine-store';
import { readSpine, renderSpine } from './wave-md-rw';

const SRC = `# Wave 2026-06-06 — test

**Status:** in-flight

## Plan-Table

| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |
| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |
| 01  | T 01  | background | mechanical | quick-verify | — | planned | 1 | — |

## PR-Log

| Created | ID | PR | Closes | Merged | Notes |
| ------- | -- | -- | ------ | ------ | ----- |
| — | — | — | — | — | _(none)_ |

## Resume-Metadata

\`\`\`yaml
dispatch-log:
  - "01 → agent a01 (sonnet)  branch wave-orch/01-thing"
\`\`\`
`;

describe('SpineStore — byte-preserving wrapper over wave-md-rw', () => {
  it('parses the spine and exposes rowState + branchesByIssueId', () => {
    const s = spineStoreFromSource(SRC);
    expect(s.rowState('01')).toBe('planned');
    expect(s.branchesByIssueId()['01']).toBe('wave-orch/01-thing');
  });

  it('setRowState mutates + re-parses; source() reflects it; other bytes preserved', () => {
    const s = spineStoreFromSource(SRC);
    s.setRowState('01', 'dispatched');
    expect(s.rowState('01')).toBe('dispatched');
    expect(s.source()).toMatch(/\| dispatched \|/);
    expect(s.source()).toContain('## Resume-Metadata'); // surrounding sections intact
  });

  it('a no-op stays byte-identical', () => {
    const s = spineStoreFromSource(SRC);
    const before = s.source();
    expect(before).toBe(SRC);
  });

  it('reload()/flush() throw without a disk-backed store', () => {
    const s = spineStoreFromSource(SRC);
    expect(() => s.reload()).toThrow();
    expect(() => s.flush()).toThrow();
  });

  it('upsertDispatchLogModel records the model without disturbing the branch (ADR-0012)', () => {
    const s = spineStoreFromSource(SRC);
    s.upsertDispatchLogModel('01', 'claude-opus-4-8');
    const entry = s.spine().dispatchLog.find((e) => e.id === '01');
    expect(entry?.model).toBe('claude-opus-4-8');
    expect(entry?.branch).toBe('wave-orch/01-thing');
    expect(s.branchesByIssueId()['01']).toBe('wave-orch/01-thing');
  });
});

// ─── Disclosures (ADR-0027) ──────────────────────────────────────────────────
//
// A disclosure is captured into the spine at verdict-routing and must carry a
// disposition before the wave archives. The section is engine-rendered AND
// engine-parsed — the printer/parser pair (ADR-0016) is what these specs pin.

/** A spine that pre-dates ADR-0027: no `## Disclosures` section at all. */
const ARCHIVED_SRC = SRC;

const META = {
  slug: 'demo',
  description: 'd',
  coordinator: 'at',
  model: 'Opus 4.8',
  created: '2026-07-28',
  lastUpdated: '2026-07-28 10:00',
};
const ROSTER = [
  { id: '156', title: 'Spine disclosures', worker: 'background-heavy', risk: 'public-API-change' },
  { id: '157', title: 'Sibling row', worker: 'background', risk: 'mechanical' },
];

/** A fresh spine, exactly as `spine create` composes it. */
function freshSpine(): string {
  return ensureDisclosuresSection(
    renderSpine(META, ROSTER, { issues: [], cells: [] }, 'all pass.'),
  );
}

describe('Disclosures — the section printer/parser pair (ADR-0027)', () => {
  it('a fresh spine carries the section, and it reads back as zero entries', () => {
    const src = freshSpine();
    expect(src).toContain('## Disclosures');
    expect(src).toContain('| Ref | Row | Iter | Source | Disposition | Text |');
    expect(readDisclosures(src)).toEqual([]);
    // The section is additive — every pre-existing section still parses.
    const spine = readSpine(src);
    expect(spine.planTable).toHaveLength(2);
    expect(spine.frontmatter.status).toBe('draft');
  });

  it('BACKWARD COMPATIBLE: a spine WITHOUT the section still parses, and reads as zero disclosures', () => {
    expect(ARCHIVED_SRC).not.toContain('## Disclosures');
    expect(readDisclosures(ARCHIVED_SRC)).toEqual([]);
    expect(openDisclosures(ARCHIVED_SRC)).toEqual([]);
    // The wave-md-rw view is unaffected — this is the every-archived-spine case.
    expect(readSpine(ARCHIVED_SRC).planTable[0].id).toBe('01');
  });

  it('write-then-read round-trips BYTE-PRESERVING: re-rendering a parsed entry reproduces its source line', () => {
    const { source: withOne } = addDisclosureToSource(freshSpine(), {
      rowId: '156',
      iter: 1,
      source: 'worker',
      text: 'the consuming call-site lies outside the declared Files globs',
    });
    const { source: withTwo } = addDisclosureToSource(withOne, {
      rowId: '157',
      iter: 2,
      source: 'reviewer',
      text: 'a compose project survived the run | ports still held',
    });

    const entries = readDisclosures(withTwo);
    expect(entries).toHaveLength(2);

    // The parser's line index + the printer agree, cell for cell, byte for byte.
    const lines = withTwo.split('\n');
    for (const entry of entries) {
      expect(lines[entry.line]).toBe(renderDisclosureRow(entry));
    }

    // Re-rendering the WHOLE section from the parsed entries is byte-identical
    // to the slice of the source it came from.
    const start = lines.indexOf('## Disclosures');
    const rendered = renderDisclosuresSection(entries).split('\n');
    expect(lines.slice(start, start + rendered.length)).toEqual(rendered);

    // A raw pipe in the prose survives the escape/unescape round-trip.
    expect(entries[1].text).toBe('a compose project survived the run | ports still held');
  });

  it('capture lands at `open`, source-neutral, with a stable per-row ref', () => {
    let src = freshSpine();
    const refs: string[] = [];
    for (const source of DISCLOSURE_SOURCES) {
      const out = addDisclosureToSource(src, { rowId: '156', iter: 1, source, text: `${source} said so` });
      src = out.source;
      refs.push(out.disclosure.ref);
      expect(out.disclosure.disposition).toBe(OPEN_DISPOSITION);
    }
    // Ordinals are 1-based PER ROW and never reused.
    expect(refs).toEqual(['156.1', '156.2', '156.3']);
    // A different row restarts at 1 — the ref is (row, ordinal), not global.
    const other = addDisclosureToSource(src, { rowId: '157', iter: 1, source: 'coordinator', text: 'x' });
    expect(other.disclosure.ref).toBe('157.1');
    // All four sources landed identically-shaped.
    expect(readDisclosures(other.source).map((d) => d.source)).toEqual([
      'worker',
      'reviewer',
      'coordinator',
      'coordinator',
    ]);
  });

  it('capture materializes the section on a spine that pre-dates ADR-0027, leaving every other section byte-identical', () => {
    const { source: after, disclosure } = addDisclosureToSource(ARCHIVED_SRC, {
      rowId: '01',
      iter: 1,
      source: 'coordinator',
      text: 'gate 8 ships inert',
    });
    expect(disclosure.ref).toBe('01.1');
    expect(after).toContain('## Disclosures');
    // Everything that was there before is untouched, prefix-identical.
    expect(after.startsWith(ARCHIVED_SRC.replace(/\n$/, ''))).toBe(true);
    expect(after).toContain('branch wave-orch/01-thing');
    expect(readSpine(after).planTable[0].state).toBe('planned');
  });

  it('capture normalizes multi-line prose to one cell-safe line', () => {
    expect(normalizeDisclosureText('a\nb   c\t\td ')).toBe('a b c d');
    const { source, disclosure } = addDisclosureToSource(freshSpine(), {
      rowId: '156',
      iter: 1,
      source: 'worker',
      text: 'first line\nsecond line',
    });
    expect(disclosure.text).toBe('first line second line');
    expect(readDisclosures(source)[0].text).toBe('first line second line');
  });

  it('capture fails loud on an unknown row id, an unknown source, a bad iter and empty text', () => {
    const src = freshSpine();
    const base = { rowId: '156', iter: 1, source: 'worker' as const, text: 'a gap' };
    expect(() => addDisclosureToSource(src, { ...base, rowId: '999' })).toThrow(/no Plan-Table row/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => addDisclosureToSource(src, { ...base, source: 'nobody' as any })).toThrow(/unknown source/);
    expect(() => addDisclosureToSource(src, { ...base, iter: 0 })).toThrow(/invalid iter/);
    expect(() => addDisclosureToSource(src, { ...base, text: '   ' })).toThrow(/empty/);
  });

  it('ensureDisclosuresSection is idempotent — a second call is byte-identical', () => {
    const once = freshSpine();
    expect(ensureDisclosuresSection(once)).toBe(once);
  });

  it('ensureDisclosuresSection scaffolds the table under a bare heading (no upsertPrLogRow-style malformed-table trap)', () => {
    const bare = ARCHIVED_SRC + '\n## Disclosures\n';
    const fixed = ensureDisclosuresSection(bare);
    expect(fixed).toContain('| Ref | Row | Iter | Source | Disposition | Text |');
    expect(() =>
      addDisclosureToSource(fixed, { rowId: '01', iter: 1, source: 'worker', text: 'g' }),
    ).not.toThrow();
  });
});

describe('Disclosures — set-disposition (ADR-0027 vocabulary)', () => {
  function withOpenPair(): string {
    let src = freshSpine();
    src = addDisclosureToSource(src, { rowId: '156', iter: 1, source: 'worker', text: 'gap A' }).source;
    src = addDisclosureToSource(src, { rowId: '157', iter: 1, source: 'reviewer', text: 'gap B' }).source;
    return src;
  }

  it('updates EXACTLY one entry, leaving its siblings byte-identical', () => {
    const before = withOpenPair();
    const after = setDispositionInSource(before, '156.1', 'filed:#158');

    const entries = readDisclosures(after);
    expect(entries.map((d) => [d.ref, d.disposition])).toEqual([
      ['156.1', 'filed:#158'],
      ['157.1', 'open'],
    ]);

    // Only that ONE line differs between the two sources.
    const a = before.split('\n');
    const b = after.split('\n');
    expect(a.length).toBe(b.length);
    const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i !== -1);
    expect(changed).toEqual([entries[0].line]);
  });

  it('accepts the full four-way vocabulary, and only that', () => {
    for (const ok of ['resolved-in-slice', 'scope-extension', 'filed:#158', 'filed:FOR-90', 'dropped:noise']) {
      expect(isSettableDisposition(ok)).toBe(true);
      expect(readDisclosures(setDispositionInSource(withOpenPair(), '156.1', ok))[0].disposition).toBe(ok);
    }
    for (const bad of ['open', 'filed:', 'dropped:', 'dropped: ', 'resolved', 'RESOLVED-IN-SLICE', '']) {
      expect(isSettableDisposition(bad)).toBe(false);
    }
  });

  it('refuses an unknown disposition loud, writing NOTHING', () => {
    const before = withOpenPair();
    expect(() => setDispositionInSource(before, '156.1', 'sorted-it-out')).toThrow(/invalid disposition/);
    // `open` is the capture default, not a decision — it is refused too.
    expect(() => setDispositionInSource(before, '156.1', 'open')).toThrow(/invalid disposition/);
  });

  it('refuses an unknown disclosure-ref loud, naming the refs it does know', () => {
    expect(() => setDispositionInSource(withOpenPair(), '156.9', 'scope-extension')).toThrow(
      /no disclosure with ref "156\.9"; known refs: 156\.1, 157\.1/,
    );
  });
});

describe('Disclosures — the fail-closed open-disclosure check (ADR-0027)', () => {
  it('a corrupt section throws rather than reading as "0 open" (the gate cannot be silently bypassed)', () => {
    const src = addDisclosureToSource(freshSpine(), {
      rowId: '156',
      iter: 1,
      source: 'worker',
      text: 'gap',
    }).source;
    // A hand-mangled data row (one cell short).
    const mangled = src.replace('| 156.1 | 156 | 1 | worker | open | gap |', '| 156.1 | 156 | worker | open | gap |');
    expect(() => readDisclosures(mangled)).toThrow(/malformed disclosure row/);
    // …and a mangled HEADER too.
    const badHeader = src.replace('| Ref | Row | Iter | Source | Disposition | Text |', '| Ref | Row |');
    expect(() => readDisclosures(badHeader)).toThrow(/malformed "## Disclosures" header/);
  });
});

describe('SpineStore — the disclosure verbs on the store surface', () => {
  it('add → open → disposition → clear, all through the store', () => {
    const s = spineStoreFromSource(freshSpine());
    expect(s.openDisclosures()).toEqual([]);

    const d = s.addDisclosure({ rowId: '156', iter: 1, source: 'worker', text: 'wiring lies outside the globs' });
    expect(d.ref).toBe('156.1');
    expect(s.openDisclosures()).toHaveLength(1);
    expect(s.disclosures()).toHaveLength(1);

    s.setDisposition('156.1', 'scope-extension');
    expect(s.openDisclosures()).toEqual([]);
    expect(s.disclosures()[0].disposition).toBe('scope-extension');

    // The mutation went through the same byte-preserving seam as every other op.
    expect(s.source()).toContain('| 156.1 | 156 | 1 | worker | scope-extension | wiring lies outside the globs |');
    expect(s.rowState('156')).toBe('planned');
  });

  it('the section coexists with every OTHER spine mutator — including replaceClosedByBlock, whose body now ends at this heading', () => {
    const s = spineStoreFromSource(freshSpine());
    s.addDisclosure({ rowId: '156', iter: 1, source: 'worker', text: 'gap A' });
    s.setDisposition('156.1', 'resolved-in-slice');

    // `wave-close` writes the Closed-by block LAST, when the section is already
    // there. `## Closed-by`'s body span now terminates at `## Disclosures`
    // instead of EOF — the splice must not swallow or displace the section.
    s.replaceClosedByBlock('Closed by PR #158 (merged 2026-07-28).');
    s.setRowState('156', 'pr-created');
    s.setRowPrCell('156', '#158');
    s.upsertDispatchLogEntry('156', 'wave/156-spine-disclosures');
    s.setFrontmatterStatus('closed');

    expect(s.source()).toContain('Closed by PR #158 (merged 2026-07-28).');
    expect(s.disclosures()).toHaveLength(1);
    expect(s.disclosures()[0].disposition).toBe('resolved-in-slice');
    expect(s.openDisclosures()).toEqual([]);
    expect(s.rowState('156')).toBe('pr-created');
    expect(s.branchesByIssueId()['156']).toBe('wave/156-spine-disclosures');
    expect(s.spine().frontmatter.status).toBe('closed');
    // …and the section is still exactly where the parser expects it.
    expect(readDisclosures(s.source())).toEqual(s.disclosures());
  });

  it('ensureDisclosuresSection through the store grows the section on an archived spine', () => {
    const s = spineStoreFromSource(ARCHIVED_SRC);
    expect(s.source()).not.toContain('## Disclosures');
    s.ensureDisclosuresSection();
    expect(s.source()).toContain('## Disclosures');
    expect(s.disclosures()).toEqual([]);
    // Re-parse survived: the wave-md-rw view is intact.
    expect(s.branchesByIssueId()['01']).toBe('wave-orch/01-thing');
  });
});
