import { sectionsFromArrangement } from '@/compose/sections';
import { OperationGeneration } from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { remapClipScoreAnnotations } from '../annotations';
import { analyzeAudioClipSections } from '../audio-sections';
import { type AutomationLaneState, automationLaneKey } from '../automation';
import { type EditorChordSymbol, toProjectChordSymbols } from '../chords';
import { clipSplitBlockReason, LOOP_CLIP_SPLIT_ERROR } from '../clip-split';
import { projectMidiNoteOccurrences } from '../midi-projection';
import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  StaleProjectOperationError,
} from '../operation';
import { allocateMarkerId, allocateSectionId, getProject, useProjectStore } from '../store';
import { normalizeTempoMap } from '../tempo-map';
import {
  deleteAutomationLanes,
  deleteChordSymbols,
  deleteMarkers,
  deleteSections,
  deleteTimelineSegments,
  duplicateChordSymbols,
  insertAutomationLanes,
  insertChordSymbols,
  insertMarkers,
  insertSections,
  insertTimelineSegments,
  validateTimelineRange,
} from '../timeline-edit';
import {
  clipKind,
  DEFAULT_SECTION_COLOR,
  type EditorClip,
  type TempoSegment,
  type TimeSignatureSegment,
  TRACK_COLOR_PALETTE,
} from '../types';
import { clearProjectClipWarp, installProjectClipWarp } from '../warp';
import { audioAnalysisSourceRevision } from './audio-analysis-source';
import { type LaneMove, moveClipsWithin } from './clip-lane';
import {
  moveClipWithin,
  removeClipWithin,
  splitClipWithin,
  trimClipWithin,
} from './clips-internal';
import { type AtomicProjectEdit, execute, executeAtomic } from './history';
import { requireClip, requireEditableClip, validatePpq, withDerivedClipMetadata } from './utils';

const sectionAnalysisOperations = new OperationGeneration();

function tempoSegmentChanged(
  current: ReadonlyArray<TempoSegment>,
  next: ReadonlyArray<TempoSegment>,
): boolean {
  if (current.length !== next.length) return true;
  return next.some((segment, index) => {
    const existing = current[index];
    return (
      existing.startPpq !== segment.startPpq ||
      existing.bpm !== segment.bpm ||
      (existing.endBpm ?? 0) !== (segment.endBpm ?? 0)
    );
  });
}

/** Rejects frozen clips and looped clips that would need structural splitting. */
function validateRippleClips(
  clips: ReadonlyArray<EditorClip>,
  splitPositions: (clip: EditorClip) => ReadonlyArray<number>,
): void {
  const store = useProjectStore();
  for (const clip of clips) {
    requireEditableClip(store, clip.id);
    for (const splitPpq of splitPositions(clip)) {
      if (clipSplitBlockReason(clip, splitPpq) === 'loop') throw new Error(LOOP_CLIP_SPLIT_ERROR);
    }
  }
}

/** Commits app-owned timeline metadata after native clip operations. */
function applyTimelineMetadata(
  edit: AtomicProjectEdit,
  mode: 'insert' | 'delete',
  firstPpq: number,
  secondPpq: number,
): void {
  const store = useProjectStore();
  const project = getProject();
  const lengthPpq = mode === 'insert' ? secondPpq : secondPpq - firstPpq;
  if (mode === 'insert') {
    store.markers = insertMarkers(store.markers, firstPpq, lengthPpq);
    store.sections = insertSections(store.sections, firstPpq, lengthPpq);
    store.automationLanes = insertAutomationLanes(store.automationLanes, firstPpq, lengthPpq);
    store.tempoSegments = insertTimelineSegments(store.tempoSegments, firstPpq, lengthPpq);
    store.timeSignatures = insertTimelineSegments(store.timeSignatures, firstPpq, lengthPpq);
  } else {
    store.markers = deleteMarkers(store.markers, firstPpq, secondPpq);
    store.sections = deleteSections(store.sections, firstPpq, secondPpq);
    store.automationLanes = deleteAutomationLanes(store.automationLanes, firstPpq, secondPpq);
    store.tempoSegments = deleteTimelineSegments(store.tempoSegments, firstPpq, secondPpq);
    store.timeSignatures = deleteTimelineSegments(store.timeSignatures, firstPpq, secondPpq);
  }
  store.markers.sort((a, b) => a.ppq - b.ppq || a.id - b.id);
  store.sections.sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq || a.id - b.id);
  if (store.tempoSegments.length > 0) {
    edit(1, () =>
      project.setTempoSegments(
        store.tempoSegments.map((segment) => ({
          startPpq: segment.startPpq,
          bpm: segment.bpm,
          endBpm: segment.endBpm ?? 0,
        })),
      ),
    );
  }
  if (store.timeSignatures.length > 0) {
    edit(1, () =>
      project.setTimeSignatures(
        store.timeSignatures.map((segment) => ({
          startPpq: segment.startPpq,
          numerator: segment.numerator,
          denominator: segment.denominator,
        })),
      ),
    );
  }
  store.tracks = store.tracks.map((track) => {
    if (track.frozen === undefined) return track;
    const next = { ...track };
    delete next.frozen;
    return next;
  });
}

