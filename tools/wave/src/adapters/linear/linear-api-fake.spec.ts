import { describe, it, expect } from 'vitest';
import { InMemoryLinearApi } from './linear-api-fake';

describe('InMemoryLinearApi native blocked-by write half (ADR-0020)', () => {
  async function twoIssues(): Promise<{ api: InMemoryLinearApi; blocked: string; blocker: string }> {
    const api = new InMemoryLinearApi();
    const blocker = (await api.createIssue({ title: 'blocker', description: '', labels: [] })).identifier;
    const blocked = (await api.createIssue({ title: 'blocked', description: '', labels: [] })).identifier;
    return { api, blocked, blocker };
  }

  it('addBlockedBy records a native relation readable via getBlockedBy', async () => {
    const { api, blocked, blocker } = await twoIssues();
    await api.addBlockedBy(blocked, blocker);
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
    // additive, directional: the blocker itself has no blockers recorded.
    expect(await api.getBlockedBy(blocker)).toEqual([]);
  });

  it('addBlockedBy throws on an unknown blocked OR blocker identifier (models resolveIssue)', async () => {
    const { api, blocked, blocker } = await twoIssues();
    await expect(api.addBlockedBy(blocked, 'EX-999')).rejects.toThrow(/EX-999/);
    await expect(api.addBlockedBy('EX-999', blocker)).rejects.toThrow(/EX-999/);
  });

  it('failRelationWrites forces addBlockedBy to reject (models a rejected issueRelationCreate) and is clearable', async () => {
    const { api, blocked, blocker } = await twoIssues();
    api.failRelationWrites(new Error('relation write boom'));
    await expect(api.addBlockedBy(blocked, blocker)).rejects.toThrow(/boom/);
    expect(await api.getBlockedBy(blocked)).toEqual([]); // nothing landed
    api.failRelationWrites(null);
    await expect(api.addBlockedBy(blocked, blocker)).resolves.toBeUndefined();
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
  });
});

// ── Document facet: the fake models a Document's TEAM attachment (ADR-0017
// amendment), so both directions of the scoped listing are ASSERTED here, not
// narrated: an unbound api is team-scoped, a project-bound one is unchanged.
describe('InMemoryLinearApi Document facet — team attachment (ADR-0017 amendment)', () => {
  describe('without a bound project (the team-pool consumer shape)', () => {
    it("createDocument mints a document the api's own team listing returns", async () => {
      const api = new InMemoryLinearApi('EX');
      const { id } = await api.createDocument({ title: 'PRD: thing', content: '# body\n' });
      expect(await api.listDocuments()).toEqual([{ id, title: 'PRD: thing', content: '# body\n' }]);
    });

    it("listDocuments returns ONLY the configured team's documents", async () => {
      const api = new InMemoryLinearApi('EX');
      const mine = (await api.createDocument({ title: 'mine', content: 'a' })).id;
      const sameTeam = api.seedDocument({ title: 'a teammate wrote this', content: 'b', team: 'EX' });
      api.seedDocument({ title: 'another team entirely', content: 'c', team: 'OTHER' });
      api.seedDocument({ title: "some project's doc", content: 'd', project: 'Unrelated Project' });

      const listed = (await api.listDocuments()).map((d) => d.id);
      expect(listed).toEqual([mine, sameTeam]); // and NOT the foreign team's / the project's
    });

    it('getDocument resolves an out-of-scope id — the listing is scoped, the fetch is not', async () => {
      const api = new InMemoryLinearApi('EX');
      const foreign = api.seedDocument({ title: 'another team entirely', content: 'c', team: 'OTHER' });
      expect(await api.listDocuments()).toEqual([]);
      await expect(api.getDocument(foreign)).resolves.toEqual({ id: foreign, title: 'another team entirely', content: 'c' });
    });
  });

  describe('with a bound project (unchanged)', () => {
    it('createDocument attaches to the PROJECT, and the project listing returns it', async () => {
      const api = new InMemoryLinearApi('EX', 'Example Project');
      const { id } = await api.createDocument({ title: 'PRD: thing', content: '# body\n' });
      expect(await api.listDocuments()).toEqual([{ id, title: 'PRD: thing', content: '# body\n' }]);
    });

    it("listDocuments stays project-scoped — a team-attached document of the SAME team is not drawn in", async () => {
      const api = new InMemoryLinearApi('EX', 'Example Project');
      const mine = (await api.createDocument({ title: 'mine', content: 'a' })).id;
      api.seedDocument({ title: 'team-attached, same team', content: 'b', team: 'EX' });
      api.seedDocument({ title: 'another project', content: 'c', project: 'Other Project' });

      expect((await api.listDocuments()).map((d) => d.id)).toEqual([mine]);
    });

    it('a project-bound api and an unbound one over the same team see different scopes', async () => {
      const bound = new InMemoryLinearApi('EX', 'Example Project');
      const unbound = new InMemoryLinearApi('EX');
      await bound.createDocument({ title: 'project doc', content: 'a' });
      await unbound.createDocument({ title: 'team doc', content: 'b' });
      // separate instances hold separate substrates — each sees exactly its own.
      expect((await bound.listDocuments()).map((d) => d.title)).toEqual(['project doc']);
      expect((await unbound.listDocuments()).map((d) => d.title)).toEqual(['team doc']);
    });
  });
});

