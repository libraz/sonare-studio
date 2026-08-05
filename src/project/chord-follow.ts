/**
 * Chord-track follow: keeping MIDI parts in step with the chord track.
 *
 * A track opted into follow re-voices itself whenever the chord track changes.
 * The mapping is relative, not absolute: a note is transposed by the interval
 * between the chord that governed it before the edit and the one governing it
 * after, then pulled onto the nearest tone of the new chord. Trying one
 * progression after another therefore keeps each part's shape and register,
 * and a single undo restores both the chords and the notes because the chord
 * command applies them in one transaction.
 *
 * Pure data module: no store, no wasm, no history.
 */

import { chordTonePitchClasses, type EditorChordSymbol } from './chords';

/** How a track tracks the chord track. */
export type ChordFollowMode =
  /** Transpose by the chord-root change, then snap to the new chord's tones. */
  | 'chordTones'
  /** Same, but every note lands on the chord's root/bass pitch class. */
  | 'root';

/** One note to re-voice, addressed by editor id. */
export interface ChordFollowNote {
  id: number;
  pitch: number;
  /** Absolute timeline position used to look the governing chord up. */
  timelinePpq: number;
}

/** Signed shortest interval between two pitch classes, in -6..+5 semitones. */
export function shortestPitchClassDelta(fromPc: number, toPc: number): number {
  const raw = (((toPc - fromPc) % 12) + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/** The chord covering a timeline position, or null outside every region. */
export function chordAt(
  chords: readonly EditorChordSymbol[],
  ppq: number,
): EditorChordSymbol | null {
  for (const chord of chords) {
    if (ppq >= chord.startPpq && ppq < chord.endPpq) return chord;
  }
  return null;
}

/**
 * Moves a pitch to the nearest member of a pitch-class set. Ties resolve
 * upward, matching the way a player fills a chord from below.
 *
 * @param pitch MIDI pitch to move.
 * @param pitchClasses Allowed pitch classes (non-empty).
 */
export function snapPitchToPitchClasses(pitch: number, pitchClasses: readonly number[]): number {
  if (pitchClasses.length === 0) return pitch;
  const allowed = new Set(pitchClasses.map((pc) => ((pc % 12) + 12) % 12));
  for (let distance = 0; distance <= 6; distance += 1) {
    const up = pitch + distance;
    if (up <= 127 && allowed.has(((up % 12) + 12) % 12)) return up;
    const down = pitch - distance;
    if (down >= 0 && allowed.has(((down % 12) + 12) % 12)) return down;
  }
  return pitch;
}

/** Pitch classes a follow mode allows under one chord. */
function targetPitchClasses(chord: EditorChordSymbol, mode: ChordFollowMode): number[] {
  if (mode === 'root') return [chord.bassPc ?? chord.rootPc];
  return chordTonePitchClasses(chord);
}

/**
 * Re-voices notes for a chord-track edit.
 *
 * @param notes Notes of the following tracks with their timeline positions.
 * @param before Chord track as it was before the edit.
 * @param after Chord track as it will be after the edit.
 * @param mode Follow mode of the note's track.
 * @returns Pitch updates for the notes that actually move.
 */
export function chordFollowUpdates(
  notes: readonly ChordFollowNote[],
  before: readonly EditorChordSymbol[],
  after: readonly EditorChordSymbol[],
  mode: ChordFollowMode = 'chordTones',
): Array<{ id: number; pitch: number }> {
  const updates: Array<{ id: number; pitch: number }> = [];
  for (const note of notes) {
    const target = chordAt(after, note.timelinePpq);
    if (target === null) continue;
    const source = chordAt(before, note.timelinePpq);
    const transposed =
      source === null
        ? note.pitch
        : note.pitch + shortestPitchClassDelta(source.rootPc, target.rootPc);
    const pitch = Math.max(
      0,
      Math.min(127, snapPitchToPitchClasses(transposed, targetPitchClasses(target, mode))),
    );
    if (pitch !== note.pitch) updates.push({ id: note.id, pitch });
  }
  return updates;
}
