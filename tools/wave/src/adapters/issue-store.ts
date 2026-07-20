/**
 * issue-store.ts — the engine↔tracker seam (CHARTER §4/§6).
 *
 * The engine consumes only `IssueView` (../contract). `IssueStore` is the
 * adapter surface every tracker target implements — `MarkdownFsStore` (P2,
 * Ur-parity) and `GitHubIssuesStore` (P3). It imports nothing harness-specific.
 *
 * The contract is the **tracker-agnostic intersection** of those two targets.
 * Where the targets diverge (most sharply in how an issue becomes natively
 * *closed*), the divergence is pushed out of the method post-conditions and
 * onto the {@link IssueStoreConformanceHooks.simulateNativeClose} seam, so the
 * shared conformance suite cannot bake in a markdown-only mechanism.
 */

import type {
  IssueView,
  IssueRef,
  ClaimRung,
  TriageView,
  ApplyTriageInput,
} from '../contract';

export type { ClaimRung };

/**
 * The candidate filter for {@link IssueStore.listOpen}. Only `'wave-ready'`
 * ships in M1 (the ADR-0003 eligibility OR-set). A closed union, not a free
 * string, so a consumer cannot smuggle a taxonomy assumption into the engine.
 */
export type ListScope = 'wave-ready';

/**
 * The result of the {@link IssueStore.readClosing} probe (ADR-0005 — the
 * deferred "GraphQL closedBy"). Distinct from {@link read}'s coarse `done`
 * projection, which is lossy and cannot tell merged from unmerged.
 *
 * The four outcomes are **evidence-shaped** — each says what the store actually
 * found, never what it inferred from an absence:
 *
 * - `open` — not closed.
 * - `merged` — POSITIVE evidence a linked PR merged: the wave's real done
 *   signal, with the PR url in `prUrl`.
 * - `closed-unmerged` — POSITIVE evidence a linked PR exists and did NOT merge
 *   (the PR-closed-without-merge concern). A genuinely rejected PR.
 * - `closed-unknown` — the issue is closed but NO PR evidence was found either
 *   way. Not a rejection: an issue closed by hand, closed as a duplicate,
 *   closed via a foreign-id mention, or closed on a workspace whose tracker↔host
 *   integration never attached a PR, all land here.
 *
 * **Why `closed-unknown` exists (W2-F1c).** The probe used to collapse the last
 * two: any close without merge evidence read `closed-unmerged`, and wave-close
 * flags `closed-unmerged` as `recoverable-stop` — so a legitimately-completed
 * row that closed outside the attachment path was reported as a rejected PR.
 * "No evidence found" and "found evidence of rejection" are different claims and
 * must route differently; only the latter is a problem worth stopping a human for.
 *
 * Callers MUST NOT treat `closed-unknown` as a rejection. It is a report line
 * (and, on a store with a known-missing integration, the trigger for the
 * done-state fallback), never an automatic flag.
 */
export type ClosingState = {
  state: 'open' | 'merged' | 'closed-unmerged' | 'closed-unknown';
  prUrl?: string;
};

/**
 * The needs-attention payload (ADR-0006): why the in-flight agent stopped and
 * what the human must answer. `kind` distinguishes a recoverable stop (the agent
 * can resume given an answer) from a terminal failure (the slice is abandoned);
 * `options` is the closed set of human replies the headless-async bridge offers.
 */
export type NeedsAttentionPayload = {
  kind: 'recoverable-stop' | 'terminal-failure';
  question: string;
  options: string[];
};

/**
 * The default eligibility OR-set (ADR-0003) — the built-in default. A single
 * shared source of truth so the two stores cannot silently diverge on it; a
 * consumer overrides it via store options. ADR-0003 keeps eligibility
 * *declared* (config), not wired — this is just the default declaration.
 */
export const DEFAULT_ELIGIBILITY: readonly string[] = ['ready-for-agent'];

