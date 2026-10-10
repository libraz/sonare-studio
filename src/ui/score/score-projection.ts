import { harmonicTracksOnly } from '@/compose/tracks';
import { DEFAULT_DIVISIONS, type NotatedScore } from '@/notation/model';
import { quantizeToScore, type ScoreInputNote } from '@/notation/quantize';
import type { ScoreAnnotations, ScoreNoteAnnotation } from '@/project/annotations';
import {
  type MidiSourceIdentity,
  midiSourceIdentityKey,
  projectMidiNoteOccurrences,
} from '@/project/midi-projection';
import type { useProjectStore } from '@/project/store';
import { clipKind, type EditorClip, type TimeSignatureSegment } from '@/project/types';

export type ProjectStore = ReturnType<typeof useProjectStore>;

/** Zero-based General MIDI percussion channel. */
const GM_PERCUSSION_CHANNEL = 9;

export interface FullScoreBuildOptions {
  divisionPpq: number;
  timeSig: { beats: number; beatUnit: number };
  keyFifths: number;
  clipStartPpq: number;
  clipLengthPpq: number;
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
  pickupLengthPpq?: number;
  displayTransposeSemitones: number;
  grandStaffSplitPitch?: number;
  estimateFingering?: boolean;
}

/** Inputs shared by active-clip and full-arrangement part transcription. */
export interface ScorePartBuildOptions extends FullScoreBuildOptions {
  partId?: string;
  partName: string;
  clef?: 'treble' | 'bass' | 'grand';
}

/**
 * Transcribes one project part. Keeping this as the single quantization path
 * prevents full-score parts from drifting from the active-clip score.
 */
export function buildScorePart(
  notes: ReadonlyArray<ScoreInputNote>,
  options: ScorePartBuildOptions,
): NotatedScore {
  return quantizeToScore(notes, {
    divisionPpq: options.divisionPpq,
    timeSig: { ...options.timeSig },
    keyFifths: options.keyFifths,
    clipStartPpq: options.clipStartPpq,
    clipLengthPpq: options.clipLengthPpq,
    timeSignatures: options.timeSignatures,
    pickupLengthPpq: options.pickupLengthPpq,
    partId: options.partId,
    partName: options.partName,
    clef: options.clef,
    displayTransposeSemitones: options.displayTransposeSemitones,
    grandStaffSplitPitch: options.grandStaffSplitPitch,
    estimateFingering: options.estimateFingering,
  });
}

export interface ScoreProjection {
  annotations: Record<number, ScoreNoteAnnotation>;
  notes: ScoreInputNote[];
  notesByTrack: Map<number, ScoreInputNote[]>;
}

function remapAnnotationTargets(
  annotation: ScoreNoteAnnotation,
  identity: MidiSourceIdentity,
  displayIdBySource: ReadonlyMap<string, number>,
): ScoreNoteAnnotation {
  const targetId = (noteId: number | undefined): number | undefined =>
    noteId === undefined
      ? undefined
      : displayIdBySource.get(midiSourceIdentityKey({ ...identity, noteId }));
  const slurToNoteId = targetId(annotation.slurToNoteId);
  const hairpinToNoteId = targetId(annotation.hairpinToNoteId);
  const lineSpanToNoteId = targetId(annotation.lineSpanToNoteId);
  const lineSpans = annotation.lineSpans
    ?.map((span) => {
      const mapped = targetId(span.lineSpanToNoteId);
      return mapped === undefined ? null : { ...span, lineSpanToNoteId: mapped };
    })
    .filter((span): span is NonNullable<typeof span> => span !== null);
  return {
    ...annotation,
    slurToNoteId,
    hairpinToNoteId,
    lineSpanToNoteId,
    ...(lineSpans ? { lineSpans } : {}),
  };
}

/**
 * The projected notes chord estimation reads: harmonic tracks only, with the
 * percussion channel dropped per track as the arrangement-wide estimate does.
 */
export function chordEstimateNotes(
  store: Pick<ProjectStore, 'tracks'>,
  projection: ScoreProjection,
): ScoreInputNote[] {
  const items = store.tracks.flatMap((track) => {
    const notes = projection.notesByTrack.get(track.id);
    return notes === undefined ? [] : [{ track, notes }];
  });
  return harmonicTracksOnly(items).harmonic.flatMap((item) => item.notes);
}

