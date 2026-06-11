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

/** A file picked by {@link pickAndReadSzd}. */
export interface PickedSzdFile {
  /** File name as reported by the browser (including extension). */
  name: string;
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

/** Reads a picked File into a {@link PickedSzdFile}. */
async function readPickedFile(file: File): Promise<PickedSzdFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Opens a .szd file via a transient input[type=file] element. */
function pickViaInputElement(): Promise<PickedSzdFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SZD_FILE_EXTENSION;
    input.style.display = 'none';
    document.body.append(input);
    const finish = (result: PickedSzdFile | null): void => {
      input.remove();
      resolve(result);
    };
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        if (!file) {
          finish(null);
          return;
        }
        readPickedFile(file).then(finish, (error: unknown) => {
          input.remove();
          reject(error);
        });
      },
      { once: true },
    );
    // Fired by browsers when the dialog is dismissed without a selection.
    input.addEventListener('cancel', () => finish(null), { once: true });
    input.click();
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
  return pickViaInputElement();
}
