/**
 * Backing (chord voicing) generation command.
 *
 * Realizes the project chord track as sustained voicings on a new track. Two
 * voicing modes are offered:
 *  - 'smooth' uses libcantus's `voiceProgression` for four-voice SATB voicings
 *    with minimal voice-leading motion between chords;
 *  - a tertian style ('close'/'drop2'/'drop3'/'shell'/'rootless') voices each
 *    chord independently with `voiceChordStyled`.
 *
 * Each chord region contributes one held note per voice, spanning the chord's
 * PPQ span. Requires a chord track; with no chords the command is a no-op.
 */

import {
  type ChordData,
  type KeyScale,
  type VoicingStyle,
  voiceChordStyled,
  voiceProgression,
} from '@libraz/libcantus';
import { editorChordToChord } from '@/compose/chord-io';
import type { EditorChordSymbol } from '../chords';
import { trackProvenance } from '../generation';
import type { RawNote } from '../midi-events';
import { useProjectStore } from '../store';
import { commitTrackPlan, type TrackPlan } from './generate-track';
import { generationKeyAt } from './generation-key';

/** Backing voicing mode: smooth SATB leading, or a fixed tertian style. */
export type BackingStyle = 'smooth' | VoicingStyle;

/** Default note-on velocity for backing voicings (softer than a lead). */
const BACKING_VELOCITY = 72;

/** NativeSynth preset for generated backing tracks (sustained chord voicings). */
const BACKING_PRESET = 'warm-pad';

/** Options for {@link generateBackingCommand}. */
export interface GenerateBackingParams {
  /** Voicing mode (default 'smooth'). */
  style?: BackingStyle;
  /** Base octave for styled voicings (default 4). */
  octave?: number;
}

/** Clamps a MIDI pitch to the representable range. */
function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

/**
 * Builds the per-chord voicings for the chord regions.
 *
 * The smooth mode is given the project's key: without it the voicer works from
 * chord structure and motion alone, leaving leading tones doubled or
 * unresolved. A key the music does not bear out costs nothing — its rules only
 * fire on that key's own leading tone and sevenths, so the result falls back to
 * the keyless one. Styled voicings are per-chord stacks and take no key.
 *
 * @throws When a chord admits no voicing in the requested ranges (libcantus
 *   `voiceProgression`/`voiceChordStyled` throw); callers surface it.
 */
function voicingsFor(
  chords: ChordData[],
  params: GenerateBackingParams,
  key: KeyScale,
): number[][] {
  const style = params.style ?? 'smooth';
  if (style === 'smooth') return voiceProgression(chords, { key });
  return chords.map((chord) =>
    voiceChordStyled(chord, {
      style,
      ...(params.octave !== undefined ? { octave: params.octave } : {}),
    }),
  );
}

/**
 * Builds the backing-track plan for a new track without writing to the Project.
 *
 * @returns The plan, or null when there is no chord track / no notes.
 * @throws When a chord cannot be voiced in the requested ranges.
 */
export function buildBackingPlan(
  store: ReturnType<typeof useProjectStore>,
  params: GenerateBackingParams = {},
  chordSymbols: ReadonlyArray<EditorChordSymbol> = store.chords,
): TrackPlan | null {
  if (chordSymbols.length === 0) return null;

  const regions = [...chordSymbols].sort((a, b) => a.startPpq - b.startPpq);
  const chords = regions.map(editorChordToChord);
  const voicings = voicingsFor(chords, params, generationKeyAt(store, regions[0].startPpq));

  const notes: RawNote[] = [];
  regions.forEach((region, index) => {
    const duration = region.endPpq - region.startPpq;
    if (duration <= 0) return;
    for (const pitch of voicings[index] ?? []) {
      notes.push({
        pitch: clampPitch(pitch),
        startPpq: region.startPpq,
        durationPpq: duration,
        velocity: BACKING_VELOCITY,
        channel: 0,
      });
    }
  });
  if (notes.length === 0) return null;

  const lengthPpq = regions.reduce((max, region) => Math.max(max, region.endPpq), 0);
  // The backing voicing is deterministic, so its record carries no seed of
  // its own; the part and the algorithm version are what reproduce it.
  return {
    name: 'Backing',
    notes,
    lengthPpq,
    preset: BACKING_PRESET,
    provenance: trackProvenance('backing', 0),
  };
}

/**
 * Generates a backing track from the project chord track.
 *
 * @param params Voicing options (see {@link GenerateBackingParams}).
 * @returns The number of notes written (0 when there is no chord track).
 * @throws When a chord cannot be voiced in the requested ranges.
 */
export function generateBackingCommand(params: GenerateBackingParams = {}): number {
  const store = useProjectStore();
  const plan = buildBackingPlan(store, params);
  if (plan === null) return 0;

  return commitTrackPlan(store, plan);
}
