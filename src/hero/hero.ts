/**
 * AuraFlow Web — interactive 3D hero
 *
 * CHAOS → SORTING → ORGANIZED: floating file cards in a CSS 3D space that
 * gather into their category folders. Plain CSS transforms — no WebGL
 * dependency, respects prefers-reduced-motion, and stays calm on touch screens.
 */

import { CATEGORIES } from '../core/categories.js';

interface CardSpec {
  name: string;
  ext: string;
  cat: string;
}

const FILES: CardSpec[] = [
  { name: 'roadmap.pdf', ext: 'PDF', cat: 'Documents' },
  { name: 'team-shot.jpg', ext: 'IMG', cat: 'Images' },
  { name: 'demo-cut.mp4', ext: 'VID', cat: 'Videos' },
  { name: 'podcast-ep7.mp3', ext: 'WAV', cat: 'Audio' },
  { name: 'assets.zip', ext: 'ZIP', cat: 'Archives' },
  { name: 'analytics.ts', ext: 'TS', cat: 'Code' },
  { name: 'setup_v2.exe', ext: 'EXE', cat: 'Executables' },
  { name: 'hero-scene.blend', ext: '3D', cat: 'Design_3D' },
  { name: 'invoice-04.xlsx', ext: 'XLS', cat: 'Documents' },
  { name: 'logo-icon.svg', ext: 'IMG', cat: 'Images' },
  { name: 'Inter-Var.woff2', ext: 'FONT', cat: 'Fonts' },
  { name: 'backup.7z', ext: '7Z', cat: 'Archives' },
];

const FOLDERS = ['Documents', 'Images', 'Videos', 'Audio', 'Archives', 'Code'] as const;

const FOLDER_LABEL: Record<string, string> = {
  Executables: 'Apps',
  Design_3D: 'Design',
};

const FOLDER_SPOTS: Record<string, { x: number; y: number }> = {
  Documents: { x: 5, y: 12 },
  Images: { x: 5, y: 72 },
  Videos: { x: 38, y: 90 },
  Audio: { x: 88, y: 14 },
  Archives: { x: 86, y: 70 },
  Code: { x: 82, y: 44 },
};

let stage: HTMLElement;
let tilt: HTMLElement;
let mode: 'idle' | 'sorting' | 'done' = 'idle';
let reducedMotion = false;let seed = 42;
function rnd(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

export function initHero(hostSel = '#hero3d'): void {
  const host = document.querySelector<HTMLElement>(hostSel);
  if (!host) return;

  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  stage = host;
  stage.setAttribute('tabindex', '0');
  stage.setAttribute('role', 'img');
  stage.setAttribute(
    'aria-label',
    'Interactive illustration: scattered files sorting themselves into category folders. Activate the Sort the mess button to see it organized.',
  );

  tilt = document.createElement('div');
  tilt.className = 'hero-tilt';
  stage.appendChild(tilt);

  glow();
  composeFolders();
  composeCards();

  if (reducedMotion) rest(true);

  if (matchMedia('(pointer: fine)').matches && !reducedMotion) {
    window.addEventListener('pointermove', onPointer);
  }

  // In-stage action button
  const btn = document.createElement('div');
  btn.className = 'stage-cta';
  btn.innerHTML = `<button class="btn btn-sm btn-secondary" type="button" aria-label="Play the organization animation: scatter the files back or sort them">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>
    <span>Sort the mess</span></button>`;
  stage.appendChild(btn);
  btn.addEventListener('click', () => toggle());
}

function glow(): void {  const el = document.createElement('div');
  el.className = 'hero-grid-glow';
  stage.appendChild(el);
  const halo = document.createElement('div');
  halo.className = 'halo';
  stage.appendChild(halo);
}

function composeFolders(): void {
  for (const name of FOLDERS) {
    const spot = FOLDER_SPOTS[name]!;
    const el = document.createElement('div');
    el.className = 'hfd';
    el.dataset.cat = name;
    el.style.left = `${spot.x}%`;
    el.style.top = `${spot.y}%`;
    el.style.setProperty('--cat', `var(--cat-${name})`);
    el.innerHTML = `
      <svg class="hfd-folder" viewBox="0 0 74 56" aria-hidden="true">
        <path d="M4 12a6 6 0 0 1 6-6h16l6 7h28a6 6 0 0 1 6 6v25a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z" fill="currentColor" opacity="0.28"/>
        <path d="M4 20h66v20a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z" fill="currentColor" opacity="0.9"/>
      </svg>
      <label>${name}</label>`;
    tilt.appendChild(el);
  }
}

function composeCards(): void {
  FILES.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'hf';
    el.dataset.cat = f.cat;
    const color = CATEGORIES.find((c) => c.name === f.cat)?.color ?? '#6b7280';
    const label = FOLDER_LABEL[f.cat] ?? f.cat;
    el.innerHTML = `<span class="hf-ico" style="background:${color}">${f.ext}</span><span>${f.name}<small>${label.toLowerCase()}</small></span>`;
    tilt.appendChild(el);
    scatterAt(el, i);
  });
}

