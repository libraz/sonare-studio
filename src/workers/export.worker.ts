/**
 * Module worker hosting offline mixdown/export renders.
 *
 * The libsonare wasm module is initialized lazily on the first render (via
 * the shared ensureWasm entry, which calls the module's worker-safe init())
 * and reused afterwards. Render requests are processed strictly in order
 * through a promise queue; 'cancel' messages bypass the queue and flip a flag
 * the running render checks between block checkpoints and stages. Audio
 * assets and
 * SoundFonts are read from OPFS inside the worker (the persistence APIs only
 * use navigator.storage, which is available in worker scope).
 *
 * Protocol: each request carries a caller-generated `id`; every response
 * echoes it back. A render emits any number of `progress` responses before
 * its terminal `render` / `cancelled` / `error` response.
 */

import { createAssetClipPageBindingFactory } from '@/export/clip-page-binding';
import { renderProjectWithEngine } from '@/export/engine-render';
import {
  MASTERING_BUFFER_LIMIT_ERROR_CODE,
  MasteringBufferLimitError,
} from '@/export/mastering-limit';
import { DEFAULT_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import {
  MixdownCancelledError,
  type MixdownRange,
  type MixdownRangePpq,
  type MixdownReport,
} from '@/export/mixdown';
import { errorMessage } from '@/lib/errors';
import { readAssetFrames } from '@/persistence/assets';
import type { ProjectDocument } from '@/project/serialization';

/** Structured-clone-safe subset of the render options (no functions). */
export interface ExportRenderOptions {
  /** Output sample rate in Hz; defaults to the document sample rate. */
  sampleRate?: number;
  /** Render range (default 'project'). */
  range?: MixdownRange;
  /** Release tail appended after the final clip for project-range renders. */
  releaseTailSeconds?: number;
  /** Loop window used when range is 'loop'. */
  loopRegion?: MixdownRangePpq;
  /** Apply master inserts/EQ and the mastering chain (default true). */
  includeMasterChain?: boolean;
  /** Also return one stereo stem per track (post-strip, pre-master). */
  stems?: boolean;
  /** When stems are enabled, also return one stereo stem per mixer bus/return. */
  busStems?: boolean;
  /** When stems are enabled, also return the final stereo master as a stem. */
  masterStem?: boolean;
  /** Retained full-length audio payload budget; defaults to 1 GiB. */
  memoryBudgetBytes?: number;
}

/** One transferred stem of a worker render. */
export interface ExportWorkerStem {
  source?: 'track' | 'bus' | 'master';
  trackIndex: number;
  busId?: string;
  busIndex?: number;
  name: string;
  left: Float32Array;
  right: Float32Array;
  report?: MixdownReport;
}

/** Transferred result of a worker render. */
export interface ExportWorkerResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  totalFrames: number;
  report: MixdownReport;
  stems?: ExportWorkerStem[];
}

/** Request payloads, without the correlation id. */
export type ExportRequestBody =
  | {
      type: 'render';
      doc: ProjectDocument;
      options?: ExportRenderOptions;
      /** Transfer one stem at a time and wait for a consumer acknowledgement. */
      streamStems?: boolean;
      /** Transfer master PCM blocks instead of retaining a full mixdown. */
      streamMixdown?: boolean;
    }
  | { type: 'cancel'; targetId: number }
  | { type: 'stem-consumed'; targetId: number; index: number }
  | { type: 'mixdown-consumed'; targetId: number; offsetFrames: number }
  | { type: 'destroy' };

/** A request message: payload plus caller-generated correlation id. */
export type ExportRequest = ExportRequestBody & { id: number };

/** Response messages; `id` echoes the originating request. */
export type ExportResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'stem'; stem: ExportWorkerStem; index: number; total: number }
  | {
      id: number;
      type: 'mixdown-chunk';
      left: Float32Array;
      right: Float32Array;
      offsetFrames: number;
      totalFrames: number;
    }
  | { id: number; type: 'render'; result: ExportWorkerResult }
  | { id: number; type: 'cancelled' }
  | { id: number; type: 'destroy' }
  | {
      id: number;
      type: 'error';
      error: string;
      code?: string;
      totalFrames?: number;
      maxFrames?: number;
      sampleRate?: number;
    };

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Render ids flagged for cancellation ('cancel' bypasses the queue). */
const cancelled = new Set<number>();
/** Render ids received by this worker but not yet terminally handled. */
const pendingRenderIds = new Set<number>();
const stemWaiters = new Map<number, { index: number; resolve: (consumed: boolean) => void }>();
const mixdownWaiters = new Map<
  number,
  { offsetFrames: number; resolve: (consumed: boolean) => void }
>();

/** Page provider backed by the OPFS asset store (worker scope reaches it). */
const assetClipPageStream = createAssetClipPageBindingFactory(readAssetFrames);

