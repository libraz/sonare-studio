/**
 * Display-only chord symbol estimation for the score view.
 *
 * Detection itself is not done here: the notes go through the shared
 * {@link detectChordRegions}, the same libcantus path the chord track uses, so
 * the score and the chord track can never disagree about the harmony. This
 * module owns only the display concern — chord windows follow the score's
 * measures, the root is spelled for the displayed key signature, and the bass
 * of the region becomes a slash chord. The result is purely a view annotation:
 * nothing here reads or writes MIDI note data.
 *
 * Estimated symbols can additionally be round-tripped through
 * `Project.annotateChords` on a scratch wasm Project so the displayed values
 * use the canonical libsonare annotation encoding (field clamping, sentinel
 * handling, ordering). A scratch Project is used instead of the live one
 * because annotation writes are undoable project edits, and the editor's
 * undo stack pairs 1:1 with note-edit history entries.
 */

import { type ChordDetectionRange, detectChordRegions } from '@/compose/chord-detection';
import { chordSpanToEditorChord } from '@/compose/chord-io';
import { chordSuffix } from '@/compose/chord-quality';
import { editorNotesToNoteEvents } from '@/compose/notes-io';
import { ensureWasm } from '@/lib/wasm';
import type { NotatedChordSymbol } from '@/notation/model';
import { PPQ_EPSILON } from '@/notation/musicxml-shared';
import { chordPitchClassName } from '@/notation/pitch-spelling';
import {
  chordFromAnnotationEntry,
  type EditorChordSymbol,
  toProjectChordSymbol,
} from '@/project/chords';
import { readNativeDocument } from '@/project/native-document';
import type { EditorNote } from '@/project/types';

/** Estimation options for {@link estimateChordSymbols}. */
export interface ChordEstimateOptions {
  /** Absolute PPQ position of the first measure (score origin). */
  clipStartPpq: number;
  /** Length of the notated window in PPQ (> 0). */
  clipLengthPpq: number;
  /** Measure length in PPQ (> 0), e.g. 4 for 4/4. Used when measures is omitted. */
  measureLengthPpq: number;
  /** Actual score measures; when provided, chord windows follow their starts and lengths. */
  measures?: ReadonlyArray<{ startPpq: number; lengthPpq: number }>;
  /** Key signature fifths (-7..7) used to spell chord root/bass names. */
  keyFifths: number;
}

/** An estimated chord symbol with its region end (needed for annotation). */
export interface EstimatedChordSymbol extends NotatedChordSymbol {
  /** Exclusive end of the chord region in absolute PPQ. */
  endPpq: number;
}

/** One absolute PPQ region used for chord estimation. */
interface ChordWindow {
  start: number;
  end: number;
}

function chordWindows(options: ChordEstimateOptions): ChordWindow[] {
  const { clipStartPpq, clipLengthPpq, measureLengthPpq } = options;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  if (options.measures !== undefined) {
    const windows = options.measures
      .filter(
        (measure) =>
          Number.isFinite(measure.startPpq) &&
          Number.isFinite(measure.lengthPpq) &&
          measure.lengthPpq > 0,
      )
      .map((measure) => ({
        start: Math.max(clipStartPpq, measure.startPpq),
        end: Math.min(clipEndPpq, measure.startPpq + measure.lengthPpq),
      }))
      .filter((window) => window.end > window.start)
      .sort((a, b) => a.start - b.start);
    if (windows.length > 0) return windows;
  }
  const measureCount = Math.ceil(clipLengthPpq / measureLengthPpq);
  return Array.from({ length: measureCount }, (_, index) => {
    const start = clipStartPpq + index * measureLengthPpq;
    return { start, end: Math.min(start + measureLengthPpq, clipEndPpq) };
  });
}

/** Spells a pitch class as a chord-symbol token, e.g. 'C#', 'Bb', 'F'. */
function pitchClassName(pc: number, keyFifths: number): string {
  return chordPitchClassName(pc, keyFifths);
}

