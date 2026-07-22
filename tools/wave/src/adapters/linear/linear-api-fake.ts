/**
 * linear-api-fake.ts — a small STATEFUL in-memory LinearApi for conformance.
 *
 * Mirrors {@link ../github/github-api-fake.InMemoryGitHubApi}: it holds exactly
 * the substrate LinearIssuesStore.read() projects from, so the SAME conformance
 * suite that drives MarkdownFsStore + GitHubIssuesStore drives LinearIssuesStore
 * with zero network and zero IssueStore-method overrides. Test-support only.
 *
 * Two Linear-specific pieces of state (ADR-0020): a workflow **state catalog**
 * (name → fixed category) the fake resolves `stateType` from, and the
 * GitHub-integration **PR attachments** the closing probe reads.
 */

import type {
  LinearApi,
  LinearIssue,
  LinearStateType,
  LinearCreateIssueInput,
  LinearPrAttachment,
} from './linear-api';
import type { LinearIssuesStore } from './linear-issues-store';
import type { IssueStoreConformanceHooks, IssueStore } from '../issue-store';

/** State categories that make an issue closed (excluded from listOpenIssues). */
const CLOSED_TYPES = new Set<LinearStateType>(['completed', 'canceled']);

/** The standard workflow — the fake's default state catalog (ADR-0020). */
const DEFAULT_STATE_CATALOG: { name: string; type: LinearStateType }[] = [
  { name: 'Triage', type: 'triage' },
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'In Review', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
  { name: 'Duplicate', type: 'duplicate' }, // live category (e2e find 2026-07-15) — NOT 'canceled'
];

/** The stored issue substrate — `stateType` is resolved from the catalog on read. */
interface StoredIssue {
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  stateName: string;
}

export class InMemoryLinearApi implements LinearApi {
  private readonly issues = new Map<string, StoredIssue>();
  private readonly commentsByIssue = new Map<string, string[]>();
  private readonly attachmentsByIssue = new Map<string, LinearPrAttachment[]>();
  private readonly documents = new Map<string, { id: string; title: string; content: string }>();
  /** blocked identifier → its NATIVE blocker identifiers (ADR-0020 read-union). */
  private readonly nativeBlockedBy = new Map<string, string[]>();
  private catalog: { name: string; type: LinearStateType }[] = [...DEFAULT_STATE_CATALOG];
  /** Store-preflight substrate (FOR-12): is the workspace's GitHub integration installed? Default yes. */
  private githubIntegrationInstalled = true;
  /** When set, the production {@link addBlockedBy} mirror rejects with it (models a failed `issueRelationCreate`). */
  private relationWriteError: Error | undefined;
  /** identifier → remaining {@link setState} calls to silently drop (FOR-64 / consumer KW-F2 fault injector). */
  private readonly droppedStateWrites = new Map<string, number>();
  private counter = 0; // per-instance; never reset between calls
  private docCounter = 0;
  private readonly teamKey: string;

  constructor(teamKey = 'EX') {
    this.teamKey = teamKey;
  }

  async createIssue(input: LinearCreateIssueInput): Promise<{ identifier: string }> {
    const identifier = `${this.teamKey}-${++this.counter}`;
    this.issues.set(identifier, {
      identifier,
      title: input.title,
      description: input.description,
      labels: [...new Set(input.labels)],
      stateName: this.defaultCreateStateName(),
    });
    return { identifier };
  }

  async getIssue(identifier: string): Promise<LinearIssue> {
    return this.project(this.mustGet(identifier));
  }

  async listOpenIssues(): Promise<LinearIssue[]> {
    return [...this.issues.values()]
      .map((i) => this.project(i))
      .filter((i) => !CLOSED_TYPES.has(i.stateType));
  }

  async setDescription(identifier: string, description: string): Promise<void> {
    this.mustGet(identifier).description = description;
  }

  async setTitle(identifier: string, title: string): Promise<void> {
    this.mustGet(identifier).title = title;
  }