/** read() coarse-status precedence over the wave/* claim rungs (highest wins). */
export const RUNG_PRECEDENCE: readonly ClaimRung[] = [
  'in-review',
  'in-flight',
  'queued',
];

/**
 * What the engine hands the store to mint a new issue. Deliberately NOT an
 * `IssueView`: an `IssueView` already has an `id` and a `status`, both of which
 * the store assigns.
 */
export interface CreateInput {
  /** Human-facing H1 title text (free prose). */
  title: string;
  /**
   * A store-INTERNAL filing hint (e.g. a kebab key). It has **no guaranteed
   * relationship to the returned id** — `MarkdownFsStore` may weave it into the
   * `<slug>#NN` path-id, `GitHubIssuesStore` ignores it entirely and returns
   * `"412"`. Callers MUST treat {@link IssueStore.create}'s return as fully
   * opaque (ADR-0001) and never reconstruct an id from this field.
   */
  filingHint: string;
  risk: string; // config-governed vocab (validate via validateHeaderBlock)
  worker: string; // config-governed vocab
  files: string[]; // globs/paths, annotation-free
  /**
   * Refs already resolved to real tracker ids. ADR-0001's two-pass create
   * (resolve intra-batch blockers first) is the **caller's** job — the store
   * validates ref *format*, never ref *existence*.
   */
  blockedBy: 'none' | IssueRef[];
  unblocks?: IssueRef[];
  /**
   * Backlink to the **PRD** this slice was sliced from (ADR-0011). The PRD's
   * **opaque id string** (ADR-0013), NOT an `IssueRef` — `parent` references a
   * document's identity, passed verbatim as the id the Document facet minted.
   * The single source the PRD's *consumed* status is derived from (exact id
   * match) — never a written PRD-side state.
   */
  parent?: string;
  /** All `checked:false` at creation; serialized as `- [ ]` task-list items. */
  acceptanceCriteria: { text: string; checked: boolean }[];
  estimatedWallclock?: string;
  /** Free-prose body sections (Parent, What to build, …) written verbatim. */
  bodySections?: { heading: string; markdown: string }[];
}

/**
 * The decorate-mode patch (ADR-0010): the wave Header-Block fields to ADD to an
 * already-filed, triage-ready issue that lacks them. Every field is optional —
 * only the supplied ones are written; omitted ones are left untouched. This is
 * what `to-issues`' decorate path hands {@link IssueStore.annotate}.
 */
export interface AnnotatePatch {
  /** config-governed vocab; written like {@link CreateInput.risk}. */
  risk?: string;
  /** config-governed vocab; written like {@link CreateInput.worker}. */
  worker?: string;
  /** globs/paths, annotation-free; REPLACES the modeled Files list when supplied. */
  files?: string[];
  /**
   * Backlink to the source **PRD** (ADR-0011/0012/0013). A decorate-mode slice
   * must be able to carry it too: a PRD is often realized through a mix of newly-
   * created slices and already-filed issues `to-issues` decorates — without this a
   * PRD sliced entirely into decorate-targets would never derive as *consumed*.
   * The PRD's opaque id **string** (same as {@link CreateInput.parent}), written
   * surgically; `blockedBy` deliberately stays OUT of the patch (dependency
   * structure is out-of-band), but `parent` is a missing Header-Block field.
   */
  parent?: string;
  /** REPLACES the modeled AC checklist when supplied (all `checked:false` for a fresh decorate). */
  acceptanceCriteria?: { text: string; checked: boolean }[];
  /** Free-prose body sections (Parent, What to build, …) added verbatim. */
  bodySections?: { heading: string; markdown: string }[];
}

/**
 * The authored-content patch the Amend facet writes (ADR-0025). Deliberately
 * minimal: every MODELED surface keeps its own owner — the wave Header-Block →
 * {@link IssueStore.annotate} (decorate, ADR-0010), the triage dimension → the
 * Triage facet (ADR-0015), the claim ledger → {@link IssueStore.transition}. So
 * there is intentionally **no** `files` / `acceptanceCriteria` / `blockedBy` /
 * `risk` / `worker` here: an amend structurally cannot clobber acceptance
 * criteria (the field does not exist), and a full re-scope is the composition
 * `amend` (title + prose) **+** `annotate` (Files/ACs) — two deliberate calls.
 */
