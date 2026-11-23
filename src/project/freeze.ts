/**
 * Track freeze and bounce-in-place: renders one track's pre-fader signal in
 * isolation through the offline engine renderer (clips, instrument,
 * inserts/EQ — without its sends, fader/pan or fader/pan automation, which
 * stay live), stores the render as an asset and flips the track's frozen
 * state (freeze) or places the render as a new audio clip (bounce).
 */

import { resolvePresetName } from '@/engine/instruments';
import { renderProjectWithEngine } from '@/export/engine-render';
import { DEFAULT_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { createAssetReferenceGuard } from './asset-references';
import { addBouncedClip, setTrackFrozen } from './commands';
import { defaultName } from './default-names';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  isProjectOperationCurrent,
} from './operation';
import { serializeProject } from './serialization';
import { useProjectStore } from './store';

/** Injectable seams for {@link freezeTrack} / {@link bounceTrackRange}. */
export interface FreezeRenderOptions {
  /** Render seam (tests); defaults to renderProjectWithEngine. */
  render?: typeof renderProjectWithEngine;
  /** Asset ingester override for tests; production uses a leased asset transaction. */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<{ id: string }>;
  /**
   * Cooperative yield awaited between render checkpoints; defaults to a
   * macrotask so the main thread can repaint and land pending edits (which the
   * cancellation check then observes) during a long freeze/bounce.
   */
  yieldBetweenBlocks?: () => Promise<void>;
}

const freezeOperations = new OperationGeneration();

/** Yields a macrotask so the browser can repaint mid-render. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Cheap change signal for a freeze/bounce: only the target track's own content
 * plus tempo/meter affect its isolated pre-fader render, so hashing just those
 * — instead of the whole document on every render checkpoint — keeps the
 * cancellation check O(one track) on large projects. Document-level swaps
 * (new/load/dispose) are caught separately by the operation's documentGeneration
 * identity, so they need not appear here.
 */
function trackRenderRevision(trackId: number): string | null {
  try {
    const store = useProjectStore();
    return JSON.stringify({
      tempo: store.tempoSegments,
      meter: store.timeSignatures,
      pickup: store.pickupLengthPpq,
      track: store.tracks.find((entry) => entry.id === trackId) ?? null,
      clips: store.clips.filter((clip) => clip.trackId === trackId),
    });
  } catch {
    return null;
  }
}

function resolveSeams(options: FreezeRenderOptions) {
  return {
    render: options.render ?? renderProjectWithEngine,
    yieldBetweenBlocks: options.yieldBetweenBlocks ?? yieldToEventLoop,
  };
}

/** Renders one track's isolated pre-fader signal over the given range. */
async function renderFrozen(
  doc: ReturnType<typeof serializeProject>,
  trackIndex: number,
  range: { startPpq: number; endPpq: number } | null,
  options: FreezeRenderOptions,
  shouldCancel: () => boolean,
) {
  const { render, yieldBetweenBlocks } = resolveSeams(options);
  const wasm = await ensureWasm();
  if (shouldCancel()) throw new DOMException('Freeze render was superseded.', 'AbortError');
  return render(doc, {
    freezeTrackIndex: trackIndex,
    deps: null,
    resolvePreset: (preset) => resolvePresetName(wasm, preset),
    memoryBudgetBytes: DEFAULT_EXPORT_MEMORY_BUDGET_BYTES,
    shouldCancel,
    yieldBetweenBlocks,
    releaseTailFromEngine: true,
    appendReleaseTailForExplicitRange: range !== null,
    ...(range !== null ? { range } : {}),
  });
}

/**
 * Freezes a track: bakes its pre-fader render over the whole project span
 * into an asset and flips the track's frozen state (one undoable edit; the
 * baked asset itself is not part of undo history). Already-frozen tracks
 * re-freeze from their CURRENT baked audio, so unfreeze first to capture
 * edits.
 *
 * @param trackId Id of the track to freeze.
 * @returns The frozen asset id.
 */
