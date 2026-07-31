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
 *
 * PUBLIC-API PAIRING (issue #325): the store-preflight family is root-exported,
 * and its pairing spec is `index.spec.ts`, NOT this file — this one mocks the api
 * factories at module scope, which is exactly the environment a root-import
 * assertion must not run in, and a barrel assertion buried in a CLI-edge spec
 * reads as a stray rather than as the contract it is. Behaviour lives here;
 * "the package root really offers these names" lives there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
const {
  resolveStore,
  preflightStore,
  runStorePreflight,
  runStorePreflightSubcommand,
  // ADR-0032 — the plugin/engine lockstep surface this module owns.
  engineManifestPath,
  readEngineVersion,
  compareEngineVersion,
  engineVersionExitCode,
  engineVersionPreflightCheck,
} = await import('./cli-store');
// The router, imported the same way (it pulls in cli-store, so it must see the
// same mocked factories). Used only to pin the `store-preflight` subcommand's
// wiring back to THIS module (issue #77).
const { main, mainAsync } = await import('./cli');

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

  it('github: tracker-host-integration is n/a (GitHub is its own host); state-catalog is a REAL check', async () => {
    const api = new InMemoryGitHubApi();
    api.setRepoLabels([
      'ready-for-agent',
      'risk/mechanical',
      'risk/isolated-refactor',
      'risk/cross-feature-refactor',
      'risk/public-API-change',
      'worker/background',
      'worker/background-heavy',
      'worker/foreground',
      'worker/HITL-required',
      'wave/queued',
      'wave/in-flight',
      'wave/in-review',
      'wave/needs-attention',
    ]);
    const store = new GitHubIssuesStore({ api });
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(true);
    expect(report.storeKind).toBe('github');
    const by = statusByName(report.checks);
    expect(by['tracker-host-integration']).toBe('not-applicable'); // GitHub is its own host
    expect(by['state-catalog']).toBe('pass'); // every wave label the repo needs already exists
  });

  // ── issue #131 — the GitHub state-catalog translation actually probes labels ──
  //
  // GitHub's claims ARE labels, which is exactly why there is something to
  // verify (the prior behavior reported `not-applicable` and never looked).

  it('github: an unconfigured repo (zero labels created) FAILS loudly rather than reporting n/a', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() }); // default: no repo labels
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'state-catalog')?.status).toBe('fail');
  });

  it('github: a missing label is named EXACTLY (copy-paste, not a hunt)', async () => {
    const api = new InMemoryGitHubApi();
    api.setRepoLabels([
      'ready-for-agent',
      'risk/mechanical',
      'risk/isolated-refactor',
      'risk/cross-feature-refactor',
      'risk/public-API-change',
      'worker/background',
      'worker/background-heavy',
      'worker/foreground',
      'worker/HITL-required',
      'wave/queued',
      'wave/in-flight',
      // 'wave/in-review' and 'wave/needs-attention' deliberately absent
    ]);
    const store = new GitHubIssuesStore({ api });
    const report = await preflightStore({ store: { kind: 'github' } }, store);

    expect(report.ok).toBe(false);
    const catalog = report.checks.find((c) => c.name === 'state-catalog');
    expect(catalog?.status).toBe('fail');
    expect(catalog?.detail).toContain('"wave/in-review"');
    expect(catalog?.detail).toContain('"wave/needs-attention"');
  });

  it('github: follows a CONFIGURED eligibility label instead of the built-in default', async () => {
    const api = new InMemoryGitHubApi();
    api.setRepoLabels([
      'agent-ok', // the configured eligibility label, NOT the 'ready-for-agent' default
      'risk/mechanical',
      'risk/isolated-refactor',
      'risk/cross-feature-refactor',
      'risk/public-API-change',
      'worker/background',
      'worker/background-heavy',
      'worker/foreground',
      'worker/HITL-required',
      'wave/queued',
      'wave/in-flight',
      'wave/in-review',
      'wave/needs-attention',
    ]);
    const store = new GitHubIssuesStore({ api, eligibility: ['agent-ok'] });
    const report = await preflightStore(
      { store: { kind: 'github', eligibility: ['agent-ok'] } },
      store,
    );

    expect(report.ok).toBe(true); // the default 'ready-for-agent' is NOT required here
  });

  it('github: a configured eligibility label that was never created is reported missing by its exact name', async () => {
    const api = new InMemoryGitHubApi();
    api.setRepoLabels([
      'risk/mechanical',
      'risk/isolated-refactor',
      'risk/cross-feature-refactor',
      'risk/public-API-change',
      'worker/background',
      'worker/background-heavy',
      'worker/foreground',
      'worker/HITL-required',
      'wave/queued',
      'wave/in-flight',
      'wave/in-review',
      'wave/needs-attention',
    ]); // 'agent-ok' never created
    const store = new GitHubIssuesStore({ api, eligibility: ['agent-ok'] });
    const report = await preflightStore(
      { store: { kind: 'github', eligibility: ['agent-ok'] } },
      store,
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'state-catalog')?.detail).toContain('"agent-ok"');
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

  // ── the `{{wave-cli}} store-preflight` router spelling (issue #77) ──────────
  //
  // The probe used to be reachable ONLY as this runnable module. It is now also
  // a `cli.ts` subcommand, so the whole engine surface speaks one
  // `{{wave-cli}} <sub>` idiom (the precondition for a single npm `bin`). The
  // subcommand is NOT a second implementation: `runStorePreflightSubcommand`
  // only prepends the `preflight` op token this module's arg shape expects and
  // delegates to `runStorePreflight`. These specs pin that equivalence at both
  // ends — the shim itself, and the router case actually reaching it — so the
  // retained direct-module alias can never drift from the subcommand.

  describe('runStorePreflightSubcommand — the router-facing spelling', () => {
    it('is byte-identical to `preflight`-prefixed args on the happy path (exit 0, same report)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const shimCode = await runStorePreflightSubcommand(
        ['--config', path],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );
      const shimOut = stdout;

      stdout = '';
      const standaloneCode = await runStorePreflight(
        ['preflight', '--config', path],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(shimCode).toBe(0);
      expect(shimCode).toBe(standaloneCode);
      expect(shimOut).toBe(stdout);
    });

    it('carries the loud exit 1 through unchanged when a configured state is missing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
      const api = new InMemoryLinearApi();
      api.setStateCatalog(FRESH_TEAM_MISSING_IN_REVIEW);

      const code = await runStorePreflightSubcommand(
        ['--config', path],
        new LinearIssuesStore({ api }),
      );

      expect(code).toBe(1);
      expect(JSON.parse(stdout).ok).toBe(false);
      expect(stdout).toContain('In Review');
    });

    it('carries the usage exit 2 through unchanged when the config is unreadable', async () => {
      const code = await runStorePreflightSubcommand([
        '--config',
        '/nonexistent/does-not-exist.json',
      ]);
      expect(code).toBe(2);
      expect(stderr).toMatch(/error:/);
    });

    it('takes no op token of its own — a bare arg list is a legal default-config probe, not an unknown-op error', async () => {
      // The tell of the standalone arg shape leaking through would be
      // `runStorePreflight`'s unknown-op message. It must never appear: the
      // subcommand NAME is the op.
      await runStorePreflightSubcommand(['--config', '/nonexistent/does-not-exist.json']);
      expect(stderr).not.toMatch(/only "preflight"/);
    });
  });

  describe('router wiring — `{{wave-cli}} store-preflight` reaches this module', () => {
    it('mainAsync(["store-preflight", ...]) runs the probe and returns its exit code', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const code = await mainAsync(
        ['store-preflight', '--config', path],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.storeKind).toBe('linear');
      expect(stderr).not.toMatch(/unknown subcommand/);
    });

    it('the sync main() refuses the async verb with an exit 2 hint rather than silently skipping the probe', () => {
      const code = main(['store-preflight', '--config', '/x.json']);
      expect(code).toBe(2);
      expect(stderr).toMatch(/async/i);
      expect(stdout).toBe('');
    });
  });

  // ── the lockstep advisory on the preflight (ADR-0032) ─────────────────────

  describe('store-preflight --expect — the lockstep comparison as an ADVISORY', () => {
    it('reports the engine-version check and still exits 0 when the versions MISMATCH', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--expect', '9.9.9-not-this-engine'],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      // The whole point of the AC: setup/plan time NOTICES the skew, it does
      // not refuse. A non-zero here would block wave-plan on a fact that only
      // bites at dispatch.
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(true);
      const check = report.checks.find((c: { name: string }) => c.name === 'engine-version');
      expect(check.status).toBe('advisory');
      expect(check.status).not.toBe('fail');
      expect(check.detail).toContain('9.9.9-not-this-engine');
      expect(check.detail).toContain('npm i -D'); // the one-line repair rides along
    });

    it('reports the engine-version check as pass when the expectation matches the real engine', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
      // Derived from the engine's own manifest, never transcribed — a hardcoded
      // literal here would go stale at the next release and start asserting
      // "mismatch" for a perfectly healthy install.
      const real = readEngineVersion().version as string;

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--expect', real],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(0);
      const check = JSON.parse(stdout).checks.find(
        (c: { name: string }) => c.name === 'engine-version',
      );
      expect(check.status).toBe('pass');
    });

    it('a tracker FAIL still exits 1 while the lockstep advisory rides alongside — the advisory neither masks nor causes it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
      const api = new InMemoryLinearApi();
      api.setStateCatalog(FRESH_TEAM_MISSING_IN_REVIEW);

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--expect', '9.9.9-not-this-engine'],
        new LinearIssuesStore({ api }),
      );

      expect(code).toBe(1); // from state-catalog, not from the version skew
      const report = JSON.parse(stdout);
      expect(report.checks.find((c: { name: string }) => c.name === 'state-catalog').status).toBe('fail');
      expect(report.checks.find((c: { name: string }) => c.name === 'engine-version').status).toBe('advisory');
    });

    it('omits the engine-version check entirely when no expectation is supplied', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const code = await runStorePreflight(
        ['preflight', '--config', path],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(0);
      const names = JSON.parse(stdout).checks.map((c: { name: string }) => c.name);
      expect(names).not.toContain('engine-version');
    });

    it('a value-less --expect is a USAGE error (exit 2), never a silently skipped check', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      // `--expect` last: the shape `flag()` cannot tell from "absent".
      const code = await runStorePreflight(
        ['preflight', '--config', path, '--expect'],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(2);
      expect(stderr).toMatch(/--expect requires a <plugin-version> value/);
      expect(stdout).toBe(''); // no report at all — the probe never ran
    });

    it('an --expect swallowed by the NEXT flag is refused too (not read as the flag name)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const code = await runStorePreflight(
        ['preflight', '--expect', '--config', path],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(2);
      expect(stdout).toBe('');
    });

    it('the router spelling carries --expect through unchanged', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-pf-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });

      const code = await mainAsync(
        ['store-preflight', '--config', path, '--expect', '9.9.9-not-this-engine'],
        new LinearIssuesStore({ api: new InMemoryLinearApi() }),
      );

      expect(code).toBe(0);
      const check = JSON.parse(stdout).checks.find(
        (c: { name: string }) => c.name === 'engine-version',
      );
      expect(check.status).toBe('advisory');
    });
  });
});