/** Builds one identity-preserving projected input shared by active/full score. */
export function buildScoreProjection(
  clips: ReadonlyArray<EditorClip>,
  sourceAnnotations: Readonly<ScoreAnnotations> = {},
): ScoreProjection {
  const notes: ScoreInputNote[] = [];
  const notesByTrack = new Map<number, ScoreInputNote[]>();
  const displayIdBySource = new Map<string, number>();
  const sourceByDisplayId = new Map<number, MidiSourceIdentity>();
  for (const clip of clips) {
    if (clipKind(clip) !== 'midi') continue;
    for (const projected of projectMidiNoteOccurrences(clip)) {
      const id = notes.length + 1;
      const { sourceIdentity, ...projectedNote } = projected;
      const scoreNote: ScoreInputNote = {
        ...projectedNote,
        id,
        scoreSourceIdentity: { ...sourceIdentity },
      };
      notes.push(scoreNote);
      const trackNotes = notesByTrack.get(clip.trackId) ?? [];
      trackNotes.push(scoreNote);
      notesByTrack.set(clip.trackId, trackNotes);
      displayIdBySource.set(midiSourceIdentityKey(sourceIdentity), id);
      sourceByDisplayId.set(id, sourceIdentity);
    }
  }
  const annotations: Record<number, ScoreNoteAnnotation> = {};
  for (const [displayId, identity] of sourceByDisplayId) {
    const annotation = sourceAnnotations[identity.clipId]?.[identity.noteId];
    if (!annotation) continue;
    annotations[displayId] = remapAnnotationTargets(annotation, identity, displayIdBySource);
  }
  return { annotations, notes, notesByTrack };
}

/** Builds the same audible, windowed MIDI input used by every Full Score part. */
export function buildFullScoreProjection(
  store: Pick<ProjectStore, 'clips' | 'scoreAnnotations'>,
  clipStartPpq: number,
  clipLengthPpq: number,
): ScoreProjection {
  const windowEnd = clipStartPpq + clipLengthPpq;
  const relevantClips = store.clips.filter(
    (clip) =>
      clipKind(clip) === 'midi' &&
      clip.startPpq < windowEnd &&
      clip.startPpq + clip.lengthPpq > clipStartPpq,
  );
  return buildScoreProjection(relevantClips, store.scoreAnnotations ?? {});
}

/** Maps every emitted Full Score part back to its source MIDI track. */
export function fullScorePartTrackIds(
  store: Pick<ProjectStore, 'tracks' | 'clips' | 'scoreAnnotations'>,
  clipStartPpq: number,
  clipLengthPpq: number,
): number[] {
  const projection = buildFullScoreProjection(store, clipStartPpq, clipLengthPpq);
  return store.tracks
    .filter((track) => track.kind === 'midi')
    .flatMap((track) => {
      const notes = projection.notesByTrack.get(track.id) ?? [];
      const hasPitched = notes.some((note) => note.channel !== GM_PERCUSSION_CHANNEL);
      const hasPercussion = notes.some((note) => note.channel === GM_PERCUSSION_CHANNEL);
      return hasPitched && hasPercussion ? [track.id, track.id] : [track.id];
    });
}

/** Allocates a stable MusicXML part id without colliding with earlier parts. */
function allocateMusicXmlPartId(preferred: string, used: Set<string>): string {
  const base = preferred.trim() || 'P1';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function buildFullScore(
  store: ProjectStore,
  options: FullScoreBuildOptions,
  projection = buildFullScoreProjection(store, options.clipStartPpq, options.clipLengthPpq),
): NotatedScore {
  const usedPartIds = new Set<string>();
  const parts = store.tracks
    .filter((track) => track.kind === 'midi')
    .flatMap((track, index) => {
      const notes = projection.notesByTrack.get(track.id) ?? [];
      const requestedPartId = track.musicXmlPartId?.trim() || `P${index + 1}`;
      const partId = allocateMusicXmlPartId(requestedPartId, usedPartIds);
      const score = buildScorePart(notes, {
        divisionPpq: options.divisionPpq,
        timeSig: options.timeSig,
        keyFifths: options.keyFifths,
        clipStartPpq: options.clipStartPpq,
        clipLengthPpq: options.clipLengthPpq,
        timeSignatures: options.timeSignatures,
        pickupLengthPpq: options.pickupLengthPpq,
        partId,
        partName: track.name || `Track ${index + 1}`,
        displayTransposeSemitones: options.displayTransposeSemitones,
        grandStaffSplitPitch: options.grandStaffSplitPitch,
        estimateFingering: options.estimateFingering,
      });
      const partIds = score.parts.map((_, partIndex) =>
        partIndex === 0
          ? partId
          : allocateMusicXmlPartId(
              partIndex === 1 ? `${partId}-percussion` : `${partId}-${partIndex + 1}`,
              usedPartIds,
            ),
      );
      return score.parts.map((part, partIndex) => ({ ...part, id: partIds[partIndex] }));
    });
  if (parts.length === 0) {
    return buildScorePart([], {
      divisionPpq: options.divisionPpq,
      timeSig: options.timeSig,
      keyFifths: options.keyFifths,
      clipStartPpq: options.clipStartPpq,
      clipLengthPpq: options.clipLengthPpq,
      timeSignatures: options.timeSignatures,
      pickupLengthPpq: options.pickupLengthPpq,
      partName: 'Score',
      displayTransposeSemitones: options.displayTransposeSemitones,
      estimateFingering: options.estimateFingering,
    });
  }
  const score: NotatedScore = {
    parts,
    keyFifths: options.keyFifths,
    divisions: DEFAULT_DIVISIONS,
  };
  if (Object.keys(projection.annotations).length > 0) {
    score.noteAnnotations = projection.annotations;
  }
  return score;
}
