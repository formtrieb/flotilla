/**
 * closing-facet.spec.ts — the closedBy probe (the deferred GraphQL closedBy).
 *
 * readClosing answers "is this issue still open, closed by a MERGED PR, closed
 * with a FOUND-but-unmerged PR (a proven rejection), or closed with NO PR
 * evidence at all?" — feeding the close/resume done-reconcile (a merged PR's
 * Closes #N is the real done signal, ADR-0005) and, downstream, classifyClosedBy.
 * The storage-aware per-store drivers here complement the tracker-agnostic
 * readClosing cases in the shared conformance suite (issue-store-conformance.ts).
 *
 * The four ClosingState outcomes are EVIDENCE claims, not verdicts (W2-F1c): the
 * `closed-unmerged` (a rejection was PROVEN) vs `closed-unknown` (no evidence
 * found) split legitimately DIVERGES per store — a store that can record a
 * rejected PR (GitHub, Linear) reports `closed-unmerged`; one that structurally
 * cannot (MarkdownFs) reports `closed-unknown`, never a rejection it cannot prove.
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

// Each store knows how to drive an issue into each closing scenario, the one
// place the targets genuinely diverge (mirrors the simulateNativeClose
// conformance-hook pattern).
const stores: {
  name: string;
  make: () => Promise<IssueStore>;
  // drive id into closed-by-merged-PR (the wave happy path).
  closeMerged: (store: IssueStore, id: string) => Promise<void>;
  // drive id into closed with a FOUND-but-unmerged PR (a proven rejection where
  // the store can record one).
  closeUnmerged: (store: IssueStore, id: string) => Promise<void>;
  // the honest readClosing state THIS store reports for that scenario: a store
  // that can record a rejected PR → closed-unmerged; one that structurally
  // cannot (MarkdownFs) → closed-unknown, never a rejection it cannot prove.
  unmergedExpected: 'closed-unmerged' | 'closed-unknown';
  // drive id into closed with NO PR evidence at all (every store → closed-unknown).
  closeNoEvidence: (store: IssueStore, id: string) => Promise<void>;
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
    // closeUnplanned natively closes WITHOUT a Closed-by PR ref. MarkdownFs has no
    // way to record a REJECTED PR — only "merged" (the ref) or "no ref" — so it
    // reads closed-unknown, never claiming a rejection it cannot prove (W2-F1c).
    closeUnmerged: async (store, id) => store.closeUnplanned(id, 'abandoned'),
    unmergedExpected: 'closed-unknown',
    closeNoEvidence: async (store, id) => store.closeUnplanned(id, 'no evidence'),
  },
  {
    name: 'GitHubIssuesStore',
    make: async () => new GitHubIssuesStore({ api: new InMemoryGitHubApi() }),
    closeMerged: async (store, id) => {
      const api = (store as GitHubIssuesStore).api as InMemoryGitHubApi;
      await api.setClosingPr(Number(id), { merged: true, url: PR });
      await api.nativeClose(Number(id), 'completed');
    },
    // a FOUND closing PR that did not merge → a proven rejection (closed-unmerged).
    closeUnmerged: async (store, id) => {
      const api = (store as GitHubIssuesStore).api as InMemoryGitHubApi;
      await api.setClosingPr(Number(id), { merged: false, url: PR });
      await api.nativeClose(Number(id), 'not_planned');
    },
    unmergedExpected: 'closed-unmerged',
    // closed WITHOUT ever recording a closing PR → no evidence → closed-unknown.
    closeNoEvidence: async (store, id) => {
      const api = (store as GitHubIssuesStore).api as InMemoryGitHubApi;
      await api.nativeClose(Number(id), 'completed');
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
    // simulateUnmergedClose moves the state to `completed` and leaves a non-merged
    // PR attachment behind — Linear CAN prove the rejection → closed-unmerged.
    closeUnmerged: async (store, id) => {
      const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
      api.simulateUnmergedClose(id);
    },
    unmergedExpected: 'closed-unmerged',
    // a completed state with NO attachment → no PR evidence → closed-unknown.
    closeNoEvidence: async (store, id) => {
      const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
      api.simulateCloseWithoutPrEvidence(id);
    },
  },
];

for (const {
  name,
  make,
  closeMerged,
  closeUnmerged,
  unmergedExpected,
  closeNoEvidence,
} of stores) {
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

    it('an issue closed with a FOUND-but-unmerged PR reads the store\'s honest evidence state', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await closeUnmerged(store, id);
      // GitHub/Linear PROVE the rejection → closed-unmerged; MarkdownFs cannot
      // record a rejected PR and so must NOT claim one → closed-unknown (W2-F1c).
      expect((await store.readClosing(id)).state).toBe(unmergedExpected);
    });

    it('an issue closed with NO PR evidence reads { state: "closed-unknown" } — never a rejection it cannot prove', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await closeNoEvidence(store, id);
      expect((await store.readClosing(id)).state).toBe('closed-unknown');
    });

    it('readClosing throws on an unknown id', async () => {
      const store = await make();
      await expect(store.readClosing('definitely#99')).rejects.toThrow();
    });
  });
}
