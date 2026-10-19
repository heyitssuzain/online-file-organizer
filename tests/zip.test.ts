import { describe, expect, it } from 'vitest';
import { crc32, buildZip, MAX_ZIP_SIZE } from '../src/core/zip.js';
import { Manifest, manifestToRows, manifestToText, foldersTouched, createManifest } from '../src/core/manifest.js';
import { csvEscape, toCsv } from '../src/core/export.js';
import * as zlib from 'node:zlib';

const blobOf = (s: string): Blob => new Blob([new TextEncoder().encode(s)]);

describe('crc32', () => {
  it('matches known value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('buildZip (stored, in-memory structure check)', () => {
  it('writes a structurally valid ZIP with folder paths', async () => {
    const entries = [
      { path: 'Documents/a.txt', file: blobOf('hello') },
      { path: 'Images/b.bin', file: blobOf('world-world-world') },
    ];
    const out = await buildZip(entries);
    const buf = new Uint8Array(await out.blob.arrayBuffer());
    const dv = new DataView(buf.buffer);

    // Local header signature
    expect(dv.getUint32(0, true)).toBe(0x04034b50);

    // EOCD: find it
    const eocdIdx = buf.length - 22;
    expect(dv.getUint32(eocdIdx, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocdIdx + 8, true)).toBe(2);
    expect(dv.getUint16(eocdIdx + 10, true)).toBe(2);
    expect(out.entries).toBe(2);
  });

  it('CRC-32 of a stored entry equals zlib.crc32 of the content', async () => {
    const content = new TextEncoder().encode('consistent checksum content');
    const out = await buildZip([{ path: 'x.dat', file: new Blob([content]) }]);
    const buf = new Uint8Array(await out.blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const storedCrc = dv.getUint32(14, true); // local header offset 14
    expect(storedCrc >>> 0).toBe(zlib.crc32(content) >>> 0);
  });

  it('refuses oversized selections with an actionable message', async () => {
    const huge = { path: 'big.bin', file: { size: (MAX_ZIP_SIZE as number) + 1024, slice: () => new Blob() } as unknown as Blob };
    await expect(buildZip([huge])).rejects.toThrow(/exceeds the 2 GB archive limit/);
  });

  it('handles empty files (zero-length entries)', async () => {
    const out = await buildZip([{ path: 'empty.txt', file: new Blob([]) }]);
    expect(out.entries).toBe(1);
    const buf = new Uint8Array(await out.blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(14, true)).toBe(0); // crc of empty = 0
    expect(dv.getUint32(18, true)).toBe(0); // size
  });
});

function sampleManifest(): Manifest {
  const m = createManifest('C:/Users/x/Downloads', 'type');
  m.moves.push({ from: 'a.pdf', to: 'Documents/a.pdf', category: 'Documents', size: 10 });
  m.moves.push({ from: 'b.jpg', to: 'Images/b.jpg', category: 'Images', size: 2000 });
  m.skipped.push({ file: 'tmp.part', reason: 'temp' });
  m.errors.push({ file: 'locked.dll', message: 'Permission denied.' });
  return m;
}

describe('manifest reporting', () => {
  it('produces CSV rows for moved/skipped/error entries', () => {
    const rows = manifestToRows(sampleManifest());
    expect(rows[0]).toEqual(['original_path', 'destination_path', 'category', 'size_bytes', 'status']);
    expect(rows[1]).toEqual(['a.pdf', 'Documents/a.pdf', 'Documents', '10', 'moved']);
    expect(rows[2]).toEqual(['b.jpg', 'Images/b.jpg', 'Images', '2000', 'moved']);
    expect(rows[3]![4]).toBe('skipped');
    expect(rows[4]![4]).toBe('error');
  });

  it('text report contains a summary line', () => {
    const txt = manifestToText(sampleManifest());
    expect(txt).toContain('2 moved · 1 skipped · 1 errors');
    expect(txt).toContain('a.pdf  →  Documents/a.pdf');
  });

  it('lists touched destination folders', () => {
    expect(foldersTouched(sampleManifest()).sort()).toEqual(['Documents', 'Images']);
  });
});

describe('CSV escaping (formula/quote safety)', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
  });

  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
  });
});
