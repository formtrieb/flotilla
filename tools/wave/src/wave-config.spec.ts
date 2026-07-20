/**
 * wave-config.spec.ts — TDD spec for the minimal store-selection config slice.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWaveConfig } from './wave-config';

function loadConfigFromString(json: string) {
  const p = join(mkdtempSync(join(tmpdir(), 'wc-')), 'wave.config.json');
  writeFileSync(p, json, 'utf8');
  return loadWaveConfig(p);
}

describe('loadWaveConfig', () => {
  it('reads a markdown-store config from a tmp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        store: {
          kind: 'markdown',
          repoRoot: '.',
          slug: '2026-06-06-x',
          eligibility: ['ready-for-agent'],
        },
      }),
    );
    const cfg = loadWaveConfig(cfgPath);
    expect(cfg).toEqual({
      store: {
        kind: 'markdown',
        repoRoot: '.',
        slug: '2026-06-06-x',
        eligibility: ['ready-for-agent'],
      },
    });
  });

  it('throws for an unknown store kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({ store: { kind: 'jira' } }));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/unknown store kind: jira/);
  });

  it('throws a clear error when the store key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({}));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/must have a "store" object/);
  });

  it('throws unknown store kind: undefined when store has no kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({ store: {} }));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/unknown store kind: undefined/);
  });

  it('loads a config with a valid verify profile', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'p', appliesTo: ['src/**'], commands: [{ command: 'echo hi' }] }] },
    }));
    expect(cfg.verify?.profiles[0].name).toBe('p');
  });

  it('loads a config with no verify (optional)', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'github' } }));
    expect(cfg.verify).toBeUndefined();
  });

  it('throws when verify is present but has no profiles array', () => {
    expect(() => loadConfigFromString(JSON.stringify({ store: { kind: 'github' }, verify: {} })))
      .toThrow(/verify.*profiles/i);
  });

  it('accepts a linear store config with team + project', () => {
    const p = loadConfigFromString(JSON.stringify({ store: { kind: 'linear', team: 'ex', project: 'Example Project' } }));
    expect(p.store.kind).toBe('linear');
  });

  it('rejects a linear store config without team', () => {
    expect(() => loadConfigFromString(JSON.stringify({ store: { kind: 'linear' } })))
      .toThrow(/team/);
  });

  // ── opt-in done-state mapping (FOR-13) ──────────────────────────────────
  it('accepts a linear store config WITH a states.doneState mapping (AC#1)', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: {
        kind: 'linear',
        team: 'ex',
        states: { queued: 'Todo', inFlight: 'In Progress', inReview: 'In Review', doneState: 'Done' },
      },
    }));
    expect(cfg.store.kind).toBe('linear');
    expect((cfg.store as { states?: { doneState?: string } }).states?.doneState).toBe('Done');
  });

  it('accepts a linear store config WITHOUT a states.doneState mapping — the default/recommended mode (AC#1)', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: { kind: 'linear', team: 'ex', states: { queued: 'Todo' } },
    }));
    expect((cfg.store as { states?: { doneState?: string } }).states?.doneState).toBeUndefined();
  });

  it('accepts a linear store config with no `states` key at all', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'linear', team: 'ex' } }));
    expect((cfg.store as { states?: unknown }).states).toBeUndefined();
  });
});
