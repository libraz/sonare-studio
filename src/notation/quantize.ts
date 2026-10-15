/**
 * Display quantizer: editor notes -> notated score.
 *
 * This is the producer side of the notation pipeline. It reads `EditorNote`s
 * (never mutating them — the notation view is a non-destructive, display-only
 * "prettified" rendering) and emits a {@link NotatedScore} for the MusicXML
 * serializer.
 *
 * Pipeline:
 * 1. Grid quantization — note starts and ends snap to the display grid
 *    (`divisionPpq`); minimum duration is one grid step, so notes that would
 *    collapse to zero length are kept at one step rather than dropped.
 *    Notes are clamped to the clip window `[clipStartPpq, clipStartPpq +
 *    clipLengthPpq)`; notes entirely outside it are dropped.
 * 2. Chord clustering — notes with equal quantized start, equal quantized
 *    end, and a pitch span of at most {@link CHORD_PITCH_SPAN} semitones
 *    merge into a single chord event.
 * 3. Voice separation — overlapping units go to different voices (at most
 *    `maxVoices`, default 2). Among simultaneous onsets, higher pitch takes
 *    the lower voice number. When every voice is busy, the overflow unit
 *    merges into the busy voice with the nearest mean pitch.
 * 4. Measure segmentation — units crossing barlines split into tied events.
 * 5. Duration decomposition — durations not representable as a single
 *    {@link NoteValue} split into tied representable values, preferring
 *    splits at beat-group boundaries; dotted values are used when exact.
 * 6. Rest filling — every listed voice covers its measure exactly; gaps are
 *    filled with rests, split at beat-group boundaries for readability.
 *
 * Beaming is intentionally not modeled; the renderer derives beams from the
 * time signature.
 */

import { estimateFingeringForUnits } from '@/notation/fingering';
import { assignGrandStaffUnits } from '@/notation/grand-staff';
import {
  beatGroupPpq,
  DEFAULT_DIVISIONS,
  NOTE_VALUE_BASES,
  type NotatedClef,
  type NotatedEvent,
  type NotatedMeasure,
  type NotatedScore,
  type NotatedTimeSig,
  type NotatedVoice,
  type NotatedVoiceNumber,
  type NoteValue,
  noteValueToPpq,
} from '@/notation/model';
import { GM_PERCUSSION_CHANNEL } from '@/notation/musicxml-percussion';
import { type AssignedVoiceUnits, EPSILON, meanPitch, type VoiceUnit } from '@/notation/voice-unit';
import type { MidiSourceIdentity } from '@/project/midi-projection';
import { clipMeasureGrid } from '@/project/time-signature';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';

export {
  assignGrandStaffUnits,
  splitUnitAcrossStaves,
  staffForMeanPitch,
} from '@/notation/grand-staff';
export type { VoiceUnit } from '@/notation/voice-unit';

/** Editor note accepted by score quantization with optional composite identity. */
export type ScoreInputNote = EditorNote & { scoreSourceIdentity?: MidiSourceIdentity };

/** Duration of a 64th note in PPQ — the finest representable display value. */
const SIXTY_FOURTH_PPQ = 0.0625;

/**
 * Maximum pitch span (in semitones, measured from the highest pitch) for
 * simultaneous equal-duration notes to merge into one chord event.
 */
export const CHORD_PITCH_SPAN = 12;

/** Options controlling a {@link quantizeToScore} call. */
export interface QuantizeOptions {
  /**
   * Display-quantize grid step in PPQ (quarter = 1.0), e.g. 0.25 for a 16th
   * grid or 1/3 for eighth-note triplets. Must be representable by the
   * notation model and integral in the score's MusicXML divisions.
   */
  divisionPpq: number;
  /** Fallback time signature applied when no time-signature map entry is active. */
  timeSig: NotatedTimeSig;
  /** Optional project time-signature map for measure-by-measure meter changes. */
  timeSignatures?: ReadonlyArray<TimeSignatureSegment>;
  /** Key signature as MusicXML fifths (-7..7), passed through to the score. */
  keyFifths: number;
  /**
   * Absolute PPQ position of the first barline (score origin). Notes starting
   * earlier are clamped to this position (or dropped if they end before it).
   */
  clipStartPpq: number;
  /**
   * Length of the notated window in PPQ. When not a multiple of the measure
   * length the final measure is short (incomplete); notes are clamped to the
   * window end.
   */
  clipLengthPpq: number;
  /** Optional short first measure length for an opening anacrusis. */
  pickupLengthPpq?: number;
  /** Maximum simultaneous voices per staff (1-4). Defaults to 2. */
  maxVoices?: number;
  /** MusicXML part id. Defaults to "P1". */
  partId?: string;
  /** Part display name. Defaults to "". */
  partName?: string;
  /**
   * Clef override. When omitted the clef is chosen from the pitch range:
   * bass when the midpoint of [lowest, highest] is below middle C (MIDI 60),
   * treble otherwise (and for empty input).
   */
  clef?: NotatedClef;
  /**
   * Grand-staff split pitch as MIDI note number. Notes/chords with a mean
   * pitch at or above this value use the upper staff; lower ones use the lower
   * staff. Defaults to middle C (60).
   */
  grandStaffSplitPitch?: number;
  /**
   * Display transpose in semitones applied to engraved pitches only (the
   * input notes are never modified — this is a non-destructive view shift).
   * Shifted pitches clamp to the MIDI range 0-127. Defaults to 0.
   */
  displayTransposeSemitones?: number;
  /**
   * When true, estimate piano fingering (1 = thumb .. 5 = pinky) for each note
   * and flag grand-staff hand crosses. Off by default; enabling it never
   * changes note/rest content, only annotates events with
   * {@link NotatedEvent.fingering} and {@link NotatedEvent.handCross}.
   */
  estimateFingering?: boolean;
}

