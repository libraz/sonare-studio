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
  type VoicingStyle,
  voiceChordStyled,
  voiceProgression,
} from '@libraz/libcantus';
import { editorChordToChord } from '@/compose/chord-io';
import type { RawNote } from '../midi-events';
import { useProjectStore } from '../store';
import { addGeneratedTrack, EDITS_PER_TRACK } from './generate-track';
import { execute } from './history';

/** Backing voicing mode: smooth SATB leading, or a fixed tertian style. */
export type BackingStyle = 'smooth' | VoicingStyle;

/** Default note-on velocity for backing voicings (softer than a lead). */
const BACKING_VELOCITY = 72;

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
 * @throws When a chord admits no voicing in the requested ranges (libcantus
 *   `voiceProgression`/`voiceChordStyled` throw); callers surface it.
 */
function voicingsFor(chords: ChordData[], params: GenerateBackingParams): number[][] {
  const style = params.style ?? 'smooth';
  if (style === 'smooth') return voiceProgression(chords);
  return chords.map((chord) =>
    voiceChordStyled(chord, {
      style,
      ...(params.octave !== undefined ? { octave: params.octave } : {}),
    }),
  );
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
  if (store.chords.length === 0) return 0;

  const regions = [...store.chords].sort((a, b) => a.startPpq - b.startPpq);
  const chords = regions.map(editorChordToChord);
  const voicings = voicingsFor(chords, params);

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
  if (notes.length === 0) return 0;

  const lengthPpq = regions.reduce((max, region) => Math.max(max, region.endPpq), 0);
  execute(EDITS_PER_TRACK, () =>
    addGeneratedTrack(store, { name: 'Backing', notes, startPpq: 0, lengthPpq }),
  );
  return notes.length;
}
