import { describe, expect, it } from 'vitest';
import { buildPlan, DEFAULT_OPTIONS } from '../src/core/plan.js';
import { executePlan, SourceMap } from '../src/fs/operations.js';
import type { DirHandle } from '../src/fs/access.js';

function notFound(): Error {
  return Object.assign(new Error('not found'), { name: 'NotFoundError' });
}

class FakeFileHandle {
  kind = 'file' as const;
  exists = true;
  bytes: number;
  readonly lastModified = 1_700_000_000_000;

  constructor(
    public name: string,
    bytes: number,
    private readonly parent: FakeDirHandle,
  ) {
    this.bytes = bytes;
  }

  async getFile(): Promise<File> {
    if (!this.exists) throw notFound();
    return new File(['x'.repeat(this.bytes)], this.name, { lastModified: this.lastModified });
  }

  async createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }> {
    return {
      write: async (data) => {
        this.bytes = data instanceof Blob ? data.size : String(data).length;
      },
      close: async () => {},
    };
  }

  /** Chromium 152+: remove through the file handle even without a parent handle. */
  async remove(): Promise<void> {
    if (!this.exists) throw notFound();
    this.exists = false;
    this.parent.children.delete(this.name);
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  children = new Map<string, FakeFileHandle | FakeDirHandle>();

  constructor(public name: string) {}

  addFile(name: string, bytes: number): FakeFileHandle {
    const f = new FakeFileHandle(name, bytes, this);
    this.children.set(name, f);
    return f;
  }

  addDir(name: string): FakeDirHandle {
    const d = new FakeDirHandle(name);
    this.children.set(name, d);
    return d;
  }

  async getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FileSystemFileHandle> {
    const entry = this.children.get(name);
    if (entry instanceof FakeFileHandle) return entry as unknown as FileSystemFileHandle;
    if (!entry && opts?.create) {
      return this.addFile(name, 0) as unknown as FileSystemFileHandle;
    }
    throw Object.assign(new Error(entry ? 'type mismatch' : 'not found'), {
      name: entry ? 'TypeMismatchError' : 'NotFoundError',
    });
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
    const entry = this.children.get(name);
    if (entry instanceof FakeDirHandle) return entry as unknown as DirHandle;
    if (!entry && opts?.create) return this.addDir(name) as unknown as DirHandle;
    throw notFound();
  }

  async removeEntry(name: string): Promise<void> {
    const entry = this.children.get(name);
    if (!entry) throw notFound();
    if (entry instanceof FakeFileHandle) entry.exists = false;
    this.children.delete(name);
  }

  async *values(): AsyncIterableIterator<FileSystemFileHandle | DirHandle> {
    for (const entry of this.children.values()) {
      yield entry as unknown as FileSystemFileHandle | DirHandle;
    }
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown as FakeDirHandle) === this;
  }
}

async function planFor(handle: FakeFileHandle) {
  const file = await handle.getFile();
  return { file, plan: buildPlan([file], DEFAULT_OPTIONS) };
}

describe('executePlan move semantics', () => {
  it('moves through the parent directory handle and records undo', async () => {
    const root = new FakeDirHandle('root');
    const source = root.addFile('report.pdf', 12);
    const { file, plan } = await planFor(source);
    const sources: SourceMap = new Map([
      [file, { path: 'report.pdf', handle: source as unknown as FileSystemFileHandle, parent: root as unknown as DirHandle }],
    ]);

    const result = await executePlan(plan, root as unknown as DirHandle, 'root', undefined, undefined, {
      mode: 'move',
      sources,
      sourceRoot: root as unknown as DirHandle,
    });

    expect(result.manifest.moves).toHaveLength(1);
    expect(result.manifest.moves[0]!.note).toBeUndefined();
    expect(result.undo).toEqual([{ from: 'report.pdf', to: 'Documents/report.pdf' }]);
    expect(source.exists).toBe(false);
    const docs = root.children.get('Documents') as FakeDirHandle;
    expect(docs.children.has('report.pdf')).toBe(true);
  });

  it('moves an individually picked file via FileSystemFileHandle.remove(), without undo', async () => {
    const sourceDir = new FakeDirHandle('Downloads');
    const source = sourceDir.addFile('invoice.pdf', 24);
    const dest = new FakeDirHandle('dest');
    const { file, plan } = await planFor(source);
    const sources: SourceMap = new Map([
      [file, { path: 'invoice.pdf', handle: source as unknown as FileSystemFileHandle }],
    ]);

    const result = await executePlan(plan, dest as unknown as DirHandle, 'Downloads', undefined, undefined, {
      mode: 'move',
      sources,
    });

    expect(result.manifest.moves[0]!.note).toMatch(/^moved/);
    expect(result.undo).toHaveLength(0);
    expect(source.exists).toBe(false);
    const docs = dest.children.get('Documents') as FakeDirHandle;
    expect(docs.children.has('invoice.pdf')).toBe(true);
  });

  it('copy mode always keeps the original and records no undo', async () => {
    const root = new FakeDirHandle('root');
    const source = root.addFile('photo.jpg', 8);
    const dest = new FakeDirHandle('dest');
    const { file, plan } = await planFor(source);
    const sources: SourceMap = new Map([
      [file, { path: 'photo.jpg', handle: source as unknown as FileSystemFileHandle, parent: root as unknown as DirHandle }],
    ]);

    const result = await executePlan(plan, dest as unknown as DirHandle, 'root', undefined, undefined, {
      mode: 'copy',
      sources,
      sourceRoot: root as unknown as DirHandle,
    });

    expect(result.manifest.moves[0]!.note).toMatch(/^copied/);
    expect(result.undo).toHaveLength(0);
    expect(source.exists).toBe(true);
    const images = dest.children.get('Images') as FakeDirHandle;
    expect(images.children.has('photo.jpg')).toBe(true);
  });
});