/** Deterministic pseudo-random chaos positions (consistent per page load). */
const chaos: Array<{ x: number; y: number; z: number; r: number }> = [];
(function precomputeChaos() {
  for (let k = 0; k < FILES.length; k++) {
    chaos.push({
      x: 12 + rnd() * 66 + (k % 3) * 2,
      y: 4 + rnd() * 72,
      z: Math.round(rnd() * 240 - 120),
      r: Math.round(rnd() * 28 - 14),
    });
  }
})();

function scatterAt(el: HTMLElement, i: number): void {
  const c = chaos[i]!;
  el.style.left = `${c.x}%`;
  el.style.top = `${c.y}%`;
  el.style.transform = `translate3d(0, 0, ${c.z}px) rotate(${c.r}deg)`;
}

function onPointer(e: PointerEvent): void {
  if (mode !== 'idle') return;
  const nx = (e.clientX / innerWidth - 0.5) * 2;
  const ny = (e.clientY / innerHeight - 0.5) * 2;
  tilt.style.transform = `rotateY(${(nx * 6).toFixed(2)}deg) rotateX(${(-ny * 4).toFixed(2)}deg)`;
}

function toggle(): void {
  if (mode === 'done') scatterOnce();
  else settleOnce();
}

/** The show piece: files fly into their folders. */
function settleOnce(): void {
  if (reducedMotion || mode === 'sorting') {
    rest(true);
    return;
  }
  mode = 'sorting';
  stage.classList.add('sorting');
  const cards = [...stage.querySelectorAll<HTMLElement>('.hf')];

  cards.forEach((el) => {
    const delay = 100 + [...stage.querySelectorAll('.hf')].indexOf(el) * 120;
    setTimeout(() => flyToFolder(el), delay);
  });

  setTimeout(() => {
    stage.classList.remove('sorting');
    stage.classList.add('organized');
    mode = 'done';
    const cap = stage.querySelector('.stage-cta span');
    if (cap) cap.textContent = 'Scatter it back';
  }, 100 + cards.length * 120 + 500);
}

function scatterOnce(): void {
  if (reducedMotion) {
    scatterAll();
    return;
  }
  mode = 'sorting';
  const cards = [...stage.querySelectorAll<HTMLElement>('.hf')];
  cards.forEach((el, i) => setTimeout(() => scatterAt(el, i), 60 + i * 70));
  setTimeout(() => {
    stage.classList.remove('organized', 'sorting');
    mode = 'idle';
    const cap = stage.querySelector('.stage-cta span');
    if (cap) cap.textContent = 'Sort the mess';
  }, 60 + cards.length * 70 + 500);
}

function flyToFolder(el: HTMLElement): void {
  const cat = el.dataset.cat ?? 'Others';
  const label = FOLDER_LABEL[cat] ?? cat;
  const folderEl = [...stage.querySelectorAll<HTMLElement>('.hfd')].find(
    (f) => f.querySelector('label')?.textContent === label,
  );
  const sameCat = [...stage.querySelectorAll<HTMLElement>('.hf')].filter((c) => c.dataset.cat === cat);
  const idx = sameCat.indexOf(el);

  const fx = folderEl ? parseFloat(folderEl.style.left) : 40;
  const fy = folderEl ? parseFloat(folderEl.style.top) : 40;

  const col = idx % 3;
  const row = Math.floor(idx / 3);
  const x = Math.max(2, Math.min(fx + (col - 1) * 13, 80));
  const y = Math.min(fy + 8 + row * 17, 90);
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  el.style.transform = 'translate3d(0, 0, 30px) rotate(0deg)';
}

function rest(_instant: boolean): void {
  stage.querySelectorAll<HTMLElement>('.hf').forEach(flyToFolder);
  stage.classList.add('organized');
  mode = 'done';
  const cap = stage.querySelector('.stage-cta span');
  if (cap) cap.textContent = 'Scatter it back';
}

function scatterAll(): void {
  stage.querySelectorAll<HTMLElement>('.hf').forEach((el, i) => scatterAt(el, i));
  stage.classList.remove('organized');
  mode = 'idle';
  const cap = stage.querySelector('.stage-cta span');
  if (cap) cap.textContent = 'Sort the mess';
}
