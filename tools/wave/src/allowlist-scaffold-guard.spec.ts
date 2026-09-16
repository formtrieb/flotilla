/**
 * allowlist-scaffold-guard.spec.ts — the reconciliation guard for the AFK
 * harness allowlist scaffold (issue #291, amended 2026-07-31).
 *
 * Same family as skill-schema-drift.spec.ts and skill-reference-guard.spec.ts:
 * a guard whose subject is config/doc consistency rather than engine behavior.
 * Before this spec, "the scaffold matches the live allowlist" was a static
 * prose classification (`setup-mechanics.md`'s "Scaffold-vs-live allowlist
 * reconciliation" section, issue #269) — nothing falsified it, and a fresh
 * drift could land invisibly. This spec runs the rule for real, in BOTH
 * directions:
 *
 *   Direction 1 (issue #269/#291, AC1-3) — LIVE ENTRY → IS IT CITED?
 *   Every string in the live `.claude/settings.json` `permissions.allow`
 *   array must be either (a) in the scaffold's canonical JSON block (or its
 *   documented flotilla-own vendored-form substitution), (b) named
 *   dogfood-only in setup-mechanics.md's "2026-07-31 pass" table, or
 *   (c) a member of the SHRINK-ONLY seeded-legacy list below (the AC2
 *   allowance for known-stale entries an operator PR has not yet removed).
 *   That list started with four entries #291 could not remove itself
 *   (`.claude/settings.json` sat outside its declared Files globs); issue
 *   #345 *did* declare that file and performed the removal, so the list is
 *   empty as of this pass — see SEEDED_LEGACY_ALLOW's own comment below for
 *   the disposition of each of the four.
 *
 *   Issue #345 also folded a fifth generic-scaffold entry in
 *   (`jq -e -r '.url':*`, the driver's on-disk PR-URL-confirmation fallback,
 *   `workflow-driver.md` Termination step 4) — canonical, not dogfood-only,
 *   because every consumer's Worker can reach for that fallback, not only
 *   this repo's own.
 *
 *   Direction 2 (2026-07-31 amendment) — DECLARED GATE → IS IT ALLOWED?
 *   The converse a one-directional check cannot see: a command a dispatched
 *   agent actually RUNS but that was never written to the allowlist prints
 *   green under direction 1 alone, because direction 1 never looks at a
 *   command that was never an entry. This is the exact live incident the
 *   amendment records — root CLAUDE.md's Verify section names `npm test` /
 *   `npm run typecheck`, and neither had an allow entry until the 2026-07-31
 *   pass landed five dogfood-only lines. For every command
 *   `wave.config.json` → `verify.profiles[].commands` declares, and every
 *   command root CLAUDE.md's Verify section names, this half asserts a
 *   matching `permissions.allow` entry exists — reading `wave.config.json`
 *   through the REAL `loadWaveConfig()` loader (not a restated copy of
 *   `VerifyConfig`'s shape), and reading CLAUDE.md's fenced example verbatim.
 *   `wave.config.json` is absent from THIS worktree by construction (this
 *   repo's own dogfood config lives at the gitignored `.flotilla/
 *   wave.config.json`, never tracked — see CONTEXT.md `### Distribution`),
 *   so that half of direction 2 is exercised for real against a temp-file
 *   fixture built through the same loader, not against a file this repo does
 *   not ship.
 *
 * Parser constraint (issue #291). The tracked `.claude/settings.json` is read
 * by Claude Code with a JSONC-tolerant parser and has carried `//` comments in
 * `permissions.deny` before (verified live: the file parsed and its
 * `PreToolUse` hook fired with a `//` line present, though strict
 * `JSON.parse` threw on it). A bare `JSON.parse` on the live file is
 * therefore not a safe assumption for this guard to make — `parseJsonc`
 * below strips `//` and `/* *​/` comments outside string literals before
 * parsing, and a dedicated test below proves `JSON.parse` really would have
 * thrown on the shape it handles.
 *
 * Both directions are permanent, in-spec negative controls (the same
 * falsification style skill-schema-drift.spec.ts and skill-reference-guard.
 * spec.ts use): a planted uncited entry / a planted missing allow entry is
 * pushed through the SAME classification/coverage functions the real
 * assertions use, so "the check works" is distinguishable from "the check
 * cannot fail" every time `npm test` runs — not just once, by hand, in a PR
 * description. (Convention 11's live, hand-run falsification for THIS guard
 * is recorded in the PR's judgmentCalls: setup-mechanics.md's dogfood-only
 * table was temporarily broken, `npx vitest run` was observed to fail on
 * exactly the entries that lost their citation, and the file was restored.)
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

const REPO_ROOT = resolve(__dirname, '../../..');
const SETTINGS_PATH = join(REPO_ROOT, '.claude/settings.json');
const SETUP_MECHANICS_PATH = join(
  REPO_ROOT,
  '.claude/skills/wave-setup/reference/setup-mechanics.md',
);
const ROOT_CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md');

// ─── JSONC-tolerant parse (parser constraint) ────────────────────────────────

/**
 * Strip `//` line comments and `/* … *​/` block comments from a JSON text,
 * respecting string literals (a `//` or `/*` inside a quoted JSON string
 * value is left untouched — a minimal JSONC tolerance, not a full parser).
 * Necessary because Claude Code's own settings reader accepts `//` comments
 * in `.claude/settings.json`, so this guard cannot assume the live file is
 * strict JSON.
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

// ─── live settings + allow-entry parsing ─────────────────────────────────────

interface LiveSettings {
  permissions?: { allow?: string[]; deny?: string[] };
}

interface AllowEntry {
  /** The raw string exactly as it appears in `permissions.allow`. */
  raw: string;
  /** The command pattern inside `Bash(...)`, with any `:*` suffix stripped. */
  tokens: string[];
  /** Whether the entry ends `:*` (a prefix-wildcard match). */
  wildcard: boolean;
}

