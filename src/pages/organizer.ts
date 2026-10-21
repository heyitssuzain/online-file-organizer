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
import { createManifest, Manifest, statusOf } from '../core/manifest.js';
import { downloadManifestCsv, downloadManifestJson, downloadReportTxt, downloadBlob } from '../core/export.js';
import { buildZip, ZipEntry } from '../core/zip.js';
import { forEachChunk, groupByHash } from '../core/hash.js';
import { Sha256 } from '../core/sha256.js';
import {
  capabilities,
  pickDirectoryDetailed,
  pickFileHandles,
  readDirectoryHandle,
  readFromDrop,
  readFromFileHandles,
  readFromInput,
  snapshotDestinations,
  verifyPermission,
  DirHandle,
  ReadRecursiveResult,
} from '../fs/access.js';
import { executePlan, undoMoves, OpSession, ExecResult, ExecMode, SourceMap, SourceMeta } from '../fs/operations.js';
import { toast, ICONS } from '../site/layout.js';

// ---------- state ------------------------------------------------------------
interface Selection {
  files: File[];
  rootName: string;
  dirHandle: DirHandle | null;
  sources: SourceMap;
}

let sel: Selection = { files: [], rootName: '', dirHandle: null, sources: new Map() };
let plan: Plan | null = null;
let opts: Options = { ...DEFAULT_OPTIONS };
let manifest: Manifest | null = null;
let undoLog: ExecResult['undo'] = [];
let lastDirHandle: DirHandle | null = null;
let lastSourceHandle: DirHandle | null = null;
const session = new OpSession();
let hashJobId = 0;
let planVersion = 0;
let hasExecuted = false;
let execMode: ExecMode = 'move';

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
async function chooseFolder(): Promise<void> {
  if (capabilities().directWrite) {
    const picked = await pickDirectoryDetailed();
    if (picked.status === 'picked') {
      hideSourceNotice();
      await loadDirectory(picked.dir);
      return;
    }
    if (picked.status === 'cancelled') return;
    if (picked.status === 'blocked') {
      showSourceNotice();
      return;
    }
    if (picked.status === 'unsupported') {
      $('dirInput').click();
      return;
    }
    toast(`Could not open that folder: ${picked.message}`, 'err');
    return;
  }
  $('dirInput').click();
}

async function loadDirectory(dir: DirHandle): Promise<void> {
  toast(`Reading "${dir.name}" …`, 'ok');
  const res = await readDirectoryHandle(dir, {
    onProgress: (n) => ($('appHeadStatus').textContent = `Reading ${n} files…`),
  });
  remember(res, dir.name, dir);
}

async function chooseFiles(startIn?: 'downloads'): Promise<void> {
  if (capabilities().filePicker) {
    const picked = await pickFileHandles(startIn);
    if (picked.status === 'picked') {
      if (!picked.handles.length) {
        toast('No files were selected', '');
        return;
      }
      hideSourceNotice();
      const res = await readFromFileHandles(picked.handles);
      const count = res.files.length;
      remember(res, count === 1 ? res.files[0]!.name : `${count} selected files`, null);
      return;
    }
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      toast(`Could not open the file picker: ${picked.message}`, 'err');
      return;
    }
    // 'unsupported' falls through to the classic <input multiple> picker.
  }
  $('fileInput').click();
}