/** A note after grid quantization and clip clamping. */
interface GridNote {
  pitch: number;
  startPpq: number;
  endPpq: number;
  /** MIDI channel from the source note (0-based). */
  channel: number;
  /** Source note-on velocity. */
  velocity: number;
  /** Editor note id, used only as a deterministic sort tiebreaker. */
  id: number;
  sourceIdentity?: MidiSourceIdentity;
}

/** A representable duration slice produced by decomposition. */
interface DurationPiece {
  startPpq: number;
  durationPpq: number;
  value: NoteValue;
}

/** Validated and grid-snapped options. */
interface ResolvedOptions {
  grid: number;
  timeSig: NotatedTimeSig;
  keyFifths: number;
  clipStartPpq: number;
  clipEndPpq: number;
  maxVoices: number;
  partId: string;
  partName: string;
  clef?: NotatedClef;
  grandStaffSplitPitch: number;
  displayTransposeSemitones: number;
  estimateFingering: boolean;
  pickupLengthPpq: number;
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
}

/** All 21 representable note values, longest first, with their PPQ lengths. */
const VALUES_DESC: ReadonlyArray<{ value: NoteValue; ppq: number }> = (() => {
  const all: Array<{ value: NoteValue; ppq: number }> = [];
  for (const base of NOTE_VALUE_BASES) {
    for (const dots of [0, 1, 2] as const) {
      const value: NoteValue = { base, dots };
      all.push({ value, ppq: noteValueToPpq(value) });
    }
    const triplet: NoteValue = { base, dots: 0, tuplet: { actual: 3, normal: 2 } };
    all.push({ value: triplet, ppq: noteValueToPpq(triplet) });
  }
  all.sort((a, b) => b.ppq - a.ppq);
  return all;
})();

/**
 * Binary note values only, longest first.  Tuplets are valid *exact* spellings,
 * but mixing them into greedy fallback can strand an unspellable remainder
 * (for example 11/16 after picking a quarter-note triplet).
 */
const BINARY_VALUES_DESC = VALUES_DESC.filter(({ value }) => value.tuplet === undefined);

/** Tuplet values only, used as a second exact-cover family when binary fails. */
const TUPLET_VALUES_DESC = VALUES_DESC.filter(({ value }) => value.tuplet !== undefined);

/** Returns true when `value` is an integral multiple of `step` within tolerance. */
function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) <= EPSILON;
}

/** Snaps `value` to the nearest integral multiple of `step`. */
function snapToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Returns true when `ppq` is a duration the model can spell directly. */
function isRepresentableDuration(ppq: number): boolean {
  return exactNoteValue(ppq) !== undefined;
}

/** Returns the single exact NoteValue for a duration, or undefined when none matches. */
function exactNoteValue(ppq: number): NoteValue | undefined {
  for (const { value, ppq: valuePpq } of VALUES_DESC) {
    if (Math.abs(ppq - valuePpq) <= EPSILON) {
      return value.tuplet
        ? { base: value.base, dots: value.dots, tuplet: { ...value.tuplet } }
        : { base: value.base, dots: value.dots };
    }
  }
  return undefined;
}

