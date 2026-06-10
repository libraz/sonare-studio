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

import {
  DEFAULT_DIVISIONS,
  NOTE_VALUE_BASE_PPQ,
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
  timeSigLengthPpq,
} from '@/notation/model';
import type { EditorNote } from '@/project/types';

/** Comparison tolerance for PPQ arithmetic on IEEE doubles. */
const EPSILON = 1e-6;

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
   * grid. Must be a positive multiple of a 64th note (0.0625 PPQ); finer or
   * non-binary (tuplet) grids are not representable by the notation model.
   */
  divisionPpq: number;
  /** Time signature applied to every measure. */
  timeSig: NotatedTimeSig;
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
}

/** A note after grid quantization and clip clamping. */
interface GridNote {
  pitch: number;
  startPpq: number;
  endPpq: number;
  /** Editor note id, used only as a deterministic sort tiebreaker. */
  id: number;
}

/** A chord-clustered unit before measure/duration splitting. */
interface VoiceUnit {
  /** MIDI pitches, ascending, deduplicated. */
  pitches: number[];
  startPpq: number;
  endPpq: number;
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
}

/** All 21 representable note values, longest first, with their PPQ lengths. */
const VALUES_DESC: ReadonlyArray<{ value: NoteValue; ppq: number }> = (() => {
  const all: Array<{ value: NoteValue; ppq: number }> = [];
  for (const base of NOTE_VALUE_BASES) {
    for (const dots of [0, 1, 2] as const) {
      const value: NoteValue = { base, dots };
      all.push({ value, ppq: noteValueToPpq(value) });
    }
  }
  all.sort((a, b) => b.ppq - a.ppq);
  return all;
})();

/** Returns true when `value` is an integral multiple of `step` within tolerance. */
function isMultipleOf(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) <= EPSILON;
}

