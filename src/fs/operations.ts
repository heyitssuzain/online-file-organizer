/**
 * AuraFlow Web — execute & undo operations
 *
 * Writes happen ONLY after explicit user confirmation, and only into the folder
 * the user granted "read & write" permission for. Every true move is journaled
 * so the session can be undone in one click, and the journal ships inside the
 * downloadable manifest.
 *
 * Move semantics (and their limits):
 *  1. The browser writes a full copy of the file into the destination.
 *  2. The destination is read back and its size is verified.
 *  3. Only then is the original removed — and only if a source handle and its
 *     parent directory handle were captured during the scan.
 *
 * If any step fails, the original is left untouched. Browsers whose
 * FileSystemFileHandle.move() only works in the origin-private filesystem fall
 * back to this verified copy-then-remove path. When removal is impossible the
 * run is reported honestly as a copy, never as a move.
 */

import type { DirHandle } from './access.js';
import { createManifest, Manifest, MoveRecord, SkipRecord, ErrorRecord } from '../core/manifest.js';
import type { Plan, PlanEntry } from '../core/plan.js';
import { splitName } from '../core/naming.js';

export type ExecMode = 'move' | 'copy';

export interface SourceMeta {
  /** Relative path inside the scanned root (kept for nested moves/undo). */
  path?: string;
  handle?: FileSystemFileHandle;
  parent?: DirHandle;
}

export type SourceMap = ReadonlyMap<File, SourceMeta>;

export interface ExecuteOptions {
  mode?: ExecMode;
  sources?: SourceMap;
  /** Root the files were scanned from (used to detect same-folder no-ops). */
  sourceRoot?: DirHandle;
  /** Rule label for the run manifest/report. */
  rule?: string;
}

export interface ExecEvents {
  onProgress?: (done: number, total: number, current: string) => void;
}

export interface UndoRecord {
  /** Relative path the file came from (may include subfolders). */
  from: string;
  /** Relative path it was moved to. */
  to: string;
  /** Copies are not undone; the original was intentionally kept. */
  copy?: boolean;
}

export interface ExecResult {
  manifest: Manifest;
  undo: UndoRecord[];
}

export class OpSession {
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
  }
}

async function ensureFolder(dir: DirHandle, segments: readonly string[]): Promise<DirHandle> {
  let target = dir;
  for (const seg of segments) target = await target.getDirectoryHandle(seg, { create: true });
  return target;
}

