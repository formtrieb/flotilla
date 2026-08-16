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
import type { GoalBlocker, GoalFrontier, GoalMemberState } from '../goal-frontier';
import { GOAL_MEMBER_STATES } from '../goal-frontier';

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
 *
 * **Two shapes, one type (ADR-0027).** `create` serves two filing paths:
 *
 * - **decorated** — the `to-issues` slicing path. Every wave Header-Block field
 *   (`risk`, `worker`, `files`, `blockedBy`, `acceptanceCriteria`) is supplied,
 *   and the store stamps the eligibility marker: a wave-ready issue.
 * - **bare** — ADR-0027's `filed:` disposition. Title, gap description and
 *   provenance line only (the prose rides `bodySections`), **deliberately**
 *   with no eligibility marker and no Header-Block: existence and wave-readiness
 *   are separate steps, and readiness comes later through `to-issues`
 *   decorate-mode ({@link IssueStore.annotate}) with the next wave's planning
 *   context. Before this the sole sanctioned write path forced decoration at
 *   filing time, so four bare finding-issues in one day were filed through the
 *   host CLI, outside the engine seam.
 *
 * The five Header-Block fields are therefore optional **as a group**: present
 * together (decorated) or absent together (bare). A PARTIAL set is neither — it
 * is a half-written Header-Block, and {@link classifyCreateInput} rejects it
 * before any adapter write. Absent and broken are different claims; only the
 * first is a bare issue.
 *
 * **The one sanctioned exception: `blockedBy` (ADR-0044 decision 1).** A bare
 * input MAY carry `blockedBy` alone, and that is not a half-written header —
 * because on a bare issue `blockedBy` is not realized as a header LINE at all.
 * It is realized NATIVELY per adapter (a GitHub issue dependency, a Linear
 * issue relation), so the bare invariant is untouched: still no Header-Block,
 * still no eligibility marker. The goal station needs exactly this: at a goal's
 * cut you know *that* workstream B waits on workstream A before either is
 * specifiable, and until now no write path existed for a dependency between two
 * bare issues. A store whose storage CANNOT represent that natively refuses
 * loudly (`'bare-blocked-by-unrepresentable'`) rather than faking it — the
 * `closed-unknown` precedent, applied to the write side.
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
  /** config-governed vocab (validate via validateHeaderBlock); omit for a BARE create. */
  risk?: string;
  /** config-governed vocab; omit for a BARE create. */
  worker?: string;
  /** globs/paths, annotation-free; omit for a BARE create. */
  files?: string[];
  /**
   * Refs already resolved to real tracker ids. ADR-0001's two-pass create
   * (resolve intra-batch blockers first) is the **caller's** job — the store
   * validates ref *format*, never ref *existence*. `'none'` is the explicit
   * "no blockers" DECORATED value, not an omission.
   *
   * **The one Header-Block field a BARE create may also carry** (ADR-0044): on
   * a bare input it is realized NATIVELY (GitHub issue dependency / Linear
   * relation), never as a `**Blocked by:**` header line, so it does not make the
   * issue half-decorated. `'none'` and `[]` on a bare input declare nothing to
   * realize and are equivalent to omitting the field.
   */
  blockedBy?: 'none' | IssueRef[];
  unblocks?: IssueRef[];
  /**
   * Backlink to the **PRD** this slice was sliced from (ADR-0011). The PRD's
   * **opaque id string** (ADR-0013), NOT an `IssueRef` — `parent` references a
   * document's identity, passed verbatim as the id the Document facet minted.
   * The single source the PRD's *consumed* status is derived from (exact id
   * match) — never a written PRD-side state.
   */
  parent?: string;
  /**
   * All `checked:false` at creation; serialized as `- [ ]` task-list items.
   * Omit for a BARE create — a bare issue carries NO acceptance-criteria
   * section, rather than an empty one fabricated from nothing.
   */
  acceptanceCriteria?: { text: string; checked: boolean }[];
  estimatedWallclock?: string;
  /**
   * Free-prose body sections (Parent, What to build, …) written verbatim.
   *
   * Optional for a DECORATED input (its Header-Block is already a body), but
   * **required with non-blank content for a BARE one** — there it IS the whole
   * authored body, so {@link classifyCreateInput} rejects a bare input whose
   * `bodySections` is absent, `[]`, or all-blank (#278/#309).
   */
  bodySections?: { heading: string; markdown: string }[];
}

/**
 * The wave Header-Block fields on {@link CreateInput} — all-present (decorated)
 * or all-absent (bare), never a partial set. See {@link classifyCreateInput}.
 */
export const HEADER_BLOCK_FIELDS = [
  'risk',
  'worker',
  'files',
  'blockedBy',
  'acceptanceCriteria',
] as const;

/**
 * Fields that only make sense ALONGSIDE a Header-Block: `unblocks` is a
 * Header-Block ref list, `parent`/`estimatedWallclock` are managed metadata
 * lines the bare body deliberately does not carry. Supplying one on an
 * otherwise-bare input is the same half-written-header mistake as a partial
 * {@link HEADER_BLOCK_FIELDS} set, so it is rejected the same way.
 */
const DECORATION_ONLY_FIELDS = ['unblocks', 'parent', 'estimatedWallclock'] as const;

/**
 * The Header-Block fields that must ALL be absent for an input to be bare —
 * {@link HEADER_BLOCK_FIELDS} minus `blockedBy`, ADR-0044's one sanctioned bare
 * arm. Derived from `HEADER_BLOCK_FIELDS` rather than re-spelled, so a sixth
 * Header-Block field added tomorrow joins the must-be-absent set automatically.
 */
const BARE_MUST_BE_ABSENT = HEADER_BLOCK_FIELDS.filter((f) => f !== 'blockedBy');

/**
 * Which whole-input invariant a {@link CreateInputError} is about. A closed
 * union so a caller routes on the discriminant rather than on message text
 * (the {@link EngineCliBindingError} stance, ADR-0032/ADR-0029 fail-loud).
 *
 * - `header-block-half-written` — SOME of {@link HEADER_BLOCK_FIELDS} supplied.
 * - `bare-carries-decoration-only-fields` — a bare input with a
 *   {@link DECORATION_ONLY_FIELDS} stowaway.
 * - `bare-without-body` — a bare input whose `bodySections` carries no authored
 *   content at all (absent, `[]`, or every entry's `markdown` blank) **or**
 *   whose `bodySections` carries an entry that is present but malformed — a
 *   missing/blank/non-string `heading`, or a missing/non-string `markdown`
 *   (#530). Both are the same claim at bottom ("this bare issue does not
 *   actually have the authored body it needs"), so they share the
 *   discriminant; {@link CreateInputError.fields} still tells them apart —
 *   `['bodySections']` for the no-content case, the dotted per-entry path
 *   (e.g. `['bodySections[0].heading']`) for a malformed entry.
 * - `bare-blocked-by-unrepresentable` — the ONE member NOT raised by
 *   {@link classifyCreateInput}. The classifier is store-agnostic and so
 *   accepts ADR-0044's bare `blockedBy` arm unconditionally; whether the
 *   requested dependency can be realized NATIVELY is a per-store question, so
 *   the ADAPTER raises this — before it writes anything — when its storage
 *   cannot represent the edge (`MarkdownFsStore`: any bare `blockedBy`, since
 *   its only blocker representation IS the Header-Block line a bare issue must
 *   not have; `GitHubIssuesStore`: a cross-REPO ref, since the dependency
 *   endpoints are repo-scoped). It is a genuinely different routing answer from
 *   the three above — "fix the input" vs "this store cannot do it" — which is
 *   why it earns its own discriminant instead of being folded into
 *   `bare-carries-decoration-only-fields`. `fields` is always `['blockedBy']`.
 */
export type CreateInputFailure =
  | 'header-block-half-written'
  | 'bare-carries-decoration-only-fields'
  | 'bare-without-body'
  | 'bare-blocked-by-unrepresentable';

/**
 * The typed rejection {@link classifyCreateInput} throws — and, for the one
 * store-capability member (`'bare-blocked-by-unrepresentable'`, ADR-0044), that
 * an ADAPTER throws from `create()` before it writes anything. Structured on
 * purpose: `failure` names WHICH invariant broke and `fields` names the
 * {@link CreateInput} fields it is about, so a caller (the issue-store CLI, a
 * skill driver, any future one) can classify the rejection — usage-error vs
 * domain-failure, which field to re-author — without string-matching a prose
 * message. The message stays the human-facing rendering, not the contract.
 *
 * Every caller inherits the rejection because every adapter runs the classifier
 * as the FIRST statement of `create()`: the rule cannot be reached around by
 * calling a store directly instead of through the CLI.
 *
 * **PUBLIC API (issue #325).** This class and {@link CreateInputFailure} are
 * re-exported from the package root (`../index`) and pinned there by
 * `index.spec.ts`. The decision is recorded here because the alternative was
 * live: a programmatic consumer could have been expected to catch a generic
 * `Error` and read its message. It is not, and the sentence above is why — the
 * rejection is INHERITED by every root-only consumer that calls `create()`
 * through a `buildStore` handle, so it was already something such a consumer
 * receives and, until now, could not name. Naming it is the whole point of the
 * structure: `instanceof` across the barrel, then route on `failure`. That works
 * only if the root-imported class is the SAME binding the adapters throw, which
 * the root pairing spec asserts by identity, not by behaviour. Same fail-loud,
 * do-not-match-on-message stance as `CredentialResolutionError` (ADR-0029) and
 * `EngineCliBindingError` (ADR-0032), which are root-exported for this reason.
 */
