/**
 * wave-config.ts — minimal store-selection config slice.
 *
 * A thin config type + reader for choosing which IssueStore implementation to
 * use. Later P7.1 tasks extend this with wave-level options (schema, eligibility
 * overrides, etc.). Loaded from a JSON file; validated at read-time so callers
 * get a clear error rather than a runtime cast failure deep in the engine.
 */

import { readFileSync } from 'node:fs';
import type { VerifyConfig } from './verify';

export interface MarkdownStoreConfig {
  kind: 'markdown';
  repoRoot: string;
  slug: string;
  eligibility?: string[];
}

export interface GitHubStoreConfig {
  kind: 'github';
  eligibility?: string[];
}

export interface LinearStateMapConfig {
  queued?: string;    // default 'Todo'
  inFlight?: string;  // default 'In Progress'
  inReview?: string;  // default 'In Review'
  /**
   * Optional opt-in fallback done-state name. NO default — leave unset (the
   * recommended mode) and `done` stays fully DERIVED from the tracker's own
   * closing signal (ADR-0002/0020). Set this only for a consumer workspace with
   * NO Linear↔GitHub integration: it lets the close path force a transition to
   * this workflow state once the wave itself has confirmed the PR merged, since
   * the tracker's own probe can never see it otherwise (FOR-13).
   */
  doneState?: string;
}

export interface LinearStoreConfig {
  kind: 'linear';
  /** Linear team key or name — owns the workflow states + label namespace. Required. */
  team: string;
  /** Optional project name — the listOpen candidate filter (ADR-0020). */
  project?: string;
  eligibility?: string[];
  /** Claim-rung → workflow-state-name mapping (defaults per ADR-0020). */
  states?: LinearStateMapConfig;
  /** Schema-category → existing consumer label (e.g. {"bug":"Bug"}). */
  categoryLabels?: Record<string, string>;
}

export type StoreConfig = MarkdownStoreConfig | GitHubStoreConfig | LinearStoreConfig;

export interface WaveConfig {
  store: StoreConfig;
  /** Optional inline verify profile (ADR-0016). No DEFAULT_VERIFY — verify is purely consumer config. */
  verify?: VerifyConfig;
}

/**
 * Read + JSON-parse a wave config file. Throws with a clear message if the
 * `store` object is missing/null, or if `store.kind` is not a known
 * discriminant, so the consumer never receives a config it cannot act on.
 */
export function loadWaveConfig(path: string): WaveConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || !('store' in raw) || !(raw as { store?: unknown }).store || typeof (raw as { store?: unknown }).store !== 'object') {
    throw new Error('wave config must have a "store" object');
  }
  const kind = ((raw as { store: { kind?: unknown } }).store).kind;
  if (kind !== 'markdown' && kind !== 'github' && kind !== 'linear') {
    throw new Error(`unknown store kind: ${String(kind)}`);
  }

  // Validate linear-specific requirements
  if (kind === 'linear') {
    const team = ((raw as { store: { team?: unknown } }).store).team;
    if (!team || typeof team !== 'string' || team.trim().length === 0) {
      throw new Error('linear store config requires a "team" string');
    }
  }
  const verify = (raw as { verify?: unknown }).verify;
  if (verify !== undefined) {
    if (!verify || typeof verify !== 'object' || !Array.isArray((verify as { profiles?: unknown }).profiles)) {
      throw new Error('wave config "verify" must have a "profiles" array');
    }
  }
  return raw as WaveConfig;
}
