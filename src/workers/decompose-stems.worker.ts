/**
 * Module worker running `decomposeStemsLinked`: one shared NMF model and soft
 * mask across every channel, applied to each channel's own complex spectrum.
 * The libsonare wasm module is initialized lazily via the shared ensureWasm
 * entry and reused afterwards. Roughly 1x realtime, so it belongs off the main
 * thread; there is one request per worker instance (the client disposes it).
 */

import { errorMessage } from '@/lib/errors';
import { isFiniteNumber } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import { isChannelList, isRecord, serveWorkerRequests } from './worker-request';

/** Request payload: planar channels to factor into `nComponents` components. */
export interface DecomposeStemsWorkerRequest {
  channels: Float32Array[];
  sampleRate: number;
  nComponents: number;
}

/** Response: `components[k][c]` is component `k`'s signal on channel `c`. */
export type DecomposeStemsWorkerResponse =
  | { type: 'done'; components: Float32Array[][] }
  | { type: 'error'; error: string };

function validRequest(value: unknown): value is DecomposeStemsWorkerRequest {
  return (
    isRecord(value) &&
    isChannelList(value.channels) &&
    isFiniteNumber(value.sampleRate) &&
    value.sampleRate > 0 &&
    Number.isInteger(value.nComponents) &&
    (value.nComponents as number) > 0
  );
}

serveWorkerRequests<DecomposeStemsWorkerRequest, DecomposeStemsWorkerResponse>({
  validate: validRequest,
  invalidMessage: 'Component split worker received an invalid request',
  errorReply: (error) => ({ type: 'error', error: errorMessage(error) }),
  handle: async ({ channels, sampleRate, nComponents }, post) => {
    const wasm = await ensureWasm();
    const result = wasm.decomposeStemsLinked({
      channels,
      sampleRate,
      nComponents,
      init: 'nndsvd',
    });
    const transfer = result.components.flatMap((component) =>
      component.map((channel) => channel.buffer),
    );
    post({ type: 'done', components: result.components }, transfer);
  },
});
