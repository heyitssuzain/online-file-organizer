import { describe, expect, it } from 'vitest';
import {
  categoryForExtension,
  isKnownExtension,
  isSystemFile,
  isTempFile,
  isUnknownExtension,
  matchesPattern,
  normalizeExtension,
} from '../src/core/categories.js';

describe('extension normalisation', () => {
  it('lowercases extensions', () => {
    expect(normalizeExtension('REPORT.PDF')).toBe('.pdf');
    expect(normalizeExtension('photo.HeIC')).toBe('.heic');
    expect(normalizeExtension('x.JS')).toBe('.js');
  });

  it('handles dotless names and trailing dots', () => {
    expect(normalizeExtension('README')).toBe('');
    expect(normalizeExtension('.gitignore')).toBe(''); // leading dot = hidden file, not ext
    expect(normalizeExtension('archive.tar.gz.')).toBe('');
  });

  it('is case-insensitive for categorisation', () => {
    expect(categoryForExtension('.PDF')).toBe('Documents');
    expect(categoryForExtension('.PdF')).toBe('Documents');
    expect(categoryForExtension('.MP4')).toBe('Videos');
  });
});

describe('categorisation (desktop rule parity)', () => {
  it('maps the desktop extension sets to the 11 categories', () => {
    expect(categoryForExtension('.xlsx')).toBe('Documents'); // desktop keeps sheets in Documents
    expect(categoryForExtension('.psd')).toBe('Images'); // first-wins like the desktop
    expect(categoryForExtension('.zip')).toBe('Archives');
    expect(categoryForExtension('.exe')).toBe('Executables');
    expect(categoryForExtension('.blend')).toBe('Design_3D');
    expect(categoryForExtension('.ttf')).toBe('Fonts');
    expect(categoryForExtension('.sqlite')).toBe('Data');
    expect(categoryForExtension('.py')).toBe('Code');
    expect(categoryForExtension('.flac')).toBe('Audio');
  });

  it('sends unknown extensions to Others instead of discarding', () => {
    expect(categoryForExtension('.weird')).toBe('Others');
    expect(categoryForExtension('.$xy')).toBe('Others');
    expect(isUnknownExtension('something.xyzzy')).toBe(true);
    expect(isKnownExtension('something.xyzzy')).toBe(false);
  });

  it('no-extension files are not "unknown extensions"', () => {
    expect(isUnknownExtension('LICENSE')).toBe(false);
  });
});

describe('exclusions (desktop parity)', () => {
  it('flags temp/incomplete files', () => {
    expect(isTempFile('setup.exe.crdownload')).toBe(true);
    expect(isTempFile('notes.bak')).toBe(true);
    expect(isTempFile('notes.tmp')).toBe(true);
    expect(isTempFile('holiday.jpg')).toBe(false);
  });

  it('flags system files case-insensitively', () => {
    expect(isSystemFile('Thumbs.DB')).toBe(true);
    expect(isSystemFile('desktop.ini')).toBe(true);
    expect(isSystemFile('.DS_Store')).toBe(true);
    expect(isSystemFile('report.pdf')).toBe(false);
  });

  it('matches wildcard patterns like the desktop fnmatch', () => {
    expect(matchesPattern('setup-v2.tmp', '*.tmp')).toBe(true);
    expect(matchesPattern('Thumbs.db', 'thumbs.db')).toBe(true);
    expect(matchesPattern('IMG_203.jpg', 'IMG_*')).toBe(true);
    expect(matchesPattern('IMG_203.jpg', '*.png')).toBe(false);
  });
});
