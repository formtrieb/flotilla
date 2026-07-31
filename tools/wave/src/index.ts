export {
  parseHeaderBlock,
  createHeaderParser,
  DEFAULT_WAVE_SCHEMA,
  serializeHeaderBlock,
  RISK_VALUES,
  WORKER_VALUES,
  type HeaderParser,
  type HeaderBlock,
  type Risk,
  type Worker,
  type IssueRef,
  type BlockedBy,
  type ParseError,
  type ParseResult,
} from './header-parser';

export {
  validateHeaderBlock,
  type IssueView,
  type CoarseState,
  type ClaimRung,
  type WaveSchema,
  type SchemaGovernedFields,
  type HeaderValidation,
} from './contract';

export { coarse } from './coarse-projection';

export {
  spineStoreFromSource,
  createSpineStore,
  defaultSpineIo,
  type SpineStore,
  type SpineIo,
  // The Disclosures surface (ADR-0027) — read/ensure/add/set-disposition. The
  // SpineStore methods above already cover it through the store; these are the
  // standalone string-in/string-out primitives (`spine-cli.ts`'s own seam onto
  // the same functions) for a consumer that wants the section without a
  // disk-backed store.
  readDisclosures,
  openDisclosures,
  ensureDisclosuresSection,
  addDisclosureToSource,
  setDispositionInSource,
  isSettableDisposition,
  normalizeDisclosureText,
  renderDisclosureRow,
  renderDisclosuresSection,
  DISCLOSURE_SOURCES,
  OPEN_DISPOSITION,
  DISPOSITION_LITERALS,
  DISPOSITION_PREFIXES,
  DISPOSITION_VOCABULARY,
  type Disclosure,
  type DisclosureInput,
  type DisclosureSource,
} from './spine-store';

export {
  readSidecars,
  parseSidecarName,
  type SidecarReader,
  type SidecarIndex,
  type ReportHit,
  type VerdictHit,
  type CorruptSidecar,
} from './sidecar';

export {
  resume,
  type ResumeInputs,
  type ResumeResult,
  type ResumeDecision,
  type RowReconstruction,
} from './resume';

export {
  verifyCommands,
  type VerifyCommand,
  type VerifyProfile,
  type VerifyConfig,
} from './verify';

export {
  runChecks,
  conflictMarkerCheck,
  acCoverageCheck,
  FLOOR_CHECKS,
  type Check,
  type CheckContext,
  type CheckResult,
} from './checks';

export {
  crossWaveCheck,
  type CrossWaveInput,
  type CrossWaveResult,
  type ScopedIssue,
} from './cross-wave';

export {
  validateIssue,
  acFilesCoverageCheck,
  extractAcBody,
  type DorResult,
  type GateResult,
  type GateStatus,
  type ValidateOptions,
  type AcFilesCoverageWarn,
} from './dor-gate';

export {
  computeConflictMap,
  loadIssueGlobs,
  type IssueGlobs,
  type ConflictCell,
  type ConflictMap,
  type ComputeOptions,
} from './conflict-map';

export {
  transition,
  ISSUE_STATES,
  WAVE_EVENTS,
  STOP_REASONS,
  SEVERITIES,
  // ADR-0022 — the `parked` entry-edge rule. Exported alongside the rest of the
  // vocabulary: `parked` is Coordinator-set rather than event-emitted, so this
  // guard (not `transition`) is where the two legal entry edges live.
  PARKABLE_FROM,
  canPark,
  type IssueState,
  type WaveEvent,
  type StopReason,
  type Severity,
  type Outcome,
  type TransitionOutcome,
  type StopOutcome,
  type WarnOutcome,
  type NoopOutcome,
} from './stop-condition-state-machine';

export {
  verdictToEvent,
  VERDICT_VALUES,
  type Verdict,
} from './verdict-to-event';