/**
 * Groups the chord windows into runs of equal, contiguous length, one analysis
 * range each. Detection slices a range from its own origin, so a measure-length
 * change (a meter change, or the clip's truncated last measure) must start a new
 * range or the following slots would drift off the barlines.
 */
function detectionRanges(windows: ReadonlyArray<ChordWindow>): ChordDetectionRange[] {
  const ranges: ChordDetectionRange[] = [];
  for (const window of windows) {
    const length = window.end - window.start;
    const open = ranges[ranges.length - 1];
    if (open !== undefined && open.endPpq === window.start && open.slotLengthPpq === length) {
      open.endPpq = window.end;
      continue;
    }
    ranges.push({ startPpq: window.start, endPpq: window.end, slotLengthPpq: length });
  }
  return ranges;
}

/**
 * The bass pitch class of a detected region: the lowest pitch sounding at the
 * region start, or (when the region starts empty) the lowest pitch at the first
 * onset inside it. Returns null when no note overlaps the region.
 */
function regionBassPc(notes: ReadonlyArray<EditorNote>, start: number, end: number): number | null {
  let bassAtStart = Number.POSITIVE_INFINITY;
  let firstOnset = Number.POSITIVE_INFINITY;
  let bassAtFirstOnset = Number.POSITIVE_INFINITY;
  for (const note of notes) {
    const overlap =
      Math.min(note.startPpq + note.durationPpq, end) - Math.max(note.startPpq, start);
    if (overlap <= 0) continue;
    if (note.startPpq <= start + PPQ_EPSILON) {
      bassAtStart = Math.min(bassAtStart, note.pitch);
    } else if (note.startPpq < firstOnset - PPQ_EPSILON) {
      firstOnset = note.startPpq;
      bassAtFirstOnset = note.pitch;
    } else if (Math.abs(note.startPpq - firstOnset) <= PPQ_EPSILON) {
      bassAtFirstOnset = Math.min(bassAtFirstOnset, note.pitch);
    }
  }
  const bassPitch = Number.isFinite(bassAtStart) ? bassAtStart : bassAtFirstOnset;
  return Number.isFinite(bassPitch) ? bassPitch % 12 : null;
}

/**
 * Estimates the score's displayed chord symbols from the editor notes.
 *
 * Windows follow the score measures when supplied and the fixed measure length
 * otherwise; runs of equal-length windows are handed to {@link detectChordRegions},
 * so the displayed chords are exactly the ones the chord track would infer.
 * Adjacent measures carrying the same chord form one region, and measures
 * without notes produce no symbol. Every note given is read as harmonic
 * material: callers drop percussion first, per track (`harmonicTracksOnly`).
 *
 * The display text is built studio-side as the key-spelled root plus the
 * quality suffix, so flat keys keep printing flats. The bass is the lowest pitch
 * sounding at the region start, or (when the region starts empty) the lowest
 * pitch at the first onset; a differing bass yields a slash chord.
 *
 * Pure and read-only over the notes; the result is sorted by ppq.
 *
 * @param notes Editor notes (not mutated).
 * @param options Clip window, measure length and key spelling context.
 * @returns Estimated symbols, one per detected region.
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
  const { regions } = detectChordRegions(
    editorNotesToNoteEvents(notes),
    detectionRanges(chordWindows(options)),
  );

  const out: EstimatedChordSymbol[] = [];
  for (const region of regions) {
    // Both the tone set and the name come from the shared bridge, so the score
    // view and the chord track cannot describe a detected chord differently.
    // Naming from the span's quality alone would part from the tone set exactly
    // where a quality is only the nearest name for it. The slash bass below is
    // the score's own, read from the notes rather than from the span.
    const mapped = chordSpanToEditorChord(region.span, region.startPpq, region.endPpq);
    const rootPc = mapped.rootPc;
    const symbol: EstimatedChordSymbol = {
      ppq: region.startPpq,
      endPpq: region.endPpq,
      text: `${pitchClassName(rootPc, keyFifths)}${chordSuffix(mapped.quality, mapped.extensions, mapped.omissions)}`,
      rootPc,
      quality: mapped.quality,
    };
    if (mapped.extensions !== undefined && mapped.extensions.length > 0) {
      symbol.extensions = [...mapped.extensions];
    }
    if (mapped.omissions !== undefined && mapped.omissions.length > 0) {
      symbol.omissions = [...mapped.omissions];
    }
    const bassPc = regionBassPc(notes, region.startPpq, region.endPpq);
    if (bassPc !== null && bassPc !== rootPc) {
      symbol.text = `${symbol.text}/${pitchClassName(bassPc, keyFifths)}`;
      symbol.bassPc = bassPc;
    }
    out.push(symbol);
  }
  return out;
}

/** Editor ordinal of a chord whose quality is not named. */
const UNKNOWN_QUALITY = 9;

