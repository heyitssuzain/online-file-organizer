/**
 * Incremental SHA-256 (pure TypeScript).
 *
 * WebCrypto's `crypto.subtle.digest` requires the whole message in memory, which
 * is wrong for large files. This class hashes in 64-byte blocks so the
 * hash worker can stream a File in 4 MB slices with flat memory usage.
 * Output is compatible with WebCrypto (same algorithm).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  /** Message byte count as 64-bit hi/lo pair (avoids BigInt in hot path). */
  private lenHi = 0;
  private lenLo = 0;

  update(data: Uint8Array | ArrayBuffer): this {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const total = this.lenLo + bytes.length;
    this.lenLo = total >>> 0;
    if (total >= 0x100000000) this.lenHi += Math.floor(total / 0x100000000);
    let i = 0;
    while (i < bytes.length) {
      const take = Math.min(64 - this.bufLen, bytes.length - i);
      this.buf.set(bytes.subarray(i, i + take), this.bufLen);
      this.bufLen += take;
      i += take;
      if (this.bufLen === 64) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    const d = this.digest();
    let out = '';
    for (const b of d) out += b.toString(16).padStart(2, '0');
    return out;
  }

  digest(): Uint8Array {
    const bitsHi = (this.lenHi * 8 + (this.lenLo >>> 29)) >>> 0;
    const bitsLo = (this.lenLo << 3) >>> 0;

    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const block = new Uint8Array(this.bufLen + padLen + 8);
    block.set(this.buf.subarray(0, this.bufLen));
    block[this.bufLen] = 0x80;
    const dv = new DataView(block.buffer);
    dv.setUint32(this.bufLen + padLen, bitsHi);
    dv.setUint32(this.bufLen + padLen + 4, bitsLo);

    for (let o = 0; o < block.length; o += 64) this.compress(block.subarray(o, o + 64));

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, this.h[i]!);
    return out;
  }

  private compress(block: Uint8Array): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      const o = i * 4;
      w[i] =
        ((block[o]! << 24) | (block[o + 1]! << 16) | (block[o + 2]! << 8) | block[o + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const p15 = w[i - 15]!;
      const p2 = w[i - 2]!;
      const s0 = rotr(p15, 7) ^ rotr(p15, 18) ^ (p15 >>> 3);
      const s1 = rotr(p2, 17) ^ rotr(p2, 19) ^ (p2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
}
