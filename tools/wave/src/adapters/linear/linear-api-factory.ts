/**
 * linear-api-factory.ts — the CLI-edge factory (ADR-0020, mirrors ADR-0019's
 * `github-api-factory.ts` pattern). It performs the impure wiring (read
 * LINEAR_API_KEY from the env) OUTSIDE `buildStore`, so the store factory stays
 * a pure assembler. A construction-time `Preflight` query fails a bad key
 * loudly up-front.
 *
 * KEY DIFFERENCE from the GitHub factory: Linear's `team`/`project` come from
 * the CONSUMER'S CONFIG (`LinearStoreConfig.team`/`.project`), not a git
 * remote — there is no `detectHost`-style derivation, because Linear is the
 * issue tracker, not the code host (the PR itself still lives on GitHub in
 * both M1/M2 consumers). `resolveStore` (cli-store.ts) passes them through
 * from `config.store`.
 */

import type { LinearApi } from './linear-api';
import { RealLinearApi } from './real-linear-api';
import type { LinearHttp } from './linear-http';

export interface LinearApiFactoryOptions {
  /** Linear team key or name — required, owns the workflow states + label namespace. */
  team: string;
  /** Optional project name — the listOpen candidate filter (ADR-0020). */
  project?: string;
  /** Injectable network seam (tests). Defaults to defaultLinearHttp inside RealLinearApi. */
  http?: LinearHttp;
  /** Environment to read LINEAR_API_KEY from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function createLinearApiFromEnv(opts: LinearApiFactoryOptions): Promise<LinearApi> {
  const env = opts.env ?? process.env;
  const token = env.LINEAR_API_KEY;
  if (!token) {
    throw new Error('LINEAR_API_KEY is required to build a linear IssueStore (ADR-0020). Export it before running.');
  }
  const api = new RealLinearApi(opts.team, opts.project, token, opts.http);
  await api.preflight(); // fail a bad key now, not mid-wave
  return api;
}