/** Snaps `value` to the nearest integral multiple of `step`. */
function snapToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Returns the single exact NoteValue for a duration, or undefined when none matches. */
function exactNoteValue(ppq: number): NoteValue | undefined {
  for (const base of NOTE_VALUE_BASES) {
    for (const dots of [0, 1, 2] as const) {
      if (Math.abs(ppq - NOTE_VALUE_BASE_PPQ[base] * (2 - 2 ** -dots)) <= EPSILON) {
        return { base, dots };
      }
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
    !isMultipleOf(divisionPpq, SIXTY_FOURTH_PPQ)
  ) {
    throw new RangeError(
      `quantizeToScore: divisionPpq must be a positive multiple of ${SIXTY_FOURTH_PPQ} PPQ, got ${divisionPpq}`,
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
  const grid = snapToStep(divisionPpq, SIXTY_FOURTH_PPQ);
  const start = snapToStep(clipStartPpq, SIXTY_FOURTH_PPQ);
  const length = snapToStep(clipLengthPpq, SIXTY_FOURTH_PPQ);
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
function quantizeToGrid(notes: readonly EditorNote[], opts: ResolvedOptions): GridNote[] {
  const { grid, clipStartPpq: cs, clipEndPpq: ce } = opts;
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
    out.push({ pitch: note.pitch, startPpq: start, endPpq: end, id: note.id });
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
      used[a] = true;
      for (let b = a + 1; b < group.length; b++) {
        if (used[b]) continue;
        if (
          Math.abs(group[b].endPpq - top.endPpq) <= EPSILON &&
          top.pitch - group[b].pitch <= CHORD_PITCH_SPAN
        ) {
          pitches.add(group[b].pitch);
          used[b] = true;
        }
      }
      units.push({
        pitches: [...pitches].sort((x, y) => x - y),
        startPpq: top.startPpq,
        endPpq: top.endPpq,
      });
    }
    i = j;
  }
  return units;
}

/** Mean MIDI pitch of a pitch list (used as the voice-proximity metric). */
function meanPitch(pitches: number[]): number {
  let sum = 0;
  for (const p of pitches) sum += p;
  return sum / pitches.length;
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
 * Beat-group length used for split/rest boundaries: the denominator beat
 * (4 / beatUnit) for simple meters; three of them (the dotted beat) for
 * compound meters (beatUnit >= 8 with beats divisible by 3, e.g. 6/8 -> 1.5).
 */
function beatGroupPpq(timeSig: NotatedTimeSig): number {
  const beatLen = 4 / timeSig.beatUnit;
  const compound = timeSig.beatUnit >= 8 && timeSig.beats % 3 === 0;
  return compound ? beatLen * 3 : beatLen;
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
): Array<{ index: number; startPpq: number; lengthPpq: number }> {
  const measureLen = timeSigLengthPpq(opts.timeSig);
  const clipLen = opts.clipEndPpq - opts.clipStartPpq;
  const count = Math.max(1, Math.ceil(clipLen / measureLen - EPSILON));
  const measures: Array<{ index: number; startPpq: number; lengthPpq: number }> = [];
  for (let index = 0; index < count; index++) {
    const startPpq = opts.clipStartPpq + index * measureLen;
    const lengthPpq = index === count - 1 ? opts.clipEndPpq - startPpq : measureLen;
    measures.push({ index, startPpq, lengthPpq });
  }
  return measures;
}

/**
 * Greedy decomposition of `[start, end)` into representable values, largest
 * first, with an exact-match check (which is how dotted values appear) before
 * every greedy pick. All boundaries are 64th-note multiples by construction,
 * so the loop always terminates exactly.
 */
function greedyPieces(start: number, end: number): DurationPiece[] {
  const out: DurationPiece[] = [];
  let cursor = start;
  while (end - cursor > EPSILON) {
    const remaining = end - cursor;
    const exact = exactNoteValue(remaining);
    const value = exact ?? VALUES_DESC.find((c) => c.ppq <= remaining + EPSILON)?.value;
    if (!value) {
      // Unreachable with validated inputs (all durations are 64th multiples).
      throw new RangeError(`quantizeToScore: cannot notate residual duration ${remaining}`);
    }
    const durationPpq = noteValueToPpq(value);
    out.push({ startPpq: cursor, durationPpq, value });
    cursor += durationPpq;
  }
  return out;
}

/**
 * Pipeline step 5 (notes): decompose one within-measure note segment into
 * tied representable values.
 *
 * Exactly-representable durations stay whole even when they cross beat
 * groups (syncopation is kept, dotted values used when exact); otherwise the
 * segment splits at the next beat-group boundary and both halves recurse,
 * falling back to greedy largest-first packing inside a single group.
 */
function decomposeNote(
  start: number,
  end: number,
  measureStartPpq: number,
  groupLen: number,
): DurationPiece[] {
  const exact = exactNoteValue(end - start);
  if (exact) {
    return [{ startPpq: start, durationPpq: end - start, value: exact }];
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
 * the whole measure becomes a single rest when the measure length is
 * representable.
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
    const exact = exactNoteValue(end - start);
    if (exact) {
      return [{ startPpq: start, durationPpq: end - start, value: exact }];
    }
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
  measures: Array<{ index: number; startPpq: number; lengthPpq: number }>,
  groupLen: number,
  voice: NotatedVoiceNumber,
): NotatedEvent[][] {
  const perMeasure: NotatedEvent[][] = measures.map(() => []);
  for (const unit of units) {
    const pieces: Array<DurationPiece & { measureIndex: number }> = [];
    for (const measure of measures) {
      const measureEnd = measure.startPpq + measure.lengthPpq;
      const segStart = Math.max(unit.startPpq, measure.startPpq);
      const segEnd = Math.min(unit.endPpq, measureEnd);
      if (segEnd - segStart <= EPSILON) continue;
      for (const piece of decomposeNote(segStart, segEnd, measure.startPpq, groupLen)) {
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
  return { voice, events: out };
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
  notes: readonly EditorNote[],
  options: QuantizeOptions,
): NotatedScore {
  const opts = resolveOptions(options);
  const gridNotes = quantizeToGrid(notes, opts);
  const units = clusterChords(gridNotes);
  const voiceUnits = separateVoices(units, opts.maxVoices);
  const measures = buildMeasureGrid(opts);
  const groupLen = beatGroupPpq(opts.timeSig);

  const perVoiceMeasureEvents = voiceUnits.map((vu, vi) =>
    splitUnitsIntoMeasures(vu, measures, groupLen, (vi + 1) as NotatedVoiceNumber),
  );

  const notatedMeasures: NotatedMeasure[] = measures.map((measure) => {
    const voices: NotatedVoice[] = [];
    for (let vi = 0; vi < perVoiceMeasureEvents.length; vi++) {
      const events = perVoiceMeasureEvents[vi][measure.index];
      // Voice 1 is always present; higher voices only where they sound.
      if (vi > 0 && events.length === 0) continue;
      voices.push(fillVoiceMeasure(measure, events, groupLen, (vi + 1) as NotatedVoiceNumber));
    }
    if (voices.length === 0) {
      voices.push(fillVoiceMeasure(measure, [], groupLen, 1));
    }
    return {
      index: measure.index,
      startPpq: measure.startPpq,
      lengthPpq: measure.lengthPpq,
      timeSig: { ...opts.timeSig },
      voices,
    };
  });

  return {
    parts: [
      {
        id: opts.partId,
        name: opts.partName,
        clef: opts.clef ?? chooseClef(gridNotes),
        measures: notatedMeasures,
      },
    ],
    keyFifths: opts.keyFifths,
    divisions: DEFAULT_DIVISIONS,
  };
}