export {
  computeMergeOrder,
  computeMergeOrderFromSpine,
  parseWaveSpine,
  defaultGitProbe,
  extractIssueId as extractMergeOrderIssueId,
  type PR,
  type MergeOrderResult,
  type GitProbe,
  type ComputeMergeOrderOptions,
  type ParsedSpine,
} from './merge-order';

export {
  isFastForward,
  defaultFfProbe,
  type FfProbe,
  type FfResult,
  type FfGuardOptions,
} from './ff-guard';

export {
  readSpine,
  setRowState,
  setRowPrCell,
  upsertPrLogRow,
  replaceClosedByBlock,
  upsertDispatchLogEntry,
  upsertDispatchLogModel,
  branchesByIssueId,
  renderSpine,
  ROW_STATES,
  // The human lane (ADR-0012). Root-reachable as a FAMILY, and deliberately so:
  // the constant alone would let an out-of-tree caller name the token while
  // re-deriving the predicate by hand, which is the divergence the whole gate
  // exists to prevent. `humanGatedRows` is the state-blind view (describe the
  // lane); `humanHeldRowIds` is the conjunction both the dispatch hold and the
  // archive gate branch on. Their row/state types (`PlanTableRow`, `RowState`)
  // already cross the barrel just below.
  HUMAN_GATED_WORKER,
  humanGatedRows,
  humanHeldRowIds,
  type RowState,
  type Spine,
  type Frontmatter,
  type PlanTableRow,
  type PrLogRow,
  type PrLogRowInput,
  type DispatchLogEntry,
  type ClosedByBlock,
  type SpineMeta,
  type SpineRosterRow,
} from './wave-md-rw';

export {
  classifyClosedBy,
  needsPin,
  renderPinned,
  type ClosedByClass,
} from './closed-by';

export {
  detectHost,
  verifyAuth,
  findOpenPr,
  createPr,
  defaultHttpProbe,
  type Host,
  type HostInfo,
  type Creds,
  type HostOptions,
  type HttpProbe,
  type HttpRequest,
  type HttpResponse,
  type AuthResult,
  type CreatePrRequest,
  type CreatePrResult,
} from './host-pr';

// The ONE credential seam (ADR-0029). Consumed inside the engine by
// `adapters/github/github-api-factory`, `adapters/linear/linear-api-factory`,
// and `host-pr-cli`'s create edge; exported so an out-of-tree store adapter
// inherits the same precedence and the same loud failures instead of writing a
// fourth lookup.
export {
  resolveCredential,
  commandVariableFor,
  defaultCredentialLookupSpawn,
  CredentialResolutionError,
  CREDENTIAL_LOOKUP_TIMEOUT_MS,
  type CredentialFailure,
  type CredentialLookupResult,
  type CredentialLookupSpawn,
  type ResolveCredentialOptions,
} from './credential-resolver';

// The value-free credential PROBE (ADR-0029) — the resolver's paired question
// ("can this be resolved right now?") rather than its answer. Consumed by the
// `credential-probe` CLI verb, which the two Coordinator auth preflights
// (wave-start step 4, wave-close phase 2) run before dispatch; exported so an
// out-of-tree adapter can probe its own `<VAR>_CMD` pair with the same
// containment instead of shelling the lookup out by hand (Convention 8).
export {
  runCredentialProbe,
  probeCredential,
  probeCredentials,
  discoverConfiguredCredentials,
  configuredLookupCommand,
  KNOWN_CREDENTIAL_VARIABLES,
  type CredentialProbeFailure,
  type CredentialProbeOutcome,
  type CredentialProbeReport,
  type CredentialProbeOptions,
  type CredentialSource,
} from './credential-probe-cli';

