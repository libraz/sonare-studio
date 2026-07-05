/**
 * Local-file fallback for project persistence: downloading .szd bytes to the
 * user's disk and picking a .szd file back in. Used when OPFS storage is
 * unavailable or when the user wants an explicit export/import.
 *
 * Kept self-contained (no notation/print import) so this module stays free of
 * the PDF toolchain that the notation download helpers pull in.
 */

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

/** Reads a picked File into a {@link PickedSzdFile}. */
async function readPickedFile(file: File): Promise<PickedSzdFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function readPickedExternalAudioFile(file: File): Promise<PickedExternalAudioFile> {
  const relativePath = (file as { webkitRelativePath?: string }).webkitRelativePath;
  return {
    name: file.name,
    ...(relativePath ? { relativePath } : {}),
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
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
      return readPickedFile(file);
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
      return await readPickedFile(await handle.getFile());
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
      return readPickedFile(file);
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
      return await readPickedFile(await handle.getFile());
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
      return readPickedFile(file);
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
      return await readPickedFile(await handle.getFile());
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
      return await Promise.all(
        handles.map(async (handle) => readPickedExternalAudioFile(await handle.getFile())),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return pickExternalAudioViaInputElement();
}
