import { downmixToMono } from '@/lib/audio-channels';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { audioAssetUri, type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import {
  type ClipScoreAnnotations,
  projectClipScoreAnnotations,
  remapClipScoreAnnotations,
} from '../annotations';
import { collectReferencedAudioAssetIds } from '../asset-references';
import { ingestAudioBuffer } from '../audio-import';
import { MIN_SLICE_PPQ, quantizeSlices, transientCutsPpq } from '../audio-slice';
import { clipSplitBlockReason, LOOP_CLIP_SPLIT_ERROR } from '../clip-split';
import { audioClipSegments } from '../comping';
import { sanitizeCcPoints, sanitizePitchBendPoints, sanitizePressurePoints } from '../midi-cc';
import type { RawNote } from '../midi-events';
import {
  MAX_LOOP_OCCURRENCES,
  MIN_LOOP_WINDOW_PPQ,
  type ProjectedMidiNote,
  projectMidiNoteOccurrences,
} from '../midi-projection';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { applyAudioClipFades, resampleChannelsLinear, sliceAudioClipWindow } from '../scheduling';
import {
  getAudioSourceId,
  getProject,
  notesToProjectEvents,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { normalizeTempoMap, ppqRangeSamples, ppqToSeconds, secondsToPpq } from '../tempo-map';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  EditorClip,
  TempoSegment,
} from '../types';
import { canTrackContainClip, clipKind, isAudioClip } from '../types';
import {
  clearProjectClipWarp,
  installProjectClipWarp,
  renderWarpedClipSource,
  type WarpRenderFn,
  warpedClipSource,
} from '../warp';
import { moveClipWithin, splitClipWithin, trimClipWithin } from './clips-internal';
import { execute, executeAtomic } from './history';
import {
  requireEditableClip,
  requireEditableTrack,
  validatePpq,
  withDerivedClipMetadata,
} from './utils';

// ---------------------------------------------------------------------------
// Clip structural-editing commands
// ---------------------------------------------------------------------------

/**
 * Removes a clip as one undoable edit. When the active clip is removed, the
 * first remaining clip of the active track becomes active.
 *
 * @param clipId Id of the clip to remove.
 */
export function deleteClip(clipId: number): void {
  const store = useProjectStore();
  const project = getProject();
  requireEditableClip(store, clipId);
  executeAtomic((edit) => {
    clearProjectClipWarp(project, clipId, (mutation) => edit(1, mutation));
    edit(1, () => project.removeClip(clipId));
    const nextAnnotations = { ...store.scoreAnnotations };
    delete nextAnnotations[clipId];
    store.scoreAnnotations = nextAnnotations;
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
  const clip = requireEditableClip(store, clipId);
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
  const clip = requireEditableClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (newTrackId !== undefined) {
    const destination = requireEditableTrack(store, newTrackId);
    if (!canTrackContainClip(destination.kind, clipKind(clip))) {
      throw new RangeError(
        `Cannot move ${clipKind(clip)} clip ${clipId} to ${destination.kind} track ${newTrackId}`,
      );
    }
  }
  execute(1, () => {
    if (newTrackId === undefined) project.moveClip(clipId, newStartPpq);
    else project.moveClip(clipId, newStartPpq, newTrackId);
    store.refresh();
  });
}

/** Moves several clips as one undoable arrangement edit. */
export function moveClips(
  moves: ReadonlyArray<{ clipId: number; newStartPpq: number; newTrackId?: number }>,
): void {
  if (moves.length === 0) return;
  const store = useProjectStore();
  const project = getProject();
  const ids = new Set<number>();
  for (const move of moves) {
    if (ids.has(move.clipId)) throw new RangeError(`Duplicate clip move ${move.clipId}`);
    ids.add(move.clipId);
    const clip = requireEditableClip(store, move.clipId);
    validatePpq(move.newStartPpq, 'Clip startPpq');
    if (move.newTrackId !== undefined) {
      const destination = requireEditableTrack(store, move.newTrackId);
      if (!canTrackContainClip(destination.kind, clipKind(clip))) {
        throw new RangeError(
          `Cannot move ${clipKind(clip)} clip ${move.clipId} to ${destination.kind}`,
        );
      }
    }
  }
  executeAtomic((edit) => {
    for (const move of moves) {
      edit(1, () => {
        if (move.newTrackId === undefined) project.moveClip(move.clipId, move.newStartPpq);
        else project.moveClip(move.clipId, move.newStartPpq, move.newTrackId);
      });
    }
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
  const source = requireEditableClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  const name = source.name;
  const sourceMeta = { ...source };
  return executeAtomic((edit) => {
    const copyId = edit(1, () => project.duplicateClip(clipId, newStartPpq));
    store.refresh();
    store.clips = store.clips.map((c) =>
      c.id === copyId ? withDerivedClipMetadata({ ...c, name }, sourceMeta) : c,
    );
    const copy = store.clips.find((clip) => clip.id === copyId);
    if (copy !== undefined) {
      const copiedAnnotations = remapClipScoreAnnotations(
        store.scoreAnnotations[clipId],
        source.notes,
        copy.notes,
      );
      if (Object.keys(copiedAnnotations).length > 0) {
        store.scoreAnnotations = { ...store.scoreAnnotations, [copyId]: copiedAnnotations };
      }
    }
    if (copy?.warp !== undefined) {
      installProjectClipWarp(
        project,
        copy,
        normalizeTempoMap(store.tempoSegments, store.tempoBpm),
        (mutation) => edit(1, mutation),
      );
    }
    store.clipId = copyId;
    store.activeTrackId = source.trackId;
    store.selection = new Set();
    return copyId;
  });
}

type PpqPoint = { ppq: number };

function clipLoopWindowPpq(clip: EditorClip): number {
  if (!clip.loopEnabled || !(clip.loopLengthPpq > 0)) return clip.lengthPpq;
  return Math.min(clip.lengthPpq, Math.max(clip.loopLengthPpq, MIN_LOOP_WINDOW_PPQ));
}

function clipRepeatOffsets(clip: EditorClip): number[] {
  if (!clip.loopEnabled) return [0];
  const windowPpq = clipLoopWindowPpq(clip);
  if (!Number.isFinite(windowPpq) || windowPpq <= 0) return [0];
  const offsets: number[] = [];
  const repeatCount = Math.min(Math.ceil(clip.lengthPpq / windowPpq), MAX_LOOP_OCCURRENCES);
  for (let occurrence = 0; occurrence < repeatCount; occurrence++) {
    offsets.push(occurrence * windowPpq);
  }
  return offsets.length > 0 ? offsets : [0];
}

function offsetPoints<T extends PpqPoint>(
  points: ReadonlyArray<T> | undefined,
  clip: EditorClip,
  startPpq: number,
): T[] {
  const offset = clip.startPpq - startPpq;
  const windowPpq = clipLoopWindowPpq(clip);
  return clipRepeatOffsets(clip).flatMap((repeatOffset) =>
    (points ?? [])
      .filter((point) => point.ppq >= 0 && point.ppq <= windowPpq)
      .filter((point) => repeatOffset + point.ppq <= clip.lengthPpq)
      .map((point) => ({ ...point, ppq: point.ppq + offset + repeatOffset })),
  );
}

function collectJoinedCcLanes(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ClipCcLane[] | undefined {
  const lanes = new Map<string, ClipCcLane>();
  for (const clip of clips) {
    for (const lane of clip.ccLanes ?? []) {
      const key = `${lane.controller}:${lane.channel}`;
      const current = lanes.get(key) ?? {
        controller: lane.controller,
        channel: lane.channel,
        points: [],
      };
      current.points.push(...offsetPoints(lane.points, clip, startPpq));
      lanes.set(key, current);
    }
  }
  const out = [...lanes.values()]
    .map((lane) => ({
      ...lane,
      points: sanitizeCcPoints(lane.points, lengthPpq),
    }))
    .filter((lane) => lane.points.length > 0)
    .sort((a, b) => a.controller - b.controller || a.channel - b.channel);
  return out.length > 0 ? out : undefined;
}

function collectJoinedPitchBendLanes(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ClipPitchBendLane[] | undefined {
  const lanes = new Map<number, ClipPitchBendLane>();
  for (const clip of clips) {
    for (const lane of clip.pitchBendLanes ?? []) {
      const current = lanes.get(lane.channel) ?? { channel: lane.channel, points: [] };
      current.points.push(...offsetPoints(lane.points, clip, startPpq));
      lanes.set(lane.channel, current);
    }
  }
  const out = [...lanes.values()]
    .map((lane) => ({ ...lane, points: sanitizePitchBendPoints(lane.points, lengthPpq) }))
    .filter((lane) => lane.points.length > 0)
    .sort((a, b) => a.channel - b.channel);
  return out.length > 0 ? out : undefined;
}

function collectJoinedChannelPressureLanes(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ClipChannelPressureLane[] | undefined {
  const lanes = new Map<number, ClipChannelPressureLane>();
  for (const clip of clips) {
    for (const lane of clip.channelPressureLanes ?? []) {
      const current = lanes.get(lane.channel) ?? { channel: lane.channel, points: [] };
      current.points.push(...offsetPoints(lane.points, clip, startPpq));
      lanes.set(lane.channel, current);
    }
  }
  const out = [...lanes.values()]
    .map((lane) => ({ ...lane, points: sanitizePressurePoints(lane.points, lengthPpq) }))
    .filter((lane) => lane.points.length > 0)
    .sort((a, b) => a.channel - b.channel);
  return out.length > 0 ? out : undefined;
}

function collectJoinedProgramChangeLanes(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ClipProgramChangeLane[] | undefined {
  const lanes = new Map<number, ClipProgramChangeLane>();
  for (const clip of clips) {
    for (const lane of clip.programChangeLanes ?? []) {
      const current = lanes.get(lane.channel) ?? { channel: lane.channel, points: [] };
      current.points.push(...offsetPoints(lane.points, clip, startPpq));
      lanes.set(lane.channel, current);
    }
  }
  const out = [...lanes.values()]
    .map((lane) => ({
      ...lane,
      points: lane.points
        .map((point) => ({ ppq: point.ppq, program: Math.round(point.program) }))
        .filter(
          (point) =>
            Number.isFinite(point.ppq) &&
            point.ppq >= 0 &&
            point.ppq <= lengthPpq &&
            Number.isInteger(point.program) &&
            point.program >= 0 &&
            point.program <= 127,
        )
        .sort((a, b) => a.ppq - b.ppq),
    }))
    .filter((lane) => lane.points.length > 0)
    .sort((a, b) => a.channel - b.channel);
  return out.length > 0 ? out : undefined;
}

function collectJoinedPolyPressureLanes(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ClipPolyPressureLane[] | undefined {
  const lanes = new Map<string, ClipPolyPressureLane>();
  for (const clip of clips) {
    for (const lane of clip.polyPressureLanes ?? []) {
      const key = `${lane.channel}:${lane.pitch}`;
      const current = lanes.get(key) ?? { channel: lane.channel, pitch: lane.pitch, points: [] };
      current.points.push(...offsetPoints(lane.points, clip, startPpq));
      lanes.set(key, current);
    }
  }
  const out = [...lanes.values()]
    .map((lane) => ({ ...lane, points: sanitizePressurePoints(lane.points, lengthPpq) }))
    .filter((lane) => lane.points.length > 0)
    .sort((a, b) => a.channel - b.channel || a.pitch - b.pitch);
  return out.length > 0 ? out : undefined;
}

function joinedNoteOccurrences(
  clips: readonly EditorClip[],
  startPpq: number,
  lengthPpq: number,
): ProjectedMidiNote[] {
  return clips
    .flatMap((clip) =>
      projectMidiNoteOccurrences(clip).map((note) => ({
        ...note,
        startPpq: note.startPpq - startPpq,
        durationPpq: Math.min(note.durationPpq, lengthPpq - (note.startPpq - startPpq)),
      })),
    )
    .filter((note) => note.startPpq >= 0 && note.startPpq < lengthPpq && note.durationPpq > 0)
    .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
}

function joinedNotes(occurrences: ReadonlyArray<ProjectedMidiNote>): RawNote[] {
  return occurrences.map((note) => ({
    pitch: note.pitch,
    velocity: note.velocity,
    ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
  }));
}

function joinedScoreAnnotations(
  occurrences: ReadonlyArray<ProjectedMidiNote>,
  targetNotes: ReadonlyArray<EditorClip['notes'][number]>,
  annotationsByClip: Readonly<Record<number, ClipScoreAnnotations>>,
): ClipScoreAnnotations {
  const projectedNotes: EditorClip['notes'] = [];
  const idsByOccurrence = new Map<string, Map<number, number>>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.sourceIdentity.clipId}:${occurrence.sourceIdentity.occurrence}`;
    let ids = idsByOccurrence.get(key);
    if (ids === undefined) {
      ids = new Map();
      idsByOccurrence.set(key, ids);
    }
    const id = projectedNotes.length + 1;
    ids.set(occurrence.sourceIdentity.noteId, id);
    projectedNotes.push({
      id,
      pitch: occurrence.pitch,
      velocity: occurrence.velocity,
      ...(occurrence.offVelocity !== undefined ? { offVelocity: occurrence.offVelocity } : {}),
      startPpq: occurrence.startPpq,
      durationPpq: occurrence.durationPpq,
      channel: occurrence.channel,
    });
  }

  const projectedAnnotations: ClipScoreAnnotations = {};
  for (const [key, ids] of idsByOccurrence) {
    const clipId = Number(key.slice(0, key.indexOf(':')));
    Object.assign(
      projectedAnnotations,
      projectClipScoreAnnotations(annotationsByClip[clipId], ids),
    );
  }
  return remapClipScoreAnnotations(projectedAnnotations, projectedNotes, targetNotes);
}

/**
 * Glues several MIDI clips on one track into a single consolidated MIDI clip
 * spanning their combined timeline range. Looped clips are flattened into
 * explicit note/expression repeats inside the glued clip.
 *
 * @param clipIds Clip ids to glue. All must be MIDI clips on the same track.
 * @returns The id of the consolidated clip.
 */
export function glueMidiClips(clipIds: ReadonlyArray<number>): number {
  const store = useProjectStore();
  const project = getProject();
  const uniqueIds = [...new Set(clipIds)];
  if (uniqueIds.length < 2) throw new RangeError('At least two clips are required to glue');
  const clips = uniqueIds.map((id) => requireEditableClip(store, id));
  const trackId = clips[0].trackId;
  if (clips.some((clip) => clip.trackId !== trackId)) {
    throw new RangeError('Can only glue clips on the same track');
  }
  if (clips.some((clip) => (clip.kind ?? 'midi') !== 'midi')) {
    throw new RangeError('Can only glue MIDI clips');
  }
  const ordered = [...clips].sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  const startPpq = ordered[0].startPpq;
  const endPpq = Math.max(...ordered.map((clip) => clip.startPpq + clip.lengthPpq));
  const lengthPpq = endPpq - startPpq;
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
    throw new RangeError('Glued clip length must be finite and > 0');
  }
  const occurrences = joinedNoteOccurrences(ordered, startPpq, lengthPpq);
  const notes = joinedNotes(occurrences);
  const name = ordered[0].name;
  return executeAtomic((edit) => {
    // Project.addClip registers a backing source and the clip itself, which are
    // two entries on the Project history (matching addMidiClip's execute(2)).
    const newClipId = edit(2, () =>
      project.addClip({ trackId, isMidi: true, startPpq, lengthPpq }),
    );
    edit(1, () => project.setMidiEvents(newClipId, notesToProjectEvents(notes)));
    for (const id of uniqueIds) edit(1, () => project.removeClip(id));
    store.refresh();
    store.clips = store.clips.map((clip) => {
      if (clip.id !== newClipId) return clip;
      const next: EditorClip = {
        ...clip,
        name,
        sourceOffsetPpq: 0,
        notes: clip.notes,
      };
      const ccLanes = collectJoinedCcLanes(ordered, startPpq, lengthPpq);
      if (ccLanes) next.ccLanes = ccLanes;
      const pitchBendLanes = collectJoinedPitchBendLanes(ordered, startPpq, lengthPpq);
      if (pitchBendLanes) next.pitchBendLanes = pitchBendLanes;
      const programChangeLanes = collectJoinedProgramChangeLanes(ordered, startPpq, lengthPpq);
      if (programChangeLanes) next.programChangeLanes = programChangeLanes;
      const channelPressureLanes = collectJoinedChannelPressureLanes(ordered, startPpq, lengthPpq);
      if (channelPressureLanes) next.channelPressureLanes = channelPressureLanes;
      const polyPressureLanes = collectJoinedPolyPressureLanes(ordered, startPpq, lengthPpq);
      if (polyPressureLanes) next.polyPressureLanes = polyPressureLanes;
      return next;
    });
    const joined = store.clips.find((clip) => clip.id === newClipId);
    const nextAnnotations = { ...store.scoreAnnotations };
    for (const id of uniqueIds) delete nextAnnotations[id];
    if (joined !== undefined) {
      const annotations = joinedScoreAnnotations(occurrences, joined.notes, store.scoreAnnotations);
      if (Object.keys(annotations).length > 0) nextAnnotations[newClipId] = annotations;
    }
    store.scoreAnnotations = nextAnnotations;
    store.clipId = newClipId;
    store.activeTrackId = trackId;
    return newClipId;
  });
}

/** Options for {@link consolidateAudioClips}. */
export interface ConsolidateAudioClipsOptions {
  /** Tempo used to convert PPQ windows to samples; defaults to project tempo. */
  tempoBpm?: number;
  /** Tempo map used by warped clips; defaults to the project tempo map. */
  tempoSegments?: ReadonlyArray<TempoSegment>;
  /** Audio asset loader; defaults to the OPFS asset store. */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Asset ingester; defaults to ingestAudioBuffer without analysis. */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<{ id: string }>;
  /** Warped-clip render override for tests; production renders through the engine. */
  renderWarp?: WarpRenderFn;
}

function consolidateClipToken(clip: EditorClip): string {
  return JSON.stringify({
    id: clip.id,
    trackId: clip.trackId,
    startPpq: clip.startPpq,
    lengthPpq: clip.lengthPpq,
    sourceOffsetPpq: clip.sourceOffsetPpq,
    gain: clip.gain,
    loopEnabled: clip.loopEnabled,
    loopLengthPpq: clip.loopLengthPpq,
    kind: clip.kind,
    assetId: clip.assetId,
    fadeInPpq: clip.fadeInPpq,
    fadeOutPpq: clip.fadeOutPpq,
    takes: clip.takes,
    compSegments: clip.compSegments,
    warp: clip.warp,
  });
}

function consolidateSourceTokens(clips: ReadonlyArray<EditorClip>): Map<number, string> {
  return new Map(clips.map((clip) => [clip.id, consolidateClipToken(clip)]));
}

function areConsolidateSourcesCurrent(
  store: ReturnType<typeof useProjectStore>,
  tokens: ReadonlyMap<number, string>,
): boolean {
  for (const [id, token] of tokens) {
    const current = store.clips.find((clip) => clip.id === id);
    if (current === undefined || consolidateClipToken(current) !== token) return false;
  }
  return true;
}

const consolidateOperations = new OperationGeneration();

function applyLinearGain(channels: Float32Array[], gain: number): Float32Array[] {
  if (gain === 1) return channels;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] *= gain;
  }
  return channels;
}

/**
 * Glues several audio clips on one track into a new rendered asset
 * and replaces them with one audio clip spanning the same timeline range.
 *
 * This pass supports plain, looped, warped and take-comp clips. Clip-level
 * gain and fades are baked into the new asset; gaps between clips become
 * silence.
 *
 * @param clipIds Clip ids to consolidate. All must be audio clips on one track.
 * @param options Test hooks and tempo override.
 * @returns The id of the consolidated clip.
 */
export async function consolidateAudioClips(
  clipIds: ReadonlyArray<number>,
  options: ConsolidateAudioClipsOptions = {},
): Promise<number | null> {
  const store = useProjectStore();
  const project = getProject();
  const uniqueIds = [...new Set(clipIds)];
  if (uniqueIds.length < 2) throw new RangeError('At least two clips are required to consolidate');
  const clips = uniqueIds.map((id) => requireEditableClip(store, id));
  const trackId = clips[0].trackId;
  if (clips.some((clip) => clip.trackId !== trackId)) {
    throw new RangeError('Can only consolidate clips on the same track');
  }
  if (clips.some((clip) => !isAudioClip(clip) || clip.assetId === undefined)) {
    throw new RangeError('Can only consolidate audio clips with assets');
  }
  if (clips.some((clip) => clip.warp?.enabled && (clip.takes?.length ?? 0) > 0)) {
    throw new RangeError('Audio consolidate does not support warped take-comp clips');
  }
  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    throw new RangeError(`Tempo must be finite and > 0, got ${tempoBpm}`);
  }
  const tempoMap = normalizeTempoMap(
    options.tempoSegments ??
      (options.tempoBpm !== undefined ? [{ startPpq: 0, bpm: tempoBpm }] : store.tempoSegments),
    tempoBpm,
  );
  const ordered = [...clips].sort((a, b) => a.startPpq - b.startPpq || a.id - b.id);
  const sourceTokens = consolidateSourceTokens(ordered);
  const targetId = `consolidate:${uniqueIds
    .slice()
    .sort((a, b) => a - b)
    .join(',')}`;
  const currentRevision = (): string | null => {
    if (!areConsolidateSourcesCurrent(store, sourceTokens)) return null;
    const currentTempoBpm = options.tempoBpm ?? store.tempoBpm;
    const currentTempoMap = normalizeTempoMap(
      options.tempoSegments ??
        (options.tempoBpm !== undefined
          ? [{ startPpq: 0, bpm: currentTempoBpm }]
          : store.tempoSegments),
      currentTempoBpm,
    );
    return JSON.stringify({ sources: [...sourceTokens.entries()], tempoMap: currentTempoMap });
  };
  const revision = currentRevision();
  const operation = beginProjectOperation(consolidateOperations, store, targetId, revision);
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(
      consolidateOperations,
      operation,
      store,
      targetId,
      currentRevision(),
    );
  const startPpq = ordered[0].startPpq;
  const endPpq = Math.max(...ordered.map((clip) => clip.startPpq + clip.lengthPpq));
  const lengthPpq = endPpq - startPpq;
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
    throw new RangeError('Consolidated clip length must be finite and > 0');
  }
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const ingest =
    options.ingest ??
    ((channels: Float32Array[], sampleRate: number, name: string) =>
      ingestAudioBuffer(channels, sampleRate, name, { analysis: null }));

  try {
    const rendered: Array<{ offsetFrames: number; channels: Float32Array[] }> = [];
    let sampleRate = 0;
    let channelCount = 0;
    for (const clip of ordered) {
      if ((clip.takes?.length ?? 0) > 0) {
        for (const segment of audioClipSegments(clip, { tempoMap, clipStartPpq: clip.startPpq })) {
          const asset = await loadAudio(segment.assetId);
          assertCurrent();
          const timelineStartPpq = clip.startPpq + segment.offsetPpq;
          if (sampleRate === 0) sampleRate = asset.meta.sampleRate;
          let channels = sliceAudioClipWindow(
            asset.channels,
            asset.meta.sampleRate,
            segment.sourceOffsetPpq,
            segment.lengthPpq,
            tempoMap,
            timelineStartPpq - segment.sourceOffsetPpq,
          );
          channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
          channels = applyAudioClipFades(
            channels,
            sampleRate,
            tempoMap,
            segment.fadeInPpq,
            segment.fadeOutPpq,
            timelineStartPpq,
            segment.lengthPpq,
          );
          channels = applyLinearGain(channels, clip.gain);
          rendered.push({
            offsetFrames: ppqRangeSamples(tempoMap, startPpq, timelineStartPpq, sampleRate),
            channels,
          });
          channelCount = Math.max(channelCount, channels.length);
        }
        continue;
      }
      const asset = await loadAudio(clip.assetId as string);
      assertCurrent();
      if (sampleRate === 0) sampleRate = asset.meta.sampleRate;
      const requestedLoopWindowPpq =
        clip.loopEnabled && Number.isFinite(clip.loopLengthPpq) && clip.loopLengthPpq > 0
          ? clip.loopLengthPpq
          : clip.lengthPpq;
      const loopWindowPpq =
        clip.loopEnabled && requestedLoopWindowPpq < clip.lengthPpq
          ? Math.max(requestedLoopWindowPpq, MIN_LOOP_WINDOW_PPQ)
          : requestedLoopWindowPpq;
      const clipFrames = ppqRangeSamples(
        tempoMap,
        clip.startPpq,
        clip.startPpq + clip.lengthPpq,
        sampleRate,
      );
      let channels: Float32Array[];
      if (clip.warp?.enabled) {
        const warped = warpedClipSource(asset.channels, asset.meta.sampleRate, clip, tempoMap);
        channels = warped
          ? await (options.renderWarp ?? renderWarpedClipSource)(warped, asset.meta.sampleRate)
          : [];
        assertCurrent();
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
      } else if (clip.loopEnabled && loopWindowPpq > 0 && loopWindowPpq < clip.lengthPpq) {
        channels = Array.from(
          { length: Math.max(1, asset.channels.length) },
          () => new Float32Array(clipFrames),
        );
        const repeatCount = Math.min(
          Math.ceil(clip.lengthPpq / loopWindowPpq),
          MAX_LOOP_OCCURRENCES,
        );
        for (let occurrence = 0; occurrence < repeatCount; occurrence++) {
          const offsetPpq = occurrence * loopWindowPpq;
          const segmentLengthPpq = Math.min(loopWindowPpq, clip.lengthPpq - offsetPpq);
          let slice = sliceAudioClipWindow(
            asset.channels,
            asset.meta.sampleRate,
            clip.sourceOffsetPpq,
            segmentLengthPpq,
            tempoMap,
            clip.startPpq + offsetPpq - clip.sourceOffsetPpq,
          );
          slice = resampleChannelsLinear(slice, asset.meta.sampleRate, sampleRate);
          const offsetFrames = ppqRangeSamples(
            tempoMap,
            clip.startPpq,
            clip.startPpq + offsetPpq,
            sampleRate,
          );
          const writable = Math.max(0, Math.min(slice[0]?.length ?? 0, clipFrames - offsetFrames));
          for (let c = 0; c < channels.length; c++) {
            const source = slice[c] ?? slice[0];
            if (source && writable > 0) channels[c].set(source.subarray(0, writable), offsetFrames);
          }
        }
      } else {
        channels = sliceAudioClipWindow(
          asset.channels,
          asset.meta.sampleRate,
          clip.sourceOffsetPpq,
          clip.lengthPpq,
          tempoMap,
          clip.startPpq - clip.sourceOffsetPpq,
        );
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
      }
      channels = applyAudioClipFades(
        channels,
        sampleRate,
        tempoMap,
        clip.fadeInPpq ?? 0,
        clip.fadeOutPpq ?? 0,
        clip.startPpq,
        clip.lengthPpq,
      );
      channels = applyLinearGain(channels, clip.gain);
      rendered.push({
        offsetFrames: ppqRangeSamples(tempoMap, startPpq, clip.startPpq, sampleRate),
        channels,
      });
      channelCount = Math.max(channelCount, channels.length);
    }
    const totalFrames = ppqRangeSamples(tempoMap, startPpq, endPpq, sampleRate);
    const stitched: Float32Array[] = Array.from(
      { length: Math.max(1, channelCount) },
      () => new Float32Array(totalFrames),
    );
    for (const render of rendered) {
      const frames = render.channels[0]?.length ?? 0;
      const writable = Math.max(0, Math.min(frames, totalFrames - render.offsetFrames));
      for (let c = 0; c < stitched.length; c++) {
        const source = render.channels[c] ?? render.channels[0];
        if (!source || writable <= 0) continue;
        // Consolidate renders every source clip into the same timeline.  Clips
        // may overlap, in which case the audible result is their sum rather
        // than whichever source happened to be rendered last.
        const target = stitched[c];
        for (let frame = 0; frame < writable; frame++) {
          target[render.offsetFrames + frame] += source[frame];
        }
      }
    }

    const assets = options.ingest ? null : createAudioAssetTransaction();
    const isReferenced = (assetId: string): boolean =>
      collectReferencedAudioAssetIds(store.clips, store.tracks).has(assetId);
    try {
      const meta = options.ingest
        ? await ingest(stitched, sampleRate, `${ordered[0].name} (consolidated)`)
        : await assets!.save({ name: `${ordered[0].name} (consolidated)`, sampleRate }, stitched);
      assertCurrent();
      const assetId = meta.id;
      const sourceId = getAudioSourceId(assetId);
      let registeredSourceId: number | null = null;
      const newClipId = executeAtomic((edit) => {
        const createdClipId = edit(2, () =>
          project.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            sourceOffsetPpq: 0,
            gain: 1,
            ...placeholderSourceAudio(),
            ...(sourceId === undefined ? { sourceUri: audioAssetUri(assetId) } : {}),
          }),
        );
        if (sourceId === undefined) registeredSourceId = project.sourceCount();
        else edit(1, () => project.setClipSource(createdClipId, sourceId));
        for (const id of uniqueIds) {
          clearProjectClipWarp(project, id, (mutation) => edit(1, mutation));
          edit(1, () => project.removeClip(id));
        }
        store.clips = [
          ...store.clips.filter((clip) => !uniqueIds.includes(clip.id)),
          {
            id: createdClipId,
            trackId,
            name: `${ordered[0].name} (consolidated)`,
            startPpq,
            lengthPpq,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [],
            kind: 'audio',
            assetId,
          },
        ];
        store.refresh();
        store.clipId = createdClipId;
        store.activeTrackId = trackId;
        return createdClipId;
      });
      if (registeredSourceId !== null) setAudioSourceId(assetId, registeredSourceId);
      assets?.commit();
      return newClipId;
    } catch (error) {
      await assets?.rollback(isReferenced);
      throw error;
    }
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return null;
    throw error;
  } finally {
    if (consolidateOperations.isCurrent(operation.token)) consolidateOperations.invalidate();
  }
}

/** Inputs of {@link sliceAudioClipAtTransients}. */
export interface SliceAudioClipOptions {
  /** Move every slice onto the editor grid after cutting. */
  quantize?: boolean;
  /** Grid snap for a timeline position; required to quantize. */
  snap?: (ppq: number) => number;
  /** Asset loader override (tests). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Onset detector override; defaults to the wasm detector. */
  detectOnsets?: (samples: Float32Array, sampleRate: number) => ArrayLike<number>;
}

/**
 * Cuts an audio clip at its transients as one undoable edit, optionally
 * placing the resulting slices on the editor grid.
 *
 * Quantizing moves each slice to its nearest grid position and closes the
 * length up to the next slice, so a loosely played take lines up without gaps
 * or doubled material. A slice is never lengthened past the source material it
 * has left, so a gap can remain where the recording itself ends.
 *
 * @param clipId Editor id of a non-looping audio clip.
 * @param options Quantize behaviour and injectable dependencies.
 * @returns Ids of the resulting slices in timeline order (the original clip
 * first); a single-element array when no usable transient was found.
 */
export async function sliceAudioClipAtTransients(
  clipId: number,
  options: SliceAudioClipOptions = {},
): Promise<number[]> {
  const store = useProjectStore();
  const clip = requireEditableClip(store, clipId);
  if (!isAudioClip(clip) || clip.assetId === undefined) {
    throw new RangeError(`Clip ${clipId} is not an audio clip with an asset`);
  }
  if (clip.loopEnabled) throw new Error(LOOP_CLIP_SPLIT_ERROR);
  const detect =
    options.detectOnsets ??
    (
      (await ensureWasm()) as unknown as {
        detectOnsets?: (samples: Float32Array, sampleRate: number) => ArrayLike<number>;
      }
    ).detectOnsets ??
    null;
  if (detect === null) throw new Error('Onset detection is unavailable in this libsonare build');
  const asset = await (options.loadAudioAsset ?? loadAsset)(clip.assetId);
  const current = requireEditableClip(store, clipId);
  const tempo = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  const cuts = transientCutsPpq(
    detect(downmixToMono(asset.channels), asset.meta.sampleRate),
    current,
    tempo,
  );
  if (cuts.length === 0) return [clipId];

  const sourceStartPpq = current.startPpq - current.sourceOffsetPpq;
  const assetSeconds = asset.meta.numFrames / asset.meta.sampleRate;
  const sourceEndPpq = secondsToPpq(
    tempo,
    ppqToSeconds(tempo, Math.max(0, sourceStartPpq)) + assetSeconds,
  );

  return executeAtomic((edit) => {
    const ids = [clipId];
    let tailId = clipId;
    for (const cutPpq of cuts) {
      tailId = splitClipWithin(edit, tailId, cutPpq);
      ids.push(tailId);
    }
    const snap = options.snap;
    if (options.quantize !== true || snap === undefined) return ids;
    const sliced = ids.map((id) => {
      const slice = store.clips.find((entry) => entry.id === id);
      if (slice === undefined) throw new Error(`Slice ${id} disappeared while slicing`);
      return {
        id,
        startPpq: slice.startPpq,
        lengthPpq: slice.lengthPpq,
        maxLengthPpq: Math.max(MIN_SLICE_PPQ, sourceEndPpq - slice.startPpq),
      };
    });
    const placed = quantizeSlices(sliced, snap);
    for (const [index, target] of placed.entries()) {
      const source = sliced[index];
      if (Math.abs(target.startPpq - source.startPpq) > 1e-9) {
        moveClipWithin(edit, source.id, target.startPpq);
      }
      if (Math.abs(target.lengthPpq - source.lengthPpq) > 1e-9) {
        trimClipWithin(edit, source.id, target.startPpq, target.lengthPpq, true);
      }
    }
    store.refresh();
    return ids;
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
  const source = requireEditableClip(store, clipId);
  const blocked = clipSplitBlockReason(source, splitPpq);
  if (blocked === 'loop') throw new Error(LOOP_CLIP_SPLIT_ERROR);
  if (blocked === 'position') {
    const end = source.startPpq + source.lengthPpq;
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the clip [${source.startPpq}, ${end}]`,
    );
  }
  return executeAtomic((edit) => splitClipWithin(edit, clipId, splitPpq));
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
  requireEditableClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (!Number.isFinite(newLengthPpq) || newLengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${newLengthPpq}`);
  }
  executeAtomic((edit) => trimClipWithin(edit, clipId, newStartPpq, newLengthPpq, true));
}
