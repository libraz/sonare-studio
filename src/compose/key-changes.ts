/**
 * Detects likely key changes from the notes actually sounding and proposes
 * them as `Key:` markers.
 *
 * The search reuses {@link buildVoiceLines}'s harmonic note pool (see the
 * caller) so a proposal reads the same notes every other theory surface does,
 * then keeps only the regions that disagree with the key in effect there: the
 * project's key map, overridden by the proposals before it until the next
 * existing marker. A return to the home key after a modulation is therefore
 * proposed, and the map may carry a marker the timeline search cannot see.
 *
 * Pure module (no Vue/Pinia).
 */

import {
  formatKeyName,
  isMinorKey,
  type KeyScale,
  keyTimelineFromNotes,
  type NoteEvent,
} from '@libraz/libcantus';
import { meterBarLengthPpq, timeSignatureAt, toMeterMap } from '@/project/time-signature';
import type { TimeSignatureSegment } from '@/project/types';
import { type KeyMap, sameKeyName } from './key-map';
import type { VoiceLine } from './voice-context';

/** One detected key change not already reflected by the project's key map. */
export interface KeyChangeProposal {
  /** Absolute PPQ where the detected key region begins. */
  startPpq: number;
  /** The detected key. */
  key: KeyScale;
  /** Display name for the dialog, e.g. "G major". */
  label: string;
  /**
   * Initial checkbox state in the dialog. False only for the timeline's first
   * region: the search runs before any markers exist to anchor it, so a
   * mismatch in the opening bars is as likely to be an under-established
   * intro as a real key (decision D23). Every later region defaults to
   * selected.
   */
  selected: boolean;
}

/**
 * Proposes `Key:` marker positions from `lines`' notes, filtered to positions
 * where the detected key differs from the key in force there once the earlier
 * proposals are applied to `keyMap`.
 *
 * @param lines Harmonic voice lines built with {@link buildVoiceLines} across
 *   every track, not scoped to one clip.
 * @param timeSignatures The project's time-signature segments.
 * @param keyMap The project's current key map (declared key plus any `Key:`
 *   markers), used to filter out regions that already agree with it.
 */
export function proposeKeyChanges(
  lines: ReadonlyArray<VoiceLine>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
  keyMap: KeyMap,
): KeyChangeProposal[] {
  const notes: NoteEvent[] = lines.flatMap((line) =>
    line.notes.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startPpq,
      durationBeat: note.durationPpq,
      velocity: note.velocity,
    })),
  );
  if (notes.length === 0) return [];

  const barBeats = meterBarLengthPpq(timeSignatureAt(timeSignatures, 0));
  const regions = keyTimelineFromNotes(notes, {
    meters: toMeterMap(timeSignatures),
    minKeyBeats: 2 * barBeats,
  });

  const markerStarts = keyMap.regions
    .filter((region) => region.source === 'marker')
    .map((region) => region.startPpq);
  const proposals: KeyChangeProposal[] = [];
  regions.forEach((region, index) => {
    // An earlier proposal holds until an existing marker takes over after it.
    const previous = proposals[proposals.length - 1];
    const overridden =
      previous !== undefined &&
      !markerStarts.some((start) => start > previous.startPpq && start <= region.startBeat);
    const inForce = overridden ? previous.key : keyMap.at(region.startBeat);
    if (inForce !== null && sameKeyName(inForce, region.key.scale)) return;
    const tonic = region.key.tonic;
    const mode = isMinorKey(region.key.scale) ? 'minor' : 'major';
    proposals.push({
      startPpq: region.startBeat,
      key: region.key.scale,
      label: formatKeyName({ tonic, mode }),
      selected: index !== 0,
    });
  });
  return proposals;
}
