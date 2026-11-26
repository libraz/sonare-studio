import type { BeatObservations } from '@libraz/libsonare';
import { errorMessage } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import type { AudioAssetTags } from '@/persistence/assets';
import { analyzeAudioTags, type LoudnessInput } from '@/project/audio-tags';
import { serveWorkerRequests } from './worker-request';

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
  | { type: 'meter'; observations: BeatObservations }
  | { type: 'error'; error: string };

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

serveWorkerRequests<AudioAnalysisWorkerRequest, AudioAnalysisWorkerResponse>({
  validate: validRequest,
  invalidMessage: 'Audio analysis worker received an invalid request',
  errorReply: (error) => ({ type: 'error', error: errorMessage(error) }),
  handle: async ({ kind, samples, sampleRate, loudness }, post) => {
    const wasm = await ensureWasm();
    if (kind === 'beats') {
      post({
        type: 'beats',
        beats: Array.from(wasm.detectBeats(samples, sampleRate)),
        downbeats: Array.from(wasm.detectDownbeats(samples, sampleRate)),
      });
      return;
    }
    if (kind === 'meter') {
      const analysis = wasm.analyze(samples, sampleRate);
      post({ type: 'meter', observations: analysis.beatObservations });
      return;
    }
    const tags = analyzeAudioTags(
      samples,
      sampleRate,
      wasm,
      (fraction) => post({ type: 'progress', fraction }),
      loudness,
    );
    post({ type: 'done', tags });
  },
});
