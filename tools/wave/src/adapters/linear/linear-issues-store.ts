/**
 * linear-issues-store.ts — the Linear IssueStore (ADR-0020, the M2-pulled-forward
 * adapter). Passes the SAME conformance suite unchanged as MarkdownFsStore and
 * GitHubIssuesStore (P3 parity), talking only to the injected {@link LinearApi}
 * seam (in-memory fake in tests; real GraphQL impl in M2). The Linear shape:
 *
 * - The **claim ledger is the workflow STATE** (config-mapped names, defaults
 *   `Todo / In Progress / In Review`; ADR-0020) — not a `wave/<rung>` label. The
 *   board is the live wave dashboard, and Linear's GitHub integration already
 *   flips the terminal rung to `Done` on PR-merge.
 * - Everything vocabulary-shaped stays a LABEL exactly like GitHub: the
 *   eligibility OR-set, `risk/<x>`, `worker/<x>`, the triage vocab, and the
 *   orthogonal `wave/needs-attention` flag (a flag CANNOT be a state, ADR-0006).
 * - `files`/`blockedBy`/`AC` live in the issue description via the SHARED
 *   {@link ../body-codec} (byte-identical to GitHub).
 * - `status` is DERIVED: `done` from the state's fixed category
 *   (`completed`/`canceled`, the same lossy collapse as ADR-0002); the claim
 *   rungs from the state name.
 * - `close()` is no-op-or-reconcile (mirrors GitHub verbatim): record the
 *   closing PR + cosmetic AC tick in the description, but DO NOT force a state
 *   change — Linear's GitHub integration flips the state out of band.
 */

import type {
  IssueView,
  CoarseState,
  IssueRef,
  BlockedBy,
  TriageSchema,
  TriageView,
  ApplyTriageInput,
} from '../../contract';
import { DEFAULT_TRIAGE_SCHEMA } from '../../contract';
import {
  DEFAULT_ELIGIBILITY,
  RUNG_PRECEDENCE,
  classifyCreateInput,
  goalMemberKind,
  requireGoalContainer,
  requireGoalMemberKind,
  renderGoalUpdateBody,
  validateAmendPatch,
  GoalMemberJoinError,
  type IssueStore,
  type CreateInput,
  type AnnotatePatch,
  type AmendPatch,
  type ListScope,
  type ClaimRung,
  type NeedsAttentionPayload,
  type PublishDocumentInput,
  type DocumentView,
  type ClosingState,
  type CreateGoalInput,
  type CreateGoalMemberInput,
  type GoalContainer,
  type GoalUpdateMemberIdentity,
  type GoalUpdateReceipt,
  type GoalView,
  type PublishGoalUpdateInput,
  withTriageDisclaimer,
} from '../issue-store';
import {
  computeGoalFrontier,
  type GoalBlocker,
  type GoalFrontier,
  type GoalMemberFacts,
} from '../../goal-frontier';
import type {
  LinearApi,
  LinearIssue,
  LinearProject,
  LinearProjectStatusType,
} from './linear-api';
import {
  serializeBody,
  serializeBareBody,
  parseBody,
  upsertLine,
  tickAcs,
  replaceSection,
  appendBodySections,
  upsertSection,
  parentToLine,
} from '../body-codec';

const VALID_RUNGS: readonly ClaimRung[] = ['queued', 'in-flight', 'in-review'];
const CLOSED_BY = 'Closed-by';
/** Orthogonal needs-attention label (ADR-0006) — a flag CANNOT be a workflow state. */
const NEEDS_ATTENTION_LABEL = 'wave/needs-attention';
/** State categories that project to the terminal `done` bookend (ADR-0020, lossy per ADR-0002 — a duplicate-close is a close). */
const CLOSED_TYPES = new Set(['completed', 'canceled', 'duplicate']);
/**
 * The Goal containers this store realizes — `project` (ADR-0044 decision 4) and
 * `initiative` (ADR-0045). BOTH, and only on this store: an initiative is a
 * Linear shape, so github and markdown-fs still answer that binding with
 * `GoalBindingError: 'unrealized-container'`.
 *
 * There is deliberately NO default beside this list. GitHub can default to
 * Milestone because it is the only native container with direct issue
 * membership, so no consumer convention can collide with it; Linear cannot,
 * because live conventions already disagree about what a project MEANS — one
 * shipped consumer runs Initiative=Epic / Project=User Story (chasing Linear's
 * timeline and health views, which live at project/initiative level rather than
 * on issues), while ADR-0017 once sketched "Wave ≈ Linear Project". Picking
 * either silently would overwrite somebody's meaning, so the binding is explicit
 * and a goal verb without one refuses loudly, naming the config key.
 *
 * The two roles differ in MEMBER KIND, which is the whole of ADR-0045
 * decision 1: a `project`-bound goal holds issues, an `initiative`-bound goal
 * holds PROJECTS. Every goal verb below therefore branches on the resolved role
 * rather than assuming issues — and {@link goalMemberKind} is where that branch
 * reads its answer, so the two arms cannot drift apart.
 */
const GOAL_CONTAINERS_REALIZED: readonly GoalContainer[] = ['project', 'initiative'];

/** Project status categories that project to the frontier's `done` bookend (ADR-0045 decision 2 — the issue rule's mirror). */
const CLOSED_PROJECT_STATUS = new Set<LinearProjectStatusType>(['completed', 'canceled']);
/** Project status categories that read as CLAIMED — somebody has it (ADR-0045 decision 2). */
const CLAIMED_PROJECT_STATUS = new Set<LinearProjectStatusType>(['started', 'paused']);

/**
 * Thrown by {@link LinearIssuesStore.transition} when a `setState` call
 * reported success but an immediate read-back shows a DIFFERENT state
 * (consumer KW-F2, live retro 2026-07-21): on the first Linear consumer wave,
 * three consecutive `transition()` calls each got `success: true` back from
 * Linear, yet the issue's own stateHistory shows no state change for ~50
 * minutes — the coarse rung silently lied to every human and to
 * `listClaimed`-based planning until a human noticed before the engine did.
 * Root cause never reproduced; eventual consistency at Linear's write/read
 * edge is the leading suspicion (three identical `success:true` responses
 * make an adapter-side bug unlikely). This guard makes the whole failure
 * class visible AT THE WRITE SITE instead of leaving it to a human: one extra
 * read per transition, thrown loud with the issue id and both state names so
 * the caller can retry or flag rather than silently drift.
 */
export class LinearTransitionVerifyError extends Error {
  constructor(
    readonly issueId: string,
    readonly expectedState: string,
    readonly actualState: string,
  ) {
    super(
      `LinearIssuesStore.transition(${issueId}): setState("${expectedState}") reported ` +
        `success, but reading the issue back immediately shows state "${actualState}" — ` +
        'the write was silently dropped (verify-after-write guard, consumer KW-F2).',
    );
    this.name = 'LinearTransitionVerifyError';
  }
}

/**
 * Claim-rung → workflow-state-NAME mapping + the unclaim/unplanned targets
 * (ADR-0020).
 *
 * **Side-finding (consumer KW-F2 retro, 2026-07-21 — documented here so the
 * next coordinator does not re-investigate it):** `create()` never sets a
 * `stateId` on the `issueCreate` mutation (see `real-linear-api.ts`), so a
 * freshly engine-created issue lands wherever the TEAM's own default landing
 * state is. On a team with Linear's Triage feature enabled, that default is
 * the native `Triage` inbox column — NOT `Backlog`
 * (`DEFAULT_LINEAR_STATES.unclaimTarget`), even though `unclaimTarget` is
 * where `unclaim()` and the cosmetic triage-move write BACK to. A
 * newly-created issue therefore does not visibly leave `Triage` until either
 * it is claimed (`transition(id, 'queued')` moves it to `queued`'s mapped
 * state) or an explicit `applyTriage()` call fires the cosmetic inbox-clear
 * (see `applyTriage`, below). This is expected tracker behaviour, not an
 * adapter bug.
 */
export interface LinearStateMap {
  queued: string;
  inFlight: string;
  inReview: string;
  /** Where `unclaim()` parks a released claim (`Backlog`). */
  unclaimTarget: string;
  /** The native `not_planned` state `closeUnplanned()` moves to (`Canceled`). */
  unplanned: string;
  /**
   * Optional opt-in fallback done-state name (FOR-13). NO default — undefined
   * unless a consumer sets it, and the RECOMMENDED mode is to leave it unset:
   * `done` stays fully DERIVED from the tracker's own closing signal
   * (ADR-0002/0020). Only a consumer workspace with no Linear↔GitHub
   * integration (so the tracker's own probe can never see a merge) should set
   * this — it lets {@link LinearIssuesStore.close} force the mapped transition
   * once the wave has already confirmed the PR merged.
   */
  doneState?: string;
}