/** Validates raw options and snaps clip bounds to the 64th-note lattice. */
function resolveOptions(options: QuantizeOptions): ResolvedOptions {
  const { divisionPpq, timeSig, keyFifths, clipStartPpq, clipLengthPpq } = options;
  if (
    !Number.isFinite(divisionPpq) ||
    divisionPpq < SIXTY_FOURTH_PPQ - EPSILON ||
    Math.abs(divisionPpq * DEFAULT_DIVISIONS - Math.round(divisionPpq * DEFAULT_DIVISIONS)) >
      EPSILON ||
    (!isMultipleOf(divisionPpq, SIXTY_FOURTH_PPQ) && !isRepresentableDuration(divisionPpq))
  ) {
    throw new RangeError(
      `quantizeToScore: divisionPpq must be a representable grid >= ${SIXTY_FOURTH_PPQ} PPQ, got ${divisionPpq}`,
    );
  }
  if (!Number.isInteger(timeSig.beats) || timeSig.beats < 1) {
    throw new RangeError(
      `quantizeToScore: timeSig.beats must be a positive integer, got ${timeSig.beats}`,
    );
  }
  if (![1, 2, 4, 8, 16, 32, 64].includes(timeSig.beatUnit)) {
    throw new RangeError(
      `quantizeToScore: timeSig.beatUnit must be a power of two from 1 to 64, got ${timeSig.beatUnit}`,
    );
  }
  if (!Number.isInteger(keyFifths) || keyFifths < -7 || keyFifths > 7) {
    throw new RangeError(
      `quantizeToScore: keyFifths must be an integer in -7..7, got ${keyFifths}`,
    );
  }
  if (!Number.isFinite(clipStartPpq) || clipStartPpq < 0) {
    throw new RangeError(
      `quantizeToScore: clipStartPpq must be finite and >= 0, got ${clipStartPpq}`,
    );
  }
  if (!Number.isFinite(clipLengthPpq) || clipLengthPpq <= 0) {
    throw new RangeError(
      `quantizeToScore: clipLengthPpq must be finite and > 0, got ${clipLengthPpq}`,
    );
  }
  const maxVoices = options.maxVoices ?? 2;
  if (!Number.isInteger(maxVoices) || maxVoices < 1 || maxVoices > 4) {
    throw new RangeError(`quantizeToScore: maxVoices must be an integer in 1..4, got ${maxVoices}`);
  }
  const displayTransposeSemitones = options.displayTransposeSemitones ?? 0;
  if (!Number.isInteger(displayTransposeSemitones)) {
    throw new RangeError(
      `quantizeToScore: displayTransposeSemitones must be an integer, got ${displayTransposeSemitones}`,
    );
  }
  const grandStaffSplitPitch = options.grandStaffSplitPitch ?? 60;
  if (
    !Number.isInteger(grandStaffSplitPitch) ||
    grandStaffSplitPitch < 0 ||
    grandStaffSplitPitch > 127
  ) {
    throw new RangeError(
      `quantizeToScore: grandStaffSplitPitch must be an integer in 0..127, got ${grandStaffSplitPitch}`,
    );
  }
  const grid = isMultipleOf(divisionPpq, SIXTY_FOURTH_PPQ)
    ? snapToStep(divisionPpq, SIXTY_FOURTH_PPQ)
    : divisionPpq;
  const start = snapToStep(clipStartPpq, SIXTY_FOURTH_PPQ);
  // The display grid governs every engraved boundary.  Keeping the clip end
  // only on the 64th lattice can leave a sub-grid tail after a triplet pickup,
  // which no note value can cover.
  const length = snapToStep(clipLengthPpq, grid);
  if (length <= 0) {
    throw new RangeError(
      `quantizeToScore: clipLengthPpq rounds to zero on the 64th-note lattice, got ${clipLengthPpq}`,
    );
  }
  return {
    grid,
    timeSig: { beats: timeSig.beats, beatUnit: timeSig.beatUnit },
    keyFifths,
    clipStartPpq: start,
    clipEndPpq: start + length,
    maxVoices,
    partId: options.partId ?? 'P1',
    partName: options.partName ?? '',
    clef: options.clef,
    grandStaffSplitPitch,
    displayTransposeSemitones,
    estimateFingering: options.estimateFingering ?? false,
    pickupLengthPpq:
      Number.isFinite(options.pickupLengthPpq) && (options.pickupLengthPpq ?? 0) > 0
        ? Math.min(length, snapToStep(options.pickupLengthPpq ?? 0, grid))
        : 0,
    timeSignatures: options.timeSignatures ?? [],
  };
}

/**
 * Pipeline step 1: snap note starts/ends to the display grid (anchored at the
 * clip start so the grid aligns with barlines) and clamp to the clip window.
 *
 * Zero-length results are kept at one grid step (minimum duration) rather
 * than dropped, so very short notes stay visible in the score. Notes wholly
 * outside the clip are dropped. The input is never mutated.
 */
function quantizeToGrid(notes: readonly ScoreInputNote[], opts: ResolvedOptions): GridNote[] {
  const { grid, clipStartPpq: cs, clipEndPpq: ce, displayTransposeSemitones: shift } = opts;
  const out: GridNote[] = [];
  for (const note of notes) {
    let start = cs + snapToStep(note.startPpq - cs, grid);
    let end = cs + snapToStep(note.startPpq + note.durationPpq - cs, grid);
    if (end - start < grid - EPSILON) {
      end = start + grid; // Minimum duration: one grid step.
    }
    if (start < cs - EPSILON) {
      if (end <= cs + EPSILON) continue; // Ends before the clip: drop.
      start = cs; // Starts before the clip but sounds into it: clamp.
    }
    if (start >= ce - EPSILON) continue; // Starts at/after the clip end: drop.
    if (end > ce + EPSILON) end = ce; // Sounds past the clip end: clamp.
    if (end - start <= EPSILON) continue;
    // Display transpose shifts the engraved pitch only; the input is untouched.
    const pitch = Math.min(127, Math.max(0, note.pitch + shift));
    out.push({
      pitch,
      startPpq: start,
      endPpq: end,
      channel: note.channel,
      velocity: note.velocity,
      id: note.id,
      ...(note.scoreSourceIdentity ? { sourceIdentity: { ...note.scoreSourceIdentity } } : {}),
    });
  }
  // Deterministic order: onset, then higher pitch first, then editor id.
  out.sort((a, b) => a.startPpq - b.startPpq || b.pitch - a.pitch || a.id - b.id);
  return out;
}

