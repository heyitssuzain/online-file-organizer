/**
 * AuraFlow Web — browser-local image engine
 *
 * Canvas does the actual work. Inputs are decoded by the browser itself; output
 * is emitted as a Blob and downloaded directly. Nothing here touches the
 * network. Object URLs are only used transiently for previews and are revoked
 * by the consuming page.
 */

import type { ImageOutput } from '../core/file-kinds.js';

export interface ImageConvertOptions {
  format: ImageOutput;
  quality: number; // 0.5 – 1, used by JPEG/WebP
  maxDimension: number; // 0 = keep original
  background: string;
}

export interface PreparedPdfImage {
  bytes: Uint8Array;
  format: 'jpeg' | 'png';
  width: number;
  height: number;
}

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((b) => new Uint8Array(b));
}

export async function loadImage(blob: Blob): Promise<LoadedImage> {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    // SVG and a few older codecs only decode through <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('This browser cannot decode that image format.'));
        el.src = url;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        release: () => URL.revokeObjectURL(url),
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('The browser could not encode this image. Try a smaller image.'));
      else resolve(blob);
    }, type, quality);
  });
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  background: string | null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Encode ImageData as a standard 24-bit bottom-up BMP. */
export function encodeBmp(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padding;
  const out = new Uint8Array(54 + stride * height);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * height, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4;
    let dest = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const i = sourceRow + x * 4;
      out[dest++] = data[i + 2] ?? 0;
      out[dest++] = data[i + 1] ?? 0;
      out[dest++] = data[i] ?? 0;
    }
  }
  return out;
}

const MIME: Record<ImageOutput, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * Convert one image locally. Same-format conversions with no resize are passed
 * through byte-for-byte, preserving the original quality and metadata.
 */
export async function convertImage(
  file: File,
  options: ImageConvertOptions,
): Promise<{ blob: Blob; width: number; height: number; passedThrough: boolean }> {
  const sourceExt = file.name.toLowerCase().split('.').pop() ?? '';
  const sameFormat =
    (options.format === 'jpeg' && (sourceExt === 'jpg' || sourceExt === 'jpeg' || file.type === 'image/jpeg')) ||
    options.format === sourceExt;
  const wantsResize = options.maxDimension > 0;

  if (sameFormat && !wantsResize) {
    const loaded = await loadImage(file);
    const width = loaded.width;
    const height = loaded.height;
    loaded.release();
    return { blob: file, width, height, passedThrough: true };
  }

  const loaded = await loadImage(file);
  try {
    if (!loaded.width || !loaded.height) throw new Error('The image has no readable dimensions.');
    let targetW = loaded.width;
    let targetH = loaded.height;
    if (wantsResize) {
      const scale = Math.min(1, options.maxDimension / Math.max(loaded.width, loaded.height));
      targetW = Math.max(1, Math.round(loaded.width * scale));
      targetH = Math.max(1, Math.round(loaded.height * scale));
    }

    const lossy = options.format === 'jpeg' || options.format === 'bmp';
    const canvas = drawScaled(loaded.source, targetW, targetH, lossy ? options.background || '#ffffff' : null);

    if (options.format === 'bmp') {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const bytes = encodeBmp(data, canvas.width, canvas.height);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return { blob: new Blob([copy.buffer], { type: MIME.bmp }), width: canvas.width, height: canvas.height, passedThrough: false };
    }

    const blob = await canvasToBlob(canvas, MIME[options.format], options.format === 'png' ? undefined : Math.max(0.5, Math.min(1, options.quality)));
    if (blob.type && blob.type !== MIME[options.format]) {
      throw new Error(`This browser cannot export ${options.format.toUpperCase()} images. Try PNG or JPG.`);
    }
    return { blob, width: canvas.width, height: canvas.height, passedThrough: false };
  } finally {
    loaded.release();
  }
}

/**
 * Prepare one image for PDF embedding.
 *
 * JPEG inputs are normalised through Canvas so EXIF orientation is applied;
 * PNG inputs are embedded losslessly when no downscale is requested. Other
 * formats become PNG (transparent) or JPEG (opaque).
 */
export async function preparePdfImage(file: File, maxDimension: number): Promise<PreparedPdfImage> {
  const loaded = await loadImage(file);
  try {
    if (!loaded.width || !loaded.height) throw new Error(`${file.name}: no readable image dimensions.`);
    const needsResize = maxDimension > 0 && Math.max(loaded.width, loaded.height) > maxDimension;
    const isJpeg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);

    let targetW = loaded.width;
    let targetH = loaded.height;
    if (needsResize) {
      const scale = maxDimension / Math.max(loaded.width, loaded.height);
      targetW = Math.max(1, Math.round(loaded.width * scale));
      targetH = Math.max(1, Math.round(loaded.height * scale));
    }

    // Always re-encode through Canvas. This applies EXIF orientation and
    // normalises unusual-but-decodable PNGs before pdf-lib sees them.
    const pngOutput = !isJpeg;
    const canvas = drawScaled(loaded.source, targetW, targetH, pngOutput ? null : '#ffffff');
    const blob = await canvasToBlob(canvas, pngOutput ? 'image/png' : 'image/jpeg', pngOutput ? undefined : 0.95);
    return {
      bytes: await blobToBytes(blob),
      format: pngOutput ? 'png' : 'jpeg',
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    loaded.release();
  }
}

export function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  return loadImage(file).then((loaded) => {
    const size = { width: loaded.width, height: loaded.height };
    loaded.release();
    return size;
  });
}
