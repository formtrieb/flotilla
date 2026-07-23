import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateIssue,
  validateIssueView,
  acFilesCoverageCheck,
  extractAcBody,
  type DorResult,
  type GateResult,
} from './dor-gate';
import type { HeaderBlock } from './header-parser';
import type { IssueView } from './contract';

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
    // cross-issue gate defers on a bare id in M1 (re-home is P2a)
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
    // cross-issue gate still defers even with a checkout — it is not working-tree
    expect(gate(result, 'blocked-by-chain-resolves').status).toBe('deferred');
  });

  it('warns literal-files-exist when a declared file is missing from the supplied repoRoot', () => {
    const result = validateIssueView(buildView({ files: ['src/ghost.ts'] }), {
      repoRoot: root,
    });

    expect(gate(result, 'literal-files-exist').status).toBe('warn');
    expect(result.overall).toBe('PASS');
  });

  it('emits all seven canonical gates in the same order as the file path (no silent omission)', () => {
    const names = validateIssueView(buildView()).gates.map((g) => g.name);

    expect(names).toEqual([
      'header-parseable',
      'files-glob-valid',
      'ac-section-consistent',
      'risk-file-count-consistent',
      'blocked-by-chain-resolves',
      'ac-files-coverage',
      'literal-files-exist',
    ]);
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
