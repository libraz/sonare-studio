/**
 * Track freeze and bounce-in-place: renders one track's pre-fader signal in
 * isolation through the offline engine renderer (clips, instrument,
 * inserts/EQ — without its sends, fader/pan or fader/pan automation, which
 * stay live), stores the render as an asset and flips the track's frozen
 * state (freeze) or places the render as a new audio clip (bounce).
 */

import { resolvePresetName } from '@/engine/instruments';
import { renderProjectWithEngine } from '@/export/engine-render';
import { ensureWasm } from '@/lib/wasm';
import { ingestAudioBuffer } from './audio-import';
import { addBouncedClip, setTrackFrozen } from './commands';
import { serializeProject } from './serialization';
import { useProjectStore } from './store';

/** Injectable seams for {@link freezeTrack} / {@link bounceTrackRange}. */
export interface FreezeRenderOptions {
  /** Render seam (tests); defaults to renderProjectWithEngine. */
  render?: typeof renderProjectWithEngine;
  /** Asset ingester (tests); defaults to ingestAudioBuffer without analysis. */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<{ id: string }>;
}

function resolveSeams(options: FreezeRenderOptions) {
  return {
    render: options.render ?? renderProjectWithEngine,
    ingest:
      options.ingest ??
      ((channels: Float32Array[], sampleRate: number, name: string) =>
        ingestAudioBuffer(channels, sampleRate, name, { analysis: null })),
  };
}

/** Renders one track's isolated pre-fader signal over the given range. */
async function renderFrozen(
  trackId: number,
  range: { startPpq: number; endPpq: number } | null,
  options: FreezeRenderOptions,
) {
  const store = useProjectStore();
  const trackIndex = store.tracks.findIndex((track) => track.id === trackId);
  if (trackIndex < 0) throw new RangeError(`Unknown track id ${trackId}`);
  if (store.tracks[trackIndex].kind === 'group') {
    throw new RangeError('Group tracks cannot be frozen or bounced (no own content)');
  }
  const { render } = resolveSeams(options);
  const doc = serializeProject();
  const wasm = await ensureWasm();
  return render(doc, {
    freezeTrackIndex: trackIndex,
    deps: null,
    resolvePreset: (preset) => resolvePresetName(wasm, preset),
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
  const { ingest } = resolveSeams(options);
  const result = await renderFrozen(trackId, null, options);
  const meta = await ingest(
    [result.channels[0], result.channels[1]],
    result.sampleRate,
    `${track.name} (frozen)`,
  );
  setTrackFrozen(trackId, { assetId: meta.id });
  return meta.id;
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
  if (!(Number.isFinite(startPpq) && startPpq >= 0 && Number.isFinite(endPpq))) {
    throw new RangeError('Bounce range PPQ values must be finite and >= 0');
  }
  if (endPpq <= startPpq) {
    throw new RangeError(`Bounce range end (${endPpq}) must be after its start (${startPpq})`);
  }
  const { ingest } = resolveSeams(options);
  const result = await renderFrozen(trackId, { startPpq, endPpq }, options);
  const meta = await ingest(
    [result.channels[0], result.channels[1]],
    result.sampleRate,
    `${track.name} (bounce)`,
  );
  // One undoable edit: a single undo removes the clip AND its new track.
  return addBouncedClip({
    name: `${track.name} (bounce)`,
    assetId: meta.id,
    startPpq,
    lengthPpq: endPpq - startPpq,
  });
}