export {
  DEFAULT_AGENT_PATH_MARKERS,
  parseWorktreeList,
  planCleanup,
  executeCleanup,
  cleanAgentWorktrees,
  listAgentWorktrees,
  defaultWorktreeRemover,
  // The consumer-declared disposable-name validator (issue #115) + the
  // widened option surface that carries it into the orphan sweep (issue
  // #184 — same barrel-gap class the disclosure surface hit: an
  // engine-complete symbol unreachable from the package root). `CleanupOptions`
  // already carried its own `disposableNames` field and was exported above
  // before this fix; `OrphanSweepOptions` is the other option surface #115
  // widened with the same field, and `normalizeDisposableNames` is the
  // exact-names validator both `wave-config.ts` and the cleanup entry points
  // apply — none of the three were importable from the package root until now.
  normalizeDisposableNames,
  // The detached-HEAD scratchpad sweep + the worktree-count advisory (issue
  // #238) — the two halves of the E2BIG hardening, engine-complete and
  // spec-covered but reachable only via a deep import until now (the same
  // barrel-gap class as `normalizeDisposableNames` above and the disclosure
  // surface in issue #177). The trio is exported whole so a consumer can either
  // take the one-shot `sweepDetachedScratchpadWorktrees` or split it into
  // list → plan → `executeCleanup` when it needs to PREVIEW the plan before
  // executing it — the split the `worktree-cleanup --detached --dry-run` CLI
  // path itself uses, and the only form that gives dry-run parity, since the
  // one-shot's plan is not observable from outside. The advisory's threshold
  // constant rides along because it is the authority the operator-facing docs
  // cite (and are drift-pinned against in skill-schema-drift.spec.ts): a
  // consumer that wants to state or raise the number must be able to read it.
  listDetachedScratchpadWorktrees,
  planDetachedScratchpadSweep,
  sweepDetachedScratchpadWorktrees,
  checkWorktreeCountAdvisory,
  WORKTREE_COUNT_ADVISORY_THRESHOLD,
  // The COMMAND-LINE term of the same E2BIG budget (issue #266) — the second
  // half of a two-term measurement whose first half was already root-reachable
  // (the count advisory directly above). That asymmetry was the sharp edge, not
  // merely another barrel gap: the count advisory's own message says in so many
  // words that a count under threshold is NOT an E2BIG all-clear and names
  // `checkCommandLineSizeAdvisory` as the term to measure next — so the root
  // shipped the correction's PREMISE while withholding the correction, and an
  // out-of-tree consumer importing from the root reproduced exactly the
  // one-term mismeasure the second term exists to end (the measured 2026-07-30
  // occurrence: ~1019.5 KB of command line across 3 argv entries, only 15 of
  // 166 sandbox deny paths worktree-derived, recovered with no worktree
  // removed).
  //
  // The family ships WHOLE because that is the whole job from the root: MEASURE
  // a command line the consumer is about to spawn (`measureExecArgumentBytes` —
  // pure, five numbers out, nothing to accidentally print), CHECK it against
  // the documented budget (`checkCommandLineSizeAdvisory`), and READ or RAISE
  // that budget (`COMMAND_LINE_ADVISORY_THRESHOLD_BYTES` — the same reason its
  // count-side sibling rides along: a consumer that wants to state or override
  // the number must be able to read it). The measurement is exported beside the
  // check rather than folded into it because the preflight form — measure a
  // command line that does not exist yet — is the one a dispatching consumer
  // actually needs, and the check's `argv` default (`process.argv`) answers a
  // different question.
  //
  // The three result types ride along so a root-only consumer can annotate the
  // options it passes and switch on the `level` it gets back.
  measureExecArgumentBytes,
  checkCommandLineSizeAdvisory,
  COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
  // The PER-STRING term of the same E2BIG budget — the barrel-gap class above
  // recurring exactly ONE TERM LATER, and the reason it recurred is worth
  // writing down rather than fixing silently. The command-line row directly
  // above was authored against a wave anchor at which the per-string sibling did
  // not yet exist, so it shipped the family "whole" as the family stood that
  // morning; the advisory-hardening row added `MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES`
  // to the module the same day and the barrel had already been written. A
  // reconciled-merge probe by that row's reviewer is what surfaced it — neither
  // branch was wrong on its own, which is precisely the shape a per-branch review
  // cannot see.
  //
  // The asymmetry it leaves behind is the SAME one issue #266 closed, one level
  // down: `checkCommandLineSizeAdvisory` returns `level: 'advisory'` when EITHER
  // condition trips, and its message states in so many words that a total safely
  // under budget is not an all-clear because a single oversized argv/env entry
  // fails the spawn on its own. A root-only consumer therefore received the
  // per-string verdict (in `level`), the per-string number (in
  // `maxEntryBytes`/`maxEntryThreshold`, which cross the barrel already as fields
  // of the exported result types) and the sentence telling it to compare them —
  // while the threshold it is told to compare against, state, or raise stayed
  // behind a deep import. Exporting the constant is what makes the advertised
  // comparison performable from the root at all.
  //
  // No function rides along, deliberately: unlike the count and total terms, the
  // per-string term has no entry point of its own. It is measured by
  // `measureExecArgumentBytes` and checked by `checkCommandLineSizeAdvisory`,
  // both already root-reachable above, so the constant is the whole of what was
  // missing — and a root surface that grew by more than that would be a
  // different decision from this one.
  MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
  type WorktreeEntry,
  type CleanupPlan,
  type CleanupResult,
  type WorktreeRemover,
  type CleanupOptions,
  type OrphanSweepOptions,
  type SkipReason,
  type DetachedSweepOptions,
  type WorktreeCountAdvisory,
  type WorktreeCountAdvisoryOptions,
  type ExecArgumentMeasurement,
  type CommandLineSizeAdvisory,
  type CommandLineSizeAdvisoryOptions,
} from './worktree-cleanup';

