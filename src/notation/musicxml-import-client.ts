/** Cancellable main-thread facade for the one-shot MusicXML SAX worker. */

import { runDisposableWorker } from '@/lib/disposable-worker';
import {
  MusicXmlImportError,
  type MusicXmlImportLimits,
  type MusicXmlImportResult,
} from '@/notation/musicxml-import';
import type {
  MusicXmlImportWorkerRequest,
  MusicXmlImportWorkerResponse,
} from '@/workers/musicxml-import.worker';

export type MusicXmlImportWorkerFactory = () => Worker;

function createMusicXmlImportWorker(): Worker {
  return new Worker(new URL('../workers/musicxml-import.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export function importMusicXmlInWorker(
  xml: string,
  fileName?: string,
  signal?: AbortSignal,
  workerFactory: MusicXmlImportWorkerFactory = createMusicXmlImportWorker,
  limits?: Partial<MusicXmlImportLimits>,
): Promise<MusicXmlImportResult> {
  return runDisposableWorker<MusicXmlImportWorkerResponse, MusicXmlImportResult>({
    create: workerFactory,
    signal,
    abortMessage: 'MusicXML import cancelled.',
    failMessage: 'MusicXML import worker failed',
    post(worker) {
      const request: MusicXmlImportWorkerRequest = { type: 'import', xml, fileName };
      if (limits !== undefined) request.limits = limits;
      worker.postMessage(request);
    },
    receive(response, settle) {
      if (response.type === 'imported') settle({ value: response.result });
      else
        settle({
          error:
            response.error.kind === 'musicxml-import'
              ? new MusicXmlImportError(response.error.message)
              : new Error(response.error.message),
        });
    },
  });
}
