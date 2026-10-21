/**
 * AuraFlow Web — Image → PDF controller
 *
 * Local images → one sharp PDF page per image with ordering, rotation, page
 * size, orientation, fit and margin controls. Attachments are read into memory
 * only; preview object URLs are revoked when an image is removed or the tab
 * closes.
 */

import '../pages/tools.css';
import { detectFileKind, extensionOf } from '../core/file-kinds.js';
import type { ImagePdfOptions, PdfImageSource } from '../core/pdf-tools.js';
import { buildImagePdfOffMain } from './pdf-worker-client.js';
import { imageDimensions, preparePdfImage } from '../browser/image.js';
import { toast } from '../site/layout.js';
import {
  $,
  bytesToBlob,
  escapeHtml,
  formatBytes,
  outputName,
  scrollToResult,
  setProgress,
  totalSize,
  wirePicker,
} from './tools-common.js';

type Rotation = 0 | 90 | 180 | 270;
type Status = 'loading' | 'ready' | 'error';

interface ImageItem {
  id: number;
  file: File;
  preview: string;
  width: number;
  height: number;
  rotation: Rotation;
  status: Status;
  error?: string;
}

const MAX_IMAGES = 75;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

let items: ImageItem[] = [];
let nextId = 1;
let working = false;
let cancelled = false;
let lastResult: { blob: Blob; name: string; pageCount: number } | null = null;

const queue = $('queue');
const queuePanel = $('queuePanel');
const emptyHelp = $('emptyHelp');
const queueCount = $('queueCount');
const pageStrip = $('pageStrip');
const dropzone = $('dropzone');
const notice = $('imageNotice');
const btnPick = $<HTMLButtonElement>('btnPick');
const fileInput = $<HTMLInputElement>('fileInput');
const btnClear = $<HTMLButtonElement>('btnClear');
const btnGenerate = $<HTMLButtonElement>('btnGenerate');
const btnCancel = $<HTMLButtonElement>('btnCancel');
const progressPanel = $('progressPanel');
const progressBar = $('progressBar');
const progressLabel = $('progressLabel');
const progressDetail = $('progressDetail');
const resultsPanel = $('resultsPanel');
const resultMeta = $('resultMeta');
const pdfName = $<HTMLInputElement>('pdfName');
const statusLine = $('statusLine');
const pageSize = $<HTMLSelectElement>('pdfPageSize');
const orientation = $<HTMLSelectElement>('pdfOrientation');
const fit = $<HTMLSelectElement>('pdfFit');
const margin = $<HTMLSelectElement>('pdfMargin');
const quality = $<HTMLSelectElement>('pdfQuality');

const UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ROTATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const DRAG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';

wirePicker({
  button: btnPick,
  input: fileInput,
  dropzone,
  accept: '.png,.jpg,.jpeg,.webp,.bmp,.gif,.svg,.avif',
  onFiles: addFiles,
});

function showNotice(html: string, kind: 'warn' | 'err' = 'warn'): void {
  notice.hidden = false;
  notice.className = `notice ${kind}`;
  notice.innerHTML = html;
}
function hideNotice(): void {
  notice.hidden = true;
  notice.innerHTML = '';
}

function addFiles(files: File[]): void {
  if (working) {
    toast('Wait for the current PDF to finish.', 'err');
    return;
  }
  const skipped: string[] = [];
  let projected = totalSize(items.map((i) => i.file));
  const added: ImageItem[] = [];

  for (const file of files) {
    if (items.length + added.length >= MAX_IMAGES) {
      skipped.push(`Only ${MAX_IMAGES} images can be combined in one PDF.`);
      break;
    }
    if (detectFileKind(file) !== 'image') {
      skipped.push(`${file.name}: not a supported image.`);
      continue;
    }
    if (projected + file.size > MAX_TOTAL_BYTES) {
      skipped.push(`${file.name}: would exceed the ${formatBytes(MAX_TOTAL_BYTES)} batch limit.`);
      continue;
    }
    if (items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) {
      skipped.push(`${file.name}: already added.`);
      continue;
    }
    const item: ImageItem = {
      id: nextId++,
      file,
      preview: URL.createObjectURL(file),
      width: 0,
      height: 0,
      rotation: 0,
      status: 'loading',
    };
    items.push(item);
    added.push(item);
    projected += file.size;
  }

  if (skipped.length) showNotice(`<strong>${skipped.length} file${skipped.length === 1 ? '' : 's'} not added.</strong><br>${skipped.slice(0, 4).map(escapeHtml).join('<br>')}`);
  else if (added.length) hideNotice();
  if (added.length) {
    if (lastResult) {
      lastResult = null;
      resultsPanel.hidden = true;
    }
    toast(`${added.length} image${added.length === 1 ? '' : 's'} added.`, 'ok');
  }
  render();
  for (const item of added) void hydrate(item);
}

