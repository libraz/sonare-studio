/** Cancellable main-thread facade for the one-shot MusicXML SAX worker. */

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
  signal?.throwIfAborted();
  const worker = workerFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError as EventListener);
      worker.terminate();
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => {
      settle(() =>
        reject(signal?.reason ?? new DOMException('MusicXML import cancelled.', 'AbortError')),
      );
    };
    const onMessage = (event: MessageEvent<MusicXmlImportWorkerResponse>): void => {
      const response = event.data;
      if (response.type === 'imported') settle(() => resolve(response.result));
      else
        settle(() =>
          reject(
            response.error.kind === 'musicxml-import'
              ? new MusicXmlImportError(response.error.message)
              : new Error(response.error.message),
          ),
        );
    };
    const onError = (event: ErrorEvent): void => {
      settle(() => reject(new Error(event.message || 'MusicXML import worker failed')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError as EventListener);
    const request: MusicXmlImportWorkerRequest = { type: 'import', xml, fileName };
    if (limits !== undefined) request.limits = limits;
    worker.postMessage(request);
    if (signal?.aborted) onAbort();
  });
}
