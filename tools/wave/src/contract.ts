/**
 * contract.ts — the engine's canonical contracts.
 *
 * The engine never knows where an issue comes from; an adapter's whole job is
 * `read(id) → IssueView` (CHARTER §5). This module holds the types every adapter
 * must speak — the `IssueView` contract, the coarse claim-state projection
 * (CHARTER §6), and the config-supplied enum vocabulary (`WaveSchema`).
 *
 * Keystone of P1: the enum vocabulary lives in *config*, not in the parser.
 * `header-parser` ships the Ur's sets as `DEFAULT_WAVE_SCHEMA` built-in
 * defaults; a consumer supplies its own via `wave.config`.
 */

/**
 * A reference to another issue. Hoisted here (P2.0) so the engine contract owns
 * this pure data shape — the markdown `header-parser` (an adapter, CHARTER §4)
 * imports it *from* the contract, never the reverse. This keeps the dependency
 * arrow engine ← adapter and lets `header-parser` physically relocate later
 * without re-coupling the engine bundle to a relocated module.
 */
export interface IssueRef {
  /** Undefined for same-slug refs (`#NN`); set for cross-slug refs (`<slug>#NN`). */
  slug?: string;
  issue: number;
}

/** `'none'` or a resolved reference list — the parsed `**Blocked by:**` shape. */
export type BlockedBy = 'none' | IssueRef[];

/**
 * The coarse claim-state projected onto the tracker so humans and concurrent
 * waves see what is claimed (CHARTER §6). flotilla actively writes only the
 * `queued → in-flight → in-review` ledger; `available`/`done` are derived
 * bookends and `needs-attention` is an orthogonal flag (ADR-0003/0005).
 */
export type CoarseState =
  | 'available'
  | 'queued'
  | 'in-flight'
  | 'in-review'
  | 'done'
  | 'needs-attention';

/**
 * The three coarse rungs flotilla actively *writes* to the tracker (ADR-0002/0003).
 * `available`/`done` are derived bookends and `needs-attention` is orthogonal —
 * none of those are ever written, so they are not rungs.
 */
export type ClaimRung = 'queued' | 'in-flight' | 'in-review';

/**
 * The enum vocabulary a consumer supplies via `wave.config`. The engine treats
 * these as opaque membership tokens (ADR-0003 philosophy) — it validates
 * membership, never meaning.
 *
 * For M1 `riskValues` stays the Ur's frozen set (its strings are load-bearing
 * for the state machine / routing / the hard-STOP — ADR-0007); only `workerValues`
 * is freely trimmable. The Ur's sets ship as {@link DEFAULT_WAVE_SCHEMA}.
 */
export interface WaveSchema {
  readonly riskValues: readonly string[];
  readonly workerValues: readonly string[];
}

/**
 * The canonical contract the engine reads (CHARTER §5). The adapter maps its
 * tracker-native shape onto this; the engine consumes only this.
 *
 * `risk`/`worker` are typed `string` — their valid vocabulary is config-governed
 * (validated at runtime via {@link validateHeaderBlock}), not a compile-time
 * union, so the contract stays tracker-agnostic.
 */
export interface IssueView {
  /** Opaque tracker-native identifier; the engine never parses or orders it (ADR-0001). */
  id: string;
  /** Config-governed vocab — see {@link WaveSchema.riskValues}. */
  risk: string;
  /** Config-governed vocab — see {@link WaveSchema.workerValues}. */
  worker: string;
  /** Globs / paths — the conflict-map input. */
  files: string[];
  blockedBy: 'none' | IssueRef[];
  unblocks?: IssueRef[];
  /**
   * Backlink to the PRD this slice was sliced from (ADR-0011); derives the PRD's
   * consumed-state. The PRD's **opaque id string** (ADR-0013), NOT an `IssueRef`:
   * `parent` references a document's identity (which the engine never parses),
   * not a resolvable wave issue — and a markdown PRD's `<slug>#prd` id isn't
   * `IssueRef`-representable anyway. Consumed = exact id match across slices.
   */
  parent?: string;
  /**
   * `checked` from a tracker read is cosmetic; AC-met *truth* is the reviewer's
   * schema-validated verdict, not the (remote, un-tickable) checklist (ADR-0004).
   */
  acceptanceCriteria: { text: string; checked: boolean }[];
  status: CoarseState;
  /** PR ref that closes this issue, once known. */
  closedBy?: string;
  estimatedWallclock?: string;
}

