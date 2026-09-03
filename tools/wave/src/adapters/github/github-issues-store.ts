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
  CreateInputError,
  GoalMemberJoinError,
  refuseGoalUpdateSurface,
  requireGoalContainer,
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
  type CreateGoalInput,
  type CreateGoalMemberInput,
  type GoalContainer,
  type GoalUpdateReceipt,
  type GoalView,
  type PublishGoalUpdateInput,
  withTriageDisclaimer,
} from '../issue-store';
import {
  computeGoalFrontier,
  type GoalFrontier,
  type GoalMemberFacts,
} from '../../goal-frontier';
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
/**
 * The one Goal container this store realizes, and its default (ADR-0044
 * decision 4). Milestone is GitHub's only native container with DIRECT issue
 * membership, so defaulting to it collides with no consumer convention — unlike
 * Linear, where "project" already means different things in different shipped
 * workspaces and therefore gets no default at all.
 */
const GOAL_CONTAINERS_REALIZED: readonly GoalContainer[] = ['milestone'];
const DEFAULT_GOAL_CONTAINER: GoalContainer = 'milestone';
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
      // ADR-0044's bare `blockedBy` arm is realized ONLY natively here, so a ref
      // this repo-scoped API cannot address has nowhere else to live — unlike
      // the decorated path, where `refToIssueNumber`'s throw is a harmless
      // per-ref skip because the body codec already recorded the ref
      // authoritatively. A bare issue has no such codec line, so the same skip
      // would silently drop the whole edge. Refused BEFORE `createIssue`, so
      // nothing is filed (the classifier's own no-partial-write property).
      const foreign = (shape.blockedBy ?? []).filter((r) => r.slug !== undefined);
      if (foreign.length > 0) {
        throw new CreateInputError(
          'bare-blocked-by-unrepresentable',
          ['blockedBy'],
          `create: a BARE issue's \`blockedBy\` is realized only as a NATIVE ` +
            `GitHub issue dependency, and those endpoints are repo-scoped — the ` +
            `cross-repo ref(s) ` +
            `${foreign.map((r) => `"${r.slug}#${r.issue}"`).join(', ')} cannot be ` +
            `represented on this issue (mirroring them here would draw a ` +
            `dependency on THIS repo's same-numbered issue, which is worse than ` +
            `no mirror). Two sanctioned routes: (1) file this issue DECORATED ` +
            `now — the body-codec \`## Blocked by\` section records a cross-repo ` +
            `ref authoritatively; or (2) file it bare with same-repo refs only ` +
            `and add the cross-repo dependency at decoration time.`,
        );
      }
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
      // …and the ADR-0044 arm: the declared dependency, realized natively and
      // ONLY natively — no `## Blocked by` section is written, so the bare
      // invariant above still holds byte-for-byte. The #381 read-union is what
      // surfaces the edge again (`read()` returns codec ∪ native), so a later
      // decorate makes it visible to conflict/blocked reasoning without the
      // bare filing ever having authored a header line.
      //
      // Best-effort per ref, exactly as the decorated mirror is: the DETERMINISTIC
      // unrepresentable case is already refused above, so what remains here is
      // transport-level refusal (rate limit, a blocker number that does not
      // resolve), the same class create()/annotate() have always absorbed rather
      // than failed a landed issue write over.
      if (shape.blockedBy !== undefined) {
        await this.mirrorBlockedBy(number, shape.blockedBy);
      }
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
    // ── operating envelope (vendor-documented, NOT throttled here — triage
    // decision: NAME the caveat, do not build throttle/backoff/retry machinery
    // for it). GitHub's own docs (both read 2026-08-09):
    //   - docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
    //     — SECONDARY rate limits, separate from the primary per-hour quota:
    //     no more than 900 points/minute for the REST API; a `POST`/`PATCH`/
    //     `PUT`/`DELETE` costs 5 points vs. 1 for `GET`/`HEAD`/`OPTIONS`; and a
    //     content-creation ceiling of no more than 80 such requests/minute or
    //     500/hour, on top of the points budget.
    //   - docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
    //     — "make requests serially instead of concurrently" and "wait at
    //     least one second between each" mutating (POST/PATCH/PUT/DELETE)
    //     request to avoid tripping the secondary limit.
    // Accepted per-call cost (matches what RealLinearApi.addBlockedBy pays for
    // its own mirror): a read() costs +1 dependency GET; a create()/annotate()
    // costs the +1 GET above PLUS up to one addBlockedBy POST per unmirrored
    // ref in THIS loop. `listOpen`/`listClaimed` (`scan()`, #654) cost +1
    // dependency GET per KEPT issue too, now that the union runs there as
    // well — read SEQUENTIALLY, never fanned out, but still one GET per row on
    // every draw. A wide wave-plan or a bulk to-issues decorate/create pass on
    // a github-store consumer — many issues, each with fresh `blockedBy`
    // refs — walks straight at that envelope: one POST per unmirrored ref, no
    // pacing between them, plus now one GET per listed row on the read side.
    // No throttle/backoff/retry is added: this mirror is best-effort by
    // design (class doc above) and a rate-limited or otherwise refused POST
    // is swallowed below exactly like any other refusal — the authoritative
    // body-codec write already landed, read() still unions codec ∪ native, and
    // the next create()/annotate() re-attempts whatever this pass left
    // unmirrored. Degradation here is harmless, not silent-and-wrong — see
    // .claude/skills/to-issues/reference/filing-mechanics.md and
    // .claude/skills/wave-plan/SKILL.md for the operator-facing note.
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

  /**
   * Shared open-issue scan; `keep` selects, malformed bodies are skipped.
   *
   * Unions each KEPT issue's native blocked-by dependency into its
   * `blockedBy` (#654), the same {@link unionBlockedBy} layer `read()`
   * applies — so `listOpen`/`listClaimed` agree with `read()` (and the goal
   * frontier) on every edge, codec or native, instead of the codec-only view
   * this scan used to return. That means one extra `getBlockedBy` GET per
   * KEPT issue, read SEQUENTIALLY — a `for…of` with `await` inside, never
   * `Promise.all` — against the same secondary-rate-limit envelope
   * {@link mirrorBlockedBy}'s doc names; the accepted cost, decided at
   * sharpening rather than left as a documented asymmetry. A failed native
   * read (or a garbled body) drops just that ONE issue from the result —
   * GitHub state is remotely editable and this call crosses the network, so a
   * single flaky read must not abort the whole scan.
   */
  private async scan(keep: (gh: GhIssue) => boolean): Promise<IssueView[]> {
    const open = await this.api.listOpenIssues();
    const out: IssueView[] = [];
    for (const gh of open) {
      if (!keep(gh)) continue;
      try {
        const view = this.project(String(gh.number), gh);
        out.push({ ...view, blockedBy: await this.unionBlockedBy(gh.number, view.blockedBy) });
      } catch {
        // a human-garbled body throws in project(), or unionBlockedBy's native
        // read fails (transient/rate-limited) — either way, skip this one
        // issue rather than aborting the whole scan.
      }
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────
  /**
   * `blockedBy` here is codec-only — parsed straight off the body, nothing
   * more. The native union is layered on top by every CALLER of `project()`:
   * `read()` applies {@link unionBlockedBy} directly, and `listOpen`/
   * `listClaimed` apply the SAME union inside {@link scan}, so every read
   * surface this store exposes agrees on `blockedBy` (#654 — they used to
   * diverge, with `scan()` skipping the union to save a `getBlockedBy` call
   * per scanned issue; see {@link scan}'s own doc for the cost that saving no
   * longer buys).
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
      // The tracker's OWN last-write instant (`updated_at`), not anything the
      // body codec could carry — it is API metadata, so it survives no
      // round-trip through the issue text. Passed through as-is; an absent
      // `updatedAt` stays absent, which the DoR staleness advisory reads as
      // `'deferred'` rather than as "nothing moved".
      ...(gh.updatedAt !== undefined ? { trackerUpdatedAt: gh.updatedAt } : {}),
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

  // ── Goal facet (ADR-0044): a Goal is a GitHub MILESTONE ───────────────────

  /**
   * Resolve the container role this call addresses, or refuse loudly. Runs as
   * the FIRST statement of every goal verb — before any id is resolved and
   * before any write — so a refused binding does nothing, the same
   * no-partial-application property `classifyCreateInput` gives `create()`.
   */
  private goalRole(container: GoalContainer | undefined): GoalContainer {
    return requireGoalContainer({
      storeKind: 'github',
      configured: container,
      fallback: DEFAULT_GOAL_CONTAINER,
      realizable: GOAL_CONTAINERS_REALIZED,
    });
  }

  async createGoal(input: CreateGoalInput, container?: GoalContainer): Promise<string> {
    this.goalRole(container);
    const { number } = await this.api.createMilestone({
      title: input.title,
      description: input.description ?? '',
    });
    return String(number); // filingHint ignored — the id is the opaque milestone number (ADR-0001)
  }

  async readGoal(id: string, container?: GoalContainer): Promise<GoalView> {
    const role = this.goalRole(container);
    const n = this.goalNumber(id);
    const ms = await this.api.getMilestone(n); // throws on unknown id
    const members = await this.api.listMilestoneIssues(n);
    return {
      id,
      title: ms.title,
      description: ms.description,
      container: role,
      memberIds: members.map((m) => String(m.number)),
    };
  }

  /**
   * Every milestone on the repo, each with its curated membership.
   *
   * Costs one member-list read PER milestone, and that is a deliberate
   * acceptance rather than an oversight: {@link GoalView.memberIds} is part of
   * the contract all three stores answer identically, and a list arm that
   * returned an empty membership would be reporting `[]` where it means "not
   * fetched" — the absent-vs-empty confusion this codebase refuses everywhere
   * else. A goal panel reads a handful of finish lines, not a wave-sized set.
   */
  async listGoals(container?: GoalContainer): Promise<GoalView[]> {
    const role = this.goalRole(container);
    const milestones = await this.api.listMilestones();
    const out: GoalView[] = [];
    for (const ms of milestones) {
      const members = await this.api.listMilestoneIssues(ms.number);
      out.push({
        id: String(ms.number),
        title: ms.title,
        description: ms.description,
        container: role,
        memberIds: members.map((m) => String(m.number)),
      });
    }
    return out;
  }

  async assignToGoal(
    goalId: string,
    issueId: string,
    container?: GoalContainer,
  ): Promise<void> {
    this.goalRole(container);
    const milestone = this.goalNumber(goalId);
    const issue = Number(issueId);
    if (!Number.isInteger(issue)) {
      throw new Error(`Malformed GitHub issue id: ${issueId}`);
    }
    // Idempotent by nature: the membership is a single pointer on the issue, so
    // re-joining writes the same value.
    //
    // ADDITIVE ONLY, deliberately — and this is the seam side of a DOCUMENTED-
    // FORM departure recorded in full at `RealGitHubApi.setIssueMilestone`:
    // GitHub's "Update an issue" documents `milestone: null` as the un-assign
    // form, and nothing here realizes it. The facet has a join verb and no
    // LEAVE verb by design (ADR-0044) — curation-leave is the Operator's act in
    // the tracker, the same line that keeps `closeGoal` off the seam — so the
    // absence is the contract holding, not this method falling short of the
    // endpoint. A facet-side unassign is its own engine slice.
    await this.api.setIssueMilestone(issue, milestone);
  }

  /**
   * Mint a bare ISSUE member and join it to the milestone, in one act (ADR-0045
   * decision 3). The milestone binding's member kind is `issue`, so this is
   * exactly the shipped bare create plus the shipped curation write — the
   * station gets one path where it used to need two, and every bare invariant
   * `create()` holds is inherited rather than re-implemented.
   *
   * The goal is resolved BEFORE the mint (an unknown milestone files nothing),
   * and the `blockedBy` refusal this store already owns — a cross-REPO ref,
   * which a native GitHub dependency cannot address — fires inside `create()`,
   * still before any write.
   */
  async createGoalMember(
    goalId: string,
    input: CreateGoalMemberInput,
    container?: GoalContainer,
  ): Promise<string> {
    this.goalRole(container);
    const milestone = this.goalNumber(goalId);
    await this.api.getMilestone(milestone); // pre-validation: an unknown goal mints nothing
    const blockedBy = input.blockedBy ?? [];
    const memberId = await this.create({
      title: input.title,
      filingHint: input.filingHint,
      bodySections: input.bodySections,
      ...(blockedBy.length > 0
        ? { blockedBy: blockedBy.map((id) => this.parseRef(id)) }
        : {}),
    });
    try {
      await this.api.setIssueMilestone(Number(memberId), milestone);
    } catch (err) {
      throw new GoalMemberJoinError(
        'membership',
        goalId,
        memberId,
        err,
        `createGoalMember: issue "${memberId}" WAS created, but joining it to ` +
          `milestone "${goalId}" failed — ${(err as Error)?.message ?? String(err)}. ` +
          `It is NOT rolled back (ADR-0045: residue is reported, never silently ` +
          `deleted), so "${memberId}" exists right now and is the thing to fix: ` +
          `assignToGoal("${goalId}", "${memberId}").`,
      );
    }
    return memberId;
  }

  async readGoalFrontier(
    goalId: string,
    container?: GoalContainer,
  ): Promise<GoalFrontier> {
    this.goalRole(container);
    const n = this.goalNumber(goalId);
    const members = await this.api.listMilestoneIssues(n); // throws on unknown goal id
    const facts: GoalMemberFacts[] = [];
    for (const gh of members) facts.push(await this.goalMemberFacts(gh));
    return computeGoalFrontier(goalId, facts);
  }

  /**
   * The mirror pass (ADR-0046) — REFUSED on this store, before any work.
   *
   * A GitHub Milestone holds members perfectly well and every other goal verb
   * above works on it; what it does not have is a timeline artifact a report
   * could be published to. There is no `milestoneUpdateCreate`, and the nearest
   * lookalike — rewriting the milestone's DESCRIPTION to hold the report — was
   * considered and rejected as a lossy state write onto a field that means
   * something else. So the honest answer is a typed refusal rather than a
   * substitute surface.
   *
   * Routed through the SHARED {@link refuseGoalUpdateSurface} rather than
   * throwing a locally-built error, so this refusal and the markdown store's are
   * the same refusal rather than two lookalikes that agree today. The binding is
   * still resolved first, so a consumer who ALSO misconfigured the container hears
   * about that (`unrealized-container`) rather than being told the surface is
   * missing on a role this store never had.
   */
  async publishGoalUpdate(
    goalId: string,
    _input?: PublishGoalUpdateInput,
    container?: GoalContainer,
  ): Promise<GoalUpdateReceipt> {
    // Resolve the binding FIRST — a bad container is a different, more
    // fundamental complaint than a missing surface, and must win.
    const role = this.goalRole(container);
    void goalId;
    return refuseGoalUpdateSurface('github', role);
  }

  /** A goal id → the milestone number it names; throws on a non-integer id. */
  private goalNumber(id: string): number {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error(`Malformed GitHub milestone id: ${id}`);
    return n;
  }

  /**
   * What this store can SEE about one goal member — the frontier's whole input.
   *
   * Read off the raw `GhIssue` rather than through `read()`, and that is the
   * load-bearing choice: `read()` projects an `IssueView` and THROWS on a bare
   * member (no `## Files` section to parse), and a bare member is exactly what
   * the `goal` station files at a cut. Going through `read()` would make a
   * fresh goal unreadable; going around it makes `unready` observable.
   *
   * `nativeState` and `health` are deliberately NOT stated. A milestone binding
   * is issue-direct: a GitHub issue is `open` or `closed` and nothing else, which
   * `closed` above already carries in full, and GitHub records no health of any
   * kind. Absence is the honest answer, and it is reported as absence — never as
   * `'open'`, never as an empty string, never as a placeholder — so a caller can
   * tell "this binding has no such value" from "this member's value is blank".
   * Only a binding whose members are themselves containers (a Linear project
   * under an `initiative` binding) has a native state the five readings are
   * lossy about; see `LinearIssuesStore.goalProjectMemberFacts`.
   */
  private async goalMemberFacts(gh: GhIssue): Promise<GoalMemberFacts> {
    const closed = gh.state === 'closed';
    const id = String(gh.number);
    // A closed member is `done` whatever else is true of it, so its blockers are
    // not read at all — one saved round-trip per finished member, and no
    // dependency edge can change a terminal reading.
    if (closed) {
      return { id, closed: true, claimed: false, eligible: false, unresolvedBlockers: [] };
    }
    // The body codec sees blockers only on a DECORATED member; a bare one has no
    // `## Blocked by` section and `parseBody` throws on it. That throw is not a
    // failure here — it is the bare case — so it degrades to "no codec refs" and
    // the native side below still carries the ADR-0044 bare arm's edges.
    let codec: BlockedBy = 'none';
    try {
      codec = parseBody(gh.body).blockedBy;
    } catch {
      codec = 'none';
    }
    const union = await this.unionBlockedBy(gh.number, codec);
    return {
      id,
      closed: false,
      claimed:
        this.rungOf(gh.labels) !== null || gh.labels.includes(NEEDS_ATTENTION_LABEL),
      eligible: this.isEligible(gh.labels),
      unresolvedBlockers: await this.unresolvedBlockers(union),
    };
  }

  /**
   * Which of a member's read-union blockers are still in the way.
   *
   * A blocker counts as UNRESOLVED unless this store positively read it closed.
   * Two cases land there deliberately:
   *
   *  - a **cross-repo** ref (`other#5`). This repo-scoped API cannot address it,
   *    and the alternative — resolving it against THIS repo's `#5` — is the
   *    silently-wrong answer `refToIssueNumber` already refuses to give on the
   *    write side.
   *  - a ref whose read **throws** (deleted, renumbered, rate-limited).
   *
   * Both are "no evidence", and `actionable` is a positive claim that nothing
   * blocks the member — so no-evidence must never be able to counterfeit it.
   * That is the `closed-unknown` discipline (W2-F1c) applied to the frontier.
   */
  private async unresolvedBlockers(blockedBy: BlockedBy): Promise<IssueRef[]> {
    if (blockedBy === 'none') return [];
    const out: IssueRef[] = [];
    for (const ref of blockedBy) {
      if (ref.slug !== undefined) {
        out.push(ref); // cross-repo — unaddressable here, so never provably clear
        continue;
      }
      try {
        const blocker = await this.api.getIssue(ref.issue);
        if (blocker.state !== 'closed') out.push(ref);
      } catch {
        out.push(ref); // unreadable ⇒ unresolved, never silently cleared
      }
    }
    return out;
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
