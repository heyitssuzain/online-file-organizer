/**
 * AuraFlow Web — Organizer application controller
 *
 * Workflow (mirrors the desktop app):
 *   select → scan/list → plan preview → confirm → execute → results → undo
 *
 * Never executes without an explicit confirmation, never overwrites
 * (collision-renames instead), and honestly switches to an organized-ZIP
 * fallback when the browser cannot write folders.
 */

import './organizer.css';
import {
  buildPlan,
  formatBytes,
  destinationPath,
  Plan,
  Options,
  DEFAULT_OPTIONS,
  PlanEntry,
} from '../core/plan.js';
import { createManifest, Manifest } from '../core/manifest.js';
import { downloadManifestCsv, downloadManifestJson, downloadReportTxt, downloadBlob } from '../core/export.js';
import { buildZip, ZipEntry } from '../core/zip.js';
import { forEachChunk, groupByHash } from '../core/hash.js';
import { Sha256 } from '../core/sha256.js';
import {
  capabilities,
  pickDirectory,
  readDirectoryHandle,
  readFromDrop,
  DirHandle,
  MAX_FILES,
} from '../fs/access.js';
import { executePlan, undoMoves, OpSession, ExecResult } from '../fs/operations.js';
import { toast, ICONS } from '../site/layout.js';

// ---------- state ------------------------------------------------------------
interface Selection {
  files: File[];
  rootName: string;
  dirHandle: DirHandle | null;
}

let sel: Selection = { files: [], rootName: '', dirHandle: null };
let plan: Plan | null = null;
let opts: Options = { ...DEFAULT_OPTIONS };
let manifest: Manifest | null = null;
let undoLog: ExecResult['undo'] = [];
let lastDirHandle: DirHandle | null = null;
const session = new OpSession();
let hashJobId = 0;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const all = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll(selector)] as T[];