/**
 * Pipeline step 2: merge simultaneous notes into chords.
 *
 * Notes merge when they share the same quantized start AND end and lie within
 * {@link CHORD_PITCH_SPAN} semitones below the cluster's highest pitch.
 * Clustering is greedy from the top pitch down, so the result is
 * deterministic. Duplicate pitches (e.g. the same note on two channels)
 * deduplicate. Units keep onset order; simultaneous units stay ordered by
 * descending top pitch (consumed by voice assignment).
 */
function clusterChords(notes: GridNote[]): VoiceUnit[] {
  const units: VoiceUnit[] = [];
  let i = 0;
  while (i < notes.length) {
    let j = i;
    while (j < notes.length && Math.abs(notes[j].startPpq - notes[i].startPpq) <= EPSILON) j++;
    const group = notes.slice(i, j); // Sorted by descending pitch.
    const used = new Array<boolean>(group.length).fill(false);
    for (let a = 0; a < group.length; a++) {
      if (used[a]) continue;
      const top = group[a];
      const pitches = new Set<number>([top.pitch]);
      const channels = new Set<number>([top.channel]);
      const ids = new Set<number>([top.id]);
      const sourceIdentities: MidiSourceIdentity[] = top.sourceIdentity
        ? [{ ...top.sourceIdentity }]
        : [];
      let velocity = top.velocity;
      used[a] = true;
      for (let b = a + 1; b < group.length; b++) {
        if (used[b]) continue;
        if (
          Math.abs(group[b].endPpq - top.endPpq) <= EPSILON &&
          top.pitch - group[b].pitch <= CHORD_PITCH_SPAN &&
          canClusterTogether(top, group[b])
        ) {
          pitches.add(group[b].pitch);
          channels.add(group[b].channel);
          ids.add(group[b].id);
          const sourceIdentity = group[b].sourceIdentity;
          if (sourceIdentity) sourceIdentities.push({ ...sourceIdentity });
          velocity = Math.max(velocity, group[b].velocity);
          used[b] = true;
        }
      }
      units.push({
        pitches: [...pitches].sort((x, y) => x - y),
        startPpq: top.startPpq,
        endPpq: top.endPpq,
        channels: [...channels].sort((x, y) => x - y),
        velocity,
        ids: [...ids].sort((x, y) => x - y),
        sourceIdentities,
      });
    }
    i = j;
  }
  return units;
}

/** Returns true when simultaneous notes should share one chord event. */
function canClusterTogether(a: GridNote, b: GridNote): boolean {
  if (a.channel !== b.channel) {
    // MusicXML instrument/channel metadata is event-scoped. Keeping channels
    // in separate units prevents a chord merge from erasing that identity.
    return false;
  }
  if (a.channel !== GM_PERCUSSION_CHANNEL && b.channel !== GM_PERCUSSION_CHANNEL) return true;
  if (a.channel !== b.channel) return false;
  return percussionVoiceGroup(a.pitch) === percussionVoiceGroup(b.pitch);
}

/** Drum-set voice group: 1 = upper kit voice, 2 = kick/low-foot voice. */
function percussionVoiceGroup(pitch: number): 1 | 2 {
  switch (pitch) {
    case 35:
    case 36:
      return 2;
    default:
      return 1;
  }
}

/** Union of two identity lists, keeping first-seen order. */
function mergeSourceIdentities(
  a: readonly MidiSourceIdentity[] | undefined,
  b: readonly MidiSourceIdentity[] | undefined,
): MidiSourceIdentity[] {
  const merged = [...(a ?? [])];
  for (const identity of b ?? []) {
    const known = merged.some(
      (m) =>
        m.clipId === identity.clipId &&
        m.noteId === identity.noteId &&
        m.occurrence === identity.occurrence,
    );
    if (!known) merged.push({ ...identity });
  }
  return merged;
}

/**
 * Pipeline step 3: assign units to at most `maxVoices` monophonic voices.
 *
 * Greedy interval scheduling: for each onset, free voices (lowest number
 * first) receive the simultaneous units in descending pitch order, so among
 * simultaneous onsets the higher pitch lands in voice 1. A unit arriving
 * while every voice is still sounding merges into the busy voice whose
 * sounding event has the nearest mean pitch (ties pick the lower voice):
 * same-onset overflow joins that event as a chord (union of pitches, longer
 * end wins); later-onset overflow truncates the sounding event at the new
 * onset so the voice stays monophonic and the new onset is preserved.
 *
 * Returns one unit list per used voice (no holes: lower voices fill first).
 */
