/**
 * Local-file fallback for project persistence: downloading .szd bytes to the
 * user's disk and picking a .szd file back in. Used when OPFS storage is
 * unavailable or when the user wants an explicit export/import.
 *
 * Kept self-contained (no notation/print import) so this module stays free of
 * the PDF toolchain that the notation download helpers pull in.
 */

import {
  MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES,
  MAX_DAWPROJECT_ARCHIVE_BYTES,
  MAX_EXTERNAL_AUDIO_FILE_BYTES,
  MAX_EXTERNAL_AUDIO_TOTAL_BYTES,
  MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES,
} from './resource-limits';
import { SZD_FILE_EXTENSION } from './szd';

/** MIME type used for .szd downloads (the format is a zip archive). */
const SZD_MIME = 'application/zip';
const BACKUP_FILE_EXTENSION = '.sonare-backup.zip';
const DAWPROJECT_FILE_EXTENSION = '.dawproject';

/** A file picked by {@link pickAndReadSzd}. */
export interface PickedSzdFile {
  /** File name as reported by the browser (including extension). */
  name: string;
  /** File contents, owned by the caller. */
  bytes: Uint8Array;
}

/** A whole-browser backup picked from disk. */
export interface PickedBackupFile {
  /** File name as reported by the browser (including extension). */
  name: string;
  /** File contents, owned by the caller. */
  bytes: Uint8Array;
}

/** A DAWproject archive picked from disk. */
export interface PickedDawprojectFile {
  /** File name as reported by the browser (including extension). */
  name: string;
  /** File contents, owned by the caller. */
  bytes: Uint8Array;
}

/** One user-selected external audio file for DAWproject media relinking. */
export interface PickedExternalAudioFile {
  /** File name as reported by the browser. */
  name: string;
  /** Relative path when the browser exposes one, otherwise absent. */
  relativePath?: string;
  /** File contents, owned by the caller. */
  bytes: Uint8Array;
}

export type ExternalAudioRelinkMatch =
  | { status: 'exact-path'; file: PickedExternalAudioFile }
  | { status: 'unique-basename'; file: PickedExternalAudioFile }
  | { status: 'ambiguous-basename'; files: PickedExternalAudioFile[] }
  | { status: 'unresolved' };

function normalizeExternalMediaPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function externalMediaBasename(path: string): string {
  const normalized = normalizeExternalMediaPath(path);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * Matches a DAWproject external path without allowing selection order to
 * decide basename collisions. Directory-picker paths may carry one extra
 * selected-root prefix, so an unambiguous relative-path suffix is exact.
 */
export function matchPickedExternalAudioFile(
  referencePath: string,
  files: readonly PickedExternalAudioFile[],
): ExternalAudioRelinkMatch {
  const reference = normalizeExternalMediaPath(referencePath);
  const referenceHasDirectory = reference.includes('/');
  const exact = files.filter((file) => {
    const candidate = normalizeExternalMediaPath(file.relativePath ?? file.name);
    if (candidate === reference) return true;
    return referenceHasDirectory && candidate.endsWith(`/${reference}`);
  });
  if (exact.length === 1) return { status: 'exact-path', file: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous-basename', files: exact };

  const basename = externalMediaBasename(reference);
  const basenameMatches = files.filter(
    (file) => externalMediaBasename(file.relativePath ?? file.name) === basename,
  );
  if (basenameMatches.length === 1) {
    return { status: 'unique-basename', file: basenameMatches[0] };
  }
  if (basenameMatches.length > 1) {
    return { status: 'ambiguous-basename', files: basenameMatches };
  }
  return { status: 'unresolved' };
}

/** Minimal typing for window.showOpenFilePicker (not yet in lib.dom). */
interface OpenFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: OpenFilePickerAcceptType[];
}
type ShowOpenFilePicker = (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;

export class LocalFileSizeError extends Error {
  constructor(
    readonly fileName: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`File "${fileName}" is too large (${size} bytes; limit ${limit})`);
    this.name = 'LocalFileSizeError';
  }
}

/** Appends the extension unless the filename already ends with it. */
function withExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : `${filename}${extension}`;
}

/**
 * Triggers a browser download of .szd project bytes via a transient object
 * URL and anchor element.
 *
 * @param filename Suggested file name; ".szd" is appended when missing.
 * @param bytes Archive bytes from encodeSzd (copied into the Blob).
 */
export function downloadSzd(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: SZD_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = withExtension(filename, SZD_FILE_EXTENSION);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Triggers a browser download for a whole-browser backup archive. */
export function downloadBrowserBackup(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: SZD_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = withExtension(filename, BACKUP_FILE_EXTENSION);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Reads one size-bounded file into a single owned allocation. */
export async function readFileBytesBounded(file: File, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    throw new LocalFileSizeError(file.name, file.size, maxBytes);
  }
  if (typeof file.stream !== 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  const output = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > file.size || offset + value.byteLength > maxBytes) {
        throw new LocalFileSizeError(file.name, offset + value.byteLength, maxBytes);
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return offset === output.byteLength ? output : output.slice(0, offset);
}

/** Reads a picked File into a {@link PickedSzdFile}. */
async function readPickedFile(file: File, maxBytes: number): Promise<PickedSzdFile> {
  return { name: file.name, bytes: await readFileBytesBounded(file, maxBytes) };
}

async function readPickedExternalAudioFile(file: File): Promise<PickedExternalAudioFile> {
  const relativePath = (file as { webkitRelativePath?: string }).webkitRelativePath;
  return {
    name: file.name,
    ...(relativePath ? { relativePath } : {}),
    bytes: await readFileBytesBounded(file, MAX_EXTERNAL_AUDIO_FILE_BYTES),
  };
}

function validateExternalAudioTotal(files: readonly File[]): void {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_EXTERNAL_AUDIO_TOTAL_BYTES) {
    throw new LocalFileSizeError('selected audio files', total, MAX_EXTERNAL_AUDIO_TOTAL_BYTES);
  }
}

interface InputPickerOptions<T> {
  accept: string;
  multiple?: boolean;
  read(files: File[]): Promise<T | null>;
}

export function pickViaInputElement<T>(options: InputPickerOptions<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = options.accept;
    input.multiple = options.multiple === true;
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const finish = (result: T | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onChange = (): void => {
      if (settled) return;
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        finish(null);
        return;
      }
      settled = true;
      cleanup();
      options.read(files).then(resolve, reject);
    };
    const onCancel = (): void => finish(null);
    input.addEventListener('change', onChange, { once: true });
    // Fired by browsers when the dialog is dismissed without a selection.
    input.addEventListener('cancel', onCancel, { once: true });
    input.click();
  });
}

