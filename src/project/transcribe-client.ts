import type { ProjectMidiEvent, TranscribeResult } from '@libraz/libsonare';
import { runDisposableWorker } from '@/lib/disposable-worker';
import { isFiniteNumber } from '@/lib/math';
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

function validEvent(value: unknown): value is ProjectMidiEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  const word0 = event.word0;
  const word1 = event.word1;
  return (
    isFiniteNumber(event.ppq) &&
    event.ppq >= 0 &&
    isFiniteNumber(word0) &&
    Number.isInteger(word0) &&
    word0 >= 0 &&
    word0 <= 0xffffffff &&
    (event.word1 === undefined ||
      (isFiniteNumber(word1) && Number.isInteger(word1) && word1 >= 0 && word1 <= 0xffffffff))
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
    isFiniteNumber(response.tuningCents)
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

  return runDisposableWorker<TranscribeWorkerResponse, TranscribeResult>({
    create,
    signal,
    abortMessage: 'Transcription was aborted',
    failMessage: 'Transcription worker failed',
    post(worker) {
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
      worker.postMessage(request, [copied.buffer]);
    },
    receive(response, settle) {
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
          tuningCents: response.tuningCents,
        },
      });
    },
  });
}
