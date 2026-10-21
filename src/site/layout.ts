/**
 * AuraFlow Web — shared layouts & icons
 */

import { supportsFsAccess } from '../fs/access.js';

const THEMES_KEY = 'auraflow-theme';

/** Vite provides the deploy base with a trailing slash ("/" or "/repo/"). */
const BASE = import.meta.env.BASE_URL;
const pageHref = (path: string): string => `${BASE}${path}`;

export const PAGES = {
  home: { href: BASE, label: 'Home' },
  organizer: { href: pageHref('organizer.html'), label: 'Organizer' },
  converter: { href: pageHref('converter.html'), label: 'Converter' },
  imagePdf: { href: pageHref('image-to-pdf.html'), label: 'Image to PDF' },
  pdfMerger: { href: pageHref('pdf-merger.html'), label: 'Merge PDF' },
  features: { href: pageHref('features.html'), label: 'Features' },
  guide: { href: pageHref('guide.html'), label: 'Help' },
  guides: { href: pageHref('guides/'), label: 'Guides' },
  about: { href: pageHref('about.html'), label: 'About' },
  privacy: { href: pageHref('privacy.html'), label: 'Privacy' },
  contact: { href: pageHref('contact.html'), label: 'Contact' },
  terms: { href: pageHref('terms.html'), label: 'Terms' },
} as const;

function icon(name: string, cls = ''): string {
  const svg = ICONS[name] ?? '';
  return svg.replace('<svg', cls ? `<svg class="${cls}"` : '<svg');
}

export function brandMark(): string {
  return `
<svg class="brand-mark" viewBox="0 0 26 26" fill="none" aria-hidden="true">
  <rect x="1.5" y="1.5" width="10" height="9" rx="2.2" fill="currentColor" opacity=".92"/>
  <rect x="14.5" y="1.5" width="10" height="9" rx="2.2" stroke="currentColor" stroke-width="1.6"/>
  <rect x="1.5" y="13.5" width="10" height="11" rx="2.2" stroke="currentColor" stroke-width="1.6"/>
  <rect x="14.5" y="13.5" width="10" height="4.5" rx="2.2" fill="currentColor" opacity=".92"/>
  <rect x="14.5" y="20" width="10" height="4.5" rx="2.2" fill="currentColor" opacity=".45"/>
</svg>`;
}

export function renderHeader(): string {
  const here = normalizePath(location.pathname);
  const links = (['organizer', 'converter', 'imagePdf', 'pdfMerger', 'guide'] as const)
    .map((k) => {
      const p = PAGES[k];
      const aria = isActive(here, p.href) ? ' aria-current="page"' : '';
      return `<li><a href="${p.href}"${aria}>${p.label}</a></li>`;
    })
    .join('');

  const cta = here === '/organizer.html'
    ? `<a class="btn btn-primary btn-sm" href="${PAGES.home.href}#demo">See it in action</a>`
    : `<a class="btn btn-primary btn-sm" href="${PAGES.organizer.href}">Organize My Files</a>`;

  return `
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <nav class="nav" aria-label="Main">
    <a class="brand" href="${PAGES.home.href}" aria-label="AuraFlow Web — home">
      ${brandMark()}
      <span>AuraFlow</span>
      <span class="edition">Web</span>
    </a>
    <button class="menu-btn" id="menuBtn" aria-expanded="false" aria-controls="navLinks" aria-label="Menu">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg>
    </button>
    <ul class="nav-links" id="navLinks">${links}</ul>
    <div class="nav-cta">
      ${cta}
      <button class="theme-btn" id="themeBtn" aria-label="Toggle light / dark theme">
        ${icon('sun', 'theme-icon-sun')}
      </button>
    </div>
  </nav>
</header>`;
}

