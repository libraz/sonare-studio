/**
 * Notation file I/O: MusicXML download helpers and filename utilities.
 *
 * Standard MIDI File import/export lives in the canonical {@link
 * import('@/project/smf')} module (the project-level path the UI wires); this
 * module deliberately stays focused on MusicXML and filename handling.
 */

import type { ProjectDocument } from '@/project/serialization';
import { importMusicXml } from './musicxml-import';
import { downloadBlob } from './print';

export { importMusicXml, MusicXmlImportError } from './musicxml-import';

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
export function ensureFileExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : `${filename}${extension}`;
}

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

/**
 * Reads a MusicXML file into a project document.
 *
 * @param file A `.musicxml` / `.xml` file chosen by the user.
 * @returns The imported project document.
 * @throws MusicXmlImportError When the file is not well-formed or supported.
 */
export async function importMusicXmlFile(file: Blob & { name?: string }): Promise<ProjectDocument> {
  return importMusicXml(await file.text(), file.name);
}
