/**
 * store-factory.ts — factory that builds the correct IssueStore from a WaveConfig.
 *
 * The real `gh`/HTTP GitHubApi implementation is deferred to P8 (end-to-end
 * integration). Until then, callers that want a GitHub store must inject an
 * in-memory fake via `deps.githubApi`; production callers with no injected api
 * receive a clear deferral error rather than a silent no-op.
 */

import type { IssueStore } from './adapters/issue-store';
import type { GitHubApi } from './adapters/github/github-api';
import type { LinearApi } from './adapters/linear/linear-api';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import type { WaveConfig } from './wave-config';

export interface StoreDeps {
  /** Injected GitHubApi implementation. Required when store.kind === 'github'. */
  githubApi?: GitHubApi;
  /** Injected LinearApi implementation. Required when store.kind === 'linear'. Built in Task 3; CLI edge wires it in Task 7. */
  linearApi?: LinearApi;
}

/**
 * Build the IssueStore described by `config`.
 *
 * - markdown → `MarkdownFsStore`
 * - github + `deps.githubApi` → `GitHubIssuesStore` (with injected api)
 * - github without api → throws a P8 deferral error
 * - linear + `deps.linearApi` → `LinearIssuesStore` (with injected api)
 * - linear without api → throws a deferral error (real LinearApi at the CLI edge, Task 7)
 */
export function buildStore(config: WaveConfig, deps?: StoreDeps): IssueStore {
  const s = config.store;

  if (s.kind === 'markdown') {
    return new MarkdownFsStore({
      repoRoot: s.repoRoot,
      slug: s.slug,
      eligibility: s.eligibility,
    });
  }

  if (s.kind === 'github') {
    if (!deps?.githubApi) {
      throw new Error(
        'real GitHubApi lands in P8; inject deps.githubApi for tests',
      );
    }
    return new GitHubIssuesStore({
      api: deps.githubApi,
      eligibility: s.eligibility,
    });
  }

  if (s.kind === 'linear') {
    if (!deps?.linearApi) {
      throw new Error('LinearIssuesStore requires an injected deps.linearApi (built in Task 3; CLI edge wires it in Task 7)');
    }
    return new LinearIssuesStore({
      api: deps.linearApi,
      ...(s.eligibility !== undefined ? { eligibility: s.eligibility } : {}),
      ...(s.states !== undefined ? { states: s.states } : {}),
      ...(s.categoryLabels !== undefined ? { categoryLabels: s.categoryLabels } : {}),
    });
  }

  const _exhaustive: never = s;
  throw new Error(`unhandled store kind: ${String((_exhaustive as { kind?: unknown }).kind)}`);
}
