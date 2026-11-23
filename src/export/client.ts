/**
 * Main-thread async client for the export worker.
 *
 * Wraps the worker message protocol in promise-returning methods with
 * request-id correlation: every render gets a unique id, progress responses
 * are routed to the caller's progress callback, and the terminal response
 * settles the promise. Cancellation immediately settles the caller while also
 * posting an out-of-band 'cancel' message the worker checks between clips and
 * stages.
 */

import type { ProjectDocument } from '@/project/serialization';
import type {
  ExportRenderOptions,
  ExportRequest,
  ExportRequestBody,
  ExportResponse,
  ExportWorkerResult,
  ExportWorkerStem,
} from '@/workers/export.worker';
import {
  MASTERING_BUFFER_LIMIT_ERROR_CODE,
  MASTERING_STEREO_FRAME_LIMIT,
  MasteringBufferLimitError,
} from './mastering-limit';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownResult,
  type MixdownStem,
} from './mixdown';

export {
  MASTERING_BUFFER_LIMIT_ERROR_CODE,
  MasteringBufferLimitError,
} from './mastering-limit';

export type { ExportRenderOptions };

/** A fatal worker failure; callers may offer retry without exposing browser internals. */
export class ExportWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportWorkerError';
  }
}

/** A render in flight: its result promise plus a cancellation hook. */
export interface ExportRenderHandle {
  /** Resolves with the mixdown; rejects with MixdownCancelledError on cancel. */
  result: Promise<MixdownResult>;
  /** Cancels immediately and requests worker cancellation (idempotent). */
  cancel(): void;
}

/** Receives one streamed stem; the worker waits for it to settle before sending the next. */
export type MixdownStemConsumer = (
  stem: MixdownStem,
  index: number,
  total: number,
) => Promise<void> | void;

/** Receives one streamed mixdown PCM block; the worker waits for it to settle. */
export type MixdownChunkConsumer = (
  channels: readonly [Float32Array, Float32Array],
  offsetFrames: number,
  totalFrames: number,
) => Promise<void> | void;

interface PendingRequest {
  resolve: (response: ExportResponse) => void;
  reject: (error: Error) => void;
  onProgress?: MixdownProgressFn;
  onStem?: MixdownStemConsumer;
  onMixdownChunk?: MixdownChunkConsumer;
  cancelRequested: boolean;
}

/** Acknowledgement the worker waits for after a streamed payload has been consumed. */
type StreamAcknowledgement =
  | { type: 'stem-consumed'; index: number }
  | { type: 'mixdown-consumed'; offsetFrames: number };

function toMixdownStem(stem: ExportWorkerStem): MixdownStem {
  return {
    source: stem.source,
    trackIndex: stem.trackIndex,
    busId: stem.busId,
    busIndex: stem.busIndex,
    name: stem.name,
    channels: [stem.left, stem.right],
    report: stem.report,
  };
}

function errorFromWorkerResponse(response: Extract<ExportResponse, { type: 'error' }>): Error {
  if (response.code === MASTERING_BUFFER_LIMIT_ERROR_CODE) {
    return new MasteringBufferLimitError({
      totalFrames: response.totalFrames ?? Number.POSITIVE_INFINITY,
      maxFrames: response.maxFrames ?? MASTERING_STEREO_FRAME_LIMIT,
      sampleRate: response.sampleRate ?? 0,
    });
  }
  return new Error(response.error);
}

/** Converts the transferred worker payload back into a MixdownResult. */
function toMixdownResult(result: ExportWorkerResult): MixdownResult {
  const out: MixdownResult = {
    channels: [result.left, result.right],
    sampleRate: result.sampleRate,
    totalFrames: result.totalFrames,
    report: result.report,
  };
  if (result.stems) {
    out.stems = result.stems.map(toMixdownStem);
  }
  return out;
}