function separateVoices(units: VoiceUnit[], maxVoices: number): VoiceUnit[][] {
  const voices: VoiceUnit[][] = Array.from({ length: maxVoices }, () => []);
  let i = 0;
  while (i < units.length) {
    let j = i;
    while (j < units.length && Math.abs(units[j].startPpq - units[i].startPpq) <= EPSILON) j++;
    const start = units[i].startPpq;
    const free: number[] = [];
    for (let v = 0; v < maxVoices; v++) {
      const last = voices[v][voices[v].length - 1];
      if (!last || last.endPpq <= start + EPSILON) free.push(v);
    }
    for (let u = i; u < j; u++) {
      const unit = units[u];
      const freeVoice = free.shift();
      if (freeVoice !== undefined) {
        voices[freeVoice].push(unit);
        continue;
      }
      // Overflow: every voice is sounding. Merge into the nearest by pitch.
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let v = 0; v < maxVoices; v++) {
        const last = voices[v][voices[v].length - 1];
        const dist = Math.abs(meanPitch(last.pitches) - meanPitch(unit.pitches));
        if (dist < bestDist - EPSILON) {
          best = v;
          bestDist = dist;
        }
      }
      const last = voices[best][voices[best].length - 1];
      if (Math.abs(last.startPpq - unit.startPpq) <= EPSILON) {
        // Same onset: widen the sounding event into a chord.
        last.pitches = [...new Set([...last.pitches, ...unit.pitches])].sort((a, b) => a - b);
        last.channels = [...new Set([...last.channels, ...unit.channels])].sort((a, b) => a - b);
        last.ids = [...new Set([...last.ids, ...unit.ids])].sort((a, b) => a - b);
        last.sourceIdentities = mergeSourceIdentities(last.sourceIdentities, unit.sourceIdentities);
        last.velocity = Math.max(last.velocity, unit.velocity);
        last.endPpq = Math.max(last.endPpq, unit.endPpq);
      } else {
        // Later onset: cut the sounding event short and start the new one.
        last.endPpq = unit.startPpq;
        voices[best].push(unit);
      }
    }
    i = j;
  }
  return voices.filter((v) => v.length > 0);
}

/**
 * Assigns a drum-set part to its conventional two voices: upper kit material
 * is voice 1 and kick/low-foot material is voice 2. Each group remains
 * monophonic, so overlapping notes in one group retain the normal overflow
 * handling instead of moving between the two engraved voices.
 */
function separatePercussionVoices(units: VoiceUnit[]): AssignedVoiceUnits[] {
  const byGroup: Record<1 | 2, VoiceUnit[]> = { 1: [], 2: [] };
  for (const unit of units) {
    byGroup[percussionVoiceGroup(unit.pitches[0])].push(unit);
  }
  return ([1, 2] as const).flatMap((group) => {
    const groupUnits = separateVoices(byGroup[group], 1)[0];
    return groupUnits ? [{ voice: group as NotatedVoiceNumber, units: groupUnits }] : [];
  });
}

function grandStaffVoiceNumber(staff: 1 | 2, index: number): NotatedVoiceNumber {
  const voice = staff === 1 ? index + 1 : index + 3;
  if (voice < 1 || voice > 4) {
    throw new RangeError(`quantizeToScore: grand-staff voice index out of range: ${voice}`);
  }
  return voice as NotatedVoiceNumber;
}

/**
 * Assigns clustered units to notated voices.
 *
 * Single-staff parts keep the historical one-pool assignment. Grand-staff
 * parts split units by pitch center first, then assign voices independently
 * on each staff: upper staff uses voices 1/2, lower staff uses voices 3/4.
 */
function assignVoiceUnits(
  units: VoiceUnit[],
  clef: NotatedClef | undefined,
  maxVoices: number,
  grandStaffSplitPitch: number,
): AssignedVoiceUnits[] {
  if (clef !== 'grand') {
    const percussionOnly = units.every(
      (unit) => unit.channels.length === 1 && unit.channels[0] === GM_PERCUSSION_CHANNEL,
    );
    if (percussionOnly && maxVoices >= 2) return separatePercussionVoices(units);
    return separateVoices(units, maxVoices).map((voiceUnits, index) => ({
      voice: (index + 1) as NotatedVoiceNumber,
      units: voiceUnits,
    }));
  }

  const { upper, lower } = assignGrandStaffUnits(units, grandStaffSplitPitch);
  const perStaffVoices = Math.min(2, maxVoices);
  const assignments: AssignedVoiceUnits[] = [];
  for (const [staff, staffUnits] of [
    [1, upper],
    [2, lower],
  ] as const) {
    const voices = separateVoices(staffUnits, perStaffVoices);
    // A grand staff must have a complete rest voice on both staves even when
    // one hand is silent for the entire clip. This keeps the MusicXML part
    // structurally complete and gives the serializer an explicit staff target.
    if (voices.length === 0) {
      assignments.push({ voice: grandStaffVoiceNumber(staff, 0), staff, units: [] });
      continue;
    }
    voices.forEach((voiceUnits, index) => {
      assignments.push({ voice: grandStaffVoiceNumber(staff, index), staff, units: voiceUnits });
    });
  }
  for (const staff of [1, 2] as const) {
    if (!assignments.some((assignment) => assignment.staff === staff)) {
      assignments.push({ voice: grandStaffVoiceNumber(staff, 0), staff, units: [] });
    }
  }
  assignments.sort((a, b) => a.voice - b.voice);
  return assignments;
}

/** First beat-group boundary strictly after `ppq` within a measure. */
function nextGroupBoundary(ppq: number, measureStartPpq: number, groupLen: number): number {
  const rel = ppq - measureStartPpq;
  return measureStartPpq + (Math.floor(rel / groupLen + EPSILON) + 1) * groupLen;
}

/**
 * Pipeline step 4: build the measure grid from the time signature.
 *
 * Measures start at the clip start. When the clip length is not a multiple of
 * the measure length, the final measure is short (incomplete) and
 * `lengthPpq < timeSigLengthPpq(timeSig)`. A pickup at the front can be
 * realized by the caller via `clipStartPpq` placement; this function only
 * models the trailing incomplete measure.
 */
