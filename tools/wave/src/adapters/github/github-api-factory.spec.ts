import { describe, it, expect } from 'vitest';
import { createGitHubApiFromEnv } from './github-api-factory';
import { FakeGitHubHttp } from './github-http-fake';

describe('createGitHubApiFromEnv', () => {
  const remoteUrl = 'https://github.com/example-org/example-repo.git';

  it('builds a RealGitHubApi from GITHUB_TOKEN + git remote and preflights GET /user', async () => {
    const http = new FakeGitHubHttp((req) => {
      expect(req.url).toBe('https://api.github.com/user'); // preflight
      expect(req.token).toBe('tok-xyz');
      return { status: 200, json: { login: 'me' } };
    });
    const api = await createGitHubApiFromEnv({ env: { GITHUB_TOKEN: 'tok-xyz' }, remoteUrl, http });
    expect(http.requests).toHaveLength(1); // preflight ran at construction
    expect(typeof api.createIssue).toBe('function');
  });

  it('throws a clear error when GITHUB_TOKEN is missing', async () => {
    await expect(createGitHubApiFromEnv({ env: {}, remoteUrl })).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('throws when the remote is not a github host', async () => {
    await expect(
      createGitHubApiFromEnv({ env: { GITHUB_TOKEN: 't' }, remoteUrl: 'https://bitbucket.org/x/y.git' }),
    ).rejects.toThrow(/github/i);
  });

  it('propagates a 401 preflight failure', async () => {
    const http = new FakeGitHubHttp(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    await expect(
      createGitHubApiFromEnv({ env: { GITHUB_TOKEN: 'bad' }, remoteUrl, http }),
    ).rejects.toMatchObject({ status: 401, op: 'preflight' });
  });
});
