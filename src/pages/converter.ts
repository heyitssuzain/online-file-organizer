/**
 * AuraFlow Web — File Converter controller
 *
 * Select files → choose a supported output per file → convert locally → download
 * individually or as a ZIP. No uploads, no server, no persistent file storage.
 */

import '../pages/tools.css';
import {
  defaultOutput,
  detectFileKind,
  extensionOf,
  outputsFor,
  type FileKind,
  type ImageOutput,
} from '../core/file-kinds.js';
import {
  jsonToRows,
  parseDelimited,
  rowsToCsv,
  rowsToJson,
  rowsToXlsx,
} from '../core/data-convert.js';
import {
  blocksForPdf,
  htmlToText,
  markdownToHtmlDocument,
  markdownToPlainText,
  plainTextToHtmlDocument,
  textToMarkdown,
} from '../core/text-convert.js';
import { createTextPdf } from '../core/pdf-tools.js';
import { convertImage } from '../browser/image.js';
import { toast } from '../site/layout.js';
import {
  $,
  bytesToBlob,
  escapeHtml,
  formatBytes,
  outputName,
  readTextFile,
  setProgress,
  totalSize,
  uniqueName,
  wirePicker,
  zipResults,
} from './tools-common.js';

type ConvertibleKind = Exclude<FileKind, 'pdf' | 'unsupported'>;
type Status = 'queued' | 'working' | 'done' | 'error';

interface Item {
  id: number;
  file: File;
  kind: ConvertibleKind;
  sourceExt: string;
  output: string;
  preview?: string;
  status: Status;
  result?: { blob: Blob; name: string };
  error?: string;
}

const MAX_FILES = 50;
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

let items: Item[] = [];
let nextId = 1;
let converting = false;
let cancelled = false;

const queue = $('queue');
const queuePanel = $('queuePanel');
const emptyHelp = $('emptyHelp');
const queueCount = $('queueCount');
const settingsGrid = $('settingsGrid');
const dropzone = $('dropzone');
const btnPick = $<HTMLButtonElement>('btnPick');
const fileInput = $<HTMLInputElement>('fileInput');
const btnConvert = $<HTMLButtonElement>('btnConvert');
const btnCancel = $<HTMLButtonElement>('btnCancel');
const btnClear = $<HTMLButtonElement>('btnClear');
const progressPanel = $('progressPanel');
const progressBar = $('progressBar');
const progressLabel = $('progressLabel');
const progressDetail = $('progressDetail');
const resultsPanel = $('resultsPanel');
const resultsList = $('resultsList');
const resultSummary = $('resultSummary');
const btnZip = $<HTMLButtonElement>('btnZip');
const statusLine = $('statusLine');
const notice = $('converterNotice');

const imgQuality = $<HTMLInputElement>('imgQuality');
const imgQualityOut = $<HTMLOutputElement>('imgQualityOut');
const imgMax = $<HTMLSelectElement>('imgMax');
const imgBg = $<HTMLInputElement>('imgBg');
const pdfPage = $<HTMLSelectElement>('pdfPage');
const pdfFont = $<HTMLSelectElement>('pdfFont');
const pdfMargin = $<HTMLSelectElement>('pdfMargin');
const sheetName = $<HTMLInputElement>('sheetName');

const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

wirePicker({
  button: btnPick,
  input: fileInput,
  dropzone,
  accept: [
    '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.svg', '.avif',
    '.txt', '.md', '.markdown', '.html', '.htm',
    '.csv', '.tsv', '.json',
  ].join(','),
  onFiles: addFiles,
});

function showNotice(kind: 'warn' | 'err' | 'ok' | '', html: string): void {
  notice.hidden = false;
  notice.className = `notice ${kind}`.trim();
  notice.innerHTML = html;
}
function hideNotice(): void {
  notice.hidden = true;
  notice.innerHTML = '';
}

