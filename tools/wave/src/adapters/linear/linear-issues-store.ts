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
  validateAmendPatch,
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
  withTriageDisclaimer,
} from '../issue-store';
import type { LinearApi, LinearIssue } from './linear-api';
import {
  serializeBody,
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
    const description = serializeBody({
      files: input.files,
      blockedBy: input.blockedBy,
      ...(input.unblocks !== undefined ? { unblocks: input.unblocks } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      acceptanceCriteria: input.acceptanceCriteria,
      ...(input.estimatedWallclock !== undefined
        ? { estimatedWallclock: input.estimatedWallclock }
        : {}),
      ...(input.bodySections !== undefined
        ? { bodySections: input.bodySections }
        : {}),
    });
    const labels = [
      this.eligibility[0],
      `risk/${input.risk}`,
      `worker/${input.worker}`,
    ];
    const { identifier } = await this.api.createIssue({
      title: input.title,
      description,
      labels,
    });
    // Mirror the just-written body-codec blockedBy into NATIVE Linear relations
    // (ADR-0020 write half) so blocked rows carry a visible board relation, not
    // just a body line. Best-effort: the body-codec write above is the
    // authoritative one (ADR-0020), so a failed mirror never fails create().
    await this.mirrorBlockedBy(identifier, input.blockedBy);
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

  /** Shared open-issue scan; `keep` selects, malformed descriptions are skipped. */
  private async scan(keep: (issue: LinearIssue) => boolean): Promise<IssueView[]> {
    const open = await this.api.listOpenIssues();
    const out: IssueView[] = [];
    for (const issue of open) {
      if (!keep(issue)) continue;
      try {
        out.push(this.project(issue.identifier, issue));
      } catch {
        // a human-garbled description throws in project(); skip it rather than
        // aborting the whole scan (Linear descriptions are remotely editable).
      }
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * NOTE — deliberate read()/list asymmetry: `read()` layers `unionBlockedBy`
   * on top of this projection, so its `blockedBy` is codec ∪ native. Views
   * built directly from `project()` (i.e. `listOpen`/`listClaimed`, via
   * `scan()`) carry the codec-only `blockedBy` — no native union, since that
   * would mean one extra `getBlockedBy` call per scanned issue. A future
   * consumer that reasons about `blockedBy` across a list scan must not assume
   * the union holds there; only a single-issue `read()` guarantees it.
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
