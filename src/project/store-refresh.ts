import { isFiniteNumber } from '@/lib/math';
import { activeTakeIndex } from './comping';
import {
  noteKey,
  pairEventsIntoNotes,
  pairEventsIntoNotesIndexed,
  type RawNote,
  type SerializedMidiEvent,
} from './midi-events';
import { assignMidiLaneFields, cloneMidiLaneFields, copyMidiLaneFields } from './midi-lane-kinds';
import {
  type NativeClipFade,
  type NativeProjectDocument,
  type NativeTrack,
  nativeClipLoops,
} from './native-document';
import {
  type EditorClip,
  type EditorNote,
  type EditorTrack,
  type TempoSegment,
  type TimeSignatureSegment,
  TRACK_COLOR_PALETTE,
} from './types';

/** Reads a clip fade length, or null when the document carries none. */
function serializedFadePpq(fade: NativeClipFade | undefined): number | null {
  return typeof fade?.lengthPpq === 'number' ? fade.lengthPpq : null;
}

/** Builds a default track mirror entry for a track first seen in the Project. */
function defaultTrackMirror(serialized: NativeTrack, index: number): EditorTrack {
  return {
    id: serialized.id,
    name: serialized.name ?? `Track ${index + 1}`,
    color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
    kind: serialized.kind,
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: index,
  };
}

/**
 * Re-associates editor ids onto raw notes by exact content key against the
 * given hints. Notes with no matching hint receive fresh ids from the
 * allocator.
 *
 * @param raw Raw notes recovered from the Project.
 * @param hints Id-annotated notes expected to match the raw content.
 * @param allocateNoteId Allocates a fresh editor note id for unmatched notes.
 */
function assignNoteIds(
  raw: RawNote[],
  hints: ReadonlyArray<EditorNote>,
  allocateNoteId: () => number,
): EditorNote[] {
  const pool = new Map<string, EditorNote[]>();
  for (const hint of hints) {
    const key = noteKey(hint);
    const bucket = pool.get(key) ?? [];
    bucket.push(hint);
    pool.set(key, bucket);
  }
  return raw.map((candidate) => {
    const match = pool.get(noteKey(candidate))?.shift();
    // Prefer the hint's exact field values: durations recovered from the
    // Project are subject to floating-point noise (offPpq - startPpq).
    return match ? { ...match } : { id: allocateNoteId(), ...candidate };
  });
}

/**
 * Id hints for a clip the engine rewrote destructively, expressed as the
 * engine's own event provenance instead of note content.
 *
 * Content keys cannot carry an id across a transform that changes the content —
 * that is exactly what a MIDI-FX bake does. The engine answers with, per output
 * event, the input event it derives from, so the mapping is authoritative even
 * when the transform reorders notes (quantize) or fans one input out into
 * several outputs (harmonize, arpeggiator).
 */
export interface NoteProvenanceHints {
  /** Clip the transform rewrote; other clips fall back to content hints. */
  clipId: number;
  /** Per output event, the index of the input event it derives from (-1 = none). */
  sourceIndex: ArrayLike<number>;
  /** Editor note id per input note-on event index. */
  idByOnEventIndex: ReadonlyMap<number, number>;
}

/**
 * Assigns editor ids from engine provenance: the output note opened by the
 * first output event claiming an input event is that input's note and keeps
 * its id; the remaining fan-out outputs are new notes with fresh ids.
 *
 * @param events Serialized events of the rewritten clip.
 * @param hints Provenance reported by the transform.
 * @param allocateNoteId Allocates a fresh editor note id for new notes.
 */
function assignNoteIdsByProvenance(
  events: ReadonlyArray<SerializedMidiEvent>,
  hints: NoteProvenanceHints,
  allocateNoteId: () => number,
): EditorNote[] {
  const recovered = pairEventsIntoNotesIndexed(events);
  // "First output" is defined in event order, which is not the note order the
  // pairing returns, so the claims are resolved in a separate ordered pass.
  const inherited = new Map<number, number>();
  const claimed = new Set<number>();
  for (const { onEventIndex } of [...recovered].sort((a, b) => a.onEventIndex - b.onEventIndex)) {
    const source = hints.sourceIndex[onEventIndex] ?? -1;
    if (source < 0 || claimed.has(source)) continue;
    const id = hints.idByOnEventIndex.get(source);
    if (id === undefined) continue;
    claimed.add(source);
    inherited.set(onEventIndex, id);
  }
  return recovered.map(({ note, onEventIndex }) => ({
    id: inherited.get(onEventIndex) ?? allocateNoteId(),
    ...note,
  }));
}

