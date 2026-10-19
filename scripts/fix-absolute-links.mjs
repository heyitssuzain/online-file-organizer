/** Convert root-absolute .html hrefs to Base-URL-relative ones (depth-aware). */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const convert = (dir, relativeTo) => {
  for (const f of readdirSync(dir || '.').filter((n) => n.endsWith('.html'))) {
    const p = dir ? `${dir}/${f}` : f;
    let s = readFileSync(p, 'utf8');
    s = s.replace(/href="\/(?!File-Organizer-Web\/)([a-zA-Z0-9#._-]+\.html[^"]*)"/g, `href="${relativeTo}$1"`);
    writeFileSync(p, s);
  }
};

convert('', './');
convert('guides', '../');

// verify: rescan
const all = [
  ...readdirSync('.').filter((f) => f.endsWith('.html')),
  ...readdirSync('guides').map((f) => `guides/${f}`).filter((f) => f.endsWith('.html')),
];
const ROOT_ABSOLUTE = /href="\/(?!File-Organizer-Web\/)[a-zA-Z0-9#._-]+\.html[^"]*"/g;
let bad = 0;
for (const p of all) {
  const m = readFileSync(p, 'utf8').match(ROOT_ABSOLUTE) ?? [];
  if (m.length) {
    bad++;
    console.log(`STILL ABSOLUTE: ${p}: ${m.join(' ')}`);
  }
}
console.log(bad === 0 ? 'all .html hrefs now base-relative ✓' : `${bad} file(s) still broken`);
