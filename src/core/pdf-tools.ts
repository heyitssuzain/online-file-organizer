/**
 * AuraFlow Web — local PDF engines (pdf-lib, loaded on demand)
 *
 * - Real PDF pages for Image → PDF (no server, no upload)
 * - Page-preserving PDF merge (text and vectors remain text and vectors)
 * - Text/Markdown → PDF using a bundled, same-origin Noto Sans font
 *
 * pdf-lib is dynamically imported so the organizer and homepage never pay for
 * a PDF engine they do not use.
 */

import type { PDFFont, PDFPage } from 'pdf-lib';

export type PageSize = 'a4' | 'letter' | 'image';
export type PageOrientation = 'auto' | 'portrait' | 'landscape';
export type PageFit = 'contain' | 'cover';

export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89, label: 'A4' },
  letter: { width: 612, height: 792, label: 'US Letter' },
} as const;

export interface ImagePdfOptions {
  pageSize: PageSize;
  orientation: PageOrientation;
  fit: PageFit;
  marginMm: number;
  background: string;
}

export interface PdfImageSource {
  name: string;
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PdfMergeFile {
  name: string;
  bytes: Uint8Array;
}

export interface PdfMergeResult {
  bytes: Uint8Array;
  pageCount: number;
}

export type PdfTextKind = 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'code' | 'hr';

export interface PdfTextBlock {
  kind: PdfTextKind;
  text: string;
}

export interface TextPdfOptions {
  pageSize: 'a4' | 'letter';
  fontSize: number;
  marginMm: number;
  title?: string;
  /** Optional pre-fetched font bytes (used by tests). */
  fontBytes?: Uint8Array;
}

const MM = 72 / 25.4;

function clampMargin(mm: number, pageWidth: number, pageHeight: number): number {
  const requested = Math.max(0, Math.min(60, mm)) * MM;
  return Math.min(requested, pageWidth * 0.22, pageHeight * 0.22);
}

function datasetBytes(bytes: Uint8Array): Uint8Array {
  return bytes;
}

function pdfError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/encrypt|password/i.test(message)) {
    return new Error('This PDF is encrypted or password-protected. Unlock it in a PDF reader first, then try again.');
  }
  if (/invalid|parse|header|trailer|not a pdf|failed to parse/i.test(message)) {
    return new Error('This file could not be read as a PDF. It may be damaged or use an unsupported PDF feature.');
  }
  return new Error(`PDF processing failed locally: ${message}`);
}

/** Image page geometry. Exported for tests and for honest UI previews. */
export function imagePageGeometry(
  imageWidth: number,
  imageHeight: number,
  rotation: 0 | 90 | 180 | 270,
  options: Pick<ImagePdfOptions, 'pageSize' | 'orientation' | 'fit' | 'marginMm'>,
): { pageWidth: number; pageHeight: number; x: number; y: number; width: number; height: number; margin: number } {
  const rot = ((rotation % 360) + 360) % 360;
  const dw = rot === 90 || rot === 270 ? imageHeight : imageWidth;
  const dh = rot === 90 || rot === 270 ? imageWidth : imageHeight;

  let pageWidth: number;
  let pageHeight: number;
  let margin: number;

  if (options.pageSize === 'image') {
    // For original-size pages the margin defines the page, so clamp it to a
    // sane absolute range rather than to the (possibly tiny) image.
    margin = Math.max(0, Math.min(60, options.marginMm)) * MM;
    const long = Math.max(dw, dh) + 2 * margin;
    const short = Math.min(dw, dh) + 2 * margin;
    if (options.orientation === 'portrait') {
      pageWidth = short;
      pageHeight = long;
    } else if (options.orientation === 'landscape') {
      pageWidth = long;
      pageHeight = short;
    } else {
      pageWidth = dw + 2 * margin;
      pageHeight = dh + 2 * margin;
    }
  } else {
    const base = PAGE_SIZES[options.pageSize];
    const portrait = options.orientation === 'portrait'
      || (options.orientation === 'auto' && dh >= dw);
    pageWidth = portrait ? base.width : base.height;
    pageHeight = portrait ? base.height : base.width;
    margin = clampMargin(options.marginMm, pageWidth, pageHeight);
  }

  const cover = options.fit === 'cover';
  const availW = Math.max(1, pageWidth - margin * 2);
  const availH = Math.max(1, pageHeight - margin * 2);
  const boxW = cover ? pageWidth : availW;
  const boxH = cover ? pageHeight : availH;
  const scale = cover ? Math.max(boxW / dw, boxH / dh) : Math.min(boxW / dw, boxH / dh);
  const width = dw * scale;
  const height = dh * scale;
  const x = cover ? (pageWidth - width) / 2 : margin + (availW - width) / 2;
  const y = cover ? (pageHeight - height) / 2 : margin + (availH - height) / 2;
  return { pageWidth, pageHeight, x, y, width, height, margin };
}

