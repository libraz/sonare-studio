import { ensureWasm } from '@/lib/wasm';
import type { AudioAssetTags } from '@/persistence/assets';
import { type AudioAnalysisFunctions, analyzeAudioTags } from '@/project/audio-tags';

/** One disposable request over a mono buffer: its asset tags, or its beats. */
export interface AudioAnalysisWorkerRequest {
  kind: 'tags' | 'beats';
  samples: Float32Array;
  sampleRate: number;
}

/** Messages sent back by the analysis worker: progress, then one result. */
export type AudioAnalysisWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; tags: AudioAssetTags }
  | { type: 'beats'; beats: number[]; downbeats: number[] }
  | { type: 'error'; error: string };

interface BeatDetectors {
  detectBeats: (samples: Float32Array, sampleRate?: number) => ArrayLike<number>;
  detectDownbeats: (samples: Float32Array, sampleRate?: number) => ArrayLike<number>;
}

function validRequest(value: unknown): value is AudioAnalysisWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Partial<AudioAnalysisWorkerRequest>;
  return (
    (request.kind === 'tags' || request.kind === 'beats') &&
    request.samples instanceof Float32Array &&
    typeof request.sampleRate === 'number' &&
    Number.isFinite(request.sampleRate) &&
    request.sampleRate > 0
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
  const { kind, samples, sampleRate } = event.data;
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
      const tags = analyzeAudioTags(
        samples,
        sampleRate,
        wasm as unknown as AudioAnalysisFunctions,
        (fraction) =>
          postMessage({ type: 'progress', fraction } satisfies AudioAnalysisWorkerResponse),
      );
      postMessage({ type: 'done', tags } satisfies AudioAnalysisWorkerResponse);
    })
    .catch((error: unknown) => {
      postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      } satisfies AudioAnalysisWorkerResponse);
    });
});
