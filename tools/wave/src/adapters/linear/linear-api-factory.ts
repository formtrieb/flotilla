/**
 * linear-api-factory.ts — the CLI-edge factory (ADR-0020, mirrors ADR-0019's
 * `github-api-factory.ts` pattern). It performs the impure wiring (resolve the
 * Linear credential) OUTSIDE `buildStore`, so the store factory stays a pure
 * assembler. A construction-time `Preflight` query fails a bad key loudly
 * up-front.
 *
 * The credential comes from the ONE engine-owned resolver (ADR-0029), never
 * from a lookup copy of its own: `LINEAR_API_KEY_CMD` (a lookup command,
 * spawned through the platform shell and bounded at 60 s) wins over an ambient
 * `LINEAR_API_KEY`, and a configured command that fails is a typed loud error
 * rather than a silent fallback to the ambient variable. The mechanical
 * `<VAR>_CMD` naming is why this adapter needed no credential logic of its own.
 *
 * KEY DIFFERENCE from the GitHub factory: Linear's `team`/`project` come from
 * the CONSUMER'S CONFIG (`LinearStoreConfig.team`/`.project`), not a git
 * remote — there is no `detectHost`-style derivation, because Linear is the
 * issue tracker, not the code host (the PR itself still lives on GitHub in
 * both M1/M2 consumers). `resolveStore` (cli-store.ts) passes them through
 * from `config.store`.
 *
 * POINTER: the adapter's page size (100) departs from Linear's documented
 * default (50). That accepted divergence is declared at its four points of
 * departure — the `first: 100` call sites in `real-linear-api.ts`
 * (`listOpenIssues`, `listDocuments`, `listProjects`, `listProjectIssues`) —
 * because that is where a reader changing the value will be.
 */

import type { LinearApi } from './linear-api';
import { RealLinearApi } from './real-linear-api';
import { resolveCredential } from '../../credential-resolver';
import type { LinearHttp } from './linear-http';

export interface LinearApiFactoryOptions {
  /** Linear team key or name — required, owns the workflow states + label namespace. */
  team: string;
  /** Optional project name — the listOpen candidate filter (ADR-0020). */
  project?: string;
  /** Injectable network seam (tests). Defaults to defaultLinearHttp inside RealLinearApi. */
  http?: LinearHttp;
  /**
   * Environment the credential is resolved from — `LINEAR_API_KEY_CMD` (a lookup
   * command) or `LINEAR_API_KEY` (ambient). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
}

export async function createLinearApiFromEnv(opts: LinearApiFactoryOptions): Promise<LinearApi> {
  // One resolver seam (ADR-0029) — the key is never read out of the env here.
  const token = resolveCredential('LINEAR_API_KEY', {
    env: opts.env,
    purpose: 'build a linear IssueStore (ADR-0020)',
  });
  const api = new RealLinearApi(opts.team, opts.project, token, opts.http);
  await api.preflight(); // fail a bad key now, not mid-wave
  return api;
}