function buildMeasureGrid(
  opts: ResolvedOptions,
): Array<{ index: number; startPpq: number; lengthPpq: number; timeSig: NotatedTimeSig }> {
  const changes: TimeSignatureSegment[] = [
    { startPpq: 0, numerator: opts.timeSig.beats, denominator: opts.timeSig.beatUnit },
    ...opts.timeSignatures,
  ];
  const ranges = clipMeasureGrid(changes, opts.clipStartPpq, opts.clipEndPpq, opts.pickupLengthPpq);
  if (ranges.length === 0) {
    return [
      {
        index: 0,
        startPpq: opts.clipStartPpq,
        lengthPpq: SIXTY_FOURTH_PPQ,
        timeSig: opts.timeSig,
      },
    ];
  }
  return ranges.map((range, index) => ({
    index,
    startPpq: range.startPpq,
    lengthPpq: Math.max(SIXTY_FOURTH_PPQ, range.lengthPpq),
    timeSig: { beats: range.numerator, beatUnit: range.denominator },
  }));
}

/**
 * Greedy decomposition of `[start, end)` into representable values, largest
 * first, with an exact-match check (which is how dotted values appear) before
 * every greedy pick. All boundaries are 64th-note multiples by construction,
 * so the loop always terminates exactly.
 */
function greedyPiecesForValues(
  start: number,
  end: number,
  values: ReadonlyArray<{ value: NoteValue; ppq: number }>,
): DurationPiece[] | undefined {
  const out: DurationPiece[] = [];
  let cursor = start;
  while (end - cursor > EPSILON) {
    const remaining = end - cursor;
    const value = values.find((candidate) => candidate.ppq <= remaining + EPSILON)?.value;
    if (!value) {
      return undefined;
    }
    const durationPpq = noteValueToPpq(value);
    out.push({ startPpq: cursor, durationPpq, value });
    cursor += durationPpq;
  }
  return out;
}

function greedyPieces(start: number, end: number): DurationPiece[] {
  const exact = exactNoteValue(end - start);
  if (exact) return [{ startPpq: start, durationPpq: end - start, value: exact }];

  // Keep each fallback decomposition within a single rhythmic family.  Trying
  // binary values first preserves conventional spelling, while the tuplet
  // family covers valid triplet-grid durations such as 5/6.
  const binary = greedyPiecesForValues(start, end, BINARY_VALUES_DESC);
  if (binary) return binary;
  const tuplet = greedyPiecesForValues(start, end, TUPLET_VALUES_DESC);
  if (tuplet) return tuplet;

  throw new RangeError(`quantizeToScore: cannot notate duration ${end - start}`);
}

/**
 * Pipeline step 5 (notes): decompose one within-measure note segment into
 * tied representable values.
 *
 * Exactly-representable durations stay whole when they are no longer than one
 * beat group or begin on a group boundary. Longer off-beat durations are tied
 * at the last group boundary before their end, preserving the central beat of
 * the measure while avoiding an unnecessarily short first fragment.
 * Otherwise the segment splits at the next beat-group boundary and both
 * halves recurse, falling back to greedy largest-first packing inside a
 * single group.
 */
function decomposeNote(
  start: number,
  end: number,
  measureStartPpq: number,
  groupLen: number,
): DurationPiece[] {
  const exact = exactNoteValue(end - start);
  if (exact) {
    const groupPosition = (start - measureStartPpq) / groupLen;
    const startsOnGroupBoundary = Math.abs(groupPosition - Math.round(groupPosition)) <= EPSILON;
    if (end - start <= groupLen + EPSILON || startsOnGroupBoundary) {
      return [{ startPpq: start, durationPpq: end - start, value: exact }];
    }
    const lastBoundaryIndex = Math.floor((end - measureStartPpq) / groupLen - EPSILON);
    const boundary = measureStartPpq + lastBoundaryIndex * groupLen;
    if (boundary > start + EPSILON) {
      return [
        ...greedyPieces(start, boundary),
        ...decomposeNote(boundary, end, measureStartPpq, groupLen),
      ];
    }
  }
  const boundary = nextGroupBoundary(start, measureStartPpq, groupLen);
  if (boundary < end - EPSILON) {
    return [
      ...decomposeNote(start, boundary, measureStartPpq, groupLen),
      ...decomposeNote(boundary, end, measureStartPpq, groupLen),
    ];
  }
  return greedyPieces(start, end);
}

/**
 * Pipeline step 6 (rests): decompose a gap into rest values.
 *
 * Unlike notes, rests split at beat-group boundaries even when the total gap
 * is exactly representable (no syncopated rests), except that a gap covering
 * the whole measure always becomes one measure rest. Its nominal note value
 * is ignored by the MusicXML serializer, which emits `<rest measure="yes"/>`.
 */