export async function freezeTrack(
  trackId: number,
  options: FreezeRenderOptions = {},
): Promise<string> {
  const store = useProjectStore();
  const track = store.tracks.find((entry) => entry.id === trackId);
  if (!track) throw new RangeError(`Unknown track id ${trackId}`);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks cannot be frozen or bounced (no own content)');
  }
  const trackIndex = store.tracks.findIndex((entry) => entry.id === trackId);
  const doc = serializeProject();
  const operation = beginProjectOperation(
    freezeOperations,
    store,
    `freeze:${trackId}`,
    trackRenderRevision(trackId),
  );
  const assets = options.ingest ? null : createAudioAssetTransaction();
  const isReferenced = createAssetReferenceGuard(store);
  try {
    const result = await renderFrozen(
      doc,
      trackIndex,
      null,
      options,
      () =>
        !isProjectOperationCurrent(
          freezeOperations,
          operation,
          store,
          `freeze:${trackId}`,
          trackRenderRevision(trackId),
        ),
    );
    assertProjectOperationCurrent(
      freezeOperations,
      operation,
      store,
      `freeze:${trackId}`,
      trackRenderRevision(trackId),
    );
    const meta = options.ingest
      ? await options.ingest(
          [result.channels[0], result.channels[1]],
          result.sampleRate,
          defaultName('frozen', { name: track.name }),
        )
      : await assets!.save(
          { name: defaultName('frozen', { name: track.name }), sampleRate: result.sampleRate },
          [result.channels[0], result.channels[1]],
        );
    assertProjectOperationCurrent(
      freezeOperations,
      operation,
      store,
      `freeze:${trackId}`,
      trackRenderRevision(trackId),
    );
    setTrackFrozen(trackId, { assetId: meta.id });
    assets?.commit();
    return meta.id;
  } catch (error) {
    await assets?.rollback(isReferenced);
    throw error;
  } finally {
    if (freezeOperations.isCurrent(operation.token)) freezeOperations.invalidate();
  }
}

/**
 * Unfreezes a track: its own clips, instrument and strip DSP take over again
 * (one undoable edit). The baked asset stays in the asset store.
 *
 * @param trackId Id of the frozen track.
 */
export function unfreezeTrack(trackId: number): void {
  setTrackFrozen(trackId, null);
}

/**
 * Bounce-in-place: renders a track's isolated pre-fader signal over a PPQ
 * range and places it as an audio clip on a new track named after the
 * source; the original track is untouched.
 *
 * @param trackId Id of the source track.
 * @param startPpq Range start in PPQ (>= 0).
 * @param endPpq Range end in PPQ (> startPpq).
 * @returns The new clip id.
 */
export async function bounceTrackRange(
  trackId: number,
  startPpq: number,
  endPpq: number,
  options: FreezeRenderOptions = {},
): Promise<number> {
  const store = useProjectStore();
  const track = store.tracks.find((entry) => entry.id === trackId);
  if (!track) throw new RangeError(`Unknown track id ${trackId}`);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks cannot be frozen or bounced (no own content)');
  }
  if (!(Number.isFinite(startPpq) && startPpq >= 0 && Number.isFinite(endPpq))) {
    throw new RangeError('Bounce range PPQ values must be finite and >= 0');
  }
  if (endPpq <= startPpq) {
    throw new RangeError(`Bounce range end (${endPpq}) must be after its start (${startPpq})`);
  }
  const trackIndex = store.tracks.findIndex((entry) => entry.id === trackId);
  const doc = serializeProject();
  const operation = beginProjectOperation(
    freezeOperations,
    store,
    `bounce:${trackId}`,
    trackRenderRevision(trackId),
  );
  const assets = options.ingest ? null : createAudioAssetTransaction();
  const isReferenced = createAssetReferenceGuard(store);
  try {
    const result = await renderFrozen(
      doc,
      trackIndex,
      { startPpq, endPpq },
      options,
      () =>
        !isProjectOperationCurrent(
          freezeOperations,
          operation,
          store,
          `bounce:${trackId}`,
          trackRenderRevision(trackId),
        ),
    );
    assertProjectOperationCurrent(
      freezeOperations,
      operation,
      store,
      `bounce:${trackId}`,
      trackRenderRevision(trackId),
    );
    const meta = options.ingest
      ? await options.ingest(
          [result.channels[0], result.channels[1]],
          result.sampleRate,
          defaultName('bounce', { name: track.name }),
        )
      : await assets!.save(
          { name: defaultName('bounce', { name: track.name }), sampleRate: result.sampleRate },
          [result.channels[0], result.channels[1]],
        );
    assertProjectOperationCurrent(
      freezeOperations,
      operation,
      store,
      `bounce:${trackId}`,
      trackRenderRevision(trackId),
    );
    // One undoable edit: a single undo removes the clip AND its new track.
    const clipId = addBouncedClip({
      name: defaultName('bounce', { name: track.name }),
      assetId: meta.id,
      startPpq,
      lengthPpq: endPpq - startPpq,
    });
    assets?.commit();
    return clipId;
  } catch (error) {
    await assets?.rollback(isReferenced);
    throw error;
  } finally {
    if (freezeOperations.isCurrent(operation.token)) freezeOperations.invalidate();
  }
}
