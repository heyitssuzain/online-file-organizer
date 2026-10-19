/**
 * AuraFlow Web — organization plan engine
 *
 * Ported from the desktop's `app_logic.py` (scan_folder / organize preview) and
 * `utils.py` (safe_move collision handling). Builds a full preview plan:
 *
 *   original file → category / destination folder → final (maybe renamed) name
 *
 * Nothing is executed at this stage — every destination is previewed first,
 * mirroring the desktop's "preview before move" safety model.
 */

import {
  categoryForExtension,
  isSystemFile,
  isTempFile,
  isUnknownExtension,
  matchesPattern,
  normalizeExtension,
} from './categories.js';
import { displayMoveName, resolveCollision, sanitizeFilename } from './naming.js';

export type OrganizeRule = 'type' | 'extension' | 'date';

export interface Options {
  rule: OrganizeRule;
  excludeTemp: boolean;
  excludeSystem: boolean;
  excludePatterns: string[];
  /** If provided, only these category names are organized (desktop parity). */
  onlyCategories: string[] | null;
}

export const DEFAULT_OPTIONS: Options = {
  rule: 'type',
  excludeTemp: true,
  excludeSystem: true,
  excludePatterns: [],
  onlyCategories: null,
};

export interface PlanEntry {
  /** Stable id within the session. */
  id: string;
  file: File;
  name: string;
  extension: string;
  size: number;
  lastModified: number;
  category: string;
  /** Destination folder name(s) relative to the organize root, e.g. ["Documents"]. */
  destination: string[];
  /** Final filename (after collision resolution within the plan). */
  finalName: string;
  /** True when the finalName differs from the original (collision → _1 rename). */
  renamed: boolean;
  /** System/temp/empty-selection style skips — file stays untouched. */
  skip: SkipReason | null;
  /** Flagged but still included. */
  unknownExtension: boolean;
}

export type SkipReason = 'temp' | 'system' | 'pattern' | 'category-filter' | 'user-unchecked';

export interface Plan {
  entries: PlanEntry[];
  /** category name → entries (ordered by count desc, like the desktop). */
  byCategory: Map<string, PlanEntry[]>;
  unknownExtensions: Set<string>;
  tempCount: number;
  systemCount: number;
  patternExcluded: number;
  totalFiles: number;
  totalSize: number;
  organizedFiles: number;
  conflictsResolved: number;
}

let idCounter = 0;
const nextId = () => `f${++idCounter}`;

function foldersFor(entry: { extension: string; lastModified: number }, rule: OrganizeRule, category: string): string[] {
  switch (rule) {
    case 'type':
      return [category];
    case 'extension':
      return [entry.extension ? categoryForExtension(entry.extension) : category, extFolderName(entry.extension)];
    case 'date': {
      const d = new Date(entry.lastModified);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return [ym, category];
    }
  }
}

/**
 * Extension-rule folder names are derived from user filenames, so they must be
 * sanitized the same way as moved file names: a hostile extension like
 * `.<img src=x onerror=…>` must never reach a filesystem path, a ZIP entry, a
 * manifest, or the DOM. Truncated to keep folders portable.
 */
function extFolderName(ext: string): string {
  if (!ext) return 'no-extension';
  const clean = sanitizeFilename(ext.slice(1).toLowerCase().slice(0, 64));
  if (!clean || clean === '_' || clean.startsWith('.')) return 'no-extension';
  return clean;
}

/**
 * Build the plan from a list of files.
 *
 * `existingOnDisk` — optional map of destination-folder → Set of filenames that
 * already exist there on disk (collected with the File System Access API when
 * available). Collisions against these are resolved the same way as in-plan
 * collisions, protecting the user's current files from being overwritten.
 */
export function buildPlan(
  files: readonly File[],
  options: Options,
  existingOnDisk?: ReadonlyMap<string, ReadonlySet<string>>,
): Plan {
  const taken = new Map<string, Set<string>>(); // destination key "folder/sub" → names
  const entries: PlanEntry[] = [];
  const unknownExtensions = new Set<string>();
  let tempCount = 0;
  let systemCount = 0;
  let patternExcluded = 0;
  let totalSize = 0;
  let conflictsResolved = 0;

  for (const file of files) {
    const ext = normalizeExtension(file.name);
    const category = ext ? categoryForExtension(ext) : 'Others';

    // Desktop parity: exclusions are evaluated first and reported separately.
    if (options.excludeTemp && isTempFile(file.name)) {
      tempCount++;
      entries.push(makeEntry(file, ext, category, [], 'temp'));
      continue;
    }
    if (options.excludeSystem && isSystemFile(file.name)) {
      systemCount++;
      entries.push(makeEntry(file, ext, category, [], 'system'));
      continue;
    }
    if (options.excludePatterns.some((p) => matchesPattern(file.name, p))) {
      patternExcluded++;
      entries.push(makeEntry(file, ext, category, [], 'pattern'));
      continue;
    }
    if (options.onlyCategories && !options.onlyCategories.includes(category)) {
      entries.push(makeEntry(file, ext, category, [], 'category-filter'));
      continue;
    }

    if (ext && !isKnownExt(ext)) unknownExtensions.add(ext);

    const folders = foldersFor({ extension: ext, lastModified: file.lastModified }, options.rule, category);
    const key = folders.join('/');
    let bucket = taken.get(key);
    if (!bucket) {
      bucket = new Set([...(existingOnDisk?.get(key) ?? [])]);
      taken.set(key, bucket);
    }

    const proposed = displayMoveName(file.name);
    const finalName = resolveCollision(proposed, bucket);
    bucket.add(finalName);

    const entry = makeEntry(file, ext, category, folders, null, finalName);
    entries.push(entry);
    totalSize += file.size;
    if (finalName !== file.name) conflictsResolved++;
  }

  const byCategory = new Map<string, PlanEntry[]>();
  for (const e of entries) {
    if (e.skip) continue;
    let list = byCategory.get(e.category);
    if (!list) byCategory.set(e.category, (list = []));
    list.push(e);
  }
  // Desktop sorts categories by file count, descending.
  const sorted = new Map([...byCategory.entries()].sort((a, b) => b[1].length - a[1].length));

  const organized = entries.filter((e) => !e.skip);

  return {
    entries,
    byCategory: sorted,
    unknownExtensions,
    tempCount,
    systemCount,
    patternExcluded,
    totalFiles: files.length,
    totalSize,
    organizedFiles: organized.length,
    conflictsResolved,
  };

  function isKnownExt(e: string): boolean {
    // "known" = maps to a category other than Others (mirrors desktop ext_map)
    return categoryForExtension(e) !== 'Others';
  }
}

function makeEntry(
  file: File,
  extension: string,
  category: string,
  destination: string[],
  skip: SkipReason | null,
  finalName?: string,
): PlanEntry {
  const name = file.name;
  const proposed = finalName ?? displayMoveName(name);
  return {
    id: nextId(),
    file,
    name,
    extension,
    size: file.size,
    lastModified: file.lastModified,
    category,
    destination,
    finalName: proposed,
    renamed: proposed !== name,
    skip,
    unknownExtension: !skip && isUnknownExtension(name) && category === 'Others',
  };
}

/** Destination path for manifest/report output, e.g. "Documents/report.pdf". */
export function destinationPath(entry: PlanEntry): string {
  return [...entry.destination, entry.finalName].join('/');
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  return u === 0 ? `${size} ${units[u]}` : `${size.toFixed(1)} ${units[u]}`;
}
