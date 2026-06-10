/**
 * Display-only chord symbol estimation for the score view.
 *
 * Derives one chord symbol per measure from the editor notes by matching a
 * duration-weighted pitch-class histogram against common chord templates.
 * The result is purely a view annotation: nothing here reads or writes MIDI
 * note data.
 *
 * Estimated symbols can additionally be round-tripped through
 * `Project.annotateChords` on a scratch wasm Project so the displayed values
 * use the canonical libsonare annotation encoding (field clamping, sentinel
 * handling, ordering). A scratch Project is used instead of the live one
 * because annotation writes are undoable project edits, and the editor's
 * undo stack pairs 1:1 with note-edit history entries.
 */

import { ensureWasm } from '@/lib/wasm';
import type { NotatedChordSymbol } from '@/notation/model';
import { spellPitch } from '@/notation/pitch-spelling';
import type { EditorNote } from '@/project/types';

/** Sentinel used by the Project annotation encoding for "no pitch class". */
const PC_NONE = 255;

/** Estimation options for {@link estimateChordSymbols}. */
export interface ChordEstimateOptions {
  /** Absolute PPQ position of the first measure (score origin). */
  clipStartPpq: number;
  /** Length of the notated window in PPQ (> 0). */
  clipLengthPpq: number;
  /** Measure length in PPQ (> 0), e.g. 4 for 4/4. */
  measureLengthPpq: number;
  /** Key signature fifths (-7..7) used to spell chord root/bass names. */
  keyFifths: number;
}

/** An estimated chord symbol with its region end (needed for annotation). */
export interface EstimatedChordSymbol extends NotatedChordSymbol {
  /** Exclusive end of the chord region in absolute PPQ. */
  endPpq: number;
}

/** One chord template: audio-domain ChordQuality ordinal + intervals + suffix. */
interface ChordTemplate {
  quality: number;
  intervals: ReadonlyArray<number>;
  suffix: string;
}

/**
 * Templates in tie-break priority order (earlier wins on equal score), using
 * audio-domain ChordQuality ordinals (Major = 0).
 */
const CHORD_TEMPLATES: ReadonlyArray<ChordTemplate> = [
  { quality: 0, intervals: [0, 4, 7], suffix: '' }, // major
  { quality: 1, intervals: [0, 3, 7], suffix: 'm' }, // minor
  { quality: 4, intervals: [0, 4, 7, 10], suffix: '7' }, // dominant 7
  { quality: 5, intervals: [0, 4, 7, 11], suffix: 'maj7' }, // major 7
  { quality: 6, intervals: [0, 3, 7, 10], suffix: 'm7' }, // minor 7
  { quality: 2, intervals: [0, 3, 6], suffix: 'dim' }, // diminished
  { quality: 3, intervals: [0, 4, 8], suffix: 'aug' }, // augmented
  { quality: 8, intervals: [0, 5, 7], suffix: 'sus4' },
  { quality: 7, intervals: [0, 2, 7], suffix: 'sus2' },
  { quality: 12, intervals: [0, 3, 6, 9], suffix: 'dim7' },
  { quality: 13, intervals: [0, 3, 6, 10], suffix: 'm7b5' }, // half-diminished
];

/** Weight a template pitch class must reach to count as present. */
const PRESENCE_EPSILON = 1e-9;
/** Penalty factor for template tones that are absent from the measure. */
const MISSING_TONE_PENALTY = 0.5;

/** Spells a pitch class as a chord-symbol token, e.g. 'C#', 'Bb', 'F'. */
function pitchClassName(pc: number, keyFifths: number): string {
  const spelled = spellPitch(60 + (((pc % 12) + 12) % 12), keyFifths);
  const accidental = spelled.alter === 1 ? '#' : spelled.alter === -1 ? 'b' : '';
  return `${spelled.step}${accidental}`;
}

/**
 * Estimates one chord symbol per measure from the editor notes.
 *
 * For each measure the overlapping note durations are accumulated into a
 * pitch-class histogram, which is matched against {@link CHORD_TEMPLATES}
 * over all 12 roots (score = matched weight - non-chord weight - a penalty
 * per missing template tone). Measures with fewer than two distinct pitch
 * classes, or where no template scores positively with its root present,
 * produce no symbol. The bass is the pitch class of the lowest sounding
 * note in the measure; a differing bass yields a slash chord.
 *
 * Pure and read-only over the notes; the result is sorted by ppq.
 *
 * @param notes Editor notes (not mutated).
 * @param options Clip window, measure length and key spelling context.
 * @returns Estimated symbols, one per matched measure.
 */
