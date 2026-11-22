/**
 * Theory-guided cleanup of transcribed notes: starts and durations only, never
 * pitch.
 *
 * Transcription leaves damage a plain grid snap cannot repair: sustained tones
 * split into fragments, accompaniment whose lengths wander from stroke to
 * stroke, and melody notes that stop short of where the harmony and the phrase
 * hold them. This module reads the harmony (the chord track, or a reading of
 * the notes), the meter and the phrase structure, separates the texture into
 * melody, bass and inner accompaniment so a piano solo is treated as the
 * voices it is, and rewrites each voice by its own rule:
 *
 *  - melody: short rests inside a line close up, chord tones on strong beats
 *    hold to the next strong beat and a phrase's last note to the bar line;
 *  - bass: holds until the next bass note;
 *  - inner voices: every stroke takes the figure's prevailing length in its
 *    bar, read from the accompaniment's firm strokes.
 *
 * No note is held across a chord change its pitch class leaves. Positions are
 * absolute-timeline PPQ (1 PPQ = one quarter note). Pure module.
 */

import {
  type ChordTimeline,
  chordPitchClasses,
  isLibcantusError,
  type MeterMap,
  metricWeight,
  type NoteEvent,
  type Phrase,
  phrasesFromTimeline,
} from '@libraz/libcantus';
import { pitchClassOf } from '@/lib/pitch';
import type { EditorChordSymbol } from '@/project/chords';
import { measureRangeAt, snapPpqToMeterGrid, toMeterMap } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { buildChordTimeline, inferChordTimelineFromNotes } from './chord-at-tick';

/** The note fields the cleanup reads; every other field is carried through. */
export interface TidyNote {
  pitch: number;
  velocity: number;
  startPpq: number;
  durationPpq: number;
}

export interface TidyOptions {
  /** Rhythmic resolution starts and ends snap to, in PPQ. */
  gridPpq: number;
  timeSignatures: readonly TimeSignatureSegment[];
  /** The project chord track; the harmony is read from the notes when empty. */
  chords?: readonly EditorChordSymbol[];
  /** No note is extended past this position (the clip's end). */
  endPpq?: number;
}

export type TidyVoice = 'melody' | 'bass' | 'inner';

/** A Bar snap is too coarse to time notes by, so it falls back to sixteenths. */
export function tidyGridPpq(snap: { snapBar: boolean; snapDivision: number }): number {
  return snap.snapBar ? 0.25 : 4 / snap.snapDivision;
}

/** A re-onset this much softer than the tone it follows reads as its decay. */
const FRAGMENT_VELOCITY_DROP = 12;
/** A one-step note on a weak position below this share of the median velocity is a ghost. */
const GHOST_VELOCITY_RATIO = 0.5;
/** Metric weight from which a position counts as a strong beat. */
const STRONG_WEIGHT = 2;
const EPS = 1e-6;

interface Item<T> {
  note: T;
  start: number;
  end: number;
}

/** Positions of the voice-separation pass; only the timing and pitch matter. */
interface VoiceInput {
  pitch: number;
  start: number;
  end: number;
}

/**
 * Splits a texture into melody, bass and inner voices.
 *
 * At each onset the top of a chord is the melody unless a melody note is still
 * sounding above it; a lone note joins the line it continues, judged by what is
 * sounding and, failing that, by register distance to each line's last pitch.
 * Within the accompaniment, the lowest pitch struck in each harmonic segment is
 * the bass, so a broken-chord left hand keeps its root as the bass.
 *
 * @param items Notes with grid-aligned starts.
 * @param segmentOf Harmonic segment id of a position (chord region or bar).
 * @returns One voice per item, index-aligned.
 */