/** Per-clip note id hints accepted by {@link refresh}. */
export type NoteIdHints =
  | ReadonlyArray<EditorNote>
  | ReadonlyMap<number, ReadonlyArray<EditorNote>>
  | NoteProvenanceHints;

/** Tempo and meter mirror values parsed from the Project document. */
export interface TempoMeterMirror {
  tempoSegments: TempoSegment[];
  /** First tempo segment BPM when valid, otherwise null (keep the current value). */
  tempoBpm: number | null;
  timeSignatures: TimeSignatureSegment[];
}

/** Parses tempo and meter mirror values from the Project document. */
export function refreshTempoMeter(
  doc: NativeProjectDocument,
  previousTimeSignatures: ReadonlyArray<TimeSignatureSegment> = [],
): TempoMeterMirror {
  const tempoDoc = Array.isArray(doc.tempoSegments) ? doc.tempoSegments : [];
  const tempoSegments = tempoDoc.map((s) => {
    const segment: TempoSegment = { startPpq: s.startPpq, bpm: s.bpm };
    if (typeof s.endBpm === 'number' && s.endBpm > 0) segment.endBpm = s.endBpm;
    return segment;
  });
  const bpm = tempoDoc[0]?.bpm;
  const tempoBpm = isFiniteNumber(bpm) && bpm > 0 ? bpm : null;
  const meterDoc = Array.isArray(doc.timeSignatures) ? doc.timeSignatures : [];
  const groupingByMeter = new Map(
    previousTimeSignatures
      .filter((segment) => segment.grouping !== undefined)
      .map((segment) => [
        `${segment.startPpq}:${segment.numerator}:${segment.denominator}`,
        segment.grouping,
      ]),
  );
  const timeSignatures = meterDoc.map((s) => {
    const segment: TimeSignatureSegment = {
      startPpq: s.startPpq,
      numerator: s.numerator,
      denominator: s.denominator,
    };
    const grouping = groupingByMeter.get(`${s.startPpq}:${s.numerator}:${s.denominator}`);
    if (grouping !== undefined) segment.grouping = [...grouping];
    return segment;
  });
  return { tempoSegments, tempoBpm, timeSignatures };
}

/** Track mirror plus the resulting (id -> display order) index. */
export interface TrackMirrorResult {
  tracks: EditorTrack[];
  trackOrder: Map<number, number>;
}

/**
 * Builds the next track mirror: structure from the Project, app fields and
 * order from the previous mirror; tracks first seen in the Project are
 * appended.
 */
export function buildTrackMirror(
  doc: NativeProjectDocument,
  previousTracks: ReadonlyArray<EditorTrack>,
): TrackMirrorResult {
  const docTracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  const docTrackById = new Map(docTracks.map((t) => [t.id, t]));
  const knownIds = new Set(previousTracks.map((t) => t.id));
  const nextTracks: EditorTrack[] = [];
  for (const previous of previousTracks) {
    const serialized = docTrackById.get(previous.id);
    if (!serialized) continue;
    // Group tracks live as aux tracks in the Project; the app-level 'group'
    // kind survives refresh as long as the Project still reports aux.
    const projectKind = serialized.kind;
    nextTracks.push({
      ...previous,
      name: serialized.name ?? previous.name,
      kind: previous.kind === 'group' && projectKind === 'aux' ? 'group' : projectKind,
    });
  }
  for (const serialized of docTracks) {
    if (!knownIds.has(serialized.id)) {
      nextTracks.push(defaultTrackMirror(serialized, nextTracks.length));
    }
  }
  nextTracks.forEach((track, index) => {
    track.order = index;
  });
  const trackOrder = new Map(nextTracks.map((track, index) => [track.id, index]));
  return { tracks: nextTracks, trackOrder };
}

/**
 * Builds the next clip mirror: structure from the Project, names and app-level
 * metadata from the previous mirror, notes recovered per clip with id hints.
 *
 * @param doc Parsed Project document.
 * @param previousClips Current clip mirror (carries forward app metadata).
 * @param trackOrder Track display order from {@link buildTrackMirror}.
 * @param activeClipId Id of the active clip, for the array-hint path.
 * @param idHints Id-annotated notes expected to match the Project content, or
 *   {@link NoteProvenanceHints} for a clip an engine transform rewrote.
 * @param allocateNoteId Allocates fresh editor note ids for unmatched notes.
 */
