import { describe, expect, it } from 'vitest';
import {
  defaultOutput,
  detectFileKind,
  extensionOf,
  extForOutput,
  mimeForOutput,
  outputsFor,
  stemOf,
} from '../src/core/file-kinds.js';

describe('file kind detection', () => {
  it('detects by extension even when the browser reports no MIME type', () => {
    expect(detectFileKind({ name: 'PHOTO.JPG', type: '' })).toBe('image');
    expect(detectFileKind({ name: 'scan.PNG', type: '' })).toBe('image');
    expect(detectFileKind({ name: 'notes.md', type: '' })).toBe('text');
    expect(detectFileKind({ name: 'table.CSV', type: '' })).toBe('data');
    expect(detectFileKind({ name: 'contract.PDF', type: '' })).toBe('pdf');
    expect(detectFileKind({ name: 'song.mp3', type: 'audio/mpeg' })).toBe('unsupported');
    expect(detectFileKind({ name: 'unknown.xyzzy', type: '' })).toBe('unsupported');
  });

  it('falls back to MIME families for extensionless files', () => {
    expect(detectFileKind({ name: 'blob', type: 'image/webp' })).toBe('image');
    expect(detectFileKind({ name: 'blob', type: 'application/json' })).toBe('data');
    expect(detectFileKind({ name: 'blob', type: 'application/pdf' })).toBe('pdf');
  });

  it('extracts extensions and stems safely', () => {
    expect(extensionOf('A.B.PDF')).toBe('pdf');
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('noext')).toBe('');
    expect(stemOf('report.final.pdf')).toBe('report.final');
    expect(stemOf('noext')).toBe('noext');
  });
});

describe('offered outputs', () => {
  it('offers only implemented image outputs', () => {
    expect(outputsFor('image').map((o) => o.value)).toEqual(['png', 'jpeg', 'webp', 'bmp']);
  });

  it('never offers the same text format back, and HTML can only become PDF/TXT', () => {
    expect(outputsFor('text', 'txt').map((o) => o.value)).toEqual(['pdf', 'html', 'md']);
    expect(outputsFor('text', 'md').map((o) => o.value)).toEqual(['pdf', 'html', 'txt']);
    expect(outputsFor('text', 'markdown').map((o) => o.value)).toEqual(['pdf', 'html', 'txt']);
    expect(outputsFor('text', 'html').map((o) => o.value)).toEqual(['pdf', 'txt']);
    expect(outputsFor('text', 'htm').map((o) => o.value)).toEqual(['pdf', 'txt']);
  });

  it('offers CSV, JSON and XLSX for data files', () => {
    expect(outputsFor('data', 'csv').map((o) => o.value)).toEqual(['csv', 'json', 'xlsx']);
    expect(outputsFor('data', 'tsv').map((o) => o.value)).toEqual(['csv', 'json', 'xlsx']);
    expect(outputsFor('data', 'json').map((o) => o.value)).toEqual(['csv', 'json', 'xlsx']);
  });

  it('defaults are always one of the offered formats', () => {
    expect(defaultOutput('image', 'jpg')).toBe('webp');
    expect(defaultOutput('image', 'webp')).toBe('png');
    expect(defaultOutput('text', 'txt')).toBe('pdf');
    expect(defaultOutput('data', 'csv')).toBe('json');
    expect(defaultOutput('data', 'json')).toBe('csv');
    expect(defaultOutput('pdf', 'pdf')).toBe('');
  });

  it('maps output formats to safe MIME types and extensions', () => {
    expect(mimeForOutput('jpeg')).toBe('image/jpeg');
    expect(extForOutput('jpeg')).toBe('jpg');
    expect(mimeForOutput('xlsx')).toContain('spreadsheetml');
    expect(extForOutput('xlsx')).toBe('xlsx');
    expect(mimeForOutput('unknown')).toBe('application/octet-stream');
  });
});
