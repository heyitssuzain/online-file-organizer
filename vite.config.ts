import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

/**
 * Multi-page app config.
 *
 * BASE: for GitHub Pages project sites the site lives under
 * /File-Organizer-Web/. Set BASE=/ for a custom domain (env override in .env).
 */

function readEnv(key: string): string | null {
  try {
    const env = readFileSync('.env', 'utf8');
    const m = env.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm'));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const BASE = process.env.BASE || readEnv('BASE') || '/File-Organizer-Web/';
const CANONICAL =
  process.env.CANONICAL_BASE_URL ||
  readEnv('CANONICAL_BASE_URL') ||
  'https://heyitssuzain.github.io/File-Organizer-Web/';
const CANONICAL_BASE = CANONICAL.endsWith('/') ? CANONICAL : `${CANONICAL}/`;

/** Replaces __BASE_URL__ at serve/build time without mutating source files. */
function seoBaseUrl() {
  return {
    name: 'auraflow-seo-base-url',
    transform(code: string, id: string) {
      if (!id.endsWith('.html') || !code.includes('__BASE_URL__')) return null;
      return { code: code.replaceAll('__BASE_URL__', CANONICAL_BASE.slice(0, -1)), map: null };
    },
  };
}

/** Generates robots.txt + sitemap.xml with the canonical base at build time. */
function seoFiles() {
  return {
    name: 'auraflow-seo-files',
    apply: 'build' as const,
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const pages: Array<[string, string, string, string]> = [
        // path, changefreq, priority, last meaningful content update
        ['', 'weekly', '1.0', '2026-10-20'],
        ['organizer.html', 'weekly', '0.9', '2026-10-20'],
        ['features.html', 'monthly', '0.7', '2026-10-20'],
        ['guide.html', 'monthly', '0.7', '2026-10-20'],
        ['guides/', 'weekly', '0.8', '2026-10-20'],
        ['guides/how-to-organize-files-by-type.html', 'monthly', '0.6', '2026-10-20'],
        ['guides/how-to-clean-up-downloads-folder.html', 'monthly', '0.6', '2026-10-20'],
        ['guides/how-to-organize-photos-and-documents.html', 'monthly', '0.6', '2026-10-20'],
        ['guides/how-to-identify-duplicate-files.html', 'monthly', '0.6', '2026-10-20'],
        ['guides/browser-file-organization-limits.html', 'monthly', '0.6', '2026-10-20'],
        ['about.html', 'monthly', '0.5', '2026-10-20'],
        ['privacy.html', 'monthly', '0.5', '2026-10-20'],
        ['contact.html', 'monthly', '0.4', '2026-10-20'],
        ['terms.html', 'monthly', '0.4', '2026-10-20'],
      ];
      const base = CANONICAL_BASE;
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    ([p, freq, pri, lastmod]: [string, string, string, string]) =>
      `  <url><loc>${base}${p}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority><lastmod>${lastmod}</lastmod></url>`,
  )
  .join('\n')}
</urlset>
`;
      writeFileSync(resolve(outDir, 'sitemap.xml'), sitemap);
      writeFileSync(
        resolve(outDir, 'robots.txt'),
        `User-agent: *\nAllow: /\n\nSitemap: ${base}sitemap.xml\n`,
      );
      console.log(`seo-files: sitemap.xml + robots.txt written (base=${base})`);
    },
  };
}

const pages = [
  'index.html',
  'organizer.html',
  'features.html',
  'privacy.html',
  'contact.html',
  'terms.html',
  'guide.html',
  'about.html',
  'guides/index.html',
  'guides/how-to-organize-files-by-type.html',
  'guides/how-to-clean-up-downloads-folder.html',
  'guides/how-to-organize-photos-and-documents.html',
  'guides/how-to-identify-duplicate-files.html',
  'guides/browser-file-organization-limits.html',
  '404.html',
];

export default defineConfig({
  base: BASE,
  plugins: [seoBaseUrl(), seoFiles()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: pages.map((p) => resolve(__dirname, p)),
    },
    target: 'es2022',
    cssCodeSplit: true,
    assetsInlineLimit: 2048,
  },
});