async function getPdfLib() {
  return import('pdf-lib');
}

async function readBundledFont(): Promise<Uint8Array> {
  const url = new URL('fonts/NotoSans-Regular.ttf', document.baseURI);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the bundled PDF font (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

let fontCache: Promise<Uint8Array> | null = null;

function bundledFont(): Promise<Uint8Array> {
  fontCache ??= readBundledFont().catch((err) => {
    fontCache = null;
    throw err;
  });
  return fontCache;
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = text.replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (!clean) return [''];
  const widthOf = (s: string) => {
    try {
      return font.widthOfTextAtSize(s, size);
    } catch {
      return s.length * size * 0.55;
    }
  };
  const lines: string[] = [];
  for (const paragraph of clean.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/(\s+)/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && widthOf(candidate) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
      // A single word can be wider than the page; split it by characters.
      while (line.length > 1 && widthOf(line) > maxWidth) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(line.slice(0, cut)) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line.trimEnd()) lines.push(line.trimEnd());
  }
  return lines.length ? lines : [''];
}

function styleFor(kind: PdfTextKind, base: number): { size: number; gap: number; indent: number; color: [number, number, number] } {
  switch (kind) {
    case 'h1': return { size: base * 1.85, gap: 18, indent: 0, color: [0.08, 0.09, 0.12] };
    case 'h2': return { size: base * 1.45, gap: 15, indent: 0, color: [0.1, 0.11, 0.15] };
    case 'h3': return { size: base * 1.18, gap: 12, indent: 0, color: [0.12, 0.13, 0.17] };
    case 'quote': return { size: base, gap: 7, indent: base * 1.3, color: [0.34, 0.36, 0.4] };
    case 'li': return { size: base, gap: 2, indent: base * 1.1, color: [0.15, 0.16, 0.2] };
    case 'code': return { size: base * 0.88, gap: 7, indent: base * 0.8, color: [0.2, 0.22, 0.26] };
    case 'hr': return { size: base, gap: 10, indent: 0, color: [0.7, 0.72, 0.76] };
    default: return { size: base, gap: 7, indent: 0, color: [0.16, 0.17, 0.21] };
  }
}

/**
 * Text/Markdown to PDF. Noto Sans is served from the same origin and embedded
 * as a subset. If it cannot be fetched, conversion fails with a clear message
 * rather than silently replacing non-Latin characters with question marks.
 */
export async function createTextPdf(
  blocks: readonly PdfTextBlock[],
  options: TextPdfOptions,
): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await getPdfLib();
  const doc = await PDFDocument.create();
  const base = PAGE_SIZES[options.pageSize];
  const margin = clampMargin(options.marginMm, base.width, base.height);
  const baseSize = Math.max(7, Math.min(18, options.fontSize));
  const lineFactor = 1.45;

  let font: PDFFont;
  try {
    const bytes = options.fontBytes ?? await bundledFont();
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    doc.registerFontkit(fontkit);

    // Noto Sans covers Latin, Greek, Cyrillic and common punctuation — not CJK
    // or emoji. Detect missing glyphs here so the result is never a PDF full of
    // invisible .notdef boxes.
    if (blocks.some((block) => /[^\u0000-\u007f]/.test(block.text))) {
      const probe = fontkit.create(bytes);
      const missing = new Map<string, number>();
      for (const block of blocks) {
        for (const char of block.text) {
          const codePoint = char.codePointAt(0);
          if (codePoint === undefined) continue;
          if (codePoint < 0x20 && char !== '\n' && char !== '\r' && char !== '\t') continue;
          if (!probe.hasGlyphForCodePoint(codePoint)) missing.set(char, codePoint);
        }
      }
      if (missing.size) {
        const list = [...missing.entries()]
          .slice(0, 8)
          .map(([char, codePoint]) => `${JSON.stringify(char)} (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')})`)
          .join(', ');
        const extra = missing.size > 8 ? ` and ${missing.size - 8} more` : '';
        throw new Error(
          `The bundled font does not include ${list}${extra}. Remove or replace those characters, or export the text as HTML/TXT instead.`,
        );
      }
    }

    font = await doc.embedFont(datasetBytes(bytes), { subset: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/does not include/i.test(detail)) {
      throw new Error(`This text could not be turned into a PDF without losing characters. ${detail}`);
    }
    throw new Error(
      `The bundled PDF font could not be loaded, so no PDF was created. Reload the page and try again. (${detail})`,
    );
  }

  const pages: PDFPage[] = [];
  let page = doc.addPage([base.width, base.height]);
  pages.push(page);
  let y = base.height - margin;

  const newPage = () => {
    page = doc.addPage([base.width, base.height]);
    pages.push(page);
    y = base.height - margin;
  };

  for (const block of blocks) {
    const style = styleFor(block.kind, baseSize);
    if (block.kind === 'hr') {
      y -= style.gap;
      if (y < margin + style.size) newPage();
      page.drawLine({
        start: { x: margin, y },
        end: { x: base.width - margin, y },
        thickness: 0.6,
        color: rgb(...style.color),
      });
      y -= style.gap;
      continue;
    }

    const text = block.text;
    const size = style.size;
    const lineHeight = size * lineFactor;
    const usable = base.width - margin * 2 - style.indent;
    const lines = wrapLine(text, font, size, usable);
    y -= style.gap;
    for (const line of lines) {
      if (y - lineHeight < margin + 18) newPage();
      page.drawText(line, {
        x: margin + style.indent,
        y: y - size,
        size,
        font,
        color: rgb(...style.color),
      });
      y -= lineHeight;
    }
  }

  // Footer: page number + local-processing note. No file names or user metadata.
  pages.forEach((p, i) => {
    p.drawText(`AuraFlow Web · page ${i + 1} of ${pages.length}`, {
      x: margin,
      y: Math.max(12, margin / 2 - 3),
      size: 7.5,
      font,
      color: rgb(0.55, 0.57, 0.62),
    });
  });

  doc.setTitle(options.title || 'Converted document');
  doc.setAuthor('AuraFlow Web');
  doc.setCreator('AuraFlow Web (local processing)');
  doc.setProducer('AuraFlow Web (local processing)');
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());
  return doc.save();
}

