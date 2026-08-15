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

describe('InMemoryGitHubApi issue dependencies (ADR-0020 read-union + write-mirror)', () => {
  it('getBlockedBy defaults to [] and throws on an unknown issue', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createIssue({ title: 't', body: 'b', labels: [] });
    expect(await api.getBlockedBy(number)).toEqual([]);
    await expect(api.getBlockedBy(999)).rejects.toThrow(/not found/);
  });

  it('addBlockedBy records the dependency and is ADDITIVE (a repeat double-represents, as a live duplicate would)', async () => {
    const api = new InMemoryGitHubApi();
    const { number: blocked } = await api.createIssue({ title: 'blocked', body: '', labels: [] });
    const { number: blocker } = await api.createIssue({ title: 'blocker', body: '', labels: [] });
    await api.addBlockedBy(blocked, blocker);
    await api.addBlockedBy(blocked, blocker);
    expect(await api.getBlockedBy(blocked)).toEqual([blocker, blocker]);
  });

  it('addBlockedBy throws on EITHER side being unresolvable — modelling the real impl\'s database-id resolution', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createIssue({ title: 't', body: 'b', labels: [] });
    await expect(api.addBlockedBy(number, 999)).rejects.toThrow(/not found/);
    await expect(api.addBlockedBy(999, number)).rejects.toThrow(/not found/);
    expect(await api.getBlockedBy(number)).toEqual([]);
  });

  it('failDependencyWrites makes addBlockedBy reject and records nothing; null clears it', async () => {
    const api = new InMemoryGitHubApi();
    const { number: blocked } = await api.createIssue({ title: 'blocked', body: '', labels: [] });
    const { number: blocker } = await api.createIssue({ title: 'blocker', body: '', labels: [] });
    api.failDependencyWrites(new Error('dependency write refused'));
    await expect(api.addBlockedBy(blocked, blocker)).rejects.toThrow(/refused/);
    expect(await api.getBlockedBy(blocked)).toEqual([]);
    api.failDependencyWrites(null);
    await api.addBlockedBy(blocked, blocker);
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
  });

  it('addNativeDependency drives the read side without going through the production write', async () => {
    const api = new InMemoryGitHubApi();
    const { number: blocked } = await api.createIssue({ title: 'blocked', body: '', labels: [] });
    const { number: blocker } = await api.createIssue({ title: 'blocker', body: '', labels: [] });
    // even with production writes refused, the human/consumer-drawn side lands.
    api.failDependencyWrites(new Error('down'));
    api.addNativeDependency(blocked, blocker);
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
    expect(() => api.addNativeDependency(blocked, 999)).toThrow(/not found/);
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

describe('InMemoryGitHubApi milestones (the Goal container substrate, ADR-0044)', () => {
  it('milestones number in their OWN space, independent of issues', async () => {
    // Real GitHub numbers milestones separately from issues, so milestone #1 and
    // issue #1 coexist and mean different things. A fake sharing one counter
    // would hide an id mix-up in the store — the exact confusion that showed up
    // once already when a conformance case compared a goal id to an issue id.
    const api = new InMemoryGitHubApi();
    const issue = await api.createIssue({ title: 'i', body: '', labels: [] });
    const milestone = await api.createMilestone({ title: 'm', description: '' });
    expect(issue.number).toBe(1);
    expect(milestone.number).toBe(1);
  });

  it('createMilestone → getMilestone round-trips, open by default', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createMilestone({ title: '1.0.0', description: 'the freeze' });
    expect(await api.getMilestone(number)).toEqual({
      number,
      title: '1.0.0',
      description: 'the freeze',
      state: 'open',
    });
  });

  it('getMilestone / listMilestoneIssues / setIssueMilestone throw on an unknown milestone', async () => {
    const api = new InMemoryGitHubApi();
    const issue = await api.createIssue({ title: 'i', body: '', labels: [] });
    await expect(api.getMilestone(99)).rejects.toThrow(/milestone not found/i);
    await expect(api.listMilestoneIssues(99)).rejects.toThrow(/milestone not found/i);
    await expect(api.setIssueMilestone(issue.number, 99)).rejects.toThrow(/milestone not found/i);
  });

  it('setIssueMilestone throws on an unknown issue', async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createMilestone({ title: 'm', description: '' });
    await expect(api.setIssueMilestone(404, number)).rejects.toThrow(/issue not found/i);
  });

  it('membership is a per-ISSUE pointer, so re-assigning is idempotent and re-pointing MOVES', async () => {
    const api = new InMemoryGitHubApi();
    const a = await api.createMilestone({ title: 'a', description: '' });
    const b = await api.createMilestone({ title: 'b', description: '' });
    const issue = await api.createIssue({ title: 'i', body: '', labels: [] });

    await api.setIssueMilestone(issue.number, a.number);
    await api.setIssueMilestone(issue.number, a.number); // idempotent
    expect((await api.listMilestoneIssues(a.number)).map((i) => i.number)).toEqual([issue.number]);

    await api.setIssueMilestone(issue.number, b.number);
    expect(await api.listMilestoneIssues(a.number)).toEqual([]);
    expect((await api.listMilestoneIssues(b.number)).map((i) => i.number)).toEqual([issue.number]);
  });

  it('listMilestoneIssues returns members OPEN AND CLOSED — `done` is a frontier reading', async () => {
    const api = new InMemoryGitHubApi();
    const { number: milestone } = await api.createMilestone({ title: 'm', description: '' });
    const open = await api.createIssue({ title: 'open', body: '', labels: [] });
    const closed = await api.createIssue({ title: 'closed', body: '', labels: [] });
    await api.setIssueMilestone(open.number, milestone);
    await api.setIssueMilestone(closed.number, milestone);
    await api.nativeClose(closed.number);

    const members = await api.listMilestoneIssues(milestone);
    expect(members.map((m) => m.number).sort()).toEqual([open.number, closed.number].sort());
    // …and listOpenIssues still filters, so the two reads are genuinely different.
    expect((await api.listOpenIssues()).map((i) => i.number)).toEqual([open.number]);
  });

  it('listMilestones returns open AND closed milestones (the real endpoint needs state=all)', async () => {
    const api = new InMemoryGitHubApi();
    await api.createMilestone({ title: 'a', description: '' });
    await api.createMilestone({ title: 'b', description: '' });
    expect((await api.listMilestones()).map((m) => m.title).sort()).toEqual(['a', 'b']);
  });

  it('the curation write moves the issue\'s updatedAt — a write is observably a write', async () => {
    const api = new InMemoryGitHubApi();
    const { number: milestone } = await api.createMilestone({ title: 'm', description: '' });
    const issue = await api.createIssue({ title: 'i', body: '', labels: [] });
    const before = (await api.getIssue(issue.number)).updatedAt;
    await api.setIssueMilestone(issue.number, milestone);
    const after = (await api.getIssue(issue.number)).updatedAt;
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(before as string));
  });
});