function showSourceNotice(): void {
  $('sourceNotice').hidden = false;
  $('appHeadStatus').textContent =
    'Chrome blocked whole-folder access. Use Select files for Downloads, or drag a subfolder here — that keeps Move available.';
  $('sourceNotice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideSourceNotice(): void {
  $('sourceNotice').hidden = true;
}

$('btnFolder').addEventListener('click', () => void chooseFolder());
$('btnPickFilesInstead').addEventListener('click', () => void chooseFiles('downloads'));
$('btnRetryFolder').addEventListener('click', () => void chooseFolder());
$('btnCopyFolder').addEventListener('click', () => {
  hideSourceNotice();
  $('appHeadStatus').textContent =
    'Using the classic folder picker: AuraFlow can read and copy this folder, but the browser will not let it remove the originals.';
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
$('btnFiles').addEventListener('click', () => void chooseFiles());

function useInputFiles(list: FileList, isFolder: boolean): void {
  const files = [...list];
  const rootName = isFolder
    ? trimmedRoot(files[0])
    : files.length === 1
      ? files[0]!.name
      : `${files.length} selected files`;
  remember(readFromInput(files), rootName, null);
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
  try {
    const res = await readFromDrop(drag);
    if (res) {
      const rootName = res.root?.name ?? (res.files.length === 1 ? res.files[0]!.name : 'dropped files');
      remember(res, rootName, res.root ?? null);
    } else if (drag.dataTransfer?.files?.length) {
      const files = [...drag.dataTransfer.files];
      remember(readFromInput(files), files.length === 1 ? files[0]!.name : 'dropped files', null);
    } else {
      toast('Nothing readable was dropped — try files or a subfolder', 'err');
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not read the dropped item', 'err');
  }
});

function sourcesFrom(res: ReadRecursiveResult): SourceMap {
  const sources = new Map<File, SourceMeta>();
  for (const file of res.files) {
    sources.set(file, {
      path: res.paths.get(file) ?? file.name,
      handle: res.handles.get(file),
      parent: res.parents.get(file),
    });
  }
  return sources;
}

function remember(res: ReadRecursiveResult, rootName: string, dir: DirHandle | null): void {
  hideSourceNotice();
  sel = { files: [...res.files], rootName, dirHandle: dir, sources: sourcesFrom(res) };
  manifest = null;
  undoLog = [];
  lastDirHandle = null;
  lastSourceHandle = null;
  hasExecuted = false;
  resetResults();
  $('executePanel').hidden = true;

  const hasFiles = res.files.length > 0;
  $('workspace').hidden = !hasFiles;
  $('countBadge').textContent = String(res.files.length);

  if (hasFiles) {
    $('appHeadStatus').textContent = `“${rootName}” — ${res.files.length} file${res.files.length === 1 ? '' : 's'} selected. Review the plan below, then confirm.`;
  } else if (res.warnings.some((w) => w.startsWith('Skipped '))) {
    $('appHeadStatus').textContent =
      'No new files found — this folder already contains organized output, which was skipped. Add new files or pick a different folder.';
  } else {
    $('appHeadStatus').textContent = 'No readable files found — try a different folder.';
  }

  replan();
  for (const w of res.warnings) toast(w, /^Skipped /.test(w) ? '' : 'err');
  if (hasFiles && innerWidth < 980) $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('btnClear').addEventListener('click', () => {
  sel = { files: [], rootName: '', dirHandle: null, sources: new Map() };
  plan = null;
  hashJobId++;
  planVersion++;
  lastDirHandle = null;
  lastSourceHandle = null;
  hasExecuted = false;
  $('workspace').hidden = true;
  $('executePanel').hidden = true;
  $('countBadge').textContent = '0';
  resetResults();
  $('dupesOut').hidden = true;
  hideSourceNotice();
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
    case 'already-organized': return 'already organized';
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
  const version = ++planVersion;
  plan = buildPlan(sel.files, opts);
  renderPlan();

  if (!sel.dirHandle) return;
  const destinations = [...new Set(plan.entries.filter((e) => !e.skip).map((e) => e.destination))];
  if (!destinations.length) return;

  // Re-plan with the files already inside destination folders so the preview
  // resolves collisions before execution (execution re-checks at write time).
  void snapshotDestinations(sel.dirHandle, destinations)
    .then((existing) => {
      if (version !== planVersion || !sel.files.length) return;
      plan = buildPlan(sel.files, opts, existing);
      renderPlan();
    })
    .catch(() => {
      /* preview stays usable; execution re-checks collisions */
    });
}

function renderPlan(): void {
  if (!plan) return;
  const out = $('planOut');
  const groups: string[] = [];

  for (const [name, files] of plan.byCategory) {
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

function sourcePathFor(e: PlanEntry): string {
  return sel.sources.get(e.file)?.path ?? e.name;
}

function renderPlanRow(e: PlanEntry): string {
  const folder = e.destination.join('/');
  const source = sourcePathFor(e);
  return `<div class="plan-row${e.renamed ? ' is-renamed' : ''}">
    <span class="src" title="${escapeHtml(source)}">${escapeHtml(source)}</span>
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
    if (e.skip) m.skipped.push({ file: sourcePathFor(e), reason: e.skip });
    else m.moves.push({ from: sourcePathFor(e), to: destinationPath(e), category: e.category, size: e.size });
  }
  return m;
}

// ---------- execute --------------------------------------------------------------------
$('btnExecute').addEventListener('click', () => {
  if (!plan || plan.organizedFiles === 0) return;
  if (hasExecuted) {
    toast('This plan has already run — select the folder again to start a fresh run', 'err');
    return;
  }
  resetResults();

  if (capabilities().directWrite) {
    $('execWrite').hidden = false;
    $('execZip').hidden = true;

    setExecMode(canMoveSelection() ? 'move' : 'copy');
    const sortBtn = $('btnSortHere') as HTMLElement;
    sortBtn.hidden = !sel.dirHandle;
    sortBtn.style.display = sel.dirHandle ? '' : 'none';
    updateExecDescription();
  } else {
    $('execWrite').hidden = true;
    $('execZip').hidden = false;
  }
  $('executePanel').hidden = false;
});

$('modeSeg').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  setExecMode(btn.dataset.mode as ExecMode);
  updateExecDescription();
});

function sourceCanBeRemoved(source: SourceMeta | undefined): boolean {
  if (!source) return false;
  const cap = capabilities();
  if (source.parent?.removeEntry) return cap.directMove;
  return (
    cap.fileRemoval &&
    typeof (source.handle as (FileSystemFileHandle & { remove?: () => Promise<void> }) | undefined)?.remove === 'function'
  );
}

/** Every selected file must have a removable handle for a true move. */
function canMoveSelection(): boolean {
  return sel.files.length > 0 && sel.files.every((f) => sourceCanBeRemoved(sel.sources.get(f)));
}

/**
 * For individually picked files, ask for write permission while the click's
 * user activation is still fresh. Without this, the request after a long copy
 * can be rejected by the browser and the move would silently become a copy.
 */
async function ensureSourceMovePermission(): Promise<boolean> {
  for (const file of sel.files) {
    const source = sel.sources.get(file);
    if (!source?.handle || source.parent?.removeEntry) continue;
    if (!(await verifyPermission(source.handle, 'readwrite'))) return false;
  }
  return true;
}

function setExecMode(mode: ExecMode): void {
  const canMove = canMoveSelection();
  if (mode === 'move' && !canMove) mode = 'copy';
  execMode = mode;
  all<HTMLButtonElement>('#modeSeg button').forEach((btn) => {
    const isMove = btn.dataset.mode === 'move';
    btn.disabled = isMove && !canMove;
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
}

function currentMode(): ExecMode {
  return execMode === 'move' && canMoveSelection() ? 'move' : 'copy';
}

function updateExecDescription(): void {
  const n = plan?.organizedFiles ?? 0;
  const mode = currentMode();
  const canMove = canMoveSelection();
  const where = sel.dirHandle
    ? `inside “${sel.rootName}” or into a different folder you choose`
    : 'into a destination folder you choose';
  const safety = mode === 'move'
    ? ' A verified copy is written first; each original is removed only after that verification.'
    : ' Originals stay untouched.';
  const why = canMove
    ? ''
    : sel.dirHandle
      ? ' Move is not available in this browser; choose Copy.'
      : ' Move needs direct access to the originals. Selections made with the classic folder picker can only be copied — for Downloads, use Select files or drag files/a subfolder.';
  const undoNote = mode === 'move' && !sel.dirHandle
    ? ' Undo is unavailable for individually picked files because the browser does not expose their original folder.'
    : '';
  $('execWriteDesc').textContent =
    `${n} file${n === 1 ? '' : 's'} will be ${mode === 'move' ? 'moved' : 'copied'} ${where}.${safety}${why}${undoNote} Nothing is overwritten — conflicts are renamed.`;
  $('modeNote').textContent = canMove
    ? mode === 'move'
      ? sel.dirHandle
        ? 'Move deletes the original only after the destination copy is verified. Undo is available for this folder run.'
        : 'Move deletes the original only after the destination copy is verified. Undo is unavailable for individually picked files because their parent folder was never exposed.'
      : 'Copy keeps every original exactly where it is.'
    : 'This selection is copy-only because the browser did not grant a removable handle to the originals.';
}

$('btnSortHere').addEventListener('click', async () => {
  if (!sel.dirHandle) return;
  if (!(await verifyPermission(sel.dirHandle, 'readwrite'))) {
    toast('Write permission was denied — nothing was changed', 'err');
    return;
  }
  await runExecute(sel.dirHandle, currentMode(), sel.dirHandle);
});

$('btnGrantWrite').addEventListener('click', async () => {
  if (currentMode() === 'move' && !(await ensureSourceMovePermission())) {
    setExecMode('copy');
    updateExecDescription();
    toast('Chrome did not grant permission to remove the originals — switched to Copy. Choose Move and try again if you want to retry.', 'err');
  }
  const picked = await pickDirectoryDetailed();
  if (picked.status !== 'picked') {
    if (picked.status === 'blocked') {
      toast(
        'Chrome blocks Downloads/Documents as a whole-folder destination. Choose a subfolder inside it or another folder.',
        'err',
      );
    } else if (picked.status !== 'cancelled') {
      toast('No destination folder was granted — nothing was changed', 'err');
    }
    return;
  }
  const dir = picked.dir;
  if (!(await verifyPermission(dir, 'readwrite'))) {
    toast('Write permission was denied — originals were not touched', 'err');
    return;
  }
  await runExecute(dir, currentMode(), sel.dirHandle);
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
    for (const mv of manifest.moves) mv.note = 'exported — originals kept';
    undoLog = [];
    showResults(manifest, false, 'export');
    finishProgress();
    toast(`ZIP downloaded — ${zip.entries} files inside; originals untouched`, 'ok');
  } catch (err) {
    finishProgress();
    toast(err instanceof Error ? err.message : 'ZIP building failed', 'err');
  }
});

$('btnCancel').addEventListener('click', () => {
  session.cancel();
  $('execCurrent').textContent = 'cancelling…';
});

async function runExecute(target: DirHandle, mode: ExecMode, sourceRoot: DirHandle | null): Promise<void> {
  if (!plan) return;

  if (mode === 'move' && !canMoveSelection()) {
    toast('This selection cannot remove originals — choose Copy, use Select files, or use the ZIP export', 'err');
    return;
  }
  if (mode === 'move') {
    const ok = confirm(
      `Move ${plan.organizedFiles} file${plan.organizedFiles === 1 ? '' : 's'}?\n\n` +
        'A copy is written and verified first. Originals are removed only after that verification. ' +
        'Existing files are never overwritten (conflicts are renamed).',
    );
    if (!ok) return;
  }

  startProgress(mode === 'move' ? 'Moving…' : 'Copying…');
  session.cancelled = false;
  try {
    const res = await executePlan(
      plan,
      target,
      sel.rootName,
      {
        onProgress: (done, total, current) => {
          setProgress(done / Math.max(1, total), current);
          $('execLabel').textContent = `${mode === 'move' ? 'Moving' : 'Copying'} ${done}/${total}…`;
        },
      },
      session,
      { mode, sources: sel.sources, sourceRoot: sourceRoot ?? undefined, rule: opts.rule },
    );
    finishProgress();
    manifest = res.manifest;
    undoLog = res.undo;
    lastDirHandle = target;
    lastSourceHandle = sourceRoot;
    hasExecuted = true;
    const movedCount = res.manifest.moves.filter((mv) => statusOf(mv) === 'moved').length;
    const noUndoNote =
      mode === 'move' && movedCount > 0 && undoLog.length === 0
        ? 'Moved. Undo is unavailable because the browser did not expose the original folder for these individually picked files.'
        : undefined;
    showResults(res.manifest, undoLog.length > 0, mode, noUndoNote);

    const moved = res.manifest.moves.filter((mv) => statusOf(mv) === 'moved').length;
    const copied = res.manifest.moves.length - moved;
    const counts = `${moved} moved${copied ? `, ${copied} copied` : ''}`;
    toast(
      res.manifest.errors.length
        ? `Finished with ${res.manifest.errors.length} error${res.manifest.errors.length === 1 ? '' : 's'} — ${counts}; see results`
        : mode === 'move'
          ? `Done — ${counts}`
          : `Done — ${copied} copied (originals kept)`,
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

function showResults(m: Manifest, canUndo: boolean, workflow: 'move' | 'copy' | 'export', note?: string): void {
  $('resultsPanel').hidden = false;

  const moved = m.moves.filter((mv) => statusOf(mv) === 'moved').length;
  const copied = m.moves.length - moved;
  const primaryLabel = workflow === 'export' ? 'exported (originals kept)' : workflow === 'copy' ? 'copied (originals kept)' : 'moved';

  $('resultsHead').innerHTML = `
    <h2 id="results-h" style="font-size:var(--fs-xl); margin-bottom:4px">Run summary</h2>
    <p class="text-muted text-sm">${new Date(m.createdAt).toLocaleString()} — from “${escapeHtml(m.root)}”, organized by ${escapeHtml(m.rule)}.</p>
    ${note ? `<p class="text-sm" style="margin:0 0 var(--s-2); color:var(--success); font-weight:600">${escapeHtml(note)}</p>` : ''}
    <div class="results-summary" role="list">
      <div class="res-stat" role="listitem"><b style="color:var(--success)">${workflow === 'move' ? moved : copied}</b><span>${primaryLabel}</span></div>
      <div class="res-stat" role="listitem"><b>${m.skipped.length}</b><span>skipped (by settings)</span></div>
      ${workflow === 'move' ? `<div class="res-stat" role="listitem"><b>${copied}</b><span>copied (original kept)</span></div>` : ''}
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
  const sourceRoot = lastSourceHandle ?? lastDirHandle;
  const ok = confirm(
    `Undo this run? ${undoLog.length} file${undoLog.length === 1 ? '' : 's'} will return to their original place. (Desktop-app style undo — only possible while this tab stays open.)`,
  );
  if (!ok) return;

  startProgress('Undoing…');
  try {
    const res = await undoMoves(undoLog, lastDirHandle, sourceRoot, {
      onProgress: (done, total, current) => {
        setProgress(done / Math.max(1, total), current);
        $('execLabel').textContent = `Restoring ${done}/${total}…`;
      },
    });
    finishProgress();

    if (res.failed.length === 0) {
      toast(`Undo complete — ${res.restored} file${res.restored === 1 ? '' : 's'} moved back`, 'ok');
      const copiedBefore = manifest?.moves.filter((mv) => statusOf(mv) !== 'moved').length ?? 0;
      const rule = manifest?.rule ?? opts.rule;
      undoLog = [];
      const empty = createManifest(sel.rootName, rule);
      manifest = { ...empty, moves: [] };
      showResults(
        manifest,
        false,
        'move',
        copiedBefore
          ? `Run was undone — ${res.restored} moved file${res.restored === 1 ? '' : 's'} restored. ${copiedBefore} copied file${copiedBefore === 1 ? '' : 's'} remain in the destination folder (originals were kept).`
          : 'Run was undone — files are back in their original place.',
      );
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
