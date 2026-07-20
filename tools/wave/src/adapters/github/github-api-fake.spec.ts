import { describe, it, expect } from 'vitest';
import { InMemoryGitHubApi } from './github-api-fake';

describe('InMemoryGitHubApi comments (ADR-0015)', () => {
  it('addComment appends; getComments returns them oldest-first', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createIssue({ title: 't', body: 'b', labels: [] });
    await api.addComment(number, 'first');
    await api.addComment(number, 'second');
    const comments = await api.getComments(number);
    expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('getComments on an issue with none returns []', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createIssue({ title: 't', body: 'b', labels: [] });
    expect(await api.getComments(number)).toEqual([]);
  });

  it('addComment throws on an unknown issue', async () => {
    const api = new InMemoryGitHubApi();
    await expect(api.addComment(999, 'x')).rejects.toThrow();
  });
});

describe('InMemoryGitHubApi PR-merge preflight (FOR-12)', () => {
  it('canMergePullRequests defaults to true', async () => {
    expect(await new InMemoryGitHubApi().canMergePullRequests()).toBe(true);
  });

  it('setCanMergePullRequests(false) drives the read-only-token case', async () => {
    const api = new InMemoryGitHubApi();
    api.setCanMergePullRequests(false);
    expect(await api.canMergePullRequests()).toBe(false);
    api.setCanMergePullRequests(true);
    expect(await api.canMergePullRequests()).toBe(true);
  });
});
