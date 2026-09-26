import { describe, it, expect } from 'vitest';
import { InMemoryGitHubApi } from './github-api-fake';
import { HeadMismatchError, armPullRequest, mergePullRequestNow, type PrLandingStatus } from '../../host-pr';

// ─── ADR-0055: the expected head, against the GitHub fake ────────────────────
//
// What lands is the reviewed commit. Driven through the two landing verbs, so
// each case is what `host-pr arm|merge --expect-head` answers on GitHub: the
// verb's own comparison first, and — for a head that moves after that read —
// the host's pin, which the fake models the way GitHub answers it.
describe('InMemoryGitHubApi — the expected head through the landing verbs (ADR-0055)', () => {
  const REVIEWED = 'a'.repeat(40);
  const MOVED = 'b'.repeat(40);
  const openPr = (mergeability: PrLandingStatus['mergeability'], headSha = REVIEWED): PrLandingStatus => ({
    state: 'open',
    number: 7,
    url: 'https://example.test/pull/7',
    mergeability,
    headSha,
    title: 'T',
  });

  /** A fake whose head moves to MOVED right after the verb's status read — a push inside the window. */
  function racingFake(mergeability: PrLandingStatus['mergeability']): InMemoryGitHubApi {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr(mergeability));
    const read = api.getPrStatus.bind(api);
    api.getPrStatus = async (branch: string) => {
      const seen = await read(branch);
      api.setPrForBranch(branch, { ...seen, headSha: MOVED });
      return seen;
    };
    return api;
  }

  it('a direct merge with a matching expected head lands', async () => {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr('clean'));
    const out = await mergePullRequestNow(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('merged');
    expect(api.mergedPrs).toHaveLength(1);
  });

  it('a direct merge with a different head is refused, the reason naming both commits, and nothing merges', async () => {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr('clean', MOVED));
    const out = await mergePullRequestNow(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('refused');
    expect(out.reason).toContain(REVIEWED);
    expect(out.reason).toContain(MOVED);
    expect(api.mergedPrs).toEqual([]);
  });

  it('arming with a matching expected head arms', async () => {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr('blocked'));
    const out = await armPullRequest(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('armed');
    expect(api.armedPrs).toHaveLength(1);
  });

  it('arming with a different head is refused, the reason naming both commits, and nothing is armed', async () => {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr('blocked', MOVED));
    const out = await armPullRequest(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('refused');
    expect(out.reason).toContain(REVIEWED);
    expect(out.reason).toContain(MOVED);
    expect(api.armedPrs).toEqual([]);
  });

  // The verb's comparison passed on the head it read; the host's pin is what
  // catches the push that landed after. Without the pin these two would land.
  it('the HOST pin: a head that moves after the verb read it refuses the merge, naming both commits', async () => {
    const api = racingFake('clean');
    const out = await mergePullRequestNow(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('refused');
    expect(out.reason).toMatch(/host refused/i);
    expect(out.reason).toContain(REVIEWED);
    expect(out.reason).toContain(MOVED);
    expect(api.mergedPrs).toEqual([]);
  });

  it('the HOST pin: a head that moves after the verb read it refuses the arm, naming both commits', async () => {
    const api = racingFake('blocked');
    const out = await armPullRequest(api, 'b', 'squash', { expectHead: REVIEWED });
    expect(out.outcome).toBe('refused');
    expect(out.reason).toMatch(/host refused/i);
    expect(out.reason).toContain(MOVED);
    expect(api.armedPrs).toEqual([]);
  });

  it('the fake pin itself: a mismatched expected head throws HeadMismatchError; none given merges whatever the head', async () => {
    const api = new InMemoryGitHubApi();
    api.setPrForBranch('b', openPr('clean', MOVED));
    await expect(api.mergePullRequest(7, 'squash', undefined, REVIEWED)).rejects.toBeInstanceOf(HeadMismatchError);
    await expect(api.enableAutoMerge(7, 'squash', undefined, REVIEWED)).rejects.toBeInstanceOf(HeadMismatchError);
    expect(await api.mergePullRequest(7, 'squash')).toMatchObject({ merged: true });
  });
});

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

