import { audioAssetUri, loadAssetMeta } from '@/persistence/assets';
import { sanitizeCompSegments } from '../comping';
import { isValidChannel, isValidController, sanitizeCcPoints } from '../midi-cc';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import {
  type ClipCcLane,
  type ClipCcPoint,
  type ClipCompSegment,
  type ClipTake,
  type ClipWarp,
  type EditorClip,
  TRACK_COLOR_PALETTE,
} from '../types';
import { sanitizeWarpAnchors } from '../warp';
import { execute } from './history';
import { requireClip, requireTrack, validatePpq, withDerivedClipMetadata } from './utils';

// ---------------------------------------------------------------------------
// Clip commands
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

/** Returns the index of an audio clip with takes, or throws. */
function requireClipWithTakes(store: ReturnType<typeof useProjectStore>, clipId: number): number {
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.takes?.length ?? 0) === 0) {
    throw new RangeError(`Clip ${clipId} has no takes`);
  }
  return index;
}

/**
 * Replaces the comp selection of an audio clip with takes, as one undoable
 * edit. Segments are sanitized (sorted, clamped into the clip window, first
 * pulled to the clip start, same-take runs merged) and the clip's assetId is
 * kept on the take selected at the clip start. App-metadata only (no
 * Project edit): playback re-schedules from the mirror.
 *
 * @param clipId Id of the clip to re-comp.
 * @param segments New comp selection (at least one valid segment).
 */
export function setClipCompSegments(
  clipId: number,
  segments: ReadonlyArray<ClipCompSegment>,
): void {
  const store = useProjectStore();
  const index = requireClipWithTakes(store, clipId);
  const clip = store.clips[index];
  const takes = clip.takes as ClipTake[];
  const sanitized = sanitizeCompSegments(segments, takes.length, clip.lengthPpq);
  if (sanitized.length === 0) {
    throw new RangeError('Comp selection must keep at least one valid segment');
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) =>
      i === index
        ? {
            ...entry,
            assetId: takes[sanitized[0].takeIndex].assetId,
            compSegments: sanitized,
          }
        : entry,
    );
    store.refresh();
  });
}

/**
 * Selects one take for the whole clip (a single-segment comp selection), as
 * one undoable edit.
 *
 * @param clipId Id of the clip.
 * @param takeIndex Index into the clip's takes list.
 */
export function setClipActiveTake(clipId: number, takeIndex: number): void {
  setClipCompSegments(clipId, [{ startPpq: 0, takeIndex }]);
}

/**
 * Replaces the takes list of an audio clip as one undoable edit. The comp
 * selection resets to the active take throughout and the clip's assetId is
 * rebased onto it. App-metadata only (no Project edit).
 *
 * @param clipId Id of the audio clip.
 * @param takes New takes (non-empty, each with a non-empty assetId).
 * @param activeTakeIndex Take selected for the whole clip (defaults to the last).
 */
export function setClipTakes(
  clipId: number,
  takes: ReadonlyArray<ClipTake>,
  activeTakeIndex?: number,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  if (takes.length === 0) throw new RangeError('Takes must not be empty');
  for (const take of takes) {
    if (typeof take.assetId !== 'string' || take.assetId.length === 0) {
      throw new RangeError('Every take needs a non-empty assetId');
    }
  }
  const next = takes.map((take) => ({ assetId: take.assetId, name: take.name }));
  const active = activeTakeIndex ?? next.length - 1;
  if (!Number.isInteger(active) || active < 0 || active >= next.length) {
    throw new RangeError(`Active take index ${active} is out of range`);
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) =>
      i === index
        ? {
            ...entry,
            assetId: next[active].assetId,
            takes: next,
            compSegments: [{ startPpq: 0, takeIndex: active }],
          }
        : entry,
    );
    store.refresh();
  });
}

/**
 * Drops the take lanes of a comped clip, turning it back into a normal audio
 * clip, as one undoable edit. Without a baked asset the comp selection must
 * be a single segment (the clip keeps that take's asset); with one — see
 * flattenClipComp (src/project/comp-flatten.ts), which stitches the comp
 * into a new asset first — the clip is rebased onto the baked asset. The
 * clip's source offset is owned by the wasm Project and stays unchanged, so
 * the baked asset must cover the clip's source window (flattenClipComp pads
 * it with leading silence up to the source offset).
 *
 * @param clipId Id of the clip to flatten.
 * @param bakedAssetId Asset holding the stitched comp at the clip's source window.
 */
