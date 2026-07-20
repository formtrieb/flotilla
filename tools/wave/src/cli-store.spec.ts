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

describe('preflightStore (FOR-12) — probes preconditions through the API seam', () => {
  it('github: pr-merge passes when the token can merge; integration + catalog are n/a', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(true);
    expect(report.storeKind).toBe('github');
    const by = statusByName(report.checks);
    expect(by['pr-merge-token']).toBe('pass');
    expect(by['tracker-host-integration']).toBe('not-applicable'); // GitHub is its own host
    expect(by['state-catalog']).toBe('not-applicable'); // GitHub claims are labels
  });

  it('github: FAILS loudly when the ambient token cannot merge PRs (read-only token)', async () => {
    const api = new InMemoryGitHubApi();
    api.setCanMergePullRequests(false);
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    expect(report.ok).toBe(false);
    const merge = report.checks.find((c) => c.name === 'pr-merge-token');
    expect(merge?.status).toBe('fail');
    expect(merge?.detail).toMatch(/write/i);
  });

  it('linear: every precondition passes on a healthy workspace (integration + full catalog)', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    expect(report.ok).toBe(true);
    const by = statusByName(report.checks);
    expect(by['tracker-host-integration']).toBe('pass');
    expect(by['state-catalog']).toBe('pass');
    expect(by['pr-merge-token']).toBe('not-applicable'); // PRs merge on GitHub, not Linear
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

  // ── ADR-0023 landing preconditions (FOR-26) ──────────────────────────

  it('github: allow-auto-merge PASSES when the repo setting is on', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(true);
    const check = report.checks.find((c) => c.name === 'allow-auto-merge');
    expect(check?.status).toBe('pass');
  });

  it('github: allow-auto-merge FAILS with a fix instruction when the setting is off (the GitHub default)', async () => {
    const api = new InMemoryGitHubApi();
    api.setAllowsAutoMerge(false);
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    expect(report.ok).toBe(false); // a HARD functional precondition (ADR-0023)
    const check = report.checks.find((c) => c.name === 'allow-auto-merge');
    expect(check?.status).toBe('fail');
    // The instruction must be actionable, not just a diagnosis.
    expect(check?.detail).toMatch(/Settings/i);
    expect(check?.detail).toMatch(/auto-merge/i);
  });

  it('github: required-checks is ADVISORY when present — reported, never a FAIL', async () => {
    const api = new InMemoryGitHubApi();
    api.setRequiredChecks({ state: 'present', contexts: ['ci/test', 'ci/lint'], detail: 'two checks' });
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    const check = report.checks.find((c) => c.name === 'required-checks');
    expect(check?.status).toBe('advisory');
    expect(check?.detail).toContain('ci/test');
    expect(report.ok).toBe(true);
  });

  it('github: a no-CI repo KEEPS --auto — required-checks absent is advisory + states the consequence', async () => {
    const api = new InMemoryGitHubApi();
    api.setRequiredChecks({ state: 'absent', contexts: [], detail: 'no required checks' });
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    // ADR-0023: visibility over gatekeeping. This must NOT block.
    expect(report.ok).toBe(true);
    const check = report.checks.find((c) => c.name === 'required-checks');
    expect(check?.status).toBe('advisory');
    // The confirm has to be able to say "confirming means immediate merge".
    expect(check?.detail).toMatch(/immediate|immediately/i);
  });

  it('github: an unreadable required-checks probe (needs admin) is advisory unknown, never a FAIL', async () => {
    const api = new InMemoryGitHubApi();
    api.setRequiredChecks({ state: 'unknown', contexts: [], detail: 'HTTP 403 — admin rights required' });
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'required-checks')?.status).toBe('advisory');
  });

  it('an advisory check NEVER drags ok to false, even alongside a real failure', async () => {
    const api = new InMemoryGitHubApi();
    api.setCanMergePullRequests(false); // one genuine FAIL
    api.setRequiredChecks({ state: 'absent', contexts: [], detail: 'none' });
    const report = await preflightStore({ store: { kind: 'github' } }, new GitHubIssuesStore({ api }));

    expect(report.ok).toBe(false); // …caused by pr-merge-token, not by the advisory
    expect(report.checks.find((c) => c.name === 'pr-merge-token')?.status).toBe('fail');
    expect(report.checks.find((c) => c.name === 'required-checks')?.status).toBe('advisory');
  });

  it('linear: both landing probes are not-applicable (PRs land on GitHub, ADR-0020)', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    expect(report.ok).toBe(true);
    const by = statusByName(report.checks);
    expect(by['allow-auto-merge']).toBe('not-applicable');
    expect(by['required-checks']).toBe('not-applicable');
  });

  it('markdown: both landing probes are not-applicable', async () => {
    const report = await preflightStore(
      { store: { kind: 'markdown', repoRoot: '/tmp/x', slug: '2026-07-16-x' } },
      {} as IssueStore,
    );
    const by = statusByName(report.checks);
    expect(by['allow-auto-merge']).toBe('not-applicable');
    expect(by['required-checks']).toBe('not-applicable');
    expect(report.ok).toBe(true);
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
