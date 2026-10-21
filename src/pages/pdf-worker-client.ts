/**
 * AuraFlow Web — PDF worker client
 *
 * One lazily-created module worker handles image→PDF assembly, PDF merging and
 * page-count reads so large documents never freeze the page. Inputs are
 * transferred only after the worker exists; if module workers are unavailable
 * the same pure functions run on the main thread as a fallback.
 */

import type {
  ImagePdfOptions,
  PdfImageSource,
  PdfMergeFile,
  PdfMergeResult,
} from '../core/pdf-tools.js';

type Progress = (done: number, total: number, name: string) => void;

type Job =
  | { op: 'images'; images: PdfImageSource[]; options: ImagePdfOptions }
  | { op: 'merge'; files: PdfMergeFile[] }
  | { op: 'info'; bytes: Uint8Array };

type Reply =
  | { id: number; type: 'progress'; done: number; total: number; name: string }
  | { id: number; type: 'done'; kind: 'file'; bytes: ArrayBuffer; pageCount: number }
  | { id: number; type: 'done'; kind: 'info'; pageCount: number; title?: string }
  | { id: number; type: 'error'; message: string };

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function disposeWorker(error?: Error): void {
  const current = worker;
  worker = null;
  current?.terminate();
  for (const job of pending.values()) job.reject(error ?? new Error('The PDF worker stopped unexpectedly.'));
  pending.clear();
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/pdf-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return null;
  }

  worker.addEventListener('message', (event: MessageEvent<Reply>) => {
    const reply = event.data;
    const job = pending.get(reply.id);
    if (!job) return;
    if (reply.type === 'progress') {
      job.onProgress?.(reply.done, reply.total, reply.name);
      return;
    }
    pending.delete(reply.id);
    if (reply.type === 'error') job.reject(new Error(reply.message));
    else job.resolve(reply);
  });

  worker.addEventListener('error', (event) => {
    disposeWorker(new Error(event.message || 'The PDF worker could not run. Try reloading the page.'));
  });

  return worker;
}

function run(
  target: Worker,
  job: Job,
  transfer: Transferable[],
  onProgress?: Progress,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
    try {
      target.postMessage({ id, ...job }, transfer);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function buildImagePdfOffMain(
  images: PdfImageSource[],
  options: ImagePdfOptions,
  onProgress?: Progress,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const target = getWorker();
  if (!target) {
    const { buildImagePdf } = await import('../core/pdf-tools.js');
    return buildImagePdf(images, options, onProgress);
  }
  const reply = await run(
    target,
    { op: 'images', images, options },
    images.map((image) => image.bytes.buffer as ArrayBuffer),
    onProgress,
  );
  if (reply.type !== 'done' || reply.kind !== 'file') throw new Error('The PDF worker returned an incomplete result.');
  return { bytes: new Uint8Array(reply.bytes), pageCount: reply.pageCount };
}

export async function mergePdfsOffMain(
  files: PdfMergeFile[],
  onProgress?: Progress,
): Promise<PdfMergeResult> {
  const target = getWorker();
  if (!target) {
    const { mergePdfs } = await import('../core/pdf-tools.js');
    return mergePdfs(files, onProgress);
  }
  const reply = await run(
    target,
    { op: 'merge', files },
    files.map((file) => file.bytes.buffer as ArrayBuffer),
    onProgress,
  );
  if (reply.type !== 'done' || reply.kind !== 'file') throw new Error('The PDF worker returned an incomplete result.');
  return { bytes: new Uint8Array(reply.bytes), pageCount: reply.pageCount };
}

export async function readPdfInfoOffMain(bytes: Uint8Array): Promise<{ pageCount: number; title?: string }> {
  const target = getWorker();
  if (!target) {
    const { readPdfInfo } = await import('../core/pdf-tools.js');
    return readPdfInfo(bytes);
  }
  const reply = await run(target, { op: 'info', bytes }, [bytes.buffer as ArrayBuffer]);
  if (reply.type !== 'done' || reply.kind !== 'info') throw new Error('The PDF worker returned an incomplete result.');
  return { pageCount: reply.pageCount, ...(reply.title ? { title: reply.title } : {}) };
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => disposeWorker(), { once: true });
}
