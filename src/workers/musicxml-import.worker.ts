/** One-shot SAX MusicXML parser worker. */

import { errorMessage } from '@/lib/errors';
import {
  importMusicXmlWithReport,
  MusicXmlImportError,
  type MusicXmlImportLimits,
  type MusicXmlImportResult,
} from '@/notation/musicxml-import';

export interface MusicXmlImportWorkerRequest {
  type: 'import';
  xml: string;
  fileName?: string;
  limits?: Partial<MusicXmlImportLimits>;
}

export type MusicXmlImportWorkerResponse =
  | { type: 'imported'; result: MusicXmlImportResult }
  | { type: 'error'; error: { message: string; kind: 'musicxml-import' | 'unknown' } };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<MusicXmlImportWorkerRequest>) => {
  if (event.data.type !== 'import') return;
  try {
    const response: MusicXmlImportWorkerResponse = {
      type: 'imported',
      result: importMusicXmlWithReport(event.data.xml, event.data.fileName, event.data.limits),
    };
    scope.postMessage(response);
  } catch (error) {
    const response: MusicXmlImportWorkerResponse = {
      type: 'error',
      error: {
        message: errorMessage(error),
        kind: error instanceof MusicXmlImportError ? 'musicxml-import' : 'unknown',
      },
    };
    scope.postMessage(response);
  }
});
