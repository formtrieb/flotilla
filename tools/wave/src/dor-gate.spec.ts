import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  validateIssue,
  validateIssueView,
  acFilesCoverageCheck,
  extractAcBody,
  type BlockerResolution,
  type DorResult,
  type GateResult,
} from './dor-gate';
import type { HeaderBlock } from './header-parser';
import type { IssueView } from './contract';
import type { VerifyConfig } from './verify';
// The composer's own bare-id strip — the function whose output Gate 10 models.
// Imported HERE and never from dor-gate.ts: `compose-driver` already reaches
// dor-gate.ts transitively, so the gate importing it back would close an
// evaluation-time cycle. A spec is outside the engine's module graph, so this
// is the one place the two can be compared.
import { stripBareIds } from './compose-driver';

/**
 * Each test spins up a throwaway repo-like tree under $TMPDIR with the bits
 * the DOR-Gate needs to evaluate: the issue file under test + zero-or-more
 * sibling issue files for blocked-by resolution + zero-or-more real files for
 * glob expansion. No fixtures committed to disk; the spec is self-contained.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-dor-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeIssue(slug: string, name: string, body: string): string {
  const dir = join(root, '.scratch', slug, 'issues');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
}

function writeDoneIssue(slug: string, name: string, body: string): string {
  const dir = join(root, '.scratch', slug, 'issues', 'done');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
}

function writeRealFile(relPath: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '// placeholder', 'utf-8');
}

const ISSUE_FIXTURE_BODY = (header: string) =>
  [
    '# 99 — Example',
    '',
    '**Status:** ready-for-agent',
    header,
    '',
    '## What to build',
    '',
    'A thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] Thing is built',
    '- [ ] Tests pass',
  ].join('\n');

describe('validateIssue — happy path', () => {
  it('PASS when all 5 gates pass', () => {
    writeRealFile(
      'libs/features/shared/src/lib/_internal/format-validators.ts',
    );
    const issuePath = writeIssue(
      'happy-feature',
      '99-example.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- libs/features/shared/src/lib/_internal/format-validators.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall, JSON.stringify(result, null, 2)).toBe('PASS');
    expect(result.gates.every((g) => g.status !== 'fail')).toBe(true);
  });
});

describe('validateIssue — fail cases', () => {
  it('FAIL when a required field is missing', () => {
    const issuePath = writeIssue(
      'happy-feature',
      '98-missing-risk.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Worker:** background',
          '**Files:**',
          '- libs/features/shared/src/lib/_internal/format-validators.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('FAIL');
    expect(result.gates[0]).toMatchObject({
      name: 'header-parseable',
      status: 'fail',
    });
  });

  it('FAIL when Risk enum is invalid', () => {
    const issuePath = writeIssue(
      'happy-feature',
      '97-bad-risk.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** super-risky',
          '**Worker:** background',
          '**Files:**',
          '- libs/features/shared/src/lib/_internal/format-validators.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('FAIL');
    expect(result.gates[0].reason).toMatch(/Risk/);
  });

  it('FAIL header-parseable when the Blocked-by section is non-empty but has no parseable ref (FOR-31 / W4-F2)', () => {
    // `FOR-23` is the human-readable id; the canonical wire form is `FOR#23`.
    // A malformed dependency line must FAIL the named `header-parseable` gate —
    // it must NOT be read as a fabricated `none` (absence ≠ evidence). A row that
    // cannot state its dependencies is not grabbable.
    const issuePath = writeIssue(
      'happy-feature',
      '95-malformed-blocker.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- libs/features/shared/src/lib/_internal/format-validators.ts',
          '**Blocked by:** FOR-23',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('FAIL');
    expect(result.gates[0]).toMatchObject({
      name: 'header-parseable',
      status: 'fail',
    });
    expect(result.gates[0].reason).toMatch(/FOR-23/);
  });

  it('FAIL when a blocked-by ref does not resolve', () => {
    const issuePath = writeIssue(
      'happy-feature',
      '96-bad-blocker.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- libs/features/shared/src/lib/_internal/format-validators.ts',
          '**Blocked by:** #42',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('FAIL');
    const blocked = result.gates.find(
      (g) => g.name === 'blocked-by-chain-resolves',
    );
    expect(blocked).toMatchObject({ status: 'fail' });
    expect(blocked?.reason).toMatch(/#42/);
  });
});

describe('validateIssue — warn cases', () => {
  it('warns (does not fail) when a glob matches nothing', () => {
    const issuePath = writeIssue(
      'happy-feature',
      '95-empty-glob.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- libs/features/tasks/*/strings.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('PASS');
    const filesGate = result.gates.find((g) => g.name === 'files-glob-valid');
    expect(filesGate).toMatchObject({ status: 'warn' });
    expect(filesGate?.reason).toMatch(/match nothing/);
  });

  it('warns when Risk=mechanical lists >5 files', () => {
    const issuePath = writeIssue(
      'happy-feature',
      '94-mechanical-many-files.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- a.ts',
          '- b.ts',
          '- c.ts',
          '- d.ts',
          '- e.ts',
          '- f.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    const riskGate = result.gates.find(
      (g) => g.name === 'risk-file-count-consistent',
    );
    expect(riskGate).toMatchObject({ status: 'warn' });
    expect(result.overall).toBe('PASS');
  });
});

describe('validateIssue — blocked-by resolves to issues/ and done/', () => {
  it('resolves a same-slug blocker living in issues/', () => {
    writeIssue(
      'feature-x',
      '01-blocker.md',
      '# 01 — Blocker\n\n**Status:** ready-for-agent\n',
    );
    const issuePath = writeIssue(
      'feature-x',
      '02-blocked.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- some/path.ts',
          '**Blocked by:** #01',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(
      result.gates.find((g) => g.name === 'blocked-by-chain-resolves'),
    ).toMatchObject({
      status: 'pass',
    });
  });

  it('resolves a same-slug blocker living in issues/done/', () => {
    writeDoneIssue(
      'feature-y',
      '01-archived.md',
      '# 01 — Archived\n\n**Status:** done\n',
    );
    const issuePath = writeIssue(
      'feature-y',
      '02-blocked.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- some/path.ts',
          '**Blocked by:** #01',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(
      result.gates.find((g) => g.name === 'blocked-by-chain-resolves'),
    ).toMatchObject({
      status: 'pass',
    });
  });

  it('resolves a cross-slug blocker', () => {
    writeIssue(
      'other-feature',
      '03-cross.md',
      '# 03 — Cross\n\n**Status:** ready-for-agent\n',
    );
    const issuePath = writeIssue(
      'feature-z',
      '02-blocked.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- some/path.ts',
          '**Blocked by:** other-feature#03',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(
      result.gates.find((g) => g.name === 'blocked-by-chain-resolves'),
    ).toMatchObject({
      status: 'pass',
    });
  });
});

// ─── Gate 6: acFilesCoverageCheck unit tests ──────────────────────────────────

/** Minimal HeaderBlock for gate-6 unit tests. */
function makeHeader(files: string[]): HeaderBlock {
  return {
    risk: 'mechanical',
    worker: 'background',
    files,
    blockedBy: 'none',
  };
}

describe('acFilesCoverageCheck — path detection forms', () => {
  it('detects backtick-wrapped path not in Files: and emits warn', () => {
    const acBody = `
- [ ] Update \`docs/agents/wave-playbook.md\` to document the new behaviour
- [ ] Tests pass
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['.husky/pre-commit']),
      acBody,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe('warn');
    expect(warns[0].message).toContain('docs/agents/wave-playbook.md');
    expect(warns[0].suggestions).toContain('docs/agents/wave-playbook.md');
  });

  it('detects markdown-link path not in Files: and emits warn', () => {
    const acBody = `
- [ ] See [playbook](docs/agents/wave-playbook.md) for reference
- [ ] Tests pass
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['.husky/pre-commit']),
      acBody,
    );
    expect(
      warns.some((w) => w.suggestions.includes('docs/agents/wave-playbook.md')),
    ).toBe(true);
  });

  it('detects bare path not in Files: and emits warn', () => {
    const acBody = `
- [ ] Rename docs/agents/wave-playbook.md to the new location
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['.husky/pre-commit']),
      acBody,
    );
    expect(
      warns.some((w) => w.suggestions.includes('docs/agents/wave-playbook.md')),
    ).toBe(true);
  });
});

describe('acFilesCoverageCheck — coverage matching', () => {
  it('emits no warn when the mentioned path IS covered by a Files: entry', () => {
    const acBody = `
- [ ] Update \`docs/agents/wave-playbook.md\` with the new hook contract
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['docs/agents/wave-playbook.md']),
      acBody,
    );
    expect(warns).toHaveLength(0);
  });

  it('emits no warn when the mentioned path is covered by a glob', () => {
    const acBody = `
- [ ] Update \`tools/wave/src/cli.ts\` to add the dor subcommand
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['tools/wave/src/*.ts']),
      acBody,
    );
    expect(warns).toHaveLength(0);
  });

  it('emits no warn when there are no file mentions in AC body', () => {
    const acBody = `
- [ ] The feature works as described
- [ ] Tests are green
- [ ] Code review complete
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['some/file.ts']),
      acBody,
    );
    expect(warns).toHaveLength(0);
  });

  it('narrative-only mention still emits a warn (acceptable false positive)', () => {
    const acBody = `
- [ ] See \`docs/CONTENT.md\` for context on how this fits the architecture
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['tools/wave/src/cli.ts']),
      acBody,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('docs/CONTENT.md');
  });
});

describe('acFilesCoverageCheck — warn message shape', () => {
  it('includes truncated bullet text (≤80 chars) in the message', () => {
    const longBullet = `Update \`docs/agents/wave-playbook.md\` by adding a very long description that goes well beyond the 80-character limit for display purposes`;
    const acBody = `- [ ] ${longBullet}\n`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['.husky/pre-commit']),
      acBody,
    );
    expect(warns.length).toBeGreaterThan(0);
    // The snippet in the message should be capped at 80 chars (plus "...")
    const snippetMatch = warns[0].message.match(/AC bullet: "([^"]+)"/);
    expect(snippetMatch).not.toBeNull();
    expect((snippetMatch?.[1] ?? '').length).toBeLessThanOrEqual(80);
  });
});

