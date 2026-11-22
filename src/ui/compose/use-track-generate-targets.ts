/**
 * Write targets of the track generator: the target dropdown of each part, the
 * encoded target string the dropdown binds, and the drum range scope a
 * `range:` target carries.
 */

import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { type SectionId, sectionIdFromName } from '@/compose/section-shaping';
import { editableDrumTracks } from '@/compose/tracks';
import type { BatchTarget, TrackPart } from '@/project/commands';
import { partForTrack } from '@/project/generation';
import { useProjectStore } from '@/project/store';
import {
  advanceBarsPpq,
  barNumberAt,
  barStartPpq,
  barsBetweenPpq,
  isFourFourBarRange,
} from '@/project/time-signature';
import { clipKind, type EditorClip } from '@/project/types';
import { formatMessage, type Messages } from '@/ui/i18n';

/** Configuration for {@link useTrackGenerateTargets}. */
export interface UseTrackGenerateTargetsOptions {
  /** The track generator's message table. */
  g: ComputedRef<Messages['shell']['generate']['track']>;
  /** Per-part checklist state; the encoded target and panel expansion are read and written. */
  parts: Record<TrackPart, { target: string; expanded: boolean }>;
  /** Drum section shaping preset, loaded from a saved section. */
  drumSection: Ref<SectionId>;
  /** Drum next-section preset, loaded from a saved section. */
  drumNextSection: Ref<SectionId | 'same'>;
  /** Active editable MIDI clip (enables motif's clip targets). */
  activeMidiClip: ComputedRef<EditorClip | null>;
  /** True when the active editable MIDI clip belongs to a percussion track. */
  activeClipIsDrum: ComputedRef<boolean>;
}

/** Write-target state returned by {@link useTrackGenerateTargets}. */
export interface TrackGenerateTargets {
  /** Saved-section select value meaning the range is entered by hand. */
  DRUM_RANGE_MANUAL: string;
  /** First bar of the drum range (1-based). */
  drumRangeStartBar: Ref<number>;
  /** Length of the drum range in bars. */
  drumRangeLengthBars: Ref<number>;
  /** Saved-section select value: manual, or `section:<id>`. */
  drumRangeSectionId: Ref<string>;
  /** Saved arrangement sections that can be addressed on the generator's 4/4 grid. */
  savedDrumSections: ComputedRef<ReadonlyArray<SavedDrumSection>>;
  /** Whether the drum part targets a range of an existing drum track. */
  isDrumRangeTarget: ComputedRef<boolean>;
  /** A translated, actionable validation message shown before the command runs. */
  drumRangeValidation: ComputedRef<string | null>;
  /** Applies the saved section picked in the range select. */
  onDrumRangeSectionChange(): void;
  /** Reacts to a part's target dropdown changing. */
  onTargetChanged(part: TrackPart): void;
  /** Encodes a batch target into its dropdown value, loading a range's scope. */
  encodeTarget(target: BatchTarget): string;
  /** Decodes a dropdown value into a batch target. */
  decodeTarget(value: string): BatchTarget;
  /** Full target dropdown for a part. */
  targetOptions(part: TrackPart): { value: string; label: string }[];
}

interface SavedDrumSection {
  id: number;
  name: string;
  startBar: number;
  lengthBars: number;
}

/**
 * Creates the write-target state of one track generator dialog.
 *
 * @param options - Checklist state, drum section presets and the active clip.
 * @returns The target options, codec and drum range scope.
 */
