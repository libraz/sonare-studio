/**
 * What the track generator can draw on — the chord progression, the active
 * MIDI clip and the project's editable MIDI clips — and which parts that
 * leaves blocked.
 */

import { type ComputedRef, computed } from 'vue';
import { harmonicNotes, isDrumTrack } from '@/compose/tracks';
import type { TrackPart } from '@/project/commands';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { barsBetweenPpq } from '@/project/time-signature';
import { clipKind, type EditorClip } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import type { Messages } from '@/ui/i18n';

/** Configuration for {@link useTrackGenerateSources}. */
export interface UseTrackGenerateSourcesOptions {
  /** The track generator's message table. */
  g: ComputedRef<Messages['shell']['generate']['track']>;
}

/** Generator sources returned by {@link useTrackGenerateSources}. */
export interface TrackGenerateSources {
  /** Chord progression length in whole bars (0 when there is no chord track). */
  chordProgressionBars: ComputedRef<number>;
  /** Active editable MIDI clip (enables motif's clip targets). */
  activeMidiClip: ComputedRef<EditorClip | null>;
  /** True when the active editable MIDI clip belongs to a percussion track. */
  activeClipIsDrum: ComputedRef<boolean>;
  /** Active MIDI clip's melody length in bars, or null when none is active. */
  counterBars: ComputedRef<number | null>;
  /** Whether the project has a chord progression. */
  hasChords: ComputedRef<boolean>;
  /** Whether any MIDI clip on an unfrozen track exists. */
  hasEditableMidiClip: ComputedRef<boolean>;
  /** Whether the generator has chords or a melody clip to work from. */
  hasGeneratorSource: ComputedRef<boolean>;
  /** Whether the counter melody has a source clip. */
  counterAvailable: ComputedRef<boolean>;
  /** Why a part cannot be generated right now, or null when it can. */
  partBlocked(part: TrackPart): string | null;
  /** Whether a part can be generated right now. */
  isPartAvailable(part: TrackPart): boolean;
}

/**
 * Derives the generator's sources from the project store.
 *
 * @param options - The message table the block reasons come from.
 * @returns The sources and the per-part availability they imply.
 */
export function useTrackGenerateSources(
  options: UseTrackGenerateSourcesOptions,
): TrackGenerateSources {
  const { g } = options;
  const store = useProjectStore();

  /** Chord progression length in whole bars (0 when there is no chord track). */
  const chordProgressionBars = computed(() => {
    const end = store.chords.reduce((max, chord) => Math.max(max, chord.endPpq), 0);
    return Math.max(0, Math.round(barsBetweenPpq(store.timeSignatures, 0, end)));
  });

  /** Active editable MIDI clip (enables motif's clip targets). */
  const activeMidiClip = computed(() => {
    const clip = store.activeClip;
    const track = clip ? store.tracks.find((entry) => entry.id === clip.trackId) : null;
    return clip !== null && clipKind(clip) === 'midi' && track?.frozen === undefined ? clip : null;
  });

  /** True when the active editable MIDI clip belongs to a percussion track (no motif target). */
  const activeClipIsDrum = computed(() => {
    const clip = activeMidiClip.value;
    if (clip === null) return false;
    return isDrumTrack(
      store.tracks.find((entry) => entry.id === clip.trackId),
      clip.notes,
    );
  });

  /** Active MIDI clip used as the counter-melody source, including frozen clips. */
  const counterSourceClip = computed(() => {
    const clip = store.activeClip;
    return clip !== null && clipKind(clip) === 'midi' ? clip : null;
  });

  /** True when the counter-melody source clip belongs to a percussion track. */
  const counterSourceIsDrum = computed(() => {
    const clip = counterSourceClip.value;
    if (clip === null) return false;
    const track = store.tracks.find((entry) => entry.id === clip.trackId);
    return isDrumTrack(track, clip.notes);
  });

  /** Active MIDI clip's melody length in bars, or null when none is active. */
  const counterBars = computed(() => {
    const clip = counterSourceClip.value;
    if (clip === null || counterSourceIsDrum.value) return null;
    const track = store.tracks.find((entry) => entry.id === clip.trackId);
    const projected = projectMidiNoteOccurrences(clip);
    const notes = track === undefined ? projected : harmonicNotes(track, projected);
    if (notes.length === 0) return null;
    const end = notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
    return Math.max(1, Math.round(barsBetweenPpq(store.timeSignatures, 0, end)));
  });

  const hasChords = computed(() => store.chords.length > 0);
  const hasEditableMidiClip = computed(() =>
    store.clips.some((clip) => {
      if (clipKind(clip) !== 'midi') return false;
      const track = store.tracks.find((entry) => entry.id === clip.trackId);
      return track?.frozen === undefined;
    }),
  );
  /** A melody clip is enough to open the motif/drum/counter workflow without chords. */
  const hasGeneratorSource = computed(() => hasChords.value || hasEditableMidiClip.value);
  const counterAvailable = computed(() => counterBars.value !== null);

  /** Why a part cannot be generated right now, or null when it can. */
  function partBlocked(part: TrackPart): string | null {
    return firstBlock(
      [!hasChords.value && (part === 'bass' || part === 'backing'), g.value.chordsRequired],
      [part === 'counter' && counterSourceIsDrum.value, g.value.counterDrumSource],
      [part === 'counter' && !counterAvailable.value, g.value.counterUnavailable],
    );
  }

  function isPartAvailable(part: TrackPart): boolean {
    return partBlocked(part) === null;
  }

  return {
    chordProgressionBars,
    activeMidiClip,
    activeClipIsDrum,
    counterBars,
    hasChords,
    hasEditableMidiClip,
    hasGeneratorSource,
    counterAvailable,
    partBlocked,
    isPartAvailable,
  };
}