export class CreateInputError extends Error {
  readonly name = 'CreateInputError';
  readonly code = 'create-input-invalid';
  constructor(
    /** Which whole-input invariant this rejection is about. */
    readonly failure: CreateInputFailure,
    /**
     * The {@link CreateInput} field names this rejection names — the missing
     * Header-Block fields, the stowaways, `['bodySections']`, or (a malformed
     * entry within an otherwise-present `bodySections`, #530) the dotted
     * per-entry path, e.g. `['bodySections[0].heading']`. Field NAMES/PATHS
     * only: never the authored values, which are the caller's content.
     */
    readonly fields: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Does a BARE create's `bodySections` actually carry authored content? A bare
 * issue has NO Header-Block to fall back on — `bodySections` IS its entire body
 * — so "absent", "`[]`", and "present but every entry's `markdown` is blank"
 * are the same failure: a filed issue with 0 body chars.
 *
 * Deliberately NOT exported. The invariant is the classifier's (below), and a
 * shared predicate is exactly what let the rule live at one caller (the CLI)
 * while the classifier that decides "this is a bare issue" declined to check
 * the one field a bare issue depends on entirely. One owner, one seam: a caller
 * that wants this answer asks {@link classifyCreateInput}.
 */
function hasBareBodyContent(sections: CreateInput['bodySections']): boolean {
  return (
    Array.isArray(sections) &&
    sections.length > 0 &&
    sections.some((s) => s.markdown.trim().length > 0)
  );
}

/**
 * Validate the SHAPE of every entry a BARE create's `bodySections` actually
 * supplies, before {@link hasBareBodyContent} — or any adapter's serializer —
 * ever reads a field off one. A bare issue's `bodySections` IS its entire
 * body, so every present entry must already be a well-formed
 * `{ heading: string, markdown: string }`; that is a DIFFERENT claim from
 * "carries authored content", which is {@link hasBareBodyContent}'s question
 * and stays untouched here.
 *
 * Checked per entry:
 * - `heading` — must be a non-blank string. Missing, blank (whitespace-only),
 *   or non-string all fail: every adapter's serializer reads `heading`
 *   unconditionally (`` `## ${s.heading}` ``, `RESERVED_SECTIONS.includes(
 *   s.heading.trim()…)` ), so an entry with `markdown` present and non-blank
 *   but `heading` absent sails straight past {@link hasBareBodyContent} — it
 *   correctly sees authored content — and crashes three frames later inside a
 *   tracker adapter's body-codec with a raw `TypeError`, not a typed refusal
 *   (#530, the live symptom this closes).
 * - `markdown` — must be a string. Missing or non-string fails here, because
 *   {@link hasBareBodyContent} calls `.trim()` on it unconditionally and would
 *   crash the same raw way. A markdown that IS a string but blank/whitespace
 *   is deliberately left alone — that is a content question, answered by
 *   {@link hasBareBodyContent} below (spec-pinned unchanged: all-blank
 *   `markdown` across every entry, and the "one non-blank section is enough"
 *   case, both stay exactly as they were).
 *
 * Throws the SAME {@link CreateInputFailure} discriminant,
 * `'bare-without-body'`, that an absent/empty/all-blank `bodySections`
 * already throws — the fix direction's "same teaching shape the
 * missing-bodySections error already has" — rather than minting a new public
 * union member: both claims reduce to "this bare issue does not actually have
 * the authored body it needs," just discovered at a different granularity.
 * {@link CreateInputError.fields} still lets a caller tell them apart: plain
 * `['bodySections']` for "no content anywhere," the dotted per-entry path
 * (e.g. `['bodySections[0].heading']`) for "this one entry is malformed."
 *
 * Deliberately NOT exported, same reasoning as {@link hasBareBodyContent}: one
 * owner — the classifier — checks the shape of a bare issue's entire body, so
 * every caller of every adapter's `create()` inherits the refusal without a
 * per-adapter check.
 */
function validateBareBodySectionsShape(sections: CreateInput['bodySections']): void {
  if (!Array.isArray(sections)) return;
  sections.forEach((entry, index) => {
    const headingOk = typeof entry?.heading === 'string' && entry.heading.trim() !== '';
    const markdownOk = typeof entry?.markdown === 'string';
    if (headingOk && markdownOk) return;

    const badFields: string[] = [];
    const complaints: string[] = [];
    if (!headingOk) {
      badFields.push('heading');
      complaints.push('`heading` must be a non-blank string');
    }
    if (!markdownOk) {
      badFields.push('markdown');
      complaints.push('`markdown` must be a string');
    }

    throw new CreateInputError(
      'bare-without-body',
      badFields.map((f) => `bodySections[${index}].${f}`),
      `create: bodySections[${index}] is malformed — ${complaints.join(' and ')}. ` +
        `Every bodySections entry needs the shape ` +
        `{ heading: string, markdown: string }, e.g. ` +
        `{ heading: "Gap", markdown: "…the gap prose…" }.`,
    );
  });
}

/** A {@link CreateInput} whose whole wave Header-Block is present (the decorated path). */
export type DecoratedCreateInput = CreateInput &
  Required<Pick<CreateInput, (typeof HEADER_BLOCK_FIELDS)[number]>>;

/**
 * The classified shape of a {@link CreateInput}. Discriminated so the adapter's
 * decorated branch keeps working over a fully-typed input with no field-by-field
 * casts — the narrowing lives in {@link classifyCreateInput} alone.
 *
 * The bare arm carries ADR-0044's optional `blockedBy` **already normalized**:
 * present only when there is genuinely an edge to realize. `'none'` and `[]`
 * both collapse to an ABSENT key, so an adapter's bare branch asks one question
 * (`shape.blockedBy !== undefined`) rather than re-deriving "is there anything
 * here?" three ways — the same collapse `mirrorBlockedBy` already performs on
 * the decorated side.
 */
export type CreateShape =
  | { kind: 'bare'; blockedBy?: IssueRef[] }
  | { kind: 'decorated'; input: DecoratedCreateInput };

/**
 * Validate a {@link CreateInput} as a WHOLE and classify it — bare (ADR-0027's
 * undecorated filing) vs decorated (the `to-issues` slicing path). Pure; every
 * adapter calls it as the FIRST statement of `create()`, before any id is
 * minted and before any write, so a rejected input files nothing (the
 * {@link IssueStore.applyTriage} no-partial-application discipline).
 *
 * **Store-agnostic, deliberately.** ADR-0044's bare `blockedBy` arm is accepted
 * here unconditionally and returned normalized on {@link CreateShape}; whether
 * the requested edge can actually be realized NATIVELY is a per-store question
 * this function has no standing to answer, so the adapter raises
 * `'bare-blocked-by-unrepresentable'` for its own storage — still before any
 * write, so that rejection files nothing either.
 *
 * **Throws** a typed {@link CreateInputError} on a PARTIAL Header-Block (some of
 * {@link HEADER_BLOCK_FIELDS} supplied, some not — `blockedBy` alone is NOT
 * partial, see above), on a bare input carrying a
 * {@link DECORATION_ONLY_FIELDS} stowaway, on a bare input with no authored
 * body content, and on a bare input whose `bodySections` carries a malformed
 * entry — a missing/blank `heading` or a missing `markdown` (#530). All four
 * are the same fail-loud stance the body-codec takes on a present-but-
 * unparseable `## Blocked by`: an ABSENT Header-Block is a legitimate claim
 * ("this is a bare issue"), a BROKEN one is not, and silently completing a
 * half-written header (or a half-written body-section entry) would mint a
 * wave-eligible issue out of a caller bug.
 *
 * **Why the body requirement lives HERE (#309).** It arrived as a predicate at
 * the issue-store CLI, applied to whatever this function classified as bare —
 * which worked, but left the classifier deciding "this is a bare issue" while
 * declining to check the one field a bare issue depends on entirely, and left
 * the rule reachable around by any non-CLI caller of `create`. The classifier is
 * the seam every adapter already runs first, before an id is minted and before
 * any write, so moving the requirement here makes it a property of the create
 * contract rather than of one entrypoint. The CLI keeps only the RENDERING of
 * the rejection (its exit-code choice and its message); the rule is inherited.
 *
 * **Deliberately NOT public API (issue #325)**, unlike the
 * {@link CreateInputError} it throws. Recorded here so the asymmetry reads as a
 * decision rather than an oversight, and the paragraph above is the reason: this
 * function runs as the first statement of every adapter's `create()`, so a
 * root-only consumer that calls `create()` has already had it run. Calling it by
 * hand first would be asking a question the write path answers on that
 * consumer's behalf, and a hand-run pre-check that can drift from the write path
 * is worse than no pre-check at all — that drift is exactly what #309 moved the
 * body rule here to end. What a root-only consumer needs is to CATCH the
 * rejection typed, which the root export of {@link CreateInputError} gives it.
 */
export function classifyCreateInput(input: CreateInput): CreateShape {
  const missing = HEADER_BLOCK_FIELDS.filter((f) => input[f] === undefined);

  if (missing.length === 0) {
    return { kind: 'decorated', input: input as DecoratedCreateInput };
  }

  // BARE — every Header-Block field absent EXCEPT the one ADR-0044 sanctions:
  // `blockedBy` may ride alone, because a bare issue realizes it natively (a
  // GitHub issue dependency, a Linear relation) rather than as the
  // `**Blocked by:**` header line it would be on a decorated issue. So the
  // membership test is over BARE_MUST_BE_ABSENT (the other four), not over all
  // five: an input carrying `blockedBy` and nothing else is a bare issue with a
  // dependency, NOT a header missing four fields.
  if (missing.filter((f) => f !== 'blockedBy').length === BARE_MUST_BE_ABSENT.length) {
    const stowaways = DECORATION_ONLY_FIELDS.filter((f) => input[f] !== undefined);
    if (stowaways.length > 0) {
      throw new CreateInputError(
        'bare-carries-decoration-only-fields',
        stowaways,
        `create: a BARE issue carries no Header-Block, so it cannot carry ` +
          `${stowaways.map((f) => `\`${f}\``).join(', ')} either. Either file it bare ` +
          `(title + filingHint + bodySections only) and decorate it later via ` +
          `\`annotate\`, or supply the full Header-Block ` +
          `(${HEADER_BLOCK_FIELDS.join(', ')}) now.`,
      );
    }
    // #530: a bare issue's `bodySections` entries must already be well-formed
    // before anything asks whether they carry content — a malformed entry
    // (missing/blank `heading`, missing `markdown`) is a shape bug, not a
    // "no content" claim, and the content check below cannot safely tell the
    // two apart (it calls `.trim()` on `markdown` unconditionally). Checked
    // BEFORE `hasBareBodyContent` so every caller gets a typed, teaching
    // refusal instead of a raw `TypeError` — either right here, or three
    // frames later inside a tracker adapter's serializer.
    validateBareBodySectionsShape(input.bodySections);
    // #278's requirement, at its root (#309): a bare issue's `bodySections` IS
    // its entire authored content, so an absent/empty/all-blank one would file
    // an issue with literally nothing in its body (measured: ten dispositions
    // from one wave landed on the tracker with 0 body chars). Checked here, in
    // the same breath as the shape decision, so every caller of every store
    // inherits it — not only the one that goes through the CLI. A DECORATED
    // input is deliberately untouched by this: it carries a Header-Block, so
    // its body is never empty even with no prose sections at all.
    if (!hasBareBodyContent(input.bodySections)) {
      throw new CreateInputError(
        'bare-without-body',
        ['bodySections'],
        'create: a BARE issue (no Header-Block) carries its ENTIRE authored ' +
          'content in `bodySections` — an absent, empty, or all-blank ' +
          '`bodySections` would file an issue with no body at all. Supply at ' +
          'least one `bodySections` entry with non-blank `markdown` (e.g. Gap ' +
          '+ Provenance), or supply the full Header-Block for a decorated issue.',
      );
    }
    // ADR-0044's bare `blockedBy` arm, normalized on the way out: `'none'` and
    // `[]` declare nothing to realize, so they collapse to an absent key and the
    // bare create is byte-for-byte the one that shipped before this arm existed.
    // Only a non-empty ref list reaches an adapter's native-dependency write.
    const blockedBy = input.blockedBy;
    if (blockedBy !== undefined && blockedBy !== 'none' && blockedBy.length > 0) {
      return { kind: 'bare', blockedBy };
    }
    return { kind: 'bare' };
  }