export {
  detectDrift,
  deriveProjectScopes,
  pathToScopeDir,
  isInsideScope,
  getChangedFilesFromGit,
  type DriftStatus,
  type DriftResult,
  type DetectDriftOptions,
} from './files-drift';

// NOTE: `gate-runner` (the check layer / the Ur's Pure-I/O check) is deliberately
// NOT seeded in P0 — it is the consumer-specific check surface, rebuilt generic in
// P6 as a flat `checks[]` config (CLAUDE.md provenance: no ADR-0005 Pure-I/O re-import).

export { type SchemaValidation } from './types';

export {
  WORKER_OUTCOME_VALUES,
  WORKER_REPORT_JSON_SCHEMA,
  outcomeToEvent,
  validateWorkerReport,
  type WorkerOutcome,
  type WorkerReport,
  type FilesChangedCounts,
} from './worker-report-schema';

export {
  AC_STATUS_VALUES,
  REVIEWER_VERDICT_JSON_SCHEMA,
  validateReviewerVerdict,
  // The Documented-Form Comparison surface (ADR-0030) — the trigger vocabulary
  // + the trigger/comparison/divergence shapes for a `ReviewerVerdict`'s
  // optional `documentedFormComparison` field. Same barrel-gap class as the
  // disclosure surface above: engine-complete, unreachable from the package
  // root until now.
  DOCUMENTED_FORM_TRIGGER_VALUES,
  type AcStatus,
  type AcVerification,
  type ReviewerVerdict,
  type DocumentedFormTrigger,
  type DocumentedFormComparison,
  type DocumentedFormDivergence,
} from './reviewer-verdict-schema';

export {
  loadWaveConfig,
  // The engine-invocation binding (ADR-0032). All four names ship together so a
  // ROOT-ONLY consumer can do the whole job from the package root: READ the
  // binding (`loadWaveConfig(p).engine?.cli`, typed by `EngineConfig` on
  // `WaveConfig`), re-apply the SAME plain-argv rule when it authors or
  // re-checks a value (`normalizeEngineCli` — one rule, one implementation,
  // shared with `config validate`), and CATCH the refusal typed
  // (`EngineCliBindingError` + its `failure` discriminant) instead of
  // string-matching a message. Exported at introduction time on purpose: the
  // barrel gap — engine-complete symbol reachable only via a deep import — is a
  // defect class this repo has had to close after the fact more than once
  // (issues #177, #184, #216).
  normalizeEngineCli,
  EngineCliBindingError,
  type EngineConfig,
  type EngineCliBindingFailure,
  type WaveConfig,
  type StoreConfig,
  type MarkdownStoreConfig,
  type GitHubStoreConfig,
  type LinearStoreConfig,
  type LinearStateMapConfig,
} from './wave-config';