/** Default rung→state mapping (the standard workflow, ADR-0020). */
export const DEFAULT_LINEAR_STATES: LinearStateMap = {
  queued: 'Todo',
  inFlight: 'In Progress',
  inReview: 'In Review',
  unclaimTarget: 'Backlog',
  unplanned: 'Canceled',
};

export interface LinearIssuesStoreOptions {
  api: LinearApi;
  /** Eligibility OR-set (default {@link DEFAULT_ELIGIBILITY}, ADR-0003). */
  eligibility?: readonly string[];
  /** Triage vocabulary (default {@link DEFAULT_TRIAGE_SCHEMA}, ADR-0015). */
  triageSchema?: TriageSchema;
  /** Rung→state-name overrides, merged over {@link DEFAULT_LINEAR_STATES}. */
  states?: Partial<LinearStateMap>;
  /** Schema category → existing consumer label name (e.g. `{bug:'Bug'}`, ADR-0020). */
  categoryLabels?: Record<string, string>;
}

export class LinearIssuesStore implements IssueStore {
  /** Exposed so the conformance hook can reach the injected fake (test seam). */
  readonly api: LinearApi;
  private readonly eligibility: readonly string[];
  private readonly triageSchema: TriageSchema;
  private readonly states: LinearStateMap;
  private readonly categoryLabels: Record<string, string>;

  constructor(opts: LinearIssuesStoreOptions) {
    this.api = opts.api;
    this.eligibility = opts.eligibility ?? DEFAULT_ELIGIBILITY;
    this.triageSchema = opts.triageSchema ?? DEFAULT_TRIAGE_SCHEMA;
    this.states = { ...DEFAULT_LINEAR_STATES, ...opts.states };
    this.categoryLabels = opts.categoryLabels ?? {};
  }

  async create(input: CreateInput): Promise<string> {
    // Whole-input validation FIRST (ADR-0027): a half-written Header-Block
    // throws before the createIssue call, so a rejected create files nothing.
    const shape = classifyCreateInput(input);

    if (shape.kind === 'bare') {
      // ADR-0027 bare filing: the free prose (gap description, provenance line)
      // and NOTHING else — no `## Files`/`## Blocked by`/`## Acceptance criteria`
      // sections, and NO labels at all: no eligibility token (so `listOpen`
      // never surfaces it) and no `risk/*`/`worker/*` stamp.
      const { identifier } = await this.api.createIssue({
        title: input.title,
        description: serializeBareBody(input.bodySections),
        labels: [],
      });
      // ADR-0044's bare `blockedBy` arm: the declared dependency becomes a
      // NATIVE Linear issue relation and nothing else — no `## Blocked by`
      // section is written, so the bare invariant above still holds. Nothing to
      // refuse up front the way the GitHub adapter must: a Linear identifier
      // carries its team slug, so `refToIdentifier` resolves a cross-TEAM ref as
      // readily as a same-team one, and there is no repo-scoping to trip over.
      // The ADR-0020 read-union then reports the edge back (codec ∪ native).
      //
      // Best-effort per ref, as the decorated mirror is — what remains after a
      // resolvable ref is transport-level refusal (a rejected
      // `issueRelationCreate`), the class create()/annotate() have always
      // absorbed rather than failed a landed issue write over.
      if (shape.blockedBy !== undefined) {
        await this.mirrorBlockedBy(identifier, shape.blockedBy);
      }
      return identifier;
    }

    const decorated = shape.input;
    const description = serializeBody({
      files: decorated.files,
      blockedBy: decorated.blockedBy,
      ...(decorated.unblocks !== undefined ? { unblocks: decorated.unblocks } : {}),
      ...(decorated.parent !== undefined ? { parent: decorated.parent } : {}),
      acceptanceCriteria: decorated.acceptanceCriteria,
      ...(decorated.estimatedWallclock !== undefined
        ? { estimatedWallclock: decorated.estimatedWallclock }
        : {}),
      ...(decorated.bodySections !== undefined
        ? { bodySections: decorated.bodySections }
        : {}),
    });
    const labels = [
      this.eligibility[0],
      `risk/${decorated.risk}`,
      `worker/${decorated.worker}`,
    ];
    const { identifier } = await this.api.createIssue({
      title: decorated.title,
      description,
      labels,
    });
    // Mirror the just-written body-codec blockedBy into NATIVE Linear relations
    // (ADR-0020 write half) so blocked rows carry a visible board relation, not
    // just a body line. Best-effort: the body-codec write above is the
    // authoritative one (ADR-0020), so a failed mirror never fails create().
    await this.mirrorBlockedBy(identifier, decorated.blockedBy);
    return identifier; // filingHint ignored — id is the opaque team identifier (ADR-0001/0020)
  }

  /**
   * Invert a `EX-16` identifier into `{ slug: 'EX', issue: 16 }`; throws on an
   * id with no trailing numeric part (the ADR-0001 store-owns-its-format seam).
   */
  parseRef(id: string): IssueRef {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (!m) {
      throw new Error(`parseRef: Linear id "${id}" is not a "<team>-<number>" identifier.`);
    }
    return { slug: m[1], issue: Number(m[2]) };
  }

