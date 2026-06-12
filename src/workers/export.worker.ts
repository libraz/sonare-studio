/**
 * Module worker hosting offline mixdown/export renders.
 *
 * The libsonare wasm module is initialized lazily on the first render (via
 * the shared ensureWasm entry, which calls the module's worker-safe init())
 * and reused afterwards. Render requests are processed strictly in order
 * through a promise queue; 'cancel' messages bypass the queue and flip a flag
 * the running render checks between clips and stages. Audio assets and
 * SoundFonts are read from OPFS inside the worker (the persistence APIs only
 * use navigator.storage, which is available in worker scope).
 *
 * Protocol: each request carries a caller-generated `id`; every response
 * echoes it back. A render emits any number of `progress` responses before
 * its terminal `render` / `cancelled` / `error` response.
 */

import { renderProjectWithEngine } from '@/export/engine-render';
import {
  createWasmMixdownDeps,
  MixdownCancelledError,
  type MixdownRange,
  type MixdownRangePpq,
  type MixdownReport,
  renderMixdown,
} from '@/export/mixdown';
import type { ProjectDocument } from '@/project/serialization';

/** Structured-clone-safe subset of the mixdown options (no functions). */
export interface ExportRenderOptions {
  /** Output sample rate in Hz; defaults to the document sample rate. */
  sampleRate?: number;
  /** Render range (default 'project'). */
  range?: MixdownRange;
  /** Loop window used when range is 'loop'. */
  loopRegion?: MixdownRangePpq;
  /** Apply master inserts/EQ and the mastering chain (default true). */
  includeMasterChain?: boolean;
  /** Also return one stereo stem per track (post-strip, pre-master). */
  stems?: boolean;
  /** MIDI clip normalization target; see renderMixdown. */
  targetPeak?: number | null;
}

/** One transferred stem of a worker render. */
export interface ExportWorkerStem {
  trackIndex: number;
  name: string;
  left: Float32Array;
  right: Float32Array;
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
  | { type: 'render'; doc: ProjectDocument; options?: ExportRenderOptions }
  | { type: 'cancel'; targetId: number }
  | { type: 'destroy' };

/** A request message: payload plus caller-generated correlation id. */
export type ExportRequest = ExportRequestBody & { id: number };

/** Response messages; `id` echoes the originating request. */
export type ExportResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'render'; result: ExportWorkerResult }
  | { id: number; type: 'cancelled' }
  | { id: number; type: 'destroy' }
  | { id: number; type: 'error'; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Render ids flagged for cancellation ('cancel' bypasses the queue). */
const cancelled = new Set<number>();

function post(message: ExportResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
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
): Promise<void> {
  try {
    // The stereo mixdown renders through the offline engine (live-playback
    // parity: buses/sends, strips, realtime instruments, automation, tempo
    // map). Stems still use the legacy per-track summing renderer.
    const result = options.stems
      ? await renderMixdown(doc, {
          ...options,
          deps: await createWasmMixdownDeps(),
          onProgress: (progress, stage) => post({ id, type: 'progress', progress, stage }),
          shouldCancel: () => cancelled.has(id),
          yieldBetweenClips: yieldToMessages,
        })
      : await renderProjectWithEngine(doc, {
          ...options,
          onProgress: (progress, stage) => post({ id, type: 'progress', progress, stage }),
          shouldCancel: () => cancelled.has(id),
          yieldBetweenBlocks: yieldToMessages,
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
        trackIndex: stem.trackIndex,
        name: stem.name,
        left: stem.channels[0],
        right: stem.channels[1],
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
    cancelled.delete(id);
  }
}

async function handle(request: ExportRequest): Promise<void> {
  switch (request.type) {
    case 'render': {
      await handleRender(request.id, request.doc, request.options);
      return;
    }
    case 'cancel': {
      // Handled out of band in onmessage; reaching here means the render it
      // targeted already finished, which is a harmless no-op.
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
    cancelled.add(request.targetId);
    return;
  }
  queue = queue.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      post({
        id: request.id,
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