// The plugin/engine LOCKSTEP COMPARISON (ADR-0032) — the other half of the same
// binding the `engine.cli` names above describe. The version gate shipped with
// two consuming surfaces, the `version` verb and the `store-preflight`
// advisory, and BOTH sit on the CLI side: a consumer that imports this package
// rather than shelling its CLI could not ask the question the ADR makes a
// checked invariant. That is the barrel gap this closes — the same defect class
// already closed after the fact for the disclosure surface, the disposable-name
// validator, and the documented-form vocabulary (issues #177, #184, #216).
//
// The trio ships WHOLE because it is the whole job from the root: read an
// installation's own manifest (`readEngineVersion`, pointable at a manifest
// other than this package's, and never throwing — an unreadable manifest is a
// reported state), compare it against the expectation the caller holds
// (`compareEngineVersion`), and map the five-valued outcome to the same exit
// code the verb returns (`engineVersionExitCode`). One comparison, one
// exit-code mapping — a root-only consumer re-implementing either is exactly
// the drift ADR-0032 exists to end. The three result types ride along so the
// report can be annotated and its `outcome` discriminant switched on
// exhaustively.
//
// Costs the barrel nothing at load time: `./cli` (re-exported at the bottom of
// this file) already imports `./cli-store`, so the module is in this graph
// either way — these are names, not a new dependency.
//
// Deliberately NOT re-exported: `engineManifestPath` (every reading already
// carries the manifest it read as `manifestPath`, so the root surface would
// gain a second way to ask one question) and `engineVersionPreflightCheck` —
// whose held-back REASON changed with issue #325 and is therefore re-recorded
// here rather than inherited. It used to be "its return type belongs to a
// surface that is not root-reachable"; the store-preflight block directly below
// makes `PreflightCheck` root-reachable, so that reason is spent. What survives
// is the other one: `preflightStore`'s `expectedEngineVersion` option already
// APPENDS exactly this check to the report, so a root consumer that wants the
// lockstep row asks the probe for it, and one that wants the comparison alone
// has `compareEngineVersion` above. A standalone constructor between those two
// would be the same second-way-to-ask-one-question `engineManifestPath` is held
// back for.
export {
  readEngineVersion,
  compareEngineVersion,
  engineVersionExitCode,
  type EngineVersionReading,
  type EngineVersionOutcome,
  type EngineVersionReport,
} from './cli-store';