export interface AmendPatch {
  /**
   * Replaces the human-facing title. On MarkdownFs only the title part of the
   * `# NN — Title` H1 is swapped; the `NN — ` filing prefix and the filename
   * (a cosmetic slug, never a key — ADR-0001) stay.
   */
  title?: string;
  /**
   * Upsert-by-heading free-prose sections: an EXISTING `## <heading>` section's
   * content is REPLACED (no shadow duplicate), an ABSENT one is appended. A
   * heading colliding with the codec's reserved Header-Block sections (Files,
   * Blocked by, Unblocks, Acceptance criteria) throws, pointing the caller at
   * `annotate`.
   */
  sections?: { heading: string; markdown: string }[];
}

/**
 * Validate an {@link AmendPatch} as a WHOLE, before any adapter write (the
 * {@link IssueStore.applyTriage} no-partial-application discipline, ADR-0025).
 * Pure. Throws on an EMPTY patch (an amend that changes nothing is a caller bug
 * — the W4-F2 fail-loud class) or a section with a blank heading. The
 * reserved-heading rejection is NOT duplicated here: it lives in the codec's
 * `upsertSection`, so it fires identically on all three adapters (zero
 * suite-shape concession) during the in-memory section transform, still before
 * any write.
 */
export function validateAmendPatch(patch: AmendPatch): void {
  const hasTitle = patch.title !== undefined;
  const hasSections = patch.sections !== undefined && patch.sections.length > 0;
  if (!hasTitle && !hasSections) {
    throw new Error(
      'amend requires a non-empty patch: supply a title and/or at least one section.',
    );
  }
  for (const s of patch.sections ?? []) {
    if (s.heading.trim() === '') {
      throw new Error('amend section heading must not be blank.');
    }
  }
}

/**
 * What `to-prd` hands the store to publish a **PRD** (ADR-0011) — a planning
 * document, deliberately NOT a wave issue: no Risk/Worker/Files, no Header-Block,
 * and no Eligibility marker, so it never enters {@link IssueStore.listOpen}.
 */
export interface PublishDocumentInput {
  /** Human-facing H1 title (free prose). */
  title: string;
  /** Store-internal filing hint; same opacity contract as {@link CreateInput.filingHint}. */
  filingHint: string;
  /** The PRD sections, written verbatim as `## heading` blocks. */
  bodySections: { heading: string; markdown: string }[];
}

/**
 * A planning document read back (ADR-0011). A tracker artifact, NOT an
 * `IssueView`: it carries no wave fields and no coarse status — just its id,
 * title, and raw rendered body (the prose `to-issues` slices from).
 */
export interface DocumentView {
  id: string;
  title: string;
  /** Raw rendered markdown body (the `bodySections` composed), Header-Block-free. */
  body: string;
}

export interface IssueStore {
  /**
   * Mint a new issue; return its assigned tracker-native id (ADR-0001 — opaque
   * to the engine, later the spine plan-table row key). Pure write: the store
   * assigns the id + the initial coarse status (`available`); it does NOT
   * resolve intra-batch blockers.
   */
  create(input: CreateInput): Promise<string>;

  /**
   * Invert an opaque id (one this store minted) into the `IssueRef` shape that
   * `blockedBy` needs — the engine seam (ADR-0001) that keeps id-format knowledge
   * out of the skills, so `to-issues`' two-pass never parses an id by hand. The
   * store owns its id format: MarkdownFs `<slug>#NN` → `{slug, issue}`, GitHub a
   * bare number → `{issue}`. Pure (no I/O). **Throws** on an id with no numeric
   * issue part — e.g. a PRD's `<slug>#prd` sentinel; a PRD is referenced by its
   * `parent` id *string*, never as a blocker `IssueRef` (ADR-0013), so it must
   * not be inverted here.
   */
  parseRef(id: string): IssueRef;

