/**
 * Stop-Condition state-machine — pure transition function for `/wave start`.
 *
 * Canonical spec: .claude/skills/wave-start/references/stop-condition-handling.md
 * PRD source: .scratch/wave-orchestration/PRD.md §L1
 * Playbook: docs/agents/wave-playbook.md §2 (Stop-Conditions)
 *
 * Usage:
 *   import { transition } from './stop-condition-state-machine';
 *   const result = transition('dispatched', 'worker-done');
 *   // → { type: 'transition', nextState: 'report-in' }
 */

import type { Risk } from './header-parser';

// ─── enums ────────────────────────────────────────────────────────────────────

export const ISSUE_STATES = [
  'planned',
  'dispatched',
  'report-in',
  'reviewing',
  'verdict-in',
  're-dispatched',
  'approved',
  'pr-created',
  'failed',
  'abandoned',
  // ADR-0022 — the 11th state. "Deliberately taken out of THIS wave; released
  // for re-planning into a future one." Terminal-but-silent: the counterpart to
  // the alarm terminals (`failed`/`abandoned` = terminal + needs-attention),
  // `parked` = terminal + silence. It is the only state that holds NO claim —
  // `coarse('parked')` is `null`, executed as `unclaim()` on the write path.
  // Set by the Coordinator (`spine set-row-state` + `unclaim`), never by an
  // event: no `WaveEvent` enters it (see {@link PARKABLE_FROM}) and from it
  // every event is invalid.
  'parked',
] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

/**
 * The **only** legal entry edges into `parked`: `planned → parked` and
 * `failed → parked` (ADR-0022 §Decisions 1).
 *
 * Parking is Coordinator-set rather than event-emitted (§Decisions 5), so no
 * `WaveEvent` carries the edge and {@link transition} cannot express it. This
 * const + {@link canPark} are therefore the machine-checkable home of the rule —
 * the guard the scripted dispositions (wave-start's membership resolution, the
 * STOP menu) consult before writing the state.
 *
 * A **live** row (`dispatched`/`report-in`/`reviewing`/`verdict-in`/
 * `re-dispatched`/`approved`/`pr-created`) is deliberately excluded: it first
 * resolves through its existing stop paths (→ `failed`) or completes. That keeps
 * `resume()` free of a "parked with a live worktree" decision column.
 *
 * `abandoned → parked` and `parked → parked` are excluded too: parked is
 * terminal and there is **no un-park** (§Decisions 6) — once the claim is
 * released the issue is back in the pool and a concurrent wave may have drawn
 * it, so re-entry is a fresh row in a future wave's spine, never a resurrection.
 */
export const PARKABLE_FROM = ['planned', 'failed'] as const satisfies readonly IssueState[];

/** True iff `state` may legally transition to `parked` (ADR-0022 §Decisions 1). */
export function canPark(state: IssueState): boolean {
  return (PARKABLE_FROM as readonly IssueState[]).includes(state);
}

export const WAVE_EVENTS = [
  'worker-done',
  'reviewer-approve',
  'reviewer-approve-public-api',
  'reviewer-changes-requested-1st',
  'reviewer-changes-requested-2nd',
  'reviewer-questions-blocking',
  'worker-failed-after-retry',
  'same-file-conflict-detected',
  'wallclock-exceeded',
  'all-issues-done',
  // #53 — Worker `Outcome: needs-context` (context-starved-but-retryable).
  // Routes to an auto re-dispatch-with-context; the sibling `Outcome: blocked`
  // reuses `worker-failed-after-retry`, and `done` / `done-with-concerns` reuse
  // `worker-done` — so only the re-dispatchable case needs a distinct event.
  'worker-needs-context',
  // #66 — Stall watchdog. A deadline (Workflow-tool deadline hosted by the #61
  // driver; the §6.3 per-Risk p90 thresholds feed the baseline) fires when no
  // completion notification arrives within the Risk-class deadline. First
  // occurrence (live Worker state `dispatched`) STOPs `worker-stalled`/`warn` —
  // surfacing the Playbook §6.5 worktree-inspection checklist without halting
  // hard. A second stall past the hard ceiling (`re-dispatched`) escalates to
  // `worker-stalled`/`blocking`. Both occurrences are bounded — termination
  // stays guaranteed (no path loops).
  'worker-stalled',
  // #66 — Transient-failure auto-retry. A Worker `Outcome: blocked` the loop
  // classifies as transient (flaky test, worktree-reset miss, transient 401 —
  // vs. a genuine spec/judgment failure, which the loop-driver maps to
  // `worker-failed-after-retry` instead) auto-retries ONCE with backoff. From
  // `dispatched` it consumes the re-dispatch budget (`→ re-dispatched`, same
  // discipline as `worker-needs-context`); from `re-dispatched` the single retry
  // is spent, so it STOPs via the existing `worker-failed` path. Cap = 1 —
  // termination stays guaranteed.
  'worker-failed-transient',
] as const;