export function dropClipTakes(clipId: number, bakedAssetId?: string): void {
  const store = useProjectStore();
  const index = requireClipWithTakes(store, clipId);
  const clip = store.clips[index];
  const selection = sanitizeCompSegments(
    clip.compSegments ?? [{ startPpq: 0, takeIndex: 0 }],
    (clip.takes as ClipTake[]).length,
    clip.lengthPpq,
  );
  if (bakedAssetId === undefined && selection.length > 1) {
    throw new RangeError(
      `Clip ${clipId} has a multi-segment comp; bake it before dropping its takes`,
    );
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const next: EditorClip = { ...entry };
      if (bakedAssetId !== undefined) {
        next.assetId = bakedAssetId;
      }
      delete next.takes;
      delete next.compSegments;
      return next;
    });
    store.refresh();
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

/**
 * Sets (or clears with null) a track's frozen state as one undoable edit.
 * App-metadata only: playback and exports skip the frozen track's own
 * content/strip DSP and play the baked asset instead (see
 * src/project/freeze.ts for the render that produces it).
 *
 * @param trackId Id of the track.
 * @param frozen Baked render reference, or null to unfreeze.
 */
export function setTrackFrozen(trackId: number, frozen: { assetId: string } | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks cannot be frozen (they have no own content)');
  }
  if (frozen !== null && (typeof frozen.assetId !== 'string' || frozen.assetId.length === 0)) {
    throw new RangeError('Frozen assetId must not be empty');
  }
  if ((track.frozen?.assetId ?? null) === (frozen?.assetId ?? null)) return;
  execute(0, () => {
    store.tracks = store.tracks.map((entry) => {
      if (entry.id !== trackId) return entry;
      const next = { ...entry };
      if (frozen === null) delete next.frozen;
      else next.frozen = { assetId: frozen.assetId };
      return next;
    });
    store.refresh();
  });
}

/**
 * Sets (or clears with null) the tempo-follow (warp) state of an audio clip
 * as one undoable edit. Anchors are sanitized (sorted, strictly inside the
 * clip window, strictly increasing source times). App-metadata only; the
 * audio re-bounces through the schedule watcher.
 *
 * @param clipId Id of the audio clip.
 * @param warp New warp state, or null to play at the recorded rate.
 */
export function setClipWarp(clipId: number, warp: ClipWarp | null): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  let next: ClipWarp | undefined;
  if (warp !== null) {
    if (!Number.isFinite(warp.sourceBpm) || warp.sourceBpm <= 0) {
      throw new RangeError(`Warp sourceBpm must be finite and > 0, got ${warp.sourceBpm}`);
    }
    const anchors = sanitizeWarpAnchors(warp.anchors ?? [], clip.lengthPpq);
    next = {
      enabled: warp.enabled,
      sourceBpm: warp.sourceBpm,
      ...(anchors.length > 0 ? { anchors } : {}),
    };
  }
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (next === undefined) delete updated.warp;
      else updated.warp = next;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Replaces one CC automation lane of a MIDI clip as one undoable edit. The
 * points are sanitized (clamped to the clip window and 0-127, sorted, deduped);
 * passing an empty point list removes the lane. CC lanes are app-level metadata
 * baked into the realtime MIDI schedule, so the change is audible on the next
 * sync without a Project edit.
 *
 * @param clipId Id of the MIDI clip.
 * @param controller MIDI controller number (integer, 0-127).
 * @param channel MIDI channel the CC is emitted on (integer, 0-15).
 * @param points Breakpoints (clip-window-relative PPQ + 0-127 value); empty
 *   removes the lane.
 */
