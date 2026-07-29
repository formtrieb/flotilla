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
  type WorktreeEntry,
  type CleanupPlan,
  type CleanupResult,
  type WorktreeRemover,
  type CleanupOptions,
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
  type AcStatus,
  type AcVerification,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';

export {
  loadWaveConfig,
  type WaveConfig,
  type StoreConfig,
  type MarkdownStoreConfig,
  type GitHubStoreConfig,
  type LinearStoreConfig,
  type LinearStateMapConfig,
} from './wave-config';

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

export { runConflictMap } from './conflict-map-cli';

export { runCrossWave } from './cross-wave-cli';

export { runIssueStore } from './issue-store-cli';

export { runSpine } from './spine-cli';

export {
  runResume,
  type ResumeDeps,
} from './resume-cli';

export { main, mainAsync } from './cli';