// ─── the plugin/engine lockstep version check (ADR-0032) ─────────────────────
//
// The engine half of the lockstep gate: it knows its OWN version and can
// compare it against an expectation handed to it. The expectation is the
// PLUGIN's version, read by the Coordinator from the plugin manifest at the
// skill's own resolution anchor — the engine never goes looking for it, because
// it has no way to know which clone the running skills came from.
//
// The assertions below are grouped around one property: the comparison must not
// be able to pass VACUOUSLY. Both sides absent, one side absent, one side blank
// — each has its own outcome and each is a non-match, never a quiet `true`.

describe('readEngineVersion — the engine package reads its OWN manifest', () => {
  it('resolves the manifest from the module location, not from cwd', () => {
    // cwd during a vitest run is tools/wave, so a cwd-based resolution would
    // accidentally agree here. The assertion is on the PATH shape: it must end
    // at the engine package root's manifest, one level above src/.
    expect(engineManifestPath().replace(/\\/g, '/')).toMatch(/\/tools\/wave\/package\.json$/);
  });

  it('reads the real name + version out of that manifest', () => {
    const manifest = JSON.parse(readFileSync(engineManifestPath(), 'utf8')) as {
      name: string;
      version: string;
    };
    const reading = readEngineVersion();

    expect(reading.version).toBe(manifest.version);
    expect(reading.packageName).toBe(manifest.name);
    expect(reading.unreadable).toBeNull();
  });

  it('an ABSENT manifest is a reported null version with a reason, never a throw', () => {
    const reading = readEngineVersion('/nonexistent/definitely-not-here/package.json');
    expect(reading.version).toBeNull();
    expect(reading.unreadable).toContain('/nonexistent/definitely-not-here/package.json');
  });

  it('a manifest that PARSES but carries no version is unreadable, not "version: undefined"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-manifest-'));
    const path = join(dir, 'package.json');
    writeFileSync(path, JSON.stringify({ name: '@formtrieb/flotilla-engine' }), 'utf8');

    const reading = readEngineVersion(path);

    expect(reading.version).toBeNull();
    expect(reading.packageName).toBe('@formtrieb/flotilla-engine');
    expect(reading.unreadable).toContain('no non-empty "version" string');
  });

  it('a whitespace-only version is treated as absent (it cannot be compared to anything)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-manifest-'));
    const path = join(dir, 'package.json');
    writeFileSync(path, JSON.stringify({ name: 'x', version: '   ' }), 'utf8');

    expect(readEngineVersion(path).version).toBeNull();
  });
});

