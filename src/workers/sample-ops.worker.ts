/** Worker endpoint for the synchronous, non-WASM sample-editor operations. */

import {
  applyGainDb,
  fadeInLinear,
  fadeOutLinear,
  normalizeToDb,
  reverse,
  type SampleRange,
  silence,
  trimToRange,
} from '@/ui/sample-editor/ops';

export type SampleOperationRequest =
  | { type: 'gain'; channels: Float32Array[]; range: SampleRange; db: number }
  | { type: 'normalize'; channels: Float32Array[]; range: SampleRange; targetDb: number }
  | { type: 'fade-in'; channels: Float32Array[]; range: SampleRange }
  | { type: 'fade-out'; channels: Float32Array[]; range: SampleRange }
  | { type: 'reverse'; channels: Float32Array[]; range: SampleRange }
  | { type: 'silence'; channels: Float32Array[]; range: SampleRange }
  | { type: 'trim'; channels: Float32Array[]; range: SampleRange };

export type SampleOperationResponse =
  | { type: 'done'; channels: Float32Array[] }
  | { type: 'error'; error: string };

function perform(request: SampleOperationRequest): Float32Array[] {
  const { channels, range } = request;
  switch (request.type) {
    case 'gain':
      return applyGainDb(channels, request.db, range);
    case 'normalize':
      return normalizeToDb(channels, request.targetDb, range);
    case 'fade-in':
      return fadeInLinear(channels, range);
    case 'fade-out':
      return fadeOutLinear(channels, range);
    case 'reverse':
      return reverse(channels, range);
    case 'silence':
      return silence(channels, range);
    case 'trim':
      return trimToRange(channels, range);
  }
}

self.addEventListener('message', (event: MessageEvent<SampleOperationRequest>) => {
  try {
    const channels = perform(event.data);
    postMessage(
      { type: 'done', channels } satisfies SampleOperationResponse,
      channels.map((channel) => channel.buffer),
    );
  } catch (error) {
    postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    } satisfies SampleOperationResponse);
  }
});