export function setClipCcLane(
  clipId: number,
  controller: number,
  channel: number,
  points: ReadonlyArray<ClipCcPoint>,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  if (!isValidController(controller)) {
    throw new RangeError(`CC controller must be an integer in [0, 127], got ${controller}`);
  }
  if (!isValidChannel(channel)) {
    throw new RangeError(`CC channel must be an integer in [0, 15], got ${channel}`);
  }
  const sanitized = sanitizeCcPoints(points, clip.lengthPpq);
  const others = (clip.ccLanes ?? []).filter(
    (lane) => lane.controller !== controller || lane.channel !== channel,
  );
  const nextLanes: ClipCcLane[] =
    sanitized.length > 0 ? [...others, { controller, channel, points: sanitized }] : others;
  nextLanes.sort((a, b) => a.controller - b.controller || a.channel - b.channel);
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (nextLanes.length > 0) updated.ccLanes = nextLanes;
      else delete updated.ccLanes;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Removes a clip as one undoable edit. When the active clip is removed, the
 * first remaining clip of the active track becomes active.
 *
 * @param clipId Id of the clip to remove.
 */
export function deleteClip(clipId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  execute(1, () => {
    project.removeClip(clipId);
    if (store.clipId === clipId) store.clipId = -1;
    store.refresh();
  });
}

/**
 * Renames a clip as one undoable edit. Clip names are app-level metadata
 * (the Project has no clip-name API), so only the mirror changes.
 *
 * @param clipId Id of the clip.
 * @param name New display name (non-empty).
 */
export function renameClip(clipId: number, name: string): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (name.length === 0) throw new RangeError('Clip name must not be empty');
  if (clip.name === name) return;
  execute(0, () => {
    store.clips = store.clips.map((c) => (c.id === clipId ? { ...c, name } : c));
    store.refresh();
  });
}

/**
 * Moves a clip to a new timeline start (and optionally another track) as one
 * undoable edit (delegates to Project.moveClip).
 *
 * @param clipId Id of the clip to move.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newTrackId Optional destination track id.
 */
export function moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (newTrackId !== undefined) requireTrack(store, newTrackId);
  execute(1, () => {
    if (newTrackId === undefined) project.moveClip(clipId, newStartPpq);
    else project.moveClip(clipId, newStartPpq, newTrackId);
    store.refresh();
  });
}

/**
 * Duplicates a clip at a new timeline start on the same track as one undoable
 * edit (delegates to Project.duplicateClip; MIDI content is copied by the
 * Project). The copy inherits the source clip's display name.
 *
 * @param clipId Id of the clip to duplicate.
 * @param newStartPpq Timeline start of the copy in PPQ (>= 0).
 * @returns The stable clip id of the copy.
 */
export function duplicateClip(clipId: number, newStartPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const copyId = project.duplicateClip(clipId, newStartPpq);
    store.refresh();
    store.clips = store.clips.map((c) =>
      c.id === copyId ? withDerivedClipMetadata({ ...c, name }, sourceMeta) : c,
    );
    return copyId;
  });
}

/**
 * Splits a clip at a timeline position as one undoable edit (delegates to
 * Project.splitClip; the Project partitions MIDI content and source offsets).
 * The right half inherits the source clip's display name.
 *
 * @param clipId Id of the clip to split.
 * @param splitPpq Timeline split position, strictly inside the clip.
 * @returns The stable clip id of the right half.
 */
export function splitClip(clipId: number, splitPpq: number): number {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  if (
    !Number.isFinite(splitPpq) ||
    splitPpq <= source.startPpq ||
    splitPpq >= source.startPpq + source.lengthPpq
  ) {
    const end = source.startPpq + source.lengthPpq;
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the clip [${source.startPpq}, ${end}]`,
    );
  }
  const name = source.name;
  const sourceMeta = { ...source };
  return execute(1, () => {
    const rightId = project.splitClip(clipId, splitPpq);
    store.refresh();
    const splitOffsetPpq = splitPpq - source.startPpq;
    store.clips = store.clips.map((c) => {
      if (c.id === clipId) {
        return withDerivedClipMetadata(c, sourceMeta, {
          windowStartPpq: 0,
          windowLengthPpq: c.lengthPpq,
        });
      }
      if (c.id === rightId) {
        return withDerivedClipMetadata({ ...c, name }, sourceMeta, {
          windowStartPpq: splitOffsetPpq,
          windowLengthPpq: c.lengthPpq,
        });
      }
      return c;
    });
    return rightId;
  });
}

/**
 * Trims a clip's timeline start and length as one undoable edit (delegates to
 * Project.trimClip; the Project adjusts the source offset accordingly).
 *
 * @param clipId Id of the clip to trim.
 * @param newStartPpq New timeline start in PPQ (>= 0).
 * @param newLengthPpq New length in PPQ (> 0).
 */
export function trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void {
  const store = useProjectStore();
  const project = getProject();
  const source = requireClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (!Number.isFinite(newLengthPpq) || newLengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${newLengthPpq}`);
  }
  const sourceMeta = { ...source };
  execute(1, () => {
    project.trimClip(clipId, newStartPpq, newLengthPpq);
    store.refresh();
    const windowStartPpq = newStartPpq - source.startPpq;
    store.clips = store.clips.map((c) =>
      c.id === clipId
        ? withDerivedClipMetadata(c, sourceMeta, {
            windowStartPpq,
            windowLengthPpq: c.lengthPpq,
          })
        : c,
    );
  });
}

