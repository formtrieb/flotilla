import { describe, it, expect, vi } from 'vitest';
import { runResume, type ResumeDeps } from './resume-cli';
// The router, imported ONLY to pin that `{{wave-cli}} resume` reaches THIS
// module's runner (issue #77). Every assertion using it stays on the
// missing-flag path, so no disk/git is ever touched from here.
import { main } from './cli';
import { spineStoreFromSource } from './spine-store';
import type { ResumeInputs } from './resume';
import type { SidecarIndex } from './sidecar';
import type { WorktreeEntry, RedispatchCleanupOps } from './worktree-cleanup';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A minimal valid WAVE.md spine (copied from resume.spec.ts) with two rows so
 *  resume() yields a non-empty `rows` array. */
function fakeSpine(): ResumeInputs['spine'] {
  const rows = [
    { id: '01', state: 'planned' },
    { id: '09', state: 'pr-created' },
  ];
  const tableRows = rows
    .map(
      (r) =>
        `| ${r.id} | T ${r.id} | background | mechanical | quick-verify | — | ${r.state} | 1 | — |`,
    )
    .join('\n');
  const dispatch = rows
    .map((r) => `  - "${r.id} → agent a${r.id} (sonnet)  branch wave-orch/${r.id}-thing"`)
    .join('\n');
  const src = `# Wave 2026-06-06 — test

**Status:** in-flight

## Plan-Table

| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |
| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |
${tableRows}

## PR-Log

| Created | ID | PR | Closes | Merged | Notes |
| ------- | -- | -- | ------ | ------ | ----- |
| — | — | — | — | — | _(none)_ |

## Resume-Metadata

\`\`\`yaml
dispatch-log:
${dispatch}
\`\`\`
`;
  return spineStoreFromSource(src).spine();
}

const emptySidecars: SidecarIndex = {
  reportFor: () => null,
  verdictFor: () => null,
  corruptFor: () => [],
};

function fakeDeps(over: Partial<ResumeDeps> = {}): ResumeDeps {
  return {
    parseSpine: () => fakeSpine(),
    listWorktrees: () => [],
    readSidecars: () => emptySidecars,
    listAllWorktrees: () => [],
    ...over,
  };
}

const REQUIRED = ['--spine', '/x', '--reports', '/r', '--verdicts', '/v'];

/** Fixture: row '01' is `planned` with no worktree/sidecar → decision 'redispatch'.
 *  Row '09' is `pr-created` → TERMINAL → decision 'keep'. See fakeSpine() above. */
const REDISPATCH_BRANCH = 'wave-orch/01-thing';
const KEEP_BRANCH = 'wave-orch/09-thing';

/** Build a fake `RedispatchCleanupOps` backed by vitest spies. */
function fakeCleanupOps(): RedispatchCleanupOps {
  return {
    unlock: vi.fn(),
    remove: vi.fn(),
    deleteBranch: vi.fn(),
  };
}