/** Writes the transformed chord track inside the surrounding atomic edit. */
function applyChordTimeline(
  edit: AtomicProjectEdit,
  chords: ReadonlyArray<EditorChordSymbol>,
): void {
  const store = useProjectStore();
  // Keep chord-less projects chord-less. When a track exists, annotate once so
  // the native Project undo entry stays in the same atomic ripple operation.
  if (store.chords.length === 0 && chords.length === 0) return;
  edit(1, () => getProject().annotateChords(toProjectChordSymbols(chords)));
  // Omissions are app-side hints because the native annotation encoding has no
  // field for them; pass the transformed symbols through every ripple refresh.
  store.refresh(undefined, chords);
}

/** Rebuilds every native warp map after clip starts and the tempo map move together. */
function reinstallTimelineWarps(edit: AtomicProjectEdit): void {
  const store = useProjectStore();
  const project = getProject();
  const tempo = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  for (const clip of store.clips) {
    if (clip.warp === undefined) continue;
    installProjectClipWarp(project, clip, tempo, (mutation) => edit(1, mutation));
  }
}

/** Appends the source-window automation points after an inserted copy of that window. */
function duplicateAutomationWindow(
  lanes: ReadonlyArray<AutomationLaneState>,
  sourceLanes: ReadonlyArray<AutomationLaneState>,
  startPpq: number,
  endPpq: number,
): AutomationLaneState[] {
  const lengthPpq = endPpq - startPpq;
  const sourceByKey = new Map(
    sourceLanes.map((lane) => [automationLaneKey(lane.target, lane.param), lane]),
  );
  return lanes.map((lane) => {
    const source = sourceByKey.get(automationLaneKey(lane.target, lane.param));
    if (!source) return lane;
    const copied = source.points
      .filter((point) => point.ppq >= startPpq && point.ppq < endPpq)
      .map((point) => ({ ...point, ppq: point.ppq + lengthPpq }));
    if (copied.length === 0) return lane;
    return { ...lane, points: [...lane.points, ...copied].sort((a, b) => a.ppq - b.ppq) };
  });
}

/** Restores the source tempo/meter context at the start of a duplicated window. */
function duplicateTimelineMapWindow<T extends TempoSegment | TimeSignatureSegment>(
  segments: ReadonlyArray<T>,
  sourceSegments: ReadonlyArray<T>,
  startPpq: number,
  endPpq: number,
): T[] {
  const lengthPpq = endPpq - startPpq;
  const active = [...sourceSegments].reverse().find((segment) => segment.startPpq <= startPpq);
  const copied = [
    ...(active ? [{ ...active, startPpq: endPpq }] : []),
    ...sourceSegments
      .filter((segment) => segment.startPpq > startPpq && segment.startPpq < endPpq)
      .map((segment) => ({ ...segment, startPpq: segment.startPpq + lengthPpq })),
  ] as T[];
  const byPosition = new Map(segments.map((segment) => [segment.startPpq, { ...segment }]));
  for (const segment of copied) byPosition.set(segment.startPpq, segment);
  return [...byPosition.values()].sort((left, right) => left.startPpq - right.startPpq);
}