export function estimateChordSymbols(
  notes: ReadonlyArray<EditorNote>,
  options: ChordEstimateOptions,
): EstimatedChordSymbol[] {
  const { clipStartPpq, clipLengthPpq, measureLengthPpq, keyFifths } = options;
  if (
    !Number.isFinite(clipStartPpq) ||
    !Number.isFinite(clipLengthPpq) ||
    !Number.isFinite(measureLengthPpq) ||
    clipLengthPpq <= 0 ||
    measureLengthPpq <= 0
  ) {
    throw new RangeError('Chord estimation requires a positive clip window and measure length');
  }
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const measureCount = Math.ceil(clipLengthPpq / measureLengthPpq);
  const out: EstimatedChordSymbol[] = [];

  for (let index = 0; index < measureCount; index++) {
    const start = clipStartPpq + index * measureLengthPpq;
    const end = Math.min(start + measureLengthPpq, clipEndPpq);
    const weights = new Array<number>(12).fill(0);
    let bassPitch = Number.POSITIVE_INFINITY;
    for (const note of notes) {
      const overlap =
        Math.min(note.startPpq + note.durationPpq, end) - Math.max(note.startPpq, start);
      if (overlap <= 0) continue;
      weights[note.pitch % 12] += overlap;
      if (note.pitch < bassPitch) bassPitch = note.pitch;
    }
    const distinct = weights.filter((w) => w > PRESENCE_EPSILON).length;
    if (distinct < 2) continue;
    const total = weights.reduce((sum, w) => sum + w, 0);
    const meanWeight = total / distinct;

    let best: { score: number; root: number; template: ChordTemplate } | null = null;
    for (const template of CHORD_TEMPLATES) {
      for (let root = 0; root < 12; root++) {
        if (weights[root] <= PRESENCE_EPSILON) continue; // require the root to sound
        let matched = 0;
        let missing = 0;
        for (const interval of template.intervals) {
          const w = weights[(root + interval) % 12];
          if (w > PRESENCE_EPSILON) matched += w;
          else missing++;
        }
        const score = matched - (total - matched) - missing * meanWeight * MISSING_TONE_PENALTY;
        if (score > 0 && (!best || score > best.score)) {
          best = { score, root, template };
        }
      }
    }
    if (!best) continue;

    const rootPc = best.root;
    const bassPc = Number.isFinite(bassPitch) ? bassPitch % 12 : rootPc;
    const rootName = pitchClassName(rootPc, keyFifths);
    let text = `${rootName}${best.template.suffix}`;
    const symbol: EstimatedChordSymbol = {
      ppq: start,
      endPpq: end,
      text,
      rootPc,
      quality: best.template.quality,
    };
    if (bassPc !== rootPc) {
      text = `${text}/${pitchClassName(bassPc, keyFifths)}`;
      symbol.text = text;
      symbol.bassPc = bassPc;
    }
    out.push(symbol);
  }
  return out;
}

/** Slice of one serialized annotation chord inside the Project JSON document. */
interface SerializedAnnotationChord {
  start_ppq: number;
  end_ppq: number;
  root_pc: number;
  quality: number;
  slash_bass_pc: number;
  roman_numeral: string;
}

/** PPQ keys are rounded at micro-PPQ resolution to absorb float round-trips. */
const KEY_PPQ_SCALE = 1e6;

/**
 * Round-trips estimated chord symbols through `Project.annotateChords` on a
 * scratch wasm Project and reads back the canonical annotation stream.
 *
 * The Project encoding shifts quality ordinals by one (0 = unknown,
 * 1 = major, ...) and uses 255 as the "no pitch class" sentinel; this
 * function applies both conversions in each direction. Display text is not
 * stored by the Project, so it is re-associated by start position.
 *
 * The scratch Project is always released; any wasm failure rejects and the
 * caller is expected to degrade by rendering without chord symbols.
 *
 * @param chords Estimated symbols (absolute PPQ regions).
 * @returns Canonicalized symbols sorted by ppq, ready for NotatedScore.
 */
export async function canonicalizeChordSymbols(
  chords: ReadonlyArray<EstimatedChordSymbol>,
): Promise<NotatedChordSymbol[]> {
  if (chords.length === 0) return [];
  const wasm = await ensureWasm();
  const scratch = new wasm.Project();
  try {
    scratch.annotateChords(
      chords.map((chord) => ({
        startPpq: chord.ppq,
        endPpq: chord.endPpq,
        rootPc: chord.rootPc ?? PC_NONE,
        quality: chord.quality === undefined ? 0 : chord.quality + 1,
        slashBassPc: chord.bassPc ?? PC_NONE,
        ...(chord.romanNumeral !== undefined ? { romanNumeral: chord.romanNumeral } : {}),
      })),
    );
    const doc = JSON.parse(scratch.toJson()) as {
      annotation?: { chords?: SerializedAnnotationChord[] };
    };
    const stored = doc.annotation?.chords;
    if (!Array.isArray(stored)) return [];
    const textByStart = new Map(
      chords.map((chord) => [Math.round(chord.ppq * KEY_PPQ_SCALE), chord.text]),
    );
    const out: NotatedChordSymbol[] = [];
    for (const raw of stored) {
      if (typeof raw.root_pc !== 'number' || raw.root_pc < 0 || raw.root_pc > 11) continue;
      const text = textByStart.get(Math.round(raw.start_ppq * KEY_PPQ_SCALE));
      if (!text) continue;
      const symbol: NotatedChordSymbol = { ppq: raw.start_ppq, text, rootPc: raw.root_pc };
      if (raw.quality >= 1) symbol.quality = raw.quality - 1;
      if (raw.slash_bass_pc >= 0 && raw.slash_bass_pc <= 11) symbol.bassPc = raw.slash_bass_pc;
      if (raw.roman_numeral) symbol.romanNumeral = raw.roman_numeral;
      out.push(symbol);
    }
    out.sort((a, b) => a.ppq - b.ppq);
    return out;
  } finally {
    scratch.delete();
  }
}
