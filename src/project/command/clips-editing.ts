import { OperationGeneration } from '@/lib/operation-generation';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { audioAssetUri, type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import {
  type ClipScoreAnnotations,
  projectClipScoreAnnotations,
  remapClipScoreAnnotations,
} from '../annotations';
import { collectReferencedAudioAssetIds } from '../asset-references';
import { ingestAudioBuffer } from '../audio-import';
import { clipSplitBlockReason, LOOP_CLIP_SPLIT_ERROR } from '../clip-split';
import { audioClipSegments } from '../comping';
import { sanitizeCcPoints, sanitizePitchBendPoints, sanitizePressurePoints } from '../midi-cc';
import type { RawNote } from '../midi-events';
import { type ProjectedMidiNote, projectMidiNoteOccurrences } from '../midi-projection';
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
import { normalizeTempoMap, ppqRangeSamples } from '../tempo-map';
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
  bakeWarpedClip,
  clearProjectClipWarp,
  installProjectClipWarp,
  type StretchFn,
} from '../warp';
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
  return clip.loopEnabled ? clip.loopLengthPpq || clip.lengthPpq : clip.lengthPpq;
}

function clipRepeatOffsets(clip: EditorClip): number[] {
  if (!clip.loopEnabled) return [0];
  const windowPpq = clipLoopWindowPpq(clip);
  if (!Number.isFinite(windowPpq) || windowPpq <= 0) return [0];
  const offsets: number[] = [];
  for (let offset = 0; offset < clip.lengthPpq - 1e-9; offset += windowPpq) {
    offsets.push(offset);
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
      .filter((point) => point.ppq >= 0 && point.ppq < windowPpq)
      .filter((point) => repeatOffset + point.ppq < clip.lengthPpq)
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
  /** Time-stretch implementation override for tests. */
  warpStretch?: StretchFn;
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
        for (const segment of audioClipSegments(clip)) {
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
      const loopWindowPpq =
        clip.loopEnabled && Number.isFinite(clip.loopLengthPpq) && clip.loopLengthPpq > 0
          ? clip.loopLengthPpq
          : clip.lengthPpq;
      const clipFrames = ppqRangeSamples(
        tempoMap,
        clip.startPpq,
        clip.startPpq + clip.lengthPpq,
        sampleRate,
      );
      let channels: Float32Array[];
      if (clip.warp?.enabled) {
        channels = await bakeWarpedClip(asset.channels, asset.meta.sampleRate, clip, tempoMap, {
          cacheKey: clip.assetId,
          stretch: options.warpStretch,
        });
        assertCurrent();
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, sampleRate);
      } else if (clip.loopEnabled && loopWindowPpq > 0 && loopWindowPpq < clip.lengthPpq) {
        channels = Array.from(
          { length: Math.max(1, asset.channels.length) },
          () => new Float32Array(clipFrames),
        );
        for (let offsetPpq = 0; offsetPpq < clip.lengthPpq - 1e-9; offsetPpq += loopWindowPpq) {
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
        stitched[c].set(source.subarray(0, writable), render.offsetFrames);
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
        const createdClipId = edit(sourceId === undefined ? 2 : 3, () => {
          const id = project.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            sourceOffsetPpq: 0,
            gain: 1,
            ...placeholderSourceAudio(),
            ...(sourceId === undefined ? { sourceUri: audioAssetUri(assetId) } : {}),
          });
          if (sourceId === undefined) registeredSourceId = project.sourceCount();
          else project.setClipSource(id, sourceId);
          return id;
        });
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
  const source = requireEditableClip(store, clipId);
  const blocked = clipSplitBlockReason(source, splitPpq);
  if (blocked === 'loop') throw new Error(LOOP_CLIP_SPLIT_ERROR);
  if (blocked === 'position') {
    const end = source.startPpq + source.lengthPpq;
    throw new RangeError(
      `Split position ${splitPpq} must lie strictly inside the clip [${source.startPpq}, ${end}]`,
    );
  }
  const name = source.name;
  const sourceMeta = { ...source };
  return executeAtomic((edit) => {
    const rightId = edit(1, () => project.splitClip(clipId, splitPpq));
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
    const nextAnnotations = { ...store.scoreAnnotations };
    delete nextAnnotations[clipId];
    for (const id of [clipId, rightId]) {
      const derived = store.clips.find((clip) => clip.id === id);
      if (derived === undefined) continue;
      const annotations = remapClipScoreAnnotations(
        store.scoreAnnotations[clipId],
        source.notes,
        derived.notes,
      );
      if (Object.keys(annotations).length > 0) nextAnnotations[id] = annotations;
    }
    store.scoreAnnotations = nextAnnotations;
    const tempo = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
    for (const id of [clipId, rightId]) {
      const derived = store.clips.find((clip) => clip.id === id);
      if (derived?.warp !== undefined) {
        installProjectClipWarp(project, derived, tempo, (mutation) => edit(1, mutation));
      }
    }
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
  const source = requireEditableClip(store, clipId);
  validatePpq(newStartPpq, 'Clip startPpq');
  if (!Number.isFinite(newLengthPpq) || newLengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${newLengthPpq}`);
  }
  const sourceMeta = { ...source };
  executeAtomic((edit) => {
    edit(1, () => project.trimClip(clipId, newStartPpq, newLengthPpq));
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
    const trimmed = store.clips.find((clip) => clip.id === clipId);
    if (trimmed?.warp !== undefined) {
      installProjectClipWarp(
        project,
        trimmed,
        normalizeTempoMap(store.tempoSegments, store.tempoBpm),
        (mutation) => edit(1, mutation),
      );
    }
  });
}
