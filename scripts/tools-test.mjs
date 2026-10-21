import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/File-Organizer-Web/';
const tmp = 'artifacts/tools-test';
await mkdir(tmp, { recursive: true });

/** Read names from the stored ZIPs this project writes (no compression). */
function zipNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    names.push(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge', headless: true }));
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 900 } });
const page = await context.newPage();
const errors = [];
const external = [];
const workers = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
page.on('worker', (worker) => workers.push(worker.url()));
page.on('request', (r) => {
  try {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return;
    external.push(r.url());
  } catch {}
});

let failures = 0;
let checks = 0;
const check = (name, pass, detail = '') => {
  checks++;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWklEQVR4nO3PQQ0AIBDAsAP/nuGNAvZoFSzZOjNnyNi9dwfgUQCeBeBZAF4F4FkAXgXgWQBeBeBZAF4F4FkAXgXgWQBeBeBZAF4F4FkAXgXgWQBeBeBZAF4F4FkAXgXgWQBeBeBZAF4FL1sBAWn4m9kAAAAASUVORK5CYII=',
  'base64'
);

// ---------- Converter: image ----------
await page.goto(`${BASE}converter.html`, { waitUntil: 'networkidle' });
check('converter page title', (await page.title()).includes('File Converter'));
await page.setInputFiles('#fileInput', { name: 'test.png', mimeType: 'image/png', buffer: png });
await page.locator('#queue .queue-row').waitFor();
await page.selectOption('#queue select[data-output]', 'webp');
await page.click('#btnConvert');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [imgDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.result-row button[data-download]').first().click(),
]);
const imgPath = await imgDownload.path();
const imgBuf = await readFile(imgPath);
check('image conversion WebP', imgBuf.length > 10 && imgBuf.subarray(0, 4).toString() === 'RIFF' && imgBuf.subarray(8, 12).toString() === 'WEBP', `${imgBuf.length} bytes`);

// ---------- Converter: every advertised image input decodes locally ----------
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const sample of [
  { file: 'sample.gif', label: 'GIF', mime: 'image/gif' },
  { file: 'sample.svg', label: 'SVG', mime: 'image/svg+xml' },
  { file: 'sample.avif', label: 'AVIF', mime: 'image/avif' },
  { file: 'sample.ico', label: 'ICO', mime: 'image/x-icon' },
]) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.setInputFiles('#fileInput', {
    name: sample.file,
    mimeType: sample.mime,
    buffer: await readFile(`tests/fixtures/${sample.file}`),
  });
  await page.locator('#queue .queue-row').waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  const sampleError = await page.locator('#queue .tag-err').first().getAttribute('title').catch(() => null);
  if (sampleError) throw new Error(`${sample.label} was rejected: ${sampleError}`);
  await page.selectOption('#queue select[data-output]', 'png');
  await page.click('#btnConvert');
  await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
  const [sampleDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.result-row button[data-download]').first().click(),
  ]);
  const sampleBuf = await readFile(await sampleDownload.path());
  check(
    `${sample.label} → PNG`,
    sampleBuf.subarray(0, 8).equals(pngSignature),
    `${sampleBuf.length} bytes`,
  );
}

// ---------- Converter: text → PDF ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('AuraFlow local conversion test.\n\nSecond paragraph with more text.', 'utf8'),
});
await page.locator('#queue .queue-row').nth(0).waitFor();
await page.waitForTimeout(200);
const rows = await page.locator('#queue .queue-row').count();
check('converter queue after reload', rows === 1, `${rows} row`);
await page.locator('#queue select[data-output]').first().selectOption('pdf');
await page.click('#btnConvert');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [pdfDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.result-row button[data-download]').first().click(),
]);
const textPdfBuf = await readFile(await pdfDownload.path());
await writeFile(`${tmp}/text.pdf`, textPdfBuf);
const textPdf = await PDFDocument.load(textPdfBuf);
check('text → PDF', textPdf.getPageCount() >= 1, `${textPdf.getPageCount()} page, ${textPdfBuf.length} bytes`);