/** Duplicates an intersecting clip window into temporary empty timeline space. */
function duplicateClipWindowForTimeline(
  edit: AtomicProjectEdit,
  source: EditorClip,
  windowStartPpq: number,
  windowEndPpq: number,
  parkingStartPpq: number,
): number {
  const store = useProjectStore();
  const project = getProject();
  const windowOffsetPpq = windowStartPpq - source.startPpq;
  const windowLengthPpq = windowEndPpq - windowStartPpq;
  let copyId: number;
  try {
    copyId = edit(1, () => project.duplicateClip(source.id, parkingStartPpq));
  } catch (error) {
    throw new Error(`Could not duplicate ${clipKind(source)} clip ${source.id}: ${String(error)}`);
  }
  // The engine copies the warp link and refuses to trim a warped clip; the
  // copy's own map is reinstalled by the timeline warp pass.
  clearProjectClipWarp(project, copyId, (mutation) => edit(1, mutation));
  edit(1, () => project.trimClip(copyId, parkingStartPpq + windowOffsetPpq, windowLengthPpq));
  store.refresh();
  store.clips = store.clips.map((clip) =>
    clip.id === copyId
      ? withDerivedClipMetadata({ ...clip, name: source.name }, source, {
          windowStartPpq: windowOffsetPpq,
          windowLengthPpq,
        })
      : clip,
  );
  const copy = store.clips.find((clip) => clip.id === copyId);
  if (copy) {
    const annotations = remapClipScoreAnnotations(
      store.scoreAnnotations[source.id],
      source.notes,
      copy.notes,
    );
    if (Object.keys(annotations).length > 0) {
      store.scoreAnnotations = { ...store.scoreAnnotations, [copyId]: annotations };
    }
  }
  return copyId;
}

/**
 * Adds or updates a timeline marker as one undoable edit. Markers are
 * app-level metadata: the Project's setMarker has no matching removal or
 * listing API, so the mirror is authoritative and the Project is not written.
 *
 * @param markerId Id of the marker to update, or null/0 to create one.
 * @param ppq Marker position in PPQ (>= 0).
 * @param name Marker display name.
 * @returns The stable marker id (the new id when one was created).
 */
export function setMarker(markerId: number | null, ppq: number, name: string): number {
  const store = useProjectStore();
  validatePpq(ppq, 'Marker ppq');
  if (markerId !== null && markerId !== 0) {
    const existing = store.markers.find((m) => m.id === markerId);
    if (!existing) throw new RangeError(`Unknown marker id: ${markerId}`);
    // Re-confirming a marker with unchanged fields must not consume an undo
    // slot (or discard the redo stack).
    if (existing.ppq === ppq && existing.name === name) return markerId;
  }
  return execute(0, () => {
    if (markerId === null || markerId === 0) {
      const id = allocateMarkerId();
      store.markers = [...store.markers, { id, ppq, name }].sort(
        (a, b) => a.ppq - b.ppq || a.id - b.id,
      );
      store.refresh();
      return id;
    }
    store.markers = store.markers
      .map((m) => (m.id === markerId ? { ...m, ppq, name } : m))
      .sort((a, b) => a.ppq - b.ppq || a.id - b.id);
    store.refresh();
    return markerId;
  });
}

/**
 * Removes a timeline marker as one undoable edit. Unknown ids are a no-op.
 *
 * @param markerId Id of the marker to remove.
 */
export function removeMarker(markerId: number): void {
  const store = useProjectStore();
  if (!store.markers.some((m) => m.id === markerId)) return;
  execute(0, () => {
    store.markers = store.markers.filter((m) => m.id !== markerId);
    store.refresh();
  });
}

/** Input shape for {@link setSections}; ids are preserved when provided. */
export interface SectionInput {
  /** Existing section id to preserve; omitted = a new id is allocated. */
  id?: number;
  /** Section display name. */
  name: string;
  /** Display color; defaults to the shared section color. */
  color?: string;
  /** Section start in PPQ (>= 0). */
  startPpq: number;
  /** Section end in PPQ (> startPpq). */
  endPpq: number;
}

/**
 * Replaces the section list as one undoable edit. Sections are app-level
 * metadata (the Project has no section API); the list is kept sorted by
 * start position.
 *
 * @param sections New section list; entries with an id keep it.
 */
export function setSections(sections: ReadonlyArray<SectionInput>): void {
  const store = useProjectStore();
  for (const section of sections) {
    validatePpq(section.startPpq, 'Section startPpq');
    if (!Number.isFinite(section.endPpq) || section.endPpq <= section.startPpq) {
      throw new RangeError(
        `Section endPpq must be > startPpq, got [${section.startPpq}, ${section.endPpq}]`,
      );
    }
  }
  execute(0, () => {
    store.sections = sections
      .map((section) => ({
        id: section.id ?? allocateSectionId(),
        name: section.name,
        color: section.color ?? DEFAULT_SECTION_COLOR,
        startPpq: section.startPpq,
        endPpq: section.endPpq,
      }))
      .sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq || a.id - b.id);
    store.refresh();
  });
}

