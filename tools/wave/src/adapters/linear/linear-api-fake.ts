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
  LinearProject,
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

/**
 * The stored Document substrate (ADR-0017). Linear attaches a Document to
 * exactly ONE parent; this fake models the two arms the adapter can mint — the
 * bound project when the api is project-bound, else the api's own team — so a
 * scoped listing is assertable rather than narrated. Exactly one of the two
 * parent fields is set on anything {@link InMemoryLinearApi.createDocument}
 * mints; {@link InMemoryLinearApi.seedDocument} can set either, so a foreign
 * team's / foreign project's document can exist in the substrate at all.
 */
interface StoredDocument {
  id: string;
  title: string;
  content: string;
  /** The team key this Document hangs off, when team-attached. */
  teamKey?: string;
  /** The project name this Document hangs off, when project-attached. */
  project?: string;
}

/** The stored issue substrate — `stateType` is resolved from the catalog on read. */
interface StoredIssue {
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  stateName: string;
  /** Linear's `updatedAt`: moved by every issue-field write (see {@link InMemoryLinearApi.touch}). */
  updatedAt: string;
}

export class InMemoryLinearApi implements LinearApi {
  private readonly issues = new Map<string, StoredIssue>();
  private readonly commentsByIssue = new Map<string, string[]>();
  private readonly attachmentsByIssue = new Map<string, LinearPrAttachment[]>();
  /**
   * Upserted (non-github-sourced) attachment cards (issue #511), keyed
   * GLOBALLY by url — mirrors Linear's own published schema doc on
   * `AttachmentCreateInput.url`: "also used as an unique identifier for the
   * attachment. If another attachment is created with the same `url` value,
   * existing record is updated instead." A DIFFERENT substrate from
   * {@link attachmentsByIssue} on purpose: that map is only what the
   * GitHub-integration's `simulateMergedPrClose`/`simulateUnmergedClose`
   * hooks populate (the closing probe's evidence base); this one is only what
   * {@link upsertAttachment} populates, and `getPrAttachments` never reads it.
   */
  private readonly upsertedAttachments = new Map<
    string,
    { issueIdentifier: string; title: string; subtitle: string }
  >();
  private readonly documents = new Map<string, StoredDocument>();
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
  /**
   * The bound project, mirroring `RealLinearApi`'s optional `project`
   * constructor arg. Only the Document facet reads it (ADR-0017): with a
   * project bound the facet is project-scoped, without one it falls back to
   * this fake's own {@link teamKey}. Left undefined by every existing caller,
   * which is exactly the team-pool consumer's shape.
   *
   * Named `boundProject`, not `project` — this class already has a private
   * `project(issue)` PROJECTION method (StoredIssue → LinearIssue) and the
   * field would shadow it.
   */
  private readonly boundProject: string | undefined;

  constructor(teamKey = 'EX', project?: string) {
    this.teamKey = teamKey;
    this.boundProject = project;
  }

  /**
   * Monotonic backing for `updatedAt`. Real Linear moves that field on every
   * issue write; the fake models the same rule via {@link touch}. Strictly
   * increasing so a create→write→read sequence has an observably later
   * timestamp even inside one millisecond — which is what the conformance
   * suite's monotonicity assertion needs to mean anything on a fast machine.
   */
  private lastStampMs: number | undefined;

  private stamp(): string {
    const now = Date.now();
    const next = this.lastStampMs === undefined ? now : Math.max(now, this.lastStampMs + 1);
    this.lastStampMs = next;
    return new Date(next).toISOString();
  }

  /** Mark an issue as just-written — the `updatedAt`-moves-on-write rule. */
  private touch(issue: StoredIssue): void {
    issue.updatedAt = this.stamp();
  }