  async annotate(id: string, patch: AnnotatePatch): Promise<void> {
    const issue = await this.api.getIssue(id); // throws on unknown id

    // risk/worker → swap the sole risk/* | worker/* label (remove old, add new).
    if (patch.risk !== undefined) {
      await this.replaceLabel(id, issue.labels, 'risk', patch.risk);
    }
    if (patch.worker !== undefined) {
      await this.replaceLabel(id, issue.labels, 'worker', patch.worker);
    }

    // files/AC/bodySections → surgically rewrite the managed description region,
    // preserving unmodeled sections/lines (NOT a parseBody→serializeBody round-trip).
    let description = issue.description;
    if (patch.files !== undefined) {
      description = replaceSection(description, 'Files', patch.files.map((f) => `- ${f}`));
    }
    if (patch.acceptanceCriteria !== undefined) {
      description = replaceSection(
        description,
        'Acceptance criteria',
        patch.acceptanceCriteria.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}`),
      );
    }
    if (patch.bodySections !== undefined) {
      description = appendBodySections(description, patch.bodySections);
    }
    if (patch.parent !== undefined) {
      description = upsertLine(description, 'Parent', parentToLine(patch.parent));
    }
    if (description !== issue.description) await this.api.setDescription(id, description);

    // Mirror the issue's CANONICAL body-codec blockedBy into native relations
    // (ADR-0020 write half). AnnotatePatch deliberately carries no `blockedBy`
    // (dependency structure is out-of-band — issue-store.ts), and annotate never
    // rewrites the Blocked-by section, so this reconciles the native side
    // against the EXISTING codec block: any codec ref not yet natively
    // represented ("newly added") is created, additively. It NEVER deletes — a
    // human-drawn or stale native relation survives.
    //
    // Parse the UPDATED (post-patch) `description` local, not the stale
    // `issue.description` read at the top of this method: on a genuine
    // decorate-target the pre-patch body has no Files section yet (that's
    // exactly the write this call just performed above), so parsing the
    // pre-patch value throws even though the write itself succeeded. And the
    // parse must sit INSIDE this same try — the surrounding comment on
    // mirrorBlockedBy promises "a failed mirror never fails annotate()", but a
    // throw from parseBody in the argument expression happens BEFORE
    // mirrorBlockedBy's own try/catch ever runs, so it used to escape
    // annotate() as an uncaught rejection after every write had already
    // landed. Folding the parse into this guard makes an unparseable body
    // degrade to a skipped mirror, matching the documented best-effort
    // semantics exactly.
    try {
      await this.mirrorBlockedBy(id, parseBody(description).blockedBy);
    } catch {
      // best-effort (ADR-0020): the body-codec write above is authoritative
      // and already landed; a body that still fails to parse (or a mirror
      // that itself throws) must not fail annotate().
    }
  }

  // ── amend (ADR-0025 — authored content: title + free-prose sections) ───────
  async amend(id: string, patch: AmendPatch): Promise<void> {
    validateAmendPatch(patch); // whole-patch validation before any write (empty / blank heading)
    const issue = await this.api.getIssue(id); // throws on unknown id

    // Transform the description IN MEMORY first: a reserved-heading section
    // (upsertSection throws, naming annotate) aborts before any write, so a
    // reserved collision never leaves a partially-amended issue.
    let description = issue.description;
    for (const s of patch.sections ?? []) {
      description = upsertSection(description, s.heading, s.markdown);
    }
    if (patch.title !== undefined) await this.api.setTitle(id, patch.title);
    if (description !== issue.description) await this.api.setDescription(id, description);
  }

  /** Swap the sole `prefix/*` label for `prefix/<value>` (idempotent). */
  private async replaceLabel(
    id: string,
    labels: string[],
    prefix: string,
    value: string,
  ): Promise<void> {
    for (const l of labels) {
      if (l.startsWith(`${prefix}/`) && l !== `${prefix}/${value}`) {
        await this.api.removeLabel(id, l);
      }
    }
    await this.api.addLabel(id, `${prefix}/${value}`);
  }

  async read(id: string): Promise<IssueView> {
    const issue = await this.api.getIssue(id); // throws on unknown id
    const view = this.project(id, issue);
    return { ...view, blockedBy: await this.unionBlockedBy(id, view.blockedBy) };
  }

  /**
   * Read-side union (ADR-0020 DoR-gate fix): the body-codec `blockedBy` can't
   * see the consumer's existing issues' NATIVE Linear blocked-by relations —
   * without this union the DoR gate would dispatch a row whose real blocker is
   * still open. Native refs are mapped through {@link parseRef} (the same
   * inversion the codec refs were minted through), so both sides normalize to
   * the same `{slug, issue}` shape and dedupe correctly. Write stays
   * body-codec-only in this slice (native write is the declared fast-follow).
   *
   * Dedup key normalization (same precedent as `dor-gate.ts`'s
   * `checkBlockedByChain`: `const slug = ref.slug ?? ownSlug;`): a codec ref
   * parsed from a hand-written body can be slug-less (same-team shorthand,
   * `#16` → `{issue: 16}`, body-codec `REF_RE`), while a native ref always
   * comes through `parseRef('EX-16')` and so always carries the resolved
   * team slug. Without normalizing, the SAME real blocker would key as `"#16"`
   * vs `"EX#16"` and appear twice. `ownSlug` — this referencing issue's own
   * team — is what a slug-less ref implicitly means, so it's substituted only
   * for the dedup key; the refs themselves are returned unmutated.
   */
  private async unionBlockedBy(id: string, codec: BlockedBy): Promise<BlockedBy> {
    const nativeIds = await this.api.getBlockedBy(id);
    if (nativeIds.length === 0) return codec;
    const ownSlug = this.parseRef(id).slug;
    const merged = new Map<string, IssueRef>();
    for (const ref of codec === 'none' ? [] : codec) merged.set(refKey(ref, ownSlug), ref);
    for (const nativeId of nativeIds) {
      const ref = this.parseRef(nativeId);
      merged.set(refKey(ref, ownSlug), ref);
    }
    const out = [...merged.values()];
    return out.length === 0 ? 'none' : out;
  }

  /**
   * The WRITE counterpart of {@link unionBlockedBy} (ADR-0020 fast-follow):
   * mirror the canonical body-codec `blockedBy` into NATIVE Linear issue
   * relations so a blocked row carries a visible board relation, not just a body
   * line. Three properties, all load-bearing:
   *
   *  - **Additive-only.** Only refs NOT already represented natively are
   *    created (delta vs {@link LinearApi.getBlockedBy}, keyed by the SAME
   *    `ownSlug`-normalized {@link refKey} the read-union dedups on). This
   *    method has no delete/update path: a human-drawn relation survives any
   *    re-scope, and a stale mirror is harmless (read() dedups double
   *    representation). "Newly added refs" = codec refs missing from the native
   *    side (the AnnotatePatch has no `blockedBy`, so annotate reconciles the
   *    existing codec block rather than a patch delta).
   *  - **Best-effort / non-fatal.** The body-codec write is the authoritative
   *    one (ADR-0020); a mirror that throws — an unresolvable ref (COORDINATOR
   *    note 2), or a rejected `issueRelationCreate` — is SKIPPED per-ref, never
   *    propagated, so create()/annotate() always complete the issue write. Same
   *    ADR-0004 best-effort-swallow class as the cosmetic inbox clear below; no
   *    logger seam exists in the engine, so the disclosure is structural: read()
   *    still surfaces the codec ref via the union, and a later create/annotate
   *    re-reconciles the native side.
   */
  private async mirrorBlockedBy(id: string, blockedBy: BlockedBy): Promise<void> {
    if (blockedBy === 'none' || blockedBy.length === 0) return;
    const ownSlug = this.parseRef(id).slug;
    let existing: Set<string>;
    try {
      existing = new Set(
        (await this.api.getBlockedBy(id)).map((nid) => refKey(this.parseRef(nid), ownSlug)),
      );
    } catch {
      existing = new Set(); // a failed native read must not fail the body write
    }
    for (const ref of blockedBy) {
      if (existing.has(refKey(ref, ownSlug))) continue; // already native — additive, no duplicate
      try {
        await this.api.addBlockedBy(id, refToIdentifier(ref, ownSlug));
      } catch {
        // swallow — best-effort mirror (ADR-0020). The authoritative body-codec
        // write already landed; a missing native mirror is harmless (read()
        // unions codec ∪ native and dedups).
      }
    }
  }

  async transition(id: string, rung: ClaimRung): Promise<void> {
    if (!VALID_RUNGS.includes(rung)) {
      throw new Error(
        `transition() accepts only ${VALID_RUNGS.join(' | ')}; got "${rung}". ` +
          `available/done are derived bookends and must not be written.`,
      );
    }
    // The claim ledger IS the workflow state (ADR-0020): set the single mapped
    // state NAME. States are mutually exclusive by construction (one state at a
    // time) and idempotent (setting the same name twice is a no-op).
    const expected = this.stateNameForRung(rung);
    await this.api.setState(id, expected);
    // Verify-after-write (consumer KW-F2, live retro 2026-07-21): a
    // success-reported `setState` can silently drop the write (see
    // {@link LinearTransitionVerifyError} for the incident this guards
    // against). One extra read per flip makes the entire failure class
    // visible at the write site — the skill-side read-backs used as a
    // stopgap during that wave saw zero further incidents once this landed.
    const actual = (await this.api.getIssue(id)).stateName;
    if (actual !== expected) {
      throw new LinearTransitionVerifyError(id, expected, actual);
    }
  }

  async unclaim(id: string): Promise<void> {
    const issue = await this.api.getIssue(id); // throws on unknown id
    // Only move if the issue currently sits in a claim state — else no-op, so a
    // human-parked `Backlog`/`Triage` issue is not disturbed (idempotent).
    if (this.rungOf(issue.stateName) !== null) {
      await this.api.setState(id, this.states.unclaimTarget);
    }
  }

  // ── flag / clearFlag (the orthogonal needs-attention overlay, ADR-0006) ────
  async flag(id: string, payload: NeedsAttentionPayload): Promise<void> {
    await this.api.getIssue(id); // existence check / throw on unknown id
    // Orthogonal to the claim: a LABEL, not a state — the workflow state (the
    // claim rung) is untouched, so clearFlag restores it.
    await this.api.addLabel(id, NEEDS_ATTENTION_LABEL);
    await this.api.addComment(id, renderNeedsAttentionComment(payload));
  }

  async clearFlag(id: string): Promise<void> {
    await this.api.removeLabel(id, NEEDS_ATTENTION_LABEL); // idempotent no-op if absent
  }

  async close(id: string, prUrl: string, ackedAcIndexes: number[]): Promise<void> {
    const issue = await this.api.getIssue(id);
    // no-op-or-reconcile (ADR-0005, mirrors GitHub): record the closing PR +
    // cosmetic AC tick in the description; do NOT force a state change — Linear's
    // GitHub integration flips the state to a completed category out of band.
    let description = upsertLine(issue.description, CLOSED_BY, prUrl);
    description = tickAcs(description, ackedAcIndexes);
    await this.api.setDescription(id, description);

    // Native attachment upsert (issue #511 — mechanics proven consumer-side):
    // give the closing PR a visible card in the issue's own attachment
    // section too, next to the `Closed-by:` body line. Unconditional (not
    // gated by `states.doneState`) and idempotent on Linear's OWN
    // upsert-by-url semantics — a re-entrant close() with the same `prUrl`
    // (wave-close is re-entrant, ADR-0018) updates this ONE card's subtitle
    // rather than minting a second one. Deliberately independent of the
    // GitHub-integration-only evidence `readClosing`/`getPrAttachments` read
    // — see `LinearApi.getPrAttachments`'s doc for why this write can never
    // feed that probe.
    await this.api.upsertAttachment(id, {
      url: prUrl,
      title: closingAttachmentTitle(prUrl),
      subtitle: 'merged',
    });

    // Opt-in done-state fallback (FOR-13). Dead unless a consumer sets
    // `states.doneState` — the default/recommended path above is the whole
    // method, byte-for-byte unchanged. When set, ONLY act if the tracker's own
    // closing signal hasn't already caught the issue up to a terminal state —
    // whether because there is no Linear↔GitHub integration to see the merge,
    // or it simply hasn't synced yet. An issue that is ALREADY terminal (via
    // the real integration, OR genuinely closed unmerged by some other means)
    // is left untouched: the fallback must never overwrite a real signal, and
    // re-close() (wave-close is re-entrant/idempotent) must not double-post.
    if (this.states.doneState !== undefined && !CLOSED_TYPES.has(issue.stateType)) {
      await this.api.setState(id, this.states.doneState);
      await this.api.addComment(id, renderDoneStateFallbackAdvisory(prUrl, this.states.doneState));
    }
  }

  async readClosing(id: string): Promise<ClosingState> {
    const issue = await this.api.getIssue(id); // throws on unknown id
    // Open until the state category is terminal (completed/canceled, ADR-0020).
    if (!CLOSED_TYPES.has(issue.stateType)) return { state: 'open' };
    // Closed. The GitHub-integration PR attachments are the ONLY merge evidence
    // this store has (ADR-0020 — the probe never cross-calls GitHub), so the
    // answer is shaped by what they actually show (W2-F1c):
    const attachments = await this.api.getPrAttachments(id);
    //   a merged attachment ⇒ positive proof: the wave's real done signal.
    const merged = attachments.find((a) => a.merged);
    if (merged) return { state: 'merged', prUrl: merged.url };
    //   no attachment at all ⇒ NO evidence either way. Not a rejection — the
    //   issue may have been closed by hand, as a duplicate, via a foreign-id
    //   mention, or on a workspace with no GitHub integration installed.
    //   Reporting `closed-unmerged` here would flag a legitimate close as a
    //   rejected PR (the live w2/w3 defect).
    if (attachments.length === 0) return { state: 'closed-unknown' };
    //   an attachment exists but none merged ⇒ positive proof a linked PR did
    //   not merge: a genuinely rejected PR.
    return { state: 'closed-unmerged' };
  }

  async listOpen(_scope: ListScope): Promise<IssueView[]> {
    // open (listOpenIssues excludes completed/canceled) ∧ eligible ∧ available
    // (available already excludes needs-attention + the claim states).
    return this.scan(
      (issue) =>
        this.isEligible(issue.labels) && this.deriveStatus(issue) === 'available',
    );
  }

  async listClaimed(): Promise<IssueView[]> {
    return this.scan((issue) => this.rungOf(issue.stateName) !== null);
  }

  // ── Document facet (ADR-0017): a PRD is a NATIVE Linear Document, not an issue ──
  async publishDocument(input: PublishDocumentInput): Promise<string> {
    const parts: string[] = [];
    for (const s of input.bodySections) {
      parts.push(`## ${s.heading}`, '', s.markdown.trimEnd(), '');
    }
    const content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    // A native Document — categorically NOT an issue, so it never enters listOpen
    // (it lives in a separate substrate the issue scan cannot see, ADR-0017).
    const { id } = await this.api.createDocument({ title: input.title, content });
    return id; // filingHint ignored — id is the opaque Document id (ADR-0001)
  }

  async readDocument(id: string): Promise<DocumentView> {
    const doc = await this.api.getDocument(id); // throws on unknown id
    return { id: doc.id, title: doc.title, body: doc.content };
  }

  async listDocuments(): Promise<DocumentView[]> {
    const docs = await this.api.listDocuments();
    return docs.map((d) => ({ id: d.id, title: d.title, body: d.content }));
  }

  /**
   * Shared open-issue scan; `keep` selects, malformed descriptions are
   * skipped.
   *
   * Unions each KEPT issue's native blocked-by relation into its `blockedBy`
   * (#654), the same {@link unionBlockedBy} layer `read()` applies — so
   * `listOpen`/`listClaimed` agree with `read()` (and the goal frontier) on
   * every edge, codec or native, instead of the codec-only view this scan
   * used to return. One extra `getBlockedBy` call per KEPT issue, read
   * SEQUENTIALLY — a `for…of` with `await` inside, never `Promise.all` — the
   * accepted cost, decided at sharpening rather than left as a documented
   * asymmetry (mirrors the GitHub port's own `scan()`, #654). A failed native
   * read (or a garbled description) drops just that ONE issue from the
   * result rather than aborting the whole scan.
   */
  private async scan(keep: (issue: LinearIssue) => boolean): Promise<IssueView[]> {
    const open = await this.api.listOpenIssues();
    const out: IssueView[] = [];
    for (const issue of open) {
      if (!keep(issue)) continue;
      try {
        const view = this.project(issue.identifier, issue);
        out.push({
          ...view,
          blockedBy: await this.unionBlockedBy(issue.identifier, view.blockedBy),
        });
      } catch {
        // a human-garbled description throws in project(), or unionBlockedBy's
        // native read fails (transient) — either way, skip this one issue
        // rather than aborting the whole scan.
      }
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * `blockedBy` here is codec-only — parsed straight off the description,
   * nothing more. The native union is layered on top by every CALLER of
   * `project()`: `read()` applies {@link unionBlockedBy} directly, and
   * `listOpen`/`listClaimed` apply the SAME union inside {@link scan}, so
   * every read surface this store exposes agrees on `blockedBy` (#654 — they
   * used to diverge, with `scan()` skipping the union to save a
   * `getBlockedBy` call per scanned issue; see {@link scan}'s own doc for the
   * cost that saving no longer buys).
   */
  private project(id: string, issue: LinearIssue): IssueView {
    const parsed = parseBody(issue.description);
    const risk = soleLabelValue(issue.labels, 'risk', id);
    const worker = soleLabelValue(issue.labels, 'worker', id);

    return {
      id,
      risk,
      worker,
      files: parsed.files,
      blockedBy: parsed.blockedBy,
      ...(parsed.unblocks !== undefined ? { unblocks: parsed.unblocks } : {}),
      ...(parsed.parent !== undefined ? { parent: parsed.parent } : {}),
      acceptanceCriteria: parsed.acceptanceCriteria,
      status: this.deriveStatus(issue),
      ...(parsed.closedBy !== undefined ? { closedBy: parsed.closedBy } : {}),
      ...(parsed.estimatedWallclock !== undefined
        ? { estimatedWallclock: parsed.estimatedWallclock }
        : {}),
      // The tracker's OWN last-write instant (`updatedAt`), not anything the
      // body codec could carry — it is API metadata and survives no round-trip
      // through the description. Passed through as-is; an absent `updatedAt`
      // stays absent, which the DoR staleness advisory reads as `'deferred'`
      // rather than as "nothing moved".
      ...(issue.updatedAt !== undefined ? { trackerUpdatedAt: issue.updatedAt } : {}),
    };
  }

  private deriveStatus(issue: LinearIssue): CoarseState {
    // Any terminal state category is the `done` bookend FIRST (ADR-0020, matching
    // GitHubIssuesStore + MarkdownFsStore's precedence, 3-store majority, final
    // review): closed wins over the flag in the coarse projection — a merged
    // (or otherwise terminally-closed) issue reads `done` even if it still
    // carries a stale `wave/needs-attention` label from before it closed. The
    // collapse of `canceled` into `done` is deliberately lossy (ADR-0002), the
    // same as GitHub's not_planned → done; a closed issue is absent from
    // listOpen anyway. The flag stays human-visible (label + comment payload)
    // even once superseded here — this carve-out only affects the derived
    // coarse `status`, never the flag's own presence/clearFlag lifecycle.
    if (CLOSED_TYPES.has(issue.stateType)) return 'done';
    // needs-attention (ADR-0006) is orthogonal to the claim and otherwise takes
    // precedence over the wave/<rung> claim state in the coarse projection (a
    // flag CANNOT be a workflow state).
    if (issue.labels.includes(NEEDS_ATTENTION_LABEL)) return 'needs-attention';
    const rung = this.rungOf(issue.stateName);
    return rung ?? 'available';
  }

  /** The claim rung whose mapped state NAME equals `stateName` (precedence-ordered), else null. */
  private rungOf(stateName: string): ClaimRung | null {
    for (const rung of RUNG_PRECEDENCE) {
      if (stateName === this.stateNameForRung(rung)) return rung;
    }
    return null;
  }

  private stateNameForRung(rung: ClaimRung): string {
    switch (rung) {
      case 'queued':
        return this.states.queued;
      case 'in-flight':
        return this.states.inFlight;
      case 'in-review':
        return this.states.inReview;
    }
  }

  private isEligible(labels: string[]): boolean {
    return labels.some((l) => this.eligibility.includes(l));
  }

  // ── Triage facet (ADR-0015/0020) — vocabulary stays LABELS, GitHub parity ──
  async readTriage(id: string): Promise<TriageView> {
    const issue = await this.api.getIssue(id); // throws on unknown id
    const state = this.triageSchema.states.find((s) => issue.labels.includes(s));
    const category = this.triageSchema.categories.find((c) =>
      issue.labels.includes(this.categoryLabel(c)),
    );
    const comments = (await this.api.getComments(id)).map((c) => ({ body: c.body }));
    return {
      id,
      title: issue.title,
      body: issue.description,
      ...(state !== undefined ? { state } : {}),
      ...(category !== undefined ? { category } : {}),
      comments,
    };
  }

  async applyTriage(id: string, input: ApplyTriageInput): Promise<void> {
    const issue = await this.api.getIssue(id); // existence check / throw
    // validate ALL supplied vocab first — no partial application.
    if (input.state !== undefined && !this.triageSchema.states.includes(input.state)) {
      throw new Error(
        `"${input.state}" is not a valid triage state. Expected one of: ${this.triageSchema.states.join(' | ')}.`,
      );
    }
    if (input.category !== undefined && !this.triageSchema.categories.includes(input.category)) {
      throw new Error(
        `"${input.category}" is not a valid triage category. Expected one of: ${this.triageSchema.categories.join(' | ')}.`,
      );
    }
    if (input.state !== undefined) {
      await this.swapAmongSet(id, issue.labels, this.triageSchema.states, input.state);
    }
    if (input.category !== undefined) {
      // Categories may map to existing consumer labels (`categoryLabels`, ADR-0020):
      // swap among the NATIVE label names, not the schema names.
      await this.swapAmongSet(
        id,
        issue.labels,
        this.triageSchema.categories.map((c) => this.categoryLabel(c)),
        this.categoryLabel(input.category),
      );
    }
    if (input.comment !== undefined) {
      await this.api.addComment(id, withTriageDisclaimer(input.comment));
    }
    // Best-effort cosmetic inbox clear (ADR-0020): a triaged issue shouldn't
    // linger in the native `Triage` inbox column once an agent has looked at
    // it — nudge it out to the unclaim/backlog target. Cosmetic only (the
    // LOAD-BEARING triage state is the label vocab above, untouched here), so
    // failures are swallowed (ADR-0004 class) rather than surfaced.
    if (issue.stateType === 'triage') {
      try {
        await this.api.setState(id, this.states.unclaimTarget);
      } catch {
        // swallow — cosmetic best-effort only.
      }
    }
  }

  async closeUnplanned(id: string, comment: string): Promise<void> {
    // Apply the schema's unplanned triage LABEL + comment, then natively close by
    // moving to the `Canceled` workflow STATE — Linear's `not_planned` (ADR-0020).
    await this.applyTriage(id, { state: this.triageSchema.unplannedState, comment });
    await this.api.setState(id, this.states.unplanned);
  }

  /** The native label name for a schema category (mapped via `categoryLabels`, else verbatim). */
  private categoryLabel(category: string): string {
    return this.categoryLabels[category] ?? category;
  }

  /** Remove every label in `set` except `target`, then add `target` (idempotent). */
  private async swapAmongSet(
    id: string,
    labels: string[],
    set: readonly string[],
    target: string,
  ): Promise<void> {
    for (const member of set) {
      if (member !== target && labels.includes(member)) {
        await this.api.removeLabel(id, member);
      }
    }
    await this.api.addLabel(id, target);
  }

  // ── Goal facet — a Goal is a Linear PROJECT (ADR-0044) or, under an
  //    `initiative` binding, a Linear INITIATIVE whose members are PROJECTS
  //    (ADR-0045) ──────────────────────────────────────────────────────────
  //
  // Every verb below resolves the role first and then branches on the MEMBER
  // KIND that role implies. The branch is deliberately explicit at each verb
  // rather than hidden behind a per-role strategy object: there are exactly two
  // arms, they read differently at every step (an issue's claim is a workflow
  // state; a project's is a status category plus what is inside it), and a
  // reader who opens `readGoalFrontier` should see both without chasing a
  // dispatch table.

  /**
   * Resolve the container role this call addresses, or refuse loudly. Runs as
   * the FIRST statement of every goal verb — before any id resolves and before
   * any write — so a refused binding does nothing.
   *
   * `fallback: undefined` is the whole Linear decision in one argument: this
   * store has NO default, so an unbound goal verb throws
   * {@link GoalBindingError} naming `store.goal.container`.
   */
  private goalRole(container: GoalContainer | undefined): GoalContainer {
    return requireGoalContainer({
      storeKind: 'linear',
      configured: container,
      fallback: undefined,
      realizable: GOAL_CONTAINERS_REALIZED,
    });
  }

  /**
   * Is this id in THIS store's ISSUE space? The adapter-owned half of the
   * id-kind rule (ADR-0045 decision 3) — the shared refusal lives in
   * {@link requireGoalMemberKind}, and only the adapter can answer the shape
   * question, because only it knows its own id format (ADR-0001).
   *
   * A Linear issue id is `<TEAM>-<n>` and a project/initiative id is a UUID, so
   * the two spaces are genuinely distinguishable here — unlike GitHub, where a
   * milestone number and an issue number are the same three bytes.
   *
   * **Deliberately TIGHTER than {@link parseRef}'s `/^(.+)-(\d+)$/`, and this
   * is a fix rather than a style choice.** That pattern is greedy and matches a
   * UUID whose final group happens to be all digits —
   * `550e8400-e29b-41d4-a716-446655440000` splits as
   * `550e8400-e29b-41d4-a716` + `446655440000` — so reusing it here would have
   * REFUSED a perfectly legitimate project id, at random, depending on the last
   * twelve characters a server handed out. The conformance suite surfaced the
   * same collision on the fake's own `prj-1` ids before any live call could.
   *
   * Requiring an UPPERCASE team key and exactly one hyphen excludes both: a
   * Linear team key is uppercase (`ENG-123`), and a UUID is lowercase hex in
   * five hyphen-separated groups. The two directions of error are not
   * symmetric, which is why the tight side is the right side: a false POSITIVE
   * blocks a valid join with a confident, wrong explanation, while a false
   * NEGATIVE merely lets the call reach the api, which throws "project not
   * found" — still loud, just less well-taught.
   *
   * `parseRef` is untouched: it inverts ids this store itself minted, which is a
   * different question with a different tolerance.
   */
  private isIssueShapedId(id: string): boolean {
    return /^[A-Z][A-Z0-9]*-\d+$/.test(id);
  }

  async createGoal(input: CreateGoalInput, container?: GoalContainer): Promise<string> {
    const role = this.goalRole(container);
    if (role === 'initiative') {
      const { id } = await this.api.createInitiative({
        name: input.title,
        description: input.description ?? '',
      });
      return id; // filingHint ignored — the id is the opaque initiative id (ADR-0001)
    }
    const { id } = await this.api.createProject({
      name: input.title,
      description: input.description ?? '',
    });
    return id; // filingHint ignored — the id is the opaque project id (ADR-0001)
  }

  async readGoal(id: string, container?: GoalContainer): Promise<GoalView> {
    const role = this.goalRole(container);
    if (role === 'initiative') {
      const initiative = await this.api.getInitiative(id); // throws on unknown id
      // DIRECT member projects — never the issues inside them (ADR-0045
      // decision 1). Empty member projects are included, which is the whole
      // point: they are exactly the members a flattening read would erase.
      const members = await this.api.listInitiativeProjects(id);
      return {
        id,
        title: initiative.name,
        description: initiative.description,
        container: role,
        memberIds: members.map((m) => m.id),
      };
    }
    const project = await this.api.getProject(id); // throws on unknown id
    const members = await this.api.listProjectIssues(id);
    return {
      id,
      title: project.name,
      description: project.description,
      container: role,
      memberIds: members.map((m) => m.identifier),
    };
  }

  /**
   * Every goal container this store can see in the bound role, each with its
   * curated membership. One member-list read per container — the same
   * deliberate acceptance the GitHub arm records: an empty `memberIds` would
   * mean "not fetched", and absent-vs-empty is a distinction this codebase
   * refuses to blur.
   *
   * **Scope diverges by role, deliberately and documented** (ADR-0045
   * decision 5): projects are listed in this api's TEAM scope, initiatives
   * WORKSPACE-wide. Initiatives live above teams — the recorded consumer's own
   * initiatives span Design and Dev — so a team filter would silently hide
   * cross-team finish lines. The extra width costs nothing, because `listGoals`
   * is sight and never the wave candidate set.
   */
  async listGoals(container?: GoalContainer): Promise<GoalView[]> {
    const role = this.goalRole(container);
    const out: GoalView[] = [];
    if (role === 'initiative') {
      for (const initiative of await this.api.listInitiatives()) {
        const members = await this.api.listInitiativeProjects(initiative.id);
        out.push({
          id: initiative.id,
          title: initiative.name,
          description: initiative.description,
          container: role,
          memberIds: members.map((m) => m.id),
        });
      }
      return out;
    }
    for (const project of await this.api.listProjects()) {
      const members = await this.api.listProjectIssues(project.id);
      out.push({
        id: project.id,
        title: project.name,
        description: project.description,
        container: role,
        memberIds: members.map((m) => m.identifier),
      });
    }
    return out;
  }

  async assignToGoal(
    goalId: string,
    memberId: string,
    container?: GoalContainer,
  ): Promise<void> {
    const role = this.goalRole(container);
    // The id-kind gate, BEFORE any write (ADR-0045 decision 3). It fires only
    // where the binding's members are projects; under `project` this is a no-op
    // and the arm below is byte-identical to what ADR-0044 shipped.
    requireGoalMemberKind({
      storeKind: 'linear',
      container: role,
      memberId,
      isIssueShaped: (id) => this.isIssueShapedId(id),
    });
    if (role === 'initiative') {
      // Idempotence is bought explicitly here: the membership is a join ENTITY
      // (`InitiativeToProject`), so a repeat call would mint a second row
      // without the api's find-before-create.
      await this.api.addProjectToInitiative(goalId, memberId);
      return;
    }
    // Idempotent by nature: the membership is a single pointer on the issue, so
    // re-joining writes the same value. Additive only — no un-assign path.
    await this.api.setIssueProject(memberId, goalId);
  }

  /**
   * Mint a bare direct member and join it, in one act (ADR-0045 decision 3).
   *
   * Ordering is the whole contract here, and it runs in exactly this sequence:
   * resolve the binding → resolve the GOAL (so an unknown goal mints nothing) →
   * mint → join → draw the declared edges. A failure after the mint is reported
   * with the minted id attached rather than rolled back.
   */
  async createGoalMember(
    goalId: string,
    input: CreateGoalMemberInput,
    container?: GoalContainer,
  ): Promise<string> {
    const role = this.goalRole(container);
    const blockedBy = input.blockedBy ?? [];

    if (goalMemberKind(role) === 'issue') {
      // Pre-validate the goal BEFORE the mint — otherwise a typo'd goal id
      // would file a real issue nobody asked for and then fail.
      await this.api.getProject(goalId);
      // The declared edges become `IssueRef`s so the shipped bare arm realizes
      // them exactly as `create()` always has — same native relations, same
      // best-effort mirror, no second code path.
      const memberId = await this.create({
        title: input.title,
        filingHint: input.filingHint,
        bodySections: input.bodySections,
        ...(blockedBy.length > 0
          ? { blockedBy: blockedBy.map((id) => this.parseRef(id)) }
          : {}),
      });
      try {
        await this.api.setIssueProject(memberId, goalId);
      } catch (err) {
        throw joinFailed('membership', goalId, memberId, err, 'issue');
      }
      return memberId;
    }

    // ── the initiative arm: a PROJECT member ────────────────────────────────
    await this.api.getInitiative(goalId); // pre-validation, before any mint
    // Every declared blocker must resolve BEFORE the mint too, so an
    // unresolvable edge cannot leave a minted project behind. `getProject`
    // throws on an unknown id — the same "refuse before any write" property the
    // bare-issue arm gets from `classifyCreateInput`.
    for (const blockerId of blockedBy) await this.api.getProject(blockerId);

    const { id: memberId } = await this.api.createProject({
      name: input.title,
      // A project's description is its only prose surface, so the authored
      // sections are woven into it — the same bytes `serializeBareBody`
      // produces for an issue member, and nothing else. A project born this way
      // carries no eligibility semantics at all (ADR-0045 decision 3), so there
      // is no bare invariant to protect the way there is for an issue.
      description: serializeBareBody(input.bodySections),
    });
    try {
      await this.api.addProjectToInitiative(goalId, memberId);
    } catch (err) {
      throw joinFailed('membership', goalId, memberId, err, 'project');
    }
    for (const blockerId of blockedBy) {
      try {
        await this.api.addProjectBlockedBy(memberId, blockerId);
      } catch (err) {
        // NOT best-effort, deliberately — unlike the issue mirror, whose edge is
        // already recorded authoritatively in the body codec. A project relation
        // is the ONLY representation this dependency has, so swallowing the
        // failure would silently drop the edge that is the feature.
        throw joinFailed('blocked-by', goalId, memberId, err, 'project');
      }
    }
    return memberId;
  }

  async readGoalFrontier(
    goalId: string,
    container?: GoalContainer,
  ): Promise<GoalFrontier> {
    const role = this.goalRole(container);
    const facts: GoalMemberFacts[] = [];
    if (role === 'initiative') {
      // throws on an unknown goal id
      for (const project of await this.api.listInitiativeProjects(goalId)) {
        facts.push(await this.goalProjectMemberFacts(project));
      }
      return computeGoalFrontier(goalId, facts);
    }
    const members = await this.api.listProjectIssues(goalId); // throws on unknown goal id
    for (const issue of members) facts.push(await this.goalMemberFacts(issue));
    return computeGoalFrontier(goalId, facts);
  }

  /**
   * The mirror pass (ADR-0046) — publish this goal's derived accounting to its
   * container's native update surface.
   *
   * **The frontier is derived HERE, inside the write.** `readGoalFrontier` is
   * called on this same store, at this moment, and its result is the only source
   * the anchor is rendered from. Nothing about the report reaches this method from
   * the caller: {@link PublishGoalUpdateInput} carries prose and a transcribed
   * health and has no field for a frontier, a member list or a body. So a caller
   * cannot supply the anchor, cannot edit it, and cannot omit it — which is the
   * entire guarantee the pass exists for.
   *
   * The identities are gathered from the SAME native nodes the derivation reads,
   * for display only (a name, and the tracker's own link). They cannot change a
   * reading — {@link renderGoalUpdateBody} joins them by id and falls back to the
   * opaque id when one is missing, so a store that could not name a member
   * publishes a less readable anchor rather than an incomplete one.
   *
   * Health is `input.health` or nothing — where "nothing" includes the empty
   * string, which is the transport's own rule read back up to this gate so the
   * receipt cannot claim a health the wire dropped. There is no branch below that
   * can put a value there, and deliberately no read of the container's own health
   * to fall back on: that value is the vendor's roll-up of the most recent update,
   * which is what this pass is about to write, so falling back to it would publish
   * this station's previous output as if it were a fresh human judgment.
   */
  async publishGoalUpdate(
    goalId: string,
    input: PublishGoalUpdateInput = {},
    container?: GoalContainer,
  ): Promise<GoalUpdateReceipt> {
    const role = this.goalRole(container);
    // Resolve the goal FIRST, so an unknown id fails as "no such goal" before any
    // derivation work — and long before any write.
    const goal = await this.readGoal(goalId, role);
    // ── The safety property, in one statement: derived fresh, right here. ─────
    const frontier = await this.readGoalFrontier(goalId, role);
    const identities = await this.goalMemberIdentities(goalId, role);
    const body = renderGoalUpdateBody({
      goalName: goal.title,
      frontier,
      identities,
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
      ...(input.operatorNote !== undefined ? { operatorNote: input.operatorNote } : {}),
    });
    // The caller's health or NONE — an absent key all the way to the wire, and
    // the SAME key in the receipt, because the receipt's contract is that it
    // reports what this engine SENT.
    //
    // The empty string is absence, and that term is load-bearing rather than
    // defensive. `''` is not a member of the vendor's health enum, so the real
    // transport's `healthIfSupplied` (real-linear-api.ts) already drops it at the
    // wire — a gate on `!== undefined` alone therefore spread `''` into a receipt
    // claiming a health that was never sent. One rule, applied at all three sites
    // the value passes through: this gate, the transport, and the in-memory fake
    // that stands in for it.
    const health =
      typeof input.health === 'string' && input.health !== '' ? { health: input.health } : {};
    const result =
      role === 'initiative'
        ? await this.api.createInitiativeUpdate({ initiativeId: goalId, body, ...health })
        : await this.api.createProjectUpdate({ projectId: goalId, body, ...health });
    return {
      goalId,
      container: role,
      updateId: result.id,
      ...(result.url !== undefined ? { url: result.url } : {}),
      body,
      ...health,
      frontier,
    };
  }

  /**
   * The members' DISPLAY identities — name, and the tracker's own link where one
   * exists.
   *
   * Read from the same connections the frontier derivation reads, so the anchor
   * names exactly the members it counts. A project member has a real
   * `Project.url`; an issue member is named by its human identifier (`EX-16`),
   * which is what a reader of a Linear project update already recognizes, and no
   * URL is fabricated for it — the seam does not carry one, and composing one from
   * a workspace slug would be inventing a value the vendor never stated.
   */
  private async goalMemberIdentities(
    goalId: string,
    role: GoalContainer,
  ): Promise<GoalUpdateMemberIdentity[]> {
    if (role === 'initiative') {
      return (await this.api.listInitiativeProjects(goalId)).map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.url !== undefined ? { url: p.url } : {}),
      }));
    }
    return (await this.api.listProjectIssues(goalId)).map((i) => ({
      id: i.identifier,
      name: `${i.identifier} — ${i.title}`,
    }));
  }