  async addLabel(identifier: string, label: string): Promise<void> {
    const issue = this.mustGet(identifier);
    if (!issue.labels.includes(label)) issue.labels.push(label); // idempotent; auto-creates
  }

  async removeLabel(identifier: string, label: string): Promise<void> {
    const issue = this.mustGet(identifier);
    issue.labels = issue.labels.filter((l) => l !== label); // idempotent
  }

  async addComment(identifier: string, body: string): Promise<void> {
    this.mustGet(identifier);
    const list = this.commentsByIssue.get(identifier) ?? [];
    list.push(body);
    this.commentsByIssue.set(identifier, list);
  }

  async getComments(identifier: string): Promise<{ body: string }[]> {
    this.mustGet(identifier);
    return (this.commentsByIssue.get(identifier) ?? []).map((body) => ({ body }));
  }

  async setState(identifier: string, stateName: string): Promise<void> {
    const issue = this.mustGet(identifier);
    if (!this.catalog.some((s) => s.name === stateName)) {
      throw new Error(`Linear state not found in the team workflow: "${stateName}"`);
    }
    const dropsLeft = this.droppedStateWrites.get(identifier);
    if (dropsLeft && dropsLeft > 0) {
      // Report success but drop the write — models the live silent-transition
      // failure class (FOR-64 / consumer KW-F2): `setState` resolves normally
      // while `issue.stateName` is left untouched, so a caller's read-back
      // sees the pre-write state.
      if (dropsLeft === 1) this.droppedStateWrites.delete(identifier);
      else this.droppedStateWrites.set(identifier, dropsLeft - 1);
      return;
    }
    issue.stateName = stateName;
  }

  async getPrAttachments(identifier: string): Promise<LinearPrAttachment[]> {
    this.mustGet(identifier);
    return (this.attachmentsByIssue.get(identifier) ?? []).map((a) => ({ ...a }));
  }

  async getBlockedBy(identifier: string): Promise<string[]> {
    this.mustGet(identifier);
    return [...(this.nativeBlockedBy.get(identifier) ?? [])];
  }

  /**
   * Mirror ONE blockedBy ref natively (ADR-0020 write half). Both sides are
   * resolved via {@link mustGet} — modelling `RealLinearApi.addBlockedBy`, which
   * resolves both identifiers to UUIDs and throws on an unknown one (the store
   * treats that as a non-fatal single-mirror skip). An injected
   * {@link failRelationWrites} error models a rejected `issueRelationCreate`
   * mutation (transport/GraphQL failure). ADDITIVE-ONLY: appends to the same
   * `nativeBlockedBy` substrate `getBlockedBy` reads (never deletes) — a repeat
   * mirror double-represents, exactly as a live duplicate relation would, and
   * the store's read-union dedups it.
   */
  async addBlockedBy(blockedIdentifier: string, blockerIdentifier: string): Promise<void> {
    this.mustGet(blockedIdentifier);
    this.mustGet(blockerIdentifier);
    if (this.relationWriteError) throw this.relationWriteError;
    const list = this.nativeBlockedBy.get(blockedIdentifier) ?? [];
    list.push(blockerIdentifier);
    this.nativeBlockedBy.set(blockedIdentifier, list);
  }

  async hasGitHubIntegration(): Promise<boolean> {
    return this.githubIntegrationInstalled;
  }

  async listStates(): Promise<{ name: string; type: LinearStateType }[]> {
    return this.catalog.map((s) => ({ ...s }));
  }

  // ── Document facet substrate (ADR-0017) — a separate store from issues ──────
  async createDocument(input: { title: string; content: string }): Promise<{ id: string }> {
    const id = `doc-${++this.docCounter}`;
    this.documents.set(id, { id, title: input.title, content: input.content });
    return { id };
  }