export function separateVoices(
  items: readonly VoiceInput[],
  segmentOf: (ppq: number) => number,
): TidyVoice[] {
  const voices = new Array<TidyVoice>(items.length);
  const order = items.map((_, index) => index).sort((a, b) => items[a].start - items[b].start);
  const melody: number[] = [];
  const accompaniment: number[] = [];
  let lastMelody: number | null = null;
  let lastAccompaniment: number | null = null;
  const soundingTop = (pool: number[], at: number): number | null => {
    let top: number | null = null;
    for (const index of pool) {
      if (items[index].start < at - EPS && items[index].end > at + EPS) {
        top = top === null ? items[index].pitch : Math.max(top, items[index].pitch);
      }
    }
    return top;
  };
  for (let cursor = 0; cursor < order.length; ) {
    const at = items[order[cursor]].start;
    const cluster: number[] = [];
    while (cursor < order.length && Math.abs(items[order[cursor]].start - at) < EPS) {
      cluster.push(order[cursor]);
      cursor += 1;
    }
    cluster.sort((a, b) => items[b].pitch - items[a].pitch);
    const top = items[cluster[0]].pitch;
    const heldMelody = soundingTop(melody, at);
    let topIsMelody: boolean;
    if (heldMelody !== null) {
      topIsMelody = top > heldMelody;
    } else if (cluster.length > 1) {
      topIsMelody = true;
    } else {
      const heldAccompaniment = soundingTop(accompaniment, at);
      if (heldAccompaniment !== null) topIsMelody = top > heldAccompaniment;
      else if (lastMelody === null) topIsMelody = true;
      else if (lastAccompaniment === null) topIsMelody = true;
      else topIsMelody = Math.abs(top - lastMelody) <= Math.abs(top - lastAccompaniment);
    }
    for (const [rank, index] of cluster.entries()) {
      if (rank === 0 && topIsMelody) {
        voices[index] = 'melody';
        melody.push(index);
        lastMelody = items[index].pitch;
      } else {
        voices[index] = 'inner';
        accompaniment.push(index);
        lastAccompaniment = items[index].pitch;
      }
    }
  }
  const lowestBySegment = new Map<number, number>();
  for (const index of accompaniment) {
    const segment = segmentOf(items[index].start);
    const lowest = lowestBySegment.get(segment);
    if (lowest === undefined || items[index].pitch < lowest) {
      lowestBySegment.set(segment, items[index].pitch);
    }
  }
  for (const index of accompaniment) {
    if (lowestBySegment.get(segmentOf(items[index].start)) === items[index].pitch) {
      voices[index] = 'bass';
    }
  }
  return voices;
}

/** The library's own "this input is larger than I will search" refusal reads as no answer. */
function unlessBudgetRefused<R>(run: () => R): R | null {
  try {
    return run();
  } catch (error) {
    if (isLibcantusError(error) && error.code === 'BUDGET_EXCEEDED') return null;
    throw error;
  }
}

function sortedOnsets<T>(items: readonly Item<T>[]): number[] {
  return [...new Set(items.map((item) => item.start))].sort((a, b) => a - b);
}

/** The most frequent value, the larger on a tie; null for an empty list. */
function mostCommon(values: readonly number[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | null = null;
  for (const [value, count] of counts) {
    const bestCount = best === null ? 0 : (counts.get(best) ?? 0);
    if (count > bestCount || (count === bestCount && best !== null && value > best)) best = value;
  }
  return best;
}

/** Pitch distances at which a piano tone's overtones are misread as notes. */
const OVERTONE_INTERVALS = [12, 19, 24];

/**
 * Drops notes that are a louder note's overtone read as a second pitch: an
 * octave, twelfth or two octaves above it, struck with it, softer, and gone no
 * later than it.
 */
function dropOvertones<T extends TidyNote>(items: Item<T>[], grid: number): Item<T>[] {
  const bySlot = new Map<number, Item<T>[]>();
  const slotOf = (ppq: number): number => Math.round(ppq / grid);
  for (const item of items) {
    const slot = slotOf(item.start);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), item]);
  }
  return items.filter((item) => {
    const slot = slotOf(item.start);
    for (const near of [slot - 1, slot, slot + 1]) {
      for (const base of bySlot.get(near) ?? []) {
        if (
          OVERTONE_INTERVALS.includes(item.note.pitch - base.note.pitch) &&
          item.note.velocity < base.note.velocity &&
          item.end <= base.end + grid + EPS
        ) {
          return false;
        }
      }
    }
    return true;
  });
}

/**
 * The accompaniment figure's stroke length per bar: the most common distance
 * between successive strokes in that bar, else the piece's most common one.
 *
 * @returns A lookup by position; null when the accompaniment has no strokes.
 */
