/**
 * amend-facet.spec.ts — the storage-AWARE sharpest test for the Amend facet
 * (ADR-0025 / FOR-33), the half the tracker-agnostic conformance suite cannot
 * express.
 *
 * The conformance suite (issue-store-conformance.ts) proves `amend` behaves
 * IDENTICALLY on all three adapters through `IssueView` + `readTriage`. It
 * deliberately cannot inspect storage, so it cannot construct the issue's
 * sharpest case: a hand-edited MarkdownFs file carrying UNMODELED header fields
 * (`**Created:**`, `**Type:**` — parsed by nobody, round-tripped by the surgical
 * writer) plus a Files ANNOTATION (`- path ← note`, which the header-parser
 * strips on read but the file retains). This spec reaches into the raw file to
 * prove an amend of a title + a prose section leaves ALL of that intact, the
 * wave Header-Block still parses, and the replaced section leaves no shadow
 * duplicate — the exact surgical-write guarantee W4-F5's raw-GraphQL bypass
 * lacked.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarkdownFsStore } from './markdown-fs-store';
import type { CreateInput } from './issue-store';

const SLUG = '2026-07-19-amend';

function tmpStore(): { store: MarkdownFsStore; repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'amend-'));
  mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
  return { store: new MarkdownFsStore({ repoRoot, slug: SLUG }), repoRoot };
}

function issueFilePath(repoRoot: string): string {
  const dir = join(repoRoot, '.scratch', SLUG, 'issues');
  const file = readdirSync(dir).find((n) => /^\d+-.*\.md$/.test(n));
  if (!file) throw new Error('no issue file written');
  return join(dir, file);
}

function baseInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    title: 'Original title',
    filingHint: 'original-slug',
    risk: 'mechanical',
    worker: 'background',
    files: ['src/entry.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'the acceptance criterion', checked: false }],
    bodySections: [{ heading: 'What to build', markdown: 'the ORIGINAL brief' }],
    ...overrides,
  };
}

/** Count `## <heading>` heading LINES in a raw file — 1 means no shadow duplicate. */
function countHeading(source: string, heading: string): number {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  return source.split('\n').filter((l) => re.test(l)).length;
}

describe('Amend facet — MarkdownFs surgical round-trip (the sharpest test, ADR-0025)', () => {
  it('amend(title + section) preserves unmodeled header fields AND Files annotations, Header-Block still parses, no shadow duplicate', async () => {
    const { store, repoRoot } = tmpStore();
    const id = await store.create(baseInput());
    const path = issueFilePath(repoRoot);

    // Hand-edit the file the way a human / an earlier decorate would: add two
    // UNMODELED header fields the parser never models, and annotate the Files
    // entry (` ← note`, stripped on read but retained in the file). This is the
    // content the surgical writer must not drop.
    const original = readFileSync(path, 'utf-8');
    const edited = original
      .replace('**Risk:** mechanical', '**Created:** 2026-01-15\n**Type:** chore\n**Risk:** mechanical')
      .replace('- src/entry.ts', '- src/entry.ts ← the entry point (do not touch)');
    writeFileSync(path, edited, 'utf-8');

    // The amend under test: rename + replace the What-to-build section.
    await store.amend(id, {
      title: 'Renamed title',
      sections: [{ heading: 'What to build', markdown: 'the AMENDED brief' }],
    });

    const after = readFileSync(path, 'utf-8');

    // 1. unmodeled header fields survive verbatim.
    expect(after).toContain('**Created:** 2026-01-15');
    expect(after).toContain('**Type:** chore');
    // 2. the Files annotation survives (the parser strips it; the file keeps it).
    expect(after).toContain('- src/entry.ts ← the entry point (do not touch)');
    // 3. the section was REPLACED, not shadowed — exactly one heading, new body.
    expect(countHeading(after, 'What to build')).toBe(1);
    expect(after).toContain('the AMENDED brief');
    expect(after).not.toContain('the ORIGINAL brief');
    // 4. the title part of the `# NN — Title` H1 swapped; the `NN — ` prefix stays.
    expect(after).toMatch(/^#\s+\d+\s+—\s+Renamed title$/m);

    // 5. the wave Header-Block STILL parses — read() succeeds and the modeled
    //    fields (Files with the annotation stripped, Risk/Worker, AC) are intact.
    const view = await store.read(id);
    expect(view.risk).toBe('mechanical');
    expect(view.worker).toBe('background');
    expect(view.files).toEqual(['src/entry.ts']); // annotation stripped on read
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['the acceptance criterion']);
    // 6. the new title round-trips through the Triage facet.
    expect((await store.readTriage(id)).title).toBe('Renamed title');
  });

  it('the FILENAME is never renamed by an amend (the slug is cosmetic, ADR-0001)', async () => {
    const { store, repoRoot } = tmpStore();
    const id = await store.create(baseInput({ filingHint: 'original-slug' }));
    const before = issueFilePath(repoRoot);

    await store.amend(id, { title: 'A completely different title' });

    const after = issueFilePath(repoRoot);
    expect(after).toBe(before); // same file — the slug in the path is unchanged
    expect(before).toContain('original-slug');
    // and the id the caller holds still resolves.
    expect((await store.read(id)).id).toBe(id);
  });

  it('a reserved-heading section throws BEFORE the title is written (no partial application)', async () => {
    const { store, repoRoot } = tmpStore();
    const id = await store.create(baseInput({ title: 'Untouched title' }));
    const path = issueFilePath(repoRoot);
    const before = readFileSync(path, 'utf-8');

    await expect(
      store.amend(id, {
        title: 'Should NOT be written',
        sections: [{ heading: 'Acceptance criteria', markdown: 'clobber attempt' }],
      }),
    ).rejects.toThrow(/annotate/i);

    // the whole file is byte-for-byte unchanged — the reserved throw fired
    // before the single write, so nothing (not even the title) landed.
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect((await store.readTriage(id)).title).toBe('Untouched title');
  });
});
