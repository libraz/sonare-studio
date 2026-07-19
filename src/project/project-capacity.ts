/**
 * Project-capacity checks: the engine addresses mixer strips and internal MIDI
 * instruments through fixed-width id spaces, so a project that grows past those
 * spaces silently loses telemetry or misroutes control. This module derives the
 * warnings from a project snapshot (pure, no engine or store access) so the UI
 * can surface them before the limits bite, instead of the enforcement sites
 * only logging to the console.
 *
 * The thresholds mirror the enforcement sites:
 *  - {@link MAX_INTERNAL_MIDI_INSTRUMENTS} — the internal MIDI instrument
 *    destination count in the MIDI sync (midi-sync.ts). Tracks past it are
 *    routed through an already-assigned destination, so they play the wrong
 *    instrument unless they happen to share one.
 *  - {@link MAX_METERED_MIXER_LANES} — the per-lane meter/scope target array
 *    (meter-targets.ts `MAX_LANE_METER_TARGETS`). Strips past it get no level
 *    meter or scope. A drift test locks the two together.
 *  - {@link MAX_MIXER_PARAM_LANES} — the lane byte in the packed mixer
 *    parameter id (engine-render-types.ts `laneParamId`). The byte is shared
 *    with reserved bus/master lane ids, so lanes at or past it collide with a
 *    bus or the master strip when automation or fader control is addressed.
 */

import {
  type ExternalMidiInstrument,
  effectiveTrackInstrument,
  instrumentDedupeKey,
} from './instrument';
import type { EditorTrack } from './types';

/** Internal MIDI instrument destinations the engine can address (midi-sync). */
export const MAX_INTERNAL_MIDI_INSTRUMENTS = 16;

/** Mixer lanes with a level meter / scope target (meter-targets `MAX_LANE_METER_TARGETS`). */
export const MAX_METERED_MIXER_LANES = 32;

/**
 * Mixer lanes safely addressable by packed parameter id before the lane byte
 * collides with a reserved bus/master lane id. The master occupies byte `255`
 * and buses occupy `254 - busId` (so the first bus is byte `253`); lane indices
 * count up from 0, so index `253` collides with the first bus. Indices `0..252`
 * are safe, i.e. 253 addressable lanes. (More buses push the collision lower,
 * so this is the ceiling, not a guarantee — it flags the clearly-unsafe case.)
 */
export const MAX_MIXER_PARAM_LANES = 253;

/** One project-capacity warning, as a structured code the UI formats to text. */
export type ProjectCapacityIssue =
  | { kind: 'mixer-lane-meters'; lanes: number; limit: number }
  | { kind: 'mixer-lane-param-id'; lanes: number; limit: number }
  | { kind: 'internal-midi-instruments'; overflowTracks: number; limit: number };

/**
 * Counts internal MIDI instrument destinations the same way the MIDI sync packs
 * them: each non-frozen internal-instrument MIDI track consumes one destination
 * slot until the limit is reached; past it, a track reuses a slot only when its
 * instrument matches an already-assigned one, otherwise it is misrouted.
 *
 * @returns The number of tracks that would be misrouted (0 when within budget).
 */
function midiInstrumentOverflowCount(
  tracks: ReadonlyArray<EditorTrack>,
  externalMidi: ExternalMidiInstrument | null | undefined,
  limit: number,
): number {
  const assignedKeys = new Set<string>();
  let slots = 0;
  let overflow = 0;
  for (const track of tracks) {
    if (track.kind !== 'midi' || track.frozen !== undefined) continue;
    const instrument = effectiveTrackInstrument(track, externalMidi);
    if (instrument.kind === 'external-midi') continue;
    const key = instrumentDedupeKey(instrument);
    if (slots < limit) {
      assignedKeys.add(key);
      slots += 1;
    } else if (!assignedKeys.has(key)) {
      overflow += 1;
    }
  }
  return overflow;
}

/**
 * Derives the capacity warnings for a project snapshot. Every editor track is a
 * mixer lane (the mixer sync assigns lane ids over `store.tracks`), so the lane
 * count is the track count. Returns an empty array when the project is within
 * every budget.
 *
 * @param tracks The project's editor tracks.
 * @param externalMidi The project-level External MIDI route, for instrument
 *   inheritance when a track opts into project mode.
 */
export function evaluateProjectCapacity(
  tracks: ReadonlyArray<EditorTrack>,
  externalMidi?: ExternalMidiInstrument | null,
): ProjectCapacityIssue[] {
  const issues: ProjectCapacityIssue[] = [];
  const lanes = tracks.length;

  // Param-id collision is the most severe (control misroutes to a bus/master).
  if (lanes > MAX_MIXER_PARAM_LANES) {
    issues.push({ kind: 'mixer-lane-param-id', lanes, limit: MAX_MIXER_PARAM_LANES });
  }
  if (lanes > MAX_METERED_MIXER_LANES) {
    issues.push({ kind: 'mixer-lane-meters', lanes, limit: MAX_METERED_MIXER_LANES });
  }

  const overflowTracks = midiInstrumentOverflowCount(
    tracks,
    externalMidi,
    MAX_INTERNAL_MIDI_INSTRUMENTS,
  );
  if (overflowTracks > 0) {
    issues.push({
      kind: 'internal-midi-instruments',
      overflowTracks,
      limit: MAX_INTERNAL_MIDI_INSTRUMENTS,
    });
  }
  return issues;
}

/** The i18n templates {@link formatProjectCapacityIssue} fills in. */
export interface ProjectCapacityStrings {
  mixerLaneMeters: string;
  mixerLaneParamId: string;
  internalMidiInstruments: string;
}

/**
 * Formats one capacity issue to display text via the supplied i18n templates.
 * Pure: the caller passes the reactive i18n slice; this never reads a store or
 * global. Unknown kinds fall through to an empty string (forward-compatible).
 */
export function formatProjectCapacityIssue(
  issue: ProjectCapacityIssue,
  strings: ProjectCapacityStrings,
): string {
  switch (issue.kind) {
    case 'mixer-lane-param-id':
      return strings.mixerLaneParamId
        .replace('{lanes}', String(issue.lanes))
        .replace('{limit}', String(issue.limit));
    case 'mixer-lane-meters':
      return strings.mixerLaneMeters
        .replace('{lanes}', String(issue.lanes))
        .replace('{limit}', String(issue.limit));
    case 'internal-midi-instruments':
      return strings.internalMidiInstruments
        .replace('{tracks}', String(issue.overflowTracks))
        .replace('{limit}', String(issue.limit));
    default: {
      const exhaustive: never = issue;
      return String(exhaustive);
    }
  }
}
