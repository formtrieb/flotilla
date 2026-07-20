import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSpine, readSpine } from './wave-md-rw';
import { runSpine } from './spine-cli';
import { resume, type ResumeInputs } from './resume';
import type { WorktreeEntry } from './worktree-cleanup';
import type { SidecarIndex } from './sidecar';

const NO_SIDECARS: SidecarIndex = {
  reportFor: () => null,
  verdictFor: () => null,
  corruptFor: () => [],
};

// The real dispatch wire: render a fresh spine (spine create), then record the
// branch via the CLI verb (what wave-start's WAL calls) — NO hand-authored
// dispatch-log. This is the seam resume.spec.ts's spineFor() fixture bypasses.
it('resume adopts a committed worktree when the branch was recorded via the real render→set-branch wire', () => {
  const meta = {
    slug: 'demo', description: 'a demo wave', coordinator: 'at',
    model: 'Opus 4.8', created: '2026-07-15', lastUpdated: '2026-07-15 10:00 CEST',
  };
  const roster = [{ id: 'DES-21', title: 'First', worker: 'background', risk: 'mechanical' }];
  const conflict = { issues: ['DES-21'], cells: [] };

  const dir = mkdtempSync(join(tmpdir(), 'seam-'));
  const path = join(dir, 'WAVE.md');
  writeFileSync(path, renderSpine(meta, roster, conflict, 'ok.'), 'utf-8');

  // wave-start's dispatch WAL: fine-state first, then the branch.
  expect(runSpine(['set-row-state', path, 'DES-21', 'dispatched'])).toBe(0);
  expect(runSpine(['set-branch', path, 'DES-21', 'wave/DES-21-api-error'])).toBe(0);

  const spine = readSpine(readFileSync(path, 'utf-8'));
  const worktree: WorktreeEntry = {
    path: '/repo/.claude/worktrees/wf-1', branch: 'wave/DES-21-api-error', head: 'abc1234', dirty: false,
  };
  const inputs: ResumeInputs = { spine, worktrees: [worktree], sidecars: NO_SIDECARS };

  const row = resume(inputs).rows.find((r) => r.id === 'DES-21')!;
  expect(row.decision).toBe('adopt'); // was 'redispatch' before the branch was durably recorded
  expect(row.worktree).not.toBeNull();
});
