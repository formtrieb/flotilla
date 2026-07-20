/**
 * spine-store.ts — the single read/write seam onto the WAVE.md orchestration
 * spine (CHARTER §6). A thin, byte-preserving wrapper over the EXISTING
 * wave-md-rw string→string primitives: it reimplements nothing, delegates every
 * mutation, and re-parses after each write so callers never touch readSpine /
 * setRowState directly.
 *
 * The spine is the durable write-ahead log that makes resume possible (ADR-0002):
 * the caller commits intent (setRowState / upsertDispatchLogEntry) BEFORE the
 * irreversible side-effect (worktree create, worker spawn), so a kill between the
 * two is recoverable.
 */

import {
  readSpine,
  setRowState,
  setRowPrCell,
  upsertPrLogRow,
  upsertDispatchLogEntry,
  upsertDispatchLogModel,
  replaceClosedByBlock,
  setFrontmatterStatus,
  branchesByIssueId,
  type Spine,
  type RowState,
  type PrLogRowInput,
} from './wave-md-rw';

/** Injected fs seam — mirrors the engine's defaultXxxProbe idiom. */
export interface SpineIo {
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface SpineStore {
  /** Current structured view (re-parsed after each write). */
  spine(): Spine;
  /** Current mutated source, ready for disk (byte-identical on a no-op). */
  source(): string;
  /** Re-read from disk (rebinds source + spine); for human-edit-between-ops recovery. */
  reload(): void;
  /** Persist source() to disk via the injected SpineIo. */
  flush(): void;

  setRowState(id: string, state: RowState): void;
  setRowPrCell(id: string, prCell: string): void;
  upsertPrLogRow(input: PrLogRowInput): void;
  /** The dispatch-log is the DURABLE branch home; Plan-Table.branch is derived-only. */
  upsertDispatchLogEntry(id: string, branch: string): void;
  /** Record the actually-dispatched model in the dispatch-log (ADR-0012); co-exists with the branch. */
  upsertDispatchLogModel(id: string, model: string): void;
  replaceClosedByBlock(body: string): void;
  setFrontmatterStatus(status: string): void;

  branchesByIssueId(): Record<string, string>;
  rowState(id: string): RowState | string | null;
}

/** Construct a SpineStore over a source string (pure — no disk). */
export function spineStoreFromSource(initial: string, path?: string, io?: SpineIo): SpineStore {
  let src = initial;
  let parsed = readSpine(src);

  const rebind = (next: string) => {
    src = next;
    parsed = readSpine(src);
  };

  return {
    spine: () => parsed,
    source: () => src,
    reload() {
      if (!io || !path) throw new Error('reload() requires a disk-backed SpineStore');
      rebind(io.read(path));
    },
    flush() {
      if (!io || !path) throw new Error('flush() requires a disk-backed SpineStore');
      io.write(path, src);
    },
    setRowState(id, state) {
      rebind(setRowState(src, id, state));
    },
    setRowPrCell(id, prCell) {
      rebind(setRowPrCell(src, id, prCell));
    },
    upsertPrLogRow(input) {
      rebind(upsertPrLogRow(src, input));
    },
    upsertDispatchLogEntry(id, branch) {
      rebind(upsertDispatchLogEntry(src, id, branch));
    },
    upsertDispatchLogModel(id, model) {
      rebind(upsertDispatchLogModel(src, id, model));
    },
    replaceClosedByBlock(body) {
      rebind(replaceClosedByBlock(src, body));
    },
    setFrontmatterStatus(status) {
      rebind(setFrontmatterStatus(src, status));
    },
    branchesByIssueId: () => branchesByIssueId(parsed),
    rowState: (id) => parsed.planTable.find((r) => r.id === id)?.state ?? null,
  };
}

/** Node fs-backed SpineIo (the only disk-touching code; isolated here). */
export function defaultSpineIo(): SpineIo {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    read: (p) => fs.readFileSync(p, 'utf-8'),
    write: (p, c) => fs.writeFileSync(p, c, 'utf-8'),
  };
}

/** Construct a disk-backed SpineStore (reads `path` now via `io`). */
export function createSpineStore(path: string, io: SpineIo = defaultSpineIo()): SpineStore {
  return spineStoreFromSource(io.read(path), path, io);
}
