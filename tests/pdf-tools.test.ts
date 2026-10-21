import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZES,
  buildImagePdf,
  createTextPdf,
  imagePageGeometry,
  mergePdfs,
  readPdfInfo,
  type PdfImageSource,
} from '../src/core/pdf-tools.js';

// A clean, tiny PNG. (The converter now re-encodes images through Canvas, so
// unusual-but-decodable PNGs never reach pdf-lib directly.)
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

function image(over: Partial<PdfImageSource> = {}): PdfImageSource {
  return {
    name: 'dot.png',
    bytes: PNG_1X1,
    format: 'png',
    width: 1,
    height: 1,
    rotation: 0,
    ...over,
  };
}

describe('image page geometry', () => {
  it('uses A4 portrait for a portrait image and preserves aspect ratio', () => {
    const g = imagePageGeometry(100, 200, 0, {
      pageSize: 'a4',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
    });
    expect(g.pageWidth).toBeCloseTo(PAGE_SIZES.a4.width, 2);
    expect(g.pageHeight).toBeCloseTo(PAGE_SIZES.a4.height, 2);
    expect(g.width / g.height).toBeCloseTo(0.5, 5);
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeGreaterThanOrEqual(0);
  });

  it('switches to landscape when the image is wider than tall', () => {
    const g = imagePageGeometry(200, 100, 0, {
      pageSize: 'a4',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
    });
    expect(g.pageWidth).toBeCloseTo(PAGE_SIZES.a4.height, 2);
    expect(g.pageHeight).toBeCloseTo(PAGE_SIZES.a4.width, 2);
  });

  it('honours a forced orientation and page size', () => {
    const g = imagePageGeometry(100, 200, 0, {
      pageSize: 'letter',
      orientation: 'landscape',
      fit: 'contain',
      marginMm: 0,
    });
    expect(g.pageWidth).toBeCloseTo(PAGE_SIZES.letter.height, 2);
    expect(g.pageHeight).toBeCloseTo(PAGE_SIZES.letter.width, 2);
  });

  it('swaps the image bounding box at 90°', () => {
    const normal = imagePageGeometry(100, 50, 0, {
      pageSize: 'image',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
    });
    const rotated = imagePageGeometry(100, 50, 90, {
      pageSize: 'image',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
    });
    expect(rotated.width).toBeCloseTo(normal.height, 5);
    expect(rotated.height).toBeCloseTo(normal.width, 5);
    expect(rotated.pageWidth).toBeCloseTo(normal.pageHeight, 5);
    expect(rotated.pageHeight).toBeCloseTo(normal.pageWidth, 5);
  });

  it('crop mode may extend beyond the page, fit mode never does', () => {
    const contain = imagePageGeometry(100, 200, 0, {
      pageSize: 'a4',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
    });
    const cover = imagePageGeometry(100, 200, 0, {
      pageSize: 'a4',
      orientation: 'auto',
      fit: 'cover',
      marginMm: 10,
    });
    expect(contain.x).toBeGreaterThanOrEqual(0);
    expect(contain.y).toBeGreaterThanOrEqual(0);
    expect(contain.x + contain.width).toBeLessThanOrEqual(contain.pageWidth + 0.01);
    expect(cover.width).toBeGreaterThan(contain.width);
    expect(cover.x < 0 || cover.y < 0).toBe(true);
  });

  it('clamps excessive margins so a page cannot vanish', () => {
    const g = imagePageGeometry(100, 100, 0, {
      pageSize: 'a4',
      orientation: 'portrait',
      fit: 'contain',
      marginMm: 10_000,
    });
    expect(g.margin).toBeLessThan(PAGE_SIZES.a4.width / 2);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });
});

describe('Image → PDF', () => {
  it('creates one real PDF page per image in order', async () => {
    const seen: number[] = [];
    const result = await buildImagePdf(
      [image({ name: 'one.png' }), image({ name: 'two.png', rotation: 90 })],
      { pageSize: 'a4', orientation: 'auto', fit: 'contain', marginMm: 10, background: '#fff' },
      (done) => seen.push(done),
    );
    expect(result.pageCount).toBe(2);
    expect(seen).toEqual([1, 2]);
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(2);
  });

  it('honours original-size pages', async () => {
    const result = await buildImagePdf([image({ width: 200, height: 100 })], {
      pageSize: 'image',
      orientation: 'auto',
      fit: 'contain',
      marginMm: 10,
      background: '#fff',
    });
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(result.bytes);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo(200 + (10 * 72) / 25.4 * 2, 1);
    expect(page.getHeight()).toBeCloseTo(100 + (10 * 72) / 25.4 * 2, 1);
  });

  it('rejects an empty selection', async () => {
    await expect(
      buildImagePdf([], { pageSize: 'a4', orientation: 'auto', fit: 'contain', marginMm: 10, background: '#fff' }),
    ).rejects.toThrow(/at least one image/i);
  });
});

describe('PDF merge', () => {
  async function sample(width: number, height: number, pages = 1): Promise<Uint8Array> {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([width, height]);
      page.drawText(`page ${i + 1}`, { x: 20, y: 20, size: 12, font, color: rgb(0, 0, 0) });
    }
    return doc.save();
  }

  it('copies pages in order and preserves each page size', async () => {
    const result = await mergePdfs([
      { name: 'a.pdf', bytes: await sample(300, 200, 2) },
      { name: 'b.pdf', bytes: await sample(210, 297, 1) },
    ]);
    expect(result.pageCount).toBe(3);
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([
      [300, 200],
      [300, 200],
      [210, 297],
    ]);
    expect(pdf.getTitle()).toBe('Merged with AuraFlow Web');
  });

  it('reports invalid PDFs clearly instead of producing a broken file', async () => {
    await expect(mergePdfs([{ name: 'broken.pdf', bytes: new Uint8Array([1, 2, 3, 4]) }])).rejects.toThrow(
      /could not be read as a PDF/i,
    );
  });

  it('reads page counts locally for the queue', async () => {
    const info = await readPdfInfo(await sample(100, 100, 4));
    expect(info.pageCount).toBe(4);
  });
});

describe('Text → PDF', () => {
  it('embeds the bundled font and keeps Unicode code points in the document', async () => {
    const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
    const bytes = await createTextPdf(
      [
        { kind: 'h1', text: 'Café — résumé' },
        { kind: 'p', text: 'A local document with an em dash — and Greek: αβγ.' },
        { kind: 'li', text: '• A bullet point' },
      ],
      { pageSize: 'a4', fontSize: 10.5, marginMm: 18, title: 'Test', fontBytes },
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getTitle()).toBe('Test');
  });

  it('paginates long text instead of dropping it', async () => {
    const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
    const paragraph = `${'A long sentence that should wrap across the page. '.repeat(120)}`;
    const bytes = await createTextPdf(
      [{ kind: 'p', text: paragraph }],
      { pageSize: 'a4', fontSize: 14, marginMm: 20, fontBytes },
    );
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it('rejects characters the bundled font cannot render', async () => {
    const fontBytes = new Uint8Array(readFileSync('public/fonts/NotoSans-Regular.ttf'));
    await expect(
      createTextPdf([{ kind: 'p', text: '日本語 😀' }], { pageSize: 'a4', fontSize: 12, marginMm: 18, fontBytes }),
    ).rejects.toThrow(/does not include/i);
  });
});