function addFiles(files: File[]): void {
  if (converting) {
    toast('Wait for the current conversion to finish.', 'err');
    return;
  }
  const skipped: string[] = [];
  let added = 0;
  let projected = totalSize(items.map((i) => i.file));

  for (const file of files) {
    if (items.length >= MAX_FILES) {
      skipped.push(`Only ${MAX_FILES} files can be converted in one run.`);
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${file.name}: larger than ${formatBytes(MAX_FILE_BYTES)}.`);
      continue;
    }
    if (projected + file.size > MAX_TOTAL_BYTES) {
      skipped.push(`${file.name}: the batch would exceed the ${formatBytes(MAX_TOTAL_BYTES)} limit.`);
      continue;
    }

    const kind = detectFileKind(file);
    if (kind === 'pdf') {
      skipped.push(`${file.name}: PDFs are handled by Image → PDF or PDF Merger.`);
      continue;
    }
    if (kind === 'unsupported') {
      skipped.push(`${file.name}: this format is not supported by the local converter.`);
      continue;
    }
    if (items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified)) {
      skipped.push(`${file.name}: already in the queue.`);
      continue;
    }

    const sourceExt = extensionOf(file.name);
    const item: Item = {
      id: nextId++,
      file,
      kind,
      sourceExt,
      output: defaultOutput(kind, sourceExt),
      status: 'queued',
      preview: kind === 'image' ? URL.createObjectURL(file) : undefined,
    };
    items.push(item);
    projected += file.size;
    added++;
  }

  if (skipped.length) {
    showNotice('warn', `<strong>${skipped.length} file${skipped.length === 1 ? '' : 's'} not added.</strong><br>${skipped.slice(0, 4).map(escapeHtml).join('<br>')}${skipped.length > 4 ? `<br>…and ${skipped.length - 4} more.` : ''}`);
  } else if (added) {
    hideNotice();
  }
  if (added) toast(`${added} file${added === 1 ? '' : 's'} added. Choose an output, then convert.`, 'ok');
  render();
}

function statusLabel(item: Item): string {
  if (item.status === 'working') return 'Working';
  if (item.status === 'done') return item.result ? formatBytes(item.result.blob.size) : 'Done';
  if (item.status === 'error') return 'Error';
  return 'Ready';
}

function render(): void {
  queuePanel.hidden = items.length === 0;
  emptyHelp.hidden = items.length > 0;
  dropzone.classList.toggle('compact', items.length > 0);
  queueCount.textContent = String(items.length);
  settingsGrid.hidden = items.length === 0;
  $('imgSettings').hidden = !items.some((i) => i.kind === 'image');
  $('docSettings').hidden = !items.some((i) => i.kind === 'text');
  $('dataSettings').hidden = !items.some((i) => i.kind === 'data');

  queue.innerHTML = items.length === 0
    ? '<div class="queue-empty">No files yet.</div>'
    : items.map((item) => {
      const options = outputsFor(item.kind, item.sourceExt)
        .map((o) => `<option value="${o.value}"${o.value === item.output ? ' selected' : ''}>${o.label}</option>`)
        .join('');
      const thumb = item.preview
        ? `<img src="${item.preview}" alt="" loading="lazy" />`
        : `<span class="thumb-badge">${item.kind === 'data' ? 'DATA' : 'TXT'}</span>`;
      const err = item.status === 'error' && item.error
        ? `<span class="tag tag-err" title="${escapeHtml(item.error)}">${escapeHtml(item.error.slice(0, 60))}${item.error.length > 60 ? '…' : ''}</span>`
        : '';
      return `<div class="queue-row${item.status === 'working' ? ' is-busy' : ''}${item.status === 'error' ? ' is-error' : ''}${item.status === 'done' ? ' is-done' : ''}" data-id="${item.id}">
        <div class="thumb">${thumb}</div>
        <div class="row-main">
          <div class="row-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
          <div class="row-meta">
            <span class="tag">${escapeHtml(item.sourceExt || item.kind)}</span>
            <span>${formatBytes(item.file.size)}</span>
            <span>→ ${escapeHtml(item.output.toUpperCase())}</span>
            <span class="${item.status === 'done' ? 'tag tag-ok' : ''}">${statusLabel(item)}</span>
            ${err}
          </div>
        </div>
        <div class="row-actions">
          <label class="sr-only" for="out-${item.id}">Output format for ${escapeHtml(item.file.name)}</label>
          <select id="out-${item.id}" data-output="${item.id}"${converting ? ' disabled' : ''} aria-label="Output format for ${escapeHtml(item.file.name)}">${options}</select>
          <button class="icon-btn danger" type="button" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}"${converting ? ' disabled' : ''}>${REMOVE_ICON}</button>
        </div>
      </div>`;
    }).join('');

  btnConvert.disabled = converting || items.length === 0;
  btnConvert.textContent = converting ? 'Converting…' : `Convert ${items.length || ''} file${items.length === 1 ? '' : 's'}`.trim();
  btnCancel.hidden = !converting;
  btnClear.disabled = converting || items.length === 0;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#settingsGrid select, #settingsGrid input')) {
    el.disabled = converting;
  }
}

queue.addEventListener('change', (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-output]');
  if (!select) return;
  const item = items.find((i) => i.id === Number(select.dataset.output));
  if (!item) return;
  item.output = select.value;
  item.status = 'queued';
  item.result = undefined;
  item.error = undefined;
  renderResults();
  render();
});

queue.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove]');
  if (!btn || converting) return;
  removeItem(Number(btn.dataset.remove));
});

function removeItem(id: number): void {
  const item = items.find((i) => i.id === id);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  items = items.filter((i) => i.id !== id);
  renderResults();
  render();
}

function clearAll(): void {
  for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
  items = [];
  hideNotice();
  progressPanel.hidden = true;
  resultsPanel.hidden = true;
  renderResults();
  render();
}

$<HTMLButtonElement>('btnClear').addEventListener('click', clearAll);
btnCancel.addEventListener('click', () => {
  cancelled = true;
  btnCancel.disabled = true;
  progressLabel.textContent = 'Finishing the current file…';
});
imgQuality.addEventListener('input', () => {
  imgQualityOut.textContent = `${Math.round(Number(imgQuality.value) * 100)}%`;
});

function outputBlobFor(item: Item): Promise<{ blob: Blob; name: string }> {
  return convertOne(item).then((blob) => ({
    blob,
    name: outputName(item.file.name, item.output),
  }));
}

async function convertOne(item: Item): Promise<Blob> {
  if (item.kind === 'image') {
    const res = await convertImage(item.file, {
      format: item.output as ImageOutput,
      quality: Number(imgQuality.value),
      maxDimension: Number(imgMax.value) || 0,
      background: imgBg.value || '#ffffff',
    });
    return res.blob;
  }

  if (item.kind === 'text') {
    const raw = await readTextFile(item.file, 8 * 1024 * 1024);
    const isHtml = item.sourceExt === 'html' || item.sourceExt === 'htm';
    const isMarkdown = item.sourceExt === 'md' || item.sourceExt === 'markdown';
    const plain = isHtml ? htmlToText(raw) : raw;

    if (item.output === 'pdf') {
      const blocks = isMarkdown
        ? blocksForPdf(plain, false)
        : blocksForPdf(plain, true);
      const bytes = await createTextPdf(blocks, {
        pageSize: pdfPage.value === 'letter' ? 'letter' : 'a4',
        fontSize: Number(pdfFont.value) || 10.5,
        marginMm: Number(pdfMargin.value) || 18,
        title: item.file.name,
      });
      return bytesToBlob(bytes, 'application/pdf');
    }
    if (item.output === 'html') {
      const html = isMarkdown ? markdownToHtmlDocument(raw, item.file.name) : plainTextToHtmlDocument(plain, item.file.name);
      return new Blob([html], { type: 'text/html;charset=utf-8' });
    }
    if (item.output === 'txt') {
      const text = isHtml ? htmlToText(raw) : isMarkdown ? markdownToPlainText(raw) : raw;
      return new Blob([text], { type: 'text/plain;charset=utf-8' });
    }
    if (item.output === 'md') {
      return new Blob([textToMarkdown(plain)], { type: 'text/markdown;charset=utf-8' });
    }
    throw new Error('That output format is not available for this file.');
  }

  if (item.kind === 'data') {
    const raw = await readTextFile(item.file, 20 * 1024 * 1024);
    const sourceIsJson = item.sourceExt === 'json';
    let rows: string[][];
    if (sourceIsJson) {
      rows = jsonToRows(raw);
    } else {
      rows = parseDelimited(raw);
    }

    if (item.output === 'json') {
      if (sourceIsJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch (err) {
          throw new Error(`That file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
        return new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json;charset=utf-8' });
      }
      return new Blob([rowsToJson(rows)], { type: 'application/json;charset=utf-8' });
    }
    if (item.output === 'csv') {
      return new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    }
    if (item.output === 'xlsx') {
      const bytes = await rowsToXlsx(rows, sheetName.value.trim() || 'Sheet1');
      return bytesToBlob(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    throw new Error('That output format is not available for this data file.');
  }

  throw new Error('Unsupported file type.');
}

