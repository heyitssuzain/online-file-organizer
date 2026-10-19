/** Reapply safe relative favicon hrefs after byte-exact encoding recovery. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const fix = (dir, prefix) => {
  for (const f of readdirSync(dir || '.').filter((n) => n.endsWith('.html'))) {
    const p = dir ? `${dir}/${f}` : f;
    let s = readFileSync(p, 'utf8');
    s = s.replaceAll('href="__BASE_URL__/favicon.svg"', `href="${prefix}/favicon.svg"`);
    writeFileSync(p, s);
  }
};

fix('', './favicon.svg');
fix('guides', '../favicon.svg');

for (const p of ['index.html', 'organizer.html', 'guides/index.html']) {
  const m = readFileSync(p, 'utf8').match(/<link rel="icon"[^\n]+/);
  console.log(`${p} → ${m[0]}`);
}
