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
// The REAL GitHub client, plus its http fixture — imported here rather than
// exercised in `real-github-api.spec.ts` because issue #675's declared Files
// globs do not include that file. The `createLabel` cases at the bottom of this
// file say so at their own site; the natural home is the real client's own spec
// and they should move there the next time it is in scope.
import { RealGitHubApi, GitHubApiError } from './adapters/github/real-github-api';
import { FakeGitHubHttp } from './adapters/github/github-http-fake';
import type { GitHubHttpRequest, GitHubHttpResponse } from './adapters/github/github-http';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
import type { IssueStore } from './adapters/issue-store';
// TYPE-ONLY, through the PACKAGE ROOT. Erased at compile time, so it loads no
// module and cannot disturb the `vi.mock` + `await import` ordering the rest of
// this file depends on — while still proving the named `store.goal` shape
// (ADR-0044 decision 4) is reachable from the root by name, which is a claim no
// runtime assertion can make about a type.
import type {
  StoreGoalConfig as StoreGoalConfigFromRoot,
  WaveConfig as WaveConfigFromRoot,
} from './index';

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
  // ADR-0044 — the Goal-container binding's config edge.
  readGoalContainer,
  resolveGoalContainer,
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

  // ─── config-miss teaches the fix (issue #505) ──────────────────────────────
  //
  // The motivating misfire: `issue-store triage-apply` run without `--config`
  // in a repo lacking a `wave.config.json` used to surface a bare fs ENOENT —
  // Node's message, not an operator's. `resolveStore` is the ONE place every
  // store-backed CLI verb goes through, so fixing it here fixes it everywhere
  // (`issue-store <op>`, `dor --id`, `conflict-map --id`) without touching
  // each call site.

  it('a missing DEFAULT wave.config.json (no --config passed) teaches "pass --config <path>", never a bare ENOENT', async () => {
    // No --config in argv → resolveStore falls back to the literal
    // 'wave.config.json', resolved against cwd (tools/wave during this test
    // run) — which genuinely has none, so this exercises the real fs path.
    await expect(resolveStore([])).rejects.toThrow(
      'no wave.config.json in cwd — pass --config <path>',
    );
    await expect(resolveStore([])).rejects.not.toThrow(/ENOENT/);
  });

  it('a missing EXPLICIT --config path names the path, not "pass --config" (the caller already did)', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'cli-store-miss-')), 'wave.config.json');

    await expect(resolveStore(['--config', missing])).rejects.toThrow('--config');
    await expect(resolveStore(['--config', missing])).rejects.not.toThrow(/ENOENT/);
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

  // ── issue #493 — tracker-host-integration stops asserting a code-host
  // conclusion it cannot know, and honours the documented FOR-13 n/a condition ──
  //
  // reference/setup-mechanics.md's per-store check table: "n/a when
  // `states.doneState` is set — the FOR-13 fallback". The pre-fix engine probed
  // `hasGitHubIntegration()` UNCONDITIONALLY and only consulted `doneState` when
  // the integration was ABSENT — so a workspace with the integration installed
  // (e.g. from other repos sharing it) and `doneState` configured reported
  // `pass`, never `not-applicable`, and never even looked at `doneState` first.

  it('AC1 — states.doneState configured (integration ALSO installed) → not-applicable, not probed, ok unaffected', async () => {
    const api = new InMemoryLinearApi(); // default: hasGitHubIntegration() → true
    const integrationSpy = vi.spyOn(api, 'hasGitHubIntegration');
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore(
      { store: { kind: 'linear', team: 'EX', states: { doneState: 'Done' } } },
      store,
    );

    const check = report.checks.find((c) => c.name === 'tracker-host-integration');
    expect(check?.status).toBe('not-applicable');
    expect(report.ok).toBe(true); // ok is unaffected either way (not-applicable never blocks)
    // "instead of probing" (AC1) — the integration API must not be called at all
    // once doneState decides the check is n/a.
    expect(integrationSpy).not.toHaveBeenCalled();
  });

  it('AC2 — without doneState, a `pass` states what was probed and CONDITIONS the done-derivation claim on a GitHub code host', async () => {
    const api = new InMemoryLinearApi(); // hasGitHubIntegration() → true, no doneState configured
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore({ store: { kind: 'linear', team: 'EX' } }, store);

    const check = report.checks.find((c) => c.name === 'tracker-host-integration');
    expect(check?.status).toBe('pass');
    // States what was actually probed — the Linear WORKSPACE's integration —
    // rather than a conclusion about this repo.
    expect(check?.detail).toContain('Linear↔GitHub integration is installed');
    // Conditions the done-derivation claim on a GitHub code host instead of
    // promising the closing attachment unconditionally.
    expect(check?.detail).toContain('GitHub code host');
    expect(check?.detail).toContain('any other code host');
    // Must NOT assert the closing attachment as an unqualified fact about THIS
    // repo — the old wording asserted it as if the code host were already known.
    expect(check?.detail).not.toMatch(/^Linear↔GitHub integration is installed — a merged PR creates/);
  });

  it('field-report false-reassurance case — linear store, Bitbucket code host, FOR-13 doneState configured (the reported consumer shape exactly)', async () => {
    // Reproduces the field report's evidence verbatim: `linear` store, team
    // `DEV`-shaped config, `states.doneState: "Done"` (the FOR-13 fallback) —
    // and the Linear↔GitHub integration IS installed (workspace-wide, from
    // other repos sharing the workspace), while THIS repo's code host is
    // Bitbucket, confirmed separately by `host-pr preflight` (out of this
    // check's seam entirely — LinearApi reaches the tracker only). The pre-fix
    // engine reported `pass` with "a merged PR creates the closing attachment
    // the done-derivation reads" — false for this consumer, since the
    // integration can never see a Bitbucket PR. The fix reports
    // `not-applicable` instead: doneState is configured, so done resolves via
    // the forced flip and the integration/closing-attachment question is moot.
    const api = new InMemoryLinearApi();
    api.setGitHubIntegration(true);
    const store = new LinearIssuesStore({ api });
    const report = await preflightStore(
      { store: { kind: 'linear', team: 'EX', states: { doneState: 'Done' } } },
      store,
    );

    const check = report.checks.find((c) => c.name === 'tracker-host-integration');
    expect(check?.status).toBe('not-applicable');
    expect(check?.detail).not.toContain('closing attachment');
    expect(report.ok).toBe(true);
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

  // ── store-preflight --create-missing-labels (issue #675) ──────────────────
  //
  // The `state-catalog` check already named every missing label and the
  // credential that ran it may create them, so a fresh consumer's first ten
  // minutes went to a hand-typed `gh label create` loop the docs did not
  // mention. The flag closes that: the probe's ONE write, opt-in, idempotent,
  // and reported in the same detail the check that found the gap prints.
  //
  // The property the whole group is built around: the read-only default must
  // stay the default. The first spec below is therefore an EQUALITY against the
  // anchor's own wording, not a `toContain` — a repair that leaked into the
  // no-flag path would pass a looser assertion.

  describe('--create-missing-labels — the label repair', () => {
    /** The thirteen a fresh repo with the default eligibility set needs. */
    const REQUIRED_LABELS = [
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
    ];

    /** The healthy `state-catalog` detail, verbatim from the anchor. */
    const CATALOG_PASS_DETAIL =
      'GitHub claims are labels (eligibility, risk/*, worker/*, wave/* rungs) — every one the wave will read or write exists in the repository.';

    function githubConfigDir(): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-labels-'));
      return writeConfig(dir, { store: { kind: 'github' } });
    }

    function catalogCheck(): { status: string; detail: string } {
      return JSON.parse(stdout).checks.find(
        (c: { name: string }) => c.name === 'state-catalog',
      );
    }

    it('WITHOUT the flag nothing is written and the report is byte-identical to the anchor', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi();
      api.setRepoLabels(
        REQUIRED_LABELS.filter((l) => l !== 'wave/in-review' && l !== 'wave/needs-attention'),
      );

      const code = await runStorePreflight(
        ['preflight', '--config', path],
        new GitHubIssuesStore({ api }),
      );

      expect(code).toBe(1);
      // EQUALITY, not containment — the anchor's exact wording, so a repair that
      // leaked into the read-only path is caught by the assertion rather than
      // tolerated by it.
      expect(catalogCheck()).toEqual({
        name: 'state-catalog',
        status: 'fail',
        detail:
          'GitHub claims are labels — which is exactly why they need verifying: the following are missing from the repository and must be created before running a wave: "wave/in-review", "wave/needs-attention".',
      });
      expect(api.labelWrites()).toEqual([]); // the probe wrote nothing at all
      expect(await api.listLabels()).not.toContain('wave/in-review');
    });

    it('creates exactly the MISSING labels, re-probes to pass, and names each one it created', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi();
      api.setRepoLabels(
        REQUIRED_LABELS.filter((l) => l !== 'wave/in-review' && l !== 'wave/needs-attention'),
      );

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );

      expect(code).toBe(0);
      const catalog = catalogCheck();
      expect(catalog.status).toBe('pass'); // the RE-probe, not the first look
      expect(catalog.detail).toBe(
        `${CATALOG_PASS_DETAIL} --create-missing-labels created 2 missing label(s) through the engine's own credential: "wave/in-review", "wave/needs-attention".`,
      );
      // Exactly the two missing ones were written — the eleven present ones were
      // not re-written.
      expect(api.labelWrites().map((w) => w.name)).toEqual([
        'wave/in-review',
        'wave/needs-attention',
      ]);
      expect((await api.listLabels()).sort()).toEqual([...REQUIRED_LABELS].sort());
    });

    it('an unconfigured repo gets all thirteen, each with a 6-hex colour and a one-sentence description of at most 100 characters', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi(); // default: zero labels created

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );

      expect(code).toBe(0);
      expect(catalogCheck().status).toBe('pass');
      const writes = api.labelWrites();
      expect(writes.map((w) => w.name).sort()).toEqual([...REQUIRED_LABELS].sort());
      for (const write of writes) {
        // GitHub's own constraints on the create endpoint: hex WITHOUT a leading
        // `#`, description 100 characters or fewer.
        expect(write.color).toMatch(/^[0-9a-f]{6}$/);
        expect(write.description).toBeDefined();
        expect((write.description as string).length).toBeGreaterThan(0);
        expect((write.description as string).length).toBeLessThanOrEqual(100);
        // One sentence: no sentence break inside it, and no newline.
        expect(write.description as string).not.toMatch(/[.!?]\s/);
        expect(write.description as string).not.toContain('\n');
      }
    });

    it('a CONFIGURED eligibility label is created under its own name with the eligibility row of the table', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-labels-'));
      const path = writeConfig(dir, {
        store: { kind: 'github', eligibility: ['agent-ok'] },
      });
      const api = new InMemoryGitHubApi();

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api, eligibility: ['agent-ok'] }),
      );

      expect(code).toBe(0);
      const names = api.labelWrites().map((w) => w.name);
      expect(names).toContain('agent-ok');
      expect(names).not.toContain('ready-for-agent'); // the default is NOT required here
      expect(api.labelWrites().find((w) => w.name === 'agent-ok')).toEqual({
        name: 'agent-ok',
        color: '0e8a16',
        description: 'Wave-eligible: an AFK agent may grab this issue',
      });
    });

    it('a SECOND run creates nothing and says so — idempotent, not merely harmless', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi();

      const first = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );
      expect(first).toBe(0);
      const afterFirst = api.labelWrites().length;
      expect(afterFirst).toBe(REQUIRED_LABELS.length);

      stdout = '';
      const second = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );

      expect(second).toBe(0);
      const catalog = catalogCheck();
      expect(catalog.status).toBe('pass');
      expect(catalog.detail).toBe(
        `${CATALOG_PASS_DETAIL} --create-missing-labels created nothing: every label the wave will read or write already existed.`,
      );
      expect(api.labelWrites().length).toBe(afterFirst); // not one extra write
    });

    it('a label that appears BETWEEN the probe and the create is read as present, never as a failure', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi();
      // The race: this probe will report `wave/queued` missing, and by the time
      // the create runs another actor has created it (GitHub's 422
      // `already_exists`).
      api.setLabelsCreatedConcurrently(['wave/queued']);

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );

      expect(code).toBe(0); // not a failure
      const catalog = catalogCheck();
      expect(catalog.status).toBe('pass');
      expect(catalog.detail).toContain('created 12 missing label(s)');
      expect(catalog.detail).not.toMatch(/created 12 missing label\(s\)[^.]*"wave\/queued"/);
      expect(catalog.detail).toContain(
        'Created by someone else between the probe and the create, and read as present rather than as a failure: "wave/queued".',
      );
      expect(await api.listLabels()).toContain('wave/queued');
    });

    it('on a LINEAR store the flag is refused with exit 2 before anything is built or written', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-labels-'));
      const path = writeConfig(dir, { store: { kind: 'linear', team: 'EX' } });
      const api = new InMemoryLinearApi();

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new LinearIssuesStore({ api }),
      );

      expect(code).toBe(2);
      expect(stderr).toContain('--create-missing-labels applies to a "github" store only');
      expect(stderr).toContain('this config is "linear"');
      expect(stderr).toContain('configured in the workspace');
      expect(stderr).toContain('Nothing was written.');
      expect(stdout).toBe(''); // no report at all — the probe never even ran
    });

    it('on a MARKDOWN store the refusal names why that store has nothing to create', async () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'cli-store-labels-repo-'));
      mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
      const dir = mkdtempSync(join(tmpdir(), 'cli-store-labels-'));
      const path = writeConfig(dir, {
        store: { kind: 'markdown', repoRoot, slug: '2026-09-03-x' },
      });

      const code = await runStorePreflight(
        ['preflight', '--config', path, '--create-missing-labels'],
        new MarkdownFsStore({ repoRoot, slug: '2026-09-03-x' }),
      );

      expect(code).toBe(2);
      expect(stderr).toContain('this config is "markdown"');
      expect(stderr).toContain('no label registry');
      expect(stdout).toBe('');
    });

    it('the usage text lists the flag', async () => {
      await runStorePreflight(['bogus']); // any usage error prints the block
      expect(stderr).toContain('[--create-missing-labels]');
      expect(stderr).toContain('creates every label the state-catalog check reports');
    });

    it('the router spelling carries the flag through unchanged', async () => {
      const path = githubConfigDir();
      const api = new InMemoryGitHubApi();

      const code = await mainAsync(
        ['store-preflight', '--config', path, '--create-missing-labels'],
        new GitHubIssuesStore({ api }),
      );

      expect(code).toBe(0);
      expect(catalogCheck().status).toBe('pass');
      expect(catalogCheck().detail).toContain('created 13 missing label(s)');
    });
  });
});

