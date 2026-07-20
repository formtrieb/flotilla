/**
 * github-api-fake.ts — a small STATEFUL in-memory GitHubApi for conformance.
 *
 * It holds exactly the substrate GitHubIssuesStore.read() projects from, so the
 * SAME conformance suite that drives MarkdownFsStore drives GitHubIssuesStore
 * with zero network and zero IssueStore-method overrides. Test-support only.
 */

import type {
  GitHubApi,
  GhIssue,
  GhStateReason,
  CreateIssueInput,
  ClosingPrState,
  RequiredChecksInfo,
} from './github-api';
import {
  AutoMergeUnavailableError,
  DEFAULT_MERGE_METHOD,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
} from '../../host-pr';
import type { GitHubIssuesStore } from './github-issues-store';
import type { IssueStoreConformanceHooks, IssueStore } from '../issue-store';

export class InMemoryGitHubApi implements GitHubApi {
  private readonly issues = new Map<number, GhIssue>();
  private readonly commentsByIssue = new Map<number, string[]>();
  private readonly closingByIssue = new Map<
    number,
    { merged: boolean; url?: string }
  >();
  private counter = 0; // per-instance; never reset between calls
  /** Store-preflight substrate (FOR-12): does the ambient token merge PRs? Default yes. */
  private canMergePrs = true;

  async createIssue(input: CreateIssueInput): Promise<{ number: number }> {
    const number = ++this.counter;
    this.issues.set(number, {
      number,
      title: input.title,
      body: input.body,
      labels: [...new Set(input.labels)],
      state: 'open',
      stateReason: null,
    });
    return { number };
  }