describe('validateIssue — gate 6 integration', () => {
  it('gate ac-files-coverage warns when AC mentions uncovered path', () => {
    const source = [
      '# 80 — Gate6 test',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- .husky/pre-commit',
      '**Blocked by:** none',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Update `docs/agents/wave-playbook.md` to note the relaxation',
    ].join('\n');

    const issuePath = writeIssue('gate6-feature', '80-gate6.md', source);
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source,
    });

    expect(result.overall).toBe('PASS'); // warns don't fail overall
    const gate6 = result.gates.find((g) => g.name === 'ac-files-coverage');
    expect(gate6).toMatchObject({ status: 'warn' });
    expect(gate6?.reason).toContain('docs/agents/wave-playbook.md');
  });

  it('gate ac-files-coverage passes when AC mentions only covered paths', () => {
    const source = [
      '# 81 — Gate6 clean test',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- docs/agents/wave-playbook.md',
      '- .husky/pre-commit',
      '**Blocked by:** none',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Update `docs/agents/wave-playbook.md` to note the relaxation',
      '- [ ] Relax `.husky/pre-commit` check on wave-orch branches',
    ].join('\n');

    const issuePath = writeIssue('gate6-feature', '81-gate6-clean.md', source);
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source,
    });

    const gate6 = result.gates.find((g) => g.name === 'ac-files-coverage');
    expect(gate6).toMatchObject({ status: 'pass' });
  });
});

// ─── Refinement 1: npm-script → package.json coverage ────────────────────────