// ─── RealGitHubApi.createLabel — the seam's one repository-level write ────────
//
// PLACEMENT, stated rather than left to be wondered at: the real client's own
// spec (`real-github-api.spec.ts`) is where these belong and is NOT in issue
// #675's declared Files globs, so they ride here with the flag that needs them.
// They exercise the same three answers the fake models — created,
// already-exists, rejected — against the documented HTTP shapes, which is the
// half no in-memory fake can check.

describe('RealGitHubApi.createLabel', () => {
  function makeApi(handler: (req: GitHubHttpRequest) => GitHubHttpResponse): {
    api: RealGitHubApi;
    http: FakeGitHubHttp;
  } {
    const http = new FakeGitHubHttp(handler);
    return { api: new RealGitHubApi('o', 'r', 't', http), http };
  }

  it('POSTs to the repository label registry and reads 201 as created', async () => {
    const { api, http } = makeApi(() => ({ status: 201, json: { name: 'wave/queued' } }));

    const answer = await api.createLabel({
      name: 'wave/queued',
      color: 'd4c5f9',
      description: 'Claim: soft-claimed by a wave, not yet dispatched',
    });

    expect(answer).toEqual({ created: true });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].method).toBe('POST');
    expect(http.requests[0].url).toBe('https://api.github.com/repos/o/r/labels');
    expect(JSON.parse(http.requests[0].body as string)).toEqual({
      name: 'wave/queued',
      color: 'd4c5f9',
      description: 'Claim: soft-claimed by a wave, not yet dispatched',
    });
  });

  it('omits `description` from the payload when the caller has none, rather than sending null', async () => {
    const { api, http } = makeApi(() => ({ status: 201, json: {} }));

    await api.createLabel({ name: 'agent-ok', color: '0e8a16' });

    expect(JSON.parse(http.requests[0].body as string)).toEqual({
      name: 'agent-ok',
      color: '0e8a16',
    });
  });

  it('reads a 422 whose validation code is already_exists as PRESENT, not as a failure', async () => {
    const { api } = makeApi(() => ({
      status: 422,
      json: {
        message: 'Validation Failed',
        errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
      },
    }));

    await expect(api.createLabel({ name: 'wave/queued', color: 'd4c5f9' })).resolves.toEqual({
      created: false,
    });
  });

  it('tolerates a 422 that carries the fact only in the human message', async () => {
    const { api } = makeApi(() => ({
      status: 422,
      json: { message: 'label already exists' },
    }));

    await expect(api.createLabel({ name: 'wave/queued', color: 'd4c5f9' })).resolves.toEqual({
      created: false,
    });
  });

  it('throws on a 422 that is a DIFFERENT validation failure — only already-exists is tolerated', async () => {
    const { api } = makeApi(() => ({
      status: 422,
      json: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'color' }] },
    }));

    await expect(api.createLabel({ name: 'x', color: 'nothex' })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it('throws on any other rejected write', async () => {
    const { api } = makeApi(() => ({ status: 403, json: { message: 'Resource not accessible' } }));

    await expect(api.createLabel({ name: 'x', color: '0e8a16' })).rejects.toMatchObject({
      status: 403,
      op: 'createLabel',
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

// ── the Goal-container binding, read from wave.config.json (ADR-0044) ────────
//
// The binding is a SETUP-TIME config fact, and this module is the one place it
// is read — which is what keeps it off every store's construction state and
// leaves `buildStore`'s contract untouched by the facet existing.
describe('readGoalContainer — store.goal.container', () => {
  it('reads a declared role verbatim', () => {
    for (const role of ['milestone', 'project', 'initiative', 'goal-file'] as const) {
      expect(readGoalContainer({ store: { kind: 'github', goal: { container: role } } } as never)).toBe(
        role,
      );
    }
  });

  it('an ABSENT binding is absent, not a failure — each store answers it for itself', () => {
    // GitHub falls back to milestone, MarkdownFs to its goal file, Linear
    // refuses. Deciding that HERE would be exactly the silent container pick
    // ADR-0044 decision 4 forbids.
    expect(readGoalContainer({ store: { kind: 'github' } } as never)).toBeUndefined();
    expect(readGoalContainer({ store: { kind: 'linear', team: 'EX' } } as never)).toBeUndefined();
    expect(
      readGoalContainer({ store: { kind: 'github', goal: { container: undefined } } } as never),
    ).toBeUndefined();
    expect(readGoalContainer({ store: { kind: 'github', goal: null } } as never)).toBeUndefined();
  });

  it('a present-but-WRONG role fails loud, naming the key — configured means authoritative', () => {
    // A malformed declaration read as "unbound" would silently fall back to a
    // container the author did not ask for — on github, to milestone.
    let thrown: unknown;
    try {
      readGoalContainer({ store: { kind: 'github', goal: { container: 'epic' } } } as never);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { name?: string })?.name).toBe('GoalBindingError');
    expect((thrown as { failure?: string })?.failure).toBe('unknown-container');
    expect((thrown as { field?: string })?.field).toBe('store.goal.container');
  });

  it('a non-object `store.goal` is refused rather than ignored', () => {
    expect(() =>
      readGoalContainer({ store: { kind: 'github', goal: 'milestone' } } as never),
    ).toThrow(/store\.goal/);
    expect(() =>
      readGoalContainer({ store: { kind: 'github', goal: ['milestone'] } } as never),
    ).toThrow(/store\.goal/);
  });

  it('reads a WELL-TYPED config by name — no `as never` needed once the block has one', () => {
    // Every other case in this describe hands the reader an `as never` literal,
    // because the shapes they exercise are deliberately ill-typed (a string
    // `goal`, an unknown role, a null). This one is the opposite measurement:
    // with `store.goal` declared as the named, root-exported StoreGoalConfig,
    // a WELL-formed config now typechecks straight into the reader's parameter
    // with no cast at all — the consumer-facing half of the promotion, and the
    // half no runtime assertion can see. `tsc --noEmit` is the assertion.
    const goal: StoreGoalConfigFromRoot = { container: 'project' };
    const config: WaveConfigFromRoot = { store: { kind: 'linear', team: 'EX', goal } };
    expect(readGoalContainer(config)).toBe('project');

    // …and the ABSENT case, which is a complete value of the same type.
    const unbound: WaveConfigFromRoot = { store: { kind: 'linear', team: 'EX', goal: {} } };
    expect(readGoalContainer(unbound)).toBeUndefined();
  });

  it('still refuses an untrusted value the interface CLAIMS is well-typed', () => {
    // Naming the interface in the reader says what the KEY is called; it says
    // nothing about what the loaded JSON put under it. This is the config that
    // satisfies the declaration and violates it at the same time — the exact
    // reason the runtime narrow below `readGoalContainer`'s shape note survives
    // the typing unchanged.
    const lying = { store: { kind: 'github', goal: { container: 'epic' } } } as unknown as
      WaveConfigFromRoot;
    expect(() => readGoalContainer(lying)).toThrow(/store\.goal\.container|epic/);
  });

  it('reads the binding out of a config LOADED from disk — the key survives loadWaveConfig', () => {
    // The shape note in `readGoalContainer`'s own doc, measured: `store.goal` is
    // not yet declared on the `StoreConfig` interfaces, so this asserts the key
    // genuinely survives the JSON load rather than being dropped by it.
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-goal-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-goal-'));
    mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
    const path = writeConfig(dir, {
      store: {
        kind: 'markdown',
        repoRoot,
        slug: '2026-08-15-goal',
        goal: { container: 'goal-file' },
      },
    });
    expect(resolveGoalContainer(['--config', path])).toBe('goal-file');
  });
});

describe('resolveGoalContainer — the argv-facing spelling', () => {
  it('short-circuits on an injected store, exactly as resolveStore does', async () => {
    // With a store injected there is no config path to read at all, so the
    // binding is undefined and the injected store applies its OWN rule. Keeping
    // the two resolutions in lockstep is what prevents a config-derived binding
    // ever being pointed at a store built from somewhere else.
    const injected = new MarkdownFsStore({ repoRoot: '/tmp/x', slug: 's' });
    expect(resolveGoalContainer(['--config', '/nonexistent/wave.config.json'], injected)).toBeUndefined();
    // …and the same args WITHOUT the injected store really would have tried to
    // load that config — so the short-circuit above is doing the work.
    expect(() => resolveGoalContainer(['--config', '/nonexistent/wave.config.json'])).toThrow();
  });

  it('a config declaring no goal block resolves to undefined (not an error)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-store-goal2-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-goal2-'));
    mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
    const path = writeConfig(dir, {
      store: { kind: 'markdown', repoRoot, slug: '2026-08-15-nogoal' },
    });
    expect(resolveGoalContainer(['--config', path])).toBeUndefined();
  });
});