/** Field subset whose vocabulary is governed by a {@link WaveSchema}. */
export interface SchemaGovernedFields {
  risk: string;
  worker: string;
}

export interface HeaderValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Predicate: do an issue's schema-governed fields (`risk`, `worker`) belong to
 * the supplied vocabulary? Structurally accepts both a `HeaderBlock` (adapter
 * output) and an `IssueView` (engine contract). The enum vocabulary lives in
 * config, not the code (CHARTER §4).
 */
export function validateHeaderBlock(
  input: SchemaGovernedFields,
  schema: WaveSchema,
): HeaderValidation {
  const errors: string[] = [];
  if (!schema.riskValues.includes(input.risk)) {
    errors.push(
      `"${input.risk}" is not a valid Risk value. Expected one of: ${schema.riskValues.join(' | ')}.`,
    );
  }
  if (!schema.workerValues.includes(input.worker)) {
    errors.push(
      `"${input.worker}" is not a valid Worker value. Expected one of: ${schema.workerValues.join(' | ')}.`,
    );
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The triage vocabulary a consumer supplies via `wave.config` (ADR-0015). The
 * SHAPE (a single-select lifecycle with eligibility-marking terminal states) is
 * flotilla's; the VOCABULARY is the consumer's. The wave-routing core never
 * reasons over these beyond the eligibility OR-set; the full set is known/typed
 * so analytics can read it. The default set ships as {@link DEFAULT_TRIAGE_SCHEMA}.
 */
export interface TriageSchema {
  /** Canonical state vocabulary (single-select lifecycle). */
  readonly states: readonly string[];
  /** Canonical category vocabulary (single-select). */
  readonly categories: readonly string[];
  /** Entry state a freshly-filed issue carries. */
  readonly entryState: string;
  /**
   * The subset of `states` that mark an issue wave-eligible (ADR-0003). Their
   * native strings must equal the store's eligibility OR-set tokens.
   */
  readonly eligibilityStates: readonly string[];
  /** The terminal "won't be actioned" state {@link IssueStore.closeUnplanned} applies. */
  readonly unplannedState: string;
}

/** Default triage vocabulary (overridable in wave.config — ADR-0015). */
export const DEFAULT_TRIAGE_SCHEMA: TriageSchema = {
  states: ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'],
  categories: ['bug', 'enhancement'],
  entryState: 'needs-triage',
  eligibilityStates: ['ready-for-agent'],
  unplannedState: 'wontfix',
};

/** One posted triage comment, read back. `body` includes the AI-provenance disclaimer. */
export interface TriageComment {
  body: string;
}

/**
 * The triage projection of an issue (ADR-0015) — SEPARATE from {@link IssueView},
 * which never carries triage state (ADR-0003 keeps it out of `IssueView.status`).
 */
export interface TriageView {
  id: string;
  /**
   * The issue's human-facing title — the report the agent triages (ADR-0015).
   * Carried here (not on {@link IssueView}, which is wave-header-only) so triage
   * reads the report through the facet, never a raw `gh issue view`.
   */
  title: string;
  /**
   * The issue's body — the reported content below the title, read through the
   * facet. Representation-shaped, not normalized: on a store that encodes wave
   * fields inline (MarkdownFs's `**Status:**`/`**Risk:**` header lines), those
   * lines are part of `body`; on GitHub they live in labels and are absent. The
   * guarantee is that the human-readable report is present, not byte-identity.
   */
  body: string;
  /** Current triage state (undefined if the issue carries none yet). */
  state?: string;
  /** Current category (undefined if none). */
  category?: string;
  /** Posted triage comments, oldest-first. */
  comments: TriageComment[];
}

/** The single-select, intent-shaped patch {@link IssueStore.applyTriage} writes (ADR-0015). */
export interface ApplyTriageInput {
  /** Set the lifecycle state (single-select; the adapter computes the native swap). */
  state?: string;
  /** Set the category (single-select). */
  category?: string;
  /** Post a comment; the facet prepends the AI-provenance disclaimer. */
  comment?: string;
}
