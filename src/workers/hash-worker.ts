/**
 * AuraFlow Web — hash worker
 *
 * Streams a File in slices and hashes incrementally so even large files never
 * sit fully in memory and the main thread never blocks.
 */

import { Sha256 } from '../core/sha256.js';
import { forEachChunk } from '../core/hash.js';

interface HashRequest {
  fileIndex: number;
  file: File;
}

self.onmessage = async (ev: MessageEvent<HashRequest>) => {
  const { file, fileIndex } = ev.data;
  try {
    const sha = new Sha256();
    await forEachChunk(file, (chunk) => {
      sha.update(chunk);
    });
    const hash = sha.digestHex();
    (self as unknown as Worker).postMessage({ fileIndex, hash });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      fileIndex,
      hash: '',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