// The STORE-PREFLIGHT family (FOR-12, ADR-0020 / the ADR-0023 amendment).
//
// RECORDED DECISION (issue #325): this surface IS public. The question was
// genuinely open — the version-barrel slice above declined to answer it, and
// "the root surface is deliberately CLI-only for preflight" would have been a
// legitimate outcome. It is public for two reasons:
//
//   - The probe is PURE OVER THE SEAM. `preflightStore(config, store)` reaches a
//     tracker only through the store's own api, so a root-only consumer can run
//     it against a fake and get the same report `wave-setup` reads — no network,
//     no subprocess. A CLI-only stance would have forced that consumer to shell
//     a verb to ask a question the engine answers in-process.
//   - The CLI runners are ALREADY a root-exported family — `runConflictMap`,
//     `runCrossWave`, `runIssueStore`, `runSpine`, `runResume`,
//     `runCredentialProbe`. `runStorePreflight` being the one missing member was
//     an omission, not a stance, and leaving it out would have recorded a stance
//     nobody actually took.
//
// The family ships WHOLE because that is the whole job from the root: BUILD the
// store the config describes at the impure edge (`resolveStore` — which
// `buildStore` deliberately is not: `resolveStore` injects the real
// GitHub/Linear api factories, `buildStore` stays pure and demands an injected
// api), PROBE it (`preflightStore`), or take the runner with its exit-code
// contract exactly as the CLI does (`runStorePreflight`, plus
// `runStorePreflightSubcommand` — the router-facing spelling, shipped alongside
// so a consumer embedding the verb picks the arg shape it already holds rather
// than re-deriving the `preflight` op token; the two cannot drift, the shim adds
// no logic of its own). The three types ride along so the report can be
// annotated and each check's `name` switched on exhaustively.
//
// Costs the barrel nothing at load time, for the same reason the version trio
// above does not: `./cli-store` is already in this graph.
//
// Deliberately NOT separately re-exported: `PreflightCheck['status']`, which is
// `CheckStatus` and owned by `host-pr`. Indexed access already reaches it from
// the root, and a second name for one type is precisely the drift this barrel
// keeps declining to buy.
export {
  resolveStore,
  preflightStore,
  runStorePreflight,
  runStorePreflightSubcommand,
  type PreflightCheck,
  type StorePreflightReport,
  type StorePreflightOptions,
} from './cli-store';

export {
  LinearIssuesStore,
  DEFAULT_LINEAR_STATES,
  type LinearIssuesStoreOptions,
  type LinearStateMap,
} from './adapters/linear/linear-issues-store';

export {
  type LinearApi,
  type LinearIssue,
  type LinearCreateIssueInput,
  type LinearPrAttachment,
  type LinearStateType,
} from './adapters/linear/linear-api';

export {
  defaultLinearHttp,
  type LinearHttp,
  type LinearHttpRequest,
  type LinearHttpResponse,
} from './adapters/linear/linear-http';

export {
  RealLinearApi,
  LinearApiError,
} from './adapters/linear/real-linear-api';

export {
  createLinearApiFromEnv,
  type LinearApiFactoryOptions,
} from './adapters/linear/linear-api-factory';

export {
  buildStore,
  type StoreDeps,
} from './store-factory';

// The TYPED CREATE REJECTION (ADR-0027, the bare-filing path).
//
// RECORDED DECISION (issue #325): the typed rejection IS public — a programmatic
// consumer is NOT expected to catch a generic error. `buildStore` above hands a
// root-only consumer a live store, and `create()` on EVERY adapter runs the
// create-input classifier as its first statement, before an id is minted and
// before any write. So this rejection was already something a root consumer
// could RECEIVE and could not NAME: catching it meant `instanceof` against a
// class reachable only by deep import, or string-matching a prose message —
// exactly the stance ADR-0029 and ADR-0032 already took against message-matching
// when they exported `CredentialResolutionError` and `EngineCliBindingError`.
// `CreateInputFailure` ships beside the class as the discriminant a caller
// routes on (usage-error vs domain-failure, which field to re-author), for the
// same reason `EngineCliBindingFailure` does.
//
// Deliberately NOT re-exported: the classifier itself. Every adapter already
// runs it first, so a consumer calling it by hand would be asking a question
// `create()` answers on its behalf — and a hand-run pre-check that can drift
// from the write path is worse than no pre-check at all. The rejection is
// inherited; the classifier stays the seam. Same one-way-to-ask discipline as
// `engineManifestPath` and `engineVersionPreflightCheck` above.
export {
  CreateInputError,
  type CreateInputFailure,
} from './adapters/issue-store';

export { runConflictMap } from './conflict-map-cli';

export { runCrossWave } from './cross-wave-cli';

export { runIssueStore } from './issue-store-cli';

export { runSpine } from './spine-cli';

export {
  runResume,
  type ResumeDeps,
} from './resume-cli';

export { main, mainAsync } from './cli';
