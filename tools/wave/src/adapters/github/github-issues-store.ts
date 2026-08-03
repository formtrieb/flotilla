/**
 * github-issues-store.ts — the GitHub IssueStore (P3, the real divergence).
 *
 * Implements the same IssueStore contract as MarkdownFsStore and passes the
 * same conformance suite unchanged, talking only to the injected {@link GitHubApi}
 * seam (in-memory fake in tests; real `gh`/HTTP impl wired in P8). The GitHub
 * shape diverges sharply from markdown:
 *
 * - `risk`/`worker` are LABELS (`risk/<x>`, `worker/<x>`); `files`/`blockedBy`/
 *   `unblocks`/`acceptanceCriteria` are body `##` sections (ADR-0010 decorate).
 * - `status` is fully DERIVED (ADR-0005): never a written `available`/`done`
 *   label. flotilla writes ONLY the `wave/<rung>` claim labels.
 * - `close()` is no-op-or-reconcile: it records the closing PR + cosmetic AC
 *   tick but does NOT natively close (the merged PR's `Closes #N` does, out of
 *   band) and does NOT drop the `wave/in-review` claim — so the issue never
 *   flips back to `available` mid-merge (no double-dispatch).
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
import type { GitHubApi, GhIssue } from './github-api';
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
/** Orthogonal needs-attention label (ADR-0006) — NOT a wave/<rung> claim. */
const NEEDS_ATTENTION_LABEL = 'wave/needs-attention';
/** Identity label for a PRD document (ADR-0011) — never an eligibility token. */
const DEFAULT_DOCUMENT_LABEL = 'prd';

export interface GitHubIssuesStoreOptions {
  api: GitHubApi;
  eligibility?: readonly string[];
  /** The label marking an issue as a PRD document (default `prd`, ADR-0011). */
  documentLabel?: string;
  /** Triage vocabulary (default {@link DEFAULT_TRIAGE_SCHEMA}, ADR-0015). */
  triageSchema?: TriageSchema;
}

export class GitHubIssuesStore implements IssueStore {
  /** Exposed so the conformance hook can reach the injected fake (test seam). */
  readonly api: GitHubApi;
  private readonly eligibility: readonly string[];
  private readonly documentLabel: string;
  private readonly triageSchema: TriageSchema;

  constructor(opts: GitHubIssuesStoreOptions) {
    this.api = opts.api;
    this.eligibility = opts.eligibility ?? DEFAULT_ELIGIBILITY;
    this.documentLabel = opts.documentLabel ?? DEFAULT_DOCUMENT_LABEL;
    this.triageSchema = opts.triageSchema ?? DEFAULT_TRIAGE_SCHEMA;
  }

