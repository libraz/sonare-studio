/** Bounded extraction of compressed MusicXML (.mxl) archives. */

import { errorMessage } from '@/lib/errors';
import {
  DEFAULT_XML_LIMITS,
  preflightXmlBytes,
  preflightXmlMarkupDepth,
  XmlPreflightError,
} from '@/lib/xml-preflight';
import { preflightAndUnzip } from '@/persistence/archive-preflight';
import { DEFAULT_MUSICXML_IMPORT_LIMITS, MusicXmlImportError } from './musicxml-import';

const MXL_CONTAINER_PATH = 'META-INF/container.xml';
const MXL_LIMITS = {
  maxCompressedBytes: DEFAULT_XML_LIMITS.maxBytes,
  maxUncompressedBytes: DEFAULT_XML_LIMITS.maxBytes,
  maxEntries: 64,
  maxEntryBytes: DEFAULT_XML_LIMITS.maxBytes,
  // Match the archive-wide safety limit. MusicXML often compresses unusually
  // well because long runs of rests/layout markup repeat verbatim.
  maxCompressionRatio: 2000,
  maxPathLength: 512,
} as const;

/** Applies the same size, element and depth limits as an uncompressed MusicXML import. */
function xmlText(bytes: Uint8Array, label: string): string {
  const limits = {
    maxBytes: DEFAULT_MUSICXML_IMPORT_LIMITS.maxBytes,
    maxElements: DEFAULT_MUSICXML_IMPORT_LIMITS.maxElements,
    maxDepth: DEFAULT_MUSICXML_IMPORT_LIMITS.maxDepth,
  };
  try {
    preflightXmlBytes(bytes.byteLength, label, limits);
    const text = new TextDecoder().decode(bytes);
    preflightXmlMarkupDepth(text, label, limits);
    return text;
  } catch (error) {
    if (error instanceof XmlPreflightError) throw new MusicXmlImportError(error.message);
    throw error;
  }
}

/**
 * Extracts the score XML selected by an MXL archive's standard container file.
 * The archive is fully preflighted before expansion, including paths and
 * compression ratios, so a compressed score cannot bypass MusicXML's normal
 * XML size/depth limits.
 */
export function extractMusicXmlFromMxl(bytes: Uint8Array, fileName = 'MusicXML archive'): string {
  let entries: Record<string, Uint8Array>;
  try {
    entries = preflightAndUnzip(bytes, MXL_LIMITS).entries;
  } catch (error) {
    const message = errorMessage(error);
    throw new MusicXmlImportError(`Invalid compressed MusicXML archive: ${message}`);
  }
  const containerBytes = entries[MXL_CONTAINER_PATH];
  if (!containerBytes) {
    throw new MusicXmlImportError(`Compressed MusicXML archive has no ${MXL_CONTAINER_PATH}`);
  }
  const container = new DOMParser().parseFromString(
    xmlText(containerBytes, `${fileName} container`),
    'application/xml',
  );
  if (container.querySelector('parsererror')) {
    throw new MusicXmlImportError('Compressed MusicXML container is not well-formed XML');
  }
  const path = container.querySelector('rootfile')?.getAttribute('full-path')?.trim();
  if (!path || !entries[path]) {
    throw new MusicXmlImportError('Compressed MusicXML container does not name an embedded score');
  }
  return xmlText(entries[path], fileName);
}