function strokeUnits(
  onsets: readonly number[],
  barAt: (ppq: number) => { startPpq: number; lengthPpq: number },
): (ppq: number) => number | null {
  const byBar = new Map<number, number[]>();
  const all: number[] = [];
  for (let index = 0; index + 1 < onsets.length; index += 1) {
    const gap = onsets[index + 1] - onsets[index];
    const bar = barAt(onsets[index]);
    if (gap > bar.lengthPpq + EPS) continue;
    byBar.set(bar.startPpq, [...(byBar.get(bar.startPpq) ?? []), gap]);
    all.push(gap);
  }
  const overall = mostCommon(all);
  const perBar = new Map([...byBar].map(([start, gaps]) => [start, mostCommon(gaps)]));
  return (ppq) => perBar.get(barAt(ppq).startPpq) ?? overall;
}

function nextOnsetAfter(onsets: readonly number[], at: number): number {
  for (const onset of onsets) if (onset > at + EPS) return onset;
  return Number.POSITIVE_INFINITY;
}

/**
 * Rewrites note starts and durations by the harmony, meter and phrase
 * structure. Fragments of one sustained tone are joined, faint one-step ghosts
 * on weak positions are dropped, and the survivors are re-timed per voice.
 *
 * @param notes Notes on the absolute timeline (not mutated).
 * @param options Grid, meter, chord track and clip end.
 * @returns The kept notes with new `startPpq`/`durationPpq`, every other field
 *   carried over, ordered by start then pitch.
 * @throws RangeError when the grid is not a positive finite step.
 */
