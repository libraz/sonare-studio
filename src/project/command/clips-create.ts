import { audioAssetUri, loadAssetMeta } from '@/persistence/assets';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { type ClipTake, TRACK_COLOR_PALETTE } from '../types';
import { execute } from './history';
import { requireTrack, validatePpq } from './utils';

// ---------------------------------------------------------------------------
// Clip creation commands
// ---------------------------------------------------------------------------

/** Fields for {@link addMidiClip}. */
export interface AddMidiClipInput {
  /** Id of the track the clip belongs to. */
  trackId: number;
  /** Timeline start in PPQ (>= 0). Defaults to 0. */
  startPpq?: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
}

/**
 * Adds an empty MIDI clip to a track as one undoable edit.
 *
 * Project.addClip registers a backing source and the clip itself, which are
 * two entries on the Project history; undo reverts both at once.
 *
 * @param input Clip placement and optional name.
 * @returns The stable clip id allocated by the Project.
 */
export function addMidiClip(input: AddMidiClipInput): number {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, input.trackId);
  const startPpq = input.startPpq ?? 0;
  validatePpq(startPpq, 'Clip startPpq');
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  return execute(2, () => {
    const newClipId = project.addClip({
      trackId: input.trackId,
      isMidi: true,
      startPpq,
      lengthPpq: input.lengthPpq,
    });
    if (input.name !== undefined) {
      // Seed the mirror entry so refresh keeps the app-level name.
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId: input.trackId,
          name: input.name,
          startPpq,
          lengthPpq: input.lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
        },
      ];
    }
    store.refresh();
    return newClipId;
  });
}

/** Fields for {@link addAudioClip}. */
export interface AddAudioClipInput {
  /** Id of the track the clip belongs to. */
  trackId: number;
  /** Audio asset id from src/persistence/assets.ts. */
  assetId: string;
  /** Timeline start in PPQ (>= 0). Defaults to 0. */
  startPpq?: number;
  /**
   * Clip length in PPQ (> 0). Defaults to the full asset duration converted
   * at the current project tempo (which requires the asset metadata to be
   * loadable from the asset store).
   */
  lengthPpq?: number;
  /** Linear playback gain (>= 0). Defaults to 1. */
  gain?: number;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
  /**
   * Alternative recordings of the clip (cycle takes). When present, the
   * comp selection starts on `activeTakeIndex` throughout and `assetId`
   * must reference that take's asset.
   */
  takes?: ClipTake[];
  /** Take initially selected (defaults to the last); used with `takes`. */
  activeTakeIndex?: number;
}

/**
 * Adds an audio clip referencing a stored asset as one undoable edit.
 *
 * The wasm Project registers one audio source per asset: the first clip of an
 * asset registers a by-reference source (sourceUri "asset:<id>", two entries
 * on the Project history, like addMidiClip), later clips of the same asset
 * are rebound to that source via Project.setClipSource (three entries). Undo
 * reverts the whole command at once either way.
 *
 * The clip's PCM stays in the asset store; playback loads it when scheduling
 * (src/project/scheduling.ts).
 *
 * @param input Clip placement, asset reference and optional overrides.
 * @returns The stable clip id allocated by the Project.
 */
