import { describe, it, expect } from 'vitest';
import { createGitHubApiFromEnv } from './github-api-factory';
import { FakeGitHubHttp } from './github-http-fake';
import { CredentialResolutionError } from '../../credential-resolver';

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

  // ── The credential comes from the ONE resolver seam (ADR-0029) ──────────────
  //
  // These drive the REAL shell through a `GITHUB_TOKEN_CMD` lookup: the only way
  // the token reaching the HTTP seam can be the command's stdout is if this
  // factory resolves through the shared resolver rather than reading the env
  // itself. That is AC1 for this edge, proven rather than asserted.

  describe('credential resolution (ADR-0029)', () => {
    it('resolves GITHUB_TOKEN_CMD through the shell and hands ITS stdout to the API', async () => {
      const http = new FakeGitHubHttp((req) => {
        expect(req.token).toBe('tok-from-the-lookup');
        return { status: 200, json: { login: 'me' } };
      });
      await createGitHubApiFromEnv({
        env: { GITHUB_TOKEN_CMD: 'echo tok-from-the-lookup' },
        remoteUrl,
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('a configured command WINS over a set ambient GITHUB_TOKEN', async () => {
      const http = new FakeGitHubHttp((req) => {
        expect(req.token).toBe('tok-from-the-lookup');
        expect(req.token).not.toBe('ambient-tok');
        return { status: 200, json: { login: 'me' } };
      });
      await createGitHubApiFromEnv({
        env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'echo tok-from-the-lookup' },
        remoteUrl,
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('an empty GITHUB_TOKEN_CMD counts as not configured — the ambient token applies', async () => {
      const http = new FakeGitHubHttp((req) => {
        expect(req.token).toBe('ambient-tok');
        return { status: 200, json: { login: 'me' } };
      });
      await createGitHubApiFromEnv({
        env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: '   ' },
        remoteUrl,
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('a BROKEN lookup command fails loud, names the command, and never falls back to the ambient token', async () => {
      const http = new FakeGitHubHttp(() => {
        throw new Error('no request may be made without a resolved credential');
      });
      const err = await createGitHubApiFromEnv({
        env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'exit 9' },
        remoteUrl,
        http,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as CredentialResolutionError).failure).toBe('lookup-exit');
      expect((err as Error).message).toContain('exit 9');
      expect((err as Error).message).not.toContain('ambient-tok');
      expect(http.requests).toEqual([]); // no network without a credential
    });
  });
});