  /**
   * What this store can SEE about one PROJECT goal member — the per-kind half of
   * ADR-0045 decision 2, mapped onto the SAME four facts the issue arm states.
   *
   * Each mapping and why it is the honest one:
   *
   *  - `closed` ← the project's own `completed`/`canceled` status category. The
   *    exact mirror of an issue's terminal state category, and the same lossy
   *    collapse ADR-0002 already sanctions.
   *  - `claimed` ← `started`/`paused`, OR at least one wave-claimed OPEN issue
   *    inside. Two sources because a member can be in motion two ways: a human
   *    moved the project, or a wave drew a row out of it. `paused` reads
   *    in-motion rather than blocked because `blocked` asserts a NAMED
   *    unresolved dependency, which paused lacks — and the reading now CARRIES
   *    `nativeState`, so "a person parked it" and "a wave is working inside it"
   *    are distinguishable at the far end instead of collapsing into one word.
   *  - `eligible` ← at least one OPEN issue inside carrying the eligibility
   *    marker. This is what makes `actionable` mean literally "a wave could draw
   *    here now": an EMPTY project has no such issue and reads `unready`, which
   *    is the reading the live consumer's 13-of-19 empty member projects need,
   *    and an all-untriaged story reads `unready` too (sharpen first).
   *  - `unresolvedBlockers` ← native project relations whose other side is not
   *    closed, named as bare project ids ({@link GoalBlocker}).
   *
   * …and a FIFTH value that is stated rather than mapped: `nativeState` ← the
   * project's own status category, verbatim. This is the ONE binding of the four
   * that has such a value at all, because it is the only one whose members are
   * themselves containers, and it is exactly the value the four booleans above
   * are lossy about — three different native situations (`started`, `paused`,
   * and a `backlog`/`planned` project with a wave-claimed issue inside) all
   * arrive at `in-motion`, and `completed`/`canceled` both arrive at `done`.
   * Reporting the category alongside the facts costs no extra read (it is
   * already on the node this method was handed) and retires the static mapping a
   * caller previously had to render in its place.
   *
   * **Reported from the vendor's own word, NOT from the classification
   * substrate** — the one place those two pull apart. `statusType` is allowed to
   * be a substitute: an adapter that meets a category outside the six narrows it
   * to `backlog`, which is right for classification (an unreadable category must
   * read `unready`, never `done` and never `actionable`) and wrong the moment it
   * is REPORTED, because a seventh vendor category would then reach a consumer
   * as `backlog` — a native fact the vendor never stated, surfaced through the
   * very field added to make native facts honest. So the two readings are taken
   * from two places: the booleans above keep reading `statusType`, while
   * `nativeState` reads {@link LinearProject.unreadStatusType} first and states
   * either the vendor's actual word or NOTHING. Absence here is honest in the
   * same way the issue arm's absence is: no category was stated, so none is
   * reported — a substituted one would be an invention.
   *
   * **The member's own HEALTH is now stated here — this is where the producer
   * the frontier row left unbuilt actually lands (ADR-0046).** `LinearProject`
   * carries a `health` since the mirror-pass slice widened the seam, so the value
   * travels: read on the node this method was handed, carried verbatim, and
   * ABSENT when the project has none.
   *
   * **What that value IS, stated precisely, because the obvious description is
   * wrong.** Linear documents `Project.health` as "derived from the most recent
   * project update … Null if no health has been reported" — so it is a ROLL-UP of
   * the latest update's health, not a field a person sets on the project node. It
   * is still human-AUTHORED (someone chose it when posting that update), which is
   * what makes transporting it honest; it is simply authored one node over. The
   * documented NULL is the case that matters here and it arrives as an absent KEY,
   * never as a coalesced word — see the conditional spread below, which has no
   * `??` and must never grow one. A `blocked` member with no reported health
   * reports NO health, not `atRisk`.
   *
   * Closed short-circuits everything below it, exactly as the issue arm does: a
   * finished member is `done` whatever else is true of it, so its issues and its
   * relations are not read at all — but the native category still travels, since
   * "which terminal category" is precisely what `done` cannot say.
   */
  private async goalProjectMemberFacts(project: LinearProject): Promise<GoalMemberFacts> {
    const id = project.id;
    // `undefined` — the ordinary case — means the narrowing never substituted,
    // so `statusType` IS what the vendor said and can be reported as-is.
    // Anything else means it is a SUBSTITUTE, and the honest native state is
    // what the vendor actually said (a category this adapter does not know,
    // carried verbatim: `GoalMemberNativeState` is opaque by design and compares
    // it against nothing) — or, for `null`, no native state at all, because the
    // response stated no category and there is nothing honest to report.
    //
    // A conditional spread rather than `nativeState: x`, for the reason the
    // frontier uses one: an absent fact must be an absent KEY, so "the vendor
    // stated nothing" is written the same way the three issue-direct bindings
    // write it, and never as a placeholder.
    const nativeState =
      project.unreadStatusType === undefined
        ? project.statusType
        : (project.unreadStatusType ?? undefined);
    // TRANSPORT, never derivation: the vendor's roll-up value or nothing. No
    // `??`, no mapping from a status category, no fallback of any kind — a health
    // this store authored would be a fabricated human judgment.
    const stated = {
      ...(nativeState !== undefined ? { nativeState } : {}),
      ...(project.health !== undefined ? { health: project.health } : {}),
    };
    if (CLOSED_PROJECT_STATUS.has(project.statusType)) {
      return {
        id,
        closed: true,
        claimed: false,
        eligible: false,
        unresolvedBlockers: [],
        ...stated,
      };
    }
    const issues = await this.api.listProjectIssues(id);
    const open = issues.filter((i) => !CLOSED_TYPES.has(i.stateType));
    const claimedInside = open.some(
      (i) => this.rungOf(i.stateName) !== null || i.labels.includes(NEEDS_ATTENTION_LABEL),
    );
    return {
      id,
      closed: false,
      claimed: CLAIMED_PROJECT_STATUS.has(project.statusType) || claimedInside,
      eligible: open.some((i) => this.isEligible(i.labels)),
      unresolvedBlockers: await this.unresolvedProjectBlockers(id),
      ...stated,
    };
  }