async function convertAll(): Promise<void> {
  if (converting || items.length === 0) return;
  converting = true;
  cancelled = false;
  btnCancel.disabled = false;
  hideNotice();
  resultsPanel.hidden = true;
  progressPanel.hidden = false;
  for (const item of items) {
    item.status = 'queued';
    item.result = undefined;
    item.error = undefined;
  }
  render();
  setProgress(progressPanel, progressBar, progressLabel, progressDetail, 0, items.length, 'Preparing…');
  statusLine.textContent = 'Converting locally. Keep this tab open while the files are processed.';

  const used = new Set<string>();
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (cancelled) break;
    const item = items[i]!;
    item.status = 'working';
    render();
    setProgress(progressPanel, progressBar, progressLabel, progressDetail, i, items.length, `Converting ${item.file.name}…`);
    try {
      const result = await outputBlobFor(item);
      result.name = uniqueName(result.name, used);
      item.result = result;
      item.status = 'done';
      item.error = undefined;
      ok++;
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof Error ? err.message : String(err);
      failed++;
    }
    setProgress(progressPanel, progressBar, progressLabel, progressDetail, i + 1, items.length, item.status === 'done' ? `Finished ${item.file.name}` : `Could not convert ${item.file.name}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  converting = false;
  btnCancel.disabled = false;
  progressLabel.textContent = cancelled ? 'Cancelled' : 'Conversion finished';
  statusLine.textContent = cancelled
    ? `Stopped after ${ok + failed} of ${items.length} files. Finished files are still available below.`
    : `${ok} converted${failed ? `, ${failed} failed` : ''}. Everything happened in this tab.`;
  render();
  renderResults();
  if (ok) toast(`${ok} file${ok === 1 ? '' : 's'} converted locally.`, 'ok');
  if (failed) toast(`${failed} file${failed === 1 ? '' : 's'} could not be converted. Open the row for details.`, 'err');
}

btnConvert.addEventListener('click', () => void convertAll());

function renderResults(): void {
  const done = items.filter((i) => i.status === 'done' && i.result);
  const failed = items.filter((i) => i.status === 'error');
  resultsPanel.hidden = done.length === 0 && failed.length === 0;
  if (resultsPanel.hidden) return;
  resultSummary.innerHTML = `<strong>${done.length}</strong> ready${failed.length ? ` · <span style="color:var(--danger)">${failed.length} failed</span>` : ''} · Nothing was uploaded`;
  resultsList.innerHTML = done.map((item) => `<div class="result-row">
    <span class="result-check">${CHECK_ICON}</span>
    <div style="min-width:0">
      <div class="result-name" title="${escapeHtml(item.result!.name)}">${escapeHtml(item.result!.name)}</div>
      <div class="result-meta">${formatBytes(item.result!.blob.size)} · from ${escapeHtml(item.file.name)}</div>
    </div>
    <button class="btn btn-secondary btn-sm" type="button" data-download="${item.id}">${DOWNLOAD_ICON} Download</button>
  </div>`).join('');
  btnZip.hidden = done.length < 2;
}

resultsList.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-download]');
  if (!btn || !btn.dataset.download) return;
  const item = items.find((i) => i.id === Number(btn.dataset.download));
  if (!item?.result) return;
  const url = URL.createObjectURL(item.result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.result.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${item.result.name}`, 'ok');
});

btnZip.addEventListener('click', async () => {
  const done = items.filter((i) => i.status === 'done' && i.result);
  if (done.length < 2) return;
  btnZip.disabled = true;
  progressPanel.hidden = false;
  try {
    await zipResults(
      done.map((i) => ({ name: i.result!.name, blob: i.result!.blob })),
      `auraflow-converted-${stamp()}.zip`,
      (doneBytes, totalBytes) => setProgress(progressPanel, progressBar, progressLabel, progressDetail, doneBytes, totalBytes, 'Building ZIP…'),
    );
    toast('Converted files zipped.', 'ok');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not build the ZIP.', 'err');
  } finally {
    btnZip.disabled = false;
  }
});

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

window.addEventListener('beforeunload', () => {
  for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
});

// Initialize.
render();
renderResults();