type WritableFormat = {
  write(d: BlobPart): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

type MovableFileHandle = FileSystemFileHandle & {
  move?: (dest: FileSystemDirectoryHandle, name?: string) => Promise<void>;
};

export async function executePlan(
  plan: Plan,
  targetRoot: DirHandle,
  root: string,
  events?: ExecEvents,
  session?: OpSession,
  options: ExecuteOptions = {},
): Promise<ExecResult> {
  const manifest = createManifest(root, options.rule ?? 'type');
  const undo: ExecResult['undo'] = [];
  const s = session ?? new OpSession();
  const mode: ExecMode = options.mode ?? 'move';
  const sources = options.sources;

  const sameRoot = options.sourceRoot
    ? targetRoot === options.sourceRoot ||
      (!!targetRoot.isSameEntry &&
        (await targetRoot.isSameEntry(options.sourceRoot as unknown as FileSystemHandle).catch(() => false)))
    : false;

  const active = plan.entries.filter((e) => !e.skip);
  const total = active.length;
  let done = 0;

  const byFolder = new Map<string, PlanEntry[]>();
  for (const e of active) {
    const folder = e.destination.join('/');
    let list = byFolder.get(folder);
    if (!list) byFolder.set(folder, (list = []));
    list.push(e);
  }

  for (const [folder, entries] of byFolder) {
    if (s.cancelled) {
      manifest.errors.push(cancelNote());
      break;
    }

    let target: DirHandle | null = null;
    try {
      target = await ensureFolder(targetRoot, folder.split('/'));
    } catch (err) {
      for (const e of entries) {
        manifest.errors.push({ file: e.name, message: `Could not create folder "${folder}": ${msg(err)}` } as ErrorRecord);
        done++;
        events?.onProgress?.(done, total, e.name);
      }
      continue;
    }

    for (const e of entries) {
      if (s.cancelled) {
        manifest.errors.push(cancelNote());
        break;
      }
      events?.onProgress?.(done, total, e.name);
      try {
        await executeOne(e, target, folder, mode, sources, sameRoot, manifest, undo);
      } catch (err) {
        manifest.errors.push({ file: e.name, message: msg(err) } as ErrorRecord);
      }
      done++;
    }
    if (s.cancelled) break;
  }

  for (const e of plan.entries) {
    if (!e.skip) continue;
    manifest.skipped.push({ file: sources?.get(e.file)?.path ?? e.name, reason: e.skip } as SkipRecord);
  }

  return { manifest, undo };
}

async function executeOne(
  e: PlanEntry,
  target: DirHandle,
  folder: string,
  mode: ExecMode,
  sources: SourceMap | undefined,
  sameRoot: boolean,
  manifest: Manifest,
  undo: ExecResult['undo'],
): Promise<void> {
  const source = sources?.get(e.file);
  const sourcePath = source?.path ?? e.name;

  // Already at the exact destination (e.g. a file picked from Images/ and
  // sorted by type into Images/): do not copy onto itself, and never delete it.
  if (sameRoot && sourcePath === `${folder}/${e.finalName}`) {
    manifest.skipped.push({ file: sourcePath, reason: 'already-organized' } as SkipRecord);
    return;
  }

  const actualName = await availableName(target, e.finalName);
  const to = `${folder}/${actualName}`;
  const existed = await entryExists(target, actualName);

  let dest: FileSystemFileHandle | null = null;
  try {
    dest = await target.getFileHandle(actualName, { create: true });
    await writeVerified(e.file, dest);
  } catch (err) {
    // Never leave a partial/empty destination behind after a failed write.
    if (dest && !existed && target.removeEntry) {
      try {
        await target.removeEntry(actualName);
      } catch {
        /* best effort — the original is still untouched */
      }
    }
    throw err;
  }

  const baseRecord = { from: sourcePath, to, category: e.category, size: e.size } as MoveRecord;

  if (mode === 'copy') {
    manifest.moves.push({ ...baseRecord, note: 'copied — original kept' });
    return;
  }

  if (!source?.handle || !source.parent?.removeEntry) {
    manifest.moves.push({ ...baseRecord, note: 'copied — original kept (source folder cannot be modified)' });
    return;
  }

  // Do not delete a file that changed after the scan: the verified copy on disk
  // may no longer represent the current original.
  try {
    const current = await source.handle.getFile();
    if (current.size !== e.file.size || current.lastModified !== e.file.lastModified) {
      manifest.moves.push({
        ...baseRecord,
        note: 'copied — original kept (it changed after the scan; run again to move the current version)',
      });
      return;
    }
  } catch (err) {
    manifest.moves.push({
      ...baseRecord,
      note: `copied — original kept (could not re-check source: ${msg(err)})`,
    });
    return;
  }

  try {
    // The name may now belong to a different file (renamed/recreated after the
    // scan). Only remove it when it is still the exact entry we copied.
    const currentHandle = await source.parent.getFileHandle(source.handle.name);
    if (
      currentHandle.isSameEntry &&
      !(await currentHandle.isSameEntry(source.handle).catch(() => false))
    ) {
      throw new Error('source entry changed after the scan');
    }

    await source.parent.removeEntry(source.handle.name);
    // Confirm the entry is really gone before claiming a move.
    if (await entryExists(source.parent, source.handle.name)) {
      throw new Error('source still exists after removal');
    }
  } catch (err) {
    manifest.moves.push({
      ...baseRecord,
      note: `copied — original kept (could not remove source: ${msg(err)})`,
    });
    return;
  }

  manifest.moves.push(baseRecord);
  undo.push({ from: sourcePath, to });
}

/** Write the whole file, close, then read it back and verify its size. */
async function writeVerified(src: File, dest: FileSystemFileHandle): Promise<void> {
  const writable = await (
    dest as unknown as { createWritable(): Promise<WritableFormat> }
  ).createWritable();
  try {
    await writable.write(src);
  } finally {
    await writable.close();
  }

  const written = await dest.getFile();
  if (written.size !== src.size) {
    throw new Error(
      `Destination verification failed (expected ${src.size} bytes, found ${written.size}). The original was not removed.`,
    );
  }
}

/** Find a free filename without ever opening an existing file for writing. */
async function availableName(dir: DirHandle, desired: string): Promise<string> {
  const { stem, ext } = splitName(desired);
  if (!(await entryExists(dir, desired))) return desired;
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!(await entryExists(dir, candidate))) return candidate;
  }
  throw new Error(`Could not find a free filename for "${desired}" (too many conflicts).`);
}