  /**
   * Which of a project member's native relations are still in the way.
   *
   * A blocker counts as UNRESOLVED unless this store positively read it into a
   * closed status category — and a relation whose other side cannot be read at
   * all (deleted, or a transport refusal) lands there too. `actionable` is a
   * positive claim that nothing blocks the member, so an unreadable edge must
   * never counterfeit one: the same `closed-unknown` evidence discipline the
   * issue arm applies, one member kind over.
   *
   * A failure of the RELATION read itself is not swallowed into "no blockers"
   * for the same reason — it propagates, so the frontier reports an error
   * rather than a clean bill of health it cannot back.
   */
  private async unresolvedProjectBlockers(projectId: string): Promise<GoalBlocker[]> {
    const out: GoalBlocker[] = [];
    for (const blockerId of await this.api.getProjectBlockedBy(projectId)) {
      try {
        const blocker = await this.api.getProject(blockerId);
        if (!CLOSED_PROJECT_STATUS.has(blocker.statusType)) out.push(blockerId);
      } catch {
        out.push(blockerId); // unreadable ⇒ unresolved, never silently cleared
      }
    }
    return out;
  }

  /**
   * What this store can SEE about one goal member.
   *
   * Read off the raw `LinearIssue` rather than through `read()`, for the reason
   * the GitHub arm records: `read()` projects an `IssueView` and THROWS on a
   * bare member (no `## Files` section), and a bare member is exactly what the
   * `goal` station files at a cut — so going through `read()` would make a fresh
   * goal unreadable, while going around it makes `unready` observable.
   *
   * Neither `nativeState` nor `health` is stated here, and both omissions are
   * deliberate. This is an ISSUE-direct binding: an issue's workflow state is
   * already fully spent on `closed` and `claimed` above (that is what
   * {@link rungOf} and {@link CLOSED_TYPES} consume it for), so re-reporting it
   * as a "native state" would re-spell two booleans rather than add the fact the
   * frontier is lossy about — and a Linear issue carries no health at all. The
   * field stays ABSENT rather than being filled with the state name, an empty
   * string, or any other placeholder: a caller distinguishes "this binding has
   * no such value" from "this member is in an unnamed state" only if absence
   * means absence.
   */
  private async goalMemberFacts(issue: LinearIssue): Promise<GoalMemberFacts> {
    const closed = CLOSED_TYPES.has(issue.stateType);
    const id = issue.identifier;
    // A closed member is `done` whatever else is true of it — no blocker read.
    if (closed) {
      return { id, closed: true, claimed: false, eligible: false, unresolvedBlockers: [] };
    }
    // The codec sees blockers only on a DECORATED member; a bare one has no
    // `## Blocked by` section and `parseBody` throws. That throw IS the bare
    // case, so it degrades to "no codec refs" while the native side below still
    // carries the ADR-0044 bare arm's relations.
    let codec: BlockedBy = 'none';
    try {
      codec = parseBody(issue.description).blockedBy;
    } catch {
      codec = 'none';
    }
    const union = await this.unionBlockedBy(id, codec);
    return {
      id,
      closed: false,
      claimed:
        this.rungOf(issue.stateName) !== null ||
        issue.labels.includes(NEEDS_ATTENTION_LABEL),
      eligible: this.isEligible(issue.labels),
      unresolvedBlockers: await this.unresolvedBlockers(id, union),
    };
  }