const CAT_ICONS: Record<string, string> = {
  Documents: '📄', Images: '🖼️', Videos: '🎬', Audio: '🎵', Archives: '📦',
  Code: '💻', Executables: '⚙️', Design_3D: '🎨', Fonts: '🔤', Data: '📊', Others: '📁',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------- capability badge -------------------------------------------------
{
  const cap = capabilities();
  const badge = $('capBadge');
  if (cap.directWrite) {
    badge.className = 'badge badge-ok';
    badge.innerHTML = `✓ This browser can sort into real folders — <a href="/features.html#compatibility" style="color:inherit; text-decoration:underline">details</a>`;
  } else {
    badge.className = 'badge badge-warn';
    badge.innerHTML = `<a href="/features.html#compatibility" style="color:inherit">This browser reads &amp; plans; it delivers the organized result as a ZIP (folder writes aren't supported here)</a>`;
  }
}

// ---------- selection --------------------------------------------------------
$('btnFolder').addEventListener('click', async () => {
  if (capabilities().directWrite) {
    const dir = await pickDirectory();
    if (dir) {
      toast(`Reading "${dir.name}" …`, 'ok');
      const res = await readDirectoryHandle(dir, {
        onProgress: (n) => ($('appHeadStatus').textContent = `Reading ${n} files…`),
      });
      remember(res.files, dir.name, dir, res.warnings);
      return;
    }
    toast('Folder access was cancelled — falling back to the classic picker', '');
  }
  $('dirInput').click();
});

// Persistent change listeners so every selection path (button click, keyboard,
// automation) lands in the app — not only clicks armed through pickFiles().
$('fileInput').addEventListener('change', () => {
  const input = $('fileInput') as HTMLInputElement;
  if (input.files?.length) useInputFiles(input.files, false);
  input.value = ''; // allow re-selecting the same files next time
});
$('dirInput').addEventListener('change', () => {
  const input = $('dirInput') as HTMLInputElement;
  if (input.files?.length) useInputFiles(input.files, true);
  input.value = '';
});
$('btnFiles').addEventListener('click', () => $('fileInput').click());

function useInputFiles(list: FileList, isFolder: boolean): void {
  const files = [...list];
  const warnings = files.length > MAX_FILES ? [`Selection capped at the first ${MAX_FILES} of ${files.length} files.`] : [];
  const rootName = isFolder
    ? trimmedRoot(files[0])
    : files.length === 1
      ? files[0]!.name
      : `${files.length} selected files`;
  remember(files.slice(0, MAX_FILES), rootName, null, warnings);
}

function trimmedRoot(first: File | undefined): string {
  const rel = (first as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
  return rel?.includes('/') ? rel.split('/')[0]! : 'folder';
}

// dropzone
const dz = $('dropzone');
for (const ev of ['dragenter', 'dragover'] as const) {
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('drag-on');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  dz.addEventListener(ev, () => dz.classList.remove('drag-on'));
}
dz.addEventListener('drop', async (e) => {
  e.preventDefault();
  const drag = e as DragEvent;
  const res = await readFromDrop(drag);
  if (res) {
    remember(res.files, res.files.length === 1 ? res.files[0]!.name : 'dropped files', null, res.warnings);
  } else if (drag.dataTransfer?.files?.length) {
    const files = [...drag.dataTransfer.files];
    const warnings = files.length > MAX_FILES ? [`Selection capped at the first ${MAX_FILES} of ${files.length} files.`] : [];
    remember(files.slice(0, MAX_FILES), files.length === 1 ? files[0]!.name : 'dropped files', null, warnings);
  } else {
    toast('Nothing readable was dropped — try files or a folder', 'err');
  }
});

function remember(files: readonly File[], rootName: string, dir: DirHandle | null, warnings: string[] = []): void {
  sel = { files: [...files], rootName, dirHandle: dir };
  manifest = null;
  undoLog = [];
  resetResults();

  const hasFiles = files.length > 0;
  $('workspace').hidden = !hasFiles;
  $('countBadge').textContent = String(files.length);

  if (hasFiles) {
    $('appHeadStatus').textContent = `“${rootName}” — ${files.length} file${files.length === 1 ? '' : 's'} selected. Review the plan below, then confirm.`;
  } else {
    $('appHeadStatus').textContent = 'No readable files found — try a different folder.';
  }

  replan();
  for (const w of warnings) toast(w, 'err');
  if (hasFiles && innerWidth < 980) $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('btnClear').addEventListener('click', () => {
  sel = { files: [], rootName: '', dirHandle: null };
  plan = null;
  hashJobId++;
  $('workspace').hidden = true;
  $('countBadge').textContent = '0';
  resetResults();
  $('dupesOut').hidden = true;
  $('appHeadStatus').textContent = 'Pick files or a folder to begin — everything stays on your device.';
});

// ---------- file list --------------------------------------------------------
const RENDER_CAP = 300;

function renderList(): void {
  const list = $('fileList');
  list.innerHTML = '';
  const entryByFile = new Map<File, PlanEntry>();
  for (const e of plan?.entries ?? []) entryByFile.set(e.file, e);

  const shown = sel.files.slice(0, RENDER_CAP);
  for (const f of shown) {
    const entry = entryByFile.get(f);
    const skip = entry?.skip ?? null;
    const row = document.createElement('div');
    row.className = 'file-row' + (skip ? ' skip' : '');
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <span class="file-dot" style="background: var(--cat-${entry?.category ?? 'Others'})" aria-hidden="true"></span>
      <span><span class="file-name"></span><br><span class="file-meta"></span></span>
      <span class="skip-reason">${skip ? skipLabel(skip) : ''}</span>`;
    row.querySelector('.file-name')!.textContent = f.name;
    row.querySelector('.file-meta')!.textContent = formatBytes(f.size);
    list.appendChild(row);
  }
  $('listMore').textContent =
    sel.files.length > shown.length ? `+ ${sel.files.length - shown.length} more files (list shows the first ${RENDER_CAP})` : '';
}

function skipLabel(r: string): string {
  switch (r) {
    case 'temp': return 'temp — skipped';
    case 'system': return 'system — skipped';
    case 'pattern': return 'excluded';
    case 'category-filter': return 'not selected';
    default: return '';
  }
}

// ---------- rules --------------------------------------------------------------
$('ruleSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-rule]') as HTMLButtonElement | null;
  if (!btn) return;
  opts.rule = btn.dataset.rule as Options['rule'];
  all('button[data-rule]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  replan();
});
$('optTemp').addEventListener('change', (e) => { opts.excludeTemp = (e.target as HTMLInputElement).checked; replan(); });
$('optSystem').addEventListener('change', (e) => { opts.excludeSystem = (e.target as HTMLInputElement).checked; replan(); });

// ---------- plan preview ---------------------------------------------------------
function replan(): void {
  if (!sel.files.length) return;
  plan = buildPlan(sel.files, opts);

  const out = $('planOut');
  const groups: string[] = [];

  for (const [name, files] of plan.byCategory) {
    const folderLabel =
      opts.rule === 'type'
        ? `${name}/`
        : opts.rule === 'date'
          ? `${firstMonth(files)}}${'/' /* fixed below */}`
          : `${'<ext>'}/…`;
    const head =
      opts.rule === 'type'
        ? `${name}/`
        : opts.rule === 'date'
          ? `${firstMonth(files)}/${name}/`
          : `${'.' + (files[0]!.name.split('.').pop() ?? '')}/`;
    void folderLabel;
    void head;

    groups.push(`
      <div class="plan-cat">
        <div class="plan-cat-head">
          <span class="plan-cat-name">
            <span aria-hidden="true">${CAT_ICONS[name] ?? '📁'}</span>
            <span style="color:var(--cat-${name})">${escapeHtml(planFolderLabel(name, files))}</span>
          </span>
          <span class="plan-cat-count">${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(files.reduce((s, f) => s + f.size, 0))}</span>
        </div>
        <div class="plan-files">
          ${files.slice(0, 6).map(renderPlanRow).join('')}
          ${files.length > 6 ? `<div class="text-xs" style="padding:4px 2px; color: var(--text-faint)">…and ${files.length - 6} more</div>` : ''}
        </div>
      </div>`);
  }

  const skipNotes: string[] = [];
  if (plan.tempCount) skipNotes.push(`${plan.tempCount} temp file${plan.tempCount === 1 ? '' : 's'} skipped`);
  if (plan.systemCount) skipNotes.push(`${plan.systemCount} system file${plan.systemCount === 1 ? '' : 's'} skipped`);
  if (plan.unknownExtensions.size) skipNotes.push(`unknown types sorted into Others: ${[...plan.unknownExtensions].map(escapeHtml).join(', ')}`);

  out.innerHTML =
    groups.length === 0
      ? `<div class="empty-mini"><p class="text-muted">Nothing to organize — every selected file was skipped.</p></div>`
      : `${groups.join('')}
         ${skipNotes.length ? `<p class="text-sm text-muted" style="margin: var(--s-3) 0 0">${skipNotes.join(' · ')}</p>` : ''}`;

  // header stats
  $('statsRow').innerHTML = `
    <span class="badge">${sel.files.length} files · ${formatBytes(plan.totalSize)}</span>
    <span class="badge">${plan.byCategory.size} categor${plan.byCategory.size === 1 ? 'y' : 'ies'}</span>
    ${plan.conflictsResolved ? `<span class="badge badge-warn">${plan.conflictsResolved} naming conflict${plan.conflictsResolved === 1 ? '' : 's'} → auto-renamed</span>` : ''}
    <span class="badge badge-ok">0 overwrites</span>`;

  const execBtn = $('btnExecute') as HTMLButtonElement;
  execBtn.disabled = plan.organizedFiles === 0;
  $('btnExecuteN').textContent = plan.organizedFiles ? ` ${plan.organizedFiles} file${plan.organizedFiles === 1 ? '' : 's'}` : '';
  renderList();
}

function planFolderLabel(category: string, files: PlanEntry[]): string {
  const first = files[0];
  if (opts.rule === 'type') return `${category}/`;
  if (opts.rule === 'date') return `${firstMonth(files)}/${category}/`;
  // Read the sanitized folder the plan actually computed (extensions come
  // from user filenames — never interpolate them raw into the DOM).
  const extFolder = first?.destination[1];
  return extFolder ? `${extFolder}/` : 'no-extension/';
}

function renderPlanRow(e: PlanEntry): string {
  const folder = e.destination.length ? e.destination.slice(0, -1 + 1).join('/') : '';
  return `<div class="plan-row${e.renamed ? ' is-renamed' : ''}">
    <span class="src" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
    <span class="arrow" aria-hidden="true">→</span>
    <span class="dest">
      <span class="plan-arrow-dest">
        <span class="plan-folder" title="${escapeHtml(folder + '/')}">${escapeHtml(folder)}/</span>
        <span title="${escapeHtml(e.finalName)}">${escapeHtml(e.finalName)}</span>
      </span>
      ${e.renamed ? '<span class="renamed-tag">renamed</span>' : ''}
    </span>
  </div>`;
}

function firstMonth(files: { lastModified: number }[]): string {
  if (!files.length) return '(no date)';
  const d = new Date(files[0]!.lastModified);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- duplicates ------------------------------------------------------------
$('btnDupes').addEventListener('click', scanDuplicates);

async function scanDuplicates(): Promise<void> {
  if (!sel.files.length) return;
  const jobId = ++hashJobId;
  const btn = $('btnDupes') as HTMLButtonElement;
  btn.disabled = true;
  const out = $('dupesOut');
  out.hidden = false;
  out.innerHTML = `<p class="text-sm text-muted">Comparing ${sel.files.length} files by size…</p>`;

  // Desktop parity: group by exact size first; hash only same-size candidates.
  const bySize = new Map<number, File[]>();
  for (const f of sel.files) {
    let list = bySize.get(f.size);
    if (!list) bySize.set(f.size, (list = []));
    list.push(f);
  }
  const sizeGroups = [...bySize.values()].filter((l) => l.length >= 2);
  const uniqueBySize = sel.files.length - sizeGroups.reduce((s, l) => s + l.length, 0);

  const LARGE = 512 * 1024 * 1024; // honesty cap for hashing
  let skippedLarge = 0;
  const keyLabel = new Map<string, string>();
  const hashes = new Map<string, string>();
  let hashed = 0;
  const total = sizeGroups.reduce((s, l) => s + l.filter((f) => f.size <= LARGE).length, 0);

  for (const list of sizeGroups) {
    for (const f of list) {
      if (f.size > LARGE) {
        skippedLarge++;
        continue;
      }
      if (jobId !== hashJobId) return;
      const key = `${f.name}:${f.size}:${hashes.size + 1}`;
      keyLabel.set(key, f.name);
      const sha = new Sha256();
      await forEachChunk(f, (chunk) => {
        sha.update(chunk);
      });
      hashes.set(key, sha.digestHex());
      hashed++;
      if (hashed % 4 === 0 || hashed === total) {
        out.innerHTML = `<p class="text-sm text-muted" aria-live="polite">Hashing file ${hashed}/${total}… (streamed in 4 MB chunks)</p>`;
      }
    }
  }
  if (jobId !== hashJobId) return;

  const groups = groupByHash(hashes);

  btn.disabled = false;
  if (skippedLarge) {
    toast(`${skippedLarge} file${skippedLarge === 1 ? '' : 's'} over 512 MB couldn't be hashed (browser limits)`, 'err');
  }

  if (groups.length === 0) {
    out.innerHTML = `<p class="text-sm text-muted" style="margin-bottom:0">✓ No duplicate content found among ${total} comparable files (${uniqueBySize} already unique by size).</p>`;
    return;
  }

  out.innerHTML = `
    <p style="margin-bottom: var(--s-2)"><strong style="color:var(--accent-warm)">${groups.length} duplicate group${groups.length === 1 ? '' : 's'}</strong>
    <span class="text-muted text-sm"> — identical content verified by SHA-256. AuraFlow doesn't delete anything automatically.</span></p>
    ${groups
      .slice(0, 8)
      .map((g) => `<div class="dup-group"><span class="dup-badge">DUPLICATE</span> ${g.files.length} copies<ul style="margin:6px 0 0; padding-left:1.2rem; color:var(--text-muted)">${g.files
        .map((k) => `<li>${escapeHtml(keyLabel.get(k) ?? k)}</li>`)
        .join('')}</ul></div>`)
      .join('')}
    ${groups.length > 8 ? `<p class="text-sm text-muted">…and ${groups.length - 8} more groups. Download the manifest for the full list.</p>` : ''}`;
}

// ---------- plan exports ------------------------------------------------------------
$('btnDownloadPlan').addEventListener('click', () => {
  if (!plan) return;
  downloadManifestJson(planToManifest());
  toast('Plan (JSON) downloaded', 'ok');
});
$('btnDownloadCsv').addEventListener('click', () => {
  if (!plan) return;
  downloadManifestCsv(planToManifest());
  toast('Plan (CSV) downloaded', 'ok');
});

function planToManifest(): Manifest {
  const m = createManifest(sel.rootName, opts.rule);
  for (const e of plan?.entries ?? []) {
    if (e.skip) m.skipped.push({ file: e.name, reason: e.skip });
    else m.moves.push({ from: e.name, to: destinationPath(e), category: e.category, size: e.size });
  }
  return m;
}

// ---------- execute --------------------------------------------------------------------
$('btnExecute').addEventListener('click', () => {
  if (!plan || plan.organizedFiles === 0) return;
  resetResults();

  if (capabilities().directWrite) {
    $('execWrite').hidden = false;
    $('execZip').hidden = true;
    const exts = plan.byCategory.size;
    $('execWriteDesc').textContent = `${plan.organizedFiles} files will move into ${exts} categor${exts === 1 ? 'y' : 'ies'} inside the folder you pick next. Nothing is overwritten — conflicts are renamed. You can undo afterwards.`;
  } else {
    $('execWrite').hidden = true;
    $('execZip').hidden = false;
  }
  $('executePanel').hidden = false;
});

$('btnGrantWrite').addEventListener('click', async () => {
  const dir = await pickDirectory();
  if (!dir) {
    toast('No folder was granted — nothing was organized', 'err');
    return;
  }
  lastDirHandle = dir;
  await runExecute(dir);
});

$('btnZipGo').addEventListener('click', async () => {
  if (!plan) return;
  const entries: ZipEntry[] = plan.entries.filter((e) => !e.skip).map((e) => ({ path: destinationPath(e), file: e.file }));
  if (!entries.length) return;

  startProgress('Building organized ZIP…');
  try {
    const zip = await buildZip(entries, (done, total) => {
      const f = done / Math.max(1, total);
      setProgress(f, `${Math.round(f * 100)}% — ${Math.round(total / 1e6)} MB total`);
    });
    downloadBlob(zip.blob, `auraflow-organized-${new Date().toISOString().slice(0, 10)}.zip`);

    manifest = planToManifest();
    for (const mv of manifest.moves) mv.note = 'stored in the organized ZIP (this browser cannot write folders)';
    undoLog = [];
    showResults(manifest, false);
    finishProgress();
    toast(`ZIP built — ${zip.entries} files inside`, 'ok');
  } catch (err) {
    finishProgress();
    toast(err instanceof Error ? err.message : 'ZIP building failed', 'err');
  }
});

$('btnCancel').addEventListener('click', () => {
  session.cancel();
  $('execCurrent').textContent = 'cancelling…';
});

async function runExecute(dir: DirHandle): Promise<void> {
  if (!plan) return;
  startProgress('Organizing…');
  session.cancelled = false;
  try {
    const res = await executePlan(
      plan,
      dir,
      sel.rootName,
      {
        onProgress: (done, total, current) => {
          setProgress(done / Math.max(1, total), current);
          $('execLabel').textContent = `Organizing ${done}/${total}…`;
        },
      },
      session,
    );
    finishProgress();
    manifest = res.manifest;
    undoLog = res.undo;
    showResults(res.manifest, undoLog.length > 0);
    toast(
      res.manifest.errors.length
        ? `Finished with ${res.manifest.errors.length} error${res.manifest.errors.length === 1 ? '' : 's'} — see results`
        : `Done — ${res.manifest.moves.length} file${res.manifest.moves.length === 1 ? '' : 's'} organized`,
      res.manifest.errors.length ? 'err' : 'ok',
    );
    if (innerWidth < 980) $('resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    finishProgress();
    toast(err instanceof Error ? `Organization failed: ${err.message}` : 'Organization failed', 'err');
  }
}

// ---------- results ------------------------------------------------------------------
function resetResults(): void {
  $('resultsPanel').hidden = true;
  manifest = null;
  undoLog = [];
}

function showResults(m: Manifest, canUndo: boolean): void {
  $('resultsPanel').hidden = false;

  $('resultsHead').innerHTML = `
    <h2 id="results-h" style="font-size:var(--fs-xl); margin-bottom:4px">Run summary</h2>
    <p class="text-muted text-sm">${new Date(m.createdAt).toLocaleString()} — from “${escapeHtml(m.root)}”, organized by ${escapeHtml(m.rule)}.</p>
    <div class="results-summary" role="list">
      <div class="res-stat" role="listitem"><b style="color:var(--success)">${m.moves.length}</b><span>organized</span></div>
      <div class="res-stat" role="listitem"><b>${m.skipped.length}</b><span>skipped (by settings)</span></div>
      <div class="res-stat" role="listitem"><b>${m.moves.filter((mv) => mv.note?.startsWith('copied')).length}</b><span>copied (original kept)</span></div>
      <div class="res-stat" role="listitem"><b style="color:${m.errors.length ? 'var(--danger)' : 'inherit'}">${m.errors.length}</b><span>errors</span></div>
    </div>`;

  const catCount = new Map<string, number>();
  for (const mv of m.moves) catCount.set(mv.category, (catCount.get(mv.category) ?? 0) + 1);

  const tables: string[] = [];
  if (m.moves.length) {
    tables.push(`<div class="table-wrap"><table class="results-table">
      <thead><tr><th scope="col">Category</th><th scope="col">File</th><th scope="col">Destination</th></tr></thead>
      <tbody>${m.moves
        .slice(0, 200)
        .map(
          (mv) =>
            `<tr><td>${escapeHtml(mv.category)}</td><td>${escapeHtml(mv.from)}</td><td>${escapeHtml(mv.to)}${mv.note ? ` <span class="renamed-tag">${escapeHtml(mv.note)}</span>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div>`);
    if (m.moves.length > 200) tables.push(`<p class="text-sm text-muted">…first 200 shown. Download the manifest for the complete list.</p>`);
  }

  if (m.errors.length) {
    tables.push(
      `<p style="margin:var(--s-4) 0 var(--s-2); color:var(--danger); font-weight:600">Errors (${m.errors.length})</p>
       <ul class="text-sm text-muted" style="margin:0; padding-left:1.2rem">${m.errors
         .slice(0, 8)
         .map((e) => `<li><code>${escapeHtml(e.file)}</code> — ${escapeHtml(e.message)}</li>`)
         .join('')}</ul>
       <p class="text-sm text-muted">Tip: files can fail to move if they're open in another program or the folder lost write permission. Everything else was still organized.</p>`,
    );
  }

  if (!m.moves.length && !m.errors.length) {
    tables.push(`<p class="text-muted">Nothing was moved.</p>`);
  } else if (m.skipped.length) {
    tables.push(
      `<p class="text-sm text-muted" style="margin-top:var(--s-4)">Left untouched on purpose: ${m.skipped
        .slice(0, 8)
        .map((s) => escapeHtml(s.file))
        .join(', ')}${m.skipped.length > 8 ? ` …and ${m.skipped.length - 8} more` : ''}.</p>`,
    );
  }

  $('resultsTable').innerHTML = tables.join('');
  ($('btnUndo') as HTMLElement).style.display = canUndo ? '' : 'none';
}

$('btnExportJson').addEventListener('click', () => manifest && (downloadManifestJson(manifest), toast('Manifest (JSON) downloaded', 'ok')));
$('btnExportCsv').addEventListener('click', () => manifest && (downloadManifestCsv(manifest), toast('Manifest (CSV) downloaded', 'ok')));
$('btnExportTxt').addEventListener('click', () => manifest && (downloadReportTxt(manifest), toast('Report (TXT) downloaded', 'ok')));

$('btnUndo').addEventListener('click', async () => {
  if (!undoLog.length || !lastDirHandle) {
    toast('Nothing recorded to undo in this session', 'err');
    return;
  }
  const ok = confirm(
    `Undo this run? ${undoLog.length} file${undoLog.length === 1 ? '' : 's'} will return to their original place. (Desktop-app style undo — only possible while this tab stays open.)`,
  );
  if (!ok) return;

  startProgress('Undoing…');
  try {
    const res = await undoMoves(undoLog, lastDirHandle, {
      onProgress: (done, total, current) => {
        setProgress(done / Math.max(1, total), current);
        $('execLabel').textContent = `Restoring ${done}/${total}…`;
      },
    });
    finishProgress();

    if (res.failed.length === 0) {
      toast(`Undo complete — ${res.restored} file${res.restored === 1 ? '' : 's'} moved back`, 'ok');
      undoLog = [];
      const empty = createManifest(sel.rootName, opts.rule);
      showResults({ ...empty, moves: manifest?.moves ?? [], errors: [{ file: '(all restored)', message: 'Run was undone — files are back in their original place.' }] }, false);
      ($('btnUndo') as HTMLElement).style.display = 'none';
    } else {
      toast(`Undo restored ${res.restored} files; ${res.failed.length} failed — they may have been moved manually`, 'err');
    }
  } catch (err) {
    finishProgress();
    toast(err instanceof Error ? err.message : 'Undo failed', 'err');
  }
});

// ---------- progress helpers ----------------------------------------------------------
function startProgress(label: string): void {
  $('execProgress').hidden = false;
  $('execLabel').textContent = label;
  setProgress(0, '');
}
function setProgress(f: number, current: string): void {
  $('execBar').style.width = `${Math.min(100, Math.max(2, f * 100))}%`;
  $('execCurrent').textContent = current;
}
function finishProgress(): void {
  $('execBar').style.width = '100%';
  $('execProgress').hidden = true;
}

void ICONS;