  throw new CreateInputError(
    'header-block-half-written',
    missing,
    `create: the wave Header-Block is half-written — missing ` +
      `${missing.map((f) => `\`${f}\``).join(', ')}. Supply the whole block ` +
      `(${HEADER_BLOCK_FIELDS.join(', ')}) for a decorated issue, or NONE of it ` +
      `for a bare one (ADR-0027) — an absent header and a broken header are ` +
      `different claims.`,
  );
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

// ── Goal facet (ADR-0044 / ADR-0045) — the finish line, bound to a container ─
//
// A **Goal** is a named finish line whose members are the DIRECT native members
// of ONE native container, joined by curation (ADR-0045 decision 1 — issues for
// the three issue-direct roles, projects for a Linear Initiative; never a
// flattening query). It earns a facet here rather than living as
// skill prose over a host CLI, and the reversal is recorded: the 2026-07-31 note
// "milestones are a product artifact, deliberately outside the seam" was true
// for a maintainer's hand-driven cut on one tracker (ambient `gh` auth, a human
// deciding every step) and flips for a shipped skill. Three facts flip it —
// Linear writes must flow through the Credential-Resolver (Convention 8,
// ADR-0029), so a skill cannot raw-call Linear at all; the raw-`gh`-in-skill
// defect class was already paid for once and structurally retired by the Triage
// facet (ADR-0015); and MarkdownFs has no native container, so the facet IS its
// realization.
//
// The verb set is minimal and READ-HEAVY: mint/read the container, join a member
// by curation, and derive the frontier. Two absences are decisions, not gaps,
// and both are pinned by the facet's own conformance suite rather than left to
// be noticed:
//
//  - **No dispatch verb, ever.** Goal membership informs planning and authorizes
//    nothing — sight, never permission. A planning artifact that granted
//    execution rights is precisely the measured Wayfinder hole (a prose
//    planning/execution boundary that seven PRs walked straight through); the
//    Eligibility OR-set plus the DoR gate stay the only gate.
//  - **No `closeGoal`.** Completion is `frontier.open` being empty, which
//    {@link IssueStore.readGoalFrontier} REPORTS; closing the container is the
//    Operator's act in the tracker. The station owes accounting, never the
//    declaration (ADR-0042's sentence, one station over).
//
// ── ID-SPACE HAZARD: a goal id and an issue id are NOT the same kind of thing ─
//
// Every verb below takes BOTH kinds of id, and they belong to two SEPARATE
// opaque spaces (ADR-0001, applied twice over): a goal id names a CONTAINER, an
// issue id names a MEMBER. Neither is parsed by the engine, and neither is
// comparable to the other. Stated here rather than left to be discovered,
// because the failure mode is the quiet one:
//
//  - **They collide BY VALUE on GitHub.** A goal id is the milestone's
//    `number` and an issue id is the issue's `number`, both stringified — so
//    goal `'1'` and issue `'1'` are the same three bytes and different things.
//  - **And on no other store.** MarkdownFs keeps the spaces visibly apart
//    (`probe#goal-01` vs `probe#01`) and Linear hands out distinct UUIDs. So a
//    bare `goalId === issueId` comparison reads FALSE on two of three stores
//    and can read TRUE on the third — a bug that passes its own test suite on
//    the majority of adapters and misfires only on the shipped default.
//
// The rule that follows: **a comparison must carry the space, never just the
// value.** A goal id is only ever compared against another goal id
// ({@link GoalView.id}); a member id only ever against
// {@link GoalView.memberIds} or a {@link GoalFrontier} entry. Nothing in the
// engine performs a cross-space comparison today — this is recorded BEFORE a
// consumer of the frontier query trips it, not after.

/**
 * The native container roles a Goal can be realized as (ADR-0044 decision 4).
 * A closed union, not a free string, for the same reason {@link ListScope} is
 * one: a consumer must not be able to smuggle a container assumption into the
 * engine.
 *
 * `initiative` was DECLARED-but-unrealized in ADR-0044 and is REALIZED — on the
 * Linear store, and only there — by ADR-0045. It is also the one role whose
 * members are not issues: an initiative holds PROJECTS, so under that binding
 * every member id in this facet is a project id. See {@link GoalMemberKind}.
 * The other three stores still answer an `initiative` binding with
 * {@link GoalBindingError} `failure: 'unrealized-container'`, which is what
 * keeps "GitHub has no initiative" a named refusal rather than a silent cap.
 */
export type GoalContainer = 'milestone' | 'project' | 'initiative' | 'goal-file';

/** The container vocabulary as data — the membership test {@link parseGoalContainer} applies. */
export const GOAL_CONTAINERS: readonly GoalContainer[] = [
  'milestone',
  'project',
  'initiative',
  'goal-file',
];

/**
 * What KIND of thing a Goal's direct members are — the whole of ADR-0045
 * decision 1 in one type. A Goal's members are the bound container's **direct
 * native members**, never a flattening query, so the member kind is a fact about
 * the BINDING and nothing else:
 *
 *  - `issue` for the three issue-direct roles (GitHub Milestone · Linear
 *    Project · MarkdownFs goal file) — byte-identical to what ADR-0044 shipped;
 *  - `project` for a Linear Initiative, which holds projects and not issues.
 *
 * The transitive read this replaced was falsified against the live consumer
 * workspace: 13 of 19 initiative-member projects there are EMPTY, so an
 * issue-flattening frontier would report a goal complete over unbuilt stories.
 * A member kind that follows the binding cannot make that mistake — an empty
 * project is a member, and reads `unready` for exactly the reason a bare ticket
 * does.
 */
export type GoalMemberKind = 'issue' | 'project';

/**
 * Container role → the kind of its DIRECT members (ADR-0045 decision 1). Data
 * rather than a switch so every caller — contract, adapter, conformance suite —
 * reads ONE mapping instead of three lookalikes, the same one-owner discipline
 * {@link requireGoalContainer} applies to the binding itself.
 */
export const GOAL_MEMBER_KIND_BY_CONTAINER: Readonly<
  Record<GoalContainer, GoalMemberKind>
> = {
  milestone: 'issue',
  project: 'issue',
  'goal-file': 'issue',
  initiative: 'project',
};

/** The kind of member a Goal bound to `container` holds (ADR-0045 decision 1). */
export function goalMemberKind(container: GoalContainer): GoalMemberKind {
  return GOAL_MEMBER_KIND_BY_CONTAINER[container];
}

/**
 * The typed refusal for a member id whose KIND does not follow the binding
 * (ADR-0045 decision 3). Structured for the same reason
 * {@link GoalBindingError} is: a caller routes on `expected`/`container`, never
 * on message text.
 *
 * It exists because of ONE concrete confusion, named in the grill: under an
 * initiative binding, "add this to the goal" most naturally reaches for the
 * ISSUE somebody is looking at, not the project that issue lives in. That call
 * site is precisely where the transitive misunderstanding ADR-0045 rejected
 * would otherwise pass silently — an issue id would resolve to nothing, or
 * (worse) to some unrelated object — so it refuses BEFORE any write, naming
 * both what it got and what the binding wants.
 *
 * **PUBLIC API**, for the reason {@link GoalBindingError} is: a root-only
 * consumer holding a store from `buildStore` can RECEIVE this from a goal verb,
 * so it must be able to NAME it.
 */
