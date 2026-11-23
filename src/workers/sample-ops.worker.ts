/** Worker endpoint for the synchronous, non-WASM sample-editor operations. */

import { errorMessage } from '@/lib/errors';
import { isFiniteNumber } from '@/lib/math';
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
import { isChannelList, isRecord, serveWorkerRequests } from './worker-request';

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

const OPERATION_TYPES = new Set<string>([
  'gain',
  'normalize',
  'fade-in',
  'fade-out',
  'reverse',
  'silence',
  'trim',
  'delete',
  'duplicate',
]);

function validRequest(value: unknown): value is SampleOperationRequest {
  if (!isRecord(value)) return false;
  const { type, channels, range } = value;
  return (
    typeof type === 'string' &&
    OPERATION_TYPES.has(type) &&
    isChannelList(channels) &&
    isRecord(range) &&
    isFiniteNumber(range.startFrame) &&
    isFiniteNumber(range.endFrame) &&
    (type !== 'gain' || isFiniteNumber(value.db)) &&
    (type !== 'normalize' || isFiniteNumber(value.targetDb)) &&
    ((type !== 'delete' && type !== 'duplicate') || isFiniteNumber(value.fadeFrames))
  );
}

serveWorkerRequests<SampleOperationRequest, SampleOperationResponse>({
  validate: validRequest,
  invalidMessage: 'Sample operation worker received an invalid request',
  errorReply: (error) => ({ type: 'error', error: errorMessage(error) }),
  handle: (request, post) => {
    const channels = perform(request);
    post(
      { type: 'done', channels },
      channels.map((channel) => channel.buffer),
    );
  },
});