/**
 * Detects song sections from an audio clip with libsonare's `analyzeSections`
 * and merges them into the section list (one undoable edit), replacing any
 * existing sections that start within the clip's region so re-running is
 * idempotent. Resolves to 0 when nothing is detected.
 *
 * @param clipId Editor id of an audio clip.
 * @returns The number of sections detected in the clip.
 */
export async function detectSectionsFromAudioClip(clipId: number): Promise<number> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if (clipKind(clip) !== 'audio') {
    throw new RangeError(`Clip ${clipId} is not an audio clip`);
  }
  const targetId = `sections:${clipId}`;
  const operation = beginProjectOperation(
    sectionAnalysisOperations,
    store,
    targetId,
    audioAnalysisSourceRevision(store, clipId),
  );
  const assertCurrent = (): void =>
    assertProjectOperationCurrent(
      sectionAnalysisOperations,
      operation,
      store,
      targetId,
      audioAnalysisSourceRevision(store, clipId),
    );
  try {
    const wasm = await ensureWasm();
    assertCurrent();
    const detected = await analyzeAudioClipSections(
      clip,
      store.tempoBpm,
      {
        loadAudioAsset: loadAsset,
        analyzeSections: wasm.analyzeSections,
        chroma: wasm.chroma,
      },
      store.tempoSegments,
    );
    assertCurrent();
    const clipEnd = clip.startPpq + clip.lengthPpq;
    const kept = store.sections.filter(
      (section) => section.startPpq < clip.startPpq || section.startPpq >= clipEnd,
    );
    setSections([...kept, ...detected]);
    return detected.length;
  } catch (error) {
    if (error instanceof StaleProjectOperationError) return 0;
    throw error;
  } finally {
    if (sectionAnalysisOperations.isCurrent(operation.token)) {
      sectionAnalysisOperations.invalidate();
    }
  }
}

/** The outcome of an arrangement-wide form analysis. */
export interface DetectedSectionSummary {
  /** Number of sections written to the section list. */
  count: number;
  /** Names of the percussion tracks excluded from the analysis. */
  excludedTrackNames: string[];
}

/**
 * Recovers the song form from the written notes of every harmonic track and
 * replaces the section list with it (one undoable edit).
 *
 * This is the symbolic counterpart of {@link detectSectionsFromAudioClip}: that
 * one hears an audio clip and names what it hears (intro, verse, chorus), this
 * one reads the notes across the whole arrangement and reports only which spans
 * restate which, as letters. Sections are therefore named A, B, A' and so on --
 * nothing about a span's function is inferred.
 *
 * The whole list is replaced rather than merged, because the form is a reading
 * of the entire piece and a partial one would contradict itself. Nothing is
 * committed when no section is recovered, so running it on an empty project
 * leaves any hand-authored sections intact.
 *
 * @param unitBars Comparison unit in bars; the inferred hyperbar when omitted.
 * @returns The written section count and the tracks excluded as percussion.
 */
export function detectSectionsFromArrangement(unitBars?: number): DetectedSectionSummary {
  const store = useProjectStore();
  const tracks = store.tracks.map((track) => ({
    track,
    notes: (store.clipsByTrack.get(track.id) ?? []).flatMap(projectMidiNoteOccurrences),
  }));
  const report = sectionsFromArrangement(tracks, store.timeSignatures, unitBars);
  if (report.sections.length === 0) {
    return { count: 0, excludedTrackNames: report.excludedTrackNames };
  }
  setSections(
    report.sections.map((section) => ({
      name: section.label,
      // Restatements of the same material share a color, so the form reads off
      // the section band without comparing letters.
      color: TRACK_COLOR_PALETTE[section.firstOccurrence % TRACK_COLOR_PALETTE.length],
      // A piece opening with a pickup starts before bar one; the section list
      // has no room for negative time, so the opening section starts at zero.
      startPpq: Math.max(0, section.startPpq),
      endPpq: section.endPpq,
    })),
  );
  return { count: report.sections.length, excludedTrackNames: report.excludedTrackNames };
}

/** Sample-rate range the Project accepts, in whole hertz. */
const PROJECT_SAMPLE_RATE_RANGE = { min: 8000, max: 384000 } as const;

