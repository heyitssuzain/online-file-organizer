/**
 * AuraFlow Web — browser filesystem capability layer
 *
 * What a browser can and cannot do with your files (and how this app handles it):
 *
 *  ✅ Read files/folders      — every modern browser (File API / <input webkitdirectory>)
 *  ✅ Write into a folder     — File System Access API (Chromium 86+/Edge/Opera),
 *                               only after YOU grant "read & write" permission
 *  ❌ Background monitoring   — impossible in a browser; no silent folder watching
 *  ❌ Arbitrary paths         — browsers never expose raw filesystem paths
 *
 * The app NEVER uploads files. All processing happens locally in your tab.
 */

import { isCategoryFolderName } from '../core/categories.js';

export interface DirHandle {
  kind: 'directory';
  name: string;
  values?(): AsyncIterableIterator<DirEntryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FileSystemHandle): Promise<boolean>;
}
type DirEntryHandle = FileSystemFileHandle | DirHandle;

export interface Capabilities {
  /** Can we write into a real folder on disk? */
  directWrite: boolean;
  /** Can we remove verified source files (true move, not just copy)? */
  directMove: boolean;
  /** Drag and drop of real folders. */
  folderDrop: boolean;
  /** Directory picker via <input webkitdirectory> fallback. */
  directoryInput: boolean;
}

export function capabilities(): Capabilities {
  const picker = supportsFsAccess();
  const writable = supportsFileWrites();
  const removable = supportsDirectoryRemoval();
  return {
    directWrite: picker && writable,
    directMove: picker && writable && removable,
    folderDrop: picker,
    directoryInput: true,
  };
}

