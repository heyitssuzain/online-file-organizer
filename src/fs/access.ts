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

export interface DirHandle {
  kind: 'directory';
  name: string;
  move?: (fileOrHandle: File | FileSystemFileHandle, dest?: { name?: string }) => Promise<void>;
  values?(): AsyncIterableIterator<DirEntryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
type DirEntryHandle = FileSystemFileHandle | DirHandle;

export interface Capabilities {
  /** Can we write into a real folder on disk? */
  directWrite: boolean;
  /** Drag and drop of real folders. */
  folderDrop: boolean;
  /** Directory picker via <input webkitdirectory> fallback. */
  directoryInput: boolean;
}

export function capabilities(): Capabilities {
  return {
    directWrite: supportsFsAccess(),
    folderDrop: supportsFsAccess(),
    directoryInput: true,
  };
}

export function supportsFsAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
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

export interface ReadRecursiveResult {
  files: File[];
  /** relative path (from picked root) → File */
  paths: Map<File, string>;
  warnings: string[];
}

/**
 * Recursively read a directory handle (requires read permission). Respects a
 * depth cap on any folder source, mirroring the desktop's max_scan_depth.
 */
export async function readDirectoryHandle(
  dir: DirHandle,
  opts: { maxDepth?: number; onProgress?: (files: number) => void } = {},
): Promise<ReadRecursiveResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const result: ReadRecursiveResult = { files: [], paths: new Map(), warnings: [] };

  async function walk(handle: DirHandle, rel: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    try {
      for await (const entry of handle.values!()) {
        if (entry.kind === 'file') {
          try {
            const fh = entry as FileSystemFileHandle;
            const file = await fh.getFile();
            result.files.push(file);
            result.paths.set(file, rel ? `${rel}/${file.name}` : file.name);
            opts.onProgress?.(result.files.length);
            if (result.files.length >= MAX_FILES) {
              result.warnings.push(`Scan stopped at ${MAX_FILES} files (browser memory limits).`);
              return;
            }
          } catch {
            result.warnings.push(`Could not read "${entry.name}".`);
          }
        } else if (depth < maxDepth) {
          await walk(entry as DirHandle, rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        }
      }
    } catch {
      result.warnings.push(`Could not read folder "${handle.name}".`);
    }
  }

  await walk(dir, '', 0);
  return result;
}

/** Practical cap so a huge tree can't freeze the tab. */
export const MAX_FILES = 5000;

/**
 * Read from an <input type="file" webkitdirectory> / multiple files input.
 * Also used as the touch/mobile fallback and for drag-and-drop of plain files.
 */
export function readFromInput(files: FileList | File[]): ReadRecursiveResult {
  const arr = [...files];
  const paths = new Map<File, string>();
  for (const f of arr) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    paths.set(f, rel);
  }
  // Enforce cap for consistency (keep the first MAX_FILES).
  const kept = arr.slice(0, MAX_FILES);
  const warnings = arr.length > MAX_FILES ? [`Selection limited to first ${MAX_FILES} files (found ${arr.length}).`] : [];
  return { files: kept, paths: new Map(kept.map((f) => [f, paths.get(f) ?? f.name])), warnings };
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
  const warnings: string[] = [];

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
      } else if (handle?.kind === 'directory') {
        const res = await readDirectoryHandle(handle as unknown as DirHandle, { maxDepth });
        files.push(...res.files);
        for (const [f, p] of res.paths) paths.set(f, p);
        warnings.push(...res.warnings);
      }
    } else {
      const f = item.getAsFile?.();
      if (f) {
        files.push(f);
        paths.set(f, f.name);
      }
    }
  }
  return files.length ? { files, paths, warnings } : null;
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
