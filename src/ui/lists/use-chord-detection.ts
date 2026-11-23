/**
 * Chord-track detection state for the chord list editor: the audio/MIDI clip
 * detection, the arrangement-wide progression estimate and the per-chord
 * confidence of the last estimate that drives the tentative-row styling.
 */

import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import type { EditorChordSymbol } from '@/project/chords';
import {
  detectChordsForClip,
  detectChordsFromAudioClip,
  estimateChordsFromArrangement,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

/** Confidence below which an estimated chord row is shown as tentative. */
const LOW_CONFIDENCE = 0.55;

/**
 * Creates the detection and estimate state for the chord list editor.
 * `errorMessage` is the editor's banner text, which detection and estimation
 * write to and reset.
 */
export function useChordDetection(errorMessage: Ref<string>) {
  const store = useProjectStore();
  const { t } = useI18n();

  /** True while an audio-clip detection is awaiting the engine. */
  const isDetecting = ref(false);
  /** True while an arrangement-wide progression estimate is running. */
  const isEstimating = ref(false);

  /**
   * Confidence in [0, 1] for chords produced by the last progression estimate,
   * keyed by start PPQ. Populated by {@link estimateProgression}; cleared on any
   * manual edit so hand-entered chords are never dimmed.
   */
  const estimateConfidence = ref(new Map<number, number>());

  /** Drops the confidence of the last estimate, so no row reads as tentative. */
  function clearEstimate(): void {
    estimateConfidence.value = new Map();
  }

  /** True when a chord row is a low-confidence estimate that should read faintly. */
  function isTentative(chord: EditorChordSymbol): boolean {
    const confidence = estimateConfidence.value.get(chord.startPpq);
    return confidence !== undefined && confidence < LOW_CONFIDENCE;
  }

  /**
   * The active clip's detection kind: 'midi' for MIDI clips, 'audio' for audio
   * clips that carry an asset, or null when nothing detectable is active.
   */
  const detectKind = computed<'midi' | 'audio' | null>(() => {
    const clip = store.activeClip;
    if (!clip) return null;
    const kind = clipKind(clip);
    if (kind === 'midi') return 'midi';
    if (kind === 'audio' && clip.assetId !== undefined) return 'audio';
    return null;
  });

  /**
   * Infers a chord progression from the notes across all tracks and writes it to
   * the chord track. Confirms first when the project already has chords (the
   * estimate replaces them), and dims low-confidence rows afterwards.
   */
  async function estimateProgression(): Promise<void> {
    if (isEstimating.value) return;
    errorMessage.value = '';
    if (store.chords.length > 0) {
      const proceed = await confirmDialog({
        title: t.value.shell.lists.chords.estimateReplaceTitle,
        message: formatMessage(t.value.shell.lists.chords.estimateReplaceConfirm, {
          count: store.chords.length,
        }),
        confirmLabel: t.value.shell.lists.chords.estimateReplaceOk,
      });
      if (!proceed) return;
    }
    try {
      isEstimating.value = true;
      const summary = estimateChordsFromArrangement();
      if (summary.count === 0) {
        errorMessage.value = t.value.shell.lists.chords.noneEstimated;
        clearEstimate();
        return;
      }
      estimateConfidence.value = new Map(summary.confidenceByStartPpq);
    } finally {
      isEstimating.value = false;
    }
  }

  let detectGeneration = 0;
  let detectController: AbortController | null = null;

  // A detection belongs to the clip it started on; leaving that clip or the editor drops it.
  watch(
    () => store.activeClip?.id,
    () => detectController?.abort(),
  );
  onBeforeUnmount(() => detectController?.abort());

  async function detectFromClip(): Promise<void> {
    const clip = store.activeClip;
    const kind = detectKind.value;
    if (!clip || kind === null || isDetecting.value) return;
    const generation = ++detectGeneration;
    const controller = new AbortController();
    detectController = controller;
    const isCurrent = () => generation === detectGeneration && !controller.signal.aborted;
    errorMessage.value = '';
    clearEstimate();
    try {
      isDetecting.value = true;
      const count =
        kind === 'audio'
          ? await detectChordsFromAudioClip(clip.id, controller.signal)
          : detectChordsForClip(clip.id);
      if (!isCurrent()) return;
      if (count === 0) {
        errorMessage.value = t.value.shell.lists.chords.noneDetected;
      }
    } catch {
      if (!isCurrent()) return;
      errorMessage.value = t.value.shell.lists.chords.detectFailed;
    } finally {
      if (generation === detectGeneration) isDetecting.value = false;
      if (detectController === controller) detectController = null;
    }
  }

  return {
    isDetecting,
    isEstimating,
    detectKind,
    clearEstimate,
    isTentative,
    estimateProgression,
    detectFromClip,
  };
}
