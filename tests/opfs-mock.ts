/**
 * Shared in-memory stand-in for the origin-private file system, used by the
 * persistence specs (project files and audio assets). Implements just the
 * surface the production code touches: getDirectoryHandle/getFileHandle,
 * createWritable (write/close), getFile (size/lastModified/arrayBuffer),
 * removeEntry and entries().
 */

/** Creates a DOMException-shaped NotFoundError (jsdom-independent). */
export function notFoundError(): Error {
  const error = new Error('entry not found');
  error.name = 'NotFoundError';
  return error;
}

/** One stored file in the in-memory OPFS mock. */
export interface MemoryFile {
  data: Uint8Array;
  lastModified: number;
}

/** In-memory stand-in for FileSystemFileHandle. */
export class MemoryFileHandle {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    private readonly files: Map<string, MemoryFile>,
  ) {}

  async getFile(): Promise<File> {
    const entry = this.files.get(this.name);
    if (!entry) throw notFoundError();
    // A plain object is enough: the code under test reads size, lastModified
    // and arrayBuffer() only.
    return {
      name: this.name,
      size: entry.data.length,
      lastModified: entry.lastModified,
      arrayBuffer: async () => entry.data.slice().buffer,
    } as unknown as File;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    const chunks: Uint8Array[] = [];
    const commit = (): void => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      this.files.set(this.name, { data, lastModified: Date.now() });
    };
    return {
      write: async (chunk: Uint8Array) => {
        chunks.push(new Uint8Array(chunk));
      },
      close: async () => commit(),
    } as unknown as FileSystemWritableFileStream;
  }
}

/** In-memory stand-in for FileSystemDirectoryHandle. */
export class MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly files = new Map<string, MemoryFile>();
  private readonly directories = new Map<string, MemoryDirectoryHandle>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectoryHandle> {
    let dir = this.directories.get(name);
    if (!dir) {
      if (!options?.create) throw notFoundError();
      dir = new MemoryDirectoryHandle(name);
      this.directories.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw notFoundError();
      this.files.set(name, { data: new Uint8Array(0), lastModified: Date.now() });
    }
    return new MemoryFileHandle(name, this.files);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    if (options?.recursive && this.directories.delete(name)) return;
    throw notFoundError();
  }

  async *entries(): AsyncIterableIterator<[string, MemoryFileHandle | MemoryDirectoryHandle]> {
    for (const name of this.files.keys()) {
      yield [name, new MemoryFileHandle(name, this.files)];
    }
    // Real OPFS yields subdirectories alongside files; mirror that so callers
    // that filter on handle.kind (or sweep directories) behave faithfully.
    for (const [name, dir] of this.directories) {
      yield [name, dir];
    }
  }
}

/** Installs the mock as navigator.storage and returns the OPFS root. */
export function installMockOpfs(): MemoryDirectoryHandle {
  const root = new MemoryDirectoryHandle('');
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  });
  return root;
}

/** Removes the navigator.storage mock again. */
export function uninstallMockOpfs(): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
}
