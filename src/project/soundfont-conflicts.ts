/**
 * Shared SoundFont-slot analysis for live sync, export and the SF2 picker.
 *
 * The current engine has one global loaded SoundFont. Multiple active MIDI
 * tracks may bind SF2 players, but they all read whichever font was loaded
 * last, so every caller must detect the same contention deterministically.
 */

import type { TrackInstrument } from './instrument';

/** Minimal track shape needed to decide whether an SF2 font participates. */
export interface SoundFontUsageTrack {
  /** Track id, retained for UI/debug callers that need to map results back. */
  id?: number | string;
  /** Only MIDI tracks can request SF2 playback. */
  kind: string;
  /** Frozen tracks play their baked asset and do not touch the global slot. */
  frozen?: unknown;
  /** Track instrument when no custom resolver is needed. */
  instrument?: TrackInstrument;
}

/** Active SoundFont-slot usage in track order. */
export interface ActiveSoundFontUsage {
  /** Distinct active font ids, ordered by first appearance. */
  fontIds: string[];
  /** Last active SF2 font in track order; this wins the single global slot. */
  winningFontId?: string;
}

/**
 * Collects active SF2 font ids and the deterministic winning font.
 *
 * @param tracks Tracks in project/render order.
 * @param resolveInstrument Optional resolver for effective instruments.
 */
export function collectActiveSoundFontUsage<T extends SoundFontUsageTrack>(
  tracks: ReadonlyArray<T>,
  resolveInstrument: (track: T) => TrackInstrument | undefined = (track) => track.instrument,
): ActiveSoundFontUsage {
  const fontIds = new Set<string>();
  let winningFontId: string | undefined;
  for (const track of tracks) {
    if (track.kind !== 'midi' || track.frozen !== undefined) continue;
    const instrument = resolveInstrument(track);
    if (instrument?.kind !== 'sf2') continue;
    fontIds.add(instrument.fontId);
    winningFontId = instrument.fontId;
  }
  return { fontIds: [...fontIds], winningFontId };
}

/** True when active MIDI tracks request more fonts than the engine can hold. */
export function hasSoundFontSlotConflict(usage: ActiveSoundFontUsage): boolean {
  return usage.fontIds.length > 1;
}
