/**
 * sandbox-scaffold-guard.spec.ts — the parity guard for the tracked sandbox
 * capability scaffold (issue #716, ADR-0049 decision 3, AC5).
 *
 * Same family as allowlist-scaffold-guard.spec.ts (issue #291) and
 * skill-schema-drift.spec.ts: a guard whose subject is config/doc
 * consistency, not engine behavior — proven live, in CI, on every `npm test`,
 * rather than left as a static prose claim (setup-mechanics.md's own "Sandbox
 * capability scaffold" section) that nothing falsifies.
 *
 * What it holds in parity, in BOTH directions, the way the allowlist guard
 * already holds `permissions.allow` against the declared verify commands:
 *
 *   Direction 1 — DECLARED → SCAFFOLDED. Every `writes`/`network` entry a
 *   verify command declares in `needs` (`wave.config.json` →
 *   `verify.profiles[].commands[].needs`, read through the REAL
 *   `loadWaveConfig()` loader — never a restated copy of `VerifyCommand`'s
 *   shape) must appear in the tracked `.claude/settings.json`'s
 *   `sandbox.filesystem.allowWrite` / `sandbox.network.allowedDomains`.
 *
 *   Direction 2 — SCAFFOLDED → DECLARED. Every entry actually present in the
 *   tracked sandbox block must trace back to a declared need — an entry
 *   nobody declared is an unexplained grant, the `sandbox` analogue of what
 *   the allowlist's own #269 reconciliation already catches for
 *   `permissions.allow`.
 *
 * Unlike the allowlist guard, there is no fixed generic-scaffold baseline to
 * classify against here: every `writes`/`network` entry is entirely
 * consumer-specific (derived from THAT consumer's own verify commands'
 * declared needs), so the check is a direct two-way mapping between two live
 * sources, not a three-way classification against a canonical/dogfood/legacy
 * split the way `permissions.allow` needs.
 *
 * `host` needs are excluded from this parity computation BY CONSTRUCTION —
 * see the "host is never representable" describe block below. That is not an
 * omission this spec works around; it is itself the thing ADR-0049 decision 3
 * requires ("host never appears in the tracked file") and the thing this spec
 * proves holds in code, not only in prose.
 *
 * This repo's own live files are the vacuous case: `.claude/settings.json`
 * carries no `sandbox` key at all (no dogfood verify command declares a
 * `writes`/`network` need yet), and `wave.config.json` is absent from this
 * worktree by construction (this repo's own dogfood config lives at the
 * gitignored `.flotilla/wave.config.json` — CONTEXT.md `### Distribution`,
 * and allowlist-scaffold-guard.spec.ts makes the identical observation about
 * its own direction-2 live-file half). Both sides of the live-file check are
 * therefore empty, and the spec asserts that explicitly rather than skipping
 * it — the real parity logic is exercised against fixtures built through the
 * same `loadWaveConfig()` loader, with permanent, in-spec positive and
 * negative controls (Convention 11): a planted declared-but-unscaffolded
 * entry and a planted scaffolded-but-undeclared entry are pushed through the
 * SAME `checkParity` function the real assertions use, so "the check works"
 * stays distinguishable from "the check cannot fail" on every run, not only
 * once, by hand, in a PR description.
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is
 * tools/wave/src — three levels above the repo root, matching every other
 * guard in this family.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWaveConfig } from './wave-config';
import type { VerifyCommand } from './verify';

const REPO_ROOT = resolve(__dirname, '../../..');
const SETTINGS_PATH = join(REPO_ROOT, '.claude/settings.json');
const SETUP_MECHANICS_PATH = join(
  REPO_ROOT,
  '.claude/skills/wave-setup/reference/setup-mechanics.md',
);

// ─── JSONC-tolerant parse (same parser constraint as allowlist-scaffold-guard.spec.ts) ──

/**
 * Strip `//` line comments and `/* … *​/` block comments from a JSON text,
 * respecting string literals. Duplicated here rather than imported —
 * allowlist-scaffold-guard.spec.ts's own copy is a private, unexported
 * helper, and this repo's tracked `.claude/settings.json` is read by Claude
 * Code with a JSONC-tolerant parser, so a bare `JSON.parse` on the live file
 * is not a safe assumption for THIS guard to make either.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

// ─── live settings: the tracked sandbox block ────────────────────────────────

interface LiveSettings {
  sandbox?: {
    filesystem?: { allowWrite?: string[] };
    network?: { allowedDomains?: string[] };
  };
}

/** `sandbox.filesystem.allowWrite`, or `[]` when the key/block is absent —
 * absence is the ordinary, expected state for a consumer with no `writes`
 * needs declared anywhere. */