describe('InMemoryGitHubApi landing message (ADR-0053)', () => {
  const FIRST = { title: 'Land the fix (#42)', body: 'The first record.' };
  const EDITED = { title: 'Land the fix, corrected (#42)', body: 'The corrected record.' };

  it('arming records the message the "host" froze; merging records the message that landed', async () => {
    const api = new InMemoryGitHubApi();
    await api.enableAutoMerge(42, 'squash', FIRST);
    await api.mergePullRequest(43, 'squash', FIRST);
    expect(api.armedPrs).toEqual([{ prNumber: 42, method: 'squash', message: FIRST }]);
    expect(api.mergedPrs).toEqual([{ prNumber: 43, method: 'squash', message: FIRST }]);
  });

  it('arming an ARMED PR again REPLACES the frozen message — the LandingHost re-arm contract', async () => {
    const api = new InMemoryGitHubApi();
    await api.enableAutoMerge(42, 'squash', FIRST);
    await api.enableAutoMerge(42, 'squash', EDITED);
    expect(api.armedPrs).toEqual([{ prNumber: 42, method: 'squash', message: EDITED }]);
  });

  it('without a message (--commit-message host) nothing is recorded as frozen — the key is absent, not undefined', async () => {
    const api = new InMemoryGitHubApi();
    await api.enableAutoMerge(42, 'squash');
    await api.mergePullRequest(43);
    expect(api.armedPrs).toEqual([{ prNumber: 42, method: 'squash' }]);
    expect('message' in api.armedPrs[0]).toBe(false);
    expect('message' in api.mergedPrs[0]).toBe(false);
  });

  it('holds a COPY — a caller mutating its object afterwards cannot rewrite what was frozen', async () => {
    const api = new InMemoryGitHubApi();
    const message = { ...FIRST };
    await api.enableAutoMerge(42, 'squash', message);
    message.title = 'rewritten after the fact';
    expect(api.armedPrs[0].message).toEqual(FIRST);
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

// ── the close reason the fake records, and the class the probe derives from it ─
//
// `GhStateReason` carries GitHub's fifth documented value, `duplicate`
// (read-side; see the type's own doc and ADR-0020's 2026-09-17 note). The fake
// is the conformance substrate every store-level case runs against, so the value
// has to survive a round-trip through it — and, just as importantly, has to
// change NOTHING about what the closing probe answers: that probe reads
// closing-PR EVIDENCE, never the close reason, so a duplicate close and a
// not-planned close are one class to it.
describe('InMemoryGitHubApi close reasons (ADR-0020 note 2026-09-17)', () => {
  it("records a `duplicate` close as `duplicate` — the round-trip keeps GitHub's fifth value", async () => {
    const api = new InMemoryGitHubApi();
    const { number } = await api.createIssue({ title: 't', body: '', labels: [] });
    await api.nativeClose(number, 'duplicate');
    const issue = await api.getIssue(number);
    expect(issue.state).toBe('closed');
    expect(issue.stateReason).toBe('duplicate');
  });

  it('getClosingState answers the SAME class for a duplicate close as for a not_planned one', async () => {
    const api = new InMemoryGitHubApi();
    const duplicate = await api.createIssue({ title: 'dup', body: '', labels: [] });
    const notPlanned = await api.createIssue({ title: 'np', body: '', labels: [] });
    await api.nativeClose(duplicate.number, 'duplicate');
    await api.nativeClose(notPlanned.number, 'not_planned');

    // Neither carries closing-PR evidence, so both are `closed-unknown` —
    // absence of evidence, never a rejection (W2-F1c).
    expect(await api.getClosingState(duplicate.number)).toEqual(
      await api.getClosingState(notPlanned.number),
    );
    expect(await api.getClosingState(duplicate.number)).toEqual({ state: 'closed-unknown' });

    // The control that makes the equality above mean something: the probe DOES
    // discriminate — on evidence. Record a merged PR against the
    // duplicate-closed issue and its class moves, while its close reason has not.
    await api.setClosingPr(duplicate.number, { merged: true, url: 'https://example.test/pull/9' });
    expect(await api.getClosingState(duplicate.number)).toEqual({
      state: 'merged',
      prUrl: 'https://example.test/pull/9',
    });
    expect((await api.getIssue(duplicate.number)).stateReason).toBe('duplicate');
  });
});