/** Parse one `permissions.allow` string into an {@link AllowEntry}, or `null`
 * if it is not `Bash(...)`-shaped (out of this guard's declared scope — see
 * setup-mechanics.md's reconciliation "Scope" note: `permissions.allow` only,
 * and in practice every live entry is a Bash form). */
function parseBashPattern(raw: string): AllowEntry | null {
  const m = /^Bash\((.*)\)$/.exec(raw);
  if (!m) return null;
  let pattern = m[1];
  let wildcard = false;
  if (pattern.endsWith(':*')) {
    wildcard = true;
    pattern = pattern.slice(0, -2);
  }
  return { raw, tokens: pattern.split(/\s+/).filter(Boolean), wildcard };
}

function commandTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** True iff `entry` covers `cmdTokens` — an exact token match for a
 * non-wildcard entry, or a token-array PREFIX match for a `:*` entry. Token-
 * based (not substring-based) so `npm ci` never wrongly satisfies a prefix
 * check meant for `npm ciX` or vice versa. */
function entryCoversTokens(entry: AllowEntry, cmdTokens: string[]): boolean {
  if (entry.wildcard) {
    return (
      entry.tokens.length <= cmdTokens.length &&
      entry.tokens.every((t, i) => t === cmdTokens[i])
    );
  }
  return (
    entry.tokens.length === cmdTokens.length &&
    entry.tokens.every((t, i) => t === cmdTokens[i])
  );
}

function findCoveringEntry(entries: AllowEntry[], command: string): AllowEntry | undefined {
  const toks = commandTokens(command);
  return entries.find((e) => entryCoversTokens(e, toks));
}

// ─── direction 1: scaffold / documented-exception / dogfood-only extraction ──

/** Extract the JSON payload of the first ```json fence found AFTER `heading`
 * in `md`. Throws (never silently returns nothing) if the heading or the
 * fence is missing — a doc restructure must break this extraction, not make
 * it vacuous. */
