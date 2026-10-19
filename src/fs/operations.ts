/**
 * AuraFlow Web — execute & undo operations
 *
 * Writes happen ONLY after explicit user confirmation, and only into the folder
 * the user granted "read & write" permission for. Every move is journaled so
 * the session can be undone in one click (desktop parity with the desktop's
 * OperationTracker), and the journal ships inside the downloadable manifest.
 *
 * The app must never pretend to do something the browser cannot do: when
 * direct folder writes are unavailable (Firefox/Safari), the caller falls back
 * to the ZIP-download path instead of calling executePlan.
 */

import type { DirHandle } from './access.js';
import { createManifest, Manifest, MoveRecord, SkipRecord, ErrorRecord } from '../core/manifest.js';
import type { Plan, PlanEntry } from '../core/plan.js';

export interface ExecEvents {
  onProgress?: (done: number, total: number, current: string) => void;
}

export interface UndoRecord {
  /** Relative path the file came from (may include subfolders). */
  from: string;
  /** Relative path it was moved to. */
  to: string;
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

interface HandledEntry extends PlanEntry {
  handle?: FileSystemFileHandle;
}

/** Attach the file-system handle so executePlan can move without re-lookup. */
export function withHandle(entry: PlanEntry, handle: FileSystemFileHandle): PlanEntry {
  return Object.assign({}, entry, { handle }) as HandledEntry;
}

async function ensureFolder(dir: DirHandle, segments: readonly string[]): Promise<DirHandle> {
  let target = dir;
  for (const seg of segments) target = await target.getDirectoryHandle(seg, { create: true });
  return target;
}

export async function executePlan(
  plan: Plan,
  dir: DirHandle,
  root: string,
  events?: ExecEvents,
  session?: OpSession,
  /** Original parent handle per file (collected during the scan) for true moves. */
  parents?: ReadonlyMap<File, DirHandle>,
): Promise<ExecResult> {
  const manifest = createManifest(root, 'user-confirmed');
  const undo: ExecResult['undo'] = [];
  const s = session ?? new OpSession();

  const active = plan.entries.filter((e) => !e.skip);
  const total = active.length;
  let done = 0;

  const byFolder = new Map<string, HandledEntry[]>();
  for (const e of active) {
    const folder = e.destination.join('/');
    let list = byFolder.get(folder);
    if (!list) byFolder.set(folder, (list = []));
    list.push(e as HandledEntry);
  }

  for (const [folder, entries] of byFolder) {
    if (s.cancelled) {
      manifest.errors.push(cancelNote());
      break;
    }

    let target: DirHandle | null = null;
    try {
      target = await ensureFolder(dir, folder.split('/'));
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
        await moveOne(e, parents?.get(e.file), target!, folder, manifest, undo);
      } catch (err) {
        manifest.errors.push({ file: e.name, message: msg(err) } as ErrorRecord);
      }
      done++;
    }
    if (s.cancelled) break;
  }

  for (const e of plan.entries) {
    if (!e.skip) continue;
    manifest.skipped.push({ file: e.name, reason: e.skip } as SkipRecord);
  }

  return { manifest, undo };
}

async function moveOne(
  e: HandledEntry,
  srcParent: DirHandle | undefined,
  target: DirHandle,
  folder: string,
  manifest: Manifest,
  undo: ExecResult['undo'],
): Promise<void> {
  const from = relativeFrom(e);
  const to = `${folder}/${e.finalName}`;

  const canMove =
    srcParent !== undefined &&
    e.handle !== undefined &&
    typeof target.move === 'function' &&
    typeof srcParent.removeEntry === 'function';

  if (canMove && target.move && e.handle) {
    // True move in one atomic browser operation — the original disappears.
    await target.move(e.handle, { name: e.finalName });
  } else {
    // Copy + best-effort source removal. If the source cannot be removed
    // (permission or browser limits), the manifest honestly records a copy.
    const dest = await target.getFileHandle(e.finalName, { create: true });
    const writable = await (
      dest as unknown as FileSystemFileHandle & { createWritable(): Promise<WritableFormat> }
    ).createWritable();
    try {
      await writable.write(e.file);
    } finally {
      await writable.close();
    }
    let removed = false;
    if (srcParent?.removeEntry && e.handle) {
      try {
        await srcParent.removeEntry(e.name);
        removed = true;
      } catch {
        removed = false;
      }
    }
    if (!removed) {
      manifest.moves.push({ from, to, category: e.category, size: e.size, note: 'copied — original kept' } as MoveRecord);
      undo.push({ from, to, copy: true } as UndoRecordWithCopy);
      return;
    }
  }

  manifest.moves.push({ from, to, category: e.category, size: e.size } as MoveRecord);
  undo.push({ from, to } as UndoRecord);
}

type WritableFormat = {
  write(d: BlobPart): Promise<void>;
  close(): Promise<void>;
};

/** Relative path of the file in the organize root (flatten; desktop moves root-level names). */
function relativeFrom(e: PlanEntry): string {
  return e.name;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cancelNote(): ErrorRecord {
  return { file: '(remaining files)', message: 'Operation cancelled — no further files were moved.' };
}

/**
 * Undo the moves of a session: move each file back to its original location,
 * creating intermediate folders when the original nested (desktop parity),
 * then drop destination folders that became empty.
 */
export async function undoMoves(
  records: readonly UndoRecord[],
  dir: DirHandle,
  events?: { onProgress?: (done: number, total: number, current: string) => void },
): Promise<{ restored: number; failed: Array<{ file: string; message: string }> }> {
  const failed: Array<{ file: string; message: string }> = [];
  let restored = 0;
  let done = 0;
  const total = records.length;

  for (const rec of records) {
    const destSegs = rec.to.split('/');
    const destName = destSegs.pop()!;
    try {
      let cur = dir;
      for (const seg of destSegs) cur = await cur.getDirectoryHandle(seg);
      const src = await cur.getFileHandle(destName);

      const fromSegs = rec.from.split('/');
      const fromName = fromSegs.pop()!;
      let back = dir;
      for (const seg of fromSegs) {
        back = await back.getDirectoryHandle(seg, { create: true });
      }

      if (typeof back.move === 'function') {
        await back.move(src, { name: fromName });
      } else {
        const d = await back.getFileHandle(fromName, { create: true });
        const w = await (d as unknown as { createWritable(): Promise<WritableFormat> }).createWritable();
        const f = await src.getFile();
        await w.write(f);
        await w.close();
        await cur.removeEntry?.(destName);
      }
      restored++;
    } catch (err) {
      failed.push({ file: rec.from, message: msg(err) });
    }
    done++;
    events?.onProgress?.(done, total, rec.from);
  }

  // Remove now-empty destination folders (deepest first).
  const tops = [...new Set(records.map((r) => r.to.split('/')[0]!))];
  for (const top of tops) {
    try {
      const sub = await dir.getDirectoryHandle(top);
      if (!(await hasChildren(sub))) await dir.removeEntry?.(top);
    } catch {
      /* folder never existed */
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

interface UndoRecordWithCopy extends UndoRecord {
  copy?: boolean;
}
