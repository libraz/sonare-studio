/**
 * Notation file I/O: MusicXML download helpers and filename utilities.
 *
 * Standard MIDI File import/export lives in the canonical {@link
 * import('@/project/smf')} module (the project-level path the UI wires); this
 * module deliberately stays focused on MusicXML and filename handling.
 */

import { downloadBlob } from '@/lib/download';
import { ensureFileExtension } from '@/lib/filename';

export {
  importMusicXml,
  importMusicXmlWithReport,
  MusicXmlImportError,
} from './musicxml-import';

/** MIME type for MusicXML downloads. */
const MUSICXML_MIME = 'application/vnd.recordare.musicxml+xml';

/**
 * Appends a file extension unless the name already ends with it
 * (case-insensitive).
 *
 * @param filename File name with or without the extension.
 * @param extension Extension including the leading dot, e.g. ".musicxml".
 * @returns File name guaranteed to end with the extension.
 */
export { ensureFileExtension } from '@/lib/filename';

/**
 * Downloads a MusicXML document as a .musicxml file.
 *
 * @param xml Serialized MusicXML text.
 * @param filename Suggested file name; ".musicxml" is appended when missing.
 */
export function exportMusicXml(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: MUSICXML_MIME });
  downloadBlob(blob, ensureFileExtension(filename, '.musicxml'));
}
