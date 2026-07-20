import { describe, it, expect } from 'vitest';
import { createLinearApiFromEnv } from './linear-api-factory';
import { FakeLinearHttp } from './linear-http-fake';

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
});
