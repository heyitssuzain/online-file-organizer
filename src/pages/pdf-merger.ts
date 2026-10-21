/**
 * AuraFlow Web — PDF Merger controller
 *
 * Multiple PDFs → one document. Pages are copied with pdf-lib rather than
 * rasterized, so text stays selectable and vector art stays sharp. Nothing is
 * uploaded; page counts are read locally when a file enters the queue.
 */

import '../pages/tools.css';
import { mergePdfsOffMain, readPdfInfoOffMain } from './pdf-worker-client.js';
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

type Status = 'loading' | 'ready' | 'error';

interface PdfItem {
  id: number;
  file: File;
  pageCount: number;
  status: Status;
  error?: string;
  title?: string;
}

const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

let items: PdfItem[] = [];
let nextId = 1;
let working = false;
let cancelled = false;
let lastResult: { blob: Blob; name: string; pageCount: number } | null = null;

const queue = $('queue');
const queuePanel = $('queuePanel');
const emptyHelp = $('emptyHelp');
const queueCount = $('queueCount');
const pageTotal = $('pageTotal');
const summaryBar = $('mergeSummary');
const dropzone = $('dropzone');
const notice = $('mergeNotice');
const btnPick = $<HTMLButtonElement>('btnPick');
const fileInput = $<HTMLInputElement>('fileInput');
const btnClear = $<HTMLButtonElement>('btnClear');
const btnMerge = $<HTMLButtonElement>('btnMerge');
const btnCancel = $<HTMLButtonElement>('btnCancel');
const progressPanel = $('progressPanel');
const progressBar = $('progressBar');
const progressLabel = $('progressLabel');
const progressDetail = $('progressDetail');
const resultsPanel = $('resultsPanel');
const resultMeta = $('resultMeta');
const mergedName = $<HTMLInputElement>('mergedName');
const statusLine = $('statusLine');

const UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const DRAG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';

wirePicker({
  button: btnPick,
  input: fileInput,
  dropzone,
  accept: '.pdf,application/pdf',
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
    toast('Wait for the current merge to finish.', 'err');
    return;
  }
  const skipped: string[] = [];
  let projected = totalSize(items.map((i) => i.file));
  const added: PdfItem[] = [];

  for (const file of files) {
    if (items.length + added.length >= MAX_FILES) {
      skipped.push(`Only ${MAX_FILES} PDFs can be merged at once.`);
      break;
    }
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      skipped.push(`${file.name}: not a PDF.`);
      continue;
    }
    if (projected + file.size > MAX_TOTAL_BYTES) {
      skipped.push(`${file.name}: would exceed the ${formatBytes(MAX_TOTAL_BYTES)} batch limit.`);
      continue;
    }
    if (items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) {
      skipped.push(`${file.name}: already in the merge queue.`);
      continue;
    }
    const item: PdfItem = { id: nextId++, file, pageCount: 0, status: 'loading' };
    items.push(item);
    added.push(item);
    projected += file.size;
  }

  if (skipped.length) showNotice(`<strong>${skipped.length} file${skipped.length === 1 ? '' : 's'} not added.</strong><br>${skipped.slice(0, 4).map(escapeHtml).join('<br>')}`);
  else if (added.length) hideNotice();
  if (added.length) {
    lastResult = null;
    resultsPanel.hidden = true;
    toast(`${added.length} PDF${added.length === 1 ? '' : 's'} added.`, 'ok');
  }
  render();
  for (const item of added) void hydrate(item);
}

