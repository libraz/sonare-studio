/**
 * Loudness readout of the mastering panel: the A/B meter rows of the rendered
 * preview and the clipping and target-limit notes of the processed variant.
 */

import { type ComputedRef, computed, type ShallowRef } from 'vue';
import { formatClippingCensus } from '@/export/export-issue-format';
import { formatMessage, useI18n } from '@/ui/i18n';
import { isClippingRisk, type LoudnessRow } from '@/ui/mastering/loudness';
import type { MasteringPreviewState } from '@/ui/mastering/preview';

/** Configuration for {@link useMasteringLoudnessReadout}. */
export interface UseMasteringLoudnessReadoutOptions {
  /** Render controller state holding both variants' reports. */
  previewState: ShallowRef<MasteringPreviewState | undefined>;
}

/** Readout rows and notes returned by {@link useMasteringLoudnessReadout}. */
export interface MasteringLoudnessReadout {
  /** A/B meter rows, empty before any render. */
  loudnessRows: ComputedRef<LoudnessRow[]>;
  /** True when the processed true peak risks clipping downstream. */
  clipWarning: ComputedRef<boolean>;
  /** Extent of the clipping the processed preview produced, or ''. */
  clipCensus: ComputedRef<string>;
  /** Note when the preset stopped short of its loudness target, or ''. */
  targetLimited: ComputedRef<string>;
}

/**
 * Creates the loudness readout of the mastering preview.
 *
 * @param options - The preview render state.
 * @returns Meter rows and the processed variant's notes.
 */
export function useMasteringLoudnessReadout(
  options: UseMasteringLoudnessReadoutOptions,
): MasteringLoudnessReadout {
  const { previewState } = options;
  const { t } = useI18n();

  // --- Loudness readout --------------------------------------------------------------

  const loudnessRows = computed<LoudnessRow[]>(() => {
    const state = previewState.value;
    const a = state?.processed?.report;
    const b = state?.bypassed?.report;
    if (!a && !b) return [];
    return [
      {
        label: t.value.shell.mastering.loudness.peak,
        unit: 'dBFS',
        a: a?.peakDb,
        b: b?.peakDb,
        barScale: 'level',
      },
      {
        label: t.value.shell.mastering.loudness.truePeak,
        unit: 'dBTP',
        a: a?.truePeakDbtp,
        b: b?.truePeakDbtp,
        barScale: 'level',
      },
      {
        label: t.value.shell.mastering.loudness.loudness,
        unit: 'LUFS',
        a: a?.lufs,
        b: b?.lufs,
        barScale: 'level',
      },
      {
        label: t.value.shell.mastering.loudness.momentary,
        unit: 'LUFS',
        a: a?.momentaryLufs,
        b: b?.momentaryLufs,
        barScale: 'level',
      },
      {
        label: t.value.shell.mastering.loudness.shortTerm,
        unit: 'LUFS',
        a: a?.shortTermLufs,
        b: b?.shortTermLufs,
        barScale: 'level',
      },
      {
        label: t.value.shell.mastering.loudness.lra,
        hint: t.value.shell.mastering.loudness.lraHint,
        unit: 'LU',
        a: a?.loudnessRangeLu,
        b: b?.loudnessRangeLu,
        barScale: 'range' as const,
      },
      {
        label: t.value.shell.mastering.loudness.dynamicRange,
        hint: t.value.shell.mastering.loudness.dynamicRangeHint,
        unit: 'dB',
        a: a?.dynamicRangeDb,
        b: b?.dynamicRangeDb,
        barScale: 'range' as const,
      },
    ];
  });

  const clipWarning = computed(() =>
    isClippingRisk(previewState.value?.processed?.report.truePeakDbtp),
  );

  /**
   * Extent of the clipping the processed preview actually produced. The
   * true-peak warning above flags the risk of clipping downstream; this reports
   * samples the chain already drove past full scale, and how many.
   */
  const clipCensus = computed(() => {
    const processed = previewState.value?.processed;
    return formatClippingCensus(
      processed?.report.clipping,
      processed?.sampleRate ?? 0,
      t.value.shell.mastering.loudness.clipCensus,
    );
  });

  /** The processed preview's note when the preset stopped short of its loudness target. */
  const targetLimited = computed(() => {
    const limit = previewState.value?.processed?.report.limitations?.find(
      (entry) => entry.kind === 'mastering-loudness-target-limited',
    );
    if (limit?.kind !== 'mastering-loudness-target-limited') return '';
    return formatMessage(t.value.shell.mastering.loudness.targetLimited, {
      lufs: limit.outputLufs.toFixed(1),
    });
  });

  return {
    loudnessRows,
    clipWarning,
    clipCensus,
    targetLimited,
  };
}