  async getIssue(number: number): Promise<GhIssue> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`GitHub issue not found: #${number}`);
    // hand back a copy so callers cannot mutate internal state
    return { ...issue, labels: [...issue.labels] };
  }

  async listOpenIssues(): Promise<GhIssue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === 'open')
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }

  async setBody(number: number, body: string): Promise<void> {
    this.mutate(number, (i) => (i.body = body));
  }

  async setTitle(number: number, title: string): Promise<void> {
    this.mutate(number, (i) => (i.title = title));
  }

  async addLabel(number: number, label: string): Promise<void> {
    this.mutate(number, (i) => {
      if (!i.labels.includes(label)) i.labels.push(label);
    });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    this.mutate(number, (i) => {
      i.labels = i.labels.filter((l) => l !== label);
    });
  }

  async addComment(number: number, body: string): Promise<void> {
    if (!this.issues.has(number)) {
      throw new Error(`GitHub issue not found: #${number}`);
    }
    const list = this.commentsByIssue.get(number) ?? [];
    list.push(body);
    this.commentsByIssue.set(number, list);
  }

  async getComments(number: number): Promise<{ body: string }[]> {
    if (!this.issues.has(number)) {
      throw new Error(`GitHub issue not found: #${number}`);
    }
    return (this.commentsByIssue.get(number) ?? []).map((body) => ({ body }));
  }

  async nativeClose(
    number: number,
    reason: GhStateReason = 'completed',
  ): Promise<void> {
    this.mutate(number, (i) => {
      i.state = 'closed';
      i.stateReason = reason;
    });
  }

  /**
   * Test affordance: record the closing PR for an issue (what the merged PR's
   * `Closes #N` establishes server-side). NOT part of GitHubApi — conformance
   * drivers reach it through the store's `api` field, like simulateNativeClose.
   */
  async setClosingPr(
    number: number,
    pr: { merged: boolean; url?: string },
  ): Promise<void> {
    if (!this.issues.has(number)) {
      throw new Error(`GitHub issue not found: #${number}`);
    }
    this.closingByIssue.set(number, pr);
  }

  async getClosingState(number: number): Promise<ClosingPrState> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`GitHub issue not found: #${number}`);
    if (issue.state === 'open') return { state: 'open' };
    const pr = this.closingByIssue.get(number);
    if (pr?.merged) {
      return pr.url !== undefined
        ? { state: 'merged', prUrl: pr.url }
        : { state: 'merged' };
    }
    return { state: 'closed-unmerged' };
  }

  async canMergePullRequests(): Promise<boolean> {
    return this.canMergePrs;
  }

  /**
   * Test affordance (FOR-12): flip the ambient token's PR-merge ability. NOT
   * part of GitHubApi — the store-preflight spec reaches it directly to drive
   * the read-only-token failure case. Mirrors setClosingPr's stance.
   */
  setCanMergePullRequests(canMerge: boolean): void {
    this.canMergePrs = canMerge;
  }

  // ─── Landing substrate (ADR-0023) ──────────────────────────────────────
  //
  // Test affordances, mirroring setClosingPr / setCanMergePullRequests: the
  // landing state is HELD explicitly rather than derived, so a spec drives any
  // posture without canned HTTP. The engine's arm intent is covered by
  // host-pr.spec.ts (host-neutral) and the real request shaping by
  // real-github-api.spec.ts (fixtures) — this fake exists so the seam is
  // implementable and the CLI is drivable, not to re-test either.

  private readonly prsByBranch = new Map<string, PrLandingStatus>();
  private readonly armed = new Map<number, MergeMethod>();
  private readonly merges: { prNumber: number; method: MergeMethod }[] = [];
  private allowAutoMerge = true;
  private requiredChecks: RequiredChecksInfo = {
    state: 'present',
    contexts: ['ci/test'],
    detail: 'fake: required checks present',
  };

  /** Test affordance: register the PR the host knows for a branch. */
  setPrForBranch(branch: string, status: PrLandingStatus): void {
    this.prsByBranch.set(branch, status);
  }

  /** Test affordance: flip the repo's "Allow auto-merge" setting. */
  setAllowsAutoMerge(allow: boolean): void {
    this.allowAutoMerge = allow;
  }

  /** Test affordance: set what the required-checks probe reports. */
  setRequiredChecks(info: RequiredChecksInfo): void {
    this.requiredChecks = info;
  }

  /** Test affordance: which PRs were armed, and how. */
  get armedPrs(): { prNumber: number; method: MergeMethod }[] {
    return [...this.armed].map(([prNumber, method]) => ({ prNumber, method }));
  }

  /** Test affordance: which PRs were merged, and how. */
  get mergedPrs(): { prNumber: number; method: MergeMethod }[] {
    return [...this.merges];
  }

  async getPrStatus(branch: string): Promise<PrLandingStatus> {
    return this.prsByBranch.get(branch) ?? { state: 'none' };
  }

  async enableAutoMerge(prNumber: number, method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<void> {
    // Mirrors the real host's two typed refusals so a CLI-level spec can drive
    // the arm-vs-merge routing against the fake exactly as against GitHub.
    if (!this.allowAutoMerge) {
      throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
    }
    this.armed.set(prNumber, method);
  }

  async mergePullRequest(prNumber: number, method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<MergeResult> {
    this.merges.push({ prNumber, method });
    return { merged: true, sha: `sha-${prNumber}` };
  }

  async allowsAutoMerge(): Promise<boolean> {
    return this.allowAutoMerge;
  }

  async getRequiredChecks(): Promise<RequiredChecksInfo> {
    return this.requiredChecks;
  }

  private mutate(number: number, fn: (i: GhIssue) => void): void {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`GitHub issue not found: #${number}`);
    fn(issue);
  }
}

/**
 * The GitHub native-close seam for the shared conformance suite. Reaches the
 * fake THROUGH the store under test (the store exposes its injected `api`), so
 * the hook is correctly bound to the per-test fake without extra wiring —
 * exactly what a merged PR's `Closes #N` does to the live issue.
 */
export const githubConformanceHooks: IssueStoreConformanceHooks = {
  async simulateNativeClose(store: IssueStore, id: string): Promise<void> {
    const api = (store as GitHubIssuesStore).api;
    await api.nativeClose(Number(id));
  },
};