describe('compareEngineVersion — match, mismatch, and the no-expectation path', () => {
  const reading = (version: string | null, unreadable: string | null = null) => ({
    version,
    packageName: '@formtrieb/flotilla-engine',
    manifestPath: '/fake/package.json',
    unreadable,
  });

  it('MATCH: equal versions report match:true with nothing to repair', () => {
    const report = compareEngineVersion('0.1.0-beta.1', reading('0.1.0-beta.1'));
    expect(report.outcome).toBe('match');
    expect(report.match).toBe(true);
    expect(report.repair).toBeNull();
    expect(engineVersionExitCode(report)).toBe(0);
  });

  it('MATCH: an expectation with surrounding whitespace still matches (the caller captured a trailing newline)', () => {
    expect(compareEngineVersion('  0.1.0-beta.1\n', reading('0.1.0-beta.1')).match).toBe(true);
  });

  it('NEGATIVE CONTROL (Convention 11) — MISMATCH really fires: differing versions report match:false and the exact repair', () => {
    // The control that distinguishes "the check works" from "the check cannot
    // fail": the ONLY thing changed against the passing case above is the
    // engine-side version, and the report flips.
    const report = compareEngineVersion('0.1.0-beta.2', reading('0.1.0-beta.1'));

    expect(report.outcome).toBe('mismatch');
    expect(report.match).toBe(false);
    expect(report.version).toBe('0.1.0-beta.1');
    expect(report.expected).toBe('0.1.0-beta.2');
    expect(report.repair).toBe('npm i -D @formtrieb/flotilla-engine@0.1.0-beta.2');
    expect(report.detail).toContain('not in lockstep');
    expect(engineVersionExitCode(report)).toBe(1);
  });

  it('MISMATCH is exact, pre-1.0: a differing PRERELEASE suffix is a mismatch, not a near-enough match', () => {
    expect(compareEngineVersion('0.1.0', reading('0.1.0-beta.1')).match).toBe(false);
  });

  it('NO EXPECTATION: match is null (nothing was compared), never true', () => {
    const report = compareEngineVersion(undefined, reading('0.1.0-beta.1'));
    expect(report.outcome).toBe('no-expectation');
    expect(report.match).toBeNull();
    expect(report.version).toBe('0.1.0-beta.1');
    expect(report.expected).toBeNull();
    expect(engineVersionExitCode(report)).toBe(0);
  });

  it('VACUITY GUARD: an unreadable ENGINE version with an expectation is a non-match, not a pass', () => {
    const report = compareEngineVersion(
      '0.1.0-beta.1',
      reading(null, 'could not read /fake/package.json: ENOENT'),
    );
    expect(report.outcome).toBe('engine-version-unreadable');
    expect(report.match).toBe(false);
    expect(report.match).not.toBe(true);
    expect(report.detail).toContain('ENOENT');
    expect(report.repair).toBe('npm i -D @formtrieb/flotilla-engine@0.1.0-beta.1');
    expect(engineVersionExitCode(report)).toBe(1);
  });

  it('VACUITY GUARD: an EMPTY expectation is a non-match, not "no expectation"', () => {
    const report = compareEngineVersion('   ', reading('0.1.0-beta.1'));
    expect(report.outcome).toBe('expectation-unusable');
    expect(report.match).toBe(false);
    expect(report.outcome).not.toBe('no-expectation');
    expect(engineVersionExitCode(report)).toBe(1);
  });

  it('VACUITY GUARD: BOTH sides absent is still not a match', () => {
    const report = compareEngineVersion('', reading(null, 'gone'));
    expect(report.match).toBe(false);
    expect(engineVersionExitCode(report)).toBe(1);
  });

  it('an unreadable manifest with NO expectation reports the failure rather than a version of null read as fine', () => {
    const report = compareEngineVersion(undefined, reading(null, 'gone'));
    expect(report.outcome).toBe('engine-version-unreadable');
    expect(report.version).toBeNull();
    expect(engineVersionExitCode(report)).toBe(1);
  });

  it('falls back to the published package name in the repair when the manifest could not name itself', () => {
    const report = compareEngineVersion('0.2.0', {
      version: null,
      packageName: null,
      manifestPath: '/fake/package.json',
      unreadable: 'gone',
    });
    expect(report.repair).toContain('@formtrieb/flotilla-engine@0.2.0');
  });
});

