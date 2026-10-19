/**
 * AuraFlow Web — minimal ZIP writer (stored / no compression)
 *
 * Fallback for browsers without the File System Access API: when moving files
 * directly in a folder isn't possible, the organized result can be downloaded
 * as a single ZIP whose internal folder structure mirrors the plan
 * (e.g. Documents/report.pdf, Images/photo.jpg).
 *
 * Implementation notes:
 * - CRC-32 computed incrementally per 4 MB slice (flat memory).
 * - "Stored" entries (method 0) — no compressor dependency, fast, and the
 *   source files are often already compressed binaries anyway.
 * - ZIP64 not implemented; entries > 4 GiB or archives that grow beyond it are
 *   refused up-front (checked by the caller via MAX_ZIP_SIZE).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crcUpdate(state: number, buf: Uint8Array): number {
  let c = state >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return c >>> 0;
}

export function crcFinish(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

export function crc32(buf: Uint8Array, seed = 0): number {
  return crcFinish(crcUpdate((seed ^ 0xffffffff) >>> 0, buf));
}

/** Practical ceiling to protect memory/bandwidth (2 GiB of selected files). */
export const MAX_ZIP_SIZE = 2 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

export interface ZipEntry {
  /** Path inside the archive, e.g. "Documents/report.pdf". Forward slashes. */
  path: string;
  file: Blob;
}

interface ZipOutput {
  blob: Blob;
  entries: number;
  bytes: number;
}

/** Build a stored ZIP. `onProgress` reports (completedBytes, totalBytes). */
export async function buildZip(
  entries: readonly ZipEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<ZipOutput> {
  const prefSize = entries.reduce((s, e) => s + e.file.size, 0);
  if (prefSize > MAX_ZIP_SIZE) {
    throw new Error(
      `Selected files total ${(prefSize / 1e9).toFixed(2)} GB which exceeds the 2 GB archive limit. ` +
        'Organize fewer files at once (or use a browser that supports direct folder writes).',
    );
  }

  const encoder = new TextEncoder();
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0; // current offset in the output archive
  let crcTotal = 0; // for progress accounting
  const total = prefSize;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);

    // Stream the file, computing CRC incrementally (raw state, complemented at the end).
    let crcState = 0xffffffff;
    const slices: BlobPart[] = [];
    for (let off = 0; off < entry.file.size; off += 4 * 1024 * 1024) {
      const end = Math.min(off + 4 * 1024 * 1024, entry.file.size);
      const buf = new Uint8Array(await entry.file.slice(off, end).arrayBuffer());
      crcState = crcUpdate(crcState, buf);
      slices.push(buf);
      crcTotal += buf.length;
      onProgress?.(crcTotal, total);
    }
    const crc = crcFinish(crcState);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header signature
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    header.setUint16(8, 0, true); // method: stored
    header.setUint16(10, 0, true); // mod time
    header.setUint16(12, 0, true); // mod date (epoch — deterministic)
    header.setUint32(14, crc, true);
    header.setUint32(18, entry.file.size, true); // compressed size (stored = size)
    header.setUint32(22, entry.file.size, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true); // extra length

    localParts.push(header.buffer, nameBytes.buffer as ArrayBuffer, ...slices);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central dir signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0x0800, true); // flags
    central.setUint16(10, 0, true); // method
    central.setUint16(12, 0, true); // time
    central.setUint16(14, 0, true); // date
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.file.size, true);
    central.setUint32(24, entry.file.size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra
    central.setUint16(32, 0, true); // comment
    central.setUint16(34, 0, true); // disk start
    central.setUint16(36, 0, true); // internal attrs
    central.setUint32(38, 0, true); // external attrs
    central.setUint32(42, offset, true); // local header offset

    centralParts.push(central.buffer, nameBytes.buffer as ArrayBuffer);
    offset += 30 + nameBytes.length + entry.file.size;
  }

  const centralSize = centralParts.reduce((s: number, p) => s + (p as ArrayBuffer).byteLength, 0);
  const centralOffset = offset;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // EOCD
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);

  const blob = new Blob([...localParts, ...centralParts, end.buffer], { type: 'application/zip' });
  return { blob, entries: entries.length, bytes: blob.size };
}
