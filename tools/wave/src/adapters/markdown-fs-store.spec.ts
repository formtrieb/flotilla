import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore, markdownConformanceHooks } from './markdown-fs-store';
import { validateIssue } from '../dor-gate';
import type { CreateInput } from './issue-store';
import {
  runIssueStoreConformance,
  type ConformanceHarness,
} from './conformance/issue-store-conformance';

const SLUG = 'test-feature';

function baseInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    title: 'A test issue',
    filingHint: 'a-test-issue',
    risk: 'mechanical',
    worker: 'background',
    files: ['src/x.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'does the thing', checked: false }],
    ...overrides,
  };
}

// ── the shared contract ─────────────────────────────────────────────────────
const conformanceRoots: string[] = [];
runIssueStoreConformance('MarkdownFsStore', async (): Promise<ConformanceHarness> => {
  return {
    async makeStore() {
      const root = await mkdtemp(join(tmpdir(), 'mdfs-conf-'));
      conformanceRoots.push(root);
      return new MarkdownFsStore({ repoRoot: root, slug: SLUG });
    },
    hooks: markdownConformanceHooks,
    baseInput,
  };
});
afterEach(async () => {
  await Promise.all(conformanceRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// ── MarkdownFsStore-specific parity properties (storage-aware) ───────────────
describe('MarkdownFsStore — markdown parity specifics', () => {
  let root: string;
  let store: MarkdownFsStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mdfs-'));
    store = new MarkdownFsStore({ repoRoot: root, slug: SLUG });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const issuePath = (nn: string) =>
    join(root, '.scratch', SLUG, 'issues', `${nn}`);

  it('create() writes .scratch/<slug>/issues/<NN>-<filingHint>.md with the NN-prefixed H1', async () => {
    const id = await store.create(baseInput({ filingHint: 'my-thing', title: 'My Thing' }));
    expect(id).toBe('test-feature#01');
    const src = await readFile(issuePath('01-my-thing.md'), 'utf-8');
    expect(src).toMatch(/^# 01 — My Thing$/m);
    expect(src).toMatch(/^\*\*Status:\*\* ready-for-agent$/m);
    expect(src).toMatch(/^\*\*Risk:\*\* mechanical$/m);
  });

  // The negative control for ADR-0044's bare-`blockedBy` refusal (whose own
  // cases live in bare-create-facet.spec.ts): the refusal is scoped to the BARE
  // shape, so the DECORATED path still writes the `**Blocked by:**` header line
  // for exactly the same refs — the only representation this store has, and the
  // reason the bare shape is refused rather than half-served.
  it('a DECORATED create still writes the **Blocked by:** line — the refusal is scoped to the bare shape', async () => {
    const id = await store.create(
      baseInput({ filingHint: 'blocked-thing', blockedBy: [{ issue: 7 }] }),
    );
    const nn = id.slice(id.lastIndexOf('#') + 1);
    const src = await readFile(issuePath(`${nn}-blocked-thing.md`), 'utf-8');
    expect(src).toMatch(/^\*\*Blocked by:\*\* #7$/m);
    expect((await store.read(id)).blockedBy).toEqual([{ issue: 7 }]);
  });

  it('NN auto-increments across both issues/ and issues/done/', async () => {
    await store.create(baseInput({ filingHint: 'one' }));
    const second = await store.create(baseInput({ filingHint: 'two' }));
    expect(second).toBe('test-feature#02');
  });

  it('id uses the feature slug, NOT the filingHint (ADR-0001 — filingHint is filename-only)', async () => {
    const id = await store.create(baseInput({ filingHint: 'totally-different-hint' }));
    expect(id).toBe('test-feature#01'); // slug#NN, hint nowhere in the id
  });

  it('transition() writes a flotilla-new **Wave-Status:** line and leaves Status untouched', async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'in-flight');
    const src = await readFile(issuePath('01-a-test-issue.md'), 'utf-8');
    expect(src).toMatch(/^\*\*Wave-Status:\*\* in-flight$/m);
    expect(src).toMatch(/^\*\*Status:\*\* ready-for-agent$/m); // eligibility line intact
  });

  it('close() moves the file to done/ and writes Closed-by right after Status', async () => {
    const id = await store.create(baseInput());
    await store.close(id, 'https://example/pr/9', [0]);
    // moved out of issues/ into issues/done/
    const openNames = await readdir(join(root, '.scratch', SLUG, 'issues'));
    expect(openNames.filter((n) => n.endsWith('.md'))).toHaveLength(0);
    const src = await readFile(
      join(root, '.scratch', SLUG, 'issues', 'done', '01-a-test-issue.md'),
      'utf-8',
    );
    // Closed-by sits between Status and Risk (Ur position)
    expect(src).toMatch(/\*\*Status:\*\* done[\s\S]*\*\*Closed-by:\*\* https:\/\/example\/pr\/9[\s\S]*\*\*Risk:\*\*/);
    expect(src).toMatch(/^- \[x\] does the thing$/m);
  });

  it('surgical writes preserve unmodeled header fields and Files annotations', async () => {
    // hand-author an Ur-style file with extra fields + an annotated Files entry
    const dir = join(root, '.scratch', SLUG, 'issues');
    await mkdir(dir, { recursive: true });
    const original = `# 07 — Legacy issue

**Status:** ready-for-agent
**Created:** 2026-06-06
**Type:** lib
**Parent:** PRD #1
**Risk:** mechanical
**Worker:** background
**Files:**
- src/keep.ts  ← only if the gate surfaces a deprecation
**Blocked by:** none

## Acceptance criteria

- [ ] preserve me
`;
    await writeFile(join(dir, '07-legacy.md'), original, 'utf-8');

    await store.transition('test-feature#07', 'queued');
    const after = await readFile(join(dir, '07-legacy.md'), 'utf-8');
    // unmodeled fields survive the surgical write
    expect(after).toMatch(/^\*\*Created:\*\* 2026-06-06$/m);
    expect(after).toMatch(/^\*\*Type:\*\* lib$/m);
    expect(after).toMatch(/^\*\*Parent:\*\* PRD #1$/m);
    // the Files annotation survives (never re-serialized)
    expect(after).toMatch(/← only if the gate surfaces a deprecation/);
    // and the new claim line is present
    expect(after).toMatch(/^\*\*Wave-Status:\*\* queued$/m);
  });

  it('listOpen() excludes a non-eligible (out-of-OR-set) Status, even with prose suffix', async () => {
    const dir = join(root, '.scratch', SLUG, 'issues');
    await mkdir(dir, { recursive: true });
    // eligible but with a parenthetical prose suffix → must still be eligible
    const eligible = `# 01 — Eligible

**Status:** ready-for-agent (note: see comments)
**Risk:** mechanical
**Worker:** background
**Files:**
- src/a.ts
**Blocked by:** none

## Acceptance criteria

- [ ] x
`;
    const ineligible = eligible
      .replace('# 01 — Eligible', '# 02 — Ineligible')
      .replace('ready-for-agent (note: see comments)', 'needs-info');
    await writeFile(join(dir, '01-eligible.md'), eligible, 'utf-8');
    await writeFile(join(dir, '02-ineligible.md'), ineligible, 'utf-8');

    const open = await store.listOpen('wave-ready');
    const ids = open.map((v) => v.id).sort();
    expect(ids).toEqual(['test-feature#01']);
  });

  it('decorate (annotate) produces a DOR-passing issue file on disk', async () => {
    // The concrete ADR-0010 proof the abstract conformance can't express: create
    // a triage-ready issue (carries Blocked by: none + human AC), decorate it
    // with the computed wave fields, then run the resulting FILE through the DOR
    // gate and assert overall PASS.
    const id = await store.create(
      baseInput({
        filingHint: 'decorate-target',
        title: 'Decorate target',
        files: ['src/x.ts'],
        bodySections: [
          { heading: 'What to build', markdown: 'the human brief' },
        ],
        acceptanceCriteria: [{ text: 'human AC survives decorate', checked: false }],
      }),
    );
    expect(id).toBe('test-feature#01');

    await store.annotate(id, {
      risk: 'isolated-refactor',
      worker: 'background-heavy',
      files: ['src/x.ts', 'src/y.ts'],
    });

    const path = issuePath('01-decorate-target.md');
    const source = await readFile(path, 'utf-8');
    const result = validateIssue({ repoRoot: root, issuePath: path, source });
    expect(result.overall).toBe('PASS');
  });

  it('a custom eligibility OR-set is honored', async () => {
    const custom = new MarkdownFsStore({
      repoRoot: root,
      slug: SLUG,
      eligibility: ['ready-for-neo', 'ready-for-agent'],
    });
    const id = await custom.create(baseInput()); // stamps ready-for-neo (first token)
    const src = await readFile(issuePath('01-a-test-issue.md'), 'utf-8');
    expect(src).toMatch(/^\*\*Status:\*\* ready-for-neo$/m);
    expect((await custom.listOpen('wave-ready')).map((v) => v.id)).toContain(id);
  });

  it('parseRef() inverts a minted <slug>#NN id into {slug, issue} (strips the zero-pad)', async () => {
    const id = await store.create(baseInput()); // → `test-feature#01`
    expect(store.parseRef(id)).toEqual({ slug: SLUG, issue: 1 });
  });

  it('parseRef() throws on a non-numeric id (e.g. a PRD `#prd` sentinel — ADR-0013)', () => {
    expect(() => store.parseRef(`${SLUG}#prd`)).toThrow();
  });
});

// ── trackerUpdatedAt derivation: git-tracked vs untracked (the two disclosed
// staleness-advisory soft spots, issue #443) ──────────────────────────────────
//
// A fixture is a REAL git repository, not a mocked git: the store's whole job
// here is to ask git a question (does the index know this file, and if so what
// is its last commit's date?) and a mock would only re-assert the question
// this file already writes down. Commit dates are pinned via
// GIT_AUTHOR_DATE/GIT_COMMITTER_DATE for determinism, same shape as the Gate 9
// fixtures in dor-gate.spec.ts.
describe('MarkdownFsStore — trackerUpdatedAt derivation (git-tracked vs untracked)', () => {
  let root: string;
  let store: MarkdownFsStore;
  const COMMIT_AT = '2020-06-01T12:00:00Z';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mdfs-git-'));
    store = new MarkdownFsStore({ repoRoot: root, slug: SLUG });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const issuePath = (nn: string) => join(root, '.scratch', SLUG, 'issues', `${nn}`);

  function git(args: string[]): void {
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: COMMIT_AT,
        GIT_COMMITTER_DATE: COMMIT_AT,
      },
    });
  }

  it('a git-TRACKED issue file derives trackerUpdatedAt from git history, not mtime — a fresh clone must not read as freshly updated', async () => {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);

    const id = await store.create(baseInput({ filingHint: 'tracked-thing' }));
    const path = issuePath('01-tracked-thing.md');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);

    // Simulate exactly what a fresh clone / file copy does to a tracked file:
    // reset its mtime to "now", long after the pinned commit date above.
    const freshNow = new Date();
    utimesSync(path, freshNow, freshNow);

    const view = await store.read(id);
    expect(view.trackerUpdatedAt).toBeDefined();
    // Must read back the pinned commit year — never the fresh "now" mtime.
    expect(new Date(view.trackerUpdatedAt as string).getUTCFullYear()).toBe(2020);
    expect(new Date(view.trackerUpdatedAt as string).getTime()).toBeLessThan(
      freshNow.getTime() - 1000 * 60 * 60,
    );
  });

  it("an UNTRACKED issue file (gitignored .scratch/ — this repo's own dogfood case) keeps a working mtime-based signal", async () => {
    git(['init', '-q']);
    await writeFile(join(root, '.gitignore'), '.scratch/\n', 'utf-8');

    const before = Date.now();
    const id = await store.create(baseInput({ filingHint: 'scratch-thing' }));
    const view = await store.read(id);

    expect(view.trackerUpdatedAt).toBeDefined();
    expect(new Date(view.trackerUpdatedAt as string).getTime()).toBeGreaterThanOrEqual(
      before - 5000,
    );
  });

  it('a git-tracked file with no commit history yet (staged only) has no derivable signal — stays absent, never falls back to mtime', async () => {
    git(['init', '-q']);

    const id = await store.create(baseInput({ filingHint: 'staged-only' }));
    const path = issuePath('01-staged-only.md');
    git(['add', path]); // staged → tracked, but zero commits reach it

    const view = await store.read(id);
    expect(view.trackerUpdatedAt).toBeUndefined();
  });

  it('a repoRoot that is not a git checkout at all falls back to mtime (git cannot know a file it has no repository for)', async () => {
    // No `git init` here at all — mirrors the pre-existing (non-git) behavior
    // every other test in this file already exercises implicitly.
    const before = Date.now();
    const id = await store.create(baseInput({ filingHint: 'no-git-thing' }));
    const view = await store.read(id);

    expect(view.trackerUpdatedAt).toBeDefined();
    expect(new Date(view.trackerUpdatedAt as string).getTime()).toBeGreaterThanOrEqual(
      before - 5000,
    );
  });
});