export function tidyNotes<T extends TidyNote>(notes: readonly T[], options: TidyOptions): T[] {
  const grid = options.gridPpq;
  if (!(grid > 0) || !Number.isFinite(grid)) {
    throw new RangeError(`Tidy grid must be a positive step, got ${grid}`);
  }
  if (notes.length === 0) return [];
  const signatures = options.timeSignatures;
  const meters: MeterMap = toMeterMap(signatures);
  const limit = options.endPpq ?? Number.POSITIVE_INFINITY;
  const snap = (ppq: number): number => snapPpqToMeterGrid(signatures, ppq, grid);
  const weightAt = (ppq: number): number => metricWeight(ppq, meters);
  const barAt = (ppq: number) => measureRangeAt(signatures, ppq);

  // Snap to the grid, keeping the louder of two strikes on one pitch and onset.
  const byOnset = new Map<string, Item<T>>();
  for (const note of notes) {
    const start = snap(note.startPpq);
    const end = Math.max(start + grid, snap(note.startPpq + note.durationPpq));
    const key = `${note.pitch}@${start}`;
    const existing = byOnset.get(key);
    if (!existing || note.velocity > existing.note.velocity) {
      byOnset.set(key, { note, start, end: Math.max(end, existing?.end ?? end) });
    }
  }
  let items = [...byOnset.values()];

  const events: NoteEvent[] = items
    .map((item) => ({
      pitch: item.note.pitch,
      startBeat: item.start,
      durationBeat: item.end - item.start,
      velocity: item.note.velocity,
    }))
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  const timeline: ChordTimeline | null =
    options.chords !== undefined && options.chords.length > 0
      ? buildChordTimeline(options.chords)
      : unlessBudgetRefused(() => inferChordTimelineFromNotes(events, { meters }).timeline);
  const segments = timeline === null ? [] : [...timeline.segments];
  const inHarmony = (pitch: number, ppq: number): boolean | null => {
    const chord = timeline?.at(ppq) ?? null;
    return chord === null ? null : chordPitchClasses(chord).includes(pitchClassOf(pitch));
  };
  const harmonicCap = (pitch: number, start: number): number => {
    for (const segment of segments) {
      if (segment.startBeat > start + EPS && inHarmony(pitch, segment.startBeat) === false) {
        return segment.startBeat;
      }
    }
    return Number.POSITIVE_INFINITY;
  };
  const segmentOf = (ppq: number): number => {
    const index = segments.findIndex(
      (segment) => ppq >= segment.startBeat - EPS && ppq < segment.endBeat - EPS,
    );
    return index >= 0 ? index : -1 - barAt(ppq).index;
  };

  // A softer re-onset of the same pitch on a weaker position, right after the
  // tone it follows and still inside the harmony, is that tone's decay.
  items.sort((a, b) => a.note.pitch - b.note.pitch || a.start - b.start);
  const joined: Item<T>[] = [];
  for (const item of items) {
    const previous = joined.at(-1);
    if (
      previous !== undefined &&
      previous.note.pitch === item.note.pitch &&
      item.start - previous.end <= grid + EPS &&
      item.note.velocity <= previous.note.velocity - FRAGMENT_VELOCITY_DROP &&
      weightAt(item.start) < weightAt(previous.start) &&
      inHarmony(item.note.pitch, item.start) !== false
    ) {
      previous.end = Math.max(previous.end, item.end);
      continue;
    }
    joined.push({ ...item });
  }
  items = joined;

  const velocities = items.map((item) => item.note.velocity).sort((a, b) => a - b);
  const median = velocities[Math.floor(velocities.length / 2)];
  items = items.filter(
    (item) =>
      !(
        item.end - item.start <= grid + EPS &&
        item.note.velocity < median * GHOST_VELOCITY_RATIO &&
        weightAt(item.start) === 0 &&
        inHarmony(item.note.pitch, item.start) !== true
      ),
  );
  items = dropOvertones(items, grid);
  if (items.length === 0) return [];

  const voices = separateVoices(
    items.map((item) => ({ pitch: item.note.pitch, start: item.start, end: item.end })),
    segmentOf,
  );
  const melody = items.filter((_, index) => voices[index] === 'melody');
  const melodyOnsets = sortedOnsets(melody);
  const bassOnsets = sortedOnsets(items.filter((_, index) => voices[index] === 'bass'));
  // The figure's unit is read from the accompaniment's firm strokes only, so a
  // faint misread onset cannot halve it.
  const firm = items.filter(
    (item, index) => voices[index] !== 'melody' && item.note.velocity >= median,
  );
  const strokeUnit = strokeUnits(sortedOnsets(firm), barAt);

  // The last melody note of each phrase holds to the phrase's end.
  const phraseHold = new Map<Item<T>, number>();
  if (timeline !== null && melody.length > 0) {
    const phrases: Phrase[] =
      unlessBudgetRefused(() => phrasesFromTimeline(timeline, events, { meters })) ?? [];
    for (const phrase of phrases) {
      const last = melody
        .filter((item) => item.start >= phrase.startBeat - EPS && item.start < phrase.endBeat - EPS)
        .at(-1);
      if (last !== undefined) phraseHold.set(last, phrase.endBeat);
    }
  }
  const nextStrongBeat = (start: number): number => {
    const bar = barAt(start);
    const beat = bar.lengthPpq / bar.numerator;
    for (let at = start + beat; at <= start + 2 * bar.lengthPpq + EPS; at += beat) {
      if (weightAt(at) >= STRONG_WEIGHT) return at;
    }
    return start + bar.lengthPpq;
  };

  for (const [index, item] of items.entries()) {
    const voice = voices[index];
    const pitch = item.note.pitch;
    const bar = barAt(item.start);
    const cap = Math.min(harmonicCap(pitch, item.start), limit);
    if (voice === 'melody') {
      const next = nextOnsetAfter(melodyOnsets, item.start);
      if (next < item.end) {
        item.end = next;
        continue;
      }
      let target = item.end;
      if (next - item.end < bar.lengthPpq / bar.numerator - EPS) target = next;
      const phraseEnd = phraseHold.get(item);
      if (phraseEnd !== undefined) {
        target = Math.max(target, Math.min(next, phraseEnd, bar.startPpq + bar.lengthPpq));
      } else if (weightAt(item.start) >= STRONG_WEIGHT && inHarmony(pitch, item.start) !== false) {
        target = Math.max(target, Math.min(next, nextStrongBeat(item.start)));
      }
      item.end = Math.max(item.end, Math.min(target, cap));
    } else if (voice === 'bass') {
      const next = nextOnsetAfter(bassOnsets, item.start);
      if (next < item.end) {
        item.end = next;
        continue;
      }
      const target = Math.min(next, item.start + bar.lengthPpq);
      item.end = Math.max(item.end, Math.min(target, cap));
    } else {
      const unit = strokeUnit(item.start);
      if (unit !== null) item.end = Math.min(item.start + unit, cap);
    }
  }

  // Back onto the grid, then no pitch may overlap its own next strike.
  for (const item of items) item.end = Math.max(item.start + grid, snap(item.end));
  items.sort((a, b) => a.note.pitch - b.note.pitch || a.start - b.start);
  for (let index = 0; index + 1 < items.length; index += 1) {
    const current = items[index];
    const following = items[index + 1];
    if (current.note.pitch === following.note.pitch && current.end > following.start) {
      current.end = following.start;
    }
  }
  return items
    .map((item) => ({ ...item.note, startPpq: item.start, durationPpq: item.end - item.start }))
    .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
}