export function buildClipMirror(
  doc: NativeProjectDocument,
  previousClips: ReadonlyArray<EditorClip>,
  trackOrder: Map<number, number>,
  activeClipId: number,
  idHints: NoteIdHints | undefined,
  allocateNoteId: () => number,
): EditorClip[] {
  const hintMap = idHints instanceof Map ? idHints : null;
  const activeHints = Array.isArray(idHints) ? idHints : null;
  const provenance =
    idHints !== undefined && !hintMap && !activeHints ? (idHints as NoteProvenanceHints) : null;
  const previousClipById = new Map(previousClips.map((clip) => [clip.id, clip]));
  const docClips = Array.isArray(doc.clips) ? doc.clips : [];
  const nextClips: EditorClip[] = docClips
    .filter((serialized) => trackOrder.has(serialized.trackId))
    .map((serialized) => {
      const previous = previousClipById.get(serialized.id);
      const stored = doc.midiContent?.[String(serialized.id)];
      const events = Array.isArray(stored) ? (stored as SerializedMidiEvent[]) : [];
      const hints =
        hintMap?.get(serialized.id) ??
        (activeHints && serialized.id === activeClipId ? activeHints : null) ??
        previous?.notes ??
        [];
      const entry: EditorClip = {
        id: serialized.id,
        trackId: serialized.trackId,
        name: previous?.name ?? `Clip ${serialized.id}`,
        startPpq: serialized.startPpq,
        lengthPpq: serialized.lengthPpq,
        sourceOffsetPpq: serialized.sourceOffsetPpq ?? 0,
        gain: serialized.gain ?? 1,
        loopEnabled: nativeClipLoops(serialized),
        loopLengthPpq: serialized.loopLengthPpq ?? 0,
        notes:
          provenance?.clipId === serialized.id
            ? assignNoteIdsByProvenance(events, provenance, allocateNoteId)
            : assignNoteIds(pairEventsIntoNotes(events), hints, allocateNoteId),
      };
      // Clip kind and asset reference are app-level mirror metadata (the
      // Project document does not expose them); fade lengths prefer the
      // serialized values when the binding reports them.
      if (previous?.kind !== undefined) entry.kind = previous.kind;
      if (previous?.assetId !== undefined) entry.assetId = previous.assetId;
      if (previous?.externalStemRole !== undefined) {
        entry.externalStemRole = previous.externalStemRole;
      }
      if (previous?.contentHash !== undefined) entry.contentHash = previous.contentHash;
      if (previous?.takes !== undefined) {
        entry.takes = previous.takes.map((take) => ({ ...take }));
        if (previous.compSegments !== undefined) {
          entry.compSegments = previous.compSegments.map((segment) => ({ ...segment }));
        }
      }
      if (previous?.midiTakes !== undefined && previous.midiTakes.length > 0) {
        entry.midiTakes = previous.midiTakes.map((take) => ({
          name: take.name,
          notes: take.notes.map((note) => ({ ...note })),
          ...copyMidiLaneFields(take),
        }));
        entry.midiActiveTakeIndex = activeTakeIndex(
          previous.midiActiveTakeIndex,
          previous.midiTakes.length,
        );
        if (previous.midiCompSegments !== undefined) {
          entry.midiCompSegments = previous.midiCompSegments.map((segment) => ({ ...segment }));
        }
      }
      if (previous?.warp !== undefined) {
        entry.warp = {
          ...previous.warp,
          ...(previous.warp.anchors !== undefined
            ? { anchors: previous.warp.anchors.map((anchor) => ({ ...anchor })) }
            : {}),
        };
      }
      // Lanes are app-level metadata, carried forward across refreshes.
      assignMidiLaneFields(entry, cloneMidiLaneFields(previous ?? {}));
      if (previous?.smfSysEx !== undefined && previous.smfSysEx.length > 0) {
        entry.smfSysEx = previous.smfSysEx.map((packet) => ({
          ...packet,
          data: [...packet.data],
        }));
      }
      const fadeIn = serializedFadePpq(serialized.fadeIn) ?? previous?.fadeInPpq ?? 0;
      if (fadeIn > 0) entry.fadeInPpq = fadeIn;
      const fadeOut = serializedFadePpq(serialized.fadeOut) ?? previous?.fadeOutPpq ?? 0;
      if (fadeOut > 0) entry.fadeOutPpq = fadeOut;
      return entry;
    });
  nextClips.sort(
    (a, b) =>
      (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0) ||
      a.startPpq - b.startPpq ||
      a.id - b.id,
  );
  return nextClips;
}