  /**
   * Decorate an already-filed issue with the wave Header-Block fields it lacks
   * (ADR-0010 decorate mode — the second half of `to-issues`). Idempotent and
   * additive: only the fields supplied in {@link AnnotatePatch} are written; an
   * omitted field is left exactly as it was, and every unmodeled field/section
   * the issue already carries is preserved (the same surgical-write discipline
   * as {@link transition}/{@link close}). A supplied `files`/`acceptanceCriteria`
   * REPLACES the modeled list (decorate writes the full set it computed).
   *
   * `risk`/`worker` are written exactly as {@link create} writes them — same
   * vocabulary expectations, same (non-)validation. Touches ONLY the modeled
   * Header-Block content: never the claim ledger, never the open/closed state,
   * never the eligibility line. Throws on an unknown id.
   *
   * Decorate assumes the triage-ready target already carries `Blocked by` (the
   * ADR-0010 template contract); {@link AnnotatePatch} deliberately omits it, so
   * annotating an issue that lacks `Blocked by` will not by itself yield a
   * DOR-passing result.
   */
  annotate(id: string, patch: AnnotatePatch): Promise<void>;

  /**
   * Amend an issue's AUTHORED content (the Amend facet, ADR-0025): the
   * human-facing title and/or free-prose `## <heading>` sections
   * (upsert-by-heading — see {@link AmendPatch}). The verb-less gap `annotate`
   * left: `annotate` already surgically replaces the modeled Files/AC lists and
   * *appends* prose, but has no path to change the title or to REPLACE an
   * existing prose section (its append duplicates the heading, which the read
   * path then silently shadows).
   *
   * Validates the WHOLE patch before any write (no partial application, like
   * {@link applyTriage}) — an empty patch, a blank section heading, or a
   * reserved-heading section all throw before anything is written. Surgical:
   * every unmodeled line/section is preserved. Touches ONLY the title + free
   * prose — never the Header-Block fields (Files/AC/Blocked by belong to
   * `annotate`), never the claim ledger, never the triage dimension, never the
   * open/closed state. Throws on an unknown id, a reserved heading, or an empty
   * patch.
   *
   * Concurrency: the GitHub/Linear read-modify-write is **last-writer-wins** —
   * the same accepted class as `annotate` today; documented, not solved.
   */
  amend(id: string, patch: AmendPatch): Promise<void>;

  /**
   * Project the tracker-native representation onto the canonical `IssueView`
   * (CHARTER §5). `status` is the COARSE projection (one of the 6
   * `CoarseState`s), never the engine's fine state. `acceptanceCriteria[].checked`
   * is surfaced for human visibility but is **cosmetic** — AC-met truth is the
   * reviewer verdict (ADR-0004). Throws on an unknown id or a malformed header
   * (no silent skip, no partial view).
   */
  read(id: string): Promise<IssueView>;

  /**
   * Write ONE coarse claim-ledger rung. Accepts only the three written rungs;
   * `available`/`done` are derived bookends and are rejected. Idempotent (the
   * WAL re-projection property, ADR-0002) and mutually exclusive (writing
   * `in-flight` clears `queued`). Touches ONLY the claim ledger — never the
   * issue's lifecycle/eligibility line, never the open/closed state.
   */
  transition(id: string, rung: ClaimRung): Promise<void>;

  /**
   * Release the claim: drop the `wave/*` rung so the issue returns to the
   * eligible pool (CHARTER §6).
   *
   * Releases **any rung → available**, not just `queued` (ADR-0022 §Decisions 2).
   * Fired on every plan-time drop (DOR-fail, conflict-drop, slug-collision,
   * draft-abort) — those all sit at `queued` — and on the `parked` disposition,
   * whose `failed → parked` entry edge releases a claim sitting at **in-flight**.
   * `coarse('parked') === null` is executed by the write path as exactly this
   * call. Idempotent — a no-op if the issue carries no claim.
   *
   * Distinct from `needs-attention` (an in-flight problem); this is a clean
   * re-plannable release.
   */
  unclaim(id: string): Promise<void>;

