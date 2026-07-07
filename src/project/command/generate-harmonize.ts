/**
 * Melody-harmonization command.
 *
 * Takes the active MIDI clip's melody and derives a chord progression for it
 * with libcantus's `harmonizeMelody` (a Viterbi search over diatonic and,
 * optionally, secondary-dominant / borrowed candidates), writing the result to
 * the project chord track.
 *
 * The melody is reduced to a single voice first ({@link topVoiceOnly}): a clip
 * that carries accompaniment chord tones alongside the tune would otherwise
 * skew key inference and let inner voices be scored as melody. Notes are placed
 * on the shared timeline (clip start added) so the returned chord spans land at
 * absolute PPQ positions.
 *
 * When `transpose` is enabled and the search picks a non-zero shift, the clip's
 * notes are transposed to match the harmonization (clamped to the MIDI range)
 * inside the same undoable edit — chord write plus note write, so undo reverts
 * both at once. Without a transpose the chords match the melody as-is and only
 * the chord track changes.
 */

import { type HarmonizeResult, harmonizeMelody, type KeyScale } from '@libraz/libcantus';
import { chordSpanToEditorChord } from '@/compose/chord-io';
import { scaleHighlightToKeyScale } from '@/compose/key';
import { editorNotesToNoteEvents } from '@/compose/notes-io';
import { topVoiceOnly } from '@/compose/tracks';
import { type EditorChordSymbol, sanitizeChordSymbols, toProjectChordSymbols } from '../chords';
import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { execute } from './history';

/** Reharmonization strength passed through to libcantus. */
export type ReharmonizeStrength = 'diatonic' | 'secondaryDominant' | 'borrowed';

/** Options for {@link harmonizeFromMelodyCommand}. */
export interface HarmonizeFromMelodyParams {
  /**
   * Key context. `'infer'` lets libcantus detect the key from the melody;
   * omitted uses the project key when a scale is set, otherwise `'infer'`.
   */
  key?: KeyScale | 'infer';
  /** Beats per chord segment (default 4 = one chord per 4/4 bar). */
  harmonicRhythm?: number;
  /** Candidate pool strength (default 'diatonic'). */
  reharmonize?: ReharmonizeStrength;
  /**
   * Search transposes/octave-shifts of the melody for a better-fitting
   * placement and applies the chosen shift to the clip (default false, i.e. the
   * melody is left untouched and chords match it as played).
   */
  transpose?: boolean;
  /** Deterministic tie-break seed (default 0). */
  seed?: number;
}

/** Clamps a MIDI pitch to the representable range. */
function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

/**
 * Converts the harmonization's chord path to editor chord symbols over absolute
 * PPQ regions. Each span runs to the next span's start; the last runs to the
 * melody's end.
 */
function spansToChordSymbols(result: HarmonizeResult, melodyEndBeat: number): EditorChordSymbol[] {
  const spans = [...result.chords].sort((a, b) => a.startBeat - b.startBeat);
  return spans.map((span, index) => {
    const startPpq = span.startBeat;
    const endPpq = index + 1 < spans.length ? spans[index + 1].startBeat : melodyEndBeat;
    return chordSpanToEditorChord(span, startPpq, endPpq);
  });
}

/**
 * Harmonizes the active MIDI clip's melody into the project chord track.
 *
 * @param params Harmonization options (see {@link HarmonizeFromMelodyParams}).
 * @returns The number of chords written, or 0 when the active clip has no notes.
 * @throws Error when there is no active clip.
 */
export function harmonizeFromMelodyCommand(params: HarmonizeFromMelodyParams = {}): number {
  const store = useProjectStore();
  const clip = store.activeClip;
  if (clip === null) throw new Error('No active clip to harmonize');
  if (clip.notes.length === 0) return 0;

  const melody = topVoiceOnly(editorNotesToNoteEvents(clip.notes, clip.startPpq));
  if (melody.length === 0) return 0;
  const melodyEndBeat = melody.reduce(
    (max, note) => Math.max(max, note.startBeat + note.durationBeat),
    0,
  );

  const key =
    params.key ??
    (store.scaleHighlight.enabled ? scaleHighlightToKeyScale(store.scaleHighlight) : 'infer');
  const transpose = params.transpose ?? false;

  const result = harmonizeMelody({
    melody,
    key,
    harmonicRhythm: params.harmonicRhythm ?? 4,
    reharmonize: params.reharmonize ?? 'diatonic',
    placement: { transposeSearch: transpose, octaveSearch: transpose },
    seed: params.seed ?? 0,
  });

  const chords = spansToChordSymbols(result, melodyEndBeat);
  const sanitized = sanitizeChordSymbols(chords);
  const shift = transpose ? result.transposeSemitones : 0;
  const project = getProject();

  if (shift === 0) {
    execute(1, () => {
      project.annotateChords(toProjectChordSymbols(sanitized));
      store.refresh();
    });
    return sanitized.length;
  }

  // Transpose the clip to match the harmonization, and write both the shifted
  // notes and the chords in one undoable edit (setMidiEvents + annotateChords).
  const shifted: RawNote[] = clip.notes.map(({ id: _id, ...note }) => ({
    ...note,
    pitch: clampPitch(note.pitch + shift),
  }));
  execute(2, () => {
    project.setMidiEvents(clip.id, notesToProjectEvents(shifted));
    project.annotateChords(toProjectChordSymbols(sanitized));
    store.refresh();
  });
  return sanitized.length;
}