/** Build an Image → PDF document. Every image becomes one page, in order. */
export async function buildImagePdf(
  images: readonly PdfImageSource[],
  options: ImagePdfOptions,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (images.length === 0) throw new Error('Add at least one image first.');
  const { PDFDocument, degrees } = await getPdfLib();
  const doc = await PDFDocument.create();

  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    const g = imagePageGeometry(image.width, image.height, image.rotation, options);
    const page = doc.addPage([g.pageWidth, g.pageHeight]);
    const embedded = image.format === 'jpeg'
      ? await doc.embedJpg(datasetBytes(image.bytes))
      : await doc.embedPng(datasetBytes(image.bytes));

    const rot = image.rotation;
    let x = g.x;
    let y = g.y;
    let width = g.width;
    let height = g.height;
    if (rot === 90) {
      x = g.x + g.width;
      y = g.y;
      width = g.height;
      height = g.width;
    } else if (rot === 180) {
      x = g.x + g.width;
      y = g.y + g.height;
    } else if (rot === 270) {
      x = g.x;
      y = g.y + g.height;
      width = g.height;
      height = g.width;
    }

    page.drawImage(embedded, {
      x,
      y,
      width,
      height,
      rotate: degrees(rot),
    });
    onProgress?.(i + 1, images.length, image.name);
  }

  doc.setTitle('Images converted with AuraFlow Web');
  doc.setAuthor('AuraFlow Web');
  doc.setCreator('AuraFlow Web (local processing)');
  doc.setProducer('AuraFlow Web (local processing)');
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());
  return { bytes: await doc.save(), pageCount: images.length };
}

/** Read page counts locally for the merge queue. */
export async function readPdfInfo(bytes: Uint8Array): Promise<{ pageCount: number; title?: string }> {
  const { PDFDocument } = await getPdfLib();
  try {
    const doc = await PDFDocument.load(datasetBytes(bytes), { updateMetadata: false });
    return { pageCount: doc.getPageCount(), title: doc.getTitle() };
  } catch (err) {
    throw pdfError(err);
  }
}

/**
 * Merge PDFs in queue order. Pages are copied rather than rasterized, so text,
 * vectors and page dimensions survive. Document outlines/forms are not
 * guaranteed by pdf-lib and are not advertised as preserved in the UI.
 */
export async function mergePdfs(
  files: readonly PdfMergeFile[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<PdfMergeResult> {
  if (files.length === 0) throw new Error('Add at least one PDF first.');
  const { PDFDocument } = await getPdfLib();
  const out = await PDFDocument.create();
  let pageCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    try {
      const src = await PDFDocument.load(datasetBytes(file.bytes), { updateMetadata: false });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const page of pages) out.addPage(page);
      pageCount += pages.length;
      onProgress?.(i + 1, files.length, file.name);
    } catch (err) {
      throw pdfError(err);
    }
  }

  if (pageCount === 0) throw new Error('The selected PDFs contain no pages.');
  out.setTitle('Merged with AuraFlow Web');
  out.setAuthor('AuraFlow Web');
  out.setCreator('AuraFlow Web (local processing)');
  out.setProducer('AuraFlow Web (local processing)');
  out.setCreationDate(new Date());
  out.setModificationDate(new Date());
  return { bytes: await out.save(), pageCount };
}