  async createIssue(input: LinearCreateIssueInput): Promise<{ identifier: string }> {
    const identifier = `${this.teamKey}-${++this.counter}`;
    this.issues.set(identifier, {
      identifier,
      title: input.title,
      description: input.description,
      labels: [...new Set(input.labels)],
      stateName: this.defaultCreateStateName(),
      updatedAt: this.stamp(),
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
    const issue = this.mustGet(identifier);
    issue.description = description;
    this.touch(issue);
  }

  async setTitle(identifier: string, title: string): Promise<void> {
    const issue = this.mustGet(identifier);
    issue.title = title;
    this.touch(issue);
  }

  async addLabel(identifier: string, label: string): Promise<void> {
    const issue = this.mustGet(identifier);
    if (!issue.labels.includes(label)) issue.labels.push(label); // idempotent; auto-creates
    this.touch(issue);
  }

  async removeLabel(identifier: string, label: string): Promise<void> {
    const issue = this.mustGet(identifier);
    issue.labels = issue.labels.filter((l) => l !== label); // idempotent
    this.touch(issue);
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
      return; // deliberately BEFORE touch(): a dropped write leaves updatedAt where it was
    }
    issue.stateName = stateName;
    this.touch(issue);
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

  /**
   * Upsert one attachment card, keyed globally by `input.url` (issue #511) —
   * models `RealLinearApi.upsertAttachment` / Linear's own upsert-by-url
   * semantics on `attachmentCreate`: a repeated call with the SAME url
   * overwrites `title`/`subtitle` in place rather than appending a second
   * card. Deliberately writes into {@link upsertedAttachments}, never
   * {@link attachmentsByIssue} — see that field's doc for why the two
   * substrates never merge.
   */
  async upsertAttachment(
    identifier: string,
    input: { url: string; title: string; subtitle: string },
  ): Promise<void> {
    this.mustGet(identifier);
    this.upsertedAttachments.set(input.url, {
      issueIdentifier: identifier,
      title: input.title,
      subtitle: input.subtitle,
    });
  }

  async hasGitHubIntegration(): Promise<boolean> {
    return this.githubIntegrationInstalled;
  }

  async listStates(): Promise<{ name: string; type: LinearStateType }[]> {
    return this.catalog.map((s) => ({ ...s }));
  }

  // ── Document facet substrate (ADR-0017) — a separate store from issues ──────

  /**
   * Mint a Document under this api's ONE parent — the bound project when there
   * is one, else its team — mirroring `RealLinearApi.createDocument`'s two
   * arms. Never parentless, because a team is always known.
   */
  async createDocument(input: { title: string; content: string }): Promise<{ id: string }> {
    const id = `doc-${++this.docCounter}`;
    this.documents.set(id, {
      id,
      title: input.title,
      content: input.content,
      ...(this.boundProject !== undefined
        ? { project: this.boundProject }
        : { teamKey: this.teamKey }),
    });
    return { id };
  }

  /** Fetch by id — deliberately NOT scope-filtered, mirroring `document(id)`: an id the caller holds resolves whatever its parent. */
  async getDocument(id: string): Promise<{ id: string; title: string; content: string }> {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`Linear document not found: ${id}`);
    return projectDocument(doc);
  }

  /**
   * The Documents in this api's own scope: the bound project's when a project
   * is bound, else this api's team's — never every document in the substrate
   * (`RealLinearApi`'s server-side `DocumentFilter`, modelled in memory).
   */
  async listDocuments(): Promise<{ id: string; title: string; content: string }[]> {
    return [...this.documents.values()]
      .filter((d) =>
        this.boundProject !== undefined
          ? d.project === this.boundProject
          : d.teamKey === this.teamKey,
      )
      .map(projectDocument);
  }

  // ── Goal facet substrate (ADR-0044) — projects ─────────────────────────────
  //
  // Modelled the same way the GitHub fake models milestones: projects in their
  // own id space, membership as a per-ISSUE pointer (so the curation write is
  // naturally idempotent and the member list is a scan, never a second
  // collection to keep in sync). Every project minted here belongs to this
  // api's TEAM, mirroring `ProjectCreateInput.teamIds`' required arity — which
  // is what makes {@link listProjects} team-scoped rather than workspace-wide.

  private readonly projects = new Map<string, LinearProject>();
  private projectCounter = 0;
  /** issue identifier → the project id it belongs to (absent = no project). */
  private readonly projectByIssue = new Map<string, string>();

  async createProject(input: { name: string; description: string }): Promise<{ id: string }> {
    const id = `prj-${++this.projectCounter}`;
    this.projects.set(id, { id, name: input.name, description: input.description });
    return { id };
  }

  async getProject(id: string): Promise<LinearProject> {
    const prj = this.projects.get(id);
    if (!prj) throw new Error(`Linear project not found: ${id}`);
    return { ...prj };
  }

  async listProjects(): Promise<LinearProject[]> {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  async setIssueProject(identifier: string, projectId: string): Promise<void> {
    this.mustGet(identifier); // throws on an unknown issue
    if (!this.projects.has(projectId)) {
      throw new Error(`Linear project not found: ${projectId}`);
    }
    this.projectByIssue.set(identifier, projectId);
    // The real `issueUpdate` moves `updatedAt`; model the same rule so a
    // curation write is observably a write.
    this.touch(this.mustGet(identifier));
  }

  async listProjectIssues(projectId: string): Promise<LinearIssue[]> {
    if (!this.projects.has(projectId)) {
      throw new Error(`Linear project not found: ${projectId}`);
    }
    // OPEN AND CLOSED, unlike listOpenIssues: `done` is a frontier reading.
    return [...this.issues.values()]
      .filter((i) => this.projectByIssue.get(i.identifier) === projectId)
      .map((i) => this.project(i));
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
    this.touch(issue);
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
    this.touch(issue);
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
    const issue = this.mustGet(identifier);
    issue.stateName = this.mustCompletedStateName();
    this.touch(issue);
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
   * Seed a Document with an EXPLICIT parent (ADR-0017 amendment): a document
   * belonging to another team, or to another project, or to this very team —
   * whatever the scoped listing is supposed to keep or drop. This is the only
   * way such a document can enter the substrate at all, since
   * {@link createDocument} can only ever mint one under this api's OWN parent,
   * so without it a scope filter is untestable (it would trivially keep
   * everything it could see). Returns the minted id. NOT part of `LinearApi` —
   * mirrors `addNativeRelation`'s test-only stance.
   */
  seedDocument(doc: { title: string; content?: string; team?: string; project?: string }): string {
    const id = `doc-${++this.docCounter}`;
    this.documents.set(id, {
      id,
      title: doc.title,
      content: doc.content ?? '',
      ...(doc.team !== undefined ? { teamKey: doc.team } : {}),
      ...(doc.project !== undefined ? { project: doc.project } : {}),
    });
    return id;
  }

  /**
   * Test affordance (issue #511): the upserted (non-github-sourced)
   * attachment cards currently recorded for `identifier`, oldest-insertion
   * order — what a live `attachments` query would show alongside (but
   * distinct from) the github-sourced ones {@link getPrAttachments} returns.
   * NOT part of `LinearApi` — mirrors `addNativeRelation`'s test-only stance.
   */
  listUpsertedAttachments(identifier: string): { url: string; title: string; subtitle: string }[] {
    const out: { url: string; title: string; subtitle: string }[] = [];
    for (const [url, rec] of this.upsertedAttachments) {
      if (rec.issueIdentifier === identifier) out.push({ url, title: rec.title, subtitle: rec.subtitle });
    }
    return out;
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
      updatedAt: issue.updatedAt,
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

/** Drop the parent bookkeeping — the seam returns the wire shape only (`{ id, title, content }`). */
function projectDocument(doc: StoredDocument): { id: string; title: string; content: string } {
  return { id: doc.id, title: doc.title, content: doc.content };
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
