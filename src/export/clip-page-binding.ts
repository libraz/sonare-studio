/**
 * Page providers backed by the stored audio assets, for offline renders.
 *
 * libsonare ships wrappers that pair a provider with an OPFS reader worker and
 * a miss-driven sliding window. Those target live playback from the AudioWorklet
 * engine: the window only advances once the audio thread reports a page it
 * already tried to read, which in an offline render would bake the gap into the
 * output. A render knows exactly which frame it is about to produce, so it
 * drives the window itself (see {@link AudioClipStreamSession}) and needs only
 * the provider primitive plus a reader.
 */

import { ClipPageProvider } from '@/wasm/index.js';
import type { ClipPageBinding, ClipPageBindingFactory } from './clip-page-stream';

/** Reads a frame range of a stored asset as planar channel buffers. */
export type AssetFrameReader = (
  assetId: string,
  startFrame: number,
  frameCount: number,
  numChannels: number,
) => Promise<Float32Array[]>;

/**
 * Builds the provider factory an offline render hands to
 * {@link AudioClipStreamSession}.
 *
 * Reads for one clip are serialized: the window only ever needs one new page
 * per step, and serializing keeps the transient decode buffer to a single page
 * even if a caller asks for several at once.
 *
 * The reader is passed in rather than reached for, so this module stays free of
 * storage imports and its window/read protocol can be driven against a real
 * engine outside the browser.
 *
 * @param readFrames Asset reader (the OPFS asset store's `readAssetFrames`).
 * @returns A factory usable as `createClipPageStream`.
 */
export function createAssetClipPageBindingFactory(
  readFrames: AssetFrameReader,
): ClipPageBindingFactory {
  return (request): ClipPageBinding => {
    const provider = new ClipPageProvider({
      numChannels: request.numChannels,
      numSamples: request.numSamples,
      pageFrames: request.pageFrames,
    });
    const lastPage = Math.ceil(request.numSamples / request.pageFrames) - 1;
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    return {
      provider,
      supplyPage(pageIndex: number): Promise<boolean> {
        if (closed || pageIndex < 0 || pageIndex > lastPage) return Promise.resolve(false);
        const startFrame = pageIndex * request.pageFrames;
        const frameCount = Math.min(request.pageFrames, request.numSamples - startFrame);
        const read = queue.then(async () => {
          if (closed) return false;
          const channels = await readFrames(
            request.assetId,
            request.dataOffsetFrames + startFrame,
            frameCount,
            request.numChannels,
          );
          // The provider is destroyed on close; a read that settles afterwards
          // must not write into it.
          if (closed) return false;
          provider.supply(pageIndex, channels);
          return true;
        });
        // Keep the chain alive past a failed read so later pages still run, and
        // still surface the failure to this caller.
        queue = read.catch(() => undefined);
        return read;
      },
      clearPage(pageIndex: number): void {
        if (!closed) provider.clear(pageIndex);
      },
      close(): void {
        if (closed) return;
        closed = true;
        provider.destroy();
      },
    };
  };
}
