/**
 * AuraFlow Web — home page logic: categories grid + inline demo
 */

import '../styles/hero.css';
import { CATEGORIES } from '../core/categories.js';
import { buildPlan, formatBytes, Plan, Options, DEFAULT_OPTIONS } from '../core/plan.js';
import { toCsv, downloadBlob } from '../core/export.js';
import { initHero } from '../hero/hero.js';
import { readFromDrop } from '../fs/access.js';
import { toast } from '../site/layout.js';
import './home-demo.css';

const icons: Record<string, string> = {
  doc: '📄', image: '🖼️', video: '🎬', audio: '🎵', archive: '📦',
  code: '💻', app: '⚙️', design: '🎨', font: '🔤', data: '📊', other: '📁',
};

// ---- Categories grid -------------------------------------------------------
const grid = document.getElementById('cats-grid');
if (grid) {
  grid.innerHTML = CATEGORIES.map((c) => {
    const sample = c.extensions.slice(0, 5).map((e) => `<code>${e.replace('.', '')}</code>`).join(' ');
    const more = c.extensions.length > 5 ? `<span class="text-faint">+${c.extensions.length - 5} more</span>` : '';
    return `<div class="card" style="padding: var(--s-4)">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px">
        <span aria-hidden="true" style="font-size:1.2rem">${icons[c.icon] ?? '📁'}</span>
        <h3 style="margin:0; font-size: 1rem">${c.label}</h3>
      </div>
      <p class="text-sm text-muted" style="margin-bottom:8px">${c.description}</p>
      <div class="text-sm" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center">${sample}${more}</div>
    </div>`;
  }).join('');
}

// ---- Inline demo ------------------------------------------------------------
const pick = document.getElementById('demoPick') as HTMLButtonElement | null;
const input = document.getElementById('demoInput') as HTMLInputElement | null;
const out = document.getElementById('demoOut')!;
const empty = document.getElementById('demoEmpty')!;
const resultBar = document.getElementById('demoResult')!;
let demoFiles: File[] = [];
let lastPlan: Plan | null = null;

const demoOpts: Options = { ...DEFAULT_OPTIONS };

pick?.addEventListener('click', () => input?.click());
input?.addEventListener('change', async () => {
  if (input.files?.length) setFiles(input.files);
});

// Drag & drop onto the demo card
const demoCard = out.closest('.card')!;
demoCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  demoCard.classList.add('drag-on');
});
demoCard.addEventListener('dragleave', () => demoCard.classList.remove('drag-on'));
demoCard.addEventListener('drop', async (e) => {
  e.preventDefault();
  demoCard.classList.remove('drag-on');
  const res = await readFromDrop(e as DragEvent);
  if (res) {
    setFiles(res.files, res.warnings);
  } else {
    toast('Drop files (or a folder) onto this area', 'err');
  }
});

function setFiles(files: FileList | File[], warnings: string[] = []): void {
  demoFiles = [...files];
  lastPlan = buildPlan(demoFiles, demoOpts);
  empty.hidden = true;
  resultBar.hidden = false;

  const cats = lastPlan.byCategory;
  const rows: string[] = [];
  for (const [name, files] of cats) {
    const color = `var(--cat-${name})`;
    rows.push(`
      <div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border)">
        <span style="width:10px; height:10px; border-radius:50%; background:${color}; flex-shrink:0" aria-hidden="true"></span>
        <strong style="min-width:120px">${name}</strong>
        <span class="text-muted text-sm">${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((s, f) => s + f.size, 0))}</span>
        <span class="text-sm text-muted" style="margin-left:auto; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:45%">${files.slice(0, 3).map((f) => escapeHtml(f.name)).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}</span>
      </div>`);
  }
  const skippedBits: string[] = [];
  if (lastPlan.tempCount) skippedBits.push(`${lastPlan.tempCount} temporary`);
  if (lastPlan.systemCount) skippedBits.push(`${lastPlan.systemCount} system`);
  if (lastPlan.organizedFiles === 0 && !skippedBits.length) skippedBits.push('no organizable files found');

  out.innerHTML = `
    <p class="text-sm text-muted">${lastPlan.organizedFiles} file${lastPlan.organizedFiles === 1 ? '' : 's'} ready to sort · ${formatBytes(lastPlan.totalSize)}${skippedBits.length ? ` · ${skippedBits.join(', ')} left untouched` : ''}</p>
    ${warnings.length ? `<p class="text-sm" style="color:var(--accent-warn, var(--accent-warm))">${warnings.map(escapeHtml).join('<br>')}</p>` : ''}
    ${rows.join('')}`;
}

document.getElementById('demoDownload')?.addEventListener('click', () => {
  if (!lastPlan) return;
  const header = ['original_name', 'proposed_destination', 'category', 'size_bytes', 'status'];
  const rows = [
    header,
    ...lastPlan.entries
      .filter((e) => !e.skip)
      .map((e) => [e.name, e.finalName, e.category, String(e.size), 'planned']),
    ...lastPlan.entries
      .filter((e) => e.skip)
      .map((e) => [e.name, '', e.category, String(e.size), `skipped (${e.skip})`]),
  ];
  downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'auraflow-demo-plan.csv');
  toast('Plan downloaded — check your downloads', 'ok');
});

document.getElementById('demoReset')?.addEventListener('click', () => {
  demoFiles = [];
  lastPlan = null;
  out.innerHTML = '';
  empty.hidden = false;
  resultBar.hidden = true;
  out.appendChild(empty);
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

initHero();