export function renderFooter(): string {
  const year = new Date().getFullYear();
  return `
<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="${PAGES.home.href}">${brandMark()}<span>AuraFlow</span>&nbsp;<span class="edition">Web</span></a>
        <p>Your files. Finally organized. A fast, privacy-first toolkit for organizing, converting and combining files in your browser — no uploads, no accounts, no cost.</p>
      </div>
      <div class="footer-col">
        <h4>Product</h4>
        <ul>
          <li><a href="${PAGES.organizer.href}">Organizer</a></li>
          <li><a href="${PAGES.converter.href}">File Converter</a></li>
          <li><a href="${PAGES.imagePdf.href}">Image to PDF</a></li>
          <li><a href="${PAGES.pdfMerger.href}">PDF Merger</a></li>
          <li><a href="${PAGES.features.href}">Features</a></li>
          <li><a href="${PAGES.home.href}#demo">Live demo</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Learn</h4>
        <ul>
          <li><a href="${PAGES.guide.href}">Help &amp; guide</a></li>
          <li><a href="${PAGES.guides.href}">All guides</a></li>
          <li><a href="${pageHref('guides/how-to-clean-up-downloads-folder.html')}">Clean your Downloads</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Project</h4>
        <ul>
          <li><a href="${PAGES.about.href}">About</a></li>
          <li><a target="_blank" rel="noopener noreferrer" href="https://github.com/heyitssuzain/File-Organiser">Desktop app (Windows)</a></li>
          <li><a href="${PAGES.privacy.href}">Privacy</a></li>
          <li><a href="${PAGES.terms.href}">Terms</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Contact</h4>
        <ul>
          <li><a href="${PAGES.contact.href}">Contact &amp; bug reports</a></li>
          <li><a href="mailto:thisissaddu3@gmail.com">thisissaddu3@gmail.com</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-base">
      <span>© ${year} AuraFlow Web. Open source, MIT licensed.</span>
      <span>Made with real browser capabilities — and honest ones.</span>
    </div>
  </div>
</footer>
<div class="toast-wrap" id="toasts" role="region" aria-label="Notifications"></div>`;
}

export function toast(msg: string, kind: 'ok' | 'err' | '' = ''): void {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind ? 'toast-' + kind : ''}`.trim();
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 300ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

/** Mount chrome + wire interactions. Call on every page. */
export function mountChrome(): void {
  const root = document.getElementById('site-header')!;
  root.innerHTML = renderHeader();
  document.getElementById('site-footer')!.innerHTML = renderFooter();

  // Mobile menu
  const btn = document.getElementById('menuBtn')!;
  const links = document.getElementById('navLinks')!;
  btn.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      links.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // Theme
  const themeBtn = document.getElementById('themeBtn') as HTMLButtonElement;
  const applyTheme = (t: string) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem(THEMES_KEY, t);
    themeBtn.innerHTML = t === 'dark' ? icon('sun') : icon('moon');
  };
  themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  const saved = localStorage.getItem(THEMES_KEY);
  if (saved) applyTheme(saved);

  // Reveal-on-scroll
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -4% 0px' },
  );
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

export function initToastRegion(): void {
  /* mountChrome inserts the region; nothing else needed. */
}

function normalizePath(pathname: string): string {
  const base = import.meta.env.BASE_URL; // e.g. "/File-Organizer-Web/"
  let p = pathname;
  if (base !== '/' && p.startsWith(base)) p = p.slice(base.length - 1);
  return p === '' || p === '/' ? '/index.html' : (p.endsWith('/') ? p + 'index.html' : p);
}

function isActive(here: string, href: string): boolean {
  const logical = href === BASE
    ? '/index.html'
    : (href.startsWith(BASE) ? href.slice(BASE.length - 1) : href);
  if (logical === '/index.html') return here === '/index.html';
  return here === logical || here.startsWith(logical.replace(/\.html$/, ''));
}

export const BROWSER_SUPPORTS_FS = supportsFsAccess();

export const ICONS: Record<string, string> = {
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.4-3.4 8-8 9-4.6-1-8-4.6-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L9.5 22L19 10h-6.5z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.7"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="9" y="3" width="12" height="16" rx="2"/><path d="M15 21H5a2 2 0 0 1-2-2V7"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>`,
  drag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>`,
  system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>`,
};