function extractSandboxWrites(settings: LiveSettings): string[] {
  return settings.sandbox?.filesystem?.allowWrite ?? [];
}

/** `sandbox.network.allowedDomains`, or `[]` when the key/block is absent —
 * same absence-is-ordinary reasoning as {@link extractSandboxWrites}. */
function extractSandboxNetwork(settings: LiveSettings): string[] {
  return settings.sandbox?.network?.allowedDomains ?? [];
}

// ─── declared needs: writes/network only — host excluded by construction ────

interface DeclaredNeeds {
  writes: string[];
  network: string[];
}

/**
 * The `writes`/`network` needs declared across every verify command in a
 * `wave.config.json`, deduplicated — read through the REAL
 * {@link loadWaveConfig} loader, never a restated copy of `VerifyCommand`'s
 * shape. Absence of the file is a valid, expected state (this repo's own
 * dogfood config lives at the gitignored `.flotilla/wave.config.json`, never
 * tracked at the repo root — the identical situation
 * allowlist-scaffold-guard.spec.ts's own `extractWaveConfigVerifyCommands`
 * handles) and contributes zero needs rather than throwing.
 *
 * `cmd.needs?.host` is deliberately NEVER read here. That is not an oversight
 * this function happens to have — it is the whole point of the "host is
 * never representable" describe block below: `host` cannot be narrowed to a
 * path or a host, so there is nothing for a `writes`/`network` parity check
 * to hold it against, and folding it in here would silently invent a
 * representation ADR-0049 decision 3 says must not exist.
 */
function extractDeclaredNeeds(path: string): DeclaredNeeds {
  if (!existsSync(path)) return { writes: [], network: [] };
  const config = loadWaveConfig(path);
  const profiles = config.verify?.profiles ?? [];
  const writes = new Set<string>();
  const network = new Set<string>();
  for (const profile of profiles) {
    for (const cmd of profile.commands) {
      for (const w of cmd.needs?.writes ?? []) writes.add(w);
      for (const n of cmd.needs?.network ?? []) network.add(n);
    }
  }
  return { writes: [...writes], network: [...network] };
}

// ─── the parity predicate, one direction pair at a time ──────────────────────

interface ParityResult {
  /** Declared but not present in the tracked block (AC5, direction 1). */
  missingFromBlock: string[];
  /** Present in the tracked block but never declared (AC5, direction 2). */
  undeclaredInBlock: string[];
}

/** Set-based, order-independent parity check between one dimension's
 * declared needs and its scaffolded tracked-block entries. */
function checkParity(declared: readonly string[], scaffolded: readonly string[]): ParityResult {
  const declaredSet = new Set(declared);
  const scaffoldedSet = new Set(scaffolded);
  return {
    missingFromBlock: declared.filter((d) => !scaffoldedSet.has(d)),
    undeclaredInBlock: scaffolded.filter((s) => !declaredSet.has(s)),
  };
}

// ─── fixture helper: a real wave.config.json, through the real loader ───────

/** Build a temp `wave.config.json` declaring the given verify commands under
 * one profile, run `fn` with its path, then clean up — mirrors
 * allowlist-scaffold-guard.spec.ts's identical fixture pattern so both guards
 * exercise `loadWaveConfig()` the same way. */