describe('runResume — CLI shell over the pure resume() reconciler', () => {
  it('assembles inputs via deps, prints ResumeResult JSON, returns 0', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = runResume(REQUIRED, fakeDeps());
      expect(code).toBe(0);

      const printed = out.mock.calls.map((c) => String(c[0])).join('');
      const result = JSON.parse(printed);

      expect(result).toHaveProperty('rows');
      expect(result).toHaveProperty('fatals');
      // matches the 2-row fixture
      expect(result.rows).toHaveLength(2);
      const decisions = new Set(['adopt', 'redispatch', 'keep', 'needs-attention']);
      for (const row of result.rows) {
        expect(decisions.has(row.decision)).toBe(true);
      }
    } finally {
      out.mockRestore();
    }
  });

  it('missing --spine → usage to stderr, returns 2', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = runResume(['--reports', '/r', '--verdicts', '/v'], fakeDeps());
      expect(code).toBe(2);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('missing --reports → returns 2', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(runResume(['--spine', '/x', '--verdicts', '/v'], fakeDeps())).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it('missing --verdicts → returns 2', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(runResume(['--spine', '/x', '--reports', '/r'], fakeDeps())).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it('a deps that throws during assembly → error to stderr, returns 1', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = fakeDeps({
        parseSpine: () => {
          throw new Error('bad spine');
        },
      });
      const code = runResume(REQUIRED, deps);
      expect(code).toBe(1);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

// ─── one runner behind both spellings (FOR-11 → issue #77) ───────────────────
//
// `resume` is now reachable as `{{wave-cli}} resume` (the canonical spelling)
// AND, as a retained alias, as `npx tsx tools/wave/src/resume-cli.ts …`. FOR-11
// had removed the router case precisely to kill a two-entrypoint ambiguity
// (docs/retros/2026-07-15-wire-contract.md, P-12); what keeps that ambiguity
// from returning is that the router does not re-implement anything — it calls
// `runResume` below. These specs pin both halves of that: the router really
// lands here, and this runner's own messages stay entrypoint-agnostic so one
// message is correct for both spellings.

describe('resume — one runner, two spellings (issue #77)', () => {
  it('the missing-flag usage names no module/entrypoint, so it reads correctly from either spelling', () => {
    let stderrBuf = '';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrBuf += String(c);
      return true;
    });
    try {
      expect(runResume(['--spine', '/x', '--reports', '/r'], fakeDeps())).toBe(2);
      expect(stderrBuf).toMatch(/usage: resume --spine/);
      // A hardcoded entrypoint here would be wrong for whichever caller it does
      // not name — the whole reason the alias arrangement is safe.
      expect(stderrBuf).not.toMatch(/resume-cli\.ts/);
      expect(stderrBuf).not.toMatch(/cli\.ts/);
    } finally {
      err.mockRestore();
    }
  });

  it('`{{wave-cli}} resume` reaches THIS runner — a missing flag surfaces its usage, not an unknown-subcommand error', () => {
    let stderrBuf = '';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrBuf += String(c);
      return true;
    });
    try {
      // `--verdicts` is absent, so the router hands off and this module's own
      // missing-flag guard answers — before any disk or git access.
      const code = main(['resume', '--spine', '/x', '--reports', '/r']);
      expect(code).toBe(2);
      expect(stderrBuf).toMatch(/--spine, --reports and --verdicts are required/);
      expect(stderrBuf).not.toMatch(/unknown subcommand/);
    } finally {
      err.mockRestore();
    }
  });
});

// ─── crash-cleanup before redispatch (FOR-10) ────────────────────────────────