function extractFencedJsonAfterHeading(md: string, heading: string): unknown {
  const hIdx = md.indexOf(heading);
  if (hIdx < 0) {
    throw new Error(`heading not found in setup-mechanics.md: "${heading}"`);
  }
  const fenceStart = md.indexOf('```json', hIdx);
  if (fenceStart < 0) {
    throw new Error(`no \`\`\`json fence found after heading "${heading}" in setup-mechanics.md`);
  }
  const contentStart = md.indexOf('\n', fenceStart) + 1;
  const fenceEnd = md.indexOf('```', contentStart);
  if (fenceEnd < 0) {
    throw new Error(`unterminated \`\`\`json fence after heading "${heading}" in setup-mechanics.md`);
  }
  return JSON.parse(md.slice(contentStart, fenceEnd));
}

const SCAFFOLD_HEADING =
  '## AFK harness config scaffold: env block + permission allowlist (`.claude/settings.json`)';

/** The generic-consumer scaffold's `permissions.allow` array, straight out of
 * the fenced JSON block — the ONE authority for what a fresh consumer's
 * allowlist looks like. */
function extractGenericScaffoldAllow(md: string): string[] {
  const scaffold = extractFencedJsonAfterHeading(md, SCAFFOLD_HEADING) as {
    permissions?: { allow?: string[] };
  };
  const allow = scaffold.permissions?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new Error(
      'scaffold JSON block under "AFK harness config scaffold" has no permissions.allow array',
    );
  }
  return allow;
}

/** The generic scaffold's two engine-CLI lines — the exact strings flotilla's
 * own repo substitutes for its documented vendored exception (see
 * {@link extractVendoredExceptionEntries}). Named here so the substitution is
 * legible as a substitution, not a magic filter. */
const GENERIC_ENGINE_CLI_FORMS = new Set([
  'Bash(./node_modules/.bin/flotilla-engine:*)',
  'Bash(NODE_USE_ENV_PROXY=1 ./node_modules/.bin/flotilla-engine:*)',
]);

/**
 * flotilla's own documented exception: "This repo binds `engine.cli` to the
 * vendored value, and its OWN tracked allowlist reflects that single
 * substitution, not an addition: `<path>` (+ its env-prefixed twin) in place
 * of the two lines above." Extracts `<path>` from that sentence and returns
 * the two Bash-form entries it implies.
 */
