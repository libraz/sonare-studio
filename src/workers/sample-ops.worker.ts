/** Worker endpoint for the synchronous, non-WASM sample-editor operations. */

import {
  applyGainDb,
  applyGainDbInPlace,
  deleteRange,
  duplicateRange,
  fadeInLinear,
  fadeInLinearInPlace,
  fadeOutLinear,
  fadeOutLinearInPlace,
  normalizeToDb,
  normalizeToDbInPlace,
  reverse,
  reverseInPlace,
  type SampleRange,
  silence,
  silenceInPlace,
  trimToRange,
  trimToRangeInPlace,
} from '@/ui/sample-editor/ops';

export type SampleOperationRequest =
  | { type: 'gain'; channels: Float32Array[]; range: SampleRange; db: number; owned?: boolean }
  | {
      type: 'normalize';
      channels: Float32Array[];
      range: SampleRange;
      targetDb: number;
      owned?: boolean;
    }
  | { type: 'fade-in'; channels: Float32Array[]; range: SampleRange; owned?: boolean }
  | { type: 'fade-out'; channels: Float32Array[]; range: SampleRange; owned?: boolean }
  | { type: 'reverse'; channels: Float32Array[]; range: SampleRange; owned?: boolean }
  | { type: 'silence'; channels: Float32Array[]; range: SampleRange; owned?: boolean }
  | { type: 'trim'; channels: Float32Array[]; range: SampleRange; owned?: boolean }
  | {
      type: 'delete';
      channels: Float32Array[];
      range: SampleRange;
      fadeFrames: number;
      owned?: boolean;
    }
  | {
      type: 'duplicate';
      channels: Float32Array[];
      range: SampleRange;
      fadeFrames: number;
      owned?: boolean;
    };

export type SampleOperationResponse =
  | { type: 'done'; channels: Float32Array[] }
  | { type: 'error'; error: string };

function perform(request: SampleOperationRequest): Float32Array[] {
  const { channels, range } = request;
  const owned = request.owned === true;
  switch (request.type) {
    case 'gain':
      return owned
        ? applyGainDbInPlace(channels, request.db, range)
        : applyGainDb(channels, request.db, range);
    case 'normalize':
      return owned
        ? normalizeToDbInPlace(channels, request.targetDb, range)
        : normalizeToDb(channels, request.targetDb, range);
    case 'fade-in':
      return owned ? fadeInLinearInPlace(channels, range) : fadeInLinear(channels, range);
    case 'fade-out':
      return owned ? fadeOutLinearInPlace(channels, range) : fadeOutLinear(channels, range);
    case 'reverse':
      return owned ? reverseInPlace(channels, range) : reverse(channels, range);
    case 'silence':
      return owned ? silenceInPlace(channels, range) : silence(channels, range);
    case 'trim':
      return owned ? trimToRangeInPlace(channels, range) : trimToRange(channels, range);
    // Both change the length, so they always build fresh buffers: there is no
    // in-place form to prefer when the worker owns the input.
    case 'delete':
      return deleteRange(channels, range, request.fadeFrames);
    case 'duplicate':
      return duplicateRange(channels, range, request.fadeFrames);
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