// ---------- Converter: Unicode text → PDF ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'unicode.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Café — résumé\n\nGreek: αβγ. Cyrillic: Привет. Em dash: —.\n\nLine four.', 'utf8'),
});
await page.locator('#queue .queue-row').waitFor();
await page.waitForTimeout(200);
await page.locator('#queue select[data-output]').first().selectOption('pdf');
await page.click('#btnConvert');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [unicodeDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.result-row button[data-download]').first().click(),
]);
const unicodeBuf = await readFile(await unicodeDownload.path());
await writeFile(`${tmp}/unicode.pdf`, unicodeBuf);
const unicodePdf = await PDFDocument.load(unicodeBuf);
check('Unicode text → PDF', unicodePdf.getPageCount() >= 1, `${unicodePdf.getPageCount()} page, ${unicodeBuf.length} bytes`);

// ---------- Converter: unsupported glyphs fail clearly, not silently ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'cjk.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('This line is fine.\n日本語 and 😀 are not in the bundled font.', 'utf8'),
});
await page.locator('#queue .queue-row').waitFor();
await page.waitForTimeout(200);
await page.locator('#queue select[data-output]').first().selectOption('pdf');
await page.click('#btnConvert');
await page.locator('#queue .tag-err').waitFor({ timeout: 30000 });
const glyphError = await page.locator('#queue .tag-err').getAttribute('title');
check('unsupported CJK/emoji glyphs fail with a clear message', /does not include/i.test(glyphError ?? ''), glyphError ?? '');

// ---------- Converter: CSV → XLSX ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'people.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('name,age,city\nAda,36,London\nGrace,45,New York\n', 'utf8'),
});
await page.locator('#queue .queue-row').waitFor();
await page.selectOption('#queue select[data-output]', 'xlsx');
await page.click('#btnConvert');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [xlsxDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.result-row button[data-download]').first().click(),
]);
const xlsxBuf = await readFile(await xlsxDownload.path());
await writeFile(`${tmp}/people.xlsx`, xlsxBuf);
check('CSV → XLSX', xlsxBuf.subarray(0, 2).toString() === 'PK' && xlsxBuf.length > 500, `${xlsxBuf.length} bytes`);

// ---------- Converter: mixed batch, extra outputs and ZIP ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', [
  { name: 'photo.png', mimeType: 'image/png', buffer: png },
  { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('Title\n\nA paragraph.', 'utf8') },
  { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('Title\n\nAnother paragraph.', 'utf8') },
  { name: 'c.md', mimeType: 'text/markdown', buffer: Buffer.from('# Title\n\n- one\n- two\n', 'utf8') },
  { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('name,age\nAda,36\n', 'utf8') },
]);
await page.locator('#queue .queue-row').nth(4).waitFor();
await page.waitForTimeout(300);
const outputs = ['bmp', 'html', 'md', 'txt', 'json'];
for (let i = 0; i < outputs.length; i++) {
  await page.locator('#queue select[data-output]').nth(i).selectOption(outputs[i]);
}
await page.click('#btnConvert');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const resultNames = await page.locator('#resultsList .result-row .result-name').allTextContents();
check(
  'mixed batch converts image, text and data outputs',
  resultNames.length === 5 && ['photo.bmp', 'a.html', 'b.md', 'c.txt', 'data.json'].every((n) => resultNames.includes(n)),
  resultNames.join(' | '),
);
const [firstResultDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#resultsList button[data-download]').first().click(),
]);
const bmpBuf = await readFile(await firstResultDownload.path());
check('PNG → BMP', bmpBuf.subarray(0, 2).toString() === 'BM' && bmpBuf.length > 100, `${bmpBuf.length} bytes`);
const [zipDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnZip'),
]);
const zipBuf = await readFile(await zipDownload.path());
const zipped = zipNames(zipBuf);
check('converted batch downloads as one ZIP', zipped.length === 5, zipped.join(' | '));

// ---------- Converter: PNG and JPEG outputs ----------
for (const [format, signature] of [['png', [0x89, 0x50, 0x4e, 0x47]], ['jpeg', [0xff, 0xd8, 0xff]]]) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.setInputFiles('#fileInput', { name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.locator('#queue .queue-row').waitFor();
  await page.waitForTimeout(150);
  await page.locator('#queue select[data-output]').first().selectOption(format);
  await page.click('#btnConvert');
  await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#resultsList button[data-download]').first().click(),
  ]);
  const got = await readFile(await download.path());
  check(`PNG → ${format.toUpperCase()}`, signature.every((byte, i) => got[i] === byte), `${got.length} bytes`);
}

