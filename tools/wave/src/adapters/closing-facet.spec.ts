/**
 * closing-facet.spec.ts — the closedBy probe (the deferred GraphQL closedBy).
 *
 * readClosing answers "is this issue still open, closed by a MERGED PR, or
 * closed UNMERGED?" — feeding the resume done-reconcile (a merged PR's Closes #N
 * is the real done signal, ADR-0005) and, downstream, classifyClosedBy. The SAME
 * three-state assertions over BOTH shipped stores prove it is tracker-agnostic.
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
import type { CreateInput, IssueStore } from './issue-store';

const SLUG = 'closing-facet';
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

const PR = 'https://github.com/o/r/pull/7';

// Each store knows how to drive an issue into a MERGED-PR close vs an
// UNMERGED close, the one place the targets genuinely diverge (mirrors the
// simulateNativeClose conformance-hook pattern).
const stores: {
  name: string;
  make: () => Promise<IssueStore>;
  // drive id into closed-by-merged-PR (the wave happy path).
  closeMerged: (store: IssueStore, id: string) => Promise<void>;
  // drive id into closed-without-merge (ADR-0005 open concern).
  closeUnmerged: (store: IssueStore, id: string) => Promise<void>;
}[] = [
  {
    name: 'MarkdownFsStore',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'closing-'));
      tmpRoots.push(root);
      return new MarkdownFsStore({ repoRoot: root, slug: SLUG });
    },
    // markdown close() records Closed-by:<prUrl> + moves to done/ → merged.
    closeMerged: async (store, id) => store.close(id, PR, []),
    // closeUnplanned natively closes WITHOUT a Closed-by PR ref → unmerged.
    closeUnmerged: async (store, id) => store.closeUnplanned(id, 'abandoned'),
  },
  {
    name: 'GitHubIssuesStore',
    make: async () => new GitHubIssuesStore({ api: new InMemoryGitHubApi() }),
    closeMerged: async (store, id) => {
      const api = (store as GitHubIssuesStore).api as InMemoryGitHubApi;
      await api.setClosingPr(Number(id), { merged: true, url: PR });
      await api.nativeClose(Number(id), 'completed');
    },
    closeUnmerged: async (store, id) => {
      const api = (store as GitHubIssuesStore).api as InMemoryGitHubApi;
      await api.setClosingPr(Number(id), { merged: false, url: PR });
      await api.nativeClose(Number(id), 'not_planned');
    },
  },
  {
    name: 'LinearIssuesStore',
    make: async () => new LinearIssuesStore({ api: new InMemoryLinearApi() }),
    // simulateMergedPrClose moves the state to a `completed`-type column AND
    // records a merged PR attachment (what Linear's GitHub integration does).
    closeMerged: async (store, id) => {
      const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
      api.simulateMergedPrClose(id, PR);
    },
    // simulateUnmergedClose moves the state to `completed` with NO attachment.
    closeUnmerged: async (store, id) => {
      const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
      api.simulateUnmergedClose(id);
    },
  },
];

for (const { name, make, closeMerged, closeUnmerged } of stores) {
  describe(`${name} — closing probe readClosing (ADR-0005)`, () => {
    it('an open issue reads { state: "open" }', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      expect((await store.readClosing(id)).state).toBe('open');
    });

    it('an issue closed by a merged PR reads { state: "merged", prUrl }', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await closeMerged(store, id);
      const closing = await store.readClosing(id);
      expect(closing.state).toBe('merged');
      expect(closing.prUrl).toBe(PR);
    });

    it('an issue closed WITHOUT a merge reads { state: "closed-unmerged" }', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await closeUnmerged(store, id);
      expect((await store.readClosing(id)).state).toBe('closed-unmerged');
    });

    it('readClosing throws on an unknown id', async () => {
      const store = await make();
      await expect(store.readClosing('definitely#99')).rejects.toThrow();
    });
  });
}
