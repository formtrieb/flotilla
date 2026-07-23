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

describe('InMemoryGitHubApi effective-rules read (2026-07-23 gate-arm gap)', () => {
  it('getRulesetRequiredChecks defaults to readable:false (no effective-rules answer configured)', async () => {
    expect(await new InMemoryGitHubApi().getRulesetRequiredChecks()).toMatchObject({ readable: false, contexts: [] });
  });

  it('setRulesetRequiredChecks drives the ruleset-carrying-repo path — held independently of setRequiredChecks', async () => {
    const api = new InMemoryGitHubApi();
    api.setRulesetRequiredChecks({
      readable: true,
      contexts: ['Engine Tests (vitest)', 'Engine Typecheck (tsc)'],
      detail: 'ruleset carries two checks',
    });
    expect(await api.getRulesetRequiredChecks()).toMatchObject({
      readable: true,
      contexts: ['Engine Tests (vitest)', 'Engine Typecheck (tsc)'],
    });
    // The two required-checks affordances are independent (the fake mirrors the
    // seam; the real ruleset-vs-legacy MERGE lives in RealGitHubApi, tested there).
    api.setRequiredChecks({ state: 'absent', contexts: [], detail: 'legacy none' });
    expect(await api.getRequiredChecks()).toMatchObject({ state: 'absent' });
    expect(await api.getRulesetRequiredChecks()).toMatchObject({ readable: true, contexts: ['Engine Tests (vitest)', 'Engine Typecheck (tsc)'] });
  });
});

describe('InMemoryGitHubApi deleteBranch (consumer KW-F6)', () => {
  it('records the deleted branch', async () => {
    const api = new InMemoryGitHubApi();
    await api.deleteBranch('wave/FOR-66-x');
    expect(api.deletedRemoteBranches).toEqual(['wave/FOR-66-x']);
  });

  it('setDeleteBranchError makes deleteBranch throw — the host-refusal degrade path', async () => {
    const api = new InMemoryGitHubApi();
    api.setDeleteBranchError('Reference does not exist');
    await expect(api.deleteBranch('wave/x')).rejects.toThrow(/Reference does not exist/);
    // A failed delete records nothing.
    expect(api.deletedRemoteBranches).toEqual([]);
    // Clearing the error restores normal recording.
    api.setDeleteBranchError(null);
    await api.deleteBranch('wave/x');
    expect(api.deletedRemoteBranches).toEqual(['wave/x']);
  });
});