describe('runResume — crash-cleanup of a redispatch row before handback (FOR-10)', () => {
  it('a redispatch row\'s crashed (locked) worktree is unlocked + removed and the branch deleted', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cleanupOps = fakeCleanupOps();
    const crashedWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-01-1',
      branch: REDISPATCH_BRANCH,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty: false,
      locked: true,
    };
    try {
      const deps = fakeDeps({
        listAllWorktrees: () => [crashedWorktree],
        cleanup: cleanupOps,
      });

      const code = runResume(REQUIRED, deps);
      expect(code).toBe(0);

      expect(cleanupOps.unlock).toHaveBeenCalledWith(crashedWorktree.path);
      expect(cleanupOps.remove).toHaveBeenCalledWith(crashedWorktree.path, { force: false });
      expect(cleanupOps.deleteBranch).toHaveBeenCalledWith(REDISPATCH_BRANCH);
      // The 'keep' row's branch must never be touched by crash-cleanup.
      expect(cleanupOps.deleteBranch).not.toHaveBeenCalledWith(KEEP_BRANCH);

      const printed = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
      expect(printed.cleanup).toHaveLength(1);
      expect(printed.cleanup[0]).toMatchObject({
        branch: REDISPATCH_BRANCH,
        worktreeRemoved: true,
        branchDeleted: true,
        blockedByDirty: false,
      });
    } finally {
      out.mockRestore();
    }
  });

  it('a dirty crashed worktree WITHOUT --force is refused (work-preservation) — never touched', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cleanupOps = fakeCleanupOps();
    const dirtyWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-01-1',
      branch: REDISPATCH_BRANCH,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty: true,
      locked: false,
    };
    try {
      const deps = fakeDeps({
        listAllWorktrees: () => [dirtyWorktree],
        cleanup: cleanupOps,
      });

      const code = runResume(REQUIRED, deps);
      expect(code).toBe(0);

      expect(cleanupOps.unlock).not.toHaveBeenCalled();
      expect(cleanupOps.remove).not.toHaveBeenCalled();
      expect(cleanupOps.deleteBranch).not.toHaveBeenCalled();

      const printed = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
      expect(printed.cleanup[0]).toMatchObject({
        branch: REDISPATCH_BRANCH,
        worktreeRemoved: false,
        blockedByDirty: true,
      });
    } finally {
      out.mockRestore();
    }
  });

  it('--force allows a dirty crashed worktree to be destroyed on explicit confirmation', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cleanupOps = fakeCleanupOps();
    const dirtyWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-01-1',
      branch: REDISPATCH_BRANCH,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty: true,
      locked: false,
    };
    try {
      const deps = fakeDeps({
        listAllWorktrees: () => [dirtyWorktree],
        cleanup: cleanupOps,
      });

      const code = runResume([...REQUIRED, '--force'], deps);
      expect(code).toBe(0);

      expect(cleanupOps.remove).toHaveBeenCalledWith(dirtyWorktree.path, { force: true });
      expect(cleanupOps.deleteBranch).toHaveBeenCalledWith(REDISPATCH_BRANCH);

      const printed = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
      expect(printed.cleanup[0]).toMatchObject({
        worktreeRemoved: true,
        blockedByDirty: false,
      });
    } finally {
      out.mockRestore();
    }
  });

  it('no matching worktree → idempotent no-op cleanup entry (still attempts branch delete)', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cleanupOps = fakeCleanupOps();
    try {
      const deps = fakeDeps({ listAllWorktrees: () => [], cleanup: cleanupOps });

      const code = runResume(REQUIRED, deps);
      expect(code).toBe(0);

      expect(cleanupOps.unlock).not.toHaveBeenCalled();
      expect(cleanupOps.remove).not.toHaveBeenCalled();
      expect(cleanupOps.deleteBranch).toHaveBeenCalledWith(REDISPATCH_BRANCH);

      const printed = JSON.parse(out.mock.calls.map((c) => String(c[0])).join(''));
      expect(printed.cleanup[0]).toMatchObject({
        worktreePath: null,
        worktreeRemoved: false,
        branchDeleted: true,
      });
    } finally {
      out.mockRestore();
    }
  });

  it('running twice in a row is idempotent — the second run (post-cleanup state) does not error', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // First run: a crashed worktree is present.
      const firstOps = fakeCleanupOps();
      const crashedWorktree: WorktreeEntry = {
        path: '/repo/.claude/worktrees/wf_deadbeef-01-1',
        branch: REDISPATCH_BRANCH,
        head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        dirty: false,
        locked: false,
      };
      const code1 = runResume(REQUIRED, fakeDeps({
        listAllWorktrees: () => [crashedWorktree],
        cleanup: firstOps,
      }));
      expect(code1).toBe(0);

      // Second run: a fresh listing after removal finds nothing for this branch.
      const secondOps = fakeCleanupOps();
      const code2 = runResume(REQUIRED, fakeDeps({
        listAllWorktrees: () => [],
        cleanup: secondOps,
      }));
      expect(code2).toBe(0);

      expect(secondOps.remove).not.toHaveBeenCalled();
      expect(secondOps.deleteBranch).toHaveBeenCalledWith(REDISPATCH_BRANCH);
    } finally {
      out.mockRestore();
    }
  });

  it('never invokes cleanup ops for a non-redispatch (keep/terminal) row\'s branch', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cleanupOps = fakeCleanupOps();
    // A worktree that happens to sit on the KEEP row's branch must never be touched.
    const keepWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-09-1',
      branch: KEEP_BRANCH,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty: false,
      locked: true,
    };
    try {
      const deps = fakeDeps({
        listAllWorktrees: () => [keepWorktree],
        cleanup: cleanupOps,
      });

      const code = runResume(REQUIRED, deps);
      expect(code).toBe(0);

      expect(cleanupOps.unlock).not.toHaveBeenCalled();
      expect(cleanupOps.remove).not.toHaveBeenCalled();
      expect(cleanupOps.deleteBranch).not.toHaveBeenCalledWith(KEEP_BRANCH);
    } finally {
      out.mockRestore();
    }
  });
});
