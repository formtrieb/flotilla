/**
 * cli-store.spec.ts — TDD spec for the `resolveStore` CLI-edge dispatcher
 * (Task 7). There was no prior dedicated spec for this file (the github arm's
 * wiring is only exercised indirectly, via `github-api-factory.spec.ts` +
 * `store-factory.spec.ts` in isolation) — this spec closes that gap for both
 * arms so the new `linear` branch gets real dispatch-level coverage, not just
 * its constituent pieces.
 *
 * Both real factories perform a network preflight at construction time, so
 * they are mocked here purely to keep this spec hermetic + fast; the
 * factories' own behavior (missing-token errors, preflight wiring) is covered
 * by their own specs (`github-api-factory.spec.ts` / `linear-api-factory.spec.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
import type { IssueStore } from './adapters/issue-store';

const createGitHubApiFromEnv = vi.fn();
const createLinearApiFromEnv = vi.fn();

vi.mock('./adapters/github/github-api-factory', () => ({
  createGitHubApiFromEnv: (...args: unknown[]) => createGitHubApiFromEnv(...args),
}));
vi.mock('./adapters/linear/linear-api-factory', () => ({
  createLinearApiFromEnv: (...args: unknown[]) => createLinearApiFromEnv(...args),
}));

// resolveStore is imported AFTER the mocks above so it picks up the mocked factories.
const { resolveStore, preflightStore, runStorePreflight } = await import('./cli-store');

function writeConfig(dir: string, json: unknown): string {
  const path = join(dir, 'wave.config.json');
  writeFileSync(path, JSON.stringify(json), 'utf8');
  return path;
}

describe('resolveStore', () => {
  beforeEach(() => {
    createGitHubApiFromEnv.mockReset();
    createLinearApiFromEnv.mockReset();
  });

  it('returns the injected store as-is, without touching the config file', async () => {
    const injected = {} as IssueStore;
    const store = await resolveStore(['--config', '/nonexistent/wave.config.json'], injected);
    expect(store).toBe(injected);
    expect(createGitHubApiFromEnv).not.toHaveBeenCalled();
    expect(createLinearApiFromEnv).not.toHaveBeenCalled();
  });

  it('builds a MarkdownFsStore for a markdown config without calling either factory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'cli-store-repo-'));
    mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
    const path = writeConfig(dir, { store: { kind: 'markdown', repoRoot, slug: '2026-07-10-x' } });

    const store = await resolveStore(['--config', path]);

    expect(store).toBeInstanceOf(MarkdownFsStore);
    expect(createGitHubApiFromEnv).not.toHaveBeenCalled();
    expect(createLinearApiFromEnv).not.toHaveBeenCalled();
  });

  it('builds a GitHubIssuesStore via createGitHubApiFromEnv for a github config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-'));
    const path = writeConfig(dir, { store: { kind: 'github' } });
    const api = new InMemoryGitHubApi();
    createGitHubApiFromEnv.mockResolvedValue(api);

    const store = await resolveStore(['--config', path]);

    expect(createGitHubApiFromEnv).toHaveBeenCalledTimes(1);
    expect(createGitHubApiFromEnv).toHaveBeenCalledWith();
    expect(createLinearApiFromEnv).not.toHaveBeenCalled();
    expect(store).toBeInstanceOf(GitHubIssuesStore);
  });

  it('builds a LinearIssuesStore via createLinearApiFromEnv, passing team/project through from config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-'));
    const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX', project: 'Example Project' } });
    const api = new InMemoryLinearApi();
    createLinearApiFromEnv.mockResolvedValue(api);

    const store = await resolveStore(['--config', path]);

    expect(createLinearApiFromEnv).toHaveBeenCalledTimes(1);
    expect(createLinearApiFromEnv).toHaveBeenCalledWith({ team: 'EX', project: 'Example Project' });
    expect(createGitHubApiFromEnv).not.toHaveBeenCalled();
    expect(store).toBeInstanceOf(LinearIssuesStore);
  });

  it('builds a LinearIssuesStore for a linear config with no project (optional per LinearStoreConfig)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-'));
    const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
    const api = new InMemoryLinearApi();
    createLinearApiFromEnv.mockResolvedValue(api);

    await resolveStore(['--config', path]);

    expect(createLinearApiFromEnv).toHaveBeenCalledWith({ team: 'EX', project: undefined });
  });
});

// A fresh Linear team that has every default state EXCEPT "In Review" — the
// canonical AC3 fresh-workspace fixture (the state map names a state the team
// lacks). Reused by both the direct-probe and CLI-verb suites below.
const FRESH_TEAM_MISSING_IN_REVIEW = [
  { name: 'Triage', type: 'triage' as const },
  { name: 'Backlog', type: 'backlog' as const },
  { name: 'Todo', type: 'unstarted' as const },
  { name: 'In Progress', type: 'started' as const },
  { name: 'Done', type: 'completed' as const },
  { name: 'Canceled', type: 'canceled' as const },
];

function statusByName(checks: { name: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

describe('preflightStore (FOR-12) — probes TRACKER preconditions through the API seam', () => {
  // Single-owner move (ADR-0023 amendment): the store-preflight reports ONLY the
  // two tracker facts. The three code-host checks (pr-merge-token,
  // allow-auto-merge, required-checks) left it entirely for `host-pr preflight` —
  // asserted absent below and covered for real in host-pr(-cli).spec.ts.
  const CODE_HOST_CHECKS = ['pr-merge-token', 'allow-auto-merge', 'required-checks'];

  it('github: the tracker checks are both n/a (GitHub is its own host, claims are labels)', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(true);
    expect(report.storeKind).toBe('github');
    const by = statusByName(report.checks);
    expect(by['tracker-host-integration']).toBe('not-applicable'); // GitHub is its own host
    expect(by['state-catalog']).toBe('not-applicable'); // GitHub claims are labels
  });

  it('the CheckName union no longer carries the code-host checks — they moved to host-pr preflight (ADR-0023 amendment)', async () => {
    for (const config of [
      { store: { kind: 'github' as const } },
      { store: { kind: 'linear' as const, team: 'EX' } },
      { store: { kind: 'markdown' as const, repoRoot: '/tmp/x', slug: '2026-07-20-x' } },
    ]) {
      const store =
        config.store.kind === 'linear'
          ? new LinearIssuesStore({ api: new InMemoryLinearApi() })
          : config.store.kind === 'github'
            ? new GitHubIssuesStore({ api: new InMemoryGitHubApi() })
            : ({} as IssueStore);
      const report = await preflightStore(config, store);
      const names = report.checks.map((c) => c.name);
      // Only tracker facts remain — no code-host check appears on ANY store kind.
      expect(names.every((n) => n === 'tracker-host-integration' || n === 'state-catalog')).toBe(true);
      expect(names.some((n) => CODE_HOST_CHECKS.includes(n))).toBe(false);
    }
  });

  it('linear: every tracker precondition passes on a healthy workspace (integration + full catalog)', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    expect(report.ok).toBe(true);
    const by = statusByName(report.checks);
    expect(by['tracker-host-integration']).toBe('pass');
    expect(by['state-catalog']).toBe('pass');
  });

  it('AC3 — fresh workspace: the state map names a state the team lacks (missing In Review) → FAILS loudly', async () => {
    const api = new InMemoryLinearApi();
    api.setStateCatalog(FRESH_TEAM_MISSING_IN_REVIEW);
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    expect(report.ok).toBe(false);
    const catalog = report.checks.find((c) => c.name === 'state-catalog');
    expect(catalog?.status).toBe('fail');
    expect(catalog?.detail).toContain('In Review'); // names the EXACT missing state, loudly
  });

  it('linear: a missing GitHub integration with NO doneState fallback → FAILS loudly', async () => {
    const api = new InMemoryLinearApi();
    api.setGitHubIntegration(false);
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'tracker-host-integration')?.status).toBe('fail');
  });

  it('linear: a missing GitHub integration BUT a configured states.doneState → integration is n/a, not a fail (FOR-13)', async () => {
    const api = new InMemoryLinearApi();
    api.setGitHubIntegration(false);
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore(
      { store: { kind: 'linear', team: 'EX', states: { doneState: 'Done' } } },
      store,
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'tracker-host-integration')?.status).toBe('not-applicable');
  });

  it('linear: a configured doneState the team lacks is caught by the catalog check', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const report = await preflightStore(
      { store: { kind: 'linear', team: 'EX', states: { doneState: 'Shipped' } } },
      store,
    );

    expect(report.ok).toBe(false);
    const catalog = report.checks.find((c) => c.name === 'state-catalog');
    expect(catalog?.status).toBe('fail');
    expect(catalog?.detail).toContain('Shipped');
  });

  it('markdown: every check is not-applicable and the report is ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-md-'));
    const store = new MarkdownFsStore({ repoRoot: dir, slug: '2026-07-16-x' });
    const report = await preflightStore(
      { store: { kind: 'markdown', repoRoot: dir, slug: '2026-07-16-x' } },
      store,
    );

    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status === 'not-applicable')).toBe(true);
  });
});

describe('runStorePreflight (FOR-12) — the CLI verb wave-setup runs', () => {
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
      stderr += String(c);
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits 0 and prints the report for a healthy injected linear store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
    const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });

    const code = await runStorePreflight(['preflight', '--config', path], store);

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.storeKind).toBe('linear');
  });

  it('exits 1 (loud) when a configured state is missing from the team catalog (AC3 via the CLI)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
    const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
    const api = new InMemoryLinearApi();
    api.setStateCatalog(FRESH_TEAM_MISSING_IN_REVIEW);
    const store = new LinearIssuesStore({ api });

    const code = await runStorePreflight(['preflight', '--config', path], store);

    expect(code).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
    expect(stdout).toContain('In Review');
  });

  it('exits 2 on an unknown op', async () => {
    const code = await runStorePreflight(['bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/only "preflight"/);
  });

  it('exits 2 when the config file is unreadable', async () => {
    const code = await runStorePreflight(['preflight', '--config', '/nonexistent/does-not-exist.json']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/error:/);
  });
});