/** Creates the default module worker hosting the export renderer. */
function createExportWorker(): Worker {
  // Relative URL (not the '@' alias) so Vite can statically resolve the worker chunk.
  return new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Async facade over the export worker.
 *
 * Usage: `const client = new ExportClient(); const { result, cancel } =
 * client.renderMixdown(doc, options, onProgress);` and `dispose()` when done.
 */
export class ExportClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;

  /** @param worker Optional worker instance (injected in tests); defaults to the bundled one. */
  constructor(worker?: Worker) {
    this.worker = worker ?? createExportWorker();
    this.worker.addEventListener('message', this.handleMessage as EventListener);
    this.worker.addEventListener('error', this.handleWorkerError as EventListener);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  /**
   * Renders a project document to a stereo mixdown in the worker. The
   * returned buffers are transferred (zero-copy).
   *
   * @param doc Plain project document (serializeProject output or equivalent).
   * @param options Structured-clone-safe render options.
   * @param onProgress Per-clip/per-stage progress callback.
   * @returns The render handle (result promise + cancel hook).
   */
  renderMixdown(
    doc: ProjectDocument,
    options: ExportRenderOptions = {},
    onProgress?: MixdownProgressFn,
    onStem?: MixdownStemConsumer,
    onMixdownChunk?: MixdownChunkConsumer,
  ): ExportRenderHandle {
    if (this.disposed) {
      return {
        result: Promise.reject(new Error('ExportClient is disposed')),
        cancel: () => {},
      };
    }
    const id = this.nextId++;
    const result = new Promise<MixdownResult>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: (response) => {
          if (response.type === 'render') {
            resolve(toMixdownResult(response.result));
          } else if (response.type === 'cancelled') {
            reject(new MixdownCancelledError());
          } else {
            reject(new Error(`Unexpected export worker response '${response.type}'`));
          }
        },
        reject,
        cancelRequested: false,
      };
      if (onProgress) entry.onProgress = onProgress;
      if (onStem) entry.onStem = onStem;
      if (onMixdownChunk) entry.onMixdownChunk = onMixdownChunk;
      this.pending.set(id, entry);
      const request: ExportRequest = {
        id,
        type: 'render',
        doc,
        options,
        ...(onStem ? { streamStems: true } : {}),
        ...(onMixdownChunk ? { streamMixdown: true } : {}),
      };
      this.worker.postMessage(request);
    });
    return {
      result,
      cancel: () => {
        if (this.disposed) return;
        const entry = this.pending.get(id);
        if (!entry || entry.cancelRequested) return;
        entry.cancelRequested = true;
        // Do not leave the dialog blocked if a worker is stuck before it can
        // echo `cancelled`; the worker message is only best-effort cleanup.
        this.pending.delete(id);
        entry.reject(new MixdownCancelledError());
        const cancelRequest: ExportRequest = { id: this.nextId++, type: 'cancel', targetId: id };
        this.worker.postMessage(cancelRequest);
      },
    };
  }

  /**
   * Terminates the worker and rejects all in-flight renders. The client is
   * unusable afterwards; further calls reject.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Best-effort native teardown; terminate() reclaims the memory regardless.
    const destroy: ExportRequestBody & { id: number } = { id: this.nextId++, type: 'destroy' };
    this.worker.postMessage(destroy);
    this.teardownWorker();
    this.rejectAll(new Error('ExportClient is disposed'));
  }

  private readonly handleMessage = (event: MessageEvent<ExportResponse>): void => {
    const response = event.data;
    if (response.type === 'fatal') {
      this.handleFatalError(new ExportWorkerError(response.error));
      return;
    }
    const entry = this.pending.get(response.id);
    if (!entry) {
      return;
    }
    if (response.type === 'progress') {
      entry.onProgress?.(response.progress, response.stage);
      return;
    }
    if (response.type === 'stem') {
      this.deliverStreamed(
        response.id,
        entry,
        entry.onStem &&
          (() => entry.onStem!(toMixdownStem(response.stem), response.index, response.total)),
        'Export worker streamed a stem without a consumer',
        () => ({ type: 'stem-consumed', index: response.index }),
      );
      return;
    }
    if (response.type === 'mixdown-chunk') {
      this.deliverStreamed(
        response.id,
        entry,
        entry.onMixdownChunk &&
          (() =>
            entry.onMixdownChunk!(
              [response.left, response.right],
              response.offsetFrames,
              response.totalFrames,
            )),
        'Export worker streamed mixdown PCM without a consumer',
        () => ({ type: 'mixdown-consumed', offsetFrames: response.offsetFrames }),
      );
      return;
    }
    this.pending.delete(response.id);
    if (response.type === 'error') {
      entry.reject(errorFromWorkerResponse(response));
    } else {
      entry.resolve(response);
    }
  };

  /**
   * Hands one streamed payload to its consumer and acknowledges it once the
   * consumer settles. A missing or failing consumer rejects the render and
   * cancels the worker.
   */
  private deliverStreamed(
    id: number,
    entry: PendingRequest,
    consume: (() => Promise<void> | void) | undefined,
    missingConsumerMessage: string,
    acknowledgement: () => StreamAcknowledgement,
  ): void {
    const fail = (error: Error): void => {
      if (this.pending.get(id) !== entry) return;
      this.pending.delete(id);
      entry.reject(error);
      const cancelRequest: ExportRequest = { id: this.nextId++, type: 'cancel', targetId: id };
      this.worker.postMessage(cancelRequest);
    };
    if (!consume) {
      fail(new Error(missingConsumerMessage));
      return;
    }
    void Promise.resolve(consume())
      .then(() => {
        if (this.disposed) return;
        const message: ExportRequest = { id: this.nextId++, targetId: id, ...acknowledgement() };
        this.worker.postMessage(message);
      })
      .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  }

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.handleFatalError(new ExportWorkerError(event.message || 'Export worker error'));
  };

  // A reply that could not be deserialized belongs to an unknown render, so none can be trusted.
  private readonly handleMessageError = (): void => {
    this.handleFatalError(new ExportWorkerError('Export worker reply could not be read'));
  };

  /** A dead worker is fatal for all in-flight renders. */
  private handleFatalError(error: ExportWorkerError): void {
    this.disposed = true;
    this.teardownWorker();
    if (sharedClient === this) sharedClient = null;
    this.rejectAll(error);
  }

  private teardownWorker(): void {
    this.worker.removeEventListener('message', this.handleMessage as EventListener);
    this.worker.removeEventListener('error', this.handleWorkerError as EventListener);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

/** Lazily created shared client used by {@link renderMixdownInWorker}. */
let sharedClient: ExportClient | null = null;

/** Returns the shared export client, creating it (and its worker) on demand. */
export function getExportClient(): ExportClient {
  if (!sharedClient) sharedClient = new ExportClient();
  return sharedClient;
}

/** Disposes the shared export client (tests, teardown); a new one is created on demand. */
export function disposeExportClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}

/**
 * Renders a mixdown on the shared export worker.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Structured-clone-safe render options.
 * @param onProgress Per-clip/per-stage progress callback.
 * @returns The render handle (result promise + cancel hook).
 */
export function renderMixdownInWorker(
  doc: ProjectDocument,
  options: ExportRenderOptions = {},
  onProgress?: MixdownProgressFn,
  onStem?: MixdownStemConsumer,
  onMixdownChunk?: MixdownChunkConsumer,
): ExportRenderHandle {
  return getExportClient().renderMixdown(doc, options, onProgress, onStem, onMixdownChunk);
}
