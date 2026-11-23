/**
 * Command-bar section and audio actions of the arrangement view: section
 * detection, the transcribe dialog, stem/component split and tune-to-MIDI,
 * with the reasons that block each button.
 */

import type { NoteTargetUnmatchedPolicy } from '@libraz/libsonare';
import { computed, type Ref, ref } from 'vue';
import { describeError } from '@/lib/errors';
import { TuneToMidiRefusedError } from '@/project/audio-tune-to-midi';
import {
  detectSectionsFromArrangement,
  detectSectionsFromAudioClip,
  setActiveClip,
  splitAudioClipToComponents,
  splitAudioClipToStems,
  tuneAudioClipToMidiTrack,
} from '@/project/commands';
import { MAX_TRACK_LANES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { clipKind, type EditorClip, isAudioClip } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';

/** Configuration for {@link useArrangementProcessing}. */
export interface UseArrangementProcessingOptions {
  /** Error line shown above the view; actions clear and set it. */
  error: Ref<string>;
  /** Result line shown above the view until the next action. */
  notice: Ref<string>;
  /** Whether the track with this id is frozen. */
  isTrackFrozen(trackId: number | undefined): boolean;
}

/** State and handlers returned by {@link useArrangementProcessing}. */
export interface ArrangementProcessing {
  /** Reason section detection is unavailable, or null. */
  detectSectionsBlocked: Ref<string | null>;
  /** Reason reading sections from notes is unavailable, or null. */
  sectionsFromNotesBlocked: Ref<string | null>;
  /** Reason the transcribe dialog cannot open, or null. */
  transcribeBlocked: Ref<string | null>;
  /** Reason the stem split is unavailable, or null. */
  splitStemsBlocked: Ref<string | null>;
  /** Reason tuning to MIDI is unavailable, or null. */
  tuneToMidiBlocked: Ref<string | null>;
  /** Non-null while a components split is in flight. */
  componentSplitAbort: Ref<AbortController | null>;
  /** Id of the audio clip shown in the transcription dialog. */
  transcribeDialogClipId: Ref<number | null>;
  /** Detects sections from the active audio clip. */
  detectSections(): void;
  /** Reads the song form from the written notes. */
  sectionsFromNotes(): void;
  /** Opens the audio-to-MIDI dialog for the active audio clip. */
  openTranscribeDialog(): void;
  /** Closes the audio-to-MIDI dialog. */
  closeTranscribeDialog(): void;
  /** Cancels a running components split, else opens the stem-split menu. */
  onSplitStemsClick(event: MouseEvent): void;
  /** Opens the reference-track menu for tuning the active clip to MIDI. */
  openTuneToMidiMenu(event: MouseEvent): void;
}

/**
 * Creates the command-bar section and audio actions for one arrangement view.
 *
 * @param options - Shared error/notice lines, view reasons and frozen-track probe.
 * @returns The blocked reasons, dialog state and action handlers.
 */
export function useArrangementProcessing(
  options: UseArrangementProcessingOptions,
): ArrangementProcessing {
  const { error, notice, isTrackFrozen } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  /** True while a section detection is awaiting the engine. */
  const isDetectingSections = ref(false);

  /** Id of the audio clip currently shown in the transcription dialog. */
  const transcribeDialogClipId = ref<number | null>(null);

  /** True while a stem separation (either mode) is awaiting the engine. */
  const isSplittingStems = ref(false);

  /** Non-null while a components split is in flight; clicking the button cancels it. */
  const componentSplitAbort = ref<AbortController | null>(null);

  /** Component counts offered in the "Components" submenu. */
  const COMPONENT_SPLIT_COUNTS = [2, 3, 4, 6, 8] as const;

  /** True while a clip is being tuned to a MIDI track. */
  const isTuningToMidi = ref(false);

  /** The active clip when it is an audio clip carrying an asset, else null. */
  const detectableAudioClip = computed(() => {
    const clip = store.activeClip;
    return clip && isAudioClip(clip) && clip.assetId !== undefined ? clip : null;
  });

  /** Whether any clip carries written notes the form could be read from. */
  const hasWrittenNotes = computed(() => store.clips.some((clip) => clip.notes.length > 0));

  /** Shared prerequisite of every audio-clip action: an active audio clip with media. */
  const audioClipBlocked = computed(() =>
    firstBlock([detectableAudioClip.value === null, t.value.reasons.noAudioClip]),
  );
  const detectSectionsBlocked = computed(() =>
    firstBlock(audioClipBlocked.value, [isDetectingSections.value, t.value.reasons.busy]),
  );
  const sectionsFromNotesBlocked = computed(() =>
    firstBlock([!hasWrittenNotes.value, t.value.shell.arrangement.reasons.noWrittenNotes]),
  );
  const transcribeBlocked = computed(() => audioClipBlocked.value);
  /** A running components split stays clickable: the button then cancels it. */
  const splitStemsBlocked = computed(() =>
    firstBlock(
      audioClipBlocked.value,
      [
        store.tracks.length >= MAX_TRACK_LANES,
        formatMessage(t.value.reasons.trackLimit, { limit: MAX_TRACK_LANES }),
      ],
      [isSplittingStems.value && componentSplitAbort.value === null, t.value.reasons.busy],
    ),
  );

  /**
   * Reads the song form from the written notes across the whole arrangement and
   * replaces the section lane with it. Unlike {@link detectSections} this needs no
   * audio and asserts only which spans restate which, labelling them A, B, C.
   */
  function sectionsFromNotes(): void {
    if (!hasWrittenNotes.value) return;
    error.value = '';
    const summary = detectSectionsFromArrangement();
    if (summary.count === 0) error.value = t.value.shell.arrangement.noSectionsFromNotes;
  }

  /**
   * Detects song sections from the active audio clip and merges them into the
   * section lane. Surfaces an error when analysis fails or finds nothing.
   */
  function detectSections(): void {
    const clip = detectableAudioClip.value;
    if (!clip || isDetectingSections.value) return;
    error.value = '';
    isDetectingSections.value = true;
    void (async () => {
      try {
        const count = await detectSectionsFromAudioClip(clip.id);
        if (count === 0) error.value = t.value.shell.arrangement.noSectionsDetected;
      } catch (err) {
        error.value = describeError(err, t.value.notices.errors);
      } finally {
        isDetectingSections.value = false;
      }
    })();
  }

  /** Opens the canonical mono/polyphonic audio-to-MIDI dialog. */
  function openTranscribeDialog(): void {
    const clip = detectableAudioClip.value;
    if (!clip) return;
    error.value = '';
    transcribeDialogClipId.value = clip.id;
  }

  function closeTranscribeDialog(): void {
    transcribeDialogClipId.value = null;
  }

  /**
   * Splits the active audio clip into harmonic/percussive/residual stems, each on
   * a new audio track. Surfaces an error when separation is unavailable or finds
   * no audible window.
   */
  function splitToStems(): void {
    const clip = detectableAudioClip.value;
    if (!clip || isSplittingStems.value) return;
    error.value = '';
    isSplittingStems.value = true;
    void (async () => {
      try {
        const newClipIds = await splitAudioClipToStems(clip.id);
        if (newClipIds.length === 0) error.value = t.value.shell.arrangement.noStemsSeparated;
        else setActiveClip(newClipIds[0]);
      } catch (err) {
        error.value = describeError(err, t.value.notices.errors);
      } finally {
        isSplittingStems.value = false;
      }
    })();
  }

  /**
   * Splits the active audio clip into `count` NMF components, each on a new
   * audio track. Cancelling through {@link componentSplitAbort} clears the busy
   * state silently; any other failure is surfaced in `error`.
   */
  function splitToComponents(clipId: number, count: number): void {
    if (isSplittingStems.value) return;
    error.value = '';
    isSplittingStems.value = true;
    const controller = new AbortController();
    componentSplitAbort.value = controller;
    void (async () => {
      try {
        const newClipIds = await splitAudioClipToComponents(clipId, count, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (newClipIds.length === 0) error.value = t.value.shell.arrangement.noStemsSeparated;
        else setActiveClip(newClipIds[0]);
      } catch (err) {
        if (!controller.signal.aborted) error.value = describeError(err, t.value.notices.errors);
      } finally {
        isSplittingStems.value = false;
        componentSplitAbort.value = null;
      }
    })();
  }

  /** Opens the "harmonic/percussive/residual" vs. "components" stem-split menu. */
  function openSplitStemsMenu(event: MouseEvent): void {
    const clip = detectableAudioClip.value;
    if (!clip || isSplittingStems.value) return;
    const items: ContextMenuItem[] = [
      {
        id: 'split-stems-hpss',
        label: t.value.shell.arrangement.splitStemsHpss,
        run: () => splitToStems(),
      },
      {
        id: 'split-stems-components',
        label: t.value.shell.arrangement.splitStemsComponents,
        children: COMPONENT_SPLIT_COUNTS.map((count) => ({
          id: `split-stems-components-${count}`,
          label: formatMessage(t.value.shell.arrangement.splitStemsComponentCount, { count }),
          run: () => splitToComponents(clip.id, count),
        })),
      },
    ];
    openContextMenu(event.clientX, event.clientY, items);
  }

  /** Stem-split button handler: cancels a running components split, else opens the menu. */
  function onSplitStemsClick(event: MouseEvent): void {
    if (componentSplitAbort.value) {
      componentSplitAbort.value.abort();
      return;
    }
    openSplitStemsMenu(event);
  }

  /** MIDI tracks a clip can be tuned to. */
  const midiTracks = computed(() => store.tracks.filter((track) => track.kind === 'midi'));

  /** Mirrors the refusals of the tuning command so the button says why before it is pressed. */
  const tuneToMidiBlocked = computed(() => {
    const clip = detectableAudioClip.value;
    const refused = t.value.shell.arrangement.tuneToMidiRefused;
    return firstBlock(
      audioClipBlocked.value,
      [isTrackFrozen(clip?.trackId), t.value.reasons.trackFrozen],
      [clip?.warp?.enabled === true, refused.warped],
      [clip?.loopEnabled === true, refused.looped],
      [(clip?.takes?.length ?? 0) > 0, refused.comped],
      [midiTracks.value.length === 0, t.value.shell.arrangement.reasons.noMidiTrack],
      [isTuningToMidi.value, t.value.reasons.busy],
    );
  });

  /** True when a MIDI track holds a MIDI clip overlapping the clip's window. */
  function midiTrackOverlaps(trackId: number, clip: EditorClip): boolean {
    const end = clip.startPpq + clip.lengthPpq;
    return store.clips.some(
      (entry) =>
        entry.trackId === trackId &&
        clipKind(entry) === 'midi' &&
        entry.notes.length > 0 &&
        entry.startPpq < end &&
        entry.startPpq + entry.lengthPpq > clip.startPpq,
    );
  }

  /** Unmatched-note policies offered per reference track, safest first. */
  const TUNE_POLICIES: ReadonlyArray<NoteTargetUnmatchedPolicy> = ['leave', 'mute', 'nearest'];

  /** Opens the reference-track menu for tuning the active audio clip to MIDI. */
  function openTuneToMidiMenu(event: MouseEvent): void {
    const clip = detectableAudioClip.value;
    if (!clip || tuneToMidiBlocked.value) return;
    const items: ContextMenuItem[] = midiTracks.value.map((track) => ({
      id: `tune-${track.id}`,
      label: track.name,
      disabledReason: midiTrackOverlaps(track.id, clip)
        ? null
        : formatMessage(t.value.shell.arrangement.tuneToMidiRefused['no-notes'], {
            track: track.name,
          }),
      children: TUNE_POLICIES.map((policy) => ({
        id: `tune-${track.id}-${policy}`,
        label: t.value.shell.arrangement.tuneToMidiPolicy[policy],
        run: () => tuneToMidi(clip.id, track.id, track.name, policy),
      })),
    }));
    openContextMenu(event.clientX, event.clientY, items);
  }

  /** Tunes one audio clip to a MIDI track and reports how many notes matched. */
  function tuneToMidi(
    clipId: number,
    trackId: number,
    trackName: string,
    policy: NoteTargetUnmatchedPolicy,
  ): void {
    if (isTuningToMidi.value) return;
    error.value = '';
    notice.value = '';
    isTuningToMidi.value = true;
    void (async () => {
      try {
        const outcome = await tuneAudioClipToMidiTrack(clipId, trackId, policy);
        if (!outcome) return;
        setActiveClip(outcome.clipId);
        notice.value = formatMessage(t.value.shell.arrangement.tunedToMidi, {
          assigned: outcome.assignedCount,
          total: outcome.noteCount,
          track: trackName,
        });
      } catch (err) {
        error.value =
          err instanceof TuneToMidiRefusedError
            ? formatMessage(t.value.shell.arrangement.tuneToMidiRefused[err.reason], {
                track: trackName,
              })
            : describeError(err, t.value.notices.errors);
      } finally {
        isTuningToMidi.value = false;
      }
    })();
  }

  return {
    detectSectionsBlocked,
    sectionsFromNotesBlocked,
    transcribeBlocked,
    splitStemsBlocked,
    tuneToMidiBlocked,
    componentSplitAbort,
    transcribeDialogClipId,
    detectSections,
    sectionsFromNotes,
    openTranscribeDialog,
    closeTranscribeDialog,
    onSplitStemsClick,
    openTuneToMidiMenu,
  };
}