  async getDocument(id: string): Promise<{ id: string; title: string; content: string }> {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`Linear document not found: ${id}`);
    return { ...doc };
  }

  async listDocuments(): Promise<{ id: string; title: string; content: string }[]> {
    return [...this.documents.values()].map((d) => ({ ...d }));
  }

  // ── test affordances (mirror InMemoryGitHubApi's setClosingPr shape) ────────

  /**
   * Drive an issue into closed-by-MERGED-PR: move it to a `completed` state (the
   * `Done` column) and record a merged PR attachment — what Linear's GitHub
   * integration establishes on PR-merge. NOT part of LinearApi; conformance
   * drivers reach it through the store's `api` field (like simulateNativeClose).
   */
  simulateMergedPrClose(identifier: string, prUrl: string): void {
    const issue = this.mustGet(identifier);
    issue.stateName = this.mustCompletedStateName();
    const list = this.attachmentsByIssue.get(identifier) ?? [];
    list.push({ url: prUrl, merged: true });
    this.attachmentsByIssue.set(identifier, list);
  }

  /**
   * Drive an issue into closed-by-REJECTED-PR: a `completed` state plus a PR
   * attachment that did NOT merge — what Linear's GitHub integration leaves
   * behind when a linked PR is closed without merging (the attachment stays;
   * only its `metadata.status` differs). Mirrors `InMemoryGitHubApi`'s
   * `setClosingPr({ merged: false, url })` hook.
   *
   * NOTE (FOR-23): this used to move the state and attach NOTHING, modelling a
   * rejected PR as an *absence*. That was not what the live integration does,
   * and it made the fake unable to distinguish "the PR was rejected" from "no
   * PR evidence exists" — the two cases W2-F1c is about. For a close with no PR
   * evidence at all, use {@link simulateCloseWithoutPrEvidence}.
   */
  simulateUnmergedClose(identifier: string, prUrl = 'https://github.com/o/r/pull/0'): void {
    const issue = this.mustGet(identifier);
    issue.stateName = this.mustCompletedStateName();
    const list = this.attachmentsByIssue.get(identifier) ?? [];
    list.push({ url: prUrl, merged: false });
    this.attachmentsByIssue.set(identifier, list);
  }

  /**
   * Drive an issue into closed with NO PR evidence whatsoever: a `completed`
   * state and no attachment. Models a close that never went through a PR — a
   * human closing it by hand, a duplicate/wontfix triage close, a close
   * triggered by a foreign id mentioned in some other PR's body, or any close
   * on a workspace whose GitHub integration is absent.
   *
   * The probe must read this as `closed-unknown`, never `closed-unmerged`
   * (W2-F1c) — there is no rejected PR here to find.
   */
  simulateCloseWithoutPrEvidence(identifier: string): void {
    this.mustGet(identifier).stateName = this.mustCompletedStateName();
  }

  /** Replace the team's workflow-state catalog (defaults to the standard workflow). */
  setStateCatalog(states: { name: string; type: LinearStateType }[]): void {
    this.catalog = states.map((s) => ({ ...s }));
  }

  /**
   * Test affordance (FOR-12): flip whether the workspace's GitHub integration is
   * installed. NOT part of LinearApi — the store-preflight spec reaches it to
   * drive the missing-integration failure case. Mirrors setStateCatalog's stance.
   */
  setGitHubIntegration(installed: boolean): void {
    this.githubIntegrationInstalled = installed;
  }

  /**
   * Record a NATIVE Linear blocked-by relation: `blocked` is blocked by
   * `blocker` (ADR-0020 read-union). NOT part of `LinearApi` — a test-only
   * affordance for driving `getBlockedBy`, mirroring how `simulateMergedPrClose`
   * drives the closing probe. Additive (repeat calls append; not idempotent —
   * callers that want a dedup test add the same pair twice on purpose).
   */
  addNativeRelation(blocked: string, blocker: string): void {
    this.mustGet(blocked);
    this.mustGet(blocker);
    const list = this.nativeBlockedBy.get(blocked) ?? [];
    list.push(blocker);
    this.nativeBlockedBy.set(blocked, list);
  }

  /**
   * Test affordance (ADR-0020 write half): force the production
   * {@link addBlockedBy} mirror to REJECT with `error` (a rejected
   * `issueRelationCreate`), or pass `null` to clear it. NOT part of `LinearApi`
   * — the store's non-fatal-mirror spec reaches it to prove a failed native
   * relation write never fails the authoritative create/annotate. Mirrors
   * `setStateCatalog`/`setGitHubIntegration`'s stance.
   */
  failRelationWrites(error: Error | null): void {
    this.relationWriteError = error ?? undefined;
  }

  /**
   * Test affordance (FOR-64 / consumer KW-F2): make the next `times` calls to
   * {@link setState} for `identifier` resolve successfully WITHOUT actually
   * changing the stored state — models the live silent-transition failure
   * class that motivated {@link LinearIssuesStore}'s verify-after-write guard
   * on `transition()` (a `setState` mutation that reports `success: true`
   * while the issue's real state never moves). Self-clearing: once the drop
   * budget is spent, subsequent calls apply normally, so a caller's retry
   * after the guard throws can succeed. NOT part of `LinearApi` — mirrors
   * `failRelationWrites`'s stance as a test-only fault injector.
   */
  simulateDroppedStateWrite(identifier: string, times = 1): void {
    this.mustGet(identifier);
    this.droppedStateWrites.set(identifier, times);
  }

  // ── internals ───────────────────────────────────────────────────────────────
  private mustGet(identifier: string): StoredIssue {
    const issue = this.issues.get(identifier);
    if (!issue) throw new Error(`Linear issue not found: ${identifier}`);
    return issue;
  }

  private project(issue: StoredIssue): LinearIssue {
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      labels: [...issue.labels],
      stateName: issue.stateName,
      stateType: this.typeOf(issue.stateName),
    };
  }

  private typeOf(stateName: string): LinearStateType {
    return this.catalog.find((s) => s.name === stateName)?.type ?? 'backlog';
  }

  /** The state a freshly-created issue lands in — a non-claim, open column. */
  private defaultCreateStateName(): string {
    const byType = (t: LinearStateType) => this.catalog.find((s) => s.type === t)?.name;
    return (
      byType('backlog') ??
      byType('triage') ??
      this.catalog.find((s) => !CLOSED_TYPES.has(s.type))?.name ??
      this.catalog[0]?.name ??
      'Backlog'
    );
  }

  private mustCompletedStateName(): string {
    const name = this.catalog.find((s) => s.type === 'completed')?.name;
    if (!name) throw new Error('state catalog has no `completed`-type state');
    return name;
  }
}

