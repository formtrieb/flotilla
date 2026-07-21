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
