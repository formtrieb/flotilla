import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * shipped-citation-guard.spec.ts — the published artifact may not cite a path
 * that only flotilla's own checkout can resolve.
 *
 * ## The class, and why it needed its own guard
 *
 * flotilla runs the **source form** on both distribution layers: the skills sit
 * in this repo's `.claude/skills/`, the engine in `tools/wave/`. Every consumer
 * runs the **installed form**: the skills arrive as a plugin clone and the
 * engine as an npm package, bound through `engine.cli` (ADR-0032). A path this
 * repo can resolve is therefore *not* a path a consumer can resolve, and the
 * gap is invisible from inside the repo — everything the author checks is right
 * there on disk.
 *
 * That gap reached a stranger. The `PreToolUse` echo-guard's refusal message
 * ended on `Full doctrine: <a path under .claude/skills/…>`. The hook ships in
 * the tarball's `hooks/` directory and the setup scaffold copies it into every
 * consumer's own hooks directory, so the message travelled verbatim — and its
 * last line was dead at the one moment a consumer read it: their first refusal.
 * The first installed-form 1.0.0 consumer reported it within hours of release.
 *
 * A sweep at that point found the emitted refusal was the ONLY runtime-emitted
 * instance, plus three inert doc-comments in shipped sources citing brief/handling
 * documents that had been folded into their owning SKILL and mechanics documents
 * and existed under no spelling at all.
 *
 * ## Two rules, one subject: the artifact a consumer actually installs
 *
 * 1. **No form-dependent path in the guard's REFUSAL OUTPUT** — checked by
 *    running the hook *out of a freshly packed tarball*, not out of the repo
 *    tree. Reading the repo tree is what made the class invisible in the first
 *    place; packing is cheap (well under a second) and removes the assumption
 *    entirely.
 * 2. **No doc-comment in a shipped engine source citing a skill document that
 *    does not exist** — every such citation must resolve, or must not be a path
 *    at all.
 *
 * Rule 2's second branch is deliberate and is where the fix for the three dead
 * citations went: the repair is to **name the subject** ("the Worker brief's
 * Report block, composed by `workerBrief()` in the wave-start skill's workflow
 * driver") rather than to re-spell the path. A citation with no path in it has
 * nothing for the extractor below to find, and that is the intended pass — the
 * same division of labour Convention 14's own guard draws: placement is
 * machine-checkable, compression is the author's.
 *
 * ## Scope boundaries, stated so they are not read as oversights
 *
 * - **Rule 1 covers the refusal message, not the fail-open line.** A crash
 *   message interpolates a runtime error string; any path in it comes from the
 *   OS, not from a citation this repo wrote down.
 * - **Rule 2 covers doc-COMMENTS, not code.** `worktree-cleanup.ts` carries
 *   `.claude/…` strings that are functional path constants describing the
 *   harness layout of whichever repo the sweep runs in — including
 *   `.claude/loop.md`, a harness-owned file that legitimately does not exist
 *   here. Those are data, not citations, and re-pointing them would be a
 *   behavior change dressed as a doc fix. The comment-line classifier below is
 *   what keeps them out, and a permanent negative control pins that.
 * - **Rule 2 asks only "does this document exist".** A citation that resolves
 *   here still names a source-form location; several shipped comments cite
 *   `.claude/agents/wave-reviewer.md`, which is real and maintained. Those are
 *   inert — a maintainer reading the source follows them, nothing emits them —
 *   so this guard requires them to be *true*, not to be form-neutral. Only
 *   EMITTED text (rule 1) has to survive the distribution boundary.
 *
 * This is a separate file from `skill-reference-guard.spec.ts` on purpose: that
 * spec scans markdown under the skills tree and has no view of TypeScript
 * doc-comments, which is precisely why three dead citations sat in shipped
 * sources undetected. Widening it would have coupled this rule to the file that
 * also asserts wave-plan prose.
 */

/** `tools/wave` — the npm package root. */
const PACKAGE_ROOT = join(__dirname, '..');

/** The repository root — where a `.claude/…` citation is resolved from. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Source extensions the citation rule applies to. */
const SOURCE_EXTENSIONS = ['.ts', '.cjs', '.mjs', '.js'];

// ---------------------------------------------------------------------------
// Rule 1 — form-dependent paths
// ---------------------------------------------------------------------------

/**
 * Path shapes that resolve in flotilla's own checkout and nowhere else. Each
 * carries the reason it cannot travel, so a future reader adding or removing an
 * entry has to argue with the reason rather than the regex.
 *
 * Deliberately a NAMED table rather than "any token containing a slash": the
 * refusal legitimately contains `/` characters that are not paths at all (the
 * `:- / := / :?` operator list in family 2's detail is the live example), and a
 * blanket rule would fire on those while teaching nothing.
 */
const FORM_DEPENDENT_PATHS: { label: string; pattern: RegExp; why: string }[] = [
  {
    label: '.claude/…',
    pattern: /\.claude\/[A-Za-z0-9._/-]+/g,
    why: "the harness directory. In the installed form the skills and agents live in the plugin clone, and this hook has been copied to the consumer's own hooks directory — so no `.claude/…` path this repo knows is the consumer's.",
  },
  {
    label: 'tools/wave/…',
    pattern: /tools\/wave\/[A-Za-z0-9._/-]+/g,
    why: "flotilla's own vendored engine tree. A consumer's engine lives under `node_modules/@formtrieb/flotilla-engine`.",
  },
  {
    label: 'docs/…',
    pattern: /(?:^|[\s(`'"[])docs\/[A-Za-z0-9._/-]+/g,
    why: 'repo documentation (ADRs, retros). It is not in the published tarball and not in a consumer checkout — cite the ADR by NUMBER instead, which is searchable in either form.',
  },
  {
    label: '.scratch/…',
    pattern: /\.scratch\/[A-Za-z0-9._/-]+/g,
    why: "the predecessor system's scratch tree, which never existed in this repo at all.",
  },
];

/** Every form-dependent path in `text`, with the reason it cannot travel. */
function findFormDependentPaths(text: string): { label: string; match: string; why: string }[] {
  const found: { label: string; match: string; why: string }[] = [];
  for (const { label, pattern, why } of FORM_DEPENDENT_PATHS) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
      found.push({ label, match: m[0].trim(), why });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rule 2 — skill-document citations in doc-comments
// ---------------------------------------------------------------------------

/** A citation of a markdown document under the harness directory. */
const SKILL_DOC_CITATION = /\.claude\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md/g;

/**
 * True when `line` is comment text rather than code.
 *
 * The rule the acceptance criterion states is about doc-COMMENTS, and the
 * distinction is load-bearing rather than pedantic: a `.claude/…md` string in a
 * code line is a functional path constant (`HARNESS_DENIED_FILES` in
 * `worktree-cleanup.ts` names `.claude/loop.md`, a harness-owned file that is
 * absent here by design). Requiring those to exist would be a false positive
 * that pushes an author to "fix" working behavior.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return true;
  return false;
}

/** Every skill-document citation in `source`, with its 1-indexed line. */
function extractSkillDocCitations(source: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  source.split('\n').forEach((line, index) => {
    if (!isCommentLine(line)) return;
    for (const m of line.matchAll(new RegExp(SKILL_DOC_CITATION.source, 'g'))) {
      out.push({ path: m[0], line: index + 1 });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The packed artifact
// ---------------------------------------------------------------------------

let workDir = '';
/** The extracted tarball root — `<tmp>/package`, exactly what an install lays down. */
let shippedRoot = '';

/** Every file in the extracted tarball, as tarball-relative paths. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'flotilla-pack-'));

  // `npm pack` runs no lifecycle scripts in this package (there is no `prepack`
  // or `prepare`), so this is a pure packaging step: local, offline, and the
  // exact file set `npm publish` would upload.
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', workDir], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  // Fail LOUD, never skip: a guard observed only as skipped has been proven not
  // to run, which is not the same as proven to pass.
  expect(packed.error, `npm pack failed to spawn: ${packed.error?.message}`).toBeUndefined();
  expect(packed.status, `npm pack exited ${packed.status}\n${packed.stderr}`).toBe(0);

  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0].filename;
  const tarball = join(workDir, filename);
  expect(existsSync(tarball), `packed tarball missing at ${tarball}`).toBe(true);

  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', workDir], {
    encoding: 'utf-8',
    timeout: 120_000,
  });
  expect(extracted.status, `tar exited ${extracted.status}\n${extracted.stderr}`).toBe(0);

  shippedRoot = join(workDir, 'package');
  expect(existsSync(shippedRoot), `extracted package root missing at ${shippedRoot}`).toBe(true);
}, 180_000);

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the packed tarball is the subject under test', () => {
  it('ships the echo-guard hook — the premise the emitted-refusal rule rests on', () => {
    expect(existsSync(join(shippedRoot, 'hooks', 'echo-guard.cjs'))).toBe(true);
  });

  it('ships the engine sources whose doc-comments the citation rule scans', () => {
    const shipped = walk(shippedRoot);
    expect(shipped).toContain('src/worker-report-schema.ts');
    expect(shipped).toContain('src/reviewer-verdict-schema.ts');
    expect(shipped).toContain('src/stop-condition-state-machine.ts');
    // Spec files are excluded by the package's own `files` manifest, so the
    // citation rule genuinely scans the consumer-visible surface and nothing
    // more. Asserted rather than assumed — if specs ever start shipping, the
    // rule's scope silently widens and this line is where that surfaces.
    expect(shipped.some((p) => p.endsWith('.spec.ts'))).toBe(false);
  });
});

describe('rule 1 — the shipped guard emits no path only the source form resolves', () => {
  /** The two `<VAR>_CMD` Lookup-Commands flotilla configures (ADR-0029). */
  const GITHUB_LOOKUP = 'security find-generic-password -a $USER -s flotilla-github-token -w';
  const CONFIGURED_ENV = { GITHUB_TOKEN_CMD: GITHUB_LOOKUP };

  /** Run the hook AS SHIPPED and return its refusal. */
  function refuse(command: string): { code: number; stderr: string } {
    const result = spawnSync(process.execPath, [join(shippedRoot, 'hooks', 'echo-guard.cjs')], {
      input: JSON.stringify({
        session_id: 'spec',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf-8',
      timeout: 30_000,
      // Hermetic: families 1 and 4 read the consumer's `<VAR>_CMD` entries at
      // hook runtime, so inheriting the ambient environment would make the
      // assertions depend on the machine.
      env: { PATH: process.env.PATH ?? '', ...CONFIGURED_ENV },
    });
    return { code: result.status ?? -1, stderr: result.stderr ?? '' };
  }

  /** One command per family, so no single family's detail string can hide. */
  const PER_FAMILY: { family: string; command: string }[] = [
    { family: 'credential-name expansion', command: 'echo $GITHUB_TOKEN' },
    { family: 'value-substituting expansion', command: 'echo "${DEPLOY_TARGET:-none}"' },
    { family: 'whole-environment dump', command: 'printenv' },
    { family: 'wrapped Lookup-Command', command: `echo $(${GITHUB_LOOKUP})` },
  ];

  it.each(PER_FAMILY)('$family — its refusal carries no form-dependent path', ({ family, command }) => {
    const { code, stderr } = refuse(command);
    expect(code).toBe(2);
    expect(stderr).toContain(family);
    expect(findFormDependentPaths(stderr)).toEqual([]);
  });

  it('a refusal firing ALL FOUR families at once is clean — the union covers every emitted string', () => {
    const { code, stderr } = refuse(
      `printenv; echo $GITHUB_TOKEN; echo "\${DEPLOY_TARGET:-none}"; ${GITHUB_LOOKUP}`,
    );
    expect(code).toBe(2);
    // Coverage proof, not decoration: the message is a static frame plus one
    // detail line per violation, so a refusal carrying all four family details
    // exercises every string `rejectionMessage()` can ever emit. Without this
    // assertion the scan below could pass by simply not having fired.
    for (const { family } of PER_FAMILY) expect(stderr).toContain(family);

    const found = findFormDependentPaths(stderr);
    expect(
      found,
      found.map((f) => `${f.label}: ${f.match} — ${f.why}`).join('\n'),
    ).toEqual([]);
  });

  it('still teaches: why it was rejected, what to do instead, and that it matched command TEXT', () => {
    // The pointer was dropped, so the message has to stand on its own. These are
    // the three things a stranger's first refusal must tell them.
    const { stderr } = refuse('printenv');
    // Why.
    expect(stderr).toContain('session transcript on disk');
    expect(stderr).toContain('rotating the credential');
    // What to do instead — both sanctioned forms, plus the rule for the roles
    // that should run neither.
    expect(stderr).toContain('[ -n "$VAR" ] && echo set');
    expect(stderr).toContain('credential-probe --all');
    expect(stderr).toContain('worktree-isolated role runs NEITHER');
    // What the guard actually matched: the command's text, not its behavior.
    expect(stderr).toContain('COMMAND TEXT');
    expect(stderr).toContain('speed bump');
  });

  it('NEGATIVE CONTROL — the detector fires on the exact line that was removed', () => {
    // The refusal's former last line, verbatim. If this ever comes back green,
    // the rule above has stopped being able to fail and is worth nothing.
    const regression =
      '[echo-guard] BLOCKED — Convention 8 (secret-safe tool output).\n' +
      'Full doctrine: .claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md\n';
    const found = findFormDependentPaths(regression);
    expect(found.map((f) => f.match)).toContain(
      '.claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md',
    );
  });

  it.each(FORM_DEPENDENT_PATHS.map((p) => p.label))(
    'NEGATIVE CONTROL — %s is detected, so every row of the table can fail',
    (label) => {
      const sample: Record<string, string> = {
        '.claude/…': 'see .claude/skills/wave-shared/SKILL.md for more',
        'tools/wave/…': 'see tools/wave/hooks/echo-guard.cjs for more',
        'docs/…': 'see docs/adr/0029-credentials.md for more',
        '.scratch/…': 'see .scratch/wave-orchestration/PRD.md for more',
      };
      expect(findFormDependentPaths(sample[label]).map((f) => f.label)).toContain(label);
    },
  );

  it('does NOT fire on the non-path slashes the refusal legitimately contains', () => {
    // Family 2's detail names the shell operators `:- / := / :?`; the scope note
    // names `permissions.deny`. A blanket "any token with a slash" rule would
    // block both, which is why the table above is named rather than generic.
    expect(findFormDependentPaths('the :- / := / :? operators')).toEqual([]);
    expect(findFormDependentPaths('the tracked permissions.deny entries')).toEqual([]);
  });
});

describe('rule 2 — no shipped doc-comment cites a skill document that does not exist', () => {
  it('every skill-document citation in a shipped engine source resolves', () => {
    const sources = walk(shippedRoot).filter((p) => SOURCE_EXTENSIONS.some((e) => p.endsWith(e)));
    // The scan is worthless if it found nothing to scan.
    expect(sources.length).toBeGreaterThan(20);

    const dead: string[] = [];
    let checked = 0;
    for (const rel of sources) {
      const body = readFileSync(join(shippedRoot, rel), 'utf-8');
      for (const { path, line } of extractSkillDocCitations(body)) {
        checked += 1;
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} → ${path}`);
      }
    }

    // Citations that resolve are expected to exist — this pins that the
    // extractor is still finding them rather than silently matching nothing.
    expect(checked).toBeGreaterThan(0);
    expect(
      dead,
      'shipped doc-comments citing a skill document that exists under no spelling ' +
        '(re-spelling the path is not the fix when the document was consolidated away — ' +
        `name its subject instead):\n${dead.join('\n')}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL — a dead citation in a doc-comment is found', () => {
    const planted = '/**\n * Mirrors: .claude/skills/wave-shared/references/worker-brief-template.md §Block 5\n */\n';
    const found = extractSkillDocCitations(planted);
    expect(found.map((c) => c.path)).toEqual([
      '.claude/skills/wave-shared/references/worker-brief-template.md',
    ]);
    expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(false);
  });

  it('NEGATIVE CONTROL — the `references/` vs `reference/` misspelling class is caught by resolution, not by spelling', () => {
    // Both spellings of the three consolidated documents are dead, so a guard
    // that merely corrected `references/` to `reference/` would swap one dead
    // path for another and stay green. Resolution is what makes that impossible.
    for (const spelling of ['reference', 'references']) {
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-shared/${spelling}/worker-brief-template.md`)),
      ).toBe(false);
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-shared/${spelling}/reviewer-brief-template.md`)),
      ).toBe(false);
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-start/${spelling}/stop-condition-handling.md`)),
      ).toBe(false);
    }
  });

  it('a citation that names its subject instead of a path has nothing to resolve — the intended pass', () => {
    const named =
      "/**\n * Mirrors: the Worker brief's Report block — composed by `workerBrief()` in the\n" +
      " *          wave-start skill's workflow driver.\n */\n";
    expect(extractSkillDocCitations(named)).toEqual([]);
  });

  it('CARVE-OUT CONTROL — a `.claude/…md` string in CODE is a path constant, not a citation', () => {
    // `worktree-cleanup.ts`'s `HARNESS_DENIED_FILES` names `.claude/loop.md`, a
    // harness-owned file this repo legitimately does not have. It is data the
    // sweep matches against, and it is explicitly out of this rule's scope.
    expect(extractSkillDocCitations("const HARNESS_DENIED = ['.claude/loop.md'];\n")).toEqual([]);
    expect(existsSync(join(REPO_ROOT, '.claude/loop.md'))).toBe(false);
    // ...while the same path inside a doc-comment IS a citation.
    expect(extractSkillDocCitations(' * see .claude/loop.md\n').map((c) => c.path)).toEqual([
      '.claude/loop.md',
    ]);
  });
});