/**
 * The Linear native-close seam for the shared conformance suite. Reaches the fake
 * THROUGH the store under test (the store exposes its injected `api`), so the hook
 * binds to the per-test fake without extra wiring — exactly what Linear's GitHub
 * integration does on PR-merge (state → Done + a merged PR attachment).
 */
export const linearConformanceHooks: IssueStoreConformanceHooks = {
  async simulateNativeClose(store: IssueStore, id: string): Promise<void> {
    const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
    api.simulateMergedPrClose(id, 'https://github.com/x/y/pull/1');
  },
  async simulateClosedMergedPr(
    store: IssueStore,
    id: string,
    prUrl: string,
  ): Promise<void> {
    const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
    api.simulateMergedPrClose(id, prUrl);
  },
  async simulateClosedUnmergedPr(
    store: IssueStore,
    id: string,
  ): Promise<'closed-unmerged'> {
    // Linear's GitHub integration leaves a non-merged PR attachment → the store
    // CAN prove the rejection → closed-unmerged.
    const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
    api.simulateUnmergedClose(id);
    return 'closed-unmerged';
  },
  async simulateClosedNoEvidence(store: IssueStore, id: string): Promise<void> {
    // A completed state with NO attachment → no PR evidence → closed-unknown.
    const api = (store as LinearIssuesStore).api as InMemoryLinearApi;
    api.simulateCloseWithoutPrEvidence(id);
  },
};