  /**
   * Which of a member's read-union blockers are still in the way.
   *
   * A blocker counts as UNRESOLVED unless this store positively read it into a
   * closed state category. A ref whose read THROWS (deleted, a cross-team
   * identifier this workspace cannot reach, a transport refusal) lands there
   * too: `actionable` is a positive claim that nothing blocks the member, so an
   * unreadable edge must never be able to counterfeit one — the `closed-unknown`
   * evidence discipline (W2-F1c), applied to the frontier.
   *
   * Unlike the GitHub arm there is no up-front cross-repo refusal, and the
   * asymmetry is the same one the bare `blockedBy` mirror already carries: a
   * Linear identifier names its own team, so `refToIdentifier` resolves a
   * cross-TEAM ref as readily as a same-team one and the reach question is
   * settled by the read, not by the ref's shape.
   */
  private async unresolvedBlockers(id: string, blockedBy: BlockedBy): Promise<IssueRef[]> {
    if (blockedBy === 'none') return [];
    const ownSlug = this.parseRef(id).slug;
    const out: IssueRef[] = [];
    for (const ref of blockedBy) {
      try {
        const blocker = await this.api.getIssue(refToIdentifier(ref, ownSlug));
        if (!CLOSED_TYPES.has(blocker.stateType)) out.push(ref);
      } catch {
        out.push(ref); // unreadable ⇒ unresolved, never silently cleared
      }
    }
    return out;
  }
}

