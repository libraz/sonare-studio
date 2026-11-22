/**
 * Notation file I/O: MusicXML download helpers and filename utilities.
 *
 * Standard MIDI File import and export live in {@link import('@/project/smf-import')}
 * and {@link import('@/project/smf')} (the project-level paths the UI wires); this
 * module deliberately stays focused on MusicXML and filename handling.
 */

import { downloadBlob } from '@/lib/download';
import { ensureFileExtension } from '@/lib/filename';
import { MXL_MIME, packMusicXmlToMxl } from './musicxml-mxl';

export {
  importMusicXml,
  importMusicXmlWithReport,
  MusicXmlImportError,
} from './musicxml-import';

/** MIME type for MusicXML downloads. */
const MUSICXML_MIME = 'application/vnd.recordare.musicxml+xml';

/** Builds the .musicxml download Blob. */
export function musicXmlBlob(xml: string): Blob {
  return new Blob([xml], { type: MUSICXML_MIME });
}

/** Builds the compressed .mxl download Blob. */
export function mxlBlob(xml: string): Blob {
  return new Blob([new Uint8Array(packMusicXmlToMxl(xml))], { type: MXL_MIME });
}

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
  downloadBlob(musicXmlBlob(xml), ensureFileExtension(filename, '.musicxml'));
}
