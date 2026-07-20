/**
 * store-factory.spec.ts — TDD spec for the buildStore factory.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildStore } from './store-factory';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
import type { WaveConfig } from './wave-config';

describe('buildStore', () => {
  it('returns a MarkdownFsStore for a markdown config', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'sf-'));
    const config: WaveConfig = {
      store: { kind: 'markdown', repoRoot, slug: '2026-06-06-x' },
    };
    const store = buildStore(config);
    expect(store).toBeInstanceOf(MarkdownFsStore);
  });

  it('returns a GitHubIssuesStore for a github config with injected api', () => {
    const config: WaveConfig = { store: { kind: 'github' } };
    const api = new InMemoryGitHubApi();
    const store = buildStore(config, { githubApi: api });
    expect(store).toBeInstanceOf(GitHubIssuesStore);
  });

  it('throws a P8 deferral error for github config without an api', () => {
    const config: WaveConfig = { store: { kind: 'github' } };
    expect(() => buildStore(config)).toThrow(/real GitHubApi lands in P8/);
  });

  it('throws the deferral error for linear without an injected api', () => {
    const config: WaveConfig = { store: { kind: 'linear', team: 'des' } };
    expect(() => buildStore(config)).toThrow(/linearApi/);
  });

  it('returns a LinearIssuesStore for a linear config with injected api', () => {
    const config: WaveConfig = { store: { kind: 'linear', team: 'des' } };
    const api = new InMemoryLinearApi();
    const store = buildStore(config, { linearApi: api });
    expect(store).toBeInstanceOf(LinearIssuesStore);
  });
});