/**
 * Changes the project's document sample rate as one undoable edit. Native
 * warp anchors are counted in project samples, so every warp map is rebuilt
 * at the new rate in the same edit.
 *
 * @param sampleRate Whole hertz within {@link PROJECT_SAMPLE_RATE_RANGE}.
 */
export function setProjectSampleRate(sampleRate: number): void {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < PROJECT_SAMPLE_RATE_RANGE.min ||
    sampleRate > PROJECT_SAMPLE_RATE_RANGE.max
  ) {
    throw new RangeError(
      `Sample rate must be a whole number of hertz in [${PROJECT_SAMPLE_RATE_RANGE.min}, ${PROJECT_SAMPLE_RATE_RANGE.max}], got ${sampleRate}`,
    );
  }
  const store = useProjectStore();
  if (store.sampleRate === sampleRate) return;
  const project = getProject();
  executeAtomic((edit) => {
    edit(1, () => project.setSampleRate(sampleRate));
    reinstallTimelineWarps(edit);
    store.refresh();
  });
}

/**
 * Replaces the project's tempo map as one undoable edit (delegates to
 * Project.setTempoSegments).
 *
 * @param segments Non-empty tempo segments sorted by ascending startPpq.
 */
export function setTempoSegments(segments: ReadonlyArray<TempoSegment>): void {
  validateTempoSegments(segments);
  executeAtomic((edit) => applyTempoSegments(edit, segments));
}

/** Throws RangeError unless the map is non-empty, finite (endBpm included) and strictly ascending. */
export function validateTempoSegments(segments: ReadonlyArray<TempoSegment>): void {
  if (segments.length === 0) throw new RangeError('Tempo map must contain at least one segment');
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Tempo segment startPpq');
    if (!Number.isFinite(segment.bpm) || segment.bpm <= 0) {
      throw new RangeError(`Tempo bpm must be finite and > 0, got ${segment.bpm}`);
    }
    // 0 is the engine's "no ramp" value; anything else must be a real tempo.
    if (
      segment.endBpm !== undefined &&
      segment.endBpm !== 0 &&
      (!Number.isFinite(segment.endBpm) || segment.endBpm < 0)
    ) {
      throw new RangeError(`Tempo endBpm must be finite and >= 0, got ${segment.endBpm}`);
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Tempo segments must have strictly ascending startPpq');
    }
  });
}

/**
 * Writes a validated tempo map inside an enclosing atomic edit: the Project
 * map, every warped clip re-installed against it, and frozen renders dropped
 * when the tempo changed.
 */
export function applyTempoSegments(
  edit: AtomicProjectEdit,
  segments: ReadonlyArray<TempoSegment>,
): void {
  const store = useProjectStore();
  const project = getProject();
  const invalidatesFrozenTracks = tempoSegmentChanged(store.tempoSegments, segments);
  edit(1, () =>
    project.setTempoSegments(
      segments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
    ),
  );
  const tempo = normalizeTempoMap(segments);
  for (const clip of store.clips) {
    if (clip.warp === undefined) continue;
    installProjectClipWarp(project, clip, tempo, (mutation) => edit(1, mutation));
  }
  store.refresh();
  if (invalidatesFrozenTracks) {
    store.tracks = store.tracks.map((track) => {
      if (track.frozen === undefined) return track;
      const next = { ...track };
      delete next.frozen;
      return next;
    });
  }
}

/**
 * Replaces the project's time-signature map as one undoable edit (delegates
 * to Project.setTimeSignatures).
 *
 * @param segments Non-empty meter segments sorted by ascending startPpq.
 */
export function setTimeSignatures(segments: ReadonlyArray<TimeSignatureSegment>): void {
  const store = useProjectStore();
  const project = getProject();
  if (segments.length === 0) {
    throw new RangeError('Time-signature map must contain at least one segment');
  }
  segments.forEach((segment, index) => {
    validatePpq(segment.startPpq, 'Time-signature startPpq');
    if (!Number.isInteger(segment.numerator) || segment.numerator < 1) {
      throw new RangeError('Time-signature numerator must be a positive integer');
    }
    if (!Number.isInteger(segment.denominator) || segment.denominator < 1) {
      throw new RangeError('Time-signature denominator must be a positive integer');
    }
    if (index > 0 && segment.startPpq <= segments[index - 1].startPpq) {
      throw new RangeError('Time-signature segments must have strictly ascending startPpq');
    }
  });
  execute(1, () => {
    project.setTimeSignatures(segments.map((s) => ({ ...s })));
    // The wasm Project currently stores only numerator/denominator. Seed the
    // app-side additive groups before refresh so its meter read-back can
    // re-associate them with the matching persisted segment.
    store.timeSignatures = segments.map((segment) => ({
      ...segment,
      ...(segment.grouping !== undefined ? { grouping: [...segment.grouping] } : {}),
    }));
    store.refresh();
  });
}