function post(message: ExportResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function serializeExportError(error: unknown): {
  error: string;
  code?: string;
  totalFrames?: number;
  maxFrames?: number;
  sampleRate?: number;
} {
  if (error instanceof MasteringBufferLimitError) {
    return {
      error: error.message,
      code: MASTERING_BUFFER_LIMIT_ERROR_CODE,
      totalFrames: error.totalFrames,
      maxFrames: error.maxFrames,
      sampleRate: error.sampleRate,
    };
  }
  return { error: errorMessage(error) };
}

/** Yields one macrotask so queued messages (cancel) get processed. */
function yieldToMessages(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function handleRender(
  id: number,
  doc: ProjectDocument,
  options: ExportRenderOptions = {},
  streamStems = false,
  streamMixdown = false,
): Promise<void> {
  if (cancelled.has(id)) {
    cancelled.delete(id);
    post({ id, type: 'cancelled' });
    return;
  }
  try {
    // Every render goes through the offline engine (live-playback parity:
    // buses/sends, strips, realtime instruments, automation, tempo map);
    // stems are extra isolated engine passes.
    const result = await renderProjectWithEngine(doc, {
      ...options,
      memoryBudgetBytes: options.memoryBudgetBytes ?? DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
      // Long clips that need no baked transform are read page by page from
      // their stored asset, so a project's total PCM stops bounding what can
      // be exported.
      createClipPageStream: assetClipPageStream,
      onProgress: (progress, stage) => post({ id, type: 'progress', progress, stage }),
      shouldCancel: () => cancelled.has(id),
      yieldBetweenBlocks: yieldToMessages,
      ...(streamStems && options.stems
        ? {
            onStem: async (stem, index, total): Promise<void> => {
              if (cancelled.has(id)) throw new MixdownCancelledError();
              const consumed = new Promise<boolean>((resolve) => {
                stemWaiters.set(id, { index, resolve });
              });
              post(
                {
                  id,
                  type: 'stem',
                  index,
                  total,
                  stem: {
                    source: stem.source,
                    trackIndex: stem.trackIndex,
                    busId: stem.busId,
                    busIndex: stem.busIndex,
                    name: stem.name,
                    left: stem.channels[0],
                    right: stem.channels[1],
                    report: stem.report,
                  },
                },
                [stem.channels[0].buffer, stem.channels[1].buffer],
              );
              const wasConsumed = await consumed;
              stemWaiters.delete(id);
              if (!wasConsumed || cancelled.has(id)) throw new MixdownCancelledError();
            },
          }
        : {}),
      ...(streamMixdown
        ? {
            onMixdownChunk: async (
              channels: readonly [Float32Array, Float32Array],
              offsetFrames: number,
              totalFrames: number,
            ): Promise<void> => {
              if (cancelled.has(id)) throw new MixdownCancelledError();
              const consumed = new Promise<boolean>((resolve) => {
                mixdownWaiters.set(id, { offsetFrames, resolve });
              });
              post(
                {
                  id,
                  type: 'mixdown-chunk',
                  left: channels[0],
                  right: channels[1],
                  offsetFrames,
                  totalFrames,
                },
                [channels[0].buffer, channels[1].buffer],
              );
              const wasConsumed = await consumed;
              mixdownWaiters.delete(id);
              if (!wasConsumed || cancelled.has(id)) throw new MixdownCancelledError();
            },
          }
        : {}),
    });
    const payload: ExportWorkerResult = {
      left: result.channels[0],
      right: result.channels[1],
      sampleRate: result.sampleRate,
      totalFrames: result.totalFrames,
      report: result.report,
    };
    const transfer: Transferable[] = [payload.left.buffer, payload.right.buffer];
    if (result.stems) {
      payload.stems = result.stems.map((stem) => ({
        source: stem.source,
        trackIndex: stem.trackIndex,
        busId: stem.busId,
        busIndex: stem.busIndex,
        name: stem.name,
        left: stem.channels[0],
        right: stem.channels[1],
        report: stem.report,
      }));
      for (const stem of payload.stems) {
        transfer.push(stem.left.buffer, stem.right.buffer);
      }
    }
    post({ id, type: 'render', result: payload }, transfer);
  } catch (error) {
    if (error instanceof MixdownCancelledError) {
      post({ id, type: 'cancelled' });
      return;
    }
    throw error;
  } finally {
    stemWaiters.get(id)?.resolve(false);
    stemWaiters.delete(id);
    mixdownWaiters.get(id)?.resolve(false);
    mixdownWaiters.delete(id);
    cancelled.delete(id);
  }
}

async function handle(request: ExportRequest): Promise<void> {
  switch (request.type) {
    case 'render': {
      try {
        await handleRender(
          request.id,
          request.doc,
          request.options,
          request.streamStems,
          request.streamMixdown,
        );
      } finally {
        pendingRenderIds.delete(request.id);
      }
      return;
    }
    case 'cancel': {
      // Handled out of band in onmessage; reaching here means the render it
      // targeted already finished, which is a harmless no-op.
      return;
    }
    case 'stem-consumed': {
      // Handled out of band below so the running render can resume.
      return;
    }
    case 'mixdown-consumed': {
      // Handled out of band below so the running render can resume.
      return;
    }
    case 'destroy': {
      post({ id: request.id, type: 'destroy' });
      scope.close();
      return;
    }
  }
}

/** Serializes request handling so responses follow request order. */
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<ExportRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    // Bypass the queue: the flag must be visible to the render in flight.
    // Ignore a late/unknown cancel instead of retaining its id forever. A
    // queued render is added to pendingRenderIds as soon as its message is
    // received, so legitimate pre-start cancellation still works.
    if (!pendingRenderIds.has(request.targetId)) return;
    cancelled.add(request.targetId);
    stemWaiters.get(request.targetId)?.resolve(false);
    mixdownWaiters.get(request.targetId)?.resolve(false);
    return;
  }
  if (request.type === 'stem-consumed') {
    const waiter = stemWaiters.get(request.targetId);
    if (waiter?.index === request.index) waiter.resolve(true);
    return;
  }
  if (request.type === 'mixdown-consumed') {
    const waiter = mixdownWaiters.get(request.targetId);
    if (waiter?.offsetFrames === request.offsetFrames) waiter.resolve(true);
    return;
  }
  if (request.type === 'render') pendingRenderIds.add(request.id);
  queue = queue.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      const serialized = serializeExportError(error);
      post({
        id: request.id,
        type: 'error',
        ...serialized,
      });
    }
  });
};
