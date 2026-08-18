import { cloneCcLanes } from './midi-cc';
import {
  noteKey,
  pairEventsIntoNotes,
  pairEventsIntoNotesIndexed,
  type RawNote,
  type SerializedMidiEvent,
} from './midi-events';
import {
  type EditorClip,
  type EditorNote,
  type EditorTrack,
  type TempoSegment,
  type TimeSignatureSegment,
  TRACK_COLOR_PALETTE,
  type TrackKind,
} from './types';

/** Shape of one serialized tempo segment inside the Project JSON document. */
export interface SerializedTempoSegment {
  start_ppq: number;
  bpm: number;
  end_bpm?: number;
}

/** Shape of one serialized time signature inside the Project JSON document. */
export interface SerializedTimeSignature {
  start_ppq: number;
  numerator: number;
  denominator: number;
}

/** Shape of one serialized track inside the Project JSON document. */
export interface SerializedTrack {
  id: number;
  kind: number;
  name: string;
}

/** Shape of one serialized clip fade (the binding nests length and curve). */
export interface SerializedClipFade {
  length_ppq?: number;
  curve?: number;
}

/** Shape of one serialized clip inside the Project JSON document. */
export interface SerializedClip {
  id: number;
  track_id: number;
  start_ppq: number;
  length_ppq: number;
  source_offset_ppq: number;
  gain: number;
  loop_mode: number;
  loop_length_ppq: number;
  /** Flat fade lengths (older bindings); omitted when not serialized. */
  fade_in_ppq?: number;
  fade_out_ppq?: number;
  /** Nested fade objects (current binding); omitted when not serialized. */
  fade_in?: SerializedClipFade;
  fade_out?: SerializedClipFade;
}

/** Minimal slice of the Project JSON document this store reads. */
export interface SerializedProjectDoc {
  midi_content?: Record<string, unknown>;
  tempo_segments?: SerializedTempoSegment[];
  time_signatures?: SerializedTimeSignature[];
  tracks?: SerializedTrack[];
  clips?: SerializedClip[];
  annotation?: { chords?: unknown };
}

/** Reads a clip fade length from either serialized form, or null. */
function serializedFadePpq(
  flat: number | undefined,
  nested: SerializedClipFade | undefined,
): number | null {
  if (typeof flat === 'number') return flat;
  if (nested && typeof nested.length_ppq === 'number') return nested.length_ppq;
  return null;
}

/** Maps a serialized track-kind ordinal to the string form. */
function trackKindFromOrdinal(kind: number): TrackKind {
  if (kind === 0) return 'audio';
  if (kind === 2) return 'aux';
  return 'midi';
}

