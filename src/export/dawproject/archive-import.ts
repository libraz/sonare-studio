/** Unzips a DAWproject archive and parses its XML entries, refusing anything unreadable. */

import { strFromU8 } from 'fflate';
import {
  preflightXmlBytes,
  preflightXmlDocument,
  preflightXmlMarkupDepth,
  XmlPreflightError,
} from '@/lib/xml-preflight';
import {
  ArchivePreflightError,
  preflightAndUnzip,
  preflightAndUnzipInWorker,
} from '@/persistence/archive-preflight';
import {
  MAX_DAWPROJECT_ARCHIVE_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import {
  parseSonareDawprojectMetadata,
  SONARE_DAWPROJECT_METADATA_ENTRY,
  type SonareDawprojectMetadata,
} from './sonare-metadata';

export class DawprojectImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DawprojectImportError';
  }
}

function parseXml(bytes: Uint8Array, entryName: string): Document {
  let doc: Document;
  try {
    preflightXmlBytes(bytes.byteLength, entryName);
    const xml = strFromU8(bytes);
    preflightXmlMarkupDepth(xml, entryName);
    doc = new DOMParser().parseFromString(xml, 'application/xml');
    preflightXmlDocument(doc, entryName);
  } catch (error) {
    if (error instanceof XmlPreflightError) {
      throw new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
    }
    throw error;
  }
  if (doc.querySelector('parsererror')) {
    throw new DawprojectImportError(`Invalid DAWproject archive: ${entryName} is not valid XML`);
  }
  return doc;
}

const ARCHIVE_LIMITS = {
  maxCompressedBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
  maxEntries: 10_000,
  maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  maxUncompressedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
};

/** Maps an unzip failure to an import error; an aborted signal rethrows its reason instead. */
function toArchiveImportError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) signal.throwIfAborted();
  if (error instanceof ArchivePreflightError) {
    return new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
  }
  return new DawprojectImportError('Invalid DAWproject archive: not a readable zip');
}

function parseArchiveEntries(entries: Record<string, Uint8Array>): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
} {
  const projectBytes = entries['project.xml'];
  if (!projectBytes) {
    throw new DawprojectImportError('Invalid DAWproject archive: missing project.xml');
  }
  const project = parseXml(projectBytes, 'project.xml');
  const metadata = entries['metadata.xml']
    ? parseXml(entries['metadata.xml'], 'metadata.xml')
    : null;
  return { entries, project, metadata };
}

export function parseArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
  sonareMetadata: SonareDawprojectMetadata;
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = preflightAndUnzip(bytes, ARCHIVE_LIMITS, signal).entries;
  } catch (error) {
    throw toArchiveImportError(error, signal);
  }
  const parsed = parseArchiveEntries(entries);
  return {
    ...parsed,
    sonareMetadata: parseSonareDawprojectMetadata(entries[SONARE_DAWPROJECT_METADATA_ENTRY]),
  };
}

export async function parseArchiveInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
}> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = (await preflightAndUnzipInWorker(bytes, ARCHIVE_LIMITS, signal)).entries;
  } catch (error) {
    throw toArchiveImportError(error, signal);
  }
  return parseArchiveEntries(entries);
}