/**
 * Inserts empty timeline space and ripples all following project content.
 *
 * Clips spanning the boundary are split so their right-hand content moves
 * with the insertion; markers, sections, automation, tempo and meter maps
 * use the same coordinate transform and are committed as one undoable edit.
 */
export function insertTime(atPpq: number, lengthPpq: number): void {
  validatePpq(atPpq, 'Insert position');
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
    throw new RangeError(`Insert lengthPpq must be finite and > 0, got ${lengthPpq}`);
  }
  const store = useProjectStore();
  const clips = store.clips.map((clip) => ({ ...clip }));
  const nextChords = insertChordSymbols(store.chords, atPpq, lengthPpq);
  const impacted = clips.filter(
    (clip) => clip.startPpq >= atPpq || clip.startPpq + clip.lengthPpq > atPpq,
  );
  validateRippleClips(impacted, (clip) =>
    clip.startPpq < atPpq && clip.startPpq + clip.lengthPpq > atPpq ? [atPpq] : [],
  );
  executeAtomic((edit) => {
    const moves: LaneMove[] = [];
    for (const clip of clips) {
      const endPpq = clip.startPpq + clip.lengthPpq;
      if (clip.startPpq >= atPpq) {
        moves.push({ clipId: clip.id, startPpq: clip.startPpq + lengthPpq });
      } else if (endPpq > atPpq) {
        const rightId = splitClipWithin(edit, clip.id, atPpq);
        moves.push({ clipId: rightId, startPpq: atPpq + lengthPpq });
      }
    }
    moveClipsWithin(edit, moves);
    applyTimelineMetadata(edit, 'insert', atPpq, lengthPpq);
    applyChordTimeline(edit, nextChords);
    store.refresh();
    reinstallTimelineWarps(edit);
    store.refresh();
    store.selection = new Set(store.selection);
  });
}

type TimelineStore = ReturnType<typeof useProjectStore>;
type DuplicatedClip = { id: number; targetStartPpq: number };

/** Copies each source clip's window into parking space past the final ripple boundary. */
function parkDuplicatedClipWindows(
  edit: AtomicProjectEdit,
  sourceClips: EditorClip[],
  originalClips: EditorClip[],
  startPpq: number,
  endPpq: number,
): DuplicatedClip[] {
  const lengthPpq = endPpq - startPpq;
  // A normal project disallows overlapping clips. Keep temporary copies past
  // the final ripple boundary, then place their trimmed windows in the gap.
  let parkingStartPpq =
    Math.max(endPpq, ...originalClips.map((clip) => clip.startPpq + clip.lengthPpq)) +
    lengthPpq +
    1;
  return sourceClips.map((source) => {
    const windowStartPpq = Math.max(startPpq, source.startPpq);
    const windowEndPpq = Math.min(endPpq, source.startPpq + source.lengthPpq);
    const parking = parkingStartPpq;
    parkingStartPpq += source.lengthPpq + 1;
    return {
      id: duplicateClipWindowForTimeline(edit, source, windowStartPpq, windowEndPpq, parking),
      targetStartPpq: windowStartPpq + lengthPpq,
    };
  });
}

/** Ripples the original clips right of the window, splitting one that spans its end. */
function rippleClipsPastDuplicatedWindow(
  edit: AtomicProjectEdit,
  originalClips: EditorClip[],
  endPpq: number,
  lengthPpq: number,
): void {
  // Ripple only original clips; temporary copies stay parked until the gap
  // is clear. They are moved into it after the timeline metadata is updated.
  const rippleMoves: LaneMove[] = [];
  for (const clip of originalClips) {
    const end = clip.startPpq + clip.lengthPpq;
    if (clip.startPpq >= endPpq) {
      rippleMoves.push({ clipId: clip.id, startPpq: clip.startPpq + lengthPpq });
    } else if (end > endPpq) {
      const rightId = splitClipWithin(edit, clip.id, endPpq);
      rippleMoves.push({ clipId: rightId, startPpq: endPpq + lengthPpq });
    }
  }
  moveClipsWithin(edit, rippleMoves);
}

