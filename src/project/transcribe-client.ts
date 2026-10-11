import type { ProjectMidiEvent, TranscribeResult } from '@/wasm/index.js';
import type {
  TranscribeWorkerRequest,
  TranscribeWorkerResponse,
} from '@/workers/transcribe.worker';

/** Factory override used by tests and non-browser embeddings. */
export type TranscribeWorkerFactory = () => Worker;

export interface TranscribeWorkerOptions {
  /** Aborts the request and terminates its disposable worker. */
  signal?: AbortSignal;
  /** Optional worker factory used by tests or an embedding environment. */
  workerFactory?: TranscribeWorkerFactory;
  /** Original PCM rate when the worker must perform the bounded resample. */
  sourceSampleRate?: number;
  /** Tuning reference in Hz, or `'auto'` to measure it; omitted means 440 Hz. */
  referenceHz?: number | 'auto';
  /** Grid tempo the events come back on; omitted means 60 BPM (one PPQ per second). */
  tempoBpm?: number;
  /** Shortest note kept, as a `1/n` note at the grid tempo; omitted keeps the library default. */
  minNoteDivision?: number;
  /** Polyphonic only: most notes one frame may hold, `1..64`; omitted keeps the library default. */
  maxPolyphony?: number;
}

function createWorker(): Worker {
  return new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Transcription was aborted', 'AbortError');
  }
  const error = new Error('Transcription was aborted');
  error.name = 'AbortError';
  return error;
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
  return new Error(event.message || 'Transcription worker failed');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validEvent(value: unknown): value is ProjectMidiEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  const data0 = event.data0;
  const data1 = event.data1;
  return (
    isFiniteNumber(event.ppq) &&
    event.ppq >= 0 &&
    isFiniteNumber(data0) &&
    Number.isInteger(data0) &&
    data0 >= 0 &&
    data0 <= 0xffffffff &&
    (event.data1 === undefined ||
      (isFiniteNumber(data1) && Number.isInteger(data1) && data1 >= 0 && data1 <= 0xffffffff))
  );
}

function validResponse(
  value: unknown,
): value is Extract<TranscribeWorkerResponse, { type: 'done' }> {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<Extract<TranscribeWorkerResponse, { type: 'done' }>>;
  const noteCount = response.noteCount;
  return (
    response.type === 'done' &&
    Array.isArray(response.events) &&
    response.events.every(validEvent) &&
    typeof noteCount === 'number' &&
    Number.isInteger(noteCount) &&
    noteCount >= 0 &&
    noteCount * 2 === response.events.length &&
    isFiniteNumber(response.tempoBpm) &&
    response.tempoBpm > 0 &&
    isFiniteNumber(response.tuning)
  );
}

/**
 * Runs one transcription request in a disposable worker.
 *
 * The caller owns the source buffer, so the client copies it before transfer.
 * This prevents a worker request from detaching an asset/cache-owned buffer.
 */
export function transcribeAudioInWorker(
  samples: Float32Array,
  sampleRate: number,
  polyphonic: boolean,
  options: TranscribeWorkerOptions = {},
): Promise<TranscribeResult> {
  const { signal, workerFactory } = options;
  const create = workerFactory ?? createWorker;

  return new Promise<TranscribeResult>((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    let abortListener: (() => void) | undefined;

    const cleanup = (): void => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      abortListener = undefined;
      if (worker) {
        worker.removeEventListener('message', onMessage as EventListener);
        worker.removeEventListener('error', onError as EventListener);
        try {
          worker.terminate();
        } catch {
          // Termination is best effort; preserve the settled result.
        }
      }
      worker = null;
    };

    const settle = (result: { value: TranscribeResult } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    const onMessage = (event: MessageEvent<TranscribeWorkerResponse>): void => {
      const response = event.data;
      if (response?.type === 'error') {
        settle({ error: new Error(response.error) });
        return;
      }
      if (!validResponse(response)) {
        settle({ error: new Error('Transcription worker returned an invalid response') });
        return;
      }
      settle({
        value: {
          events: response.events,
          noteCount: response.noteCount,
          tempoBpm: response.tempoBpm,
          tuning: response.tuning,
        },
      });
    };

    const onError = (event: ErrorEvent): void => {
      settle({ error: errorFromWorkerEvent(event) });
    };

    const onAbort = (): void => {
      settle({ error: abortError(signal?.reason) });
    };

    try {
      if (signal?.aborted) {
        settle({ error: abortError(signal.reason) });
        return;
      }
      worker = create();
      const copied = new Float32Array(samples);
      const request: TranscribeWorkerRequest = {
        samples: copied,
        sampleRate,
        polyphonic,
        ...(options.sourceSampleRate !== undefined
          ? { sourceSampleRate: options.sourceSampleRate }
          : {}),
        ...(options.referenceHz !== undefined ? { referenceHz: options.referenceHz } : {}),
        ...(options.tempoBpm !== undefined ? { tempoBpm: options.tempoBpm } : {}),
        ...(options.minNoteDivision !== undefined
          ? { minNoteDivision: options.minNoteDivision }
          : {}),
        ...(options.maxPolyphony !== undefined ? { maxPolyphony: options.maxPolyphony } : {}),
      };
      worker.addEventListener('message', onMessage as EventListener);
      worker.addEventListener('error', onError as EventListener);
      abortListener = onAbort;
      signal?.addEventListener('abort', abortListener, { once: true });
      worker.postMessage(request, [copied.buffer]);
    } catch (error) {
      settle({ error });
    }
  });
}