async function hydrate(item: PdfItem): Promise<void> {
  try {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const info = await readPdfInfoOffMain(bytes);
    if (!items.some((i) => i.id === item.id)) return;
    item.pageCount = info.pageCount;
    item.title = info.title;
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
  const ready = items.filter((i) => i.status === 'ready');
  const pages = ready.reduce((sum, i) => sum + i.pageCount, 0);
  const size = totalSize(items.map((i) => i.file));
  pageTotal.textContent = `${pages} page${pages === 1 ? '' : 's'}`;
  summaryBar.innerHTML = `<strong>${ready.length}</strong> readable PDF${ready.length === 1 ? '' : 's'} · <strong>${pages}</strong> total page${pages === 1 ? '' : 's'} · ${formatBytes(size)}`;

  queue.innerHTML = items.length === 0 ? '<div class="queue-empty">No PDFs yet.</div>' : items.map((item, index) => {
    const status = item.status === 'loading'
      ? '<span class="tag">Reading…</span>'
      : item.status === 'error'
        ? `<span class="tag tag-err" title="${escapeHtml(item.error ?? 'Unreadable PDF')}">${escapeHtml((item.error ?? 'Unreadable PDF').slice(0, 48))}</span>`
        : `<span class="tag tag-ok">${item.pageCount} page${item.pageCount === 1 ? '' : 's'}</span>`;
    return `<div class="queue-row${item.status === 'error' ? ' is-error' : ''}" data-id="${item.id}" data-index="${index}">
      <div class="thumb">${PDF_ICON}</div>
      <div class="row-main">
        <div class="row-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
        <div class="row-meta">
          <span class="tag">PDF</span>
          <span>${formatBytes(item.file.size)}</span>
          ${item.title ? `<span title="Embedded document title">${escapeHtml(item.title.slice(0, 42))}</span>` : ''}
          ${status}
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn drag-handle" type="button" draggable="true" data-drag="${item.id}" aria-label="Drag to reorder ${escapeHtml(item.file.name)}" title="Drag to reorder"${working ? ' disabled' : ''}>${DRAG_ICON}</button>
        <button class="icon-btn" type="button" data-up="${item.id}" aria-label="Move ${escapeHtml(item.file.name)} up"${index === 0 || working ? ' disabled' : ''}>${UP_ICON}</button>
        <button class="icon-btn" type="button" data-down="${item.id}" aria-label="Move ${escapeHtml(item.file.name)} down"${index === items.length - 1 || working ? ' disabled' : ''}>${DOWN_ICON}</button>
        <button class="icon-btn danger" type="button" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}"${working ? ' disabled' : ''}>${REMOVE_ICON}</button>
      </div>
    </div>`;
  }).join('');

  btnMerge.disabled = working || ready.length === 0;
  btnMerge.textContent = working ? 'Merging…' : `Merge ${ready.length || ''} PDF${ready.length === 1 ? '' : 's'}`.trim();
  btnCancel.hidden = !working;
  btnClear.disabled = working || items.length === 0;
  for (const el of document.querySelectorAll<HTMLInputElement>('#settingsGrid input')) el.disabled = working;
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
  items = items.filter((i) => i.id !== id);
  lastResult = null;
  resultsPanel.hidden = true;
  render();
}

function clearAll(): void {
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
  const removeBtn = target.closest<HTMLButtonElement>('button[data-remove]');
  if (working) return;
  if (up?.dataset.up) {
    const id = Number(up.dataset.up);
    const index = items.findIndex((i) => i.id === id);
    if (index > 0) reorder(id, items[index - 1]!.id, false);
  } else if (down?.dataset.down) {
    const id = Number(down.dataset.down);
    const index = items.findIndex((i) => i.id === id);
    if (index >= 0 && index < items.length - 1) reorder(id, items[index + 1]!.id, true);
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
  handle.closest('.queue-row')?.classList.add('dragging');
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
  row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
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
  progressLabel.textContent = 'Finishing locally…';
});

async function merge(): Promise<void> {
  if (working) return;
  const ready = items.filter((i) => i.status === 'ready');
  if (!ready.length) {
    toast('Add at least one readable PDF.', 'err');
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
  setProgress(progressPanel, progressBar, progressLabel, progressDetail, 0, ready.length * 2, 'Reading PDFs…');

  const loaded: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < ready.length; i++) {
    if (cancelled) break;
    const item = ready[i]!;
    setProgress(progressPanel, progressBar, progressLabel, progressDetail, i, ready.length * 2, `Reading ${item.file.name}…`);
    try {
      loaded.push({ name: item.file.name, bytes: new Uint8Array(await item.file.arrayBuffer()) });
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (cancelled || !loaded.length) {
    working = false;
    btnCancel.disabled = false;
    progressLabel.textContent = cancelled ? 'Cancelled' : 'Nothing to merge';
    statusLine.textContent = cancelled ? 'Merge cancelled before it started.' : 'None of the selected PDFs could be read.';
    render();
    return;
  }

  try {
    btnCancel.hidden = true;
    const result = await mergePdfsOffMain(loaded, (done, total, name) => {
      setProgress(progressPanel, progressBar, progressLabel, progressDetail, ready.length + done, ready.length * 2, `Copying pages from ${name} (${done} of ${total})…`);
    });
    const base = mergedName.value.trim() || `auraflow-merged-${stamp()}`;
    const name = outputName(base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`, 'pdf');
    lastResult = { blob: bytesToBlob(result.bytes, 'application/pdf'), name, pageCount: result.pageCount };
    resultMeta.innerHTML = `<strong>${result.pageCount}</strong> page${result.pageCount === 1 ? '' : 's'} · ${formatBytes(lastResult.blob.size)} · text and vectors preserved where the source PDFs allow it.`;
    resultsPanel.hidden = false;
    progressLabel.textContent = 'PDF ready';
    statusLine.textContent = `Merged ${loaded.length} PDF${loaded.length === 1 ? '' : 's'} locally.`;
    toast('PDF merged locally. Download it below.', 'ok');
    scrollToResult(resultsPanel);
  } catch (err) {
    progressLabel.textContent = 'Merge failed';
    statusLine.textContent = err instanceof Error ? err.message : 'Could not merge the PDFs.';
    showNotice(`<strong>Merge failed.</strong><br>${escapeHtml(err instanceof Error ? err.message : String(err))}`, 'err');
    toast('Could not merge the PDFs.', 'err');
  } finally {
    working = false;
    btnCancel.disabled = false;
    render();
  }
}

btnMerge.addEventListener('click', () => void merge());

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
  toast('Saving your merged PDF…', 'ok');
});

$<HTMLButtonElement>('btnStartOver').addEventListener('click', clearAll);

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

render();
