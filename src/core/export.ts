/**
 * AuraFlow Web — export helpers
 *
 * Downloads are plain Blobs produced client-side. Nothing is uploaded.
 */

import { manifestToRows, manifestToText, Manifest } from './manifest.js';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeDownloadName(filename);
  document.body.appendChild(a); // Firefox requires the link in the DOM
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Keep downloads predictable & safe across OSes. */
export function sanitizeDownloadName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'download';
}

/**
 * Escape one CSV cell. Handles classic CSV quoting plus "CSV formula
 * injection": a cell starting with = + - @ or a tab/CR could be evaluated as a
 * formula when opened in Excel/LibreOffice (OWASP guidance). We prefix a literal
 * apostrophe so spreadsheet apps treat it as text. Filenames arriving from the
 * File API are user-controlled on most OSes, so this applies to every cell.
 */
export function csvEscape(value: string): string {
  const lead = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(lead)) return `"${lead.replace(/"/g, '""')}"`;
  return lead;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

export function downloadManifestJson(m: Manifest): void {
  downloadBlob(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), `auraflow-manifest-${stamp()}.json`);
}

export function downloadManifestCsv(m: Manifest): void {
  const csv = toCsv(manifestToRows(m));
  downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `auraflow-manifest-${stamp()}.csv`);
}

export function downloadReportTxt(m: Manifest): void {
  downloadBlob(new Blob([manifestToText(m)], { type: 'text/plain;charset=utf-8' }), `auraflow-report-${stamp()}.txt`);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
