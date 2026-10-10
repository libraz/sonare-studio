import type { NotatedVoiceNumber } from '@/notation/model';
import type { MidiSourceIdentity } from '@/project/midi-projection';

/** Comparison tolerance for PPQ arithmetic on IEEE doubles. */
export const EPSILON = 1e-6;

/** A chord-clustered unit before measure/duration splitting. */
export interface VoiceUnit {
  /** MIDI pitches, ascending, deduplicated. */
  pitches: number[];
  startPpq: number;
  endPpq: number;
  /** Source MIDI channels merged into this unit (ascending, deduplicated). */
  channels: number[];
  /** Representative source note-on velocity for display accents. */
  velocity: number;
  /** Editor note ids merged into this unit (ascending, deduplicated). */
  ids: number[];
  /** Composite source identities merged into this unit. */
  sourceIdentities?: MidiSourceIdentity[];
  /**
   * Estimated per-pitch fingering (1-5), index-aligned with {@link pitches}.
   * Set only when fingering estimation runs; otherwise absent.
   */
  fingering?: number[];
  /**
   * True when the unit is engraved on the staff opposite its pitch center on a
   * grand staff. Set only when fingering estimation runs; otherwise absent.
   */
  handCross?: boolean;
}

export interface AssignedVoiceUnits {
  voice: NotatedVoiceNumber;
  staff?: 1 | 2;
  units: VoiceUnit[];
}

/** Mean MIDI pitch of a pitch list (used as the voice-proximity metric). */
export function meanPitch(pitches: number[]): number {
  let sum = 0;
  for (const p of pitches) sum += p;
  return sum / pitches.length;
}