/** The editor chord an estimated symbol stands for; an unnamed quality is the unknown ordinal. */
function editorChord(chord: EstimatedChordSymbol, rootPc: number): EditorChordSymbol {
  const symbol: EditorChordSymbol = {
    startPpq: chord.ppq,
    endPpq: chord.endPpq,
    rootPc,
    quality: chord.quality ?? UNKNOWN_QUALITY,
  };
  if (chord.bassPc !== undefined) symbol.bassPc = chord.bassPc;
  if (chord.extensions !== undefined) symbol.extensions = [...chord.extensions];
  if (chord.omissions !== undefined) symbol.omissions = [...chord.omissions];
  if (chord.romanNumeral !== undefined) symbol.romanNumeral = chord.romanNumeral;
  return symbol;
}

/** PPQ keys are rounded at micro-PPQ resolution to absorb float round-trips. */
const KEY_PPQ_SCALE = 1e6;

/**
 * Round-trips estimated chord symbols through `Project.annotateChords` on a
 * scratch wasm Project and reads back the canonical annotation stream.
 *
 * The Project encoding folds the editor's qualities into the core's families
 * plus extension degrees; this function applies that conversion in each
 * direction. Display text and omitted tones are not stored by the Project, so
 * both are re-associated by start position from the symbols handed in.
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
      chords.map((chord) =>
        chord.rootPc === undefined
          ? { startPpq: chord.ppq, endPpq: chord.endPpq }
          : toProjectChordSymbol(editorChord(chord, chord.rootPc)),
      ),
    );
    const doc = readNativeDocument(scratch);
    const stored = doc.annotation?.chords;
    if (!Array.isArray(stored)) return [];
    const chordByStart = new Map(
      chords.map((chord) => [Math.round(chord.ppq * KEY_PPQ_SCALE), chord]),
    );
    const out: NotatedChordSymbol[] = [];
    for (const raw of stored) {
      const original = chordByStart.get(Math.round(raw.startPpq * KEY_PPQ_SCALE));
      if (original === undefined || original.rootPc === undefined) continue;
      const read = chordFromAnnotationEntry(raw, editorChord(original, original.rootPc));
      if (read === null) continue;
      const symbol: NotatedChordSymbol = {
        ppq: raw.startPpq,
        text: original.text,
        rootPc: read.rootPc,
      };
      if (original.quality !== undefined) symbol.quality = read.quality;
      if (read.bassPc !== undefined) symbol.bassPc = read.bassPc;
      if (read.extensions !== undefined) symbol.extensions = read.extensions;
      // The Project encoding has no field for omitted tones, so the round trip
      // cannot return them. The symbol that went in is still in hand, so the
      // read-back is seeded from it rather than losing the chord's shape.
      if (read.omissions !== undefined) symbol.omissions = read.omissions;
      if (read.romanNumeral !== undefined) symbol.romanNumeral = read.romanNumeral;
      out.push(symbol);
    }
    out.sort((a, b) => a.ppq - b.ppq);
    return out;
  } finally {
    scratch.destroy();
  }
}
