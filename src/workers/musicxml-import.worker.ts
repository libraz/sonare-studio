/** One-shot SAX MusicXML parser worker. */

import { errorMessage } from '@/lib/errors';
import {
  importMusicXmlWithReport,
  MusicXmlImportError,
  type MusicXmlImportLimits,
  type MusicXmlImportResult,
} from '@/notation/musicxml-import';
import { type DefaultNameTable, registerDefaultNames } from '@/project/default-names';
import { isRecord, serveWorkerRequests } from './worker-request';

/** First message of a worker: the default-name table of the language current on the main thread. */
export interface MusicXmlImportWorkerInit {
  type: 'init';
  defaultNames: DefaultNameTable;
}

export interface MusicXmlImportWorkerRequest {
  type: 'import';
  xml: string;
  fileName?: string;
  limits?: Partial<MusicXmlImportLimits>;
}

export type MusicXmlImportWorkerResponse =
  | { type: 'imported'; result: MusicXmlImportResult }
  | { type: 'error'; error: { message: string; kind: 'musicxml-import' | 'unknown' } };

type MusicXmlImportWorkerMessage = MusicXmlImportWorkerInit | MusicXmlImportWorkerRequest;

function validRequest(value: unknown): value is MusicXmlImportWorkerMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'init') return isRecord(value.defaultNames);
  return (
    value.type === 'import' &&
    typeof value.xml === 'string' &&
    (value.fileName === undefined || typeof value.fileName === 'string') &&
    (value.limits === undefined || isRecord(value.limits))
  );
}

serveWorkerRequests<MusicXmlImportWorkerMessage, MusicXmlImportWorkerResponse>({
  validate: validRequest,
  invalidMessage: 'MusicXML import worker received an invalid request',
  errorReply: (error) => ({
    type: 'error',
    error: {
      message: errorMessage(error),
      kind: error instanceof MusicXmlImportError ? 'musicxml-import' : 'unknown',
    },
  }),
  handle: (request, post) => {
    if (request.type === 'init') {
      const table = request.defaultNames;
      registerDefaultNames(() => table);
      return;
    }
    post({
      type: 'imported',
      result: importMusicXmlWithReport(request.xml, request.fileName, request.limits),
    });
  },
});
