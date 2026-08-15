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
 * ── ACCEPTED DIVERGENCE: this adapter's page size is 100, the document's is 50
 *
 * Declared at this adapter's config edge because it is an adapter-WIDE choice
 * rather than a property of any one query. Every paged read the Linear adapter
 * makes asks for `first: 100`, where Linear's own pagination reference
 * (linear.app/developers/pagination, re-read 2026-08-15) states *"The first 50
 * results are returned by default without query arguments"* and names no
 * maximum. So the requested page is twice the documented default, on purpose.
 *
 * Deliberate and benign, for a reason that is about cost and not about
 * completeness: every one of those loops drains `pageInfo.hasNextPage` to a
 * cursor exhaustion rather than trusting a single page, so the number changes
 * how many round-trips a full read costs and can never change WHAT it returns.
 * A smaller page would be more requests for the identical result set; a larger
 * one is the same result set sooner. It is written down rather than left
 * implicit because an undeclared departure from a documented default is the
 * class this repo grades at review (ADR-0030) — an unstated 100 reads as
 * someone not having checked, which is the one thing it is not.
 *
 * The value itself lives at the four `first: 100` call sites in
 * `real-linear-api.ts` (`listOpenIssues`, `listDocuments`, `listProjects`,
 * `listProjectIssues`), which is where a reader changing it will be.
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