async function entryExists(dir: DirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    const name = errName(err);
    if (name === 'NotFoundError') return false;
    // A directory with the same name also makes the name unavailable.
    if (name === 'TypeMismatchError') return true;
    throw err;
  }
}

/**
 * Undo the true moves of a session: move each file back to its original
 * location, creating intermediate folders when the original nested, then drop
 * destination folders that became empty. Cross-folder runs pass both roots.
 */
export async function undoMoves(
  records: readonly UndoRecord[],
  destRoot: DirHandle,
  sourceRoot: DirHandle = destRoot,
  events?: { onProgress?: (done: number, total: number, current: string) => void },
): Promise<{ restored: number; failed: Array<{ file: string; message: string }> }> {
  const failed: Array<{ file: string; message: string }> = [];
  let restored = 0;
  let done = 0;
  const undoable = records.filter((r) => !r.copy);
  const total = undoable.length;

  for (const rec of undoable) {
    const destSegs = rec.to.split('/');
    const destName = destSegs.pop()!;
    try {
      let cur = destRoot;
      for (const seg of destSegs) cur = await cur.getDirectoryHandle(seg);
      const src = await cur.getFileHandle(destName);

      const fromSegs = rec.from.split('/');
      const fromName = fromSegs.pop()!;
      let back = sourceRoot;
      for (const seg of fromSegs) {
        back = await back.getDirectoryHandle(seg, { create: true });
      }
      const targetName = await availableName(back, fromName);

      let moved = false;
      const movable = src as MovableFileHandle;
      if (typeof movable.move === 'function') {
        try {
          // Native move works for OPFS; local user-picked files may reject it.
          await movable.move.call(src, back as unknown as FileSystemDirectoryHandle, targetName);
          moved = true;
        } catch {
          moved = false; // verified copy + remove below
        }
      }

      if (!moved) {
        const d = await back.getFileHandle(targetName, { create: true });
        const f = await src.getFile();
        await writeVerified(f, d);
        if (!cur.removeEntry) throw new Error('destination folder cannot be modified (undo not supported)');
        const check = await cur.getFileHandle(destName);
        if (check.isSameEntry && !(await check.isSameEntry(src).catch(() => false))) {
          throw new Error('destination entry changed before undo removal');
        }
        await cur.removeEntry(destName);
      }
      restored++;
    } catch (err) {
      failed.push({ file: rec.from, message: msg(err) });
    }
    done++;
    events?.onProgress?.(done, total, rec.from);
  }

  // Remove now-empty destination folders (only direct children of the root).
  const tops = [...new Set(undoable.map((r) => r.to.split('/')[0]!))];
  for (const top of tops) {
    try {
      const sub = await destRoot.getDirectoryHandle(top);
      if (!(await hasChildren(sub))) await destRoot.removeEntry?.(top);
    } catch {
      /* folder never existed or still has files */
    }
  }

  return { restored, failed };
}

async function hasChildren(dir: DirHandle): Promise<boolean> {
  if (!dir.values) return true; // cannot verify — assume non-empty (safe)
  let seen = false;
  for await (const _ of dir.values()) {
    void _;
    seen = true;
    break;
  }
  return seen;
}

function errName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cancelNote(): ErrorRecord {
  return { file: '(remaining files)', message: 'Operation cancelled — no further files were moved.' };
}
