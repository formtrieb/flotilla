/**
 * needs-attention-facet.spec.ts — ADR-0006 cross-store contract net.
 *
 * The orthogonal needs-attention flag (NOT a claim rung): set/cleared via
 * flag()/clearFlag(), surfaced as IssueView.status === 'needs-attention' with
 * precedence over the wave/* claim rungs. The SAME assertions over BOTH shipped
 * stores are the guarantee the flag is tracker-agnostic.
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
import type { CreateInput, IssueStore, NeedsAttentionPayload } from './issue-store';

const SLUG = 'na-facet';
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

const PAYLOAD: NeedsAttentionPayload = {
  kind: 'recoverable-stop',
  question: 'The migration needs a manual DB backfill before I continue — proceed?',
  options: ['backfill done, continue', 'abandon this slice'],
};

const stores: { name: string; make: () => Promise<IssueStore> }[] = [
  {
    name: 'MarkdownFsStore',
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), 'nafacet-'));
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
  describe(`${name} — needs-attention facet (ADR-0006)`, () => {
    it('flag() makes read().status === "needs-attention"', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await store.flag(id, PAYLOAD);
      expect((await store.read(id)).status).toBe('needs-attention');
    });

    it('needs-attention takes precedence over a wave/<rung> claim', async () => {
      // the flag is ORTHOGONAL to the rung — set both, the flag wins in read().
      const store = await make();
      const id = await store.create(baseInput());
      await store.transition(id, 'in-flight');
      await store.flag(id, PAYLOAD);
      expect((await store.read(id)).status).toBe('needs-attention');
    });

    it('clearFlag() restores the underlying coarse state (the rung re-surfaces)', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await store.transition(id, 'in-flight');
      await store.flag(id, PAYLOAD);
      await store.clearFlag(id);
      expect((await store.read(id)).status).toBe('in-flight');
    });

    it('clearFlag() on an unflagged issue is a no-op', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await store.clearFlag(id); // never flagged
      expect((await store.read(id)).status).toBe('available');
    });

    it('flag() is idempotent — re-flagging keeps status needs-attention', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await store.flag(id, PAYLOAD);
      await store.flag(id, { ...PAYLOAD, kind: 'terminal-failure' });
      expect((await store.read(id)).status).toBe('needs-attention');
    });

    it('flag() throws on an unknown id', async () => {
      const store = await make();
      await expect(store.flag('definitely#99', PAYLOAD)).rejects.toThrow();
    });

    it('a flagged issue is excluded from listOpen (it is not available)', async () => {
      const store = await make();
      const id = await store.create(baseInput());
      await store.flag(id, PAYLOAD);
      expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(id);
    });
  });
}