  async create(input: CreateInput): Promise<string> {
    // Whole-input validation FIRST (ADR-0027): a half-written Header-Block
    // throws before the createIssue call, so a rejected create files nothing.
    const shape = classifyCreateInput(input);

    if (shape.kind === 'bare') {
      // ADR-0027 bare filing: the free prose (gap description, provenance line)
      // and NOTHING else — no `## Files`/`## Blocked by`/`## Acceptance criteria`
      // sections, and NO labels at all: no eligibility token (so `listOpen`
      // never surfaces it) and no `risk/*`/`worker/*` stamp. `read()` on it
      // throws (parseBody finds no `## Files`), which is the honest outcome —
      // the wave fields are absent, not empty.
      const { number } = await this.api.createIssue({
        title: input.title,
        body: serializeBareBody(input.bodySections),
        labels: [],
      });
      return String(number);
    }

    const decorated = shape.input;
    const body = serializeBody({
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
    const { number } = await this.api.createIssue({
      title: decorated.title,
      body,
      labels,
    });
    // Mirror the just-written body-codec blockedBy into NATIVE GitHub issue
    // dependencies (ADR-0020's write half, ported) so a blocked row carries a
    // visible dependency on the issue itself, not just a body line. Best-effort:
    // the body-codec write above is the authoritative one, so a failed mirror
    // never fails create().
    await this.mirrorBlockedBy(number, decorated.blockedBy);
    return String(number); // filingHint ignored — id is the opaque issue number (ADR-0001)
  }

  // ── parseRef (opaque id → IssueRef inversion, ADR-0001) ───────────────────
  /** Invert a bare-number id into a slug-less `{issue}`; throws on a non-integer id. */
  parseRef(id: string): IssueRef {
    const issue = Number(id);
    if (!Number.isInteger(issue)) {
      throw new Error(`parseRef: GitHub id "${id}" is not an integer issue number.`);
    }
    return { issue };
  }

  async annotate(id: string, patch: AnnotatePatch): Promise<void> {
    const n = Number(id);
    const gh = await this.api.getIssue(n); // throws on unknown id

    // risk/worker → swap the sole risk/* | worker/* label (remove old, add new).
    if (patch.risk !== undefined) {
      await this.replaceLabel(n, gh.labels, 'risk', patch.risk);
    }
    if (patch.worker !== undefined) {
      await this.replaceLabel(n, gh.labels, 'worker', patch.worker);
    }

    // files/AC/bodySections → surgically rewrite the managed body region, so
    // unmodeled sections/lines (blockedBy, unblocks, wallclock, Closed-by, free
    // prose) are preserved (NOT a parseBody→serializeBody round-trip).
    let body = gh.body;
    if (patch.files !== undefined) {
      body = replaceSection(body, 'Files', patch.files.map((f) => `- ${f}`));
    }
    if (patch.acceptanceCriteria !== undefined) {
      body = replaceSection(
        body,
        'Acceptance criteria',
        patch.acceptanceCriteria.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}`),
      );
    }
    if (patch.bodySections !== undefined) {
      body = appendBodySections(body, patch.bodySections);
    }
    // parent → surgically upsert the `**Parent:**` line (the PRD's opaque id,
    // ADR-0013); `parentToLine` renders the `#<id>` that lights up GitHub's
    // cross-reference on the PRD.
    if (patch.parent !== undefined) {
      body = upsertLine(body, 'Parent', parentToLine(patch.parent));
    }
    if (body !== gh.body) await this.api.setBody(n, body);

    // Mirror the issue's CANONICAL body-codec blockedBy into native dependencies
    // (the write half). AnnotatePatch deliberately carries no `blockedBy`
    // (dependency structure is out-of-band — issue-store.ts; ADR-0025 keeps it
    // off the patch), and annotate never rewrites the Blocked-by section, so
    // this reconciles the native side against the EXISTING codec block: any
    // codec ref not yet natively represented is created, additively. It NEVER
    // deletes — a human-drawn or stale native dependency survives.
    //
    // Parse the UPDATED (post-patch) `body` local, not the stale `gh.body` read
    // at the top: on a genuine decorate-target the pre-patch body has no Files
    // section yet (that is exactly the write this call just performed), so
    // parsing the pre-patch value throws even though the write succeeded. The
    // parse must sit INSIDE this same try — a throw from parseBody in the
    // argument expression would happen BEFORE mirrorBlockedBy's own per-ref
    // catches and escape annotate() as an uncaught rejection after every write
    // had already landed (the FOR-77 shape the Linear port fixed).
    try {
      await this.mirrorBlockedBy(n, parseBody(body).blockedBy);
    } catch {
      // best-effort: the body-codec write above is authoritative and already
      // landed; a body that still fails to parse must not fail annotate().
    }
  }

  // ── amend (ADR-0025 — authored content: title + free-prose sections) ───────
  async amend(id: string, patch: AmendPatch): Promise<void> {
    validateAmendPatch(patch); // whole-patch validation before any write (empty / blank heading)
    const n = Number(id);
    const gh = await this.api.getIssue(n); // throws on unknown id

    // Transform the body IN MEMORY first: a reserved-heading section (upsertSection
    // throws, naming annotate) aborts here — before any setTitle/setBody write —
    // so a reserved collision never leaves a partially-amended issue.
    let body = gh.body;
    for (const s of patch.sections ?? []) {
      body = upsertSection(body, s.heading, s.markdown);
    }
    // Writes only after the whole patch validated (no reserved heading survived).
    if (patch.title !== undefined) await this.api.setTitle(n, patch.title);
    if (body !== gh.body) await this.api.setBody(n, body);
  }

  /** Swap the sole `prefix/*` label for `prefix/<value>` (idempotent). */
  private async replaceLabel(
    n: number,
    labels: string[],
    prefix: string,
    value: string,
  ): Promise<void> {
    for (const l of labels) {
      if (l.startsWith(`${prefix}/`) && l !== `${prefix}/${value}`) {
        await this.api.removeLabel(n, l);
      }
    }
    await this.api.addLabel(n, `${prefix}/${value}`);
  }

  async read(id: string): Promise<IssueView> {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error(`Malformed GitHub issue id: ${id}`);
    const gh = await this.api.getIssue(n);
    const view = this.project(id, gh);
    return { ...view, blockedBy: await this.unionBlockedBy(n, view.blockedBy) };
  }

  /**
   * Read-side union (ADR-0020's DoR-gate fix, ported to GitHub's native
   * issue-dependencies API): the body-codec `blockedBy` cannot see a native
   * blocked-by dependency the consumer already maintains on the issue, and
   * without this union the DoR gate would dispatch a row whose real blocker is
   * still open. Native numbers are mapped through {@link parseRef} — the same
   * inversion the codec refs were minted through — so both sides normalize to
   * the same `IssueRef` shape and dedupe correctly.
   *
   * Dedup key: GitHub's own ids are SLUG-LESS (`parseRef('16') → {issue:16}`),
   * so unlike the Linear port there is no owning-team slug to substitute. A
   * codec ref that DOES carry a slug is a foreign-REPO reference (`other#5`,
   * body-codec `REF_RE`) and names a different issue than this repo's `#5` — so
   * {@link refKey} keeps them apart deliberately rather than collapsing them.
   */
  private async unionBlockedBy(n: number, codec: BlockedBy): Promise<BlockedBy> {
    const nativeNumbers = await this.api.getBlockedBy(n);
    if (nativeNumbers.length === 0) return codec;
    const merged = new Map<string, IssueRef>();
    for (const ref of codec === 'none' ? [] : codec) merged.set(refKey(ref), ref);
    for (const blocker of nativeNumbers) {
      const ref = this.parseRef(String(blocker));
      merged.set(refKey(ref), ref);
    }
    const out = [...merged.values()];
    return out.length === 0 ? 'none' : out;
  }

  /**
   * The WRITE counterpart of {@link unionBlockedBy} (ADR-0020's fast-follow, the
   * same shape the Linear adapter carries): mirror the canonical body-codec
   * `blockedBy` into NATIVE GitHub issue dependencies so a blocked row carries a
   * visible dependency, not just a body line. Three properties, all load-bearing:
   *
   *  - **Additive-only.** Only refs NOT already represented natively are created
   *    (delta vs {@link GitHubApi.getBlockedBy}, keyed by the SAME {@link refKey}
   *    the read-union dedups on). There is no delete/update path: a human-drawn
   *    dependency survives any re-scope, and a stale mirror is harmless (read()
   *    dedups double representation). "Newly added refs" = codec refs missing
   *    from the native side — the AnnotatePatch has no `blockedBy` (ADR-0025), so
   *    annotate reconciles the existing codec block rather than a patch delta.
   *  - **Best-effort / non-fatal.** The body-codec write is the authoritative one
   *    (ADR-0020); a mirror that throws — an unresolvable number, a foreign-repo
   *    ref this repo-scoped endpoint cannot address, or a refused dependency
   *    write — is SKIPPED per-ref, never propagated, so create()/annotate()
   *    always complete the issue write. No logger seam exists in the engine, so
   *    the disclosure is structural: read() still surfaces the codec ref via the
   *    union, and a later create/annotate re-reconciles the native side.
   *  - **The codec stays canonical.** This never rewrites the body; it only adds
   *    a redundant, human-visible representation of what the body already says.
   */
  private async mirrorBlockedBy(n: number, blockedBy: BlockedBy): Promise<void> {
    if (blockedBy === 'none' || blockedBy.length === 0) return;
    let existing: Set<string>;
    try {
      existing = new Set(
        (await this.api.getBlockedBy(n)).map((b) => refKey(this.parseRef(String(b)))),
      );
    } catch {
      existing = new Set(); // a failed native read must not fail the body write
    }
    for (const ref of blockedBy) {
      if (existing.has(refKey(ref))) continue; // already native — additive, no duplicate
      try {
        await this.api.addBlockedBy(n, refToIssueNumber(ref));
      } catch {
        // swallow — best-effort mirror. The authoritative body-codec write
        // already landed; a missing native mirror is harmless (read() unions
        // codec ∪ native and dedups).
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
    const n = Number(id);
    // remove-then-add: clear the other two rungs FIRST, so a crash mid-transition
    // leaves zero wave/* labels (read() → available) rather than two.
    for (const other of VALID_RUNGS) {
      if (other !== rung) await this.api.removeLabel(n, `wave/${other}`);
    }
    await this.api.addLabel(n, `wave/${rung}`);
  }

  async unclaim(id: string): Promise<void> {
    const n = Number(id);
    // drop every wave/* rung → back to the eligible pool (idempotent).
    for (const rung of VALID_RUNGS) await this.api.removeLabel(n, `wave/${rung}`);
  }

  // ── flag / clearFlag (the orthogonal needs-attention overlay, ADR-0006) ────
  async flag(id: string, payload: NeedsAttentionPayload): Promise<void> {
    const n = Number(id);
    await this.api.getIssue(n); // existence check / throw on unknown id
    await this.api.addLabel(n, NEEDS_ATTENTION_LABEL); // orthogonal to wave/<rung>
    await this.api.addComment(n, renderNeedsAttentionComment(payload));
  }

  async clearFlag(id: string): Promise<void> {
    const n = Number(id);
    await this.api.removeLabel(n, NEEDS_ATTENTION_LABEL); // idempotent no-op if absent
  }

  async close(id: string, prUrl: string, ackedAcIndexes: number[]): Promise<void> {
    const n = Number(id);
    const gh = await this.api.getIssue(n);
    // no-op-or-reconcile (ADR-0005): record the closing PR + cosmetic AC tick;
    // do NOT natively close (the merged PR's Closes #N does) and do NOT drop the
    // wave/* claim (keeps the issue out of `available` until the close lands).
    let body = upsertLine(gh.body, CLOSED_BY, prUrl);
    body = tickAcs(body, ackedAcIndexes);
    await this.api.setBody(n, body);
  }

  async readClosing(id: string): Promise<ClosingState> {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error(`Malformed GitHub issue id: ${id}`);
    const probe = await this.api.getClosingState(n); // throws on unknown id
    return probe.prUrl !== undefined
      ? { state: probe.state, prUrl: probe.prUrl }
      : { state: probe.state };
  }

  async listOpen(_scope: ListScope): Promise<IssueView[]> {
    return this.scan(
      (gh) =>
        this.isEligible(gh.labels) &&
        this.rungOf(gh.labels) === null &&
        !gh.labels.includes(NEEDS_ATTENTION_LABEL),
    );
  }

  async listClaimed(): Promise<IssueView[]> {
    return this.scan((gh) => this.rungOf(gh.labels) !== null);
  }

  // ── Document facet (ADR-0011): a PRD is an issue labelled `prd`, no eligibility ──
  async publishDocument(input: PublishDocumentInput): Promise<string> {
    const parts: string[] = [];
    for (const s of input.bodySections) {
      parts.push(`## ${s.heading}`, '', s.markdown.trimEnd(), '');
    }
    const body = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    // labelled `prd`, NOT the eligibility token — so it never enters listOpen.
    const { number } = await this.api.createIssue({
      title: input.title,
      body,
      labels: [this.documentLabel],
    });
    return String(number); // filingHint ignored — id is the opaque issue number (ADR-0001)
  }

  async readDocument(id: string): Promise<DocumentView> {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error(`Malformed GitHub issue id: ${id}`);
    const gh = await this.api.getIssue(n); // throws on unknown id
    return { id, title: gh.title, body: gh.body };
  }

  async listDocuments(): Promise<DocumentView[]> {
    const open = await this.api.listOpenIssues();
    return open
      .filter((gh) => gh.labels.includes(this.documentLabel))
      .map((gh) => ({ id: String(gh.number), title: gh.title, body: gh.body }));
  }

  /** Shared open-issue scan; `keep` selects, malformed bodies are skipped. */
  private async scan(keep: (gh: GhIssue) => boolean): Promise<IssueView[]> {
    const open = await this.api.listOpenIssues();
    const out: IssueView[] = [];
    for (const gh of open) {
      if (!keep(gh)) continue;
      try {
        out.push(this.project(String(gh.number), gh));
      } catch {
        // a human-garbled body throws in project(); skip it rather than aborting
        // the whole scan (GitHub bodies are remotely editable).
      }
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * NOTE — deliberate read()/list asymmetry (the same one the Linear port
   * carries): `read()` layers {@link unionBlockedBy} on top of this projection,
   * so its `blockedBy` is codec ∪ native. Views built directly from `project()`
   * (i.e. `listOpen`/`listClaimed`, via `scan()`) carry the codec-only
   * `blockedBy` — no native union, since that would mean one extra
   * `getBlockedBy` call per scanned issue. A future consumer that reasons about
   * `blockedBy` across a list scan must not assume the union holds there; only a
   * single-issue `read()` guarantees it.
   */
  private project(id: string, gh: GhIssue): IssueView {
    const parsed = parseBody(gh.body);
    const risk = soleLabelValue(gh.labels, 'risk', id);
    const worker = soleLabelValue(gh.labels, 'worker', id);

    return {
      id,
      risk,
      worker,
      files: parsed.files,
      blockedBy: parsed.blockedBy,
      ...(parsed.unblocks !== undefined ? { unblocks: parsed.unblocks } : {}),
      ...(parsed.parent !== undefined ? { parent: parsed.parent } : {}),
      acceptanceCriteria: parsed.acceptanceCriteria,
      status: this.deriveStatus(gh),
      ...(parsed.closedBy !== undefined ? { closedBy: parsed.closedBy } : {}),
      ...(parsed.estimatedWallclock !== undefined
        ? { estimatedWallclock: parsed.estimatedWallclock }
        : {}),
    };
  }

  private deriveStatus(gh: GhIssue): CoarseState {
    // Any natively-closed issue is the terminal coarse bookend (ADR-0005). The
    // rule is "closed ⇒ done" so a `Closes #N` merge that leaves stateReason=null
    // (not always 'completed') still derives done. The not_planned (wontfix)
    // nuance is DELIBERATELY lossy in the coarse projection (ADR-0002): the
    // close reason is not consulted, not_planned collapses to done too, and it
    // is excluded from waves either way (closed ⇒ absent from listOpen). The
    // docs are reconciled to this and a spec pins it (decided 2026-06-06).
    if (gh.state === 'closed') return 'done';
    // needs-attention (ADR-0006) is orthogonal to the claim and takes precedence
    // over the wave/<rung> rung in the coarse projection.
    if (gh.labels.includes(NEEDS_ATTENTION_LABEL)) return 'needs-attention';
    const rung = this.rungOf(gh.labels);
    return rung ?? 'available';
  }

  /** Highest-precedence wave/* rung present (in-review > in-flight > queued). */
  private rungOf(labels: string[]): ClaimRung | null {
    for (const rung of RUNG_PRECEDENCE) {
      if (labels.includes(`wave/${rung}`)) return rung;
    }
    return null;
  }

  private isEligible(labels: string[]): boolean {
    return labels.some((l) => this.eligibility.includes(l));
  }

  // ── Triage facet (ADR-0015) — issue-side labels + comments ─────────────────
  async readTriage(id: string): Promise<TriageView> {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error(`Malformed GitHub issue id: ${id}`);
    const gh = await this.api.getIssue(n); // throws on unknown id
    const state = this.triageSchema.states.find((s) => gh.labels.includes(s));
    const category = this.triageSchema.categories.find((c) => gh.labels.includes(c));
    const comments = (await this.api.getComments(n)).map((c) => ({ body: c.body }));
    return {
      id,
      title: gh.title,
      body: gh.body,
      ...(state !== undefined ? { state } : {}),
      ...(category !== undefined ? { category } : {}),
      comments,
    };
  }

  async applyTriage(id: string, input: ApplyTriageInput): Promise<void> {
    const n = Number(id);
    const gh = await this.api.getIssue(n); // existence check / throw
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
      await this.swapAmongSet(n, gh.labels, this.triageSchema.states, input.state);
    }
    if (input.category !== undefined) {
      await this.swapAmongSet(n, gh.labels, this.triageSchema.categories, input.category);
    }
    if (input.comment !== undefined) {
      await this.api.addComment(n, withTriageDisclaimer(input.comment));
    }
  }

  async closeUnplanned(id: string, comment: string): Promise<void> {
    const n = Number(id);
    await this.applyTriage(id, { state: this.triageSchema.unplannedState, comment });
    await this.api.nativeClose(n, 'not_planned');
  }

  /** Remove every label in `set` except `target`, then add `target` (idempotent). */
  private async swapAmongSet(
    n: number,
    labels: string[],
    set: readonly string[],
    target: string,
  ): Promise<void> {
    for (const member of set) {
      if (member !== target && labels.includes(member)) {
        await this.api.removeLabel(n, member);
      }
    }
    await this.api.addLabel(n, target);
  }
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
 * Normalized ref identity for the blockedBy read-union / mirror dedup —
 * `slug#issue`, with an absent slug meaning THIS repo.
 *
 * The Linear counterpart substitutes the referencing issue's own team slug here;
 * GitHub has no such slug (its ids are bare numbers, `parseRef('16') →
 * {issue:16}`), so a slug-less ref keys as `#16` and a slugged ref keys as
 * `other#16`. Keeping those apart is the CORRECT behaviour, not a gap: a slugged
 * ref names a foreign repo's issue #16, which is a different issue from this
 * repo's #16 and must never dedupe against a native dependency here.
 */
function refKey(ref: IssueRef): string {
  return `${ref.slug ?? ''}#${ref.issue}`;
}

/**
 * A blockedBy `IssueRef` → the issue NUMBER the native mirror addresses. Inverse
 * of {@link GitHubIssuesStore.parseRef}.
 *
 * A ref carrying a slug is a FOREIGN-REPO reference, and GitHub's dependency
 * endpoints are repo-scoped (`POST /repos/{owner}/{repo}/issues/{n}/
 * dependencies/blocked_by`): mirroring it against this repo would create a
 * dependency on this repo's same-numbered issue — a silently WRONG relation, the
 * one outcome worse than a missing mirror. So it throws instead, and
 * {@link GitHubIssuesStore.mirrorBlockedBy}'s per-ref catch turns that into a
 * non-fatal skip (the body codec keeps the ref, authoritatively, either way).
 * This is the deliberate divergence from the Linear port, whose
 * `refToIdentifier` CAN resolve a cross-team ref because a Linear identifier
 * carries its team slug natively.
 */
function refToIssueNumber(ref: IssueRef): number {
  if (ref.slug !== undefined) {
    throw new Error(
      `refToIssueNumber: cross-repo blockedBy ref "${ref.slug}#${ref.issue}" cannot be mirrored ` +
        `into a repo-scoped GitHub issue dependency.`,
    );
  }
  return ref.issue;
}

/**
 * The sole `prefix/<value>` label. Fail-fast on zero (malformed — no partial
 * view) AND on multiple (ambiguous — a human/race added a second `risk/*`,
 * which would otherwise be silently first-wins).
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