/** Builds a default track mirror entry for a track first seen in the Project. */
function defaultTrackMirror(serialized: SerializedTrack, index: number): EditorTrack {
  return {
    id: serialized.id,
    name: serialized.name ?? `Track ${index + 1}`,
    color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
    kind: trackKindFromOrdinal(serialized.kind),
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
  doc: SerializedProjectDoc,
  previousTimeSignatures: ReadonlyArray<TimeSignatureSegment> = [],
): TempoMeterMirror {
  const tempoDoc = Array.isArray(doc.tempo_segments) ? doc.tempo_segments : [];
  const tempoSegments = tempoDoc.map((s) => {
    const segment: TempoSegment = { startPpq: s.start_ppq, bpm: s.bpm };
    if (typeof s.end_bpm === 'number' && s.end_bpm > 0) segment.endBpm = s.end_bpm;
    return segment;
  });
  const bpm = tempoDoc[0]?.bpm;
  const tempoBpm = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  const meterDoc = Array.isArray(doc.time_signatures) ? doc.time_signatures : [];
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
      startPpq: s.start_ppq,
      numerator: s.numerator,
      denominator: s.denominator,
    };
    const grouping = groupingByMeter.get(`${s.start_ppq}:${s.numerator}:${s.denominator}`);
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
  doc: SerializedProjectDoc,
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
    const projectKind = trackKindFromOrdinal(serialized.kind);
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
  doc: SerializedProjectDoc,
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
    .filter((serialized) => trackOrder.has(serialized.track_id))
    .map((serialized) => {
      const previous = previousClipById.get(serialized.id);
      const stored = doc.midi_content?.[String(serialized.id)];
      const events = Array.isArray(stored) ? (stored as SerializedMidiEvent[]) : [];
      const hints =
        hintMap?.get(serialized.id) ??
        (activeHints && serialized.id === activeClipId ? activeHints : null) ??
        previous?.notes ??
        [];
      const entry: EditorClip = {
        id: serialized.id,
        trackId: serialized.track_id,
        name: previous?.name ?? `Clip ${serialized.id}`,
        startPpq: serialized.start_ppq,
        lengthPpq: serialized.length_ppq,
        sourceOffsetPpq: serialized.source_offset_ppq ?? 0,
        gain: serialized.gain ?? 1,
        loopEnabled: serialized.loop_mode === 1,
        loopLengthPpq: serialized.loop_length_ppq ?? 0,
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
          ...(take.ccLanes !== undefined
            ? {
                ccLanes: take.ccLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.pitchBendLanes !== undefined
            ? {
                pitchBendLanes: take.pitchBendLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.programChangeLanes !== undefined
            ? {
                programChangeLanes: take.programChangeLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.channelPressureLanes !== undefined
            ? {
                channelPressureLanes: take.channelPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(take.polyPressureLanes !== undefined
            ? {
                polyPressureLanes: take.polyPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
        }));
        entry.midiActiveTakeIndex = Math.min(
          Math.max(0, previous.midiActiveTakeIndex ?? previous.midiTakes.length - 1),
          previous.midiTakes.length - 1,
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
      // CC lanes are app-level metadata, carried forward across refreshes.
      const ccLanes = cloneCcLanes(previous?.ccLanes);
      if (ccLanes !== undefined) entry.ccLanes = ccLanes;
      if (previous?.pitchBendLanes !== undefined && previous.pitchBendLanes.length > 0) {
        entry.pitchBendLanes = previous.pitchBendLanes.map((lane) => ({
          channel: lane.channel,
          points: lane.points.map((point) => ({ ...point })),
        }));
      }
      if (previous?.programChangeLanes !== undefined && previous.programChangeLanes.length > 0) {
        entry.programChangeLanes = previous.programChangeLanes.map((lane) => ({
          channel: lane.channel,
          points: lane.points.map((point) => ({ ...point })),
        }));
      }
      if (
        previous?.channelPressureLanes !== undefined &&
        previous.channelPressureLanes.length > 0
      ) {
        entry.channelPressureLanes = previous.channelPressureLanes.map((lane) => ({
          channel: lane.channel,
          points: lane.points.map((point) => ({ ...point })),
        }));
      }
      if (previous?.polyPressureLanes !== undefined && previous.polyPressureLanes.length > 0) {
        entry.polyPressureLanes = previous.polyPressureLanes.map((lane) => ({
          channel: lane.channel,
          pitch: lane.pitch,
          points: lane.points.map((point) => ({ ...point })),
        }));
      }
      if (previous?.smfSysEx !== undefined && previous.smfSysEx.length > 0) {
        entry.smfSysEx = previous.smfSysEx.map((packet) => ({
          ...packet,
          data: [...packet.data],
        }));
      }
      const fadeIn =
        serializedFadePpq(serialized.fade_in_ppq, serialized.fade_in) ?? previous?.fadeInPpq ?? 0;
      if (fadeIn > 0) entry.fadeInPpq = fadeIn;
      const fadeOut =
        serializedFadePpq(serialized.fade_out_ppq, serialized.fade_out) ??
        previous?.fadeOutPpq ??
        0;
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
