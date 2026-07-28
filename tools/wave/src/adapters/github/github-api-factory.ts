/**
 * github-api-factory.ts — the CLI-edge factory (ADR-0019). It performs the
 * impure wiring (resolve the GitHub credential, derive owner/repo from the git
 * remote via host-pr's detectHost) OUTSIDE `buildStore`, so the store factory
 * stays a pure assembler. A construction-time `GET /user` preflight fails a bad
 * token loudly up-front.
 *
 * The credential comes from the ONE engine-owned resolver (ADR-0029), never
 * from a lookup copy of its own: `GITHUB_TOKEN_CMD` (a lookup command, spawned
 * through the platform shell and bounded at 60 s) wins over an ambient
 * `GITHUB_TOKEN`, and a configured command that fails is a typed loud error
 * rather than a silent fallback to the ambient variable.
 */

import { execFileSync } from 'node:child_process';
import type { GitHubApi } from './github-api';
import { RealGitHubApi } from './real-github-api';
import { detectHost } from '../../host-pr';
import { resolveCredential } from '../../credential-resolver';
import type { GitHubHttp } from './github-http';

export interface GitHubApiFactoryOptions {
  /** Injectable network seam (tests). Defaults to defaultGitHubHttp inside RealGitHubApi. */
  http?: GitHubHttp;
  /**
   * Environment the credential is resolved from — `GITHUB_TOKEN_CMD` (a lookup
   * command) or `GITHUB_TOKEN` (ambient). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
  /** Git remote URL. Defaults to `git remote get-url origin` in cwd. */
  remoteUrl?: string;
}

export async function createGitHubApiFromEnv(opts: GitHubApiFactoryOptions = {}): Promise<GitHubApi> {
  // One resolver seam (ADR-0029) — the token is never read out of the env here.
  const token = resolveCredential('GITHUB_TOKEN', {
    env: opts.env,
    purpose: 'build a github IssueStore (ADR-0019)',
  });
  const remoteUrl = opts.remoteUrl ?? gitRemoteUrl();
  const info = detectHost(remoteUrl);
  if (info.host !== 'github') {
    throw new Error(`expected a github remote, got host "${info.host}" from "${remoteUrl}"`);
  }
  const api = new RealGitHubApi(info.workspace, info.repo, token, opts.http);
  await api.preflight(); // fail a bad token now, not mid-wave
  return api;
}

/** Read the origin remote URL (local git read — not a gh-creds call, sandbox-OK). */
function gitRemoteUrl(): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
}