function extractVendoredExceptionEntries(md: string): string[] {
  const anchor = 'not an addition:';
  const idx = md.indexOf(anchor);
  if (idx < 0) {
    throw new Error(`vendored-exception anchor missing in setup-mechanics.md: "${anchor}"`);
  }
  const window = md.slice(idx, idx + 400);
  const m = /`([^`]+)`\s*\(\+ its env-prefixed twin\)/.exec(window);
  if (!m) {
    throw new Error(
      'vendored-exception path not found after the "not an addition:" anchor in setup-mechanics.md',
    );
  }
  const path = m[1];
  return [`Bash(${path}:*)`, `Bash(NODE_USE_ENV_PROXY=1 ${path}:*)`];
}

const DOGFOOD_TABLE_HEADING = '### 2026-07-31 pass — the used-but-absent direction (issue #291)';
const DOGFOOD_TABLE_ROW = /^\|\s*`(Bash\([^`]+\))`\s*\|\s*dogfood-only\s*\|/gm;

/** The five `dogfood-only` rows of the "2026-07-31 pass" table. Bounded to a
 * window after the table's heading so a runaway regex cannot walk past the
 * table into unrelated prose that happens to contain a `Bash(...)` mention. */
function extractDogfoodOnlyEntries(md: string): string[] {
  const idx = md.indexOf(DOGFOOD_TABLE_HEADING);
  if (idx < 0) {
    throw new Error(`heading not found in setup-mechanics.md: "${DOGFOOD_TABLE_HEADING}"`);
  }
  const window = md.slice(idx, idx + 6000);
  const out = [...window.matchAll(DOGFOOD_TABLE_ROW)].map((mm) => mm[1]);
  if (out.length === 0) {
    throw new Error('no dogfood-only rows extracted from the 2026-07-31 pass table');
  }
  return out;
}

/**
 * Known-stale live allowlist entries that predate this guard and were not yet
 * removed from `.claude/settings.json` nor folded into a scaffold/dogfood-only
 * classification in setup-mechanics.md — SHRINK-ONLY, so the list may lose
 * entries but must never grow (a genuinely NEW unclassified entry must fail
 * the guard, not be quietly seeded away).
 *
 * **Emptied by issue #345.** `.claude/settings.json` sat outside issue #291's
 * declared Files globs (setup-mechanics.md + this spec only), so removing the
 * four entries below was left as a separate operator PR. Issue #345 declared
 * `.claude/settings.json` in its own Files globs and performed exactly that
 * removal — both pairs were confirmed dead (grepped across `.claude/**` and
 * `docs/**`) and dropped from the live file in the same change:
 *
 *  - `npx @formtrieb/flotilla-engine` (+ its `NODE_USE_ENV_PROXY` twin): the
 *    pre-setup bootstrap form (ADR-0032). setup-mechanics.md's own binding
 *    rule states this is "never an ongoing allowlist entry" once Procedure
 *    step 3 has run, which it has in this repo, and the doc's own
 *    reconciliation narrative already said so explicitly ("the `npx` pair no
 *    longer matches anything in the current scaffold at all").
 *  - `npx tsx tools/wave/src/cli.ts` (+ its `NODE_USE_ENV_PROXY` twin): a
 *    THIRD, never-scaffolded engine-invocation spelling. This repo's
 *    documented exception is the DOTTED
 *    `./tools/wave/node_modules/.bin/tsx …` form, never the bare `npx tsx`
 *    spelling — confirmed live-referenced nowhere except one stale,
 *    already-flagged example in `wave-shared/reference/convention-01-auth-
 *    preflight.md` (outside issue #345's Files globs; noted as a residual
 *    follow-up, not fixed here, since that doc's own scenario condition — "no
 *    tracked env block (yet) applies" — is false for this repo).
 *
 * The list is intentionally left in place, empty, rather than deleted: a
 * future stale entry re-seeds here the same way, and the shrink-only
 * discipline (and the tests below) carry forward unchanged.
 */
const SEEDED_LEGACY_ALLOW: readonly string[] = [];

interface ClassificationSets {
  canonical: Set<string>;
  dogfoodOnly: Set<string>;
  seededLegacy: Set<string>;
}

function buildClassificationSets(setupMd: string): ClassificationSets {
  const generic = extractGenericScaffoldAllow(setupMd);
  const genericMinusEngineCli = generic.filter((e) => !GENERIC_ENGINE_CLI_FORMS.has(e));
  const exception = extractVendoredExceptionEntries(setupMd);
  const dogfoodOnly = extractDogfoodOnlyEntries(setupMd);
  return {
    canonical: new Set([...genericMinusEngineCli, ...exception]),
    dogfoodOnly: new Set(dogfoodOnly),
    seededLegacy: new Set(SEEDED_LEGACY_ALLOW),
  };
}

/** The direction-1 predicate. Returns `null` when `raw` is cited, or a
 * human-legible reason naming all three sets it failed to match. */
function classifyLiveEntry(raw: string, sets: ClassificationSets): string | null {
  if (sets.canonical.has(raw)) return null;
  if (sets.dogfoodOnly.has(raw)) return null;
  if (sets.seededLegacy.has(raw)) return null;
  return (
    `live allowlist entry ${raw} is neither in the scaffold's canonical set, ` +
    'dogfood-documented (setup-mechanics.md "2026-07-31 pass" table), nor in the ' +
    'seeded legacy list (SEEDED_LEGACY_ALLOW) — it arrived without a scaffold ' +
    'citation or a dogfood-only note (setup-mechanics.md, "Going forward").'
  );
}

// ─── direction 2: declared verify gate → matching allow entry ───────────────

/** Extract the command list from the first ```bash fence after `## Verify` in
 * root CLAUDE.md, stripping trailing `# comment` text off each line. */
function extractClaudeMdVerifyCommands(md: string): string[] {
  const heading = '## Verify';
  const hIdx = md.indexOf(heading);
  if (hIdx < 0) {
    throw new Error('## Verify heading not found in root CLAUDE.md');
  }
  const fenceStart = md.indexOf('```bash', hIdx);
  if (fenceStart < 0) {
    throw new Error('no ```bash fence found after the ## Verify heading in root CLAUDE.md');
  }
  const contentStart = md.indexOf('\n', fenceStart) + 1;
  const fenceEnd = md.indexOf('```', contentStart);
  if (fenceEnd < 0) {
    throw new Error('unterminated ```bash fence after the ## Verify heading in root CLAUDE.md');
  }
  return md
    .slice(contentStart, fenceEnd)
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line.length > 0);
}

/**
 * The `wave.config.json` → `verify.profiles[].commands` command list, read
 * through the REAL {@link loadWaveConfig} loader — never a restated copy of
 * `VerifyConfig`'s shape. Absence is a valid, expected state (this repo's own
 * dogfood config lives at the gitignored `.flotilla/wave.config.json`, never
 * tracked at the repo root) and contributes zero commands rather than
 * throwing — a fresh consumer's TRACKED `wave.config.json` is the ordinary
 * case this half exists for.
 */
function extractWaveConfigVerifyCommands(path: string): string[] {
  if (!existsSync(path)) return [];
  const config = loadWaveConfig(path);
  const profiles = config.verify?.profiles ?? [];
  return profiles.flatMap((p) => p.commands.map((c) => c.command));
}

// ─── direction 1 tests ────────────────────────────────────────────────────────

describe('allowlist-scaffold-guard — parseJsonc tolerates // comments the live settings reader accepts (Parser constraint)', () => {
  const withComment =
    '{\n  "permissions": {\n    "deny": [\n      // secret-echo anchor\n      "Read(.env)"\n    ]\n  }\n}\n';

  it('a bare JSON.parse throws on the exact shape the live file has carried', () => {
    expect(() => JSON.parse(withComment)).toThrow();
  });

  it('parseJsonc reads the identical text without throwing, and the comment is gone', () => {
    const parsed = parseJsonc(withComment) as { permissions: { deny: string[] } };
    expect(parsed.permissions.deny).toEqual(['Read(.env)']);
  });

  it('a // inside a string value survives untouched (not mistaken for a comment)', () => {
    const withUrlLikeValue = '{\n  "note": "see https://example.com/x"\n}\n';
    expect(parseJsonc(withUrlLikeValue)).toEqual({ note: 'see https://example.com/x' });
  });

  it('a /* */ block comment is also tolerated', () => {
    const withBlockComment = '{\n  /* block */\n  "a": 1\n}\n';
    expect(parseJsonc(withBlockComment)).toEqual({ a: 1 });
  });
});

describe('allowlist-scaffold-guard — direction 1: every live allow entry is cited (issue #269/#291 AC1-3)', () => {
  const settingsRaw = readFileSync(SETTINGS_PATH, 'utf-8');
  const settings = parseJsonc(settingsRaw) as LiveSettings;
  const liveAllow = settings.permissions?.allow ?? [];
  const setupMd = readFileSync(SETUP_MECHANICS_PATH, 'utf-8');
  const sets = buildClassificationSets(setupMd);

  it('finds the live allow population (a guard matching nothing is green for the wrong reason)', () => {
    expect(liveAllow.length).toBeGreaterThanOrEqual(20);
  });

  it('extracts the generic scaffold, the documented exception, and the dogfood-only table with non-trivial populations', () => {
    expect(extractGenericScaffoldAllow(setupMd).length).toBe(15); // 14 + jq (issue #345)
    expect(extractVendoredExceptionEntries(setupMd).length).toBe(2);
    expect(extractDogfoodOnlyEntries(setupMd).length).toBe(5);
    expect(sets.canonical.size).toBe(15); // 15 generic - 2 replaced + 2 exception
  });

  it('every live allow entry classifies as canonical, dogfood-only, or seeded-legacy (AC1/AC2, real assertion)', () => {
    const offenders = liveAllow
      .map((e) => classifyLiveEntry(e, sets))
      .filter((v): v is string => v !== null);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the uncited-but-tolerated live entries are EXACTLY the seeded legacy list — no silent growth (AC2)', () => {
    const uncited = liveAllow.filter((e) => !sets.canonical.has(e) && !sets.dogfoodOnly.has(e));
    expect(new Set(uncited)).toEqual(new Set(SEEDED_LEGACY_ALLOW));
  });

  it('every seeded-legacy entry is still live and still genuinely uncited (an allowlist that outlives its reason is a hole)', () => {
    for (const entry of SEEDED_LEGACY_ALLOW) {
      expect(liveAllow, `seeded-legacy entry no longer live: ${entry}`).toContain(entry);
      expect(
        sets.canonical.has(entry) || sets.dogfoodOnly.has(entry),
        `seeded-legacy entry ${entry} now has a real citation — drop it from SEEDED_LEGACY_ALLOW`,
      ).toBe(false);
    }
  });

  it('the seeded-legacy set is empty (AC2, issue #345) — the four #291-era entries were removed live, not merely re-cited', () => {
    expect(SEEDED_LEGACY_ALLOW).toEqual([]);
    // The two pairs SEEDED_LEGACY_ALLOW used to name are gone from the live
    // file entirely — not reclassified as canonical/dogfood-only, which would
    // make this assertion pass for the wrong reason.
    expect(liveAllow).not.toContain('Bash(npx @formtrieb/flotilla-engine:*)');
    expect(liveAllow).not.toContain('Bash(NODE_USE_ENV_PROXY=1 npx @formtrieb/flotilla-engine:*)');
    expect(liveAllow).not.toContain('Bash(npx tsx tools/wave/src/cli.ts:*)');
    expect(liveAllow).not.toContain('Bash(NODE_USE_ENV_PROXY=1 npx tsx tools/wave/src/cli.ts:*)');
  });

  it('negative control (AC1) — a planted uncited entry fails the same classification predicate', () => {
    const planted = 'Bash(curl http://example.com:*)';
    expect(sets.canonical.has(planted)).toBe(false);
    expect(sets.dogfoodOnly.has(planted)).toBe(false);
    expect(sets.seededLegacy.has(planted)).toBe(false);
    const why = classifyLiveEntry(planted, sets);
    expect(why).not.toBeNull();
    expect(why).toMatch(/neither in the scaffold's canonical set/);
  });

  it('positive control — a genuinely canonical entry classifies clean', () => {
    expect(classifyLiveEntry('Bash(git fetch origin:*)', sets)).toBeNull();
  });

  it('positive control — a genuinely dogfood-only entry classifies clean', () => {
    expect(classifyLiveEntry('Bash(npm test)', sets)).toBeNull();
  });

  it('negative control — extractGenericScaffoldAllow/extractVendoredExceptionEntries/extractDogfoodOnlyEntries fail loud on a doc with no anchors', () => {
    expect(() => extractGenericScaffoldAllow('# nothing here\n')).toThrow(/heading not found/);
    expect(() => extractVendoredExceptionEntries('# nothing here\n')).toThrow(
      /vendored-exception anchor missing/,
    );
    expect(() => extractDogfoodOnlyEntries('# nothing here\n')).toThrow(/heading not found/);
  });
});

// ─── direction 2 tests ────────────────────────────────────────────────────────

describe('allowlist-scaffold-guard — direction 2: every declared verify gate has a matching allow entry (2026-07-31 amendment)', () => {
  const claudeMd = readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8');
  const settingsRaw = readFileSync(SETTINGS_PATH, 'utf-8');
  const settings = parseJsonc(settingsRaw) as LiveSettings;
  const liveAllowEntries = (settings.permissions?.allow ?? [])
    .map(parseBashPattern)
    .filter((e): e is AllowEntry => e !== null);

  it('extracts the root CLAUDE.md Verify section commands (pinned, so a doc rewrite is visible here)', () => {
    expect(extractClaudeMdVerifyCommands(claudeMd)).toEqual([
      'npm ci',
      'npm test',
      'npm run typecheck',
    ]);
  });

  it('every CLAUDE.md Verify command has a matching live permissions.allow entry (real assertion — the live incident)', () => {
    const commands = extractClaudeMdVerifyCommands(claudeMd);
    const uncovered = commands.filter((c) => !findCoveringEntry(liveAllowEntries, c));
    expect(
      uncovered,
      `declared verify gate(s) with no matching allow entry: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('negative control (2026-07-31 amendment) — reproducing the exact pre-pass gap: dropping the npm-test/typecheck entries makes them uncovered again', () => {
    const withoutDogfoodEntries = liveAllowEntries.filter(
      (e) => e.raw !== 'Bash(npm test)' && e.raw !== 'Bash(npm run typecheck)',
    );
    const uncovered = extractClaudeMdVerifyCommands(claudeMd).filter(
      (c) => !findCoveringEntry(withoutDogfoodEntries, c),
    );
    expect(uncovered).toEqual(['npm test', 'npm run typecheck']);
    // ...and npm ci, unaffected by the removal, stays covered — isolating the
    // removal's effect instead of a global break.
    expect(findCoveringEntry(withoutDogfoodEntries, 'npm ci')).toBeDefined();
  });

  it('findCoveringEntry token-matches, not substring-matches (a near-miss command is NOT covered)', () => {
    const entries = [parseBashPattern('Bash(npm ci)') as AllowEntry];
    expect(findCoveringEntry(entries, 'npm ci --prefix tools/wave')).toBeUndefined();
    expect(findCoveringEntry(entries, 'npm ci')).toBeDefined();
  });

  it('wave.config.json is absent from this worktree by construction (gitignored .flotilla/wave.config.json) — treated as zero commands, not a crash', () => {
    const path = join(REPO_ROOT, 'wave.config.json');
    expect(existsSync(path)).toBe(false);
    expect(() => extractWaveConfigVerifyCommands(path)).not.toThrow();
    expect(extractWaveConfigVerifyCommands(path)).toEqual([]);
  });

  it('the wave.config.json direction is exercised for real through loadWaveConfig against a fixture, not a restated shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allowlist-guard-'));
    const fixturePath = join(dir, 'wave.config.json');
    try {
      writeFileSync(
        fixturePath,
        JSON.stringify({
          store: { kind: 'github' },
          verify: {
            profiles: [
              {
                name: 'engine',
                appliesTo: ['tools/wave/**'],
                commands: [
                  { cwd: 'tools/wave', command: 'npx vitest run' },
                  { cwd: 'tools/wave', command: 'npx tsc --noEmit' },
                ],
              },
            ],
          },
        }),
      );
      const commands = extractWaveConfigVerifyCommands(fixturePath);
      expect(commands).toEqual(['npx vitest run', 'npx tsc --noEmit']);
      const uncovered = commands.filter((c) => !findCoveringEntry(liveAllowEntries, c));
      expect(uncovered).toEqual([]); // both covered by the canonical scaffold entries

      // negative control — a fixture command with no allow-entry match at all.
      const withGap = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
        verify: { profiles: Array<{ commands: Array<{ command: string }> }> };
      };
      withGap.verify.profiles[0].commands.push({ command: 'composer install' });
      writeFileSync(fixturePath, JSON.stringify(withGap));
      const commands2 = extractWaveConfigVerifyCommands(fixturePath);
      const uncovered2 = commands2.filter((c) => !findCoveringEntry(liveAllowEntries, c));
      expect(uncovered2).toEqual(['composer install']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── AC3: the scaffold documents this guard now enforces the going-forward rule ──

describe('allowlist-scaffold-guard — setup-mechanics.md documents the rule is now enforced, retiring the could-not-falsify disclosure (AC3)', () => {
  const setupMd = readFileSync(SETUP_MECHANICS_PATH, 'utf-8');

  it('cites this spec by name as the enforcement mechanism', () => {
    expect(setupMd).toContain('allowlist-scaffold-guard.spec.ts');
  });

  it('states the rule is enforced, not only stated, and names issue #291', () => {
    expect(setupMd).toMatch(/[Ee]nforced, not (?:just|only) stated/);
    expect(setupMd).toContain('#291');
  });

  it('retires the could-not-falsify framing explicitly', () => {
    expect(setupMd).toMatch(/could-not-falsify/i);
    expect(setupMd).toMatch(/retired/i);
  });
});
