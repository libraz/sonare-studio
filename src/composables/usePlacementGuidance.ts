/**
 * Placement guidance for the pencil tool: the safe/warn/ng verdicts for the
 * column of pitches a click would write at the hovered or drawn cell.
 *
 * Reuses the same building blocks as `useCompositionGuidance` (voice lines,
 * chord timeline, key map) but reads only the edited clip's own notes plus
 * the cell being placed, so the expensive column evaluation reruns only when
 * one of its actual inputs changes rather than on every hover tick. The cell
 * and the constructed inputs are split into their own computeds specifically
 * so that a re-hover landing on the same cell, or a store change unrelated to
 * this surface, leaves the cached column untouched.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { buildChordTimeline } from '@/compose/chord-at-tick';
import { buildKeyMap } from '@/compose/key-map';
import { evaluatePlacementColumn, type PlacementVerdict } from '@/compose/placement';
import { harmonicNotes, isDrumTrack } from '@/compose/tracks';
import { buildVoiceContext, buildVoiceLines } from '@/compose/voice-context';
import { audibleMidiProjector, midiSourcePpqToTimeline } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';

/** Lowest and highest MIDI pitch a placement column ever covers. */
const PITCH_LOW = 0;
const PITCH_HIGH = 127;

/** The placement cell's verdicts, in the cell's own (source-relative) frame. */
export interface PlacementColumn {
  startPpq: number;
  endPpq: number;
  verdicts: PlacementVerdict[];
}

/**
 * Builds the reactive placement-guidance column for a candidate cell in the
 * active clip's source frame.
 *
 * @param placementCell The cell the pencil would write, in source-relative
 *   PPQ (see `usePlacementCell`); null while nothing is hovered or drawn.
 */
export function usePlacementGuidance(
  placementCell: Ref<{ startPpq: number; lengthPpq: number } | null>,
): ComputedRef<PlacementColumn | null> {
  const store = useProjectStore();
  const appSettings = useAppSettings();

  const editedClip = computed(() => store.activeClip);
  const editedTrack = computed(() => {
    const clip = editedClip.value;
    if (clip === null) return null;
    return store.tracks.find((entry) => entry.id === clip.trackId) ?? null;
  });

  /** Whether the surface applies at all, independent of the hovered cell. */
  const eligible = computed(() => {
    if (!appSettings.settings.pianoRollPlacementGuide) return false;
    const clip = editedClip.value;
    const track = editedTrack.value;
    if (clip === null || track === null) return false;
    if (track.frozen !== undefined) return false;
    if (clipKind(clip) !== 'midi') return false;
    const trackNotes = (store.clipsByTrack.get(track.id) ?? []).flatMap((entry) => entry.notes);
    return !isDrumTrack(track, trackNotes);
  });

  // Read as separate primitive computeds so a re-hover that lands on the same
  // cell (a new object with the same fields) does not read as a change: Vue
  // compares a computed's own value, not the source ref it was read from.
  const cellStartPpq = computed(() => placementCell.value?.startPpq ?? null);
  const cellLengthPpq = computed(() => placementCell.value?.lengthPpq ?? null);

  /** The cell's start in absolute PPQ, converting through the clip's trim. */
  const absoluteStartPpq = computed(() => {
    const clip = editedClip.value;
    const start = cellStartPpq.value;
    if (clip === null || start === null) return null;
    return midiSourcePpqToTimeline(clip, start);
  });

  /** The edited clip's own notes, in absolute PPQ, percussion channel dropped. */
  const activeNotes = computed(() => {
    const clip = editedClip.value;
    const track = editedTrack.value;
    if (clip === null || track === null) return [];
    const notes = audibleMidiProjector(clip, { expandLoops: false }).map((entry) => ({
      ...entry.note,
      startPpq: entry.timelineStartPpq,
      durationPpq: entry.durationPpq,
    }));
    return harmonicNotes(track, notes);
  });

  /** Every other non-percussion track, loops expanded, as it actually sounds. */
  const voiceLines = computed(() => {
    const clip = editedClip.value;
    if (clip === null) return [];
    return buildVoiceLines(store.tracks, store.clipsByTrack, clip.trackId);
  });

  const chordTimeline = computed(() => buildChordTimeline(store.chords));
  const keyMap = computed(() => buildKeyMap(store.scaleHighlight, store.markers));
  const pitchRange = computed(() => editedTrack.value?.pitchRange);

  /** Accompaniment tracks following the edited track. */
  const followerTrackIds = computed(() => {
    const clip = editedClip.value;
    if (clip === null) return new Set<number>();
    const ids = new Set<number>();
    for (const track of store.tracks) {
      if (track.leadFollow?.leadTrackId === clip.trackId) ids.add(track.id);
    }
    return ids;
  });

  return computed<PlacementColumn | null>(() => {
    if (!eligible.value) return null;
    const startPpq = cellStartPpq.value;
    const lengthPpq = cellLengthPpq.value;
    const absStart = absoluteStartPpq.value;
    if (startPpq === null || lengthPpq === null || absStart === null) return null;
    const voices = buildVoiceContext(voiceLines.value, [absStart], store.timeSignatures);
    const verdicts = evaluatePlacementColumn(
      {
        startPpq: absStart,
        lengthPpq,
        activeNotes: activeNotes.value,
        voices,
        chords: chordTimeline.value,
        keyMap: keyMap.value,
        timeSignatures: store.timeSignatures,
        profile: appSettings.settings.guidanceProfile,
        ...(pitchRange.value !== undefined ? { pitchRange: pitchRange.value } : {}),
        followerTrackIds: followerTrackIds.value,
      },
      PITCH_LOW,
      PITCH_HIGH,
    );
    return { startPpq, endPpq: startPpq + lengthPpq, verdicts };
  });
}
