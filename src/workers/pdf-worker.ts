/**
 * AuraFlow Web — PDF worker
 *
 * pdf-lib is heavy and can spend seconds parsing or copying large documents.
 * This worker keeps that work off the main thread while the page stays
 * responsive. Jobs arrive as plain bytes, results leave as plain bytes; no file
 * data is stored or sent anywhere.
 */

import {
  buildImagePdf,
  mergePdfs,
  readPdfInfo,
  type ImagePdfOptions,
  type PdfImageSource,
  type PdfMergeFile,
} from '../core/pdf-tools.js';

type Job =
  | { id: number; op: 'images'; images: PdfImageSource[]; options: ImagePdfOptions }
  | { id: number; op: 'merge'; files: PdfMergeFile[] }
  | { id: number; op: 'info'; bytes: Uint8Array };

type Reply =
  | { id: number; type: 'progress'; done: number; total: number; name: string }
  | { id: number; type: 'done'; kind: 'file'; bytes: ArrayBuffer; pageCount: number }
  | { id: number; type: 'done'; kind: 'info'; pageCount: number; title?: string }
  | { id: number; type: 'error'; message: string };

const send = (message: Reply, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer;
}

self.onmessage = async (ev: MessageEvent<Job>) => {
  const job = ev.data;
  try {
    if (job.op === 'images') {
      const result = await buildImagePdf(job.images, job.options, (done, total, name) => {
        send({ id: job.id, type: 'progress', done, total, name });
      });
      const buffer = exactBuffer(result.bytes);
      send({ id: job.id, type: 'done', kind: 'file', bytes: buffer, pageCount: result.pageCount }, [buffer]);
      return;
    }

    if (job.op === 'merge') {
      const result = await mergePdfs(job.files, (done, total, name) => {
        send({ id: job.id, type: 'progress', done, total, name });
      });
      const buffer = exactBuffer(result.bytes);
      send({ id: job.id, type: 'done', kind: 'file', bytes: buffer, pageCount: result.pageCount }, [buffer]);
      return;
    }

    const info = await readPdfInfo(job.bytes);
    send({ id: job.id, type: 'done', kind: 'info', pageCount: info.pageCount, ...(info.title ? { title: info.title } : {}) });
  } catch (err) {
    send({ id: job.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