export function supportsFsAccess(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Writing needs createWritable on file handles — some partial implementations lack it. */
function supportsFileWrites(): boolean {
  const G = globalThis as unknown as { FileSystemFileHandle?: { prototype?: object } };
  return !!G.FileSystemFileHandle?.prototype && 'createWritable' in G.FileSystemFileHandle.prototype;
}

function supportsDirectoryRemoval(): boolean {
  const G = globalThis as unknown as { FileSystemDirectoryHandle?: { prototype?: object } };
  return !!G.FileSystemDirectoryHandle?.prototype && 'removeEntry' in G.FileSystemDirectoryHandle.prototype;
}

/**
 * Check (and, when needed, request) read/write permission for a picked folder.
 * Must be called from a user gesture for `requestPermission` to prompt.
 */
export async function verifyPermission(dir: DirHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<boolean> {
  if (!dir.queryPermission || !dir.requestPermission) return true;
  const opts = { mode };
  try {
    if ((await dir.queryPermission(opts)) === 'granted') return true;
    return (await dir.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}


/** Pick a real folder with read/write permission (Chromium). Returns null if declined/unavailable. */
export async function pickDirectory(): Promise<DirHandle | null> {
  if (!supportsFsAccess()) return null;
  try {
    const picker = (window as unknown as {
      showDirectoryPicker: (o?: { mode?: string; id?: string }) => Promise<DirHandle>;
    }).showDirectoryPicker;
    return await picker({ mode: 'readwrite', id: 'auraflow' });
  } catch {
    return null; // user cancelled or denied
  }
}

/** Collect existing filenames per first-level subfolder (collision safety). */
export async function snapshotFolder(dir: DirHandle, folders: readonly string[]): Promise<Map<string, Set<string>>> {
  const snap = new Map<string, Set<string>>();
  for (const f of folders) {
    try {
      const sub = await dir.getDirectoryHandle(f);
      const names = new Set<string>();
      for await (const entry of sub.values!()) {
        if (entry.kind === 'file') names.add(entry.name);
      }
      snap.set(f, names);
    } catch {
      // folder doesn't exist yet — nothing existing
      snap.set(f, new Set());
    }
  }
  return snap;
}

/**
 * Snapshot filenames in every destination folder the current plan would use,
 * so collisions with files already on disk can be resolved before the preview
 * is shown. Handles missing folders (first run) and permission failures safely.
 */
export async function snapshotDestinations(
  dir: DirHandle,
  destinations: Iterable<readonly string[]>,
): Promise<Map<string, Set<string>>> {
  const snap = new Map<string, Set<string>>();
  for (const segments of destinations) {
    const key = segments.join('/');
    if (snap.has(key)) continue;
    const names = new Set<string>();
    try {
      let cur = dir;
      for (const seg of segments) cur = await cur.getDirectoryHandle(seg);
      for await (const entry of cur.values!()) {
        if (entry.kind === 'file') names.add(entry.name);
      }
    } catch {
      // Missing folder (or unreadable) — treat as empty; execution re-checks.
    }
    snap.set(key, names);
  }
  return snap;
}

/**
 * Folder names produced by AuraFlow at the root of an organized folder:
 * category names for "by type"/"by extension", and YYYY-MM for "by date".
 * They are skipped during scanning so a second run cannot reprocess its own
 * output (a folder is only skipped at the selected root, never deeper).
 */
export function isOrganizedDestinationFolder(name: string): boolean {
  return isCategoryFolderName(name) || /^\d{4}-(0[1-9]|1[0-2])$/.test(name);
}

export interface ReadRecursiveResult {
  files: File[];
  /** relative path (from picked root) → File */
  paths: Map<File, string>;
  /** File handle per file (Chromium direct-write path; empty for <input>). */
  handles: Map<File, FileSystemFileHandle>;
  /** Directory that directly contains each file (for verified moves/undo). */
  parents: Map<File, DirHandle>;
  warnings: string[];
  /** Root directory handle when the selection itself was a folder drop. */
  root?: DirHandle;
}

/**
 * Recursively read a directory handle (requires read permission). Respects a
 * depth cap on any folder source, mirroring the desktop's max_scan_depth.
 *
 * Root-level folder names produced by this app (Images/, Documents/, YYYY-MM/)
 * are skipped so a second run cannot re-process its own output. This is only
 * applied at depth 0 — a nested folder called "Images" remains scannable.
 */
export async function readDirectoryHandle(
  dir: DirHandle,
  opts: {
    maxDepth?: number;
    onProgress?: (files: number) => void;
    skipOrganizedFolders?: boolean;
  } = {},
): Promise<ReadRecursiveResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const skipOrganized = opts.skipOrganizedFolders ?? true;
  const result: ReadRecursiveResult = {
    files: [],
    paths: new Map(),
    handles: new Map(),
    parents: new Map(),
    warnings: [],
  };
  const skippedFolders: string[] = [];
  let stopped = false;

  async function walk(handle: DirHandle, rel: string, depth: number): Promise<void> {
    if (stopped || depth > maxDepth) return;
    if (!handle.values) {
      result.warnings.push(`Folder "${handle.name}" cannot be enumerated in this browser.`);
      return;
    }
    try {
      for await (const entry of handle.values()) {
        if (stopped) return;
        if (entry.kind === 'file') {
          try {
            const fh = entry as FileSystemFileHandle;
            const file = await fh.getFile();
            result.files.push(file);
            result.paths.set(file, rel ? `${rel}/${file.name}` : file.name);
            result.handles.set(file, fh);
            result.parents.set(file, handle);
            opts.onProgress?.(result.files.length);
            if (result.files.length >= MAX_FILES) {
              result.warnings.push(`Scan stopped at ${MAX_FILES} files (browser memory limits).`);
              stopped = true;
              return;
            }
          } catch {
            result.warnings.push(`Could not read "${entry.name}".`);
          }
        } else if (depth === 0 && skipOrganized && isOrganizedDestinationFolder(entry.name)) {
          skippedFolders.push(entry.name);
        } else if (depth < maxDepth) {
          await walk(entry as DirHandle, rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        }
      }
    } catch {
      result.warnings.push(`Could not read folder "${handle.name}" (permission denied or removed).`);
    }
  }

  await walk(dir, '', 0);
  if (skippedFolders.length) {
    result.warnings.push(
      `Skipped ${skippedFolders.length} existing organized folder${skippedFolders.length === 1 ? '' : 's'} (${skippedFolders.slice(0, 4).join(', ')}${skippedFolders.length > 4 ? '…' : ''}).`,
    );
  }
  return result;
}

/** Practical cap so a huge tree can't freeze the tab. */
export const MAX_FILES = 5000;

/**
 * Read from an <input type="file" webkitdirectory> / multiple files input.
 * Also used as the touch/mobile fallback and for drag-and-drop of plain files.
 * No filesystem handles exist on this path, so direct moves are unavailable.
 */
export function readFromInput(files: FileList | File[]): ReadRecursiveResult {
  const arr = [...files];
  const paths = new Map<File, string>();
  const skipped: string[] = [];
  for (const f of arr) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    // webkitRelativePath looks like "SelectedRoot/Sub/file.ext". Only a
    // category/date folder directly under the selected root is app output.
    const parts = rel.split('/');
    if (parts.length >= 3 && isOrganizedDestinationFolder(parts[1]!)) {
      skipped.push(parts[1]!);
      continue;
    }
    paths.set(f, rel);
  }
  const kept = [...paths.keys()];
  // Enforce cap for consistency (keep the first MAX_FILES).
  const capped = kept.slice(0, MAX_FILES);
  const warnings: string[] = [];
  if (skipped.length) {
    const unique = [...new Set(skipped)];
    warnings.push(
      `Skipped ${unique.length} existing organized folder${unique.length === 1 ? '' : 's'} (${unique.slice(0, 4).join(', ')}${unique.length > 4 ? '…' : ''}).`,
    );
  }
  if (kept.length > MAX_FILES) warnings.push(`Selection limited to first ${MAX_FILES} files (found ${kept.length}).`);
  return {
    files: capped,
    paths: new Map(capped.map((f) => [f, paths.get(f) ?? f.name])),
    handles: new Map(),
    parents: new Map(),
    warnings,
  };
}

/**
 * Drag-and-drop: DataTransfer items may carry a FileSystemDirectoryHandle
 * (Chromium). Plain file drops work everywhere.
 */
export async function readFromDrop(dt: DragEvent, maxDepth = 3): Promise<ReadRecursiveResult | null> {
  const items = dt.dataTransfer?.items;
  if (!items) return null;

  const files: File[] = [];
  const paths = new Map<File, string>();
  const handles = new Map<File, FileSystemFileHandle>();
  const parents = new Map<File, DirHandle>();
  const warnings: string[] = [];
  let root: DirHandle | undefined;
  let directoryCount = 0;

  for (const item of [...items]) {
    const anyItem = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    };
    if (anyItem.getAsFileSystemHandle) {
      const handle = await anyItem.getAsFileSystemHandle();
      if (handle?.kind === 'file') {
        const fh = handle as FileSystemFileHandle;
        const file = await fh.getFile();
        files.push(file);
        paths.set(file, file.name);
        handles.set(file, fh);
      } else if (handle?.kind === 'directory') {
        directoryCount++;
        const dirHandle = handle as unknown as DirHandle;
        const res = await readDirectoryHandle(dirHandle, { maxDepth });
        files.push(...res.files);
        for (const [f, p] of res.paths) paths.set(f, p);
        for (const [f, h] of res.handles) handles.set(f, h);
        for (const [f, d] of res.parents) parents.set(f, d);
        warnings.push(...res.warnings);
        if (directoryCount === 1) root = dirHandle;
      }
    } else {
      const f = item.getAsFile?.();
      if (f) {
        files.push(f);
        paths.set(f, f.name);
      }
    }
  }
  return files.length
    ? { files, paths, handles, parents, warnings, root: directoryCount === 1 ? root : undefined }
    : null;
}

/** Pick files with a standard <input multiple>. */
export function pickFiles(input: HTMLInputElement): Promise<FileList | null> {
  return new Promise((resolve) => {
    const onChange = () => {
      input.removeEventListener('change', onChange);
      resolve(input.files);
      input.value = ''; // allow re-selecting the same files
    };
    input.addEventListener('change', onChange);
    input.click();
  });
}