describe('MarkdownFsStore — Triage facet (ADR-0015)', () => {
  const triRoots: string[] = [];
  afterAll(async () => {
    await Promise.all(triRoots.map((r) => rm(r, { recursive: true, force: true })));
  });
  async function freshStore() {
    const root = await mkdtemp(join(tmpdir(), 'mdtriage-'));
    triRoots.push(root);
    return new MarkdownFsStore({ repoRoot: root, slug: 'tri' });
  }
  function tInput(overrides: Partial<CreateInput> = {}): CreateInput {
    return {
      title: 'A slice',
      filingHint: 'a-slice',
      risk: 'mechanical',
      worker: 'background',
      files: ['src/x.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'does the thing', checked: false }],
      ...overrides,
    };
  }

  it('applyTriage sets state (the **Status:** field) + category + comment; readTriage round-trips', async () => {
    const store = await freshStore();
    const id = await store.create(tInput());
    await store.applyTriage(id, { state: 'needs-info', category: 'bug', comment: 'need a repro' });
    const t = await store.readTriage(id);
    expect(t.state).toBe('needs-info');
    expect(t.category).toBe('bug');
    expect(t.comments[0].body).toBe('> *This was generated by AI during triage.*\n\nneed a repro');
  });

  it('flipping state to a non-eligibility state removes it from listOpen; flipping back restores it', async () => {
    const store = await freshStore();
    const id = await store.create(tInput()); // create stamps `ready-for-agent` → eligible
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).toContain(id);
    await store.applyTriage(id, { state: 'needs-info' });
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(id);
    await store.applyTriage(id, { state: 'ready-for-agent' });
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).toContain(id);
  });

  it('two comments round-trip oldest-first', async () => {
    const store = await freshStore();
    const id = await store.create(tInput());
    await store.applyTriage(id, { comment: 'first' });
    await store.applyTriage(id, { comment: 'second' });
    const bodies = (await store.readTriage(id)).comments.map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('first');
    expect(bodies[1]).toContain('second');
  });

  it('closeUnplanned sets wontfix + comment and natively closes (status done)', async () => {
    const store = await freshStore();
    const id = await store.create(tInput());
    await store.closeUnplanned(id, 'out of scope');
    expect((await store.read(id)).status).toBe('done');
    expect((await store.readTriage(id)).state).toBe('wontfix');
    expect((await store.readTriage(id)).comments[0].body).toContain('out of scope');
  });

  it('readTriage throws on an unknown id', async () => {
    const store = await freshStore();
    await expect(store.readTriage('tri#999')).rejects.toThrow();
  });

  // The report-read path must survive issue files this store did NOT author —
  // triage's whole job is surfacing *incoming* reports (ADR-0015). create()
  // always writes an `# NN — title` H1, so these need raw files.
  async function storeWithRawIssue(fileName: string, content: string) {
    const root = await mkdtemp(join(tmpdir(), 'mdtriage-'));
    triRoots.push(root);
    const dir = join(root, '.scratch', 'tri', 'issues');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), content, 'utf-8');
    return new MarkdownFsStore({ repoRoot: root, slug: 'tri' });
  }

  it('readTriage surfaces the full body even when the issue file has no H1 (no silent drop)', async () => {
    const store = await storeWithRawIssue(
      '05-no-h1.md',
      '**Status:** ready-for-agent\n\nThe login button does nothing when clicked.\n',
    );
    expect((await store.readTriage('tri#05')).body).toContain(
      'The login button does nothing when clicked.',
    );
  });

  it('readTriage strips only the NN filing prefix, never a real title that starts with digits', async () => {
    const store = await storeWithRawIssue(
      '03-orwell.md',
      '# 1984 — a novel reference\n\nSome report prose.\n',
    );
    expect((await store.readTriage('tri#03')).title).toBe('1984 — a novel reference');
  });
});
