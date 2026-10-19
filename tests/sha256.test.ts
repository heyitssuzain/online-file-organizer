import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from '../src/core/sha256.js';
import { groupByHash } from '../src/core/hash.js';

const bytes = (n: number, seed = 7): Uint8Array => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
};

function nodeHex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('Sha256 incremental implementation', () => {
  it('matches known vectors', () => {
    const empty = new Sha256();
    expect(empty.digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    const abc = new Sha256().update(new TextEncoder().encode('abc'));
    expect(abc.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4096, 70000])(
    'matches node crypto at size %i (incl. >64 byte blocks)',
    (size) => {
      const data = bytes(size);
      expect(new Sha256().update(data).digestHex()).toBe(nodeHex(data));
    },
  );

  it('priming works across chunk boundaries of arbitrary sizes', () => {
    const data = bytes(1_000_003);
    const stream2 = new Sha256();
    for (const [a, b] of [[0, 1], [1, 64], [64, 128], [128, 700], [700, 700000], [700000, data.length]] as const) {
      stream2.update(data.subarray(a, b));
    }
    expect(stream2.digestHex()).toBe(nodeHex(data));
  });
});

describe('duplicate grouping', () => {
  it('groups identical hashes only (names are irrelevant)', () => {
    const groups = groupByHash(
      new Map([
        ['a.jpg', 'h1'],
        ['copy of a.jpg', 'h1'],
        ['b.jpg', 'h2'],
        ['c.jpg', 'h3'],
      ]),
    );
    expect(groups).toEqual([{ hash: 'h1', files: ['a.jpg', 'copy of a.jpg'] }]);
  });

  it('never claims duplicates for different content with same names', () => {
    const groups = groupByHash(
      new Map([
        ['report.pdf', 'hX'],
        ['report.pdf', 'hY'],
      ]),
    );
    expect(groups).toEqual([]);
  });
});
