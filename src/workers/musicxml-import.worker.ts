/** One-shot SAX MusicXML parser worker. */

import { importMusicXmlWithReport, type MusicXmlImportResult } from '@/notation/musicxml-import';

export interface MusicXmlImportWorkerRequest {
  type: 'import';
  xml: string;
  fileName?: string;
}

export type MusicXmlImportWorkerResponse =
  | { type: 'imported'; result: MusicXmlImportResult }
  | { type: 'error'; error: string };

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
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  }
});