function withFixtureConfig(commands: VerifyCommand[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-guard-'));
  const fixturePath = join(dir, 'wave.config.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        store: { kind: 'github' },
        verify: {
          profiles: [{ name: 'fixture', appliesTo: ['**'], commands }],
        },
      }),
    );
    fn(fixturePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── live-file tests: the vacuous case, asserted explicitly (not skipped) ───

describe('sandbox-scaffold-guard — parseJsonc tolerates // comments the live settings reader accepts (Parser constraint)', () => {
  const withComment =
    '{\n  "sandbox": {\n    // widened for the ios verify gate\n    "filesystem": { "allowWrite": ["~/Library/Developer/Xcode/DerivedData"] }\n  }\n}\n';

  it('a bare JSON.parse throws on the exact shape the live file has carried', () => {
    expect(() => JSON.parse(withComment)).toThrow();
  });

  it('parseJsonc reads the identical text without throwing, and the comment is gone', () => {
    const parsed = parseJsonc(withComment) as LiveSettings;
    expect(parsed.sandbox?.filesystem?.allowWrite).toEqual([
      '~/Library/Developer/Xcode/DerivedData',
    ]);
  });
});

describe("sandbox-scaffold-guard — live files: writes/network parity (issue #716, ADR-0049 AC5)", () => {
  const settingsRaw = readFileSync(SETTINGS_PATH, 'utf-8');
  const settings = parseJsonc(settingsRaw) as LiveSettings;
  const scaffoldedWrites = extractSandboxWrites(settings);
  const scaffoldedNetwork = extractSandboxNetwork(settings);
  const waveConfigPath = join(REPO_ROOT, 'wave.config.json');
  const declared = extractDeclaredNeeds(waveConfigPath);

  it('wave.config.json is absent from this worktree by construction (gitignored .flotilla/wave.config.json) — treated as zero declared needs, not a crash', () => {
    expect(existsSync(waveConfigPath)).toBe(false);
    expect(() => extractDeclaredNeeds(waveConfigPath)).not.toThrow();
    expect(declared).toEqual({ writes: [], network: [] });
  });

  it("this repo's own tracked .claude/settings.json carries no sandbox block yet — no dogfood verify command declares a writes/network need", () => {
    expect(scaffoldedWrites).toEqual([]);
    expect(scaffoldedNetwork).toEqual([]);
  });

  it('both directions hold vacuously on the live files — nothing declared, nothing scaffolded; a REAL assertion against the real files, not a skip', () => {
    expect(checkParity(declared.writes, scaffoldedWrites)).toEqual({
      missingFromBlock: [],
      undeclaredInBlock: [],
    });
    expect(checkParity(declared.network, scaffoldedNetwork)).toEqual({
      missingFromBlock: [],
      undeclaredInBlock: [],
    });
  });
});

// ─── fixture-based tests: the real parity logic, exercised for real ─────────

describe('sandbox-scaffold-guard — fixture: checkParity exercised through the real loadWaveConfig() loader (issue #716)', () => {
  it('positive control — declared writes/network entries exactly matching a scaffold: clean parity in both directions', () => {
    withFixtureConfig(
      [
        {
          cwd: 'ios',
          command: 'xcodebuild test -scheme App',
          needs: { writes: ['~/Library/Developer/Xcode/DerivedData'] },
        },
        {
          command: 'npm run integration',
          needs: { network: ['registry.example-cache.internal'] },
        },
      ],
      (path) => {
        const declared = extractDeclaredNeeds(path);
        expect(declared).toEqual({
          writes: ['~/Library/Developer/Xcode/DerivedData'],
          network: ['registry.example-cache.internal'],
        });
        const scaffolded: LiveSettings = {
          sandbox: {
            filesystem: { allowWrite: ['~/Library/Developer/Xcode/DerivedData'] },
            network: { allowedDomains: ['registry.example-cache.internal'] },
          },
        };
        expect(checkParity(declared.writes, extractSandboxWrites(scaffolded))).toEqual({
          missingFromBlock: [],
          undeclaredInBlock: [],
        });
        expect(checkParity(declared.network, extractSandboxNetwork(scaffolded))).toEqual({
          missingFromBlock: [],
          undeclaredInBlock: [],
        });
      },
    );
  });

  it('negative control (AC5, direction 1 — declared → scaffolded) — a declared need with NO matching scaffold entry surfaces as missingFromBlock', () => {
    withFixtureConfig(
      [
        {
          cwd: 'ios',
          command: 'xcodebuild test -scheme App',
          needs: { writes: ['~/Library/Developer/Xcode/DerivedData'] },
        },
      ],
      (path) => {
        const declared = extractDeclaredNeeds(path);
        const scaffolded: LiveSettings = { sandbox: { filesystem: { allowWrite: [] } } };
        const result = checkParity(declared.writes, extractSandboxWrites(scaffolded));
        expect(result.missingFromBlock).toEqual(['~/Library/Developer/Xcode/DerivedData']);
        expect(result.undeclaredInBlock).toEqual([]);
      },
    );
  });

  it('negative control (AC5, direction 2 — scaffolded → declared) — a scaffolded entry with NO declaring command surfaces as undeclaredInBlock', () => {
    withFixtureConfig([{ command: 'plain build, no needs' }], (path) => {
      const declared = extractDeclaredNeeds(path);
      expect(declared.writes).toEqual([]);
      const scaffolded: LiveSettings = {
        sandbox: { filesystem: { allowWrite: ['/some/path/nobody-declared'] } },
      };
      const result = checkParity(declared.writes, extractSandboxWrites(scaffolded));
      expect(result.missingFromBlock).toEqual([]);
      expect(result.undeclaredInBlock).toEqual(['/some/path/nobody-declared']);
    });
  });

  it('dedup across commands — two commands declaring the SAME writes path collapse to one entry, not a false parity gap', () => {
    withFixtureConfig(
      [
        { command: 'cmd one', needs: { writes: ['~/shared-cache'] } },
        { command: 'cmd two', needs: { writes: ['~/shared-cache'] } },
      ],
      (path) => {
        expect(extractDeclaredNeeds(path).writes).toEqual(['~/shared-cache']);
      },
    );
  });

  it('a command with no needs at all contributes nothing — the additive, needs-free case composes exactly as before ADR-0049', () => {
    withFixtureConfig([{ command: 'npm test' }], (path) => {
      expect(extractDeclaredNeeds(path)).toEqual({ writes: [], network: [] });
    });
  });
});

// ─── host is never representable: excluded from parity by construction ──────

describe('sandbox-scaffold-guard — host needs are never scaffolded (ADR-0049 decision 3, AC3/AC5)', () => {
  it('a needs.host: true command contributes NOTHING to extractDeclaredNeeds — writes/network stay empty', () => {
    withFixtureConfig([{ command: 'xcrun simctl boot', needs: { host: true } }], (path) => {
      expect(extractDeclaredNeeds(path)).toEqual({ writes: [], network: [] });
    });
  });

  it('a command declaring writes/network AND host together still contributes only the writes/network parts', () => {
    withFixtureConfig(
      [
        {
          command: 'xcodebuild test -scheme App',
          needs: { writes: ['~/Library/Developer/Xcode/DerivedData'], host: true },
        },
      ],
      (path) => {
        expect(extractDeclaredNeeds(path)).toEqual({
          writes: ['~/Library/Developer/Xcode/DerivedData'],
          network: [],
        });
      },
    );
  });

  it('LiveSettings has no field a host need could ever populate — extractSandboxWrites/Network read only filesystem.allowWrite / network.allowedDomains', () => {
    // Even a settings object carrying an out-of-shape "host" key under
    // `sandbox` (hand-authored, malformed, or from a future harness version)
    // is invisible to both extractors — there is no `sandbox.host` read path
    // to add one to, by construction, not by convention. Built as `unknown`
    // first (not a direct `LiveSettings`-typed literal) specifically so the
    // extra `host` key is legal to write at all — the point of this test is
    // the RUNTIME read path, not a compile-time excess-property check.
    const raw: unknown = {
      sandbox: {
        filesystem: { allowWrite: ['/tracked/path'] },
        network: { allowedDomains: ['tracked.example.com'] },
        host: true,
      },
    };
    const withStrayHostKey = raw as LiveSettings;
    expect(extractSandboxWrites(withStrayHostKey)).toEqual(['/tracked/path']);
    expect(extractSandboxNetwork(withStrayHostKey)).toEqual(['tracked.example.com']);
  });
});

// ─── doc citation: setup-mechanics.md names this spec as the enforcement ────

describe('sandbox-scaffold-guard — setup-mechanics.md documents the rule this spec enforces, and the host-class generalization (issue #716)', () => {
  const setupMd = readFileSync(SETUP_MECHANICS_PATH, 'utf-8');

  it('cites this spec by name as the enforcement mechanism', () => {
    expect(setupMd).toContain('sandbox-scaffold-guard.spec.ts');
  });

  it('names ADR-0049 for the sandbox capability scaffold', () => {
    expect(setupMd).toMatch(/ADR-0049/);
  });

  it("generalizes the docker note into the rule for the whole host class (not a docker-specific carve-out)", () => {
    expect(setupMd).toMatch(/rule for the whole `host` class/);
    expect(setupMd).toMatch(/docker.*worked example/i);
  });

  it('documents the measure-first ordering (ADR-0049\'s one open assumption) ahead of the scaffold JSON', () => {
    const measureIdx = setupMd.indexOf('Measuring whether the tracked sandbox block is honored');
    const scaffoldIdx = setupMd.indexOf('The scaffold JSON — deriving');
    expect(measureIdx).toBeGreaterThan(-1);
    expect(scaffoldIdx).toBeGreaterThan(-1);
    expect(measureIdx).toBeLessThan(scaffoldIdx);
  });
});
