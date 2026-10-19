/**
 * Patch 404.html (description + base-path-relative nav) and scan every page
 * for root-absolute .html links that would break under the /File-Organizer-Web/ base.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// --- 1. scan for root-absolute hrefs (potential deploy-base bugs) ---
const all = [
  ...readdirSync('.').filter((f) => f.endsWith('.html')),
  ...readdirSync('guides').map((f) => `guides/${f}`).filter((f) => f.endsWith('.html')),
];

const ROOT_ABSOLUTE = /href="\/(?!File-Organizer-Web\/)[a-zA-Z0-9#._-]+\.html[^"]*"/g;
let found = 0;
for (const p of all) {
  const m = readFileSync(p, 'utf8').match(ROOT_ABSOLUTE);
  if (m.length) {
    found++;
    console.log(`${p}: ${m.join(' ')}`);
  }
}
console.log(found ? `${found} file(s) with root-absolute links` : 'scan: no root-absolute hrefs anywhere ✓');

// --- 2. patch 404.html ---
let s = readFileSync('404.html', 'utf8');
if (!s.includes('name="description"')) {
  s = s.replace(
    '<meta name="robots" content="noindex" />',
    '<meta name="robots" content="noindex" />\n  <meta name="description" content="Page not found (404). AuraFlow Web sorts files and folders right in your browser — no uploads, no accounts, no cost." />',
  );
}
s = s.replaceAll('href="/index.html"', 'href="./index.html"')
     .replaceAll('href="/organizer.html"', 'href="./organizer.html"');
writeFileSync('404.html', s);
console.log('404.html patched: description added, links made relative');
console.log(readFileSync('404.html', 'utf8').split('\n').slice(3, 12).join('\n'));