function decomposeRest(
  start: number,
  end: number,
  measureStartPpq: number,
  measureLengthPpq: number,
  groupLen: number,
): DurationPiece[] {
  const coversMeasure =
    start <= measureStartPpq + EPSILON && end >= measureStartPpq + measureLengthPpq - EPSILON;
  if (coversMeasure) {
    return [
      {
        startPpq: start,
        durationPpq: end - start,
        // A 5/4 or 5/8 measure has no ordinary single notehead value, but
        // measure rests deliberately omit `<type>` in MusicXML.
        value: exactNoteValue(end - start) ?? { base: 'whole', dots: 0 },
      },
    ];
  }
  const boundary = nextGroupBoundary(start, measureStartPpq, groupLen);
  if (boundary < end - EPSILON) {
    return [
      ...decomposeRest(start, boundary, measureStartPpq, measureLengthPpq, groupLen),
      ...decomposeRest(boundary, end, measureStartPpq, measureLengthPpq, groupLen),
    ];
  }
  const exact = exactNoteValue(end - start);
  if (exact) {
    return [{ startPpq: start, durationPpq: end - start, value: exact }];
  }
  return greedyPieces(start, end);
}

/**
 * Splits one voice's units at barlines and into representable values,
 * producing per-measure note events with tie flags chained across every
 * piece (first piece: tieStart only; middle pieces: both; last: tieStop
 * only). Ties are per-event, so every pitch of a chord ties together.
 */
function splitUnitsIntoMeasures(
  units: VoiceUnit[],
  measures: Array<{ index: number; startPpq: number; lengthPpq: number; timeSig: NotatedTimeSig }>,
  voice: NotatedVoiceNumber,
  staff?: 1 | 2,
): NotatedEvent[][] {
  const perMeasure: NotatedEvent[][] = measures.map(() => []);
  for (const unit of units) {
    const pieces: Array<DurationPiece & { measureIndex: number }> = [];
    for (const measure of measures) {
      const measureEnd = measure.startPpq + measure.lengthPpq;
      const segStart = Math.max(unit.startPpq, measure.startPpq);
      const segEnd = Math.min(unit.endPpq, measureEnd);
      if (segEnd - segStart <= EPSILON) continue;
      for (const piece of decomposeNote(
        segStart,
        segEnd,
        measure.startPpq,
        beatGroupPpq(measure.timeSig),
      )) {
        pieces.push({ ...piece, measureIndex: measure.index });
      }
    }
    pieces.forEach((piece, k) => {
      perMeasure[piece.measureIndex].push({
        kind: 'note',
        pitches: [...unit.pitches],
        voice,
        startPpq: piece.startPpq,
        durationPpq: piece.durationPpq,
        value: piece.value,
        tieStart: k < pieces.length - 1,
        tieStop: k > 0,
        ...(staff !== undefined ? { staff } : {}),
        ...(unit.fingering !== undefined ? { fingering: [...unit.fingering] } : {}),
        ...(unit.handCross ? { handCross: true } : {}),
        sourceIds: [...unit.ids],
        ...((unit.sourceIdentities?.length ?? 0) > 0
          ? { sourceIdentities: unit.sourceIdentities?.map((identity) => ({ ...identity })) }
          : {}),
        midiChannels: [...unit.channels],
        velocity: unit.velocity,
      });
    });
  }
  for (const events of perMeasure) {
    events.sort((a, b) => a.startPpq - b.startPpq);
  }
  return perMeasure;
}

/** Builds one gap-free NotatedVoice for a measure by filling gaps with rests. */
function fillVoiceMeasure(
  measure: { startPpq: number; lengthPpq: number },
  events: NotatedEvent[],
  groupLen: number,
  voice: NotatedVoiceNumber,
  staff?: 1 | 2,
): NotatedVoice {
  const out: NotatedEvent[] = [];
  const measureEnd = measure.startPpq + measure.lengthPpq;
  const pushRests = (from: number, to: number) => {
    for (const piece of decomposeRest(from, to, measure.startPpq, measure.lengthPpq, groupLen)) {
      out.push({
        kind: 'rest',
        pitches: [],
        voice,
        startPpq: piece.startPpq,
        durationPpq: piece.durationPpq,
        value: piece.value,
        tieStart: false,
        tieStop: false,
        ...(staff !== undefined ? { staff } : {}),
      });
    }
  };
  let cursor = measure.startPpq;
  for (const event of events) {
    if (event.startPpq - cursor > EPSILON) pushRests(cursor, event.startPpq);
    out.push(event);
    cursor = event.startPpq + event.durationPpq;
  }
  if (measureEnd - cursor > EPSILON) pushRests(cursor, measureEnd);
  assignTupletGroupIds(out, measure.startPpq, voice);
  return { voice, events: out };
}

/** Separates adjacent same-ratio tuplets into explicit, stable event groups. */
function assignTupletGroupIds(
  events: NotatedEvent[],
  measureStartPpq: number,
  voice: NotatedVoiceNumber,
): void {
  let previous: NotatedEvent | undefined;
  let activeId: string | undefined;
  let activeDuration = 0;
  let shortestDuration = Number.POSITIVE_INFINITY;
  let groupOrdinal = 0;
  for (const event of events) {
    const tuplet = event.value.tuplet;
    const contiguous =
      previous !== undefined &&
      Math.abs(previous.startPpq + previous.durationPpq - event.startPpq) <= EPSILON;
    const sameRatio =
      previous?.value.tuplet !== undefined &&
      tuplet !== undefined &&
      previous.value.tuplet.actual === tuplet.actual &&
      previous.value.tuplet.normal === tuplet.normal;
    if (tuplet === undefined) {
      activeId = undefined;
      activeDuration = 0;
      shortestDuration = Number.POSITIVE_INFINITY;
    } else {
      if (!contiguous || !sameRatio || activeId === undefined) {
        activeId = `m${Math.round(measureStartPpq * DEFAULT_DIVISIONS)}-v${voice}-t${groupOrdinal}`;
        groupOrdinal += 1;
        activeDuration = 0;
        shortestDuration = Number.POSITIVE_INFINITY;
      }
      event.tupletGroupId = activeId;
      activeDuration += event.durationPpq;
      shortestDuration = Math.min(shortestDuration, event.durationPpq);
      // A tuplet group spans `actual` copies of its shortest written value.
      // This lets a quarter-triplet plus an eighth-triplet share one bracket,
      // while still separating adjacent runs of three equal eighth-triplets.
      if (Math.abs(activeDuration - shortestDuration * tuplet.actual) <= EPSILON) {
        activeId = undefined;
      }
    }
    previous = event;
  }
}