// ---------- Converter: unsupported file is rejected honestly ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'song.mp3',
  mimeType: 'audio/mpeg',
  buffer: Buffer.from('not audio'),
});
await page.locator('#converterNotice').waitFor({ state: 'visible' });
const unsupported = await page.locator('#converterNotice').innerText();
check('unsupported audio is rejected with a visible notice', /not supported/i.test(unsupported) && (await page.locator('#queue .queue-row').count()) === 0, unsupported.replace(/\s+/g, ' ').slice(0, 120));

// ---------- Image → PDF ----------
await page.goto(`${BASE}image-to-pdf.html`, { waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', [
  { name: 'one.png', mimeType: 'image/png', buffer: png },
  { name: 'two.png', mimeType: 'image/png', buffer: png },
]);
await page.locator('#queue .queue-row').nth(1).waitFor();
await page.waitForFunction(() => {
  const b = document.querySelector('#btnGenerate');
  return !!b && !(b).disabled && /2 pages/.test((b).textContent || '');
});
await page.selectOption('#pdfPageSize', 'a4');
await page.selectOption('#pdfOrientation', 'auto');
await page.click('#btnGenerate');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [imagePdfDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownload'),
]);
const imagePdfBuf = await readFile(await imagePdfDownload.path());
await writeFile(`${tmp}/images.pdf`, imagePdfBuf);
const imagePdf = await PDFDocument.load(imagePdfBuf);
const ip = imagePdf.getPage(0);
check('images → PDF', imagePdf.getPageCount() === 2, `${imagePdf.getPageCount()} pages, first ${Math.round(ip.getWidth())}×${Math.round(ip.getHeight())}`);

// ---------- Image → PDF: reorder, original page size, letter landscape ----------
const png1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
  'base64',
);
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', [
  { name: 'big.png', mimeType: 'image/png', buffer: png },
  { name: 'tiny.png', mimeType: 'image/png', buffer: png1 },
]);
await page.locator('#queue .queue-row').nth(1).waitFor();
await page.waitForFunction(() => /2 pages/.test(document.querySelector('#btnGenerate')?.textContent || ''));
await page.locator('#queue .queue-row').first().locator('button[data-down]').click();
await page.selectOption('#pdfPageSize', 'image');
await page.selectOption('#pdfMargin', '0');
await page.click('#btnGenerate');
await page.waitForFunction(() => document.querySelector('#progressLabel')?.textContent === 'PDF ready', undefined, { timeout: 30000 });
const [reorderedDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownload'),
]);
const reorderedPdf = await PDFDocument.load(await readFile(await reorderedDownload.path()));
const dims = reorderedPdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
check('image pages keep queue order and original sizes', JSON.stringify(dims) === JSON.stringify([[1, 1], [64, 64]]), JSON.stringify(dims));

await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', { name: 'wide.png', mimeType: 'image/png', buffer: png });
await page.locator('#queue .queue-row').waitFor();
await page.waitForFunction(() => !document.querySelector('#btnGenerate')?.disabled);
await page.selectOption('#pdfPageSize', 'letter');
await page.selectOption('#pdfOrientation', 'landscape');
await page.click('#btnGenerate');
await page.waitForFunction(() => document.querySelector('#progressLabel')?.textContent === 'PDF ready', undefined, { timeout: 30000 });
const [letterDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownload'),
]);
const letterPdf = await PDFDocument.load(await readFile(await letterDownload.path()));
const lp = letterPdf.getPage(0);
check('US Letter landscape page size', Math.round(lp.getWidth()) === 792 && Math.round(lp.getHeight()) === 612, `${Math.round(lp.getWidth())}×${Math.round(lp.getHeight())}`);

// ---------- Image → PDF: corrupt image is rejected before generation ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'broken.png',
  mimeType: 'image/png',
  buffer: Buffer.from('this is not a png'),
});
await page.locator('#queue .tag-err').waitFor({ timeout: 15000 });
const brokenImageError = await page.locator('#queue .tag-err').getAttribute('title');
check(
  'corrupt image shows an error and cannot be turned into a PDF',
  /image|could not|decode|read/i.test(brokenImageError ?? '') && (await page.locator('#btnGenerate').isDisabled()),
  brokenImageError ?? '',
);

// ---------- PDF merge ----------
const pdfA = await PDFDocument.create();
const pa = pdfA.addPage([300, 200]);
const font = await pdfA.embedFont(StandardFonts.Helvetica);
pa.drawText('First document', { x: 20, y: 160, size: 18, font, color: rgb(0, 0, 0) });
const pdfB = await PDFDocument.create();
pdfB.addPage([210, 297]);
const aBytes = Buffer.from(await pdfA.save());
const bBytes = Buffer.from(await pdfB.save());
const aPath = `${tmp}/a.pdf`;
const bPath = `${tmp}/b.pdf`;
await writeFile(aPath, aBytes);
await writeFile(bPath, bBytes);