/**
 * Build the {@link GoalMemberJoinError} for a `createGoalMember` whose MINT
 * landed and whose follow-up write did not (ADR-0045 decision 3).
 *
 * The message's job is to make the residue actionable rather than merely
 * admitted: it names the member that exists, the goal it is missing from, and
 * the one hand-fix that closes the gap. Rolling the mint back was never an
 * option — this facet has no delete verb, and inventing one to paper over a
 * failed second write would be a far larger decision than the failure warrants.
 */
function joinFailed(
  stage: 'membership' | 'blocked-by',
  goalId: string,
  memberId: string,
  reason: unknown,
  kind: 'issue' | 'project',
): GoalMemberJoinError {
  const what =
    stage === 'membership'
      ? `joining it to the goal failed`
      : `drawing its declared blocked-by edge(s) failed`;
  const fix =
    stage === 'membership'
      ? `assignToGoal("${goalId}", "${memberId}")`
      : `redraw the dependency in the tracker, or re-run with the same blockers`;
  return new GoalMemberJoinError(
    stage,
    goalId,
    memberId,
    reason,
    `createGoalMember: the ${kind} "${memberId}" WAS created, but ${what} — ` +
      `${(reason as Error)?.message ?? String(reason)}. It is NOT rolled back ` +
      `(ADR-0045: residue is reported, never silently deleted), so "${memberId}" ` +
      `exists right now and is the thing to fix: ${fix}.`,
  );
}

