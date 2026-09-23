/**
 * Module worker running `decomposeStemsLinked`: one shared NMF model and soft
 * mask across every channel, applied to each channel's own complex spectrum.
 * The libsonare wasm module is initialized lazily via the shared ensureWasm
 * entry and reused afterwards. Roughly 1x realtime, so it belongs off the main
 * thread; there is one request per worker instance (the client disposes it).
 */

import { ensureWasm } from '@/lib/wasm';

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

self.addEventListener('message', (event: MessageEvent<DecomposeStemsWorkerRequest>) => {
  const { channels, sampleRate, nComponents } = event.data;
  ensureWasm()
    .then((wasm) => {
      const result = wasm.decomposeStemsLinked({
        channels,
        sampleRate,
        nComponents,
        init: 'nndsvd',
      });
      const transfer = result.components.flatMap((component) =>
        component.map((channel) => channel.buffer),
      );
      postMessage(
        { type: 'done', components: result.components } satisfies DecomposeStemsWorkerResponse,
        transfer,
      );
    })
    .catch((error: unknown) => {
      postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      } satisfies DecomposeStemsWorkerResponse);
    });
});