// ── attachment upsert (issue #511, mechanics proven consumer-side) ─────────
describe('InMemoryLinearApi attachment upsert (issue #511)', () => {
  it('upsertAttachment records a card readable via listUpsertedAttachments', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(api.listUpsertedAttachments(id)).toEqual([
      { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' },
    ]);
  });

  it('a second upsertAttachment call with the SAME url updates the card in place — no duplicate (models Linear\'s own upsert-by-url)', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'open' });
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(api.listUpsertedAttachments(id)).toEqual([
      { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' },
    ]);
  });

  it('upsertAttachment throws on an unknown identifier (models resolveIssue)', async () => {
    const api = new InMemoryLinearApi();
    await expect(
      api.upsertAttachment('EX-999', { url: 'https://x/pr/1', title: 't', subtitle: 's' }),
    ).rejects.toThrow(/EX-999/);
  });

  it('is a substrate SEPARATE from getPrAttachments — an upserted card never appears there', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(await api.getPrAttachments(id)).toEqual([]);
  });
});

describe('InMemoryLinearApi store-preflight substrate (FOR-12)', () => {
  it('hasGitHubIntegration defaults to true and is togglable', async () => {
    const api = new InMemoryLinearApi();
    expect(await api.hasGitHubIntegration()).toBe(true);
    api.setGitHubIntegration(false);
    expect(await api.hasGitHubIntegration()).toBe(false);
    api.setGitHubIntegration(true);
    expect(await api.hasGitHubIntegration()).toBe(true);
  });

  it('listStates exposes the default catalog (including the standard claim ladder)', async () => {
    const names = (await new InMemoryLinearApi().listStates()).map((s) => s.name);
    // The claim-ledger states + unclaim/unplanned targets must all be present.
    expect(names).toEqual(expect.arrayContaining(['Todo', 'In Progress', 'In Review', 'Backlog', 'Canceled']));
  });

  it('listStates reflects a replaced catalog (the fresh-workspace fixture)', async () => {
    const api = new InMemoryLinearApi();
    api.setStateCatalog([
      { name: 'Backlog', type: 'backlog' },
      { name: 'Todo', type: 'unstarted' },
      { name: 'In Progress', type: 'started' },
      { name: 'Done', type: 'completed' },
      { name: 'Canceled', type: 'canceled' },
    ]);
    const names = (await api.listStates()).map((s) => s.name);
    expect(names).not.toContain('In Review'); // the fresh workspace lacks it
    expect(names).toContain('In Progress');
  });
});
