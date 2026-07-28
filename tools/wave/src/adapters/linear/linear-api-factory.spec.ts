import { describe, it, expect } from 'vitest';
import { createLinearApiFromEnv } from './linear-api-factory';
import { FakeLinearHttp } from './linear-http-fake';
import { CredentialResolutionError } from '../../credential-resolver';

describe('createLinearApiFromEnv', () => {
  it('builds a RealLinearApi from LINEAR_API_KEY + config team/project and preflights the Preflight query', async () => {
    const http = new FakeLinearHttp({
      Preflight: (req) => {
        expect(req.token).toBe('lin_api_xyz');
        return { status: 200, json: { data: { viewer: { id: 'user-1' } } } };
      },
    });
    const api = await createLinearApiFromEnv({
      env: { LINEAR_API_KEY: 'lin_api_xyz' },
      team: 'EX',
      project: 'Example Project',
      http,
    });
    expect(http.requests).toHaveLength(1); // preflight ran at construction
    expect(typeof api.createIssue).toBe('function');
  });

  it('works without a project (project is optional per LinearStoreConfig)', async () => {
    const http = new FakeLinearHttp({
      Preflight: () => ({ status: 200, json: { data: { viewer: { id: 'user-1' } } } }),
    });
    const api = await createLinearApiFromEnv({
      env: { LINEAR_API_KEY: 'lin_api_xyz' },
      team: 'EX',
      http,
    });
    expect(typeof api.listOpenIssues).toBe('function');
  });

  it('throws a clear error when LINEAR_API_KEY is missing', async () => {
    await expect(createLinearApiFromEnv({ env: {}, team: 'EX' })).rejects.toThrow(/LINEAR_API_KEY/);
  });

  it('propagates a preflight failure (bad key)', async () => {
    const http = new FakeLinearHttp({
      Preflight: () => ({ status: 401, json: { errors: [{ message: 'Authentication required' }] } }),
    });
    await expect(
      createLinearApiFromEnv({ env: { LINEAR_API_KEY: 'bad' }, team: 'EX', http }),
    ).rejects.toMatchObject({ status: 401, op: 'Preflight' });
  });

  // ── The credential comes from the ONE resolver seam (ADR-0029) ──────────────
  //
  // The mechanical `<VAR>_CMD` naming is what lets this adapter inherit the
  // whole contract without a line of credential logic: `LINEAR_API_KEY_CMD` is
  // `LINEAR_API_KEY`'s command counterpart, with the same precedence and the
  // same loud failures as the GitHub pair.

  describe('credential resolution (ADR-0029)', () => {
    it('resolves LINEAR_API_KEY_CMD through the shell and hands ITS stdout to the API', async () => {
      const http = new FakeLinearHttp({
        Preflight: (req) => {
          expect(req.token).toBe('lin-from-the-lookup');
          return { status: 200, json: { data: { viewer: { id: 'user-1' } } } };
        },
      });
      await createLinearApiFromEnv({
        env: { LINEAR_API_KEY_CMD: 'echo lin-from-the-lookup' },
        team: 'EX',
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('a configured command WINS over a set ambient LINEAR_API_KEY', async () => {
      const http = new FakeLinearHttp({
        Preflight: (req) => {
          expect(req.token).toBe('lin-from-the-lookup');
          expect(req.token).not.toBe('ambient-key');
          return { status: 200, json: { data: { viewer: { id: 'user-1' } } } };
        },
      });
      await createLinearApiFromEnv({
        env: { LINEAR_API_KEY: 'ambient-key', LINEAR_API_KEY_CMD: 'echo lin-from-the-lookup' },
        team: 'EX',
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('an empty LINEAR_API_KEY_CMD counts as not configured — the ambient key applies', async () => {
      const http = new FakeLinearHttp({
        Preflight: (req) => {
          expect(req.token).toBe('ambient-key');
          return { status: 200, json: { data: { viewer: { id: 'user-1' } } } };
        },
      });
      await createLinearApiFromEnv({
        env: { LINEAR_API_KEY: 'ambient-key', LINEAR_API_KEY_CMD: '' },
        team: 'EX',
        http,
      });
      expect(http.requests).toHaveLength(1);
    });

    it('a BROKEN lookup command fails loud, names the command, and never falls back to the ambient key', async () => {
      const http = new FakeLinearHttp({
        Preflight: () => {
          throw new Error('no request may be made without a resolved credential');
        },
      });
      const err = await createLinearApiFromEnv({
        env: { LINEAR_API_KEY: 'ambient-key', LINEAR_API_KEY_CMD: 'exit 9' },
        team: 'EX',
        http,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as CredentialResolutionError).failure).toBe('lookup-exit');
      expect((err as Error).message).toContain('exit 9');
      expect((err as Error).message).not.toContain('ambient-key');
      expect(http.requests).toEqual([]); // no network without a credential
    });
  });
});