/** Adds copies of the window's markers and sections shifted by the window length. */
function duplicateMarkersAndSections(
  store: TimelineStore,
  sourceMarkers: TimelineStore['markers'],
  sourceSections: TimelineStore['sections'],
  startPpq: number,
  endPpq: number,
): void {
  const lengthPpq = endPpq - startPpq;
  store.markers = [
    ...store.markers,
    ...sourceMarkers
      .filter((marker) => marker.ppq >= startPpq && marker.ppq < endPpq)
      .map((marker) => ({ ...marker, id: allocateMarkerId(), ppq: marker.ppq + lengthPpq })),
  ].sort((left, right) => left.ppq - right.ppq || left.id - right.id);
  store.sections = [
    ...store.sections,
    ...sourceSections.flatMap((section) => {
      const copiedStartPpq = Math.max(startPpq, section.startPpq);
      const copiedEndPpq = Math.min(endPpq, section.endPpq);
      return copiedEndPpq > copiedStartPpq
        ? [
            {
              ...section,
              id: allocateSectionId(),
              startPpq: copiedStartPpq + lengthPpq,
              endPpq: copiedEndPpq + lengthPpq,
            },
          ]
        : [];
    }),
  ].sort(
    (left, right) =>
      left.startPpq - right.startPpq || left.endPpq - right.endPpq || left.id - right.id,
  );
}

/** Duplicates the window's tempo and meter segments and pushes both maps to the engine. */
function duplicateTempoAndMeters(
  edit: AtomicProjectEdit,
  store: TimelineStore,
  sourceTempo: TimelineStore['tempoSegments'],
  sourceMeters: TimelineStore['timeSignatures'],
  startPpq: number,
  endPpq: number,
): void {
  store.tempoSegments = duplicateTimelineMapWindow(
    store.tempoSegments,
    sourceTempo,
    startPpq,
    endPpq,
  );
  store.timeSignatures = duplicateTimelineMapWindow(
    store.timeSignatures,
    sourceMeters,
    startPpq,
    endPpq,
  );
  edit(1, () =>
    getProject().setTempoSegments(
      store.tempoSegments.map((segment) => ({
        startPpq: segment.startPpq,
        bpm: segment.bpm,
        endBpm: segment.endBpm ?? 0,
      })),
    ),
  );
  edit(1, () =>
    getProject().setTimeSignatures(
      store.timeSignatures.map((segment) => ({
        startPpq: segment.startPpq,
        numerator: segment.numerator,
        denominator: segment.denominator,
      })),
    ),
  );
}

/** Selects the duplicated clips and focuses the editor on the first copy. */
function selectDuplicatedClips(store: TimelineStore, copies: DuplicatedClip[]): void {
  // Timeline duplication selects the copied clips in the arrangement. Clip
  // ids are not note ids, so never leak them into the active piano-roll
  // selection; the next note command must start with an empty, valid set.
  store.clipSelection = new Set(copies.map((copy) => copy.id));
  store.selection = new Set();
  if (copies[0]) {
    store.clipId = copies[0].id;
    store.activeTrackId = store.clips.find((clip) => clip.id === copies[0]?.id)?.trackId ?? -1;
    // The preceding refresh read the source clip. Refresh once more after
    // moving the editor focus so note edits target the copied clip.
    store.refresh();
    store.selection = new Set();
  }
}

/**
 * Duplicates a timeline window directly after itself, rippling later content
 * right. The copied arrangement includes every clip intersection plus markers,
 * sections, automation and tempo/meter context, and is one undoable operation.
 */