  /**
   * Raise the orthogonal **needs-attention** flag (ADR-0006). NOT a claim rung —
   * it overlays the rung: a flagged issue reads back `status: 'needs-attention'`
   * (which takes precedence over queued/in-flight/in-review in `read()`), while
   * the underlying claim is preserved so {@link clearFlag} can restore it. The
   * {@link NeedsAttentionPayload} (the recoverable-stop / terminal-failure kind
   * + the human question + the option set) is recorded for the headless-async
   * bridge. Idempotent (re-flagging overwrites the payload, status stays
   * needs-attention). Throws on an unknown id.
   *
   * GitHubIssuesStore: a `wave/needs-attention` label (orthogonal to the
   * `wave/<rung>` claim) + the payload as a structured issue comment.
   * MarkdownFsStore: a `**Needs-Attention:**` header line + a `## Needs-Attention`
   * payload block (surgical-edit, unmodeled fields preserved).
   */
  flag(id: string, payload: NeedsAttentionPayload): Promise<void>;

  /**
   * Clear the needs-attention flag (ADR-0006). Idempotent — a no-op if the issue
   * is not flagged. After clearing, `read().status` re-derives the underlying
   * coarse state (the preserved `wave/<rung>` claim re-surfaces, else
   * `available`). Throws on an unknown id.
   */
  clearFlag(id: string): Promise<void>;

  /**
   * Record the closing facts: `closedBy = prUrl` and a **best-effort cosmetic**
   * tick of the reviewer-acked ACs (`ackedAcIndexes` — stable AC indexes from
   * the reviewer verdict, ADR-0004; an unmatched index is a no-op, never an
   * error). Clears any `wave/*` claim rung. Writes **no** `wave/done` rung
   * (`done` is a derived bookend, ADR-0005).
   *
   * close() MUST NOT assume it is the agent that flips the issue closed.
   * `MarkdownFsStore` performs the native close locally (git mv → `done/`);
   * `GitHubIssuesStore` is no-op-or-reconcile — the merged PR's `Closes #N`
   * performs the native close out of band, possibly post-session. The
   * `done` derivation lives in {@link read}'s contract (status derives from the
   * native open/closed state *however* it was reached), not here.
   *
   * `ackedAcIndexes` is the ONLY review-derived value the store touches, and
   * only for cosmetic ticking — the store never re-reads or re-validates it as
   * AC authority (ADR-0004/0008).
   */
  close(id: string, prUrl: string, ackedAcIndexes: number[]): Promise<void>;

  /**
   * Probe how this issue was CLOSED (ADR-0005): `open`, `merged` (with the
   * closing PR url), or `closed-unmerged`. This is the precise signal the coarse
   * `done` projection deliberately discards (ADR-0002) — the resume
   * done-reconcile needs merged-vs-unmerged to decide whether a `done` row is a
   * real landing or an abandoned slice. Feeds the downstream `classifyClosedBy`
   * predicate. Throws on an unknown id.
   *
   * GitHubIssuesStore: queries the issue's closing PR merge-state through the
   * {@link GitHubApi} seam (NEVER raw `gh`). MarkdownFsStore: derives from the
   * file's done-state + the `**Closed-by:**` annotation (a recorded PR ref ⇒
   * merged, a done file without one ⇒ closed-unmerged).
   */
  readClosing(id: string): Promise<ClosingState>;

  /**
   * Draw the candidate set: OPEN issues passing the eligibility OR-set
   * (ADR-0003), minus any already carrying a `wave/*` claim. Returns full
   * `IssueView`s (wave-plan needs `files[]`/`risk` for the conflict-map
   * immediately). Only wave-plan calls this; the spine never does.
   */
  listOpen(scope: ListScope): Promise<IssueView[]>;

