/**
 * AuraFlow Web — hashing helpers
 *
 * The Web Worker streams files in 4 MB slices and hashes them incrementally
 * (see `workers/hash-worker.ts`). This module owns the conversation with that
 * worker and a pure grouping function used by both the worker test-suite and
 * the organizer UI.
 */

export interface DupGroup {
  hash: string;
  files: string[];
}

/**
 * Group file indices by content hash (already computed).
 * Files of *different sizes* are never duplicates, so callers pass hashes only
 * for same-size buckets — mirroring the desktop's size-then-hash efficiency.
 * A "group" is only returned when 2+ files share the exact same hash.
 */
export function groupByHash(hashes: Map<string, string>): DupGroup[] {
  const byHash = new Map<string, string[]>();
  for (const [key, hash] of hashes) {
    let list = byHash.get(hash);
    if (!list) byHash.set(hash, (list = []));
    list.push(key);
  }
  return [...byHash.entries()]
    .filter(([, files]) => files.length >= 2)
    .map(([hash, files]) => ({ hash, files }));
}

/** Runs `fn` for each 4 MB slice without keeping the whole file in memory. */
export async function forEachChunk(file: Blob, fn: (chunk: Uint8Array, offset: number) => void | Promise<void>, chunkSize = 4 * 1024 * 1024): Promise<void> {
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    await fn(new Uint8Array(buf), offset);
  }
}