export function duplicateTime(startPpq: number, endPpq: number): void {
  validateTimelineRange(startPpq, endPpq);
  const store = useProjectStore();
  const lengthPpq = endPpq - startPpq;
  const sourceClips = store.clips
    .filter((clip) => clip.startPpq < endPpq && clip.startPpq + clip.lengthPpq > startPpq)
    .map((clip) => ({ ...clip }));
  const originalClips = store.clips.map((clip) => ({ ...clip }));
  const impacted = store.clips.filter(
    (clip) => clip.startPpq >= endPpq || clip.startPpq + clip.lengthPpq > endPpq,
  );
  validateRippleClips(impacted, (clip) =>
    clip.startPpq < endPpq && clip.startPpq + clip.lengthPpq > endPpq ? [endPpq] : [],
  );
  for (const clip of sourceClips) requireEditableClip(store, clip.id);

  const sourceMarkers = store.markers.map((marker) => ({ ...marker }));
  const sourceSections = store.sections.map((section) => ({ ...section }));
  const sourceAutomation = store.automationLanes.map((lane) => ({
    ...lane,
    points: lane.points.map((point) => ({ ...point })),
  }));
  const sourceTempo = store.tempoSegments.map((segment) => ({ ...segment }));
  const sourceMeters = store.timeSignatures.map((segment) => ({
    ...segment,
    ...(segment.grouping ? { grouping: [...segment.grouping] } : {}),
  }));
  const nextChords = duplicateChordSymbols(store.chords, startPpq, endPpq);

  executeAtomic((edit) => {
    const copies = parkDuplicatedClipWindows(edit, sourceClips, originalClips, startPpq, endPpq);
    rippleClipsPastDuplicatedWindow(edit, originalClips, endPpq, lengthPpq);
    applyTimelineMetadata(edit, 'insert', endPpq, lengthPpq);
    duplicateMarkersAndSections(store, sourceMarkers, sourceSections, startPpq, endPpq);
    store.automationLanes = duplicateAutomationWindow(
      store.automationLanes,
      sourceAutomation,
      startPpq,
      endPpq,
    );
    duplicateTempoAndMeters(edit, store, sourceTempo, sourceMeters, startPpq, endPpq);
    moveClipsWithin(
      edit,
      copies.map((copy) => ({ clipId: copy.id, startPpq: copy.targetStartPpq })),
    );
    applyChordTimeline(edit, nextChords);
    store.refresh();
    reinstallTimelineWarps(edit);
    store.refresh();
    selectDuplicatedClips(store, copies);
  });
}

/**
 * Removes a timeline range and ripples following project content left.
 *
 * A clip spanning both boundaries is split into its surviving left/right
 * source windows. The right window is moved to the deletion start, avoiding
 * a false source-contiguous trim that would replay deleted material.
 */
export function deleteTime(startPpq: number, endPpq: number): void {
  validateTimelineRange(startPpq, endPpq);
  const store = useProjectStore();
  const lengthPpq = endPpq - startPpq;
  const clips = store.clips.map((clip) => ({ ...clip }));
  const nextChords = deleteChordSymbols(store.chords, startPpq, endPpq);
  const impacted = clips.filter((clip) => clip.startPpq + clip.lengthPpq > startPpq);
  validateRippleClips(impacted, (clip) => {
    const end = clip.startPpq + clip.lengthPpq;
    return clip.startPpq < startPpq && end > endPpq ? [startPpq] : [];
  });
  executeAtomic((edit) => {
    // Leftward ripple: earlier clips settle first so a later one never lands on them.
    for (const clip of [...clips].sort((a, b) => a.startPpq - b.startPpq)) {
      const clipEndPpq = clip.startPpq + clip.lengthPpq;
      if (clipEndPpq <= startPpq) continue;
      if (clip.startPpq >= endPpq) {
        moveClipWithin(edit, clip.id, clip.startPpq - lengthPpq);
      } else if (clip.startPpq >= startPpq && clipEndPpq <= endPpq) {
        removeClipWithin(edit, clip.id);
      } else if (clip.startPpq < startPpq && clipEndPpq <= endPpq) {
        trimClipWithin(edit, clip.id, clip.startPpq, startPpq - clip.startPpq);
      } else if (clip.startPpq >= startPpq && clipEndPpq > endPpq) {
        trimClipWithin(edit, clip.id, endPpq, clipEndPpq - endPpq);
        moveClipWithin(edit, clip.id, startPpq);
      } else {
        const rightId = splitClipWithin(edit, clip.id, startPpq);
        trimClipWithin(edit, rightId, endPpq, clipEndPpq - endPpq);
        moveClipWithin(edit, rightId, startPpq);
      }
    }
    applyTimelineMetadata(edit, 'delete', startPpq, endPpq);
    applyChordTimeline(edit, nextChords);
    store.refresh();
    reinstallTimelineWarps(edit);
    store.refresh();
    store.selection = new Set(store.selection);
  });
}
