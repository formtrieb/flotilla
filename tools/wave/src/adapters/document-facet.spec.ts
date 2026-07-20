/**
 * document-facet.spec.ts — ADR-0011 cross-store contract net.
 *
 * Proves, on BOTH shipped stores, that:
 *   1. a slice's `parent` backlink round-trips through create() → read();
 *   2. a PRD published via the Document facet round-trips (title + body);
 *   3. a published PRD is NOT a wave candidate (absent from listOpen);
 *   4. listDocuments() finds it.
 *
 * The same assertions over both adapters are the guarantee that "a PRD is a
 * tracker document, not a wave issue" holds across the tracker-agnostic seam.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore } from './markdown-fs-store';
import { GitHubIssuesStore } from './github/github-issues-store';
import { InMemoryGitHubApi } from './github/github-api-fake';
import { LinearIssuesStore } from './linear/linear-issues-store';
import { InMemoryLinearApi } from './linear/linear-api-fake';
import type { CreateInput, IssueStore, PublishDocumentInput } from './issue-store';

const SLUG = 'doc-facet';
const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
});

function baseInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    title: 'A slice',
    filingHint: 'a-slice',
    risk: 'mechanical',
    worker: 'background',
    files: ['src/x.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'does the thing', checked: false }],
    ...overrides,
  };
}

const samplePrd: PublishDocumentInput = {
  title: 'PRD: Frobnicator',
  filingHint: 'prd-frobnicator',
  bodySections: [
    { heading: 'Problem Statement', markdown: 'Users cannot frobnicate.' },
    { heading: 'User Stories', markdown: '1. As a user, I want to frobnicate.' },
  ],
};

const stores: { name: string; make: () => Promise<IssueStore> }[] = [
  {
    name: 'MarkdownFsStore',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'docfacet-'));
      tmpRoots.push(root);
      return new MarkdownFsStore({ repoRoot: root, slug: SLUG });
    },
  },
  {
    name: 'GitHubIssuesStore',
    make: async () => new GitHubIssuesStore({ api: new InMemoryGitHubApi() }),
  },
  {
    name: 'LinearIssuesStore',
    make: async () => new LinearIssuesStore({ api: new InMemoryLinearApi() }),
  },
];

for (const { name, make } of stores) {
  describe(`${name} — parent backlink (ADR-0011/0013)`, () => {
    it('round-trips a parent backlink (the PRD id string) through create() → read()', async () => {
      const store = await make();
      // parent is the PRD's OWN opaque id (ADR-0013) — never an IssueRef. Using a
      // real published PRD id proves the round-trip on each store's native id shape
      // (markdown `<slug>#prd`, github bare number) without the suite knowing it.
      const prdId = await store.publishDocument(samplePrd);
      const id = await store.create(baseInput({ parent: prdId }));
      const view = await store.read(id);
      expect(view.parent).toBe(prdId);
    });

    it('an issue with no parent reads back parent: undefined', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      const view = await store.read(id);
      expect(view.parent).toBeUndefined();
    });
  });

  describe(`${name} — Document facet (ADR-0011)`, () => {
    it('publishDocument → readDocument round-trips title + body', async () => {
      const store = await make();
      const id = await store.publishDocument(samplePrd);
      const doc = await store.readDocument(id);
      expect(doc.id).toBe(id);
      expect(doc.title).toBe('PRD: Frobnicator');
      expect(doc.body).toContain('## Problem Statement');
      expect(doc.body).toContain('Users cannot frobnicate.');
      expect(doc.body).toContain('## User Stories');
    });

    it('a PRD body carries NO wave Header-Block / eligibility marker', async () => {
      const store = await make();
      const id = await store.publishDocument(samplePrd);
      const doc = await store.readDocument(id);
      expect(doc.body).not.toContain('**Risk:**');
      expect(doc.body).not.toContain('## Files');
      expect(doc.body).not.toContain('ready-for-agent');
    });

    it('a published PRD is NOT a wave candidate (absent from listOpen)', async () => {
      const store = await make();
      const sliceId = await store.create(baseInput());
      const prdId = await store.publishDocument(samplePrd);
      const openIds = (await store.listOpen('wave-ready')).map((v) => v.id);
      expect(openIds).toContain(sliceId);
      expect(openIds).not.toContain(prdId);
    });

    it('listDocuments() finds the published PRD', async () => {
      const store = await make();
      const id = await store.publishDocument(samplePrd);
      const docs = await store.listDocuments();
      expect(docs.map((d) => d.id)).toContain(id);
      expect(docs.find((d) => d.id === id)?.title).toBe('PRD: Frobnicator');
    });

    it('readDocument throws on an unknown id', async () => {
      const store = await make();
      await expect(store.readDocument('999')).rejects.toThrow();
    });
  });
}