describe('engineVersionPreflightCheck — advisory by construction', () => {
  const reading = (version: string) => ({
    version,
    packageName: '@formtrieb/flotilla-engine',
    manifestPath: '/fake/package.json',
    unreadable: null,
  });

  it.each([
    ['match', '0.1.0-beta.1', 'pass'],
    ['mismatch', '0.1.0-beta.2', 'advisory'],
  ] as const)('a %s maps to status %s', (_label, expected, status) => {
    const check = engineVersionPreflightCheck(
      compareEngineVersion(expected, reading('0.1.0-beta.1')),
    );
    expect(check.name).toBe('engine-version');
    expect(check.status).toBe(status);
  });

  it('NEVER emits fail — the status that would flip StorePreflightReport.ok', () => {
    for (const expected of ['0.1.0-beta.1', '0.1.0-beta.2', '   ']) {
      const check = engineVersionPreflightCheck(
        compareEngineVersion(expected, reading('0.1.0-beta.1')),
      );
      expect(check.status).not.toBe('fail');
    }
    const unreadable = engineVersionPreflightCheck(
      compareEngineVersion('0.1.0-beta.1', {
        version: null,
        packageName: null,
        manifestPath: '/fake/package.json',
        unreadable: 'gone',
      }),
    );
    expect(unreadable.status).not.toBe('fail');
  });
});

describe('preflightStore — the lockstep check rides the injected reading', () => {
  it('appends an ADVISORY engine-version check without moving ok', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store, {
      expectedEngineVersion: '0.1.0-beta.2',
      engineVersionReading: {
        version: '0.1.0-beta.1',
        packageName: '@formtrieb/flotilla-engine',
        manifestPath: '/fake/package.json',
        unreadable: null,
      },
    });

    expect(report.ok).toBe(true);
    const check = report.checks.find((c) => c.name === 'engine-version');
    expect(check?.status).toBe('advisory');
  });

  it('markdown (the source-form dogfood store) reports the same advisory — the check is store-blind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-md-'));
    const store = new MarkdownFsStore({ repoRoot: dir, slug: '2026-07-30-x' });
    const report = await preflightStore(
      { store: { kind: 'markdown', repoRoot: dir, slug: '2026-07-30-x' } },
      store,
      {
        expectedEngineVersion: '0.1.0-beta.2',
        engineVersionReading: {
          version: '0.1.0-beta.1',
          packageName: '@formtrieb/flotilla-engine',
          manifestPath: '/fake/package.json',
          unreadable: null,
        },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'engine-version')?.status).toBe('advisory');
  });
});
