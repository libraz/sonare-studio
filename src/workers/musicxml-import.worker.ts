/** One-shot SAX MusicXML parser worker. */

import { errorMessage } from '@/lib/errors';
import {
  importMusicXmlWithReport,
  MusicXmlImportError,
  type MusicXmlImportLimits,
  type MusicXmlImportResult,
} from '@/notation/musicxml-import';
import { isRecord, serveWorkerRequests } from './worker-request';

export interface MusicXmlImportWorkerRequest {
  type: 'import';
  xml: string;
  fileName?: string;
  limits?: Partial<MusicXmlImportLimits>;
}

export type MusicXmlImportWorkerResponse =
  | { type: 'imported'; result: MusicXmlImportResult }
  | { type: 'error'; error: { message: string; kind: 'musicxml-import' | 'unknown' } };

function validRequest(value: unknown): value is MusicXmlImportWorkerRequest {
  return (
    isRecord(value) &&
    value.type === 'import' &&
    typeof value.xml === 'string' &&
    (value.fileName === undefined || typeof value.fileName === 'string') &&
    (value.limits === undefined || isRecord(value.limits))
  );
}

serveWorkerRequests<MusicXmlImportWorkerRequest, MusicXmlImportWorkerResponse>({
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
    post({
      type: 'imported',
      result: importMusicXmlWithReport(request.xml, request.fileName, request.limits),
    });
  },
});
