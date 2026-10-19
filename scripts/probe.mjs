/** Focused probe for the 6 remaining smoke failures. Uses system Edge. */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173/File-Organizer-Web/';
const browser = await chromium.launch({ channel: 'msedge', headless: true });

// --- probe 1: organizer plan preview content ---
{
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}organizer.html`, { waitUntil: 'networkidle' });
  await page.locator('#fileInput').setInputFiles([
    { name: 'thesis.pdf', mimeType: 'application/pdf', buffer: Buffer.from('a'.repeat(2048)) },
    { name: 'photo.JPG', mimeType: 'image/jpeg', buffer: Buffer.from('b'.repeat(3000)) },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('c'.repeat(5000)) },
    { name: 'install.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('d') },
    { name: 'notes.bak', mimeType: 'application/octet-stream', buffer: Buffer.from('e') },
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('f') },
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('g'.repeat(64)) },
  ]);
  await page.waitForTimeout(500);
  const hidden = await page.evaluate(() => ({
    ws: document.getElementById('workspace').hidden,
    display: getComputedStyle(document.getElementById('planOut')).display,
    visibility: getComputedStyle(document.getElementById('planOut')).visibility,
  }));
  console.log('workspace/planOut style:', JSON.stringify(hidden));
  console.log('pageerrors:', JSON.stringify(errs));
  console.log('--- planOut textContent (first 700) ---');
  console.log((await page.evaluate(() => document.getElementById('planOut').textContent)).slice(0, 700));
  console.log('--- planOut innerText (first 700) ---');
  console.log((await page.evaluate(() => document.getElementById('planOut').innerText)).slice(0, 700));
  console.log('--- statsRow ---');
  console.log(await page.evaluate(() => document.getElementById('statsRow').innerText));
  console.log('--- countBadge/appHeadStatus ---');
  console.log(await page.evaluate(() => [document.getElementById('countBadge').textContent, document.getElementById('appHeadStatus').textContent]));
  await page.close();
}

// --- probe 2: which elements overflow at 320px ---
{
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  for (const p of ['', 'organizer.html', 'features.html', 'guides/']) {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' });
    const wide = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 || r.right > vw + 6) {
          const cs = getComputedStyle(el);
          out.push(`${el.tagName}.${[...el.classList].join('.')} w=${Math.round(r.width)} right=${Math.round(r.right)} pos=${cs.position} overflow=${cs.overflow}`);
          if (out.length >= 6) break;
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, vw, out };
    });
    console.log(`\n=== ${p || 'index'} scrollWidth=${wide.scrollWidth} vw=${wide.vw}`);
    console.log(wide.out.join('\n') || '(no wide elements)');
  }
  await page.close();
}

await browser.close();