await page.goto(`${BASE}pdf-merger.html`, { waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', [aPath, bPath]);
await page.locator('#queue .queue-row').nth(1).waitFor();
await page.waitForFunction(() => document.querySelectorAll('#queue .tag-ok').length === 2);
const pageBadges = await page.locator('#queue .tag-ok').allTextContents();
check('PDF page counts read locally', pageBadges.join(', ') === '1 page, 1 page', pageBadges.join(', '));
await page.click('#btnMerge');
await page.locator('#resultsPanel').waitFor({ state: 'visible', timeout: 30000 });
const [mergeDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownload'),
]);
const mergedBuf = await readFile(await mergeDownload.path());
await writeFile(`${tmp}/merged.pdf`, mergedBuf);
const merged = await PDFDocument.load(mergedBuf);
check('PDF merge page order/sizes', merged.getPageCount() === 2 && Math.round(merged.getPage(0).getWidth()) === 300 && Math.round(merged.getPage(1).getHeight()) === 297, `${merged.getPageCount()} pages`);

// ---------- PDF merge: reorder files ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', [aPath, bPath]);
await page.locator('#queue .queue-row').nth(1).waitFor();
await page.waitForFunction(() => document.querySelectorAll('#queue .tag-ok').length === 2);
await page.locator('#queue .queue-row').nth(1).locator('button[data-up]').click();
await page.click('#btnMerge');
await page.waitForFunction(() => document.querySelector('#progressLabel')?.textContent === 'PDF ready', undefined, { timeout: 30000 });
const [reorderMergeDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnDownload'),
]);
const reorderMerged = await PDFDocument.load(await readFile(await reorderMergeDownload.path()));
const rd = reorderMerged.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
check('reordered PDF files merge in the visible order', JSON.stringify(rd) === JSON.stringify([[210, 297], [300, 200]]), JSON.stringify(rd));

// ---------- PDF merge: invalid file is rejected locally ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'broken.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('not a real pdf'),
});
await page.locator('#queue .tag-err').waitFor({ timeout: 15000 });
const brokenError = await page.locator('#queue .tag-err').getAttribute('title');
check('invalid PDF shows a clear local error and blocks merge', /read as a PDF/i.test(brokenError ?? '') && (await page.locator('#btnMerge').isDisabled()), brokenError ?? '');

// ---------- PDF merge: encrypted PDF is rejected with a clear message ----------
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('#fileInput', {
  name: 'locked.pdf',
  mimeType: 'application/pdf',
  buffer: await readFile('tests/fixtures/encrypted.pdf'),
});
await page.locator('#queue .tag-err').waitFor({ timeout: 15000 });
const encryptedError = await page.locator('#queue .tag-err').getAttribute('title');
check(
  'encrypted PDF is rejected with a clear message and blocks merge',
  /encrypted|password/i.test(encryptedError ?? '') && (await page.locator('#btnMerge').isDisabled()),
  encryptedError ?? '',
);

// ---------- Navigation + no external requests ----------
await page.goto(`${BASE}`, { waitUntil: 'networkidle' });
const nav = await page.locator('#navLinks a').allTextContents();
check('toolkit navigation', ['Organizer', 'Converter', 'Image to PDF', 'Merge PDF', 'Help'].every((x) => nav.includes(x)), nav.join(' | '));
check('PDF work runs in a Web Worker', workers.some((url) => /pdf-worker/.test(url)), workers.join(' | ') || 'no worker started');
const storage = await page.evaluate(async () => ({
  local: Object.keys(localStorage),
  session: Object.keys(sessionStorage),
  cookies: document.cookie,
  databases: indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name ?? '') : [],
  serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
}));
const strayKeys = [...storage.local, ...storage.session].filter((key) => key !== 'auraflow-theme');
check(
  'no file data, cookies or databases persisted',
  strayKeys.length === 0 && !storage.cookies && storage.databases.length === 0 && storage.serviceWorkers === 0,
  JSON.stringify(storage),
);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
check('no external network requests', external.length === 0, external.slice(0, 3).join(' | '));

await browser.close();
console.log(`
=== TOOLS RESULT: ${checks} checks, ${failures} failed ===`);
if (failures) process.exit(1);
