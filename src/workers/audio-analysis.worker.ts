import { errorMessage } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import type { AudioAssetTags } from '@/persistence/assets';
import {
  type AudioAnalysisFunctions,
  analyzeAudioTags,
  type LoudnessInput,
} from '@/project/audio-tags';

/** One disposable request over a mono buffer: its asset tags, beats, or beat accents. */
export interface AudioAnalysisWorkerRequest {
  kind: 'tags' | 'beats' | 'meter';
  samples: Float32Array;
  sampleRate: number;
  /** The stored channels for the loudness step of a 'tags' request. */
  loudness?: LoudnessInput;
}

/** Messages sent back by the analysis worker: progress, then one result. */
export type AudioAnalysisWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; tags: AudioAssetTags }
  | { type: 'beats'; beats: number[]; downbeats: number[] }
  | { type: 'meter'; beatTimes: number[]; beatStrengths: number[] }
  | { type: 'error'; error: string };

interface BeatAnalyzer {
  analyze: (
    samples: Float32Array,
    sampleRate: number,
  ) => { beats: ReadonlyArray<{ time: number }>; beatObservations: { onsetStrength: number[] } };
}

interface BeatDetectors {
  detectBeats: (samples: Float32Array, sampleRate?: number) => ArrayLike<number>;
  detectDownbeats: (samples: Float32Array, sampleRate?: number) => ArrayLike<number>;
}

function validRequest(value: unknown): value is AudioAnalysisWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<AudioAnalysisWorkerRequest>;
  return (
    (request.kind === 'tags' || request.kind === 'beats' || request.kind === 'meter') &&
    request.samples instanceof Float32Array &&
    typeof request.sampleRate === 'number' &&
    Number.isFinite(request.sampleRate) &&
    request.sampleRate > 0 &&
    (request.loudness === undefined ||
      (request.loudness.interleaved instanceof Float32Array &&
        Number.isInteger(request.loudness.channels) &&
        request.loudness.channels > 0))
  );
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!validRequest(event.data)) {
    postMessage({
      type: 'error',
      error: 'Audio analysis worker received an invalid request',
    } satisfies AudioAnalysisWorkerResponse);
    return;
  }
  const { kind, samples, sampleRate, loudness } = event.data;
  ensureWasm()
    .then((wasm) => {
      if (kind === 'beats') {
        const detectors = wasm as unknown as BeatDetectors;
        postMessage({
          type: 'beats',
          beats: Array.from(detectors.detectBeats(samples, sampleRate)),
          downbeats: Array.from(detectors.detectDownbeats(samples, sampleRate)),
        } satisfies AudioAnalysisWorkerResponse);
        return;
      }
      if (kind === 'meter') {
        const analysis = (wasm as unknown as BeatAnalyzer).analyze(samples, sampleRate);
        postMessage({
          type: 'meter',
          beatTimes: analysis.beats.map((beat) => beat.time),
          beatStrengths: Array.from(analysis.beatObservations.onsetStrength),
        } satisfies AudioAnalysisWorkerResponse);
        return;
      }
      const tags = analyzeAudioTags(
        samples,
        sampleRate,
        wasm as unknown as AudioAnalysisFunctions,
        (fraction) =>
          postMessage({ type: 'progress', fraction } satisfies AudioAnalysisWorkerResponse),
        loudness,
      );
      postMessage({ type: 'done', tags } satisfies AudioAnalysisWorkerResponse);
    })
    .catch((error: unknown) => {
      postMessage({
        type: 'error',
        error: errorMessage(error),
      } satisfies AudioAnalysisWorkerResponse);
    });
});