  /**
   * Every OPEN issue currently carrying a `wave/*` claim (queued / in-flight /
   * in-review). Feeds the cross-wave check (CHARTER §9): `(candidates ∪ claimed)`
   * → conflict-map answers "can this wave run alongside the running ones?".
   */
  listClaimed(): Promise<IssueView[]>;

  // ── Document facet (ADR-0011) — PRDs, not wave issues ──────────────────────

  /**
   * Publish a **PRD** as a tracker document and return its opaque id (ADR-0001,
   * same contract as {@link create}). Carries NO Header-Block and NO Eligibility
   * marker, so it never appears in {@link listOpen} — `create()` stays the
   * wave-slice contract. GitHub files it as an issue with a `prd` label;
   * MarkdownFs writes a `prd.md` beside the slug's `issues/` dir.
   */
  publishDocument(input: PublishDocumentInput): Promise<string>;

  /**
   * Read a published PRD back as raw prose (ADR-0011) — the input `to-issues`
   * slices from. NOT an `IssueView`: a PRD has no wave fields. Throws on an
   * unknown id.
   */
  readDocument(id: string): Promise<DocumentView>;

  /**
   * Every PRD this store can see. Consumed by `wave-plan`'s separate planning-doc
   * panel (never the wave candidate set). The PRD's *consumed* status is derived
   * by the caller from the `parent` backlinks on wave issues, not stored here.
   */
  listDocuments(): Promise<DocumentView[]>;

  // ── Triage facet (ADR-0015) — the issue-side lifecycle, tracker-agnostic ────

  /**
   * Read the triage projection of an issue: current state, category, and posted
   * comments (ADR-0015). SEPARATE from {@link read} — triage state never enters
   * `IssueView.status` (ADR-0003). Throws on an unknown id.
   */
  readTriage(id: string): Promise<TriageView>;

  /**
   * Apply a single-select triage outcome (ADR-0015): set state and/or category
   * (the adapter computes the native swap) and/or post a comment (the facet
   * prepends the AI-provenance disclaimer). Only supplied fields are written.
   * Validates every supplied state/category against the configured triage vocab
   * BEFORE any write (no partial application). Touches ONLY the triage dimension
   * — never the `wave/*` claim ledger, never the open/closed state. Throws on an
   * unknown id or an out-of-vocab state/category.
   */
  applyTriage(id: string, input: ApplyTriageInput): Promise<void>;

  /**
   * Terminate an issue as won't-be-actioned (ADR-0015): set the schema's
   * `unplannedState`, post `comment` (disclaimer-prepended), and natively close —
   * GitHub `close --reason not_planned`, MarkdownFs move to `done/`. After this,
   * `read().status` derives `done` and `readTriage().state` is the unplanned
   * state. Throws on an unknown id.
   */
  closeUnplanned(id: string, comment: string): Promise<void>;
}

/**
 * Adapter-supplied seams the shared conformance suite needs to drive both
 * targets through the same transitions without assuming a mechanism.
 */
export interface IssueStoreConformanceHooks {
  /**
   * Drive an issue into the **natively-closed** state the way the tracker
   * really would: `MarkdownFsStore` = the git mv already performed by close()
   * (a no-op-or-reconcile); `GitHubIssuesStore` = mark the issue closed as the
   * merged PR's `Closes #N` would. After this, `read().status` derives `done`.
   */
  simulateNativeClose(store: IssueStore, id: string): Promise<void>;
}

export type { IssueView, IssueRef };

/** The AI-provenance disclaimer the Triage facet prepends to every comment (ADR-0015). */
export const TRIAGE_DISCLAIMER = '> *This was generated by AI during triage.*';

/** Prepend the AI-provenance disclaimer to a triage comment body (ADR-0015). */
export function withTriageDisclaimer(body: string): string {
  return `${TRIAGE_DISCLAIMER}\n\n${body}`;
}
