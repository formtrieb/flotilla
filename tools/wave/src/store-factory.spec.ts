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
import {
  LinearIssuesStore,
  DEFAULT_LINEAR_STATES,
} from './adapters/linear/linear-issues-store';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
import type { CreateInput } from './adapters/issue-store';
import type { LinearStateMapConfig, WaveConfig } from './wave-config';

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

// ── store.states reaches the adapter WHOLE, the two non-rung keys included ──
//
// `unclaimTarget` and `unplanned` are honoured because this factory passes
// `store.states` through un-picked and the adapter merges it over
// `DEFAULT_LINEAR_STATES`. That was true before they were typed too — which is
// exactly the reason to pin it here rather than in the adapter's own spec: the
// question this block answers is whether a value that came out of a CONFIG FILE
// still steers the write, end to end, through the same seam a consumer uses.
describe('buildStore — linear store.states: the configured unclaim/unplanned targets steer the real writes (issue #755)', () => {
  /** The standard workflow plus the two NON-default columns these specs configure. */
  const CATALOG_WITH_CUSTOM_TARGETS = [
    { name: 'Triage', type: 'triage' as const },
    { name: 'Backlog', type: 'backlog' as const },
    { name: 'Icebox', type: 'backlog' as const },
    { name: 'Todo', type: 'unstarted' as const },
    { name: 'In Progress', type: 'started' as const },
    { name: 'In Review', type: 'started' as const },
    { name: 'Done', type: 'completed' as const },
    { name: 'Canceled', type: 'canceled' as const },
    { name: 'Discarded', type: 'canceled' as const },
  ];

  function baseInput(): CreateInput {
    return {
      title: 'A factory-built row',
      filingHint: 'a-factory-built-row',
      risk: 'mechanical',
      worker: 'background',
      files: ['src/x.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'does the thing', checked: false }],
    };
  }

  /** A store built the way a consumer gets one: from a loaded config, through the factory. */
  function storeFromStates(states: LinearStateMapConfig): {
    api: InMemoryLinearApi;
    store: LinearIssuesStore;
  } {
    const api = new InMemoryLinearApi();
    api.setStateCatalog(CATALOG_WITH_CUSTOM_TARGETS);
    const config: WaveConfig = { store: { kind: 'linear', team: 'EX', states } };
    return { api, store: buildStore(config, { linearApi: api }) as LinearIssuesStore };
  }

  it('a configured states.unclaimTarget is where a RELEASED claim lands', async () => {
    const { api, store } = storeFromStates({ unclaimTarget: 'Icebox' });
    const id = await store.create(baseInput());
    await store.transition(id, 'queued'); // the claim has to exist before it can be released
    expect((await api.getIssue(id)).stateName).toBe('Todo');

    await store.unclaim(id);
    expect((await api.getIssue(id)).stateName).toBe('Icebox');
  });

  it('NEGATIVE CONTROL: the same release with NO states declared lands on the default Backlog', async () => {
    // Without this, the assertion above is equally satisfied by a store that
    // ignores the config and happens to be pointed at a state called 'Icebox'.
    const { api, store } = storeFromStates({});
    const id = await store.create(baseInput());
    await store.transition(id, 'queued');
    await store.unclaim(id);
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unclaimTarget);
    expect((await api.getIssue(id)).stateName).toBe('Backlog');
  });

  it('a configured states.unplanned is where an UNPLANNED close lands', async () => {
    const { api, store } = storeFromStates({ unplanned: 'Discarded' });
    const id = await store.create(baseInput());

    await store.closeUnplanned(id, 'not in scope for this repo');
    expect((await api.getIssue(id)).stateName).toBe('Discarded');
    // …and the close is a real close: the category the state carries is what
    // makes `read()` report done, so a custom name must keep that property.
    expect((await store.read(id)).status).toBe('done');
  });

  it('NEGATIVE CONTROL: the same close with NO states declared lands on the default Canceled', async () => {
    const { api, store } = storeFromStates({});
    const id = await store.create(baseInput());
    await store.closeUnplanned(id, 'not in scope for this repo');
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unplanned);
    expect((await api.getIssue(id)).stateName).toBe('Canceled');
  });

  it('both keys are honoured from ONE config, and the three claim rungs are untouched by them', async () => {
    const { api, store } = storeFromStates({ unclaimTarget: 'Icebox', unplanned: 'Discarded' });
    const released = await store.create(baseInput());
    await store.transition(released, 'in-flight');
    expect((await api.getIssue(released)).stateName).toBe(DEFAULT_LINEAR_STATES.inFlight);
    await store.unclaim(released);
    expect((await api.getIssue(released)).stateName).toBe('Icebox');

    const discarded = await store.create(baseInput());
    await store.closeUnplanned(discarded, 'duplicate');
    expect((await api.getIssue(discarded)).stateName).toBe('Discarded');
  });
});