/**
 * A short, human-readable attachment title for the closing-PR card (issue
 * #511): extracts a PR/MR number from the common host URL shapes (GitHub
 * `/pull/<n>`, Bitbucket `/pull-requests/<n>`, GitLab `/merge_requests/<n>`)
 * so the card reads e.g. "PR #130" instead of a bare URL. Falls back to a
 * generic label for any other host — `AttachmentCreateInput.title` is
 * required (`String!`), so a title is always produced.
 */
function closingAttachmentTitle(prUrl: string): string {
  const m = /\/(?:pull|pull-requests|merge_requests)\/(\d+)/.exec(prUrl);
  return m ? `PR #${m[1]}` : 'Closing PR';
}

/**
 * Render the LOUD advisory posted when the opt-in done-state fallback fires
 * (FOR-13) — the audit trail that distinguishes "the tracker's probe reads
 * open only because there is no integration to see the merge" from "this
 * issue is genuinely unmerged": if this comment is present, the wave itself
 * already confirmed `prUrl` merged; if it is absent, whatever `readClosing`
 * reports (open / closed-unmerged) is the real, unmediated signal.
 */
function renderDoneStateFallbackAdvisory(prUrl: string, doneState: string): string {
  const lines = [
    '<!-- wave-done-state-fallback -->',
    `⚠️ **Opt-in done-state fallback applied — moved to "${doneState}".**`,
    '',
    `The wave already confirmed the merged PR ${prUrl}, but this issue's own ` +
      'closing signal never caught up (most likely: no Linear↔GitHub ' +
      'integration in this workspace, so the tracker cannot see the merge on ' +
      'its own).',
    '',
    '**Derived done — via the tracker\'s own closing signal — is the preferred ' +
      'mode.** This transition was forced by the opt-in `doneState` fallback ' +
      'config instead; if this workspace gains the integration later, unset ' +
      'the mapping so `done` goes back to being fully derived.',
  ];
  return lines.join('\n');
}

/** Render the needs-attention payload as a structured, human-readable comment (ADR-0006). */
function renderNeedsAttentionComment(payload: NeedsAttentionPayload): string {
  const lines = [
    '<!-- wave-needs-attention -->',
    `**Needs attention (${payload.kind}):**`,
    '',
    payload.question,
    '',
    '**Options:**',
    ...payload.options.map((o) => `- ${o}`),
  ];
  return lines.join('\n');
}

/**
 * The sole `prefix/<value>` label. Fail-fast on zero (malformed — no partial
 * view) AND on multiple (ambiguous — a human/race added a second `risk/*`).
 */
function soleLabelValue(labels: string[], prefix: string, id: string): string {
  const hits = labels.filter((l) => l.startsWith(`${prefix}/`));
  if (hits.length === 0) throw new Error(`Issue ${id} has no ${prefix}/* label`);
  if (hits.length > 1) {
    throw new Error(
      `Issue ${id} has ${hits.length} ${prefix}/* labels (ambiguous): ${hits.join(', ')}`,
    );
  }
  return hits[0].slice(prefix.length + 1);
}

/**
 * Normalized ref identity for blockedBy dedup (ADR-0020 read-union) —
 * `slug#issue`. A slug-less ref (hand-written same-team shorthand) means the
 * REFERENCING issue's own team, so `ownSlug` — the caller's `parseRef(id).slug`
 * — is substituted for the key only; a native ref's own resolved slug always
 * wins over `ownSlug` when present (same precedent as `dor-gate.ts`'s
 * `checkBlockedByChain`: `const slug = ref.slug ?? ownSlug;`).
 */
function refKey(ref: IssueRef, ownSlug: string | undefined): string {
  return `${ref.slug ?? ownSlug ?? ''}#${ref.issue}`;
}

/**
 * A blockedBy `IssueRef` → the Linear identifier the native mirror resolves
 * (ADR-0020 write half). Inverse of {@link LinearIssuesStore.parseRef}: joins
 * with `-` (Linear's `<TEAM>-<number>` id form, NOT the codec's `slug#issue`
 * wire form). A slug-less same-team ref (`#16`, hand-written body shorthand)
 * means the referencing issue's own team, so `ownSlug` is substituted — the
 * same rule the read-union's dedup key uses.
 */
function refToIdentifier(ref: IssueRef, ownSlug: string | undefined): string {
  const slug = ref.slug ?? ownSlug;
  if (slug === undefined) {
    // Unreachable for a real Linear id (parseRef always yields a `<TEAM>-`
    // slug), but guard rather than mint a malformed `-16`: mirrorBlockedBy's
    // per-ref catch turns this into a non-fatal skip.
    throw new Error(`refToIdentifier: cannot resolve slug-less ref #${ref.issue} without an owning team slug.`);
  }
  return `${slug}-${ref.issue}`;
}