export class GoalMemberKindError extends Error {
  readonly name = 'GoalMemberKindError';
  readonly code = 'goal-member-kind-invalid';
  constructor(
    /** The member kind this binding requires. */
    readonly expected: GoalMemberKind,
    /** The binding that decided it. */
    readonly container: GoalContainer,
    /** The offending id, AS PASSED — an opaque tracker id, never a secret. */
    readonly memberId: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Refuse an ISSUE-shaped id at a call whose binding wants a PROJECT member
 * (ADR-0045 decision 3) — the ONE direction the id-kind rule fires in, and the
 * asymmetry is deliberate rather than an oversight:
 *
 *  - under `initiative` an issue-shaped id is a *categorically* different
 *    object from the project the verb addresses, and the mistake is the
 *    predictable one, so it refuses;
 *  - under the three ISSUE-direct bindings nothing new is checked at all, so
 *    those three behave byte-identically to what ADR-0044 shipped. A store that
 *    already threw its own "malformed id" there keeps throwing exactly that.
 *
 * The RULE and its message live here, once; the SHAPE question — "is this id in
 * my issue space?" — is adapter-owned, because only the adapter knows its own
 * id format (ADR-0001: the engine never parses an id). Same split
 * {@link requireGoalContainer} draws between the shared refusal and the
 * per-store `realizable` list.
 */
export function requireGoalMemberKind(opts: {
  /** How to name this store in the refusal message. */
  storeKind: string;
  /** The resolved binding this call addresses. */
  container: GoalContainer;
  /** The id as passed by the caller. */
  memberId: string;
  /** Adapter-owned: does this id belong to THIS store's issue space? */
  isIssueShaped: (id: string) => boolean;
}): void {
  const expected = goalMemberKind(opts.container);
  if (expected !== 'project') return; // issue-direct bindings: unchanged, on purpose
  if (!opts.isIssueShaped(opts.memberId)) return;
  throw new GoalMemberKindError(
    expected,
    opts.container,
    opts.memberId,
    `goal: the ${opts.storeKind} store's "${opts.container}" binding holds ` +
      `PROJECT members, but "${opts.memberId}" is an issue-space id ` +
      `(ADR-0045: a Goal's members are the container's DIRECT native members, ` +
      `never the issues inside them). Pass the project id the issue lives in — ` +
      `or, if the goal should hold issues directly, bind ` +
      `"store.goal.container" to "project" instead. Nothing was written.`,
  );
}

/**
 * The typed failure of {@link IssueStore.createGoalMember} AFTER its member was
 * already minted (ADR-0045 decision 3's no-silent-rollback line).
 *
 * `createGoalMember` is "mint a bare direct member and join it, in one act", and
 * the honest failure mode of a two-write act is that the first write lands and
 * the second does not. Rolling the mint back would be a *deletion* this facet
 * has no verb for and no right to perform; swallowing the failure would return
 * an id for a member that is in no goal. So the residue is REPORTED: this error
 * names the member that exists and is unattached, so the caller can join it by
 * hand or re-run. Same `closed-unknown` honesty line — report what happened,
 * never claim what cannot be proven.
 *
 * **PUBLIC API** for the same reason the two goal errors above are.
 */
export class GoalMemberJoinError extends Error {
  readonly name = 'GoalMemberJoinError';
  readonly code = 'goal-member-join-failed';
  constructor(
    /** Which half of the act failed: the membership join, or a `blockedBy` edge. */
    readonly stage: 'membership' | 'blocked-by',
    /** The goal the member was meant to join. */
    readonly goalId: string,
    /**
     * The member that WAS minted and is now residue — the whole point of this
     * class. Never rolled back, always named.
     */
    readonly memberId: string,
    /** Whatever the underlying write threw, carried verbatim for a caller that wants it. */
    readonly reason: unknown,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Why a goal-container binding was refused (ADR-0044 decision 4, applying the
 * ADR-0032 `engine.cli` fail-loud discipline). A closed union so a caller routes
 * on the discriminant rather than on message text — the same stance
 * {@link CreateInputFailure} and `EngineCliBindingFailure` take.
 *
 * - `unbound` — no container is bound and this store has no default. Linear's
 *   case, and the whole point of decision 4: one shipped consumer runs
 *   Initiative=Epic / Project=User Story while ADR-0017 once sketched
 *   "Wave ≈ Linear Project", so any built-in Linear assumption collides with a
 *   live convention. GitHub has no such collision (Milestone is the only native
 *   container with direct issue membership) and MarkdownFs has no choice to
 *   make, so those two carry defaults and this failure is unreachable for them.
 * - `unknown-container` — the configured value is not in {@link GOAL_CONTAINERS}
 *   at all (a typo, an invented role).
 * - `unrealized-container` — a real role this store does not ship. `initiative`
 *   on Linear is the recorded case; so is asking GitHub for `project`.
 * - `unrealized-update-surface` — the role IS realized, and every other goal verb
 *   works on it, but the native container has no UPDATE surface to mirror onto
 *   (ADR-0046 decision 5). A GitHub Milestone and a MarkdownFs goal file are the
 *   two recorded cases: both hold members perfectly well and neither has a
 *   timeline artifact a report could be published to.
 *
 *   **A fourth member of THIS union rather than a second error class, and that is
 *   the whole of the "one refusal family" rule.** The two failures are the same
 *   kind of fact — a config-declared container cannot do a thing the caller asked
 *   for — they name the same field (`store.goal.container`), and a caller routes
 *   on both with one `instanceof` and one `switch`. A parallel
 *   `GoalUpdateSurfaceError` would have split that routing in two for no gain and
 *   left a consumer catching two classes to handle one class of misconfiguration.
 *
 *   It is nonetheless a DISTINCT member rather than a reuse of
 *   `unrealized-container`, because the two say genuinely different things and the
 *   fix differs: `unrealized-container` means "this store cannot bind that role at
 *   all" (rebind, and nothing works until you do), while this means "the role is
 *   bound and working — this ONE pass has no surface here" (every other goal verb
 *   keeps working; only the mirror is unavailable). Collapsing them would tell a
 *   GitHub consumer their milestone binding was wrong when it is entirely correct.
 */
export type GoalBindingFailure =
  | 'unbound'
  | 'unknown-container'
  | 'unrealized-container'
  | 'unrealized-update-surface';

/**
 * The typed goal-binding refusal. Structured on purpose: `failure` names WHICH
 * way the binding is unusable and `field` names the dotted config key to fix, so
 * a caller renders an actionable message without string-matching prose. The
 * configured value is echoed because — exactly like `engine.cli` — it is a
 * declaration from TRACKED config, a role name and never a secret, so showing
 * the author their own bytes is the whole point of the message.
 *
 * **PUBLIC API**, for the reason {@link CreateInputError} is: a root-only
 * consumer holding a store from `buildStore` can RECEIVE this from any goal
 * verb, so it must be able to NAME it — `instanceof` across the barrel, then
 * route on `failure`. Same stance as `CredentialResolutionError` (ADR-0029) and
 * `EngineCliBindingError` (ADR-0032).
 */
export class GoalBindingError extends Error {
  readonly name = 'GoalBindingError';
  readonly code = 'goal-binding-invalid';
  /** The config field this refusal is about — always the dotted path. */
  readonly field = 'store.goal.container';
  constructor(
    /** Which way the binding is unusable. */
    readonly failure: GoalBindingFailure,
    /** The configured role AS AUTHORED, when one was supplied at all. */
    readonly configured: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Narrow a configured value to a {@link GoalContainer}. `undefined`/`null` mean
 * "nothing declared" and return `undefined` — an absent binding is not itself a
 * failure here, because whether absence is fatal is the STORE's question (GitHub
 * and MarkdownFs default; Linear refuses). Anything else present-but-wrong
 * throws `unknown-container`, on the "configured means authoritative" principle:
 * a malformed declaration must fail loud rather than be read as unbound.
 */
export function parseGoalContainer(
  value: unknown,
  label = 'wave config "store.goal.container"',
): GoalContainer | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(GOAL_CONTAINERS as readonly string[]).includes(value)) {
    throw new GoalBindingError(
      'unknown-container',
      typeof value === 'string' ? value : undefined,
      `${label} must be one of: ${GOAL_CONTAINERS.join(' | ')} — got ` +
        `${typeof value === 'string' ? JSON.stringify(value) : `a ${value === null ? 'null' : typeof value}`}. ` +
        `A configured binding is authoritative, so a malformed one fails here ` +
        `rather than being read as unbound.`,
    );
  }
  return value as GoalContainer;
}

/**
 * Resolve the container role a goal verb will address, or refuse loudly
 * (ADR-0044 decision 4). Shared by all three adapters so the rule cannot drift
 * into three lookalikes — the same one-owner discipline
 * {@link classifyCreateInput} applies to the create shape.
 *
 * @param opts.storeKind    how to name this store in the refusal message.
 * @param opts.configured   the binding the consumer declared, if any.
 * @param opts.fallback     this store's OWN default, or `undefined` for a store
 *                          that deliberately has none (Linear).
 * @param opts.realizable   the roles this store actually ships.
 */
export function requireGoalContainer(opts: {
  storeKind: string;
  configured: GoalContainer | undefined;
  fallback: GoalContainer | undefined;
  realizable: readonly GoalContainer[];
}): GoalContainer {
  const role = opts.configured ?? opts.fallback;
  if (role === undefined) {
    throw new GoalBindingError(
      'unbound',
      undefined,
      `goal: the ${opts.storeKind} store binds no goal container by default, so a ` +
        `goal verb needs one declared explicitly — set "store.goal.container" in ` +
        `wave.config.json to one of: ${opts.realizable.join(' | ')}. There is no ` +
        `built-in choice here on purpose (ADR-0044): consumer conventions for what ` +
        `a project/initiative MEANS collide, so the facet never silently picks a ` +
        `container.`,
    );
  }
  if (!opts.realizable.includes(role)) {
    throw new GoalBindingError(
      'unrealized-container',
      role,
      `goal: the ${opts.storeKind} store does not realize the "${role}" container — ` +
        `it ships ${opts.realizable.map((r) => `"${r}"`).join(' | ')}. ` +
        (role === 'initiative'
          ? `An initiative is a LINEAR container and is realized on the linear ` +
            `store only (ADR-0045): its members are projects rather than issues, ` +
            `and no other shipped tracker has that shape to bind. `
          : '') +
        `Change "store.goal.container" in wave.config.json.`,
    );
  }
  return role;
}

/**
 * Refuse {@link IssueStore.publishGoalUpdate} on a container that has no native
 * update surface (ADR-0046 decision 5) — the ONE spelling of that refusal, shared
 * by every store that owes it.
 *
 * Shared for the reason {@link requireGoalContainer} is shared: two adapters
 * writing "this container has no update surface" in their own words is two
 * refusal vocabularies for one class of misconfiguration, and the drift is
 * invisible until a consumer string-matches one of them. Here the class, the
 * `failure` discriminant, the `field`, and the shape of the message all come from
 * one place, so a fourth adapter inherits the refusal it owes rather than
 * inventing a lookalike.
 *
 * Note what is deliberately NOT offered: a fallback surface. A milestone
 * DESCRIPTION edit was considered as a substitute and rejected — the mirror is a
 * timeline report, and rewriting a container's description to hold one is a lossy
 * state write onto a field that means something else. A store either has the
 * surface or says so.
 *
 * @param storeKind how to name this store in the message.
 * @param role      the container role that is bound and working, minus this pass.
 */
export function refuseGoalUpdateSurface(storeKind: string, role: GoalContainer): never {
  throw new GoalBindingError(
    'unrealized-update-surface',
    role,
    `goal: the ${storeKind} store's "${role}" container has no native UPDATE ` +
      `surface, so the mirror pass has nothing to publish to (ADR-0046). The ` +
      `binding itself is fine — every other goal verb works on it; only this ` +
      `pass is unavailable. A native update surface is a Linear shape: bind ` +
      `"store.goal.container" to "project" or "initiative" on a linear store to ` +
      `mirror a frontier. Nothing was written, and no substitute surface was ` +
      `used — editing the container's description to hold a report would be a ` +
      `lossy state write onto a field that means something else.`,
  );
}

/**
 * What the `goal` station hands the store to mint a Goal container. Deliberately
 * NOT a {@link CreateInput}: a goal is not an issue, carries no wave fields, and
 * never enters {@link IssueStore.listOpen}.
 */
export interface CreateGoalInput {
  /** The finish line's human-facing name. */
  title: string;
  /**
   * Store-internal filing hint — the SAME opacity contract as
   * {@link CreateInput.filingHint}: MarkdownFs may weave it into the goal file's
   * path-id, GitHub and Linear ignore it entirely. Callers MUST treat
   * {@link IssueStore.createGoal}'s return as fully opaque (ADR-0001).
   */
  filingHint: string;
  /** Free prose describing the finish line. Absent is written as an empty description. */
  description?: string;
}

/**
 * A Goal container read back. A tracker artifact, NOT an `IssueView` — it has no
 * wave fields, no coarse status, and no completion state of its own: completion
 * is a QUERY over its members ({@link IssueStore.readGoalFrontier}), never a
 * value written here.
 */
export interface GoalView {
  /**
   * The container's opaque id (ADR-0001) — never parsed by the engine, and in
   * the GOAL id space, which is not the issue id space. It is comparable to
   * another goal id and to nothing else: on GitHub this value and a member's
   * id are both a bare `number`, so `'1'` here and `'1'` in
   * {@link memberIds} are the same bytes and different things. See the
   * id-space note in the facet banner above.
   */
  id: string;
  title: string;
  /** Free prose; empty string when the container carries none. */
  description: string;
  /** Which native container role this goal is realized as. */
  container: GoalContainer;
  /**
   * The DIRECT member ids, by CURATION — every native member of the container,
   * open and closed alike. Closed members are kept deliberately: the frontier
   * derives `done` from them, and a membership list that silently dropped
   * finished work would make a completed goal indistinguishable from an empty
   * one.
   *
   * **The KIND of these ids follows {@link container}** (ADR-0045 decision 1):
   * issue-space ids under the three issue-direct roles, PROJECT-space ids under
   * `initiative`. Never a flattening query — under `initiative` these are the
   * member projects themselves, not the issues inside them, because a
   * transitive list would report a goal complete over empty member projects.
   * Never comparable to {@link id} either way — see the facet banner.
   */
  memberIds: string[];
}

/**
 * What the `goal` station hands the store to mint a **bare direct member** of a
 * Goal and join it in ONE act (ADR-0045 decision 3). Member-kind-generic on
 * purpose: the same input mints a bare ISSUE under the three issue-direct
 * bindings and a PROJECT under `initiative`, because the member kind is the
 * binding's fact and never the caller's.
 *
 * Why a facet verb rather than "call `create` then `assignToGoal`": at a goal's
 * cut, filing the member and curating it in are one intention, and the two-call
 * shape has a silent failure the one-call shape does not (a filed member nobody
 * joined). Under `initiative` there is no two-call route at all — `create`
 * mints issues, and an initiative holds projects.
 */
export interface CreateGoalMemberInput {
  /** The member's human-facing name (an issue title; a project name). */
  title: string;
  /**
   * Store-internal filing hint — the SAME opacity contract as
   * {@link CreateInput.filingHint}. MarkdownFs weaves it into the path-id;
   * GitHub and Linear ignore it. The returned id is fully opaque (ADR-0001).
   */
  filingHint: string;
  /**
   * The member's authored free prose. It is the WHOLE authored body and must
   * carry real content — a member minted with nothing to read is the bare
   * filing ADR-0027 already refuses (`bare-without-body`).
   *
   * Issue members: {@link CreateInput.bodySections} verbatim, so every bare
   * invariant holds byte-for-byte (no Header-Block, no eligibility marker).
   * Project members: woven into the project's description, which is the only
   * prose surface a Linear project has.
   */
  bodySections: { heading: string; markdown: string }[];
  /**
   * Dependency edges to draw NATIVELY at the cut (ADR-0045 decision 4) — the
   * station writes the edges it already knows instead of leaving the Operator
   * to hand-click them later, which is the misplaced-block error class the
   * grill named.
   *
   * **MEMBER-space opaque ids, not `IssueRef`s** — the same space
   * {@link GoalView.memberIds} lives in, because a blocker of a project member
   * IS another project and has no `IssueRef` spelling. The adapter realizes
   * each edge in its own native shape (a Linear project relation under
   * `initiative`; ADR-0044's shipped bare-issue arm elsewhere) and REFUSES
   * typed, before any write, when its storage cannot represent the edge at all
   * — `CreateInputError` with `'bare-blocked-by-unrepresentable'`, the
   * precedent one member kind over.
   *
   * Absent and `[]` both declare nothing to realize.
   */
  blockedBy?: readonly string[];
}

// ── The MIRROR PASS (ADR-0046) — derived accounting on the native update surface
//
// One facet verb publishes a goal's frontier to its container's own timeline. The
// safety property is stated once, here, because every type below exists to serve
// it:
//
//   ☞ the CALLER never supplies the report. The engine derives the frontier fresh
//     at write time and renders the anchor itself, so a mirror is structurally
//     unable to publish accounting that does not match the tracker at the moment
//     of writing.
//
// That is why {@link PublishGoalUpdateInput} has no field for a rendered body, no
// field for a frontier, and no field for a member list — not "a field that is
// validated", but no field at all. A doctored-report channel cannot be spelled.

/**
 * What a caller MAY contribute to a mirror publish — and, read as a whole, what
 * it may not.
 *
 * Every field here is PROSE or a transcribed human judgment. There is deliberately
 * no `anchor`, no `frontier`, no `members`, no `body`, and no `renderedReport`:
 * the accounting half of the published artifact is derived by the engine at write
 * time and is not addressable from this shape. A caller that wanted to publish a
 * flattering frontier would have to change the tracker, which is the point.
 */
export interface PublishGoalUpdateInput {
  /**
   * The Operator-approved narrative — what happened and why it matters, in the
   * consumer's own house style (ADR-0046 decision 3). Published ABOVE the anchor,
   * verbatim: flotilla pins no form here and edits nothing.
   *
   * Absent means the update is anchor-only, which is a complete and honest
   * artifact rather than a degraded one.
   */
  narrative?: string;
  /**
   * A health value to record with the update — **transcribed, never derived**
   * (ADR-0046 decision 4).
   *
   * Two sanctioned sources produce what a caller may put here: a value the
   * Operator supplied or confirmed, or a source-attributed aggregation of the
   * members' OWN human-authored healths that the Operator then confirmed. Both
   * are human judgments; the engine's whole obligation is to carry one through
   * untouched or carry none.
   *
   * **Absent means absent, all the way to the wire.** Nothing downstream may
   * default, coalesce, infer or map a value into this — in particular nothing may
   * read a health off the frontier, because a formula over the station's own
   * classification (`blocked > 0 → atRisk`) is the station authoring a human's
   * judgment, which is the single thing this seam exists to prevent.
   *
   * **An EMPTY STRING is absent, at every site the value passes.** `''` names no
   * judgment and is a member of no tracker's health vocabulary, so it is dropped
   * rather than sent — and the receipt reports the drop, because
   * {@link GoalUpdateReceipt.health} states what went out rather than what came
   * in. This is the one narrowing sanctioned here, and it narrows toward silence:
   * it can only ever cause LESS to be claimed, never a value to be invented.
   *
   * A `string` rather than a union, for the reason {@link GoalMemberHealth} is
   * one: the vocabulary is a VENDOR's, the engine is tracker-agnostic, and a
   * value outside what the tracker accepts must fail LOUDLY at the write rather
   * than be silently narrowed here. See the adapter's own read-stamp for what the
   * tracker accepts and how a wrong value fails.
   */
  health?: string;
  /**
   * A short Operator aside published with the update — a note about the pass
   * itself ("read at 14:00, before the Berlin standup"), distinct from the
   * narrative's account of the work.
   *
   * Rendered inside the engine-owned anchor and ATTRIBUTED as the Operator's,
   * never folded into the derived accounting: a reader must be able to tell the
   * two apart, which is the same separation the two layers exist for.
   */
  operatorNote?: string;
}

/**
 * How the anchor NAMES one member — the identity half the frontier deliberately
 * does not carry.
 *
 * {@link GoalMemberReading} carries a member's opaque id and its readings, which
 * is everything the CLASSIFICATION needs and nothing a human can read: `prj-7` or
 * a bare UUID names nothing to the person the update is written for. So the store
 * — which already holds the native nodes it derived the frontier from — states
 * the display identity alongside, and the renderer joins the two by id.
 *
 * Kept OUT of `GoalMemberReading` on purpose: a name and a URL are presentation
 * facts with no bearing on any reading, and widening the frontier with them would
 * put display concerns into the pure classification module that every consumer
 * reads.
 */
export interface GoalUpdateMemberIdentity {
  /** The member's opaque tracker id — the join key against {@link GoalMemberReading.id}. */
  id: string;
  /** The member's human-facing name (an issue title; a project name). */
  name: string;
  /**
   * The tracker's OWN link to this member, when the store has one.
   *
   * Optional, and absence renders as a plain name rather than a fabricated link:
   * a URL this engine composed from an id and a guessed workspace slug would be a
   * value the tracker never stated — the same prohibition `nativeState` lives
   * under, one field over. A store reports the link the API gave it, or none.
   */
  url?: string;
}

/**
 * What a mirror publish reports back — a RECEIPT, and deliberately not a handle.
 *
 * It carries the derivation the anchor was rendered from and the body that was
 * actually published, so a caller can show the Operator exactly what went out
 * without re-reading the tracker (and without any opportunity to have sent
 * something else).
 */
export interface GoalUpdateReceipt {
  /** The goal whose frontier was mirrored. */
  goalId: string;
  /** The container role the update was published to. */
  container: GoalContainer;
  /** The published update's own opaque id, as the tracker assigned it. */
  updateId: string;
  /**
   * The tracker's own link to the published update, when it returned one.
   * Reported, never composed — see {@link GoalUpdateMemberIdentity.url}.
   */
  url?: string;
  /** The exact body published: the narrative, then the engine-owned anchor. */
  body: string;
  /**
   * The health that accompanied the write, present ONLY when one was actually
   * SENT. Absent means no health went out — and it is a faithful report of what
   * this engine did, NOT a claim about what the container's health now reads as.
   * See {@link IssueStore.publishGoalUpdate} for why those are different
   * sentences.
   *
   * "Sent", not "supplied", and the distinction is load-bearing rather than
   * pedantic: a caller's EMPTY STRING is dropped at the wire (it is not a member
   * of the tracker's health vocabulary), so it must be absent here too. A receipt
   * that echoed the input rather than the write would claim a judgment the
   * tracker never received — which is the one thing this shape exists not to do.
   */
  health?: string;
  /**
   * The frontier as derived AT WRITE TIME — the anchor's own source, returned so
   * the caller can see what was published rather than trust that it matched.
   */
  frontier: GoalFrontier;
}

/**
 * The plain reader-facing word for each frontier state (ADR-0046 decision 3's
 * "the distribution in plain reader-facing language").
 *
 * The update is read by people who do not run waves — a stakeholder opening a
 * Linear timeline — so the anchor spends the engine's vocabulary rather than
 * making the reader learn it. `unready` in particular is meaningless outside this
 * project and actively misleading inside a stakeholder's reading ("the work is
 * not ready" rather than "nobody has written the ticket properly yet").
 *
 * A total map over {@link GoalMemberState}, so adding a sixth reading is a
 * compile error here rather than a member that silently renders as its internal
 * spelling.
 */
export const GOAL_MEMBER_STATE_PROSE: Readonly<Record<GoalMemberState, string>> =
  Object.freeze({
    done: 'done',
    'in-motion': 'in motion',
    actionable: 'ready to pick up',
    blocked: 'blocked',
    unready: 'awaiting sharpening',
  });

/**
 * The all-members-closed accounting sentence, published VERBATIM (ADR-0046
 * decision 3).
 *
 * A constant rather than an inline string because the sentence is the station's
 * most load-bearing piece of prose: it is what the mirror says at the exact
 * moment a reader might mistake a report for a release authorization. It reports
 * that every member is closed and then explicitly hands the remaining act back to
 * the Operator — the station owes accounting, never the declaration (ADR-0042's
 * sentence, one station over; ADR-0044 decision 5).
 *
 * **It renders only when the goal HAS members** — see the render site in
 * {@link renderGoalUpdateBody}. `GoalFrontier.complete` is true for a goal with
 * zero members too (an empty remainder is empty, and that derivation is
 * deliberate: it is what stops the station from ever UNDER-reporting), but a
 * container nobody has populated yet has not reached anything, and publishing
 * this sentence beside "no members yet" put two contradicting readings on the one
 * surface an outsider reads.
 *
 * Exported so the skill side can show the same words in its preview, and so a
 * spec can pin them rather than paraphrase.
 */
export const GOAL_UPDATE_EMPTY_FRONTIER_SENTENCE =
  'Every member of this goal is closed. The remaining step — closing the ' +
  'container itself — is the Operator’s act in the tracker: this pass reports ' +
  'the finish line has been reached and does not declare it reached.';

/**
 * The anchor's provenance line, naming the pass that wrote it (ADR-0046 decision
 * 3).
 *
 * It exists so a reader meeting this artifact cold can tell a derived report from
 * a hand-written one — which is precisely the confusion the consumer's "nobody
 * hand-writes initiative updates" convention would otherwise suffer the moment
 * initiative updates start existing there. It also tells the reader which half of
 * the artifact is which, since the layer above it is a human's prose.
 */
export const GOAL_UPDATE_PROVENANCE_LINE =
  'Derived and published by the flotilla goal station’s mirror pass. The ' +
  'accounting in this section is read from the tracker at publish time and is ' +
  'not author-editable; any prose above it is the Operator’s own.';

/** The heading that opens the engine-owned half of every published body. */
export const GOAL_UPDATE_ANCHOR_HEADING = '## Frontier';

/**
 * Render the complete update body: the caller's narrative, then the engine-owned
 * anchor (ADR-0046 decision 3).
 *
 * **One renderer for every store, and that is the guarantee rather than a
 * convenience.** If each adapter composed its own anchor, "the anchor can be
 * neither supplied nor edited nor omitted" would be a property of three
 * implementations that happen to agree today, and a fourth adapter would inherit
 * the sentence but not the behaviour. Here the store's only contribution is
 * FACTS — the frontier it derived and the identities it read — and the artifact
 * is assembled in one place a reviewer can read whole.
 *
 * The ordering is fixed and not a parameter: prose above, accounting below. A
 * narrative that embellishes therefore stands directly above an anchor that
 * counts, and the contradiction is visible inside the artifact itself — which is
 * the realistic form of the audit property once free prose is admitted at all
 * (ADR-0046's rejected "numbers-only render" option).
 *
 * Pure: no I/O, no clock, no store. Given the same facts it renders the same
 * bytes, which is what lets a preview show the Operator exactly what will be
 * published.
 */
export function renderGoalUpdateBody(input: {
  /** The goal's human-facing name, for the anchor's opening line. */
  goalName: string;
  /** The frontier as derived at write time — the ONLY source of the accounting. */
  frontier: GoalFrontier;
  /** Display identities for the members, joined by id. Missing ones fall back to the id. */
  identities?: readonly GoalUpdateMemberIdentity[];
  /** The Operator's prose, published verbatim above the anchor. */
  narrative?: string;
  /** The Operator's aside, attributed inside the anchor. */
  operatorNote?: string;
}): string {
  const { goalName, frontier, identities = [], narrative, operatorNote } = input;
  const byId = new Map(identities.map((i) => [i.id, i]));
  const out: string[] = [];

  // ── Layer 1: the caller's prose, verbatim and untouched ────────────────────
  // Trimmed only at the edges so the layer boundary renders predictably; the
  // engine never rewrites, truncates or reflows an Operator's sentence.
  const prose = narrative?.trim();
  if (prose) out.push(prose, '');

  // ── Layer 2: the engine's anchor. Appended UNCONDITIONALLY — there is no
  // branch here that a caller's input can reach, which is what makes the anchor
  // un-omittable rather than merely always-passed.
  out.push(GOAL_UPDATE_ANCHOR_HEADING, '');
  out.push(`Goal: **${goalName}** — ${frontier.readings.length} member${frontier.readings.length === 1 ? '' : 's'}.`, '');

  if (frontier.readings.length > 0) {
    for (const reading of frontier.readings) {
      const identity = byId.get(reading.id);
      const name = identity?.name ?? reading.id;
      // A link ONLY when the tracker gave one; never composed from an id.
      const label = identity?.url ? `[${name}](${identity.url})` : `**${name}**`;
      const parts: string[] = [`${GOAL_MEMBER_STATE_PROSE[reading.state]}`];
      // The member's LIVE native word, when the store reported one. Rendered
      // beside the reading rather than instead of it, because the reading is the
      // engine's vocabulary and this is the tracker's.
      if (reading.nativeState !== undefined) parts.push(`tracker state: ${reading.nativeState}`);
      // The member's OWN health — transported, never derived, and ABSENT when the
      // store reported none. There is no `??` here and there must not be one.
      if (reading.health !== undefined) parts.push(`health: ${reading.health}`);
      if (reading.unresolvedBlockers.length > 0) {
        parts.push(`waiting on ${reading.unresolvedBlockers.map(renderBlocker).join(', ')}`);
      }
      out.push(`- ${label} — ${parts.join('; ')}`);
    }
    out.push('');
  }

  // The distribution, in the reader's language rather than the engine's.
  out.push(renderGoalUpdateDistribution(frontier), '');

  // The verbatim sentence, exactly where a reader might otherwise infer a
  // release authorization from an empty list.
  //
  // Gated on there BEING members, and the second term is the whole of the fix
  // (Operator ruling 2026-08-16). `frontier.complete` is `open.length === 0`, so
  // it is true of a goal with zero members as well — and that derivation stays
  // exactly as it is, because "an empty remainder is empty" is what stops this
  // station from ever under-reporting. What could not stand was the RENDERING:
  // an unpopulated container published "this goal has no members yet" and "every
  // member is closed, the finish line has been reached" in the same artifact, on
  // the one surface a stakeholder reads.
  //
  // Which sentence wins follows the station's own status pass rather than a fresh
  // decision — `goal/SKILL.md` already rules that an empty membership is reported
  // DISTINCTLY from completion ("'this goal has no members yet' is not 'every
  // member of this goal is finished'; only in the second case is the remaining
  // step yours to take"). The mirror now says the same thing in the same order:
  // the distribution line above already stated the empty case, so this sentence —
  // the one that names the Operator's remaining act — belongs only to the goal
  // that actually reached its finish line.
  if (frontier.complete && frontier.readings.length > 0) {
    out.push(GOAL_UPDATE_EMPTY_FRONTIER_SENTENCE, '');
  }

  // The Operator's aside, ATTRIBUTED — inside the anchor, but never presented as
  // part of the derivation.
  const note = operatorNote?.trim();
  if (note) out.push(`Operator’s note: ${note}`, '');

  out.push(GOAL_UPDATE_PROVENANCE_LINE);
  return out.join('\n');
}

/**
 * The frontier's distribution as a sentence a stakeholder can read (ADR-0046
 * decision 3).
 *
 * States with a zero count are omitted rather than listed as "0 blocked": a
 * reader wants the shape of the remainder, and five clauses of which three say
 * nothing is noise. The `done` count is always stated, including zero, because
 * "how much is finished" is the question the artifact is opened for.
 */
function renderGoalUpdateDistribution(frontier: GoalFrontier): string {
  const total = frontier.readings.length;
  if (total === 0) {
    return 'This goal has no members yet, so there is nothing to report against it.';
  }
  const open = GOAL_MEMBER_STATES.filter(
    (s) => s !== 'done' && frontier.counts[s] > 0,
  ).map((s) => `${frontier.counts[s]} ${GOAL_MEMBER_STATE_PROSE[s]}`);
  const head = `${frontier.counts.done} of ${total} ${total === 1 ? 'member is' : 'members are'} done.`;
  if (open.length === 0) return head;
  return `${head} Still open: ${open.join(', ')}.`;
}

/**
 * One unresolved blocker, in the anchor's own line.
 *
 * {@link GoalBlocker} has TWO spellings — an `IssueRef` and a bare opaque member
 * id — and this renders **three** forms, because the `IssueRef` arm splits on
 * whether the ref carries a slug:
 *
 *  1. `IssueRef` WITH a slug → `flotilla#628`, the cross-repo form a reader of
 *     this tracker already recognizes;
 *  2. `IssueRef` WITHOUT one → `#628`, the same-repo form, and deliberately not a
 *     fabricated slug — the store reports the ref it read;
 *  3. a bare member id → itself, verbatim (a Linear project UUID has no `#n`
 *     spelling to squeeze it into, ADR-0045 decision 1).
 *
 * All three are pinned by spec against the rendered update body; each was
 * demonstrated failing before it was committed.
 */
function renderBlocker(blocker: GoalBlocker): string {
  if (typeof blocker === 'string') return blocker;
  return blocker.slug ? `${blocker.slug}#${blocker.issue}` : `#${blocker.issue}`;
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
   *
   * Serves both {@link CreateInput} shapes (ADR-0027). A **decorated** input
   * files a wave-ready issue exactly as before: eligibility marker + the full
   * Header-Block. A **bare** input files the title and the free-prose
   * `bodySections` and NOTHING else — no eligibility marker (so `listOpen`
   * never surfaces it), no Header-Block, and no acceptance-criteria section
   * fabricated from nothing. A bare issue therefore has no projectable
   * `IssueView`: {@link read} throws on it until `annotate` decorates it, which
   * is the honest outcome — the wave fields are genuinely absent, not empty.
   *
   * A bare input MAY additionally carry `blockedBy` (ADR-0044): the store
   * realizes it NATIVELY — GitHub as an issue dependency, Linear as an issue
   * relation — and writes no header line for it, so the bare invariant is
   * untouched. A store whose storage cannot represent that edge REFUSES, before
   * any write, with `'bare-blocked-by-unrepresentable'`; it never writes a
   * partial `**Blocked by:**` line and never drops the edge silently.
   *
   * Validates the WHOLE input via {@link classifyCreateInput} BEFORE minting an
   * id or writing anything: a half-written Header-Block, a bare input with a
   * decoration-only stowaway, a bare input with no authored body content, and a
   * bare `blockedBy` this store cannot realize all throw a typed
   * {@link CreateInputError} and file nothing. Those rejections are part of THIS
   * contract, not of any one entrypoint — a direct caller of a store inherits
   * them exactly as the issue-store CLI does.
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
   * closing PR url), `closed-unmerged` (a closing PR was FOUND and did not merge),
   * or `closed-unknown` (closed with NO PR evidence either way — not a rejection,
   * W2-F1c). See {@link ClosingState} for the evidence-shaped reading. This is the
   * precise signal the coarse `done` projection deliberately discards (ADR-0002) —
   * the resume/close done-reconcile needs merged-vs-rejected-vs-no-evidence to
   * decide whether a `done` row is a real landing, an abandoned slice, or merely a
   * close it cannot explain. Feeds the downstream `classifyClosedBy` predicate.
   * Throws on an unknown id.
   *
   * GitHubIssuesStore: queries the issue's closing PR merge-state through the
   * {@link GitHubApi} seam (NEVER raw `gh`) — a closed issue with no closing-PR
   * reference reads `closed-unknown`. MarkdownFsStore: derives from the file's
   * done-state + the `**Closed-by:**` annotation (a recorded PR ref ⇒ merged; a
   * done file without one ⇒ `closed-unknown` — the store structurally cannot
   * record a rejection, so it never claims one).
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

  // ── Goal facet (ADR-0044) — a finish line in a config-bound container ───────
  //
  // Every verb takes the container role as its LAST parameter, optional, rather
  // than reading it off construction state. Two reasons, both load-bearing:
  //
  //  - the binding is a SETUP-TIME config fact (`store.goal.container`), and the
  //    CLI edge that already turns config into runtime wiring is where it is
  //    read — so `buildStore`'s construction contract is untouched by this
  //    facet existing, and a goal-less consumer's config keeps validating
  //    byte-for-byte as before;
  //  - "the facet must never silently pick a container" becomes structural: the
  //    role is visible at every call site, and an absent one is resolved by
  //    {@link requireGoalContainer} — this store's own default where it HAS one
  //    (GitHub `milestone`, MarkdownFs `goal-file`), a loud
  //    {@link GoalBindingError} naming `store.goal.container` where it
  //    deliberately does not (Linear).

  /**
   * Mint a Goal container and return its opaque id (ADR-0001, same contract as
   * {@link create}). Carries NO eligibility marker and no Header-Block — a goal
   * is not an issue and never appears in {@link listOpen}.
   *
   * Refuses before any write when the container role cannot be resolved
   * ({@link GoalBindingError}) — the same no-partial-application discipline
   * {@link applyTriage} and {@link create} apply.
   */
  createGoal(input: CreateGoalInput, container?: GoalContainer): Promise<string>;

  /**
   * Read a Goal back: its name, its prose, the role it is realized as, and its
   * curated membership. NOT an `IssueView` — a goal has no wave fields and no
   * status of its own. Throws on an unknown id.
   */
  readGoal(id: string, container?: GoalContainer): Promise<GoalView>;

  /**
   * Every Goal this store can see in the bound container role. Consumed by a
   * planning panel; never the wave candidate set (`listOpen` stays the only
   * source of dispatchable work — sight, never permission).
   */
  listGoals(container?: GoalContainer): Promise<GoalView[]>;

  /**
   * Join a DIRECT member to a Goal **by curation** — the deliberate human act
   * that makes the frontier editable (a bare member that outgrows its
   * placeholder becomes a PRD whose slices join here while the placeholder
   * closes). Never an automatism, and never derived from a PRD backlink: a PRD
   * belongs to a Goal only derivedly, through member slices (ADR-0044
   * decision 2).
   *
   * **The member id's KIND follows the binding** (ADR-0045 decision 3), which
   * is why the parameter is `memberId` and not `issueId`: an issue under the
   * three issue-direct roles, a PROJECT under `initiative`. There is
   * deliberately no second, project-shaped verb — the member kind is the
   * binding's fact, not the verb's.
   *
   * Under a PROJECT-member binding an issue-shaped id is refused typed
   * ({@link GoalMemberKindError}) BEFORE any write, because "I meant the issue
   * *inside* the goal" is the exact transitive confusion ADR-0045 rejected and
   * this is the call site where it would otherwise pass silently. Under the
   * three issue-direct bindings nothing new is checked and behaviour is
   * byte-identical to what ADR-0044 shipped.
   *
   * Idempotent — re-joining a member already in the container is a no-op.
   * Touches ONLY container membership: never the claim ledger, never the triage
   * dimension, never the eligibility marker, never the open/closed state.
   * Throws on an unknown goal id or member id.
   *
   * The two ids are from DIFFERENT opaque spaces and are not interchangeable —
   * on GitHub they collide by value (milestone `'1'`, issue `'1'`), so passing
   * them in the wrong order is a call that can succeed against the wrong pair.
   * See the id-space note in the facet banner above.
   *
   * @param goalId   a GOAL-space id — {@link GoalView.id}.
   * @param memberId a MEMBER-space id of the kind {@link goalMemberKind} names
   *                 for this binding — the space {@link GoalView.memberIds}
   *                 lives in.
   */
  assignToGoal(
    goalId: string,
    memberId: string,
    container?: GoalContainer,
  ): Promise<void>;

  /**
   * Mint a **bare direct member** of a Goal and join it, in ONE act (ADR-0045
   * decision 3) — the cut pass's whole write surface.
   *
   * What "bare" means per member kind, and why the burden differs:
   *  - ISSUE members: ADR-0027's bare filing verbatim — the authored prose and
   *    nothing else, no Header-Block and no eligibility marker, so nothing this
   *    verb mints can be drawn by a wave until a human sharpens it. Every bare
   *    invariant `create()` holds, this holds.
   *  - PROJECT members: a Linear project is *born* bare — a name, prose, and a
   *    backlog status carry no eligibility semantics at all — so there is no
   *    extra invariant to protect.
   *
   * Ordering is the contract, not an implementation detail. The goal id and the
   * container binding are resolved BEFORE anything is minted (no partial
   * application, the discipline `create()` and `applyTriage()` already apply),
   * and an unrepresentable `blockedBy` edge is refused before the mint too. If
   * the JOIN nonetheless fails after the mint, {@link GoalMemberJoinError}
   * names the minted member id: the residue is reported, never silently rolled
   * back — this facet has no delete verb and no right to invent one.
   *
   * Creation is goal-ANCHORED: there is no free-floating member-create here.
   * Minting a container's member without a container is tracker admin, not
   * facet surface.
   *
   * @returns the minted member's opaque id (ADR-0001), in the same MEMBER space
   *          {@link GoalView.memberIds} lives in.
   */
  createGoalMember(
    goalId: string,
    input: CreateGoalMemberInput,
    container?: GoalContainer,
  ): Promise<string>;

  /**
   * The **frontier query** (ADR-0044 decision 5): read every DIRECT member of a
   * Goal and classify each into exactly one of `done` / `in-motion` /
   * `actionable` / `blocked` / `unready` — see {@link GoalFrontier}. Read-only
   * and free: no write, no state, no durable marker.
   *
   * ONE vocabulary at every member granularity (ADR-0045 decision 2): the five
   * readings and the classification rule are the same whatever the member kind
   * is; the ADAPTER states {@link GoalMemberFacts} honestly per kind. For a
   * PROJECT member that reads: closed ← the project's own `completed`/`canceled`
   * status (the issue rule's mirror); claimed ← `started`/`paused`, or a
   * wave-claimed open issue inside; eligible ← an open issue inside carrying the
   * eligibility marker; blockers ← native project relations. An EMPTY project
   * therefore reads `unready` for exactly the reason a bare ticket does, which
   * is the whole point — a frontier structurally blind to empty members cannot
   * make `actionable`'s positive claim honestly.
   *
   * `blocked` is derived through the #381 read-union (body-codec ∪ native
   * relations), so a bare member depending on another bare member is visible
   * with no Header-Block anywhere; `unready` is derived from an ABSENT
   * eligibility marker. A blocker this store cannot resolve counts as
   * UNRESOLVED, never as clear — `actionable` is a positive claim that nothing
   * blocks the member, and an unreadable edge must not be able to counterfeit
   * one (the `ClosingState` evidence discipline, on the frontier side).
   *
   * **Each reading also CARRIES the live native facts it was folded from**, so a
   * caller can say WHICH fact produced a reading rather than rendering a static
   * mapping of everything the word could have meant. Two obligations, and a
   * fourth adapter inherits both:
   *
   *  - `nativeState` — the member's own state in the TRACKER's vocabulary.
   *    Answer it where the binding HAS one, which in practice means a binding
   *    whose members are themselves containers: a Linear project under
   *    `initiative` reports its status category (`backlog`/`planned`/`started`/
   *    `paused`/`completed`/`canceled`), precisely because five readings over six
   *    categories is lossy. The three ISSUE-direct bindings report ABSENCE: an
   *    issue's workflow state is already spent in full on the `closed`/`claimed`
   *    facts, so a value here would re-spell a boolean rather than add a fact.
   *  - `health` — the member's OWN health. Answer it where the tracker records
   *    one and this store can see it; report ABSENCE otherwise.
   *
   *    **Corrected against the vendor (ADR-0046), because the obvious reading is
   *    wrong and it misdirects the next producer.** This is NOT "a value a human
   *    set on the member". Linear documents `Project.health` as *derived from the
   *    most recent project update*, null when none was ever reported — a ROLL-UP
   *    of the latest update's health rather than a field on the node. It remains
   *    human-AUTHORED (a person chose it when posting that update), which is what
   *    makes transporting it honest; it is simply authored one node over. Two
   *    obligations follow for an adapter: select the roll-up rather than guessing
   *    at some update, and let the documented NULL arrive as an absent KEY — that
   *    absence is exactly what this contract cares about, and coalescing it is
   *    how a health nobody authored would enter the system.
   *
   * **Absence means the field is missing, never a placeholder** — not `'open'`,
   * not `''`, not a re-spelling of a state the reading already carries. A caller
   * distinguishes "this binding has no such value" from "this member's value is
   * blank" only if the two are not written the same way.
   *
   * **And neither value is ever DERIVED.** The frontier computes accounting; it
   * does not author an assessment. A store states what it read and nothing else:
   * no default, no coalesce, and above all no mapping from a five-state reading
   * back onto a health (`blocked` does not mean `atRisk` — that is the station
   * judging, and ADR-0046 decision 4 names the only two sanctioned sources of a
   * health value, neither of which is this read).
   *
   * Reports completion (`complete`) and closes nothing: there is deliberately no
   * `closeGoal` on this facet. Throws on an unknown goal id.
   */
  readGoalFrontier(
    goalId: string,
    container?: GoalContainer,
  ): Promise<GoalFrontier>;

  /**
   * The **mirror pass** (ADR-0046): publish this goal's derived accounting to its
   * container's native update surface, as ONE update.
   *
   * ── The safety property, and how the signature enforces it ─────────────────
   *
   * **The engine derives the frontier FRESH here, at write time, and renders the
   * anchor itself.** The caller contributes prose and, optionally, a transcribed
   * health — {@link PublishGoalUpdateInput} has no field for a report, a
   * frontier, or a member list, so a caller is structurally unable to publish
   * accounting that does not match the tracker at the moment of writing. That is
   * the whole reason this verb exists rather than a "post this text" verb: the
   * mirror cannot lie about the frontier because it is never told what it is.
   *
   * An implementation therefore MUST call its own {@link readGoalFrontier} (or
   * the identical derivation) inside this method. Accepting a frontier from
   * anywhere else — a cached one, a parameter, a field — reintroduces exactly the
   * doctored-report channel the shape above removes.
   *
   * ── Health: two sanctioned sources, and one prohibition ────────────────────
   *
   * The value published is `input.health` or nothing (ADR-0046 decision 4). An
   * implementation must never derive one: not from the frontier, not from the
   * counts, not from a member's health, not from a previous update. `blocked > 0`
   * does not mean `atRisk` — that is the station authoring a human's judgment,
   * and a defaulted health is a fabricated one.
   *
   * When no health is available the update publishes WITHOUT one. If a native
   * create surface should ever REQUIRE a value, the implementation refuses typed
   * rather than inventing a default. (On Linear it does not require one — the
   * field is optional on both create inputs; see the adapter's read-stamp, which
   * also records the one thing that read cannot settle.)
   *
   * ── What this verb reports about health, and what it deliberately does not ──
   *
   * {@link GoalUpdateReceipt.health} reports what THIS ENGINE SENT. It is not a
   * claim about what the container's health subsequently reads as, and the
   * difference is real rather than pedantic: on Linear a container's health is
   * DERIVED from its most recent update, so publishing an update is itself an act
   * that can move it. Reporting "the container's health is now X" would be this
   * engine asserting a value it did not author and did not read back.
   *
   * **The feedback loop that follows from that, and why the anchor is not caught
   * in it.** Because the mirror writes to the CONTAINER's timeline while the
   * anchor reports the MEMBERS' healths, the write and the reading sit one
   * container apart and cannot touch:
   *
   *  - `initiative`-bound — the pass writes an INITIATIVE update; the anchor
   *    reports member PROJECTS' healths, each derived from that project's own
   *    latest PROJECT update. An initiative update feeds initiative health only,
   *    so no member health the anchor names can be altered by this write.
   *  - `project`-bound — the pass writes a PROJECT update; the members are ISSUES,
   *    which carry no health at all, so the anchor reports none.
   *
   * The container's OWN health is genuinely affected, and the anchor therefore
   * never reports it. That is the decision, not an omission: a report cannot
   * honestly state a value its own publication is about to change, so the mirror
   * states the members (which it cannot move) and stays silent about the
   * container (which it can). Any implementation that starts reporting the
   * container's health in the anchor reopens the loop.
   *
   * ── Surface, and the refusal ───────────────────────────────────────────────
   *
   * The surface follows the binding, ONE update per goal, no per-member fan-out
   * (ADR-0046 decision 5): `project` → a native project update, `initiative` → a
   * native initiative update. A container with no native update surface refuses
   * through {@link refuseGoalUpdateSurface} — same error class, same config key,
   * one refusal family.
   *
   * Throws on an unknown goal id. Writes nothing when it refuses.
   */
  publishGoalUpdate(
    goalId: string,
    input?: PublishGoalUpdateInput,
    container?: GoalContainer,
  ): Promise<GoalUpdateReceipt>;
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

  // ── readClosing evidence-split drivers (ADR-0005 / W2-F1c) ─────────────────
  // Each drives the store into one closing-probe scenario THROUGH the adapter's
  // own mechanism, so the shared suite can assert readClosing without baking a
  // storage assumption in — the same stance as simulateNativeClose.

  /**
   * Drive the issue closed by a MERGED linked PR (the wave happy path), recording
   * `prUrl` as the merge evidence. After this, `readClosing` reports
   * `{ state: 'merged', prUrl }` on every store.
   */
  simulateClosedMergedPr(
    store: IssueStore,
    id: string,
    prUrl: string,
  ): Promise<void>;

  /**
   * Drive the issue closed with POSITIVE evidence a linked PR was FOUND and did
   * NOT merge — a genuine rejection. Returns the {@link ClosingState} state that
   * `readClosing` is EXPECTED to report on THIS store: a store that can record the
   * rejected PR (GitHub, Linear) answers `closed-unmerged`; a store that
   * structurally cannot prove a rejection (MarkdownFs) answers `closed-unknown`
   * (it never claims a rejection it cannot see — W2-F1c / the AC-2 honesty rule).
   * The hook both drives the state and declares the honest per-store answer, so
   * the suite pins the real (legitimately divergent) behaviour rather than a
   * lowest-common mechanism.
   */
  simulateClosedUnmergedPr(
    store: IssueStore,
    id: string,
  ): Promise<ClosingState['state']>;

  /**
   * Drive the issue closed with NO closing-PR evidence at all (closed by hand, as
   * a duplicate, via a foreign-id mention, or on a store whose tracker↔host
   * integration never attached a PR). Every store MUST report `closed-unknown`
   * here — never a rejection it cannot prove (W2-F1c).
   */
  simulateClosedNoEvidence(store: IssueStore, id: string): Promise<void>;
}

export type { IssueView, IssueRef };

/** The AI-provenance disclaimer the Triage facet prepends to every comment (ADR-0015). */
export const TRIAGE_DISCLAIMER = '> *This was generated by AI during triage.*';

/** Prepend the AI-provenance disclaimer to a triage comment body (ADR-0015). */
export function withTriageDisclaimer(body: string): string {
  return `${TRIAGE_DISCLAIMER}\n\n${body}`;
}
