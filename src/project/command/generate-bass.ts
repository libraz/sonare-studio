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
import type { EditorChordSymbol } from '../chords';
import { trackProvenance } from '../generation';
import { useProjectStore } from '../store';
import { commitTrackPlan, materializeNote, type TrackPlan } from './generate-track';

/** NativeSynth preset for generated bass tracks. */
const BASS_PRESET = 'sub-bass';

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
 * Builds the bass-track plan for a new track without writing to the Project.
 *
 * @returns The plan, or null when there is no chord track / no notes.
 */
export function buildBassPlan(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateBassParams = {},
  chords: ReadonlyArray<EditorChordSymbol> = store.chords,
): TrackPlan | null {
  if (chords.length === 0) return null;

  const key = effectiveKeyScale(store.scaleHighlight);
  const segments: BassSegment[] = chords.map((symbol) => ({
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
    ctx: { seed: params.seed ?? 0 },
  });

  const notes = noteEventsToNewEditorNotes(events, { channel: 0 }).map(materializeNote);
  if (notes.length === 0) return null;
  return {
    name: 'Bass',
    notes,
    lengthPpq,
    preset: BASS_PRESET,
    provenance: trackProvenance('bass', params.seed ?? 0),
  };
}

/**
 * Generates a bass line following the project chord track.
 *
 * @param params Generation options (see {@link GenerateBassParams}).
 * @returns The number of bass notes written (0 when there is no chord track).
 */
export function generateBassLineCommand(params: GenerateBassParams = {}): number {
  const store = useProjectStore();
  const plan = buildBassPlan(store, params);
  if (plan === null) return 0;

  return commitTrackPlan(store, plan);
}
