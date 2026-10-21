/**
 * Shared browser helpers for the local tools (converter, Image → PDF, merger).
 * Deliberately tiny: DOM wiring, downloads, queue naming and progress. No
 * analytics, no storage, no network.
 */

import { buildZip, type ZipEntry } from '../core/zip.js';
import { downloadBlob } from '../core/export.js';
import { extForOutput } from '../core/file-kinds.js';
import { toast } from '../site/layout.js';

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
export const $$ = <T extends HTMLElement>(selector: string): T[] => [...document.querySelectorAll(selector)] as T[];

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function safeStem(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name).trim() || 'converted';
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'converted';
}

export function uniqueName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate.toLowerCase())) {
    used.add(candidate.toLowerCase());
    return candidate;
  }
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const ext = dot > 0 ? candidate.slice(dot) : '';
  let i = 1;
  while (used.has(`${stem}_${i}${ext}`.toLowerCase())) i++;
  const result = `${stem}_${i}${ext}`;
  used.add(result.toLowerCase());
  return result;
}

export function outputName(sourceName: string, output: string): string {
  return `${safeStem(sourceName)}.${extForOutput(output)}`;
}

export function download(blob: Blob, name: string): void {
  downloadBlob(blob, name);
}

export async function zipResults(
  files: readonly { name: string; blob: Blob }[],
  zipName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (files.length === 0) {
    toast('There are no converted files to zip.', 'err');
    return;
  }
  const entries: ZipEntry[] = files.map((f) => ({ path: f.name, file: f.blob }));
  const { blob } = await buildZip(entries, onProgress);
  download(blob, zipName);
}

export function setProgress(
  panel: HTMLElement,
  bar: HTMLElement,
  label: HTMLElement,
  detail: HTMLElement,
  done: number,
  total: number,
  text = '',
): void {
  panel.hidden = false;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  label.textContent = text || `${done} of ${total}`;
  detail.textContent = total > 0 ? `${pct}%` : '';
}

export interface PickerOptions {
  button: HTMLElement;
  input: HTMLInputElement;
  dropzone?: HTMLElement;
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
}

/** Wire a button + hidden input + optional drop panel. Folders are rejected honestly. */
export function wirePicker(options: PickerOptions): void {
  const { button, input, dropzone, onFiles, accept, multiple = true } = options;
  if (accept) input.accept = accept;
  input.multiple = multiple;

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) onFiles(files);
  });

  if (!dropzone) return;
  let depth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    dropzone.classList.add('drag-on');
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropzone.classList.remove('drag-on');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dropzone.classList.remove('drag-on');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) {
      toast('No files found. To add a whole folder, open it and select the files inside.', 'err');
      return;
    }
    onFiles(files);
  });
}

export function revokeUrls(urls: Iterable<string | undefined>): void {
  for (const url of urls) if (url) URL.revokeObjectURL(url);
}

export function markBusy(button: HTMLButtonElement, busy: boolean, idleText: string, busyText = 'Working…'): void {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
  button.setAttribute('aria-busy', String(busy));
}

export function totalSize(files: readonly File[]): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}

export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

/** Scroll results into view without overriding the user's motion preference. */
export function scrollToResult(element: HTMLElement): void {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
}

/** Read UTF-8/UTF-16 text with a hard size cap. No upload, no persistence. */
export async function readTextFile(file: Blob, maxBytes = 16 * 1024 * 1024): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(`${formatBytes(file.size)} is too large for in-browser text conversion (limit ${formatBytes(maxBytes)}).`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