describe('acFilesCoverageCheck — Refinement 1: npm-script → package.json warn', () => {
  it('warns when AC mentions `npm run <script>` and package.json absent from Files:', () => {
    // Mirrors cag/13 AC #4: "Hook test added and wired into `npm run test:hooks`"
    const acBody = `
- [x] Hook denies (exit 2) for Write and Edit.
- [x] Hook test added and wired into \`npm run test:hooks\`.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['.claude/hooks/guard-r16.sh', 'scripts/guard-r16.test.sh']),
      acBody,
    );
    const pkgWarn = warns.find((w) => w.suggestions.includes('package.json'));
    expect(pkgWarn).toBeDefined();
    expect(pkgWarn?.level).toBe('warn');
    expect(pkgWarn?.message).toContain('package.json');
  });

  it('warns when AC prose says "wired into npm run"', () => {
    const acBody = `
- [ ] New check wired into npm run lint:all.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['tools/wave/src/check.ts']),
      acBody,
    );
    expect(warns.some((w) => w.suggestions.includes('package.json'))).toBe(
      true,
    );
  });

  it('does NOT warn when package.json IS declared in Files:', () => {
    // Mirrors wo/67: package.json is in Files: → no warn
    const acBody = `
- [x] \`@types/micromatch\` added to \`devDependencies\`; \`package-lock.json\` updated via \`npm install\`.
- [x] \`nx run wave-tools:test\` stays green.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['package.json', 'package-lock.json']),
      acBody,
    );
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('does NOT warn when no AC bullet references an npm script', () => {
    const acBody = `
- [ ] The feature works as described.
- [ ] Tests are green.
- [ ] Update \`docs/agents/wave-playbook.md\` link.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['docs/agents/wave-playbook.md']),
      acBody,
    );
    // Should not introduce a package.json warn on ordinary ACs
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });
});

// ─── W25-F3: run-only gate ACs vs. change ACs ─────────────────────────────────

describe('acFilesCoverageCheck — run-only ACs are gates, not change surfaces (W25-F3)', () => {
  it('does NOT warn on the standard verify-floor AC (npm test / npm run typecheck, no change-verb)', () => {
    // The literal wave-eligible verify-floor AC text — no repo file is a
    // change target, `package.json` is never touched by running the scripts.
    const acBody = `
- [ ] Engine floor green: npm test and npm run typecheck clean from tools/wave/.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['tools/wave/src/dor-gate.ts', 'tools/wave/src/dor-gate.spec.ts']),
      acBody,
    );
    expect(warns).toHaveLength(0);
  });

  it('does NOT warn on a bare `npm run <script>` mention with no change-verb', () => {
    const acBody = `
- [ ] \`npm run lint\` passes clean.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/index.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('does NOT warn on a bare `npx`/CLI invocation with no change-verb', () => {
    const acBody = `
- [ ] \`npx tsc --noEmit\` reports zero errors.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/index.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('still warns (change class, byte-for-byte unchanged) when a change-verb pairs npm run with the script', () => {
    // Regression guard: the two pre-existing Refinement-1 "warns" tests above
    // (wire(d) into npm run <name>) must keep firing — this is the class the
    // heuristic exists for, distinct from the run-only class above.
    const acBody = `
- [ ] New hook wired into \`npm run precommit\`.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['scripts/hook.sh']), acBody);
    expect(warns.some((w) => w.suggestions.includes('package.json'))).toBe(true);
  });

  it('boundary: run-only command + uncovered changed file in the same bullet — file half still warns, package.json half does not', () => {
    const acBody = `
- [ ] \`npm run typecheck\` passes and \`src/new-thing.ts\` implements the parser.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/other.ts']), acBody);
    // No package.json warn — the npm run mention is run-only, no change-verb attached.
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
    // But the concrete changed file is still uncovered — the file half keeps warning.
    expect(warns.some((w) => w.suggestions.includes('src/new-thing.ts'))).toBe(
      true,
    );
  });

  it('does NOT warn when an unrelated earlier add verb pairs with a later, unrelated run-only npm run mention (iteration-2 repro 1)', () => {
    // Live repro from the reviewer: "Add" here is the change-verb for the
    // empty-input-handling clause, not for the npm run mention that follows
    // in a separate clause. An unbounded word-gap wrongly paired the two.
    const acBody = `
- [ ] Add error handling for the empty-input case; npm run test stays green.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/index.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('does NOT warn when an add verb is followed by run-only npm mentions many words later in the same bullet (iteration-2 repro 2)', () => {
    // Live repro from the reviewer: "Add retry handling to the fetcher" is
    // the change clause; "npm test and npm run typecheck clean from
    // tools/wave/" is the standard run-only verify-floor gate tacked on
    // after a colon. The two must not pair up.
    const acBody = `
- [ ] Add retry handling to the fetcher: npm test and npm run typecheck clean from tools/wave/.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/fetcher.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('does NOT warn when an unrelated earlier wire(d) verb pairs with a later, unrelated run-only npm run mention (iteration-3 repro 1, W26-F3)', () => {
    // Mirrors iteration-2 repro 1, but for the `wire(d) into/in` pattern:
    // "Wired into" here is the change-verb clause for the retry-handler
    // change, not for the npm run mention that follows in a separate
    // clause. An unbounded word-gap wrongly paired the two.
    const acBody = `
- [ ] Wired into the retry handler for the empty-input case; npm run test stays green.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/index.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('does NOT warn when a wire(d) verb is followed by run-only npm mentions many words later in the same bullet (iteration-3 repro 2, W26-F3)', () => {
    // Mirrors iteration-2 repro 2, but for the `wire(d) into/in` pattern:
    // "Wired into the retry-path handler already reviewed" is the change
    // clause; "npm test and npm run typecheck clean from tools/wave/" is
    // the standard run-only verify-floor gate tacked on after a colon. The
    // two must not pair up.
    const acBody = `
- [ ] Wired into the retry-path handler already reviewed: npm test and npm run typecheck clean from tools/wave/.
`;
    const warns = acFilesCoverageCheck('', makeHeader(['src/index.ts']), acBody);
    expect(
      warns.filter((w) => w.suggestions.includes('package.json')),
    ).toHaveLength(0);
  });

  it('full gate: the standard verify-floor AC passes ac-files-coverage warn-free with package.json absent from Files:', () => {
    const source = [
      '# 82 — Verify-floor AC gate test',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- tools/wave/src/dor-gate.ts',
      '- tools/wave/src/dor-gate.spec.ts',
      '**Blocked by:** none',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Engine floor green: npm test and npm run typecheck clean from tools/wave/.',
    ].join('\n');

    const issuePath = writeIssue('gate6-verify-floor', '82-verify-floor.md', source);
    const result = validateIssue({ repoRoot: root, issuePath, source });

    const gate6 = result.gates.find((g) => g.name === 'ac-files-coverage');
    expect(gate6).toMatchObject({ status: 'pass' });
  });
});

// ─── Refinement 2: basename↔fullpath false-positive fix ───────────────────────

describe('acFilesCoverageCheck — Refinement 2: basename↔fullpath false-positive', () => {
  it('does NOT warn when AC mentions bare basename covered by full-path Files: entry', () => {
    // Mirrors cag/20 AC #1: "The 3 file-path links … in `wave-playbook.md` resolve …"
    // Files: has docs/agents/wave-playbook.md → should be covered, no warn.
    const acBody = `
- [ ] The 3 file-path links in \`wave-playbook.md\` resolve to their current paths.
- [ ] \`scripts/check-doc-links.sh\` exits 0.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader([
        'docs/agents/wave-playbook.md',
        'scripts/check-doc-links.sh',
      ]),
      acBody,
    );
    // wave-playbook.md basename covered by full-path entry — no spurious warn
    expect(
      warns.filter((w) => w.suggestions.includes('wave-playbook.md')),
    ).toHaveLength(0);
    // check-doc-links.sh also matched exactly — no warn
    expect(
      warns.filter((w) => w.suggestions.includes('scripts/check-doc-links.sh')),
    ).toHaveLength(0);
  });

  it('still warns when basename matches NO Files: entry (true-positive preserved)', () => {
    // AC mentions a file whose basename does not appear in Files: at all
    const acBody = `
- [ ] Update \`docs/agents/domain.md\` with new details.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['docs/agents/wave-playbook.md']),
      acBody,
    );
    // domain.md has a different basename → still warns (true-positive)
    expect(
      warns.some((w) => w.suggestions.includes('docs/agents/domain.md')),
    ).toBe(true);
  });

  it('resolves covered even when same basename appears in multiple Files: entries', () => {
    // Common basename (e.g. index.ts) in multiple Files: entries → still covered
    const acBody = `
- [ ] Update \`index.ts\` exports.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader([
        'libs/example-ds/src/index.ts',
        'libs/features/shared/src/index.ts',
      ]),
      acBody,
    );
    // Should suppress the false-positive (covered via basename match), not warn
    expect(
      warns.filter((w) => w.suggestions.includes('index.ts')),
    ).toHaveLength(0);
  });

  it('emits no warn for full-path-matching existing coverage (regression guard)', () => {
    // Ensure the basename fallback does not break the existing exact-match path
    const acBody = `
- [ ] Update \`docs/agents/wave-playbook.md\` with the new contract.
`;
    const warns = acFilesCoverageCheck(
      '',
      makeHeader(['docs/agents/wave-playbook.md']),
      acBody,
    );
    expect(warns).toHaveLength(0);
  });
});

// ─── Gate 7: literal-files-exist advisory check ──────────────────────────────

describe('validateIssue — literal-files-exist advisory (gate 7)', () => {
  it('warns (does not fail) when a literal Files: entry does not exist on disk', () => {
    // Deliberately do NOT create the file referenced in Files:
    const issuePath = writeIssue(
      'literal-check-feature',
      '90-missing-literal.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- docs/adr/0016-real-browser-testing-strategy.md',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('PASS'); // advisory only — does not fail
    const gate7 = result.gates.find((g) => g.name === 'literal-files-exist');
    expect(gate7).toMatchObject({ status: 'warn' });
    expect(gate7?.reason).toContain(
      'docs/adr/0016-real-browser-testing-strategy.md',
    );
    expect(gate7?.reason).toContain('renamed or typo');
  });

  it('does not warn when a literal Files: entry exists on disk', () => {
    writeRealFile('docs/adr/0016-real-browser-test-layer.md');
    const issuePath = writeIssue(
      'literal-check-feature',
      '89-existing-literal.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- docs/adr/0016-real-browser-test-layer.md',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('PASS');
    const gate7 = result.gates.find((g) => g.name === 'literal-files-exist');
    expect(gate7).toMatchObject({ status: 'pass' });
  });

  it('does not warn for a zero-match glob (glob entries are skipped)', () => {
    // Existing literal exists; glob matches nothing — gate 7 must still pass
    writeRealFile('tools/wave/src/dor-gate.ts');
    const issuePath = writeIssue(
      'literal-check-feature',
      '88-glob-no-warn.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- tools/wave/src/dor-gate.ts',
          '- libs/features/tasks/*/strings.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('PASS');
    const gate7 = result.gates.find((g) => g.name === 'literal-files-exist');
    // Glob entry must not contribute a warn to gate 7
    expect(gate7).toMatchObject({ status: 'pass' });
  });
});

// ─── Gate 8: verify-profile-coverage advisory check (#127) ────────────────

describe('validateIssue — verify-profile-coverage advisory (gate 8)', () => {
  it('defers when no verify config is supplied to this call (capability gap, not a claim about the row)', () => {
    const issuePath = writeIssue(
      'verify-coverage-feature',
      '70-no-verify-config.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- apps/web/src/thing.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
    });
    expect(result.overall).toBe('PASS');
    const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
    expect(gate8).toMatchObject({ status: 'deferred' });
    // issue #676: this is the "genuinely absent" case — `verify` was never
    // even supplied to this call — and the text must name the flag that
    // would resolve it, distinct from the loaded-but-empty pass case below.
    expect(gate8?.reason).toMatch(/No verify config reached this check/);
    expect(gate8?.reason).toMatch(/--config/);
    expect(gate8?.reason).not.toMatch(/declares no profiles/);
  });

  it('does NOT warn (AC4) when the consumer has zero verify profiles configured at all — a legitimately doc-only row', () => {
    const issuePath = writeIssue(
      'verify-coverage-feature',
      '71-doc-only-no-profiles.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- docs/some-doc.md',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
      verify: { profiles: [] },
    });
    expect(result.overall).toBe('PASS');
    const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
    expect(gate8).toMatchObject({ status: 'pass' });
    // issue #676: a config that DID reach this call and declares zero
    // profiles carries a note distinguishing it from the deferred,
    // never-reached-this-call case above — chosen status: pass-with-a-note.
    expect(gate8?.reason).toMatch(/declares no profiles/);
    expect(gate8?.reason).not.toMatch(/No verify config reached this check/);
  });

  it('passes when the row\'s declared files match a configured verify profile', () => {
    writeRealFile('apps/web/src/matched-thing.ts');
    const issuePath = writeIssue(
      'verify-coverage-feature',
      '72-matched.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- apps/web/src/matched-thing.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
      verify: {
        profiles: [
          { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          { name: 'cms', appliesTo: ['cms/**'], commands: [{ command: 'composer test' }] },
        ],
      },
    });
    expect(result.overall).toBe('PASS');
    const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
    expect(gate8).toMatchObject({ status: 'pass' });
  });

  it('warns (does not fail) when the row\'s declared files match no configured verify profile — the #83-shaped bug this gate exists to close', () => {
    writeRealFile('apps/ios/src/only-ios-thing.ts');
    const issuePath = writeIssue(
      'verify-coverage-feature',
      '73-unmatched.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- apps/ios/src/only-ios-thing.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
      verify: {
        profiles: [
          { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          { name: 'cms', appliesTo: ['cms/**'], commands: [{ command: 'composer test' }] },
          { name: 'android', appliesTo: ['apps/android/**'], commands: [{ command: 'gradle test' }] },
        ],
      },
    });
    // Advisory only — never fails overall, and the row stays dispatchable (AC2).
    expect(result.overall).toBe('PASS');
    const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
    expect(gate8).toMatchObject({ status: 'warn' });
    expect(gate8?.reason).toContain('apps/ios/src/only-ios-thing.ts');
    expect(gate8?.reason).toMatch(/web, cms, android/);
  });

  it('resolves a glob Files: entry against the repo tree before testing profile coverage', () => {
    writeRealFile('apps/web/src/glob-a.ts');
    writeRealFile('apps/web/src/glob-b.ts');
    const issuePath = writeIssue(
      'verify-coverage-feature',
      '74-glob-matched.md',
      ISSUE_FIXTURE_BODY(
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- apps/web/src/*.ts',
          '**Blocked by:** none',
        ].join('\n'),
      ),
    );
    const result = validateIssue({
      repoRoot: root,
      issuePath,
      source: require('node:fs').readFileSync(issuePath, 'utf-8'),
      verify: {
        profiles: [
          { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
        ],
      },
    });
    const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
    expect(gate8).toMatchObject({ status: 'pass' });
  });

  // ── issue #711: the PARTIAL-coverage case — some declared files match a
  // profile, some don't. Before this fix, `commands.length > 0` (true because
  // at least one file matched) short-circuited straight to `pass`, so the
  // uncovered half was silently indistinguishable from a fully verify-backed
  // approve. This is the reported shape: a row split between covered package
  // sources and uncovered application targets.

  it(
    'passes — no reason, byte-identical to the full-coverage case above — when EVERY declared ' +
      'file matches at least one profile (issue #711 AC1, negative control)',
    () => {
      writeRealFile('apps/web/src/full-a.ts');
      writeRealFile('apps/web/src/full-b.ts');
      const issuePath = writeIssue(
        'verify-coverage-feature',
        '75-full-coverage.md',
        ISSUE_FIXTURE_BODY(
          [
            '**Risk:** mechanical',
            '**Worker:** background',
            '**Files:**',
            '- apps/web/src/full-a.ts',
            '- apps/web/src/full-b.ts',
            '**Blocked by:** none',
          ].join('\n'),
        ),
      );
      const result = validateIssue({
        repoRoot: root,
        issuePath,
        source: require('node:fs').readFileSync(issuePath, 'utf-8'),
        verify: {
          profiles: [
            { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          ],
        },
      });
      const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
      // Byte-identical to the plain pre-#711 pass shape: status only, no reason.
      expect(gate8).toStrictEqual({ name: 'verify-profile-coverage', status: 'pass' });
    },
  );

  it(
    'warns — naming the uncovered files verbatim and the profile(s) that DID match — when SOME ' +
      'but not all declared files match a configured profile (issue #711 AC2, the partial case)',
    () => {
      writeRealFile('apps/web/src/covered.ts');
      writeRealFile('apps/ios/src/uncovered.ts');
      const issuePath = writeIssue(
        'verify-coverage-feature',
        '76-partial-coverage.md',
        ISSUE_FIXTURE_BODY(
          [
            '**Risk:** mechanical',
            '**Worker:** background',
            '**Files:**',
            '- apps/web/src/covered.ts',
            '- apps/ios/src/uncovered.ts',
            '**Blocked by:** none',
          ].join('\n'),
        ),
      );
      const result = validateIssue({
        repoRoot: root,
        issuePath,
        source: require('node:fs').readFileSync(issuePath, 'utf-8'),
        verify: {
          profiles: [
            { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
            { name: 'android', appliesTo: ['apps/android/**'], commands: [{ command: 'gradle test' }] },
          ],
        },
      });
      // Advisory only — a partial gap still never fails the row (AC2 policy unchanged).
      expect(result.overall).toBe('PASS');
      const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
      expect(gate8).toMatchObject({ status: 'warn' });
      // Uncovered file named verbatim.
      expect(gate8?.reason).toContain('apps/ios/src/uncovered.ts');
      // Covered file is NOT listed among the uncovered ones.
      expect(gate8?.reason).not.toMatch(/uncovered.*covered\.ts/);
      // The profile that DID match is named ('web'); the one that never matched
      // anything on this row ('android') is not claimed as a match.
      expect(gate8?.reason).toMatch(/\bweb\b/);
      expect(gate8?.reason).not.toMatch(/\bandroid\b/);
      // States the covered/inspection-only split explicitly.
      expect(gate8?.reason).toMatch(/verify-backed only for the covered files/);
      expect(gate8?.reason).toMatch(/inspection-only/);
    },
  );

  it(
    'keeps the all-uncovered warn text UNCHANGED (byte-identical) when the row was already ' +
      'covered by the pre-#711 fully-uncovered test above',
    () => {
      writeRealFile('apps/ios/src/still-only-ios.ts');
      const issuePath = writeIssue(
        'verify-coverage-feature',
        '77-still-all-uncovered.md',
        ISSUE_FIXTURE_BODY(
          [
            '**Risk:** mechanical',
            '**Worker:** background',
            '**Files:**',
            '- apps/ios/src/still-only-ios.ts',
            '**Blocked by:** none',
          ].join('\n'),
        ),
      );
      const verify: VerifyConfig = {
        profiles: [
          { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          { name: 'cms', appliesTo: ['cms/**'], commands: [{ command: 'composer test' }] },
          { name: 'android', appliesTo: ['apps/android/**'], commands: [{ command: 'gradle test' }] },
        ],
      };
      const result = validateIssue({
        repoRoot: root,
        issuePath,
        source: require('node:fs').readFileSync(issuePath, 'utf-8'),
        verify,
      });
      const gate8 = result.gates.find((g) => g.name === 'verify-profile-coverage');
      expect(gate8).toStrictEqual({
        name: 'verify-profile-coverage',
        status: 'warn',
        reason:
          'Declared files (apps/ios/src/still-only-ios.ts) match no configured verify profile ' +
          '(web, cms, android) — this row has no automated build/test gate behind it. ' +
          'An approve here is inspection-only, not verify-backed: state that ' +
          'explicitly in the Worker/Reviewer brief rather than letting it read the ' +
          'same as a row a full verify run actually backed.',
      });
    },
  );
});

describe('validateIssueView — verify-profile-coverage advisory (gate 8, structured path)', () => {
  it('defers when verify is absent even though a repoRoot is supplied', () => {
    const result = validateIssueView(buildView({ files: ['apps/web/src/x.ts'] }), {
      repoRoot: root,
    });
    expect(gate(result, 'verify-profile-coverage').status).toBe('deferred');
  });

  it('defers when verify is supplied but repoRoot is absent — cannot expand globs to determine overlap', () => {
    const result = validateIssueView(buildView({ files: ['apps/web/src/x.ts'] }), {
      verify: {
        profiles: [{ name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] }],
      },
    });
    expect(gate(result, 'verify-profile-coverage').status).toBe('deferred');
  });

  it('does NOT warn when the consumer configured zero verify profiles at all (AC4)', () => {
    const result = validateIssueView(buildView({ files: ['docs/only-a-doc.md'] }), {
      repoRoot: root,
      verify: { profiles: [] },
    });
    expect(gate(result, 'verify-profile-coverage').status).toBe('pass');
  });

  it('warns when files+repoRoot+verify are all present and no profile matches', () => {
    writeRealFile('apps/ios/src/only-ios.ts');
    const result = validateIssueView(
      buildView({ files: ['apps/ios/src/only-ios.ts'] }),
      {
        repoRoot: root,
        verify: {
          profiles: [
            { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          ],
        },
      },
    );
    expect(gate(result, 'verify-profile-coverage').status).toBe('warn');
    expect(result.overall).toBe('PASS');
  });

  it('passes when files+repoRoot+verify are all present and a profile matches', () => {
    writeRealFile('apps/web/src/matched-view.ts');
    const result = validateIssueView(
      buildView({ files: ['apps/web/src/matched-view.ts'] }),
      {
        repoRoot: root,
        verify: {
          profiles: [
            { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
          ],
        },
      },
    );
    expect(gate(result, 'verify-profile-coverage').status).toBe('pass');
  });

  // issue #711 — the partial case reaches the structured (non-file) path too.
  it(
    'warns — naming the uncovered file(s) — when only SOME of the view\'s declared files match a ' +
      'configured profile',
    () => {
      writeRealFile('apps/web/src/view-covered.ts');
      writeRealFile('apps/ios/src/view-uncovered.ts');
      const result = validateIssueView(
        buildView({ files: ['apps/web/src/view-covered.ts', 'apps/ios/src/view-uncovered.ts'] }),
        {
          repoRoot: root,
          verify: {
            profiles: [
              { name: 'web', appliesTo: ['apps/web/**'], commands: [{ command: 'npm test' }] },
            ],
          },
        },
      );
      const gate8 = gate(result, 'verify-profile-coverage');
      expect(gate8.status).toBe('warn');
      expect(gate8.reason).toContain('apps/ios/src/view-uncovered.ts');
      expect(gate8.reason).toMatch(/\bweb\b/);
      expect(result.overall).toBe('PASS');
    },
  );
});

describe('extractAcBody', () => {
  it('returns null when no AC section exists', () => {
    expect(extractAcBody('# Title\n\nNo AC here.')).toBeNull();
  });

  it('extracts content between AC header and next section', () => {
    const source = [
      '## Acceptance criteria',
      '',
      '- [ ] First AC',
      '- [ ] Second AC',
      '',
      '## Out of scope',
      '',
      'Should not appear.',
    ].join('\n');
    const body = extractAcBody(source);
    expect(body).toContain('First AC');
    expect(body).not.toContain('Out of scope');
  });

  it('extracts content to end of file when AC is the last section', () => {
    const source = '## Acceptance criteria\n\n- [ ] Only AC\n';
    const body = extractAcBody(source);
    expect(body).toContain('Only AC');
  });
});

// ─── validateIssueView — the non-file / structured entrypoint (ADR-0014) ─────

function buildView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    id: '42',
    risk: 'isolated-refactor',
    worker: 'background',
    files: ['src/foo.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'foo refactored', checked: false }],
    status: 'available',
    ...overrides,
  };
}

function gate(result: DorResult, name: string): GateResult {
  const g = result.gates.find((x) => x.name === name);
  if (!g) throw new Error(`gate "${name}" not present in result`);
  return g;
}

/** Gate 10's one spelling, pinned here the same way {@link STALENESS_GATE_NAME} is. */
const PR_TITLE_GATE_NAME = 'pr-title-id-independent';

/**
 * The nine gate names that shipped before Gate 10, in emission order. Kept as
 * its own constant so the additivity test below can assert them as a PREFIX of
 * the live roster rather than re-listing them.
 */
const GATE_NAMES_BEFORE_PR_TITLE = [
  'header-parseable',
  'files-glob-valid',
  'ac-section-consistent',
  'risk-file-count-consistent',
  'blocked-by-chain-resolves',
  'ac-files-coverage',
  'literal-files-exist',
  'verify-profile-coverage',
  'files-touched-since-tracker-update',
];

/** The full roster both entrypoints emit, in order. */
const CANONICAL_GATE_NAMES = [
  ...GATE_NAMES_BEFORE_PR_TITLE,
  PR_TITLE_GATE_NAME,
];

describe('validateIssueView (non-file / structured entrypoint)', () => {
  it('passes a well-formed view and defers the working-tree + cross-issue gates when no repoRoot is given', () => {
    const result = validateIssueView(buildView());

    expect(result.overall).toBe('PASS');
    // self-content gates run on the structured fields
    expect(gate(result, 'header-parseable').status).toBe('pass');
    expect(gate(result, 'risk-file-count-consistent').status).toBe('pass');
    // working-tree gates defer (no checkout present)
    expect(gate(result, 'files-glob-valid').status).toBe('deferred');
    expect(gate(result, 'literal-files-exist').status).toBe('deferred');
    // cross-issue gate defers when the caller supplied no blocker reading
    expect(gate(result, 'blocked-by-chain-resolves').status).toBe('deferred');
  });

  it('fails header-parseable when worker is outside the configured vocabulary', () => {
    // 'background-sonnet' is the retired Ur value — no longer in the default set
    const result = validateIssueView(buildView({ worker: 'background-sonnet' }));

    expect(result.overall).toBe('FAIL');
    expect(gate(result, 'header-parseable').status).toBe('fail');
    expect(gate(result, 'header-parseable').reason).toContain('background-sonnet');
  });

  it('fails header-parseable when risk is outside the configured vocabulary', () => {
    const result = validateIssueView(buildView({ risk: 'catastrophic' }));

    expect(result.overall).toBe('FAIL');
    expect(gate(result, 'header-parseable').status).toBe('fail');
  });

  it('warns risk-file-count when a mechanical view lists more than five files', () => {
    const result = validateIssueView(
      buildView({
        risk: 'mechanical',
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      }),
    );

    expect(gate(result, 'risk-file-count-consistent').status).toBe('warn');
    expect(result.overall).toBe('PASS'); // warn never blocks
  });

  it('warns ac-files-coverage when an AC bullet names a path absent from files (acBody rebuilt from the structured array)', () => {
    const result = validateIssueView(
      buildView({
        files: ['src/foo.ts'],
        acceptanceCriteria: [
          { text: 'wire `src/unlisted.ts` into the module', checked: false },
        ],
      }),
    );

    expect(gate(result, 'ac-files-coverage').status).toBe('warn');
    expect(gate(result, 'ac-files-coverage').reason).toContain('src/unlisted.ts');
    expect(result.overall).toBe('PASS');
  });

  it('passes ac-files-coverage when every AC path mention is covered by files', () => {
    const result = validateIssueView(
      buildView({
        files: ['src/foo.ts'],
        acceptanceCriteria: [
          { text: 'update `src/foo.ts` behaviour', checked: false },
        ],
      }),
    );

    expect(gate(result, 'ac-files-coverage').status).toBe('pass');
  });

  it('warns ac-section when the view carries no acceptance criteria', () => {
    const result = validateIssueView(buildView({ acceptanceCriteria: [] }));

    expect(gate(result, 'ac-section-consistent').status).toBe('warn');
    expect(result.overall).toBe('PASS');
  });

  it('warns ac-section when an acceptance criterion has empty text', () => {
    const result = validateIssueView(
      buildView({ acceptanceCriteria: [{ text: '   ', checked: false }] }),
    );

    expect(gate(result, 'ac-section-consistent').status).toBe('warn');
  });

  it('passes ac-section when criteria are present and non-empty', () => {
    const result = validateIssueView(buildView());

    expect(gate(result, 'ac-section-consistent').status).toBe('pass');
  });

  it('runs the working-tree gates against a supplied repoRoot instead of deferring (capability-conditional)', () => {
    writeRealFile('src/real.ts');
    const result = validateIssueView(buildView({ files: ['src/real.ts'] }), {
      repoRoot: root,
    });

    expect(gate(result, 'files-glob-valid').status).toBe('pass');
    expect(gate(result, 'literal-files-exist').status).toBe('pass');
    // cross-issue gate still defers even with a checkout — it is not a
    // working-tree gate, and `repoRoot` is not its capability (issue #750)
    expect(gate(result, 'blocked-by-chain-resolves').status).toBe('deferred');
  });

  it('warns literal-files-exist when a declared file is missing from the supplied repoRoot', () => {
    const result = validateIssueView(buildView({ files: ['src/ghost.ts'] }), {
      repoRoot: root,
    });

    expect(gate(result, 'literal-files-exist').status).toBe('warn');
    expect(result.overall).toBe('PASS');
  });

  it('emits all ten canonical gates in the same order as the file path (no silent omission)', () => {
    const names = validateIssueView(buildView()).gates.map((g) => g.name);

    expect(names).toEqual(CANONICAL_GATE_NAMES);
  });

  it('the tenth gate is ADDITIVE — the nine that shipped before it are all still emitted, in order', () => {
    // The roster is the package's contract surface: a consumer reading
    // `dor --json` matches these names literally. Pinning the pre-existing
    // nine as a PREFIX is what makes "additive" checkable — a rename or a
    // reorder of any of them fails here even though the array above would
    // simply be edited to match.
    const names = validateIssueView(buildView()).gates.map((g) => g.name);

    expect(names.slice(0, GATE_NAMES_BEFORE_PR_TITLE.length)).toEqual(
      GATE_NAMES_BEFORE_PR_TITLE,
    );
    expect(names).toContain(PR_TITLE_GATE_NAME);
    expect(names).toHaveLength(GATE_NAMES_BEFORE_PR_TITLE.length + 1);
  });

  it('never lets a warn or deferred gate flip overall to FAIL', () => {
    // mechanical+6 files (gate-4 warn) + no repoRoot (gates 2/5/7 deferred)
    const result = validateIssueView(
      buildView({
        risk: 'mechanical',
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      }),
    );

    expect(result.gates.some((g) => g.status === 'warn')).toBe(true);
    expect(result.gates.some((g) => g.status === 'deferred')).toBe(true);
    expect(result.gates.some((g) => g.status === 'fail')).toBe(false);
    expect(result.overall).toBe('PASS');
  });
});

// ─── Gate 5 — the cross-issue gate, re-homed onto a caller capability ────────
//
// The defect (issue #750): on the structured path this gate was PUSHED as
// `deferred` with a fixed reason before any input was looked at, so a row whose
// declared blocker was still open sailed through the readiness check and the
// hold that exists precisely for that case never fired.
//
// These cases drive the PURE gate — the CLI wiring that actually reads a tracker
// lives in cli.spec.ts. Four answers are pinned here, and the third and fourth
// are the ones that carry the defect: an open blocker must FAIL, and a ref
// nobody could resolve must DEFER rather than counterfeit a pass.

const BLOCKED_GATE = 'blocked-by-chain-resolves';

describe('Gate 5 — blocked-by-chain-resolves on the structured path', () => {
  it('defers with the no-capability reason when no blocker reading is supplied', () => {
    // AC1 — the pure-function form is unchanged for every existing caller. The
    // view DECLARES a blocker here, which is the sharper case: even with refs on
    // the row, a caller that supplied no resolution gets the deferral, never a
    // guess.
    const result = validateIssueView(buildView({ blockedBy: [{ issue: 41 }] }));

    expect(gate(result, BLOCKED_GATE).status).toBe('deferred');
    expect(gate(result, BLOCKED_GATE).reason).toMatch(
      /no blocked-by resolution reached this check/i,
    );
    expect(result.overall).toBe('PASS');
  });

  it('passes a row declaring no blockers once the capability is present', () => {
    // An EMPTY array is a capability, not an absence: the gate branches on
    // presence, so `Blocked by: none` + `[]` is the answer the file path
    // already gives (`pass`), not another deferral.
    const result = validateIssueView(buildView({ blockedBy: 'none' }), {
      blockerResolutions: [],
    });

    expect(gate(result, BLOCKED_GATE).status).toBe('pass');
  });

  it('passes when every declared blocker resolved CLOSED', () => {
    const result = validateIssueView(
      buildView({ blockedBy: [{ issue: 41 }, { issue: 7 }] }),
      {
        blockerResolutions: [
          { ref: { issue: 41 }, state: 'closed' },
          { ref: { issue: 7 }, state: 'closed' },
        ],
      },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('pass');
    expect(result.overall).toBe('PASS');
  });

  it('FAILS, and names the offending refs, when a declared blocker is still open', () => {
    // The whole point of the row: a still-open dependency holds the wave row.
    const result = validateIssueView(
      buildView({ blockedBy: [{ issue: 41 }, { issue: 7 }] }),
      {
        blockerResolutions: [
          { ref: { issue: 41 }, state: 'open' },
          { ref: { issue: 7 }, state: 'closed' },
        ],
      },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('fail');
    // AC4 — the reason names the ref, so the operator acts without re-deriving it.
    expect(gate(result, BLOCKED_GATE).reason).toContain('#41');
    expect(gate(result, BLOCKED_GATE).reason).not.toContain('#7');
    // A `fail` on any gate is what flips the whole result.
    expect(result.overall).toBe('FAIL');
  });

  it('DEFERS with the stated reason when a ref cannot be resolved at all', () => {
    // AC3 — not `pass`, not `fail`. No-evidence never counterfeits a clear
    // answer (the `closed-unknown` discipline, W2-F1c).
    const result = validateIssueView(
      buildView({ blockedBy: [{ slug: 'other', issue: 5 }] }),
      {
        blockerResolutions: [
          {
            ref: { slug: 'other', issue: 5 },
            state: 'unresolvable',
            reason: 'names a different slug than this row',
          },
        ],
      },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('deferred');
    expect(gate(result, BLOCKED_GATE).reason).toContain('other#5');
    expect(gate(result, BLOCKED_GATE).reason).toContain('different slug');
    expect(result.overall).toBe('PASS');
  });

  it('treats a declared ref with NO supplied resolution as unresolvable, never as clear', () => {
    // A caller that resolved only some of the refs must not be able to buy a
    // `pass` with the ones it omitted.
    const result = validateIssueView(
      buildView({ blockedBy: [{ issue: 41 }, { issue: 7 }] }),
      { blockerResolutions: [{ ref: { issue: 41 }, state: 'closed' }] },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('deferred');
    expect(gate(result, BLOCKED_GATE).reason).toContain('#7');
  });

  it('FAILS rather than defers when one ref is open and another is unresolvable, disclosing both', () => {
    // Positive evidence that the row is blocked does not stop being true because
    // a SECOND ref could not be reached — but the unreachable one is still named.
    const resolutions: BlockerResolution[] = [
      { ref: { issue: 41 }, state: 'open' },
      { ref: { slug: 'other', issue: 5 }, state: 'unresolvable', reason: 'cross-repo' },
    ];
    const result = validateIssueView(
      buildView({ blockedBy: [{ issue: 41 }, { slug: 'other', issue: 5 }] }),
      { blockerResolutions: resolutions },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('fail');
    expect(gate(result, BLOCKED_GATE).reason).toContain('#41');
    expect(gate(result, BLOCKED_GATE).reason).toContain('other#5');
    expect(gate(result, BLOCKED_GATE).reason).toContain('cross-repo');
  });

  it('matches resolutions to declared refs by slug#issue identity, not by position', () => {
    // `#5` and `other#5` are different issues; a slug-blind match would let the
    // resolved one answer for the unresolved one.
    const result = validateIssueView(
      buildView({ blockedBy: [{ slug: 'other', issue: 5 }] }),
      { blockerResolutions: [{ ref: { issue: 5 }, state: 'closed' }] },
    );

    expect(gate(result, BLOCKED_GATE).status).toBe('deferred');
    expect(gate(result, BLOCKED_GATE).reason).toContain('other#5');
  });
});

// ─── Gate 9 — the staleness advisory ────────────────────────────────────────
//
// Fixtures are REAL git repositories, not a mocked git: the gate's whole job is
// to ask git a question (has the default branch touched these paths since this
// instant?) and a mock would only re-assert the question this file already
// writes down. Commit dates are pinned via GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
// so every case is deterministic — `--since` filters on the COMMITTER date, so
// pinning it is what removes the clock race between "make a commit" and "pick a
// tracker timestamp".

const STALENESS_GATE_NAME = 'files-touched-since-tracker-update';

/** Commit date every fixture commit is pinned to. */
const COMMIT_AT = '2020-06-01T12:00:00Z';
/** A tracker update BEFORE the fixture commit — the row is stale, the advisory fires. */
const TRACKER_BEFORE_COMMIT = '2020-01-01T00:00:00Z';
/** A tracker update AFTER the fixture commit — nothing has moved since, the advisory passes. */
const TRACKER_AFTER_COMMIT = '2021-01-01T00:00:00Z';

describe('Gate 9 — the staleness advisory (files-touched-since-tracker-update)', () => {
  const repos: string[] = [];

  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  function git(repo: string, args: string[]): void {
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: COMMIT_AT,
        GIT_COMMITTER_DATE: COMMIT_AT,
      },
    });
  }

  /** A fresh git repo whose default branch is `main`, with one seed commit. */
  function makeRepo(label: string): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), `wave-dor-stale-${label}-`)));
    repos.push(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    // A global core.excludesFile on the machine running this suite must not be
    // able to make a fixture file un-addable and quietly empty the history.
    git(repo, ['config', 'core.excludesFile', '/dev/null']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf-8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'seed']);
    git(repo, ['branch', '-M', 'main']); // deterministic default-branch name
    return repo;
  }

  /**
   * Write a minimal wave issue file inside the repo and hand back both the path
   * and the exact source string, so `validateIssue` reads what was written
   * rather than a second, separately-composed copy.
   */
  function writeIssueIn(repo: string): { issuePath: string; source: string } {
    const issuePath = join(repo, '.scratch', 'demo', 'issues', '01-demo.md');
    mkdirSync(dirname(issuePath), { recursive: true });
    const source = ISSUE_FIXTURE_BODY(
      [
        '**Risk:** isolated-refactor',
        '**Worker:** background',
        '**Files:**',
        '- src/foo.ts',
        '**Blocked by:** none',
      ].join('\n'),
    );
    writeFileSync(issuePath, source, 'utf-8');
    return { issuePath, source };
  }

  function commitFile(repo: string, rel: string, message: string): void {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `// ${message}\n`, 'utf-8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
  }

  /**
   * One commit touching SEVERAL files at once — the shape issue #918's
   * Provenance describes ("that commit's whole diff is four files, exactly
   * one of which the row declares"): `commitFile` above only ever produces a
   * single-file diff, which cannot reproduce a commit whose diff is WIDER
   * than the declared files it happens to intersect.
   */
  function commitFiles(repo: string, rels: string[], message: string): void {
    for (const rel of rels) {
      const abs = join(repo, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// ${message}: ${rel}\n`, 'utf-8');
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
  }

  /** The abbreviated shas `git log --format=%h` reports for `rel`, newest first. */
  function shasTouching(repo: string, rel: string): string[] {
    return execFileSync('git', ['log', '--format=%h', '--', rel], {
      cwd: repo,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  }

  // ── it FIRES ────────────────────────────────────────────────────────────

  it('warns when the default branch touched a declared file after the row was last updated, naming the touching commit', () => {
    const repo = makeRepo('fires');
    commitFile(repo, 'src/foo.ts', 'retire the mechanism the row still names');

    const result = validateIssueView(
      buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
      { repoRoot: repo },
    );

    const g = gate(result, STALENESS_GATE_NAME);
    expect(g.status).toBe('warn');
    expect(g.reason).toContain('retire the mechanism the row still names');
    expect(g.reason).toContain('src/foo.ts');
  });

  it('names the ref it compared against, so a reader can tell origin/main from a bare HEAD', () => {
    const repo = makeRepo('ref-named');
    commitFile(repo, 'src/foo.ts', 'moved');

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.reason).toContain('main');
  });

  it('fires through a GLOB entry, matching the engine-wide `**` semantics', () => {
    const repo = makeRepo('glob');
    commitFile(repo, 'src/nested/deep/thing.ts', 'moved under the glob');

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/**'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('warn');
    expect(g.reason).toContain('moved under the glob');
  });

  it('is ADVISORY in the firing case: overall stays PASS and no gate reports fail', () => {
    const repo = makeRepo('advisory');
    commitFile(repo, 'src/foo.ts', 'moved');

    const result = validateIssueView(
      buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
      { repoRoot: repo },
    );

    expect(gate(result, STALENESS_GATE_NAME).status).toBe('warn');
    expect(result.gates.some((g) => g.status === 'fail')).toBe(false);
    expect(result.overall).toBe('PASS');
  });

  // ── it names the INTERSECTION, not the whole declared list (issue #918) ──
  //
  // The observed defect (issue #918's Provenance, verified against each
  // commit's own diff): a row was warned that a commit had moved SEVEN of its
  // declared files when that commit's whole diff was four files, exactly one
  // of which the row declared; a second row in the same pass was warned over
  // three declared files by a commit that touched only one of them. Both
  // cases are reproduced verbatim below.

  it('names only the declared file a commit touched out of SEVEN declared, and omits the other six', () => {
    const repo = makeRepo('seven-declared-one-touched');
    const declared = [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
      'src/g.ts',
    ];
    // The commit's WHOLE diff is four files; only `src/c.ts` is declared —
    // the exact shape reported in the Provenance above.
    commitFiles(
      repo,
      ['src/c.ts', 'unrelated/one.ts', 'unrelated/two.ts', 'unrelated/three.ts'],
      'touch one declared file inside a wider four-file diff',
    );

    const g = gate(
      validateIssueView(
        buildView({ files: declared, trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('warn');
    expect(g.reason).toContain('src/c.ts');
    expect(g.reason).toContain('touched 1 of 7 declared file');
    for (const untouched of ['src/a.ts', 'src/b.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts']) {
      expect(g.reason).not.toContain(untouched);
    }
  });

  it('names only the declared file a commit touched out of THREE declared, and omits the other two', () => {
    const repo = makeRepo('three-declared-one-touched');
    const declared = ['src/x.ts', 'src/y.ts', 'src/z.ts'];
    commitFile(repo, 'src/y.ts', 'touch one of three declared files');

    const g = gate(
      validateIssueView(
        buildView({ files: declared, trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('warn');
    expect(g.reason).toContain('src/y.ts');
    expect(g.reason).toContain('touched 1 of 3 declared file');
    expect(g.reason).not.toContain('src/x.ts');
    expect(g.reason).not.toContain('src/z.ts');
  });

  it('attributes a file touched by TWO commits to both of them, on the same line', () => {
    const repo = makeRepo('two-commits-one-file');
    commitFile(repo, 'src/shared.ts', 'first change to the shared file');
    commitFile(repo, 'src/shared.ts', 'second change to the shared file');
    const [newestSha, olderSha] = shasTouching(repo, 'src/shared.ts');
    expect(newestSha).toBeDefined();
    expect(olderSha).toBeDefined();

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/shared.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('warn');
    const attributionLine = (g.reason ?? '')
      .split('\n')
      .find((line) => line.includes('src/shared.ts —'));
    expect(attributionLine).toBeDefined();
    expect(attributionLine).toContain(newestSha);
    expect(attributionLine).toContain(olderSha);
  });

  it(
    'discloses a capped commit list as PARTIAL rather than presenting a truncated file set as complete',
    () => {
      const repo = makeRepo('capped');
      // Mirrors dor-gate.ts's own (unexported) STALENESS_COMMIT_CAP = 200 —
      // not imported, because that constant is deliberately module-private
      // (see its doc comment: exporting it would require growing
      // barrel-drift.spec.ts's allowlist, a file outside this issue's
      // declared Files: globs). Exactly this many commits touching the one
      // declared file is enough to hit `git log --max-count`'s own cap.
      const CAPPED_COMMIT_COUNT = 200;
      for (let i = 0; i < CAPPED_COMMIT_COUNT; i++) {
        commitFile(repo, 'src/foo.ts', `capped touch ${i}`);
      }

      const g = gate(
        validateIssueView(
          buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
          { repoRoot: repo },
        ),
        STALENESS_GATE_NAME,
      );

      expect(g.status).toBe('warn');
      expect(g.reason).toMatch(/partial/i);

      // Control: well under the cap, the same fixture shape carries no such
      // disclosure — the wording is conditional on capping, not unconditional
      // hedging.
      const repo2 = makeRepo('uncapped-control');
      commitFile(repo2, 'src/foo.ts', 'a single touch, nowhere near the cap');
      const g2 = gate(
        validateIssueView(
          buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
          { repoRoot: repo2 },
        ),
        STALENESS_GATE_NAME,
      );
      expect(g2.reason).not.toMatch(/partial/i);
    },
    60_000,
  );

  // ── it stays QUIET where it should ──────────────────────────────────────

  it('passes when the branch moved only OUTSIDE the declared files (the pathspec is load-bearing)', () => {
    const repo = makeRepo('elsewhere');
    commitFile(repo, 'docs/unrelated.md', 'moved somewhere else entirely');

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('pass');
  });

  it('passes when the row was updated AFTER the branch last touched its files', () => {
    const repo = makeRepo('fresh');
    commitFile(repo, 'src/foo.ts', 'moved before the row was decorated');

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_AFTER_COMMIT }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('pass');
  });

  it('passes vacuously — and says so — for a row that declares no Files at all', () => {
    const repo = makeRepo('no-files');
    commitFile(repo, 'src/foo.ts', 'moved');

    const g = gate(
      validateIssueView(buildView({ files: [], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }), {
        repoRoot: repo,
      }),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('pass');
    expect(g.reason).toContain('declares no Files');
  });

  // ── absence DEFERS, never falsely passes (the acceptance criterion) ──────

  it('DEFERS — never passes — when the view carries no tracker-update timestamp, on the exact fixture that otherwise fires', () => {
    const repo = makeRepo('no-timestamp');
    commitFile(repo, 'src/foo.ts', 'moved');

    // Control: with the timestamp, this same repo + row warns.
    expect(
      gate(
        validateIssueView(
          buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
          { repoRoot: repo },
        ),
        STALENESS_GATE_NAME,
      ).status,
    ).toBe('warn');

    const g = gate(
      validateIssueView(buildView({ files: ['src/foo.ts'] }), { repoRoot: repo }),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('deferred');
    expect(g.status).not.toBe('pass');
    expect(g.reason).toContain('capability gap');
  });

  it('DEFERS on an unparseable tracker-update timestamp rather than guessing a window', () => {
    const repo = makeRepo('bad-timestamp');
    commitFile(repo, 'src/foo.ts', 'moved');

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/foo.ts'], trackerUpdatedAt: 'last Tuesday-ish' }),
        { repoRoot: repo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('deferred');
  });

  it('DEFERS without a checkout, with the same working-tree semantics as gates 2/7 (ADR-0014)', () => {
    const result = validateIssueView(
      buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
    );

    const g = gate(result, STALENESS_GATE_NAME);
    expect(g.status).toBe('deferred');
    // the SAME defer reason the other working-tree gates carry
    expect(g.reason).toBe(gate(result, 'literal-files-exist').reason);
  });

  it('DEFERS when the supplied repo root is not a git checkout', () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), 'wave-dor-stale-nongit-')));
    repos.push(notARepo);

    const g = gate(
      validateIssueView(
        buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
        { repoRoot: notARepo },
      ),
      STALENESS_GATE_NAME,
    );

    expect(g.status).toBe('deferred');
    expect(g.reason).toContain('not a git checkout');
  });

  it('DEFERS with its own reason when the checkout is a git repo with no commits at all (no resolvable default-branch ref)', () => {
    // Every other fixture in this suite makes a seed commit via makeRepo(); this
    // is the one path #443 pins a regression spec on: a git-initialized repo
    // whose HEAD is unborn — no commit reaches origin/HEAD, origin/main,
    // origin/master, main, master, or even bare HEAD — so
    // resolveDefaultBranchRef() has nothing to resolve. This must defer with
    // its own named reason, not throw, and must not affect the overall verdict.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wave-dor-stale-no-commits-')));
    repos.push(repo);
    git(repo, ['init', '-q']);

    const result = validateIssueView(
      buildView({ files: ['src/foo.ts'], trackerUpdatedAt: TRACKER_BEFORE_COMMIT }),
      { repoRoot: repo },
    );

    const g = gate(result, STALENESS_GATE_NAME);
    expect(g.status).toBe('deferred');
    expect(g.reason).toContain('No default-branch ref resolves');
    // Advisory-only, same as every other Gate 9 outcome: the deferral must not
    // flip any gate to fail or the overall result away from PASS.
    expect(result.gates.some((x) => x.status === 'fail')).toBe(false);
    expect(result.overall).toBe('PASS');
  });

  // ── the file path (validateIssue) ───────────────────────────────────────

  it('derives the window from the issue FILE mtime on the file path, and fires', () => {
    const repo = makeRepo('file-path');
    commitFile(repo, 'src/foo.ts', 'moved after the issue file was last written');

    const { issuePath, source } = writeIssueIn(repo);
    // Back-date the issue file: the markdown store's tracker-update signal IS
    // this mtime, so this is the file-path equivalent of TRACKER_BEFORE_COMMIT.
    const backdated = new Date(TRACKER_BEFORE_COMMIT);
    utimesSync(issuePath, backdated, backdated);

    const result = validateIssue({ repoRoot: repo, issuePath, source });

    expect(gate(result, STALENESS_GATE_NAME).status).toBe('warn');
    expect(result.overall).toBe('PASS');
  });

  it('lets an explicit trackerUpdatedAt override the file mtime on the file path', () => {
    const repo = makeRepo('file-path-override');
    commitFile(repo, 'src/foo.ts', 'moved');

    const { issuePath, source } = writeIssueIn(repo);
    const backdated = new Date(TRACKER_BEFORE_COMMIT);
    utimesSync(issuePath, backdated, backdated);

    const result = validateIssue({
      repoRoot: repo,
      issuePath,
      source,
      // later than the commit — overrides the back-dated mtime
      trackerUpdatedAt: TRACKER_AFTER_COMMIT,
    });

    expect(gate(result, STALENESS_GATE_NAME).status).toBe('pass');
  });

  it('emits the gate second-to-last on the file path too, keeping the two entrypoints in the same order', () => {
    // #918 pinned this gate as the LAST one on the file path; Gate 10 (the
    // PR-title advisory) appended after it, so the position moved by one. The
    // invariant #918 was actually holding — the two entrypoints emit the SAME
    // roster in the SAME order — is asserted directly here instead of through
    // the position, which makes it stronger than the original one-index check.
    const repo = makeRepo('file-path-order');
    const { issuePath, source } = writeIssueIn(repo);

    const names = validateIssue({ repoRoot: repo, issuePath, source }).gates.map(
      (g) => g.name,
    );

    expect(names).toEqual(CANONICAL_GATE_NAMES);
    expect(names[names.length - 2]).toBe(STALENESS_GATE_NAME);
    expect(names[names.length - 1]).toBe(PR_TITLE_GATE_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate 10 — the PR-title advisory (pr-title-id-independent)
//
// The defect: a composed PR title is DERIVED from the tracker title by
// stripping the bare ids mention discipline forbids, and a title whose
// sentence leans on an id is left with prose pointing at nothing. Three such
// titles were observed live in one wave and corrected by hand at routing; the
// compose-time malformation notice caught none of them, because none of them
// left stray punctuation behind. The three are pinned as cases below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three titles observed live in wave `2026-09-21-guard-clarity-and-create-shape`,
 * in the shape the ticket records them: the id-bearing tracker title, the row id
 * the strip is run against, and the derived title that actually reached the PR.
 *
 * `derived` is NOT hand-written from the reported symptom — each entry is
 * cross-checked below against the composer's own `stripBareIds`, which is the
 * function that produces the real thing.
 */
const LIVE_ORPHANED_TITLES: ReadonlyArray<{
  label: string;
  id: string;
  title: string;
  derived: string;
}> = [
  {
    label: 'a leading preposition left pointing at nothing',
    id: '905',
    title:
      "After #791 the Reviewer agent definition still describes the sibling list as the round's dispatched rows",
    derived:
      "After the Reviewer agent definition still describes the sibling list as the round's dispatched rows",
  },
  {
    label: 'a trailing clause lost off the end',
    id: '900',
    title:
      "wave-setup's throwaway-consumer reference after #734",
    derived: "wave-setup's throwaway-consumer reference after",
  },
  {
    label: 'a trailing clause lost with the sentence colon left standing',
    id: '901',
    title:
      'Fix three usage-render residues after #856 : three stale references',
    derived: 'Fix three usage-render residues after : three stale references',
  },
];

/** A view carrying a title, with no PR-title override. */
function viewWithTitle(id: string): IssueView {
  return buildView({ id });
}

describe('Gate 10 — the PR-title advisory (pr-title-id-independent)', () => {
  it('warns on a title that carries a tracker id and declares no PR title, naming the row and showing the derived title', () => {
    const title = 'After #791 the Reviewer agent definition still describes the sibling list';
    const result = validateIssueView(viewWithTitle('905'), { title });
    const g = gate(result, PR_TITLE_GATE_NAME);

    expect(g.status).toBe('warn');
    // …names the row…
    expect(g.reason).toContain('Row 905');
    // …and shows BOTH titles, so the difference is read rather than re-derived.
    expect(g.reason).toContain(title);
    expect(g.reason).toContain(
      'After the Reviewer agent definition still describes the sibling list',
    );
  });

  it('passes a row that carries the override, whatever its tracker title contains', () => {
    const result = validateIssueView(viewWithTitle('905'), {
      title:
        "After #791 the Reviewer agent definition still describes the sibling list as the round's dispatched rows",
      prTitle: 'Reconcile the Reviewer brief with the composed sibling list',
    });
    const g = gate(result, PR_TITLE_GATE_NAME);

    expect(g.status).toBe('pass');
    expect(g.reason).toContain('A PR title is declared for this row');
  });

  it('passes a row whose tracker title contains no tracker id', () => {
    const g = gate(
      validateIssueView(viewWithTitle('905'), {
        title: 'Reconcile the Reviewer brief with the composed sibling list',
      }),
      PR_TITLE_GATE_NAME,
    );

    expect(g.status).toBe('pass');
    expect(g.reason).toBeUndefined();
  });

  it('a whitespace-only difference is not an id — the tidy pass alone never warns', () => {
    // The detection compares the stripped title against the title's own tidied
    // form, so collapsing runs of spaces cannot masquerade as a removed id.
    const g = gate(
      validateIssueView(viewWithTitle('905'), {
        title: '  Reconcile   the Reviewer brief  ',
      }),
      PR_TITLE_GATE_NAME,
    );

    expect(g.status).toBe('pass');
  });

  it('defers — never passes — when no title reached the check', () => {
    const g = gate(validateIssueView(viewWithTitle('905')), PR_TITLE_GATE_NAME);

    expect(g.status).toBe('deferred');
    expect(g.reason).toContain('capability gap');
    expect(g.reason).toContain('readTriage');
  });

  it('defers on a blank title rather than reading it as id-free', () => {
    const g = gate(
      validateIssueView(viewWithTitle('905'), { title: '   ' }),
      PR_TITLE_GATE_NAME,
    );

    expect(g.status).toBe('deferred');
  });

  it('a blank override does not count as a declaration', () => {
    const g = gate(
      validateIssueView(viewWithTitle('905'), {
        title: 'After #791 the Reviewer agent definition',
        prTitle: '   ',
      }),
      PR_TITLE_GATE_NAME,
    );

    expect(g.status).toBe('warn');
  });

  it("strips the row's OWN literal id too, not only the #<digits> form", () => {
    // The composer's strip has two branches; the structured entrypoint hands it
    // the row's opaque id so both of them run.
    const g = gate(
      validateIssueView(viewWithTitle('FOR-437'), {
        title: 'After FOR-437 the guard list is stale',
      }),
      PR_TITLE_GATE_NAME,
    );

    expect(g.status).toBe('warn');
    expect(g.reason).toContain('"After the guard list is stale"');
  });

  it('never changes the verdict — a row that would otherwise pass still passes', () => {
    const result = validateIssueView(viewWithTitle('905'), {
      title:
        "After #791 the Reviewer agent definition still describes the sibling list as the round's dispatched rows",
    });

    expect(gate(result, PR_TITLE_GATE_NAME).status).toBe('warn');
    expect(result.gates.some((g) => g.status === 'fail')).toBe(false);
    expect(result.overall).toBe('PASS');
  });

  describe('the three titles observed live', () => {
    for (const live of LIVE_ORPHANED_TITLES) {
      it(`warns and shows the orphaned derivation — ${live.label}`, () => {
        const g = gate(
          validateIssueView(viewWithTitle(live.id), { title: live.title }),
          PR_TITLE_GATE_NAME,
        );

        expect(g.status).toBe('warn');
        expect(g.reason).toContain(`  tracker title:    "${live.title}"`);
        expect(g.reason).toContain(`  derived PR title: "${live.derived}"`);
      });
    }

    it('and the compose-time malformation notice catches NONE of them — the gap this gate closes', () => {
      // The notice fires on a leading or doubled `/`/`,` the strip left
      // standing. Every one of these three derivations is free of that shape,
      // which is exactly why all three reached a PR and were renamed by hand.
      for (const live of LIVE_ORPHANED_TITLES) {
        expect(/^[/,]/.test(live.derived), live.title).toBe(false);
        expect(/([/,])\s*\1/.test(live.derived), live.title).toBe(false);
      }
    });
  });

  describe("agreement with the composer's own strip", () => {
    // This gate models the strip rather than importing it: the composer
    // already reaches dor-gate.ts transitively (compose-driver → cli-store →
    // store-factory → adapters/markdown-fs-store → dor-gate), so importing it
    // back from the gate would close an evaluation-time cycle the engine's
    // import-graph guard refuses. A SPEC may import both — specs are outside
    // that graph — so the duplication is pinned here instead of trusted.
    const CROSS_PIN_CASES: ReadonlyArray<{ id: string; title: string }> = [
      ...LIVE_ORPHANED_TITLES.map((l) => ({ id: l.id, title: l.title })),
      { id: '800', title: 'Residue after #751/#772: the STILL OPEN sentence' },
      { id: '648', title: "(ADR-0051 decision 7, #648's settled shape)" },
      { id: '905', title: 'A title with #12 and #13 in a chain' },
      { id: 'FOR-437', title: 'After FOR-437 the guard list is stale' },
      { id: '905', title: 'A title carrying no tracker id at all' },
      { id: '905', title: 'ADR-0041 is not a tracker id and must survive' },
    ];

    for (const c of CROSS_PIN_CASES) {
      it(`derives exactly what stripBareIds produces — "${c.title}"`, () => {
        const expected = stripBareIds(c.title, c.id);
        const g = gate(
          validateIssueView(viewWithTitle(c.id), { title: c.title }),
          PR_TITLE_GATE_NAME,
        );

        if (expected === c.title) {
          // Nothing was stripped — the gate must not warn.
          expect(g.status).toBe('pass');
        } else {
          expect(g.status).toBe('warn');
          expect(g.reason).toContain(`  derived PR title: "${expected}"`);
        }
      });
    }
  });

  describe('the file entrypoint', () => {
    it("reads the issue file's own `# ` heading and warns on an id-bearing one", () => {
      const issuePath = writeIssue(
        'pr-title-feature',
        '70-id-bearing-title.md',
        [
          '# After #791 the Reviewer agent definition still describes the sibling list',
          '',
          '**Status:** ready-for-agent',
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- src/foo.ts',
          '**Blocked by:** none',
          '',
          '## Acceptance criteria',
          '',
          '- [ ] Thing is built',
        ].join('\n'),
      );
      const source = require('node:fs').readFileSync(issuePath, 'utf-8');
      const result = validateIssue({ repoRoot: root, issuePath, source });
      const g = gate(result, PR_TITLE_GATE_NAME);

      expect(g.status).toBe('warn');
      // Named by its file, because this entrypoint is handed no tracker id.
      expect(g.reason).toContain('Row 70-id-bearing-title.md');
      expect(g.reason).toContain(
        '"After the Reviewer agent definition still describes the sibling list"',
      );
      // Advisory only.
      expect(result.overall).toBe('PASS');
    });

    it('takes the `# ` heading and never an `##` section heading', () => {
      const issuePath = writeIssue(
        'pr-title-feature',
        '71-clean-title.md',
        ISSUE_FIXTURE_BODY(
          [
            '**Risk:** mechanical',
            '**Worker:** background',
            '**Files:**',
            '- src/foo.ts',
            '**Blocked by:** none',
          ].join('\n'),
        ),
      );
      const source = require('node:fs').readFileSync(issuePath, 'utf-8');
      const g = gate(
        validateIssue({ repoRoot: root, issuePath, source }),
        PR_TITLE_GATE_NAME,
      );

      // `# 99 — Example` carries no `#<digits>` token of its own.
      expect(g.status).toBe('pass');
    });

    it('passes when the call states the PR title, whatever the heading says', () => {
      const issuePath = writeIssue(
        'pr-title-feature',
        '72-declared.md',
        [
          '# After #791 the Reviewer agent definition',
          '',
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- src/foo.ts',
          '**Blocked by:** none',
          '',
          '## Acceptance criteria',
          '',
          '- [ ] Thing is built',
        ].join('\n'),
      );
      const source = require('node:fs').readFileSync(issuePath, 'utf-8');
      const g = gate(
        validateIssue({
          repoRoot: root,
          issuePath,
          source,
          prTitle: 'Reconcile the Reviewer brief with the composed sibling list',
        }),
        PR_TITLE_GATE_NAME,
      );

      expect(g.status).toBe('pass');
    });

    it('defers on a source with no `# ` heading at all', () => {
      const issuePath = writeIssue(
        'pr-title-feature',
        '73-headless.md',
        [
          '**Risk:** mechanical',
          '**Worker:** background',
          '**Files:**',
          '- src/foo.ts',
          '**Blocked by:** none',
        ].join('\n'),
      );
      const source = require('node:fs').readFileSync(issuePath, 'utf-8');
      const g = gate(
        validateIssue({ repoRoot: root, issuePath, source }),
        PR_TITLE_GATE_NAME,
      );

      expect(g.status).toBe('deferred');
    });
  });
});
