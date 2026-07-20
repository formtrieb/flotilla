import { describe, it, expect } from 'vitest';
import { InMemoryLinearApi } from './linear-api-fake';

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
