/**
 * github-api-factory.ts — the CLI-edge factory (ADR-0019). It performs the
 * impure wiring (read GITHUB_TOKEN from the env, derive owner/repo from the git
 * remote via host-pr's detectHost) OUTSIDE `buildStore`, so the store factory
 * stays a pure assembler. A construction-time `GET /user` preflight fails a bad
 * token loudly up-front.
 */

import { execFileSync } from 'node:child_process';
import type { GitHubApi } from './github-api';
import { RealGitHubApi } from './real-github-api';
import { detectHost } from '../../host-pr';
import type { GitHubHttp } from './github-http';

export interface GitHubApiFactoryOptions {
  /** Injectable network seam (tests). Defaults to defaultGitHubHttp inside RealGitHubApi. */
  http?: GitHubHttp;
  /** Environment to read GITHUB_TOKEN from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Git remote URL. Defaults to `git remote get-url origin` in cwd. */
  remoteUrl?: string;
}

export async function createGitHubApiFromEnv(opts: GitHubApiFactoryOptions = {}): Promise<GitHubApi> {
  const env = opts.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to build a github IssueStore (ADR-0019). Export it before running.');
  }
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