export type WaveEvent = (typeof WAVE_EVENTS)[number];

export const STOP_REASONS = [
  'worker-failed',
  'same-file-conflict',
  'public-api-approval-required',
  'reviewer-questions-blocking',
  're-dispatch-cap-exhausted',
  'wave-complete-pending-close',
  // #66 — Stall watchdog. Distinct from `worker-failed`: a stalled Worker may
  // still be running (the §6.5 finish-inline-vs-re-dispatch checklist applies),
  // whereas `worker-failed` is a confirmed test/lint failure. Carries `warn`
  // severity on the 1st stall, escalating to `blocking` at the hard ceiling.
  'worker-stalled',
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export const SEVERITIES = ['info', 'warn', 'error', 'blocking'] as const;
export type Severity = (typeof SEVERITIES)[number];

// ─── outcome types ────────────────────────────────────────────────────────────

export type TransitionOutcome = {
  type: 'transition';
  nextState: IssueState;
};

export type StopOutcome = {
  type: 'stop';
  reason: StopReason;
  severity: Severity;
};

export type WarnOutcome = {
  type: 'warn';
  reason: 'wallclock-exceeded';
};

export type NoopOutcome = {
  type: 'noop';
};

export type Outcome =
  | TransitionOutcome
  | StopOutcome
  | WarnOutcome
  | NoopOutcome;

// ─── helpers ──────────────────────────────────────────────────────────────────

function t(nextState: IssueState): TransitionOutcome {
  return { type: 'transition', nextState };
}

function stop(reason: StopReason, severity: Severity): StopOutcome {
  return { type: 'stop', reason, severity };
}

const warn: WarnOutcome = { type: 'warn', reason: 'wallclock-exceeded' };
const noop: NoopOutcome = { type: 'noop' };

// ─── transition table ─────────────────────────────────────────────────────────

/**
 * Resolve `(currentState, event)` to an outcome.
 *
 * @param currentState — Current issue state from the WAVE.md Plan-Table.
 * @param event        — The event that just occurred.
 * @param riskClass    — Optional; only consulted when `event = 'reviewer-approve'`.
 *                       When provided as `'public-API-change'`, the function
 *                       automatically routes to the `reviewer-approve-public-api`
 *                       path (STOP). Callers may alternatively pass
 *                       `'reviewer-approve-public-api'` as the `event` directly.
 *
 * @returns Outcome — transition | stop | warn | noop
 */
export function transition(
  currentState: IssueState,
  event: WaveEvent,
  riskClass?: Risk,
): Outcome {
  // Convenience: auto-promote reviewer-approve to public-api branch when the
  // caller supplied riskClass = 'public-API-change'.
  const resolvedEvent: WaveEvent =
    event === 'reviewer-approve' && riskClass === 'public-API-change'
      ? 'reviewer-approve-public-api'
      : event;

  switch (currentState) {
    // ── planned ──────────────────────────────────────────────────────────────
    case 'planned':
      // Worker hasn't been dispatched yet; no events are meaningful.
      return noop;

    // ── dispatched ───────────────────────────────────────────────────────────
    case 'dispatched':
      switch (resolvedEvent) {
        case 'worker-done':
          return t('report-in');
        case 'worker-needs-context':
          // Worker is context-starved-but-retryable (#53). Skip review and
          // auto re-dispatch with added context — consumes the re-dispatch
          // budget, same as a 1st changes-requested.
          return t('re-dispatched');
        case 'worker-failed-after-retry':
          return stop('worker-failed', 'error');
        case 'worker-failed-transient':
          // #66 — 1st attempt failed transiently (flaky test / worktree-reset
          // miss / transient 401). Auto-retry ONCE with backoff: consume the
          // re-dispatch budget exactly as `worker-needs-context` does.
          return t('re-dispatched');
        case 'worker-stalled':
          // #66 — 1st stall. Non-terminal STOP: surface the §6.5 worktree
          // checklist (warn) so the Coordinator inspects rather than waits.
          return stop('worker-stalled', 'warn');
        case 'same-file-conflict-detected':
          return stop('same-file-conflict', 'blocking');
        case 'wallclock-exceeded':
          return warn;
        default:
          return noop;
      }

    // ── report-in ─────────────────────────────────────────────────────────
    case 'report-in':
      switch (resolvedEvent) {
        case 'same-file-conflict-detected':
          return stop('same-file-conflict', 'blocking');
        case 'wallclock-exceeded':
          return warn;
        default:
          return noop;
      }

    // ── reviewing ─────────────────────────────────────────────────────────
    case 'reviewing':
      switch (resolvedEvent) {
        case 'reviewer-approve':
          return t('approved');
        case 'reviewer-approve-public-api':
          return stop('public-api-approval-required', 'blocking');
        case 'reviewer-changes-requested-1st':
          return t('re-dispatched');
        case 'reviewer-questions-blocking':
          return stop('reviewer-questions-blocking', 'blocking');
        case 'wallclock-exceeded':
          return warn;
        default:
          return noop;
      }

    // ── verdict-in ────────────────────────────────────────────────────────
    case 'verdict-in':
      switch (resolvedEvent) {
        case 'reviewer-approve':
          return t('approved');
        case 'reviewer-approve-public-api':
          return stop('public-api-approval-required', 'blocking');
        case 'reviewer-questions-blocking':
          return stop('reviewer-questions-blocking', 'blocking');
        default:
          return noop;
      }

    // ── re-dispatched ─────────────────────────────────────────────────────
    case 're-dispatched':
      switch (resolvedEvent) {
        case 'worker-done':
          // Second Worker iteration finishes — feeds back into reviewing.
          return t('report-in');
        case 'worker-needs-context':
          // A 2nd needs-context request would be the 3rd Worker attempt —
          // the re-dispatch budget (cap = 1) is exhausted, so STOP (#53).
          return stop('re-dispatch-cap-exhausted', 'error');
        case 'reviewer-changes-requested-2nd':
          return stop('re-dispatch-cap-exhausted', 'error');
        case 'reviewer-questions-blocking':
          return stop('reviewer-questions-blocking', 'blocking');
        case 'worker-failed-after-retry':
          return stop('worker-failed', 'error');
        case 'worker-failed-transient':
          // #66 — A transient failure on the 2nd (already-retried) attempt: the
          // single retry is spent. Route to the genuine hard-failure STOP — the
          // retry is bounded at cap 1, so termination stays guaranteed.
          return stop('worker-failed', 'error');
        case 'worker-stalled':
          // #66 — 2nd stall = hard ceiling. Escalate warn → blocking: the
          // Coordinator can no longer just wait; the wave must halt here.
          return stop('worker-stalled', 'blocking');
        case 'same-file-conflict-detected':
          return stop('same-file-conflict', 'blocking');
        case 'wallclock-exceeded':
          return warn;
        default:
          return noop;
      }

    // ── approved ─────────────────────────────────────────────────────────
    case 'approved':
      switch (resolvedEvent) {
        case 'reviewer-approve':
          // Loop-driver calls host-pr create (the engine verb) and sets state
          // to pr-created; if the driver emits this event before updating
          // state, resolve it here.
          return t('pr-created');
        case 'all-issues-done':
          return stop('wave-complete-pending-close', 'info');
        default:
          return noop;
      }

    // ── terminal states ───────────────────────────────────────────────────
    case 'pr-created':
    case 'failed':
    case 'abandoned':
    // ADR-0022: `parked` is terminal exactly like `abandoned` — every event is
    // invalid. The two differ only OFF the event path (claim + flag), not here.
    case 'parked':
      // Terminal states only respond to the wave-level all-issues-done signal.
      if (resolvedEvent === 'all-issues-done') {
        return stop('wave-complete-pending-close', 'info');
      }
      return noop;

    // ── exhaustiveness guard ────────────────────────────────────────────────
    // currentState is `never` here when the union is fully covered (compile-time
    // totality). At runtime the value arrives from durable I/O (the spine
    // Plan-Table state column), so a corrupt/unknown string is possible — fail
    // loud at the boundary rather than silently returning `undefined`.
    default: {
      const unknownState: never = currentState;
      throw new Error(
        `transition: unknown issue state ${JSON.stringify(unknownState)} (corrupt durable input?)`,
      );
    }
  }
}