/** Chooses a clef from the quantized pitch range (see {@link QuantizeOptions.clef}). */
function chooseClef(notes: GridNote[]): NotatedClef {
  if (notes.length === 0) return 'treble';
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note.pitch < min) min = note.pitch;
    if (note.pitch > max) max = note.pitch;
  }
  return (min + max) / 2 < 60 ? 'bass' : 'treble';
}

/**
 * Quantizes editor notes into a display-only single-part {@link NotatedScore}.
 *
 * Pure and non-destructive: the input notes are only read, never written —
 * display quantization exists solely for the score view and is never applied
 * back to MIDI data. Multi-part scores are produced by calling this once per
 * track and combining the resulting parts (all calls share the measure grid
 * when given the same timeSig/clip window).
 *
 * @param notes Editor notes of one clip/track (any order; not mutated).
 * @param options Grid, meter, key, clip window, and voice settings.
 * @returns A score with one part whose voices are gap-free and whose event
 *   durations always satisfy `durationPpq === noteValueToPpq(value)`.
 * @throws RangeError When options are out of range (see {@link QuantizeOptions}).
 */
export function quantizeToScore(
  notes: readonly ScoreInputNote[],
  options: QuantizeOptions,
): NotatedScore {
  const pitchedNotes = notes.filter((note) => note.channel !== GM_PERCUSSION_CHANNEL);
  const percussionNotes = notes.filter((note) => note.channel === GM_PERCUSSION_CHANNEL);
  if (pitchedNotes.length > 0 && percussionNotes.length > 0) {
    const pitched = quantizeToScore(pitchedNotes, options);
    const basePartId = options.partId ?? 'P1';
    const basePartName = options.partName?.trim() ?? '';
    const percussion = quantizeToScore(percussionNotes, {
      ...options,
      partId: `${basePartId}-percussion`,
      partName: basePartName === '' ? 'Percussion' : `${basePartName} Percussion`,
      clef: 'treble',
    });
    return { ...pitched, parts: [...pitched.parts, ...percussion.parts] };
  }
  const opts = resolveOptions(options);
  const gridNotes = quantizeToGrid(notes, opts);
  const units = clusterChords(gridNotes);
  const clef =
    percussionNotes.length > 0 && pitchedNotes.length === 0
      ? 'treble'
      : (opts.clef ?? chooseClef(gridNotes));
  const voiceUnits = assignVoiceUnits(units, clef, opts.maxVoices, opts.grandStaffSplitPitch);
  if (opts.estimateFingering) {
    estimateFingeringForUnits(voiceUnits, clef, opts.grandStaffSplitPitch);
  }
  const measures = buildMeasureGrid(opts);

  const perVoiceMeasureEvents = voiceUnits.map((entry) => ({
    voice: entry.voice,
    staff: entry.staff,
    measures: splitUnitsIntoMeasures(entry.units, measures, entry.voice, entry.staff),
  }));

  const notatedMeasures: NotatedMeasure[] = measures.map((measure) => {
    const voices: NotatedVoice[] = [];
    for (const entry of perVoiceMeasureEvents) {
      const events = entry.measures[measure.index];
      const staff = clef === 'grand' ? (entry.voice <= 2 ? 1 : 2) : entry.staff;
      // Keep a rest voice for the primary voice of each grand-staff stave
      // (1 = upper, 3 = lower). Secondary voices only exist where they sound.
      const primaryVoice =
        clef === 'grand' ? entry.voice === 1 || entry.voice === 3 : entry.voice === 1;
      if (!primaryVoice && events.length === 0) continue;
      voices.push(
        fillVoiceMeasure(measure, events, beatGroupPpq(measure.timeSig), entry.voice, staff),
      );
    }
    if (voices[0]?.voice !== 1) {
      voices.unshift(fillVoiceMeasure(measure, [], beatGroupPpq(measure.timeSig), 1));
    }
    return {
      index: measure.index,
      startPpq: measure.startPpq,
      lengthPpq: measure.lengthPpq,
      timeSig: { ...measure.timeSig },
      voices,
    };
  });

  return {
    parts: [
      {
        id: opts.partId,
        name: opts.partName,
        clef,
        measures: notatedMeasures,
      },
    ],
    keyFifths: opts.keyFifths,
    divisions: DEFAULT_DIVISIONS,
  };
}