/** Opens a .szd file via a transient input[type=file] element. */
function pickSzdViaInputElement(): Promise<PickedSzdFile | null> {
  return pickViaInputElement({
    accept: SZD_FILE_EXTENSION,
    read: async (files) => {
      const file = files[0];
      if (!file) return null;
      return readPickedFile(file, MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES);
    },
  });
}

/**
 * Asks the user to pick a .szd project file and reads its bytes.
 *
 * Uses the File System Access API (window.showOpenFilePicker) when available
 * and falls back to a transient input[type=file] element otherwise.
 *
 * @returns The picked file, or null when the user cancelled the dialog.
 */
export async function pickAndReadSzd(): Promise<PickedSzdFile | null> {
  const picker = (globalThis as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        // Constrain the picker to .szd: hide the "all files" escape hatch so the
        // dialog only offers project archives.
        excludeAcceptAllOption: true,
        types: [
          {
            description: 'Sonare Studio project',
            accept: { [SZD_MIME]: [SZD_FILE_EXTENSION] },
          },
        ],
      });
      if (!handle) return null;
      return await readPickedFile(await handle.getFile(), MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES);
    } catch (error) {
      // The picker rejects with AbortError when the user cancels.
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return pickSzdViaInputElement();
}

/** Opens a whole-browser backup zip via a transient input[type=file] element. */
function pickBackupViaInputElement(): Promise<PickedBackupFile | null> {
  return pickViaInputElement({
    accept: `${BACKUP_FILE_EXTENSION},.zip`,
    read: async (files) => {
      const file = files[0];
      if (!file) return null;
      return readPickedFile(file, MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES);
    },
  });
}

/**
 * Asks the user to pick a whole-browser backup archive and reads its bytes.
 */
export async function pickAndReadBrowserBackup(): Promise<PickedBackupFile | null> {
  const picker = (globalThis as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Sonare Studio browser backup',
            accept: { [SZD_MIME]: [BACKUP_FILE_EXTENSION, '.zip'] },
          },
        ],
      });
      if (!handle) return null;
      return await readPickedFile(await handle.getFile(), MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return pickBackupViaInputElement();
}

/** Opens a DAWproject file via a transient input[type=file] element. */
function pickDawprojectViaInputElement(): Promise<PickedDawprojectFile | null> {
  return pickViaInputElement({
    accept: DAWPROJECT_FILE_EXTENSION,
    read: async (files) => {
      const file = files[0];
      if (!file) return null;
      return readPickedFile(file, MAX_DAWPROJECT_ARCHIVE_BYTES);
    },
  });
}

/** Asks the user to pick a .dawproject archive and reads its bytes. */
export async function pickAndReadDawproject(): Promise<PickedDawprojectFile | null> {
  const picker = (globalThis as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        excludeAcceptAllOption: true,
        types: [
          {
            description: 'DAWproject',
            accept: { [SZD_MIME]: [DAWPROJECT_FILE_EXTENSION] },
          },
        ],
      });
      if (!handle) return null;
      return await readPickedFile(await handle.getFile(), MAX_DAWPROJECT_ARCHIVE_BYTES);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return pickDawprojectViaInputElement();
}

/** Opens external audio files via a transient input[type=file] element. */
function pickExternalAudioViaInputElement(): Promise<PickedExternalAudioFile[] | null> {
  return pickViaInputElement({
    accept: 'audio/*,.wav,.wave,.aif,.aiff,.flac,.mp3,.m4a,.aac,.ogg,.opus',
    multiple: true,
    read: async (files) => {
      if (files.length === 0) return null;
      validateExternalAudioTotal(files);
      return Promise.all(files.map(readPickedExternalAudioFile));
    },
  });
}

/** Asks the user to pick external audio files referenced by a DAWproject archive. */
export async function pickAndReadExternalAudioFiles(): Promise<PickedExternalAudioFile[] | null> {
  const picker = (globalThis as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const handles = await picker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Audio files',
            accept: {
              'audio/*': [
                '.wav',
                '.wave',
                '.aif',
                '.aiff',
                '.flac',
                '.mp3',
                '.m4a',
                '.aac',
                '.ogg',
                '.opus',
              ],
            },
          },
        ],
      });
      if (handles.length === 0) return null;
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      validateExternalAudioTotal(files);
      return await Promise.all(files.map(readPickedExternalAudioFile));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return pickExternalAudioViaInputElement();
}