export function useTrackGenerateTargets(
  options: UseTrackGenerateTargetsOptions,
): TrackGenerateTargets {
  const { g, parts, drumSection, drumNextSection, activeMidiClip, activeClipIsDrum } = options;
  const store = useProjectStore();

  /** Range controls used only when a drum track's existing material is targeted. */
  const DRUM_RANGE_MANUAL = 'manual';
  const drumRangeStartBar = ref(1);
  const drumRangeLengthBars = ref(4);
  const drumRangeSectionId = ref(DRUM_RANGE_MANUAL);

  /** Saved arrangement sections that can be addressed on the generator's 4/4 grid. */
  const savedDrumSections = computed<ReadonlyArray<SavedDrumSection>>(() =>
    store.sections.flatMap((section) => {
      const startBar = barNumberAt(store.timeSignatures, section.startPpq);
      const spanBars = barsBetweenPpq(store.timeSignatures, section.startPpq, section.endPpq);
      const lengthBars = Math.round(spanBars);
      if (
        barStartPpq(store.timeSignatures, startBar) !== section.startPpq ||
        Math.abs(spanBars - lengthBars) > 1e-9 ||
        startBar < 1 ||
        lengthBars < 1 ||
        !isFourFourBarRange(store.timeSignatures, section.startPpq, lengthBars)
      ) {
        return [];
      }
      return [
        {
          id: section.id,
          name:
            section.name.trim() || formatMessage(g.value.rangeUnnamedSection, { id: section.id }),
          startBar,
          lengthBars,
        },
      ];
    }),
  );

  // --- Targets -------------------------------------------------------------------

  function targetTrackId(value: string, prefix: 'replace' | 'range'): number | null {
    if (!value.startsWith(`${prefix}:`)) return null;
    const trackId = Number(value.slice(prefix.length + 1));
    return Number.isInteger(trackId) && trackId >= 0 ? trackId : null;
  }

  const drumRangeTrackId = computed(() => targetTrackId(parts.drums.target, 'range'));
  const isDrumRangeTarget = computed(() => drumRangeTrackId.value !== null);

  const drumRangeStartPpq = computed(() =>
    barStartPpq(store.timeSignatures, Math.round(drumRangeStartBar.value)),
  );
  const drumRangeEndPpq = computed(() =>
    advanceBarsPpq(
      store.timeSignatures,
      drumRangeStartPpq.value,
      Math.round(drumRangeLengthBars.value),
    ),
  );

  const drumRangeTargetClipEndPpq = computed(() => {
    const trackId = drumRangeTrackId.value;
    if (trackId === null) return 0;
    return store.clips
      .filter((clip) => clip.trackId === trackId)
      .reduce((end, clip) => Math.max(end, clip.startPpq + clip.lengthPpq), 0);
  });
  const drumRangeTargetClipStartPpq = computed(() => {
    const trackId = drumRangeTrackId.value;
    if (trackId === null) return 0;
    const starts = store.clips
      .filter((clip) => clip.trackId === trackId)
      .map((clip) => clip.startPpq);
    return starts.length === 0 ? 0 : Math.min(...starts);
  });

  /** A translated, actionable validation message shown before the command runs. */
  const drumRangeValidation = computed(() => {
    if (!isDrumRangeTarget.value) return null;
    const start = drumRangeStartBar.value;
    const length = drumRangeLengthBars.value;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(length) || length < 1) {
      return g.value.rangeInvalid;
    }
    if (!isFourFourBarRange(store.timeSignatures, drumRangeStartPpq.value, length)) {
      return g.value.rangeMeterError;
    }
    const clipStart = drumRangeTargetClipStartPpq.value;
    if (clipStart > 0 && drumRangeStartPpq.value < clipStart) {
      return formatMessage(g.value.rangeBeforeTrack, {
        start: barNumberAt(store.timeSignatures, clipStart),
      });
    }
    const clipEnd = drumRangeTargetClipEndPpq.value;
    if (clipEnd > 0 && drumRangeEndPpq.value > clipEnd) {
      return formatMessage(g.value.rangeOutsideTrack, {
        end: Math.round(barsBetweenPpq(store.timeSignatures, 0, clipEnd)),
      });
    }
    const intersecting = store.clips.filter(
      (clip) =>
        clip.trackId === drumRangeTrackId.value &&
        clipKind(clip) === 'midi' &&
        clip.startPpq < drumRangeEndPpq.value &&
        clip.startPpq + clip.lengthPpq > drumRangeStartPpq.value,
    );
    const targetClip = intersecting[0];
    if (
      intersecting.length !== 1 ||
      targetClip === undefined ||
      targetClip.startPpq > drumRangeStartPpq.value ||
      targetClip.startPpq + targetClip.lengthPpq < drumRangeEndPpq.value
    ) {
      return g.value.rangeSingleClip;
    }
    if (targetClip.loopEnabled) return g.value.rangeLoopedClip;
    return null;
  });

  function onDrumRangeSectionChange(): void {
    if (drumRangeSectionId.value === DRUM_RANGE_MANUAL) return;
    const sectionId = Number(drumRangeSectionId.value.slice('section:'.length));
    const section = savedDrumSections.value.find((entry) => entry.id === sectionId);
    if (section === undefined) {
      drumRangeSectionId.value = DRUM_RANGE_MANUAL;
      return;
    }
    drumRangeStartBar.value = section.startBar;
    drumRangeLengthBars.value = section.lengthBars;
    applyDrumSectionContext(
      barStartPpq(store.timeSignatures, section.startBar),
      barStartPpq(store.timeSignatures, section.startBar + section.lengthBars),
    );
  }

  function onTargetChanged(part: TrackPart): void {
    if (part === 'drums' && isDrumRangeTarget.value) {
      // Selecting a range target immediately exposes the scope controls so a
      // user never has to guess which part of the track will be overwritten.
      parts.drums.expanded = true;
    }
  }

  /** Loads the saved section's style and its following section into drum controls. */
  function applyDrumSectionContext(startPpq: number, endPpq: number): void {
    const section = store.sections.find(
      (entry) => entry.startPpq === startPpq && entry.endPpq === endPpq,
    );
    if (section === undefined) return;

    const sectionId = sectionIdFromName(section.name);
    if (sectionId !== null) drumSection.value = sectionId;

    const next = store.sections.find((entry) => entry.startPpq === endPpq);
    const nextId = next === undefined ? null : sectionIdFromName(next.name);
    drumNextSection.value = nextId ?? (sectionId === 'prechorus' ? 'chorus' : 'same');

    const saved = savedDrumSections.value.find((entry) => entry.id === section.id);
    drumRangeSectionId.value = saved === undefined ? DRUM_RANGE_MANUAL : `section:${section.id}`;
  }

  function encodeTarget(target: BatchTarget): string {
    if (target.kind === 'new') return 'new';
    if (target.kind === 'replaceTrack') return `replace:${target.trackId}`;
    if (target.kind === 'replaceRange') {
      drumRangeStartBar.value = barNumberAt(store.timeSignatures, target.startPpq);
      drumRangeLengthBars.value = Math.max(
        1,
        Math.round(barsBetweenPpq(store.timeSignatures, target.startPpq, target.endPpq)),
      );
      applyDrumSectionContext(target.startPpq, target.endPpq);
      return `range:${target.trackId}`;
    }
    return `clip:${target.mode}`;
  }

  function decodeTarget(value: string): BatchTarget {
    if (value.startsWith('replace:')) {
      return { kind: 'replaceTrack', trackId: Number(value.slice('replace:'.length)) };
    }
    const rangeTrackId = targetTrackId(value, 'range');
    if (rangeTrackId !== null) {
      return {
        kind: 'replaceRange',
        trackId: rangeTrackId,
        startPpq: drumRangeStartPpq.value,
        endPpq: drumRangeEndPpq.value,
      };
    }
    if (value === 'clip:append') return { kind: 'clip', mode: 'append' };
    if (value === 'clip:replace') return { kind: 'clip', mode: 'replace' };
    return { kind: 'new' };
  }

  /** Replacement candidates for a part: tracks recorded as (or named after) it. */
  function replaceCandidates(part: TrackPart): { value: string; label: string }[] {
    const matching = store.tracks.filter(
      (track) => track.frozen === undefined && partForTrack(track) === part,
    );
    // Empty MIDI lanes are useful in a prepared arrangement (for example
    // Soprano/Tenor/Pedal in an organ template). Offer them after a known part,
    // while never stealing a hand-authored lane that already contains notes.
    const emptyMidi = store.tracks.filter(
      (track) =>
        track.frozen === undefined &&
        track.kind === 'midi' &&
        partForTrack(track) === null &&
        store.clips
          .filter((clip) => clip.trackId === track.id && clipKind(clip) === 'midi')
          .every((clip) => clip.notes.length === 0),
    );
    return [...matching, ...emptyMidi].map((track) => ({
      value: `replace:${track.id}`,
      label: formatMessage(g.value.targetReplace, { name: track.name }),
    }));
  }

  /** Full target dropdown for a part. */
  function targetOptions(part: TrackPart): { value: string; label: string }[] {
    const options: { value: string; label: string }[] = [
      { value: 'new', label: g.value.targetNew },
    ];
    if (part === 'motif' && activeMidiClip.value !== null && !activeClipIsDrum.value) {
      options.push(
        { value: 'clip:append', label: g.value.targetClipAppend },
        { value: 'clip:replace', label: g.value.targetClipReplace },
      );
    }
    const replacements = replaceCandidates(part);
    options.push(...replacements);
    if (part === 'drums') {
      for (const track of editableDrumTracks(store.tracks, store.clips)) {
        options.push({
          value: `range:${track.id}`,
          label: formatMessage(g.value.targetReplaceRange, { name: track.name }),
        });
      }
    }
    return options;
  }

  return {
    DRUM_RANGE_MANUAL,
    drumRangeStartBar,
    drumRangeLengthBars,
    drumRangeSectionId,
    savedDrumSections,
    isDrumRangeTarget,
    drumRangeValidation,
    onDrumRangeSectionChange,
    onTargetChanged,
    encodeTarget,
    decodeTarget,
    targetOptions,
  };
}
