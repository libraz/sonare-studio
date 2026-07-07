/**
 * Bass-line generation command.
 *
 * Follows the project chord track with libcantus's `generateBassLine`, laying
 * the result on a new track. Segments come straight from the chord stream (one
 * per chord region), so the bass tracks the harmony; the walking style also
 * uses the key for diatonic approach tones. Output is deterministic in `seed`.
 *
 * Requires a chord track — with no chords there is nothing to follow and the
 * command is a no-op.
 */

import { type BassLineOptions, type BassSegment, generateBassLine } from '@libraz/libcantus';
import { editorChordToChord } from '@/compose/chord-io';
import { effectiveKeyScale } from '@/compose/key';
import { noteEventsToNewEditorNotes } from '@/compose/notes-io';
import { useProjectStore } from '../store';
import { addGeneratedTrack, EDITS_PER_TRACK, materializeNote } from './generate-track';
import { execute } from './history';

/** Options for {@link generateBassLineCommand}. */
export interface GenerateBassParams {
  /** Bass idiom (default 'root'). */
  style?: BassLineOptions['style'];
  /** Target register as a base MIDI octave (default 2). */
  octave?: number;
  /** Deterministic seed (default 0). */
  seed?: number;
}

/**
 * Generates a bass line following the project chord track.
 *
 * @param params Generation options (see {@link GenerateBassParams}).
 * @returns The number of bass notes written (0 when there is no chord track).
 */
export function generateBassLineCommand(params: GenerateBassParams = {}): number {
  const store = useProjectStore();
  if (store.chords.length === 0) return 0;

  const key = effectiveKeyScale(store.scaleHighlight);
  const segments: BassSegment[] = store.chords.map((symbol) => ({
    startBeat: symbol.startPpq,
    endBeat: symbol.endPpq,
    chord: editorChordToChord(symbol),
  }));
  const lengthPpq = segments.reduce((max, segment) => Math.max(max, segment.endBeat), 0);

  const events = generateBassLine({
    segments,
    key,
    ...(params.style !== undefined ? { style: params.style } : {}),
    ...(params.octave !== undefined ? { octave: params.octave } : {}),
    seed: params.seed ?? 0,
  });

  const notes = noteEventsToNewEditorNotes(events, { channel: 0 }).map(materializeNote);
  if (notes.length === 0) return 0;

  execute(EDITS_PER_TRACK, () =>
    addGeneratedTrack(store, { name: 'Bass', notes, startPpq: 0, lengthPpq }),
  );
  return notes.length;
}