async function hydrate(item: ImageItem): Promise<void> {
  try {
    const dims = await imageDimensions(item.file);
    if (!items.some((i) => i.id === item.id)) return;
    item.width = dims.width;
    item.height = dims.height;
    item.status = 'ready';
  } catch (err) {
    if (!items.some((i) => i.id === item.id)) return;
    item.status = 'error';
    item.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

function render(): void {
  queuePanel.hidden = items.length === 0;
  emptyHelp.hidden = items.length > 0;
  dropzone.classList.toggle('compact', items.length > 0);
  queueCount.textContent = String(items.length);
  const ready = items.filter((i) => i.status === 'ready').length;

  queue.innerHTML = items.length === 0 ? '<div class="queue-empty">No images yet.</div>' : items.map((item, index) => {
    const rotateLabel = item.rotation ? `Rotation ${item.rotation}°` : 'No rotation';
    const dims = item.status === 'ready' ? `${item.width} × ${item.height}` : item.status === 'loading' ? 'Reading…' : 'Unreadable';
    return `<div class="queue-row${item.status === 'error' ? ' is-error' : ''}" data-id="${item.id}" data-index="${index}">
      <div class="thumb"><img src="${item.preview}" alt="" loading="lazy" /></div>
      <div class="row-main">
        <div class="row-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
        <div class="row-meta">
          <span class="tag">${escapeHtml(extensionOf(item.file.name) || 'image')}</span>
          <span>${dims}</span>
          <span>${formatBytes(item.file.size)}</span>
          <span>${rotateLabel}</span>
          ${item.status === 'error' ? `<span class="tag tag-err" title="${escapeHtml(item.error ?? 'Unreadable image')}">${escapeHtml((item.error ?? 'Unreadable image').slice(0, 48))}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn drag-handle" type="button" draggable="true" data-drag="${item.id}" aria-label="Drag to reorder ${escapeHtml(item.file.name)}" title="Drag to reorder"${working ? ' disabled' : ''}>${DRAG_ICON}</button>
        <button class="icon-btn" type="button" data-up="${item.id}" aria-label="Move ${escapeHtml(item.file.name)} up"${index === 0 || working ? ' disabled' : ''}>${UP_ICON}</button>
        <button class="icon-btn" type="button" data-down="${item.id}" aria-label="Move ${escapeHtml(item.file.name)} down"${index === items.length - 1 || working ? ' disabled' : ''}>${DOWN_ICON}</button>
        <button class="icon-btn" type="button" data-rotate="${item.id}" aria-label="Rotate ${escapeHtml(item.file.name)} 90 degrees"${working ? ' disabled' : ''}>${ROTATE_ICON}</button>
        <button class="icon-btn danger" type="button" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}"${working ? ' disabled' : ''}>${REMOVE_ICON}</button>
      </div>
    </div>`;
  }).join('');

  pageStrip.innerHTML = items.map((item, index) => `<div class="page-card">
    <div class="page-img"><img src="${item.preview}" alt="${escapeHtml(item.file.name)} preview" loading="lazy" style="transform:rotate(${item.rotation}deg)" /></div>
    <div class="page-cap">${index + 1}. ${escapeHtml(item.file.name)}${item.rotation ? ` · ${item.rotation}°` : ''}</div>
  </div>`).join('');

  btnGenerate.disabled = working || ready === 0;
  btnGenerate.textContent = working ? 'Building PDF…' : `Create PDF${ready ? ` · ${ready} page${ready === 1 ? '' : 's'}` : ''}`;
  btnCancel.hidden = !working;
  btnClear.disabled = working || items.length === 0;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#settingsGrid select, #settingsGrid input')) {
    el.disabled = working;
  }
}

function reorder(fromId: number, toId: number, after: boolean): void {
  const from = items.findIndex((i) => i.id === fromId);
  const to = items.findIndex((i) => i.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = items.splice(from, 1);
  if (!moved) return;
  let target = items.findIndex((i) => i.id === toId);
  if (after) target++;
  items.splice(target, 0, moved);
  render();
}

function remove(id: number): void {
  const item = items.find((i) => i.id === id);
  if (item) URL.revokeObjectURL(item.preview);
  items = items.filter((i) => i.id !== id);
  lastResult = null;
  resultsPanel.hidden = true;
  render();
}

function clearAll(): void {
  for (const item of items) URL.revokeObjectURL(item.preview);
  items = [];
  lastResult = null;
  hideNotice();
  resultsPanel.hidden = true;
  progressPanel.hidden = true;
  render();
}

queue.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const up = target.closest<HTMLButtonElement>('button[data-up]');
  const down = target.closest<HTMLButtonElement>('button[data-down]');
  const rotate = target.closest<HTMLButtonElement>('button[data-rotate]');
  const removeBtn = target.closest<HTMLButtonElement>('button[data-remove]');
  if (working) return;
  if (up?.dataset.up) {
    const id = Number(up.dataset.up);
    const index = items.findIndex((i) => i.id === id);
    if (index > 0) {
      const prev = items[index - 1]!;
      reorder(id, prev.id, false);
    }
  } else if (down?.dataset.down) {
    const id = Number(down.dataset.down);
    const index = items.findIndex((i) => i.id === id);
    if (index >= 0 && index < items.length - 1) {
      const next = items[index + 1]!;
      reorder(id, next.id, true);
    }
  } else if (rotate?.dataset.rotate) {
    const item = items.find((i) => i.id === Number(rotate.dataset.rotate));
    if (item) {
      item.rotation = ((item.rotation + 90) % 360) as Rotation;
      lastResult = null;
      resultsPanel.hidden = true;
      render();
    }
  } else if (removeBtn?.dataset.remove) {
    remove(Number(removeBtn.dataset.remove));
  }
});

let dragId: number | null = null;

queue.addEventListener('dragstart', (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-drag]');
  if (!handle || working) {
    event.preventDefault();
    return;
  }
  dragId = Number(handle.dataset.drag);
  const row = handle.closest('.queue-row');
  row?.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(dragId));
  }
});

queue.addEventListener('dragover', (event) => {
  if (dragId === null) return;
  event.preventDefault();
  const row = (event.target as HTMLElement).closest<HTMLElement>('.queue-row');
  for (const el of queue.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  if (!row) return;
  const rect = row.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  row.classList.add(after ? 'drop-after' : 'drop-before');
});

queue.addEventListener('drop', (event) => {
  if (dragId === null) return;
  event.preventDefault();
  const row = (event.target as HTMLElement).closest<HTMLElement>('.queue-row');
  const targetId = row?.dataset.id ? Number(row.dataset.id) : null;
  if (targetId !== null) {
    const rect = row!.getBoundingClientRect();
    reorder(dragId, targetId, event.clientY > rect.top + rect.height / 2);
  }
  dragId = null;
  for (const el of queue.querySelectorAll('.drop-before, .drop-after, .dragging')) el.classList.remove('drop-before', 'drop-after', 'dragging');
});

queue.addEventListener('dragend', () => {
  dragId = null;
  for (const el of queue.querySelectorAll('.drop-before, .drop-after, .dragging')) el.classList.remove('drop-before', 'drop-after', 'dragging');
});

$<HTMLButtonElement>('btnClear').addEventListener('click', clearAll);
btnCancel.addEventListener('click', () => {
  cancelled = true;
  btnCancel.disabled = true;
  progressLabel.textContent = 'Stopping after the current step…';
});

function options(): ImagePdfOptions {
  return {
    pageSize: pageSize.value === 'letter' ? 'letter' : pageSize.value === 'image' ? 'image' : 'a4',
    orientation: orientation.value === 'portrait' ? 'portrait' : orientation.value === 'landscape' ? 'landscape' : 'auto',
    fit: fit.value === 'cover' ? 'cover' : 'contain',
    marginMm: Number(margin.value) || 0,
    background: '#ffffff',
  };
}

async function generate(): Promise<void> {
  if (working) return;
  const ready = items.filter((i) => i.status === 'ready');
  if (!ready.length) {
    toast('Add at least one readable image.', 'err');
    return;
  }

  working = true;
  cancelled = false;
  btnCancel.disabled = false;
  btnCancel.hidden = false;
  hideNotice();
  resultsPanel.hidden = true;
  lastResult = null;
  progressPanel.hidden = false;
  setProgress(progressPanel, progressBar, progressLabel, progressDetail, 0, ready.length, 'Reading images…');

  const maxEdge = Number(quality.value) || 0;
  const prepared: PdfImageSource[] = [];
  let failed = 0;

  for (let i = 0; i < ready.length; i++) {
    if (cancelled) break;
    const item = ready[i]!;
    setProgress(progressPanel, progressBar, progressLabel, progressDetail, i, ready.length * 2, `Preparing ${item.file.name}…`);
    try {
      const img = await preparePdfImage(item.file, maxEdge);
      prepared.push({
        name: item.file.name,
        bytes: img.bytes,
        format: img.format,
        width: img.width,
        height: img.height,
        rotation: item.rotation,
      });
    } catch (err) {
      failed++;
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (cancelled) {
    working = false;
    btnCancel.disabled = false;
    progressLabel.textContent = 'Cancelled';
    statusLine.textContent = 'PDF creation was cancelled. No output was generated.';
    render();
    return;
  }
  if (!prepared.length) {
    working = false;
    btnCancel.disabled = false;
    progressLabel.textContent = 'Nothing to build';
    statusLine.textContent = 'None of the selected images could be read.';
    showNotice('No readable images remained. Remove the failed files and try different images.', 'err');
    render();
    return;
  }

  try {
    btnCancel.hidden = true;
    const result = await buildImagePdfOffMain(prepared, options(), (done, total, name) => {
      setProgress(progressPanel, progressBar, progressLabel, progressDetail, ready.length + done, ready.length * 2, `Placing ${name} on page ${done} of ${total}…`);
    });
    const base = pdfName.value.trim() || `auraflow-images-${stamp()}`;
    const name = outputName(base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`, 'pdf');
    lastResult = { blob: bytesToBlob(result.bytes, 'application/pdf'), name, pageCount: result.pageCount };
    resultMeta.innerHTML = `<strong>${result.pageCount}</strong> page${result.pageCount === 1 ? '' : 's'} · ${formatBytes(lastResult.blob.size)} · built locally${failed ? ` · ${failed} image${failed === 1 ? '' : 's'} skipped` : ''}`;
    resultsPanel.hidden = false;
    progressLabel.textContent = 'PDF ready';
    statusLine.textContent = `Created ${name} entirely in this tab.`;
    toast('PDF created locally. Download it below.', 'ok');
    scrollToResult(resultsPanel);
  } catch (err) {
    progressLabel.textContent = 'PDF failed';
    statusLine.textContent = err instanceof Error ? err.message : 'Could not build the PDF.';
    showNotice(`<strong>PDF creation failed.</strong><br>${escapeHtml(err instanceof Error ? err.message : String(err))}`, 'err');
    toast('Could not build the PDF.', 'err');
  } finally {
    working = false;
    btnCancel.disabled = false;
    render();
  }
}

btnGenerate.addEventListener('click', () => void generate());

$<HTMLButtonElement>('btnDownload').addEventListener('click', () => {
  if (!lastResult) return;
  const url = URL.createObjectURL(lastResult.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = lastResult.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Saving your PDF…', 'ok');
});

$<HTMLButtonElement>('btnStartOver').addEventListener('click', clearAll);

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

window.addEventListener('beforeunload', () => {
  for (const item of items) URL.revokeObjectURL(item.preview);
});

render();
