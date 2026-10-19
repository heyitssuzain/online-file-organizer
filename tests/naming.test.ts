import { describe, expect, it } from 'vitest';
import { displayMoveName, resolveCollision, sanitizeFilename, splitName } from '../src/core/naming.js';

describe('sanitizeFilename', () => {
  it('replaces Windows-hostile characters', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFilename('con:trol\u0001char')).toBe('con_trol_char');
  });

  it('removes trailing dots and spaces (invalid on Windows)', () => {
    expect(sanitizeFilename('report. ')).toBe('report');
    expect(sanitizeFilename('final version .')).toBe('final version');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('   ')).toBe('_');
    expect(sanitizeFilename('?')).toBe('_');
    expect(sanitizeFilename('.')).toBe('_');
  });

  it('leaves normal names untouched', () => {
    expect(displayMoveName('My Photo 2024.jpg')).toBe('My Photo 2024.jpg');
  });
});

describe('collision resolution (desktop safe_move parity)', () => {
  it('returns the original when free', () => {
    expect(resolveCollision('a.pdf', new Set())).toBe('a.pdf');
  });

  it('appends _1, _2 on collisions', () => {
    expect(resolveCollision('a.pdf', new Set(['a.pdf']))).toBe('a_1.pdf');
    expect(resolveCollision('a.pdf', new Set(['a.pdf', 'a_1.pdf']))).toBe('a_2.pdf');
  });

  it('handles collision chains and extension-less files', () => {
    expect(resolveCollision('LICENSE', new Set(['LICENSE', 'LICENSE_1']))).toBe('LICENSE_2');
  });

  it('splitName keeps compound extensions intact', () => {
    expect(splitName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
    expect(splitName('noext')).toEqual({ stem: 'noext', ext: '' });
  });
});