export async function addAudioClip(input: AddAudioClipInput): Promise<number> {
  const store = useProjectStore();
  const project = getProject();
  requireTrack(store, input.trackId);
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    throw new RangeError('Audio clip assetId must not be empty');
  }
  const startPpq = input.startPpq ?? 0;
  validatePpq(startPpq, 'Clip startPpq');
  if (input.gain !== undefined && (!Number.isFinite(input.gain) || input.gain < 0)) {
    throw new RangeError(`Clip gain must be finite and >= 0, got ${input.gain}`);
  }
  let lengthPpq = input.lengthPpq;
  if (lengthPpq === undefined) {
    // Default length: the asset's duration in beats at the current tempo.
    const meta = await loadAssetMeta(input.assetId);
    lengthPpq = (meta.numFrames / meta.sampleRate) * (store.tempoBpm / 60);
  }
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${lengthPpq}`);
  }
  const finalLengthPpq = lengthPpq;
  const gain = input.gain ?? 1;
  // Reuse the asset's registered source when it is still on the Project
  // (undo may have rolled the registration back; then re-register).
  let takes: ClipTake[] | undefined;
  let activeTakeIndex = 0;
  if (input.takes !== undefined && input.takes.length > 0) {
    takes = input.takes.map((take) => ({ ...take }));
    activeTakeIndex = input.activeTakeIndex ?? takes.length - 1;
    if (
      !Number.isInteger(activeTakeIndex) ||
      activeTakeIndex < 0 ||
      activeTakeIndex >= takes.length
    ) {
      throw new RangeError(`Active take index ${activeTakeIndex} is out of range`);
    }
    if (takes[activeTakeIndex].assetId !== input.assetId) {
      throw new RangeError('Clip assetId must reference the active take asset');
    }
  }
  const known = getAudioSourceId(input.assetId);
  const sourceId =
    known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
  return execute(sourceId === undefined ? 2 : 3, () => {
    const newClipId = project.addClip({
      trackId: input.trackId,
      isMidi: false,
      startPpq,
      lengthPpq: finalLengthPpq,
      gain,
      // The binding requires non-empty inline audio on every clip-source
      // registration; the real PCM stays in the asset store (the source is
      // by-reference via its "asset:<id>" URI).
      ...placeholderSourceAudio(),
      ...(sourceId === undefined ? { sourceUri: audioAssetUri(input.assetId) } : {}),
    });
    if (sourceId === undefined) {
      setAudioSourceId(input.assetId, project.sourceCount());
    } else {
      project.setClipSource(newClipId, sourceId);
    }
    // Seed the mirror entry so refresh keeps the kind/asset metadata.
    store.clips = [
      ...store.clips,
      {
        id: newClipId,
        trackId: input.trackId,
        name: input.name ?? `Clip ${newClipId}`,
        startPpq,
        lengthPpq: finalLengthPpq,
        sourceOffsetPpq: 0,
        gain,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
        kind: 'audio',
        assetId: input.assetId,
        ...(takes !== undefined
          ? {
              takes,
              compSegments: [{ startPpq: 0, takeIndex: activeTakeIndex }],
            }
          : {}),
      },
    ];
    store.refresh();
    return newClipId;
  });
}

/** Fields for {@link addBouncedClip}. */
export interface AddBouncedClipInput {
  /** Name for the new track and its clip. */
  name: string;
  /** Audio asset id holding the bounced render. */
  assetId: string;
  /** Timeline start in PPQ (>= 0). */
  startPpq: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
}

/**
 * Creates a new audio track holding one clip over a bounced render, as ONE
 * undoable edit (a bounce-in-place result; a single undo removes both the
 * clip and its track instead of stranding an empty track).
 *
 * @param input Track/clip name, asset and clip window.
 * @returns The new clip id.
 */
export function addBouncedClip(input: AddBouncedClipInput): number {
  const store = useProjectStore();
  const project = getProject();
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    throw new RangeError('Bounced clip assetId must not be empty');
  }
  validatePpq(input.startPpq, 'Clip startPpq');
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
  const known = getAudioSourceId(input.assetId);
  const sourceId =
    known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
  return execute(sourceId === undefined ? 3 : 4, () => {
    const trackId = project.addTrack({ kind: 'audio', name: input.name });
    const newClipId = project.addClip({
      trackId,
      isMidi: false,
      startPpq: input.startPpq,
      lengthPpq: input.lengthPpq,
      gain: 1,
      ...placeholderSourceAudio(),
      ...(sourceId === undefined ? { sourceUri: audioAssetUri(input.assetId) } : {}),
    });
    if (sourceId === undefined) {
      setAudioSourceId(input.assetId, project.sourceCount());
    } else {
      project.setClipSource(newClipId, sourceId);
    }
    store.tracks = [
      ...store.tracks,
      {
        id: trackId,
        name: input.name,
        color,
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: store.tracks.length,
      },
    ];
    store.clips = [
      ...store.clips,
      {
        id: newClipId,
        trackId,
        name: input.name,
        startPpq: input.startPpq,
        lengthPpq: input.lengthPpq,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
        kind: 'audio',
        assetId: input.assetId,
      },
    ];
    store.refresh();
    return newClipId;
  });
}
