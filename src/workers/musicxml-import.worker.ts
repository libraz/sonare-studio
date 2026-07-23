/** One-shot SAX MusicXML parser worker. */

import {
  importMusicXmlWithReport,
  MusicXmlImportError,
  type MusicXmlImportResult,
} from '@/notation/musicxml-import';

export interface MusicXmlImportWorkerRequest {
  type: 'import';
  xml: string;
  fileName?: string;
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
      result: importMusicXmlWithReport(event.data.xml, event.data.fileName),
    };
    scope.postMessage(response);
  } catch (error) {
    const response: MusicXmlImportWorkerResponse = {
      type: 'error',
      error: {
        message: error instanceof Error ? error.message : String(error),
        kind: error instanceof MusicXmlImportError ? 'musicxml-import' : 'unknown',
      },
    };
    scope.postMessage(response);
  }
});