/**
 * Sets a clip's loop mode and loop length as one undoable edit (delegates to
 * Project.setClipLoop).
 *
 * @param clipId Id of the clip.
 * @param loopEnabled True to loop the clip window.
 * @param loopLengthPpq Loop length in PPQ (> 0); defaults to the clip length.
 */
export function setClipLoop(clipId: number, loopEnabled: boolean, loopLengthPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  const clip = requireClip(store, clipId);
  if (loopLengthPpq !== undefined && (!Number.isFinite(loopLengthPpq) || loopLengthPpq <= 0)) {
    throw new RangeError(`Loop length must be finite and > 0, got ${loopLengthPpq}`);
  }
  execute(1, () => {
    if (loopEnabled) project.setClipLoop(clipId, 'loop', loopLengthPpq ?? clip.lengthPpq);
    else project.setClipLoop(clipId, 'off');
    store.refresh();
  });
}

/**
 * Sets a clip's linear playback gain as one undoable edit (delegates to
 * Project.setClipGain).
 *
 * @param clipId Id of the clip.
 * @param gain New linear gain (finite, >= 0).
 */
export function setClipGain(clipId: number, gain: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  if (!Number.isFinite(gain) || gain < 0) {
    throw new RangeError(`Clip gain must be finite and >= 0, got ${gain}`);
  }
  execute(1, () => {
    project.setClipGain(clipId, gain);
    store.refresh();
  });
}

/**
 * Sets a clip's fade-in/fade-out lengths as one undoable edit (delegates to
 * Project.setClipFade). Pass undefined or 0 to clear a fade. Playback applies
 * fades to audio clips only (src/project/scheduling.ts multiplies the buffer
 * edges); the prerendered MIDI path ignores them.
 *
 * @param clipId Id of the clip.
 * @param fadeInPpq Fade-in length in PPQ (finite, >= 0; 0/undefined = none).
 * @param fadeOutPpq Fade-out length in PPQ (finite, >= 0; 0/undefined = none).
 */
export function setClipFades(clipId: number, fadeInPpq?: number, fadeOutPpq?: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireClip(store, clipId);
  for (const [value, label] of [
    [fadeInPpq, 'Clip fadeInPpq'],
    [fadeOutPpq, 'Clip fadeOutPpq'],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${label} must be finite and >= 0, got ${value}`);
    }
  }
  const fadeIn = fadeInPpq ?? 0;
  const fadeOut = fadeOutPpq ?? 0;
  execute(1, () => {
    project.setClipFade(clipId, { lengthPpq: fadeIn }, { lengthPpq: fadeOut });
    store.refresh();
    // Mirror fallback for bindings that do not serialize fades in toJson():
    // pin the values we just set (0 clears the field).
    store.clips = store.clips.map((c) => {
      if (c.id !== clipId) return c;
      const { fadeInPpq: _oldIn, fadeOutPpq: _oldOut, ...rest } = c;
      return {
        ...rest,
        ...(fadeIn > 0 ? { fadeInPpq: fadeIn } : {}),
        ...(fadeOut > 0 ? { fadeOutPpq: fadeOut } : {}),
      };
    });
  });
}

/**
 * Makes a clip the active piano-roll clip. Editor-only state: not undoable.
 * The active track follows the clip and the note selection is cleared.
 *
 * @param clipId Id of the clip to activate.
 */
export function setActiveClip(clipId: number): void {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (store.clipId === clipId) return;
  store.clipId = clipId;
  store.activeTrackId = clip.trackId;
  store.selection = new Set();
  store.refresh();
}

/**
 * Makes a track the active track. Editor-only state: not undoable. The first
 * clip of the track (by timeline position) becomes the active clip, or no
 * clip when the track is empty.
 *
 * @param trackId Id of the track to activate.
 */
export function setActiveTrack(trackId: number): void {
  const store = useProjectStore();
  requireTrack(store, trackId);
  store.activeTrackId = trackId;
  const first = store.clips.find((clip) => clip.trackId === trackId) ?? null;
  store.clipId = first?.id ?? -1;
  store.selection = new Set();
  store.refresh();
}
