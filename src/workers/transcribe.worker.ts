import { ensureWasm } from '@/lib/wasm';
import type { ProjectMidiEvent, TranscribeResult } from '@/wasm/index.js';

/** Keep the worker boundary safe even when called outside the project adapter. */
const MAX_POLYPHONIC_SAMPLES = 5_760_000;

/** One disposable worker request. */
export interface TranscribeWorkerRequest {
  samples: Float32Array;
  /** Detector output sample rate (at most 48 kHz in the app adapter). */
  sampleRate: number;
  /** Original PCM rate; omitted when it already equals `sampleRate`. */
  sourceSampleRate?: number;
  polyphonic: boolean;
  /** Tuning reference in Hz, or `'auto'` to measure it; omitted means 440 Hz. */
  referenceHz?: number | 'auto';
  /** Grid tempo the events come back on; omitted means 60 BPM (one PPQ per second). */
  tempoBpm?: number;
  /** Shortest note kept, as a `1/n` note at `tempoBpm`; omitted keeps the library default. */
  minNoteDivision?: number;
}

/** Result sent back by the transcription worker. */
export type TranscribeWorkerResponse =
  | {
      type: 'done';
      events: ProjectMidiEvent[];
      noteCount: number;
      tempoBpm: number;
      /** Tuning used, in fractions of a semitone (given or measured). */
      tuning: number;
    }
  | { type: 'error'; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMidiEvent(value: unknown): value is ProjectMidiEvent {
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

function validRequest(value: unknown): value is TranscribeWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<TranscribeWorkerRequest>;
  return (
    request.samples instanceof Float32Array &&
    request.samples.length > 0 &&
    isFiniteNumber(request.sampleRate) &&
    request.sampleRate > 0 &&
    (request.sourceSampleRate === undefined ||
      (isFiniteNumber(request.sourceSampleRate) && request.sourceSampleRate > 0)) &&
    typeof request.polyphonic === 'boolean' &&
    (request.referenceHz === undefined ||
      request.referenceHz === 'auto' ||
      (isFiniteNumber(request.referenceHz) && request.referenceHz > 0)) &&
    (request.tempoBpm === undefined ||
      (isFiniteNumber(request.tempoBpm) && request.tempoBpm > 0)) &&
    (request.minNoteDivision === undefined ||
      (Number.isInteger(request.minNoteDivision) &&
        request.minNoteDivision >= 1 &&
        request.minNoteDivision <= 128))
  );
}

function validResult(value: unknown): value is TranscribeResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<TranscribeResult>;
  const noteCount = result.noteCount;
  return (
    Array.isArray(result.events) &&
    result.events.every(isMidiEvent) &&
    typeof noteCount === 'number' &&
    Number.isInteger(noteCount) &&
    noteCount >= 0 &&
    noteCount * 2 === result.events.length &&
    isFiniteNumber(result.tempoBpm) &&
    result.tempoBpm > 0 &&
    isFiniteNumber(result.tuning)
  );
}

function postError(error: unknown): void {
  postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  } satisfies TranscribeWorkerResponse);
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!validRequest(event.data)) {
    postError(new Error('Transcription worker received an invalid request'));
    return;
  }
  const request = event.data;
  ensureWasm()
    .then((wasm) => {
      const sourceSampleRate = request.sourceSampleRate ?? request.sampleRate;
      const samples =
        sourceSampleRate === request.sampleRate
          ? request.samples
          : wasm.resample(request.samples, sourceSampleRate, request.sampleRate);
      if (!(samples instanceof Float32Array) || samples.length === 0) {
        throw new Error('Transcription worker resampling returned no samples');
      }
      if (request.polyphonic && samples.length > MAX_POLYPHONIC_SAMPLES) {
        throw new RangeError(
          `Polyphonic transcription is limited to ${MAX_POLYPHONIC_SAMPLES} detector samples`,
        );
      }
      const result = wasm.transcribe({
        samples,
        sampleRate: request.sampleRate,
        tempoBpm: request.tempoBpm ?? 60,
        polyphonic: request.polyphonic,
        ...(request.referenceHz !== undefined ? { referenceHz: request.referenceHz } : {}),
        ...(request.minNoteDivision !== undefined
          ? { minNoteDivision: request.minNoteDivision }
          : {}),
      });
      if (!validResult(result)) {
        throw new Error('Transcription worker returned an invalid result');
      }
      postMessage({
        type: 'done',
        events: result.events,
        noteCount: result.noteCount,
        tempoBpm: result.tempoBpm,
        tuning: result.tuning,
      } satisfies TranscribeWorkerResponse);
    })
    .catch(postError);
});
