/**
 * AuraFlow Web — local tool format detection
 *
 * Everything here is pure and synchronous so the UI never offers a conversion
 * that the corresponding local engine does not implement. Extensions are the
 * primary hint (the browser sometimes reports an empty MIME type, especially on
 * Windows); MIME families act as a fallback.
 */

export type FileKind = 'image' | 'text' | 'data' | 'pdf' | 'unsupported';

export type ImageOutput = 'png' | 'jpeg' | 'webp' | 'bmp';

export interface OutputOption {
  value: string;
  label: string;
  ext: string;
  mime: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg', 'avif', 'ico']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'html', 'htm']);
const DATA_EXTENSIONS = new Set(['csv', 'tsv', 'json']);

export const IMAGE_OUTPUTS: readonly OutputOption[] = [
  { value: 'png', label: 'PNG', ext: 'png', mime: 'image/png' },
  { value: 'jpeg', label: 'JPG / JPEG', ext: 'jpg', mime: 'image/jpeg' },
  { value: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp' },
  { value: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp' },
];

export const TEXT_OUTPUTS: readonly OutputOption[] = [
  { value: 'pdf', label: 'PDF document', ext: 'pdf', mime: 'application/pdf' },
  { value: 'html', label: 'HTML page', ext: 'html', mime: 'text/html' },
  { value: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  { value: 'txt', label: 'Plain text', ext: 'txt', mime: 'text/plain' },
];

export const DATA_OUTPUTS: readonly OutputOption[] = [
  { value: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv' },
  { value: 'json', label: 'JSON', ext: 'json', mime: 'application/json' },
  { value: 'xlsx', label: 'Excel workbook (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
];

export function extensionOf(name: string): string {
  const clean = name.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1);
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'converted';
}

export function detectFileKind(file: Pick<File, 'name' | 'type'> | { name: string; type?: string }): FileKind {
  const ext = extensionOf(file.name);
  const type = (file.type ?? '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || type.startsWith('image/')) return 'image';
  if (TEXT_EXTENSIONS.has(ext) || type.startsWith('text/plain') || type === 'text/markdown' || type === 'text/html') {
    return 'text';
  }
  if (DATA_EXTENSIONS.has(ext) || type === 'application/json' || type === 'text/csv' || type === 'text/tab-separated-values') {
    return 'data';
  }
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  return 'unsupported';
}

export function outputsFor(kind: FileKind, sourceExt = ''): readonly OutputOption[] {
  if (kind === 'image') return IMAGE_OUTPUTS;
  if (kind === 'text') {
    const source = sourceExt === 'markdown' ? 'md' : sourceExt;
    if (source === 'html' || source === 'htm') {
      return TEXT_OUTPUTS.filter((o) => o.value === 'pdf' || o.value === 'txt');
    }
    return TEXT_OUTPUTS.filter((o) => o.ext !== source);
  }
  if (kind === 'data') return DATA_OUTPUTS;
  return [];
}

export function defaultOutput(kind: FileKind, sourceExt: string): string {
  if (kind === 'image') return sourceExt === 'webp' ? 'png' : 'webp';
  if (kind === 'text') return 'pdf';
  if (kind === 'data') {
    if (sourceExt === 'json') return 'csv';
    return 'json';
  }
  return '';
}

export function mimeForOutput(value: string): string {
  const all = [...IMAGE_OUTPUTS, ...TEXT_OUTPUTS, ...DATA_OUTPUTS];
  return all.find((o) => o.value === value)?.mime ?? 'application/octet-stream';
}

export function extForOutput(value: string): string {
  const all = [...IMAGE_OUTPUTS, ...TEXT_OUTPUTS, ...DATA_OUTPUTS];
  return all.find((o) => o.value === value)?.ext ?? value;
}
