/**
 * Analyses the mastering panel runs on the rendered preview, each rendering a
 * fresh preview first when none is current: the mastering assistant on the
 * bypassed variant, and the streaming-target check and reference comparison
 * on the processed one.
 */

import type {
  MasteringAssistantResult,
  MasteringStreamingPreviewResult,
  StreamingPlatform,
} from '@libraz/libsonare';
import { type ComputedRef, computed, type Ref, ref, type ShallowRef, shallowRef, watch } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { downmixToMono } from '@/lib/audio-channels';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { applyMasteringPresetWithOverrides } from '@/project/commands';
import type { MasteringChainState } from '@/project/mixer';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import {
  type SuggestionAdjustment,
  suggestedAdjustments,
  suggestedPresetOverrides,
} from '@/ui/mastering/assistant';
import { masteringPresetInfo } from '@/ui/mastering/preset-catalog';
import {
  decodeMasteringReference,
  type MasteringReferenceAudio,
} from '@/ui/mastering/reference-audio';
import {
  invalidStreamingPlatformCount,
  normalizeStreamingPlatforms,
  type StreamingTarget,
  streamingTargetsFromPreview,
  streamingTargetsFromReport,
} from '@/ui/mastering/streaming';
import type { MasteringPreview } from '@/ui/mastering/use-mastering-preview';
import { parseNumber } from '@/ui/numeric-input';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
import { analyzeMatchEqToReference } from '@/ui/sample-editor/wasm-ops';

/** Configuration for {@link useMasteringPreviewAnalysis}. */
export interface UseMasteringPreviewAnalysisOptions {
  /** Panel props: the reference decoder test override. */
  props: {
    readonly decodeReference: ((file: File) => Promise<MasteringReferenceAudio>) | null;
  };
  /** The project mastering chain, or the default chain when none is stored. */
  chain: ComputedRef<MasteringChainState>;
  /** The panel's error banner. */
  error: Ref<string>;
  /** Runs an undoable edit, clearing the banner or setting it on a throw. */
  runCommand(action: () => void): void;
  /** The preview the analyses read, and render when it is missing or stale. */
  preview: MasteringPreview;
}

/** Analysis state and actions returned by {@link useMasteringPreviewAnalysis}. */
export interface MasteringPreviewAnalysis {
  /** The last assistant result, or null. */
  suggestion: Ref<MasteringAssistantResult | null>;
  /** True while the assistant runs. */
  suggesting: Ref<boolean>;
  /** Preset values the last suggestion tuned, while that preset is selected. */
  suggestionAdjustments: ComputedRef<SuggestionAdjustment[]>;
  /** Why the assistant button is unavailable, or null. */
  suggestBlocked: ComputedRef<string | null>;
  /** Runs the assistant and applies its tuning as preset overrides. */
  onAutoSuggest(): Promise<void>;
  /** Per-platform normalization results of the last check, or null. */
  streamingTargets: Ref<StreamingTarget[] | null>;
  /** Editable streaming-platform loudness targets, persisted when valid. */
  streamingPlatforms: Ref<StreamingPlatform[]>;
  /** True while the streaming-target check runs. */
  checkingTargets: Ref<boolean>;
  /** Measures the processed render against the streaming targets. */
  onCheckTargets(): Promise<void>;
  /** Appends a custom streaming target. */
  onAddStreamingPlatform(): void;
  /** Removes a streaming target, keeping at least one. */
  onRemoveStreamingPlatform(index: number): void;
  /** Edits one field of a streaming target. */
  onUpdateStreamingPlatform(index: number, field: keyof StreamingPlatform, value: string): void;
  /** The decoded reference track, or null. */
  referenceAudio: ShallowRef<MasteringReferenceAudio | null>;
  /** Loudness and tonal-balance comparison with the reference, or null. */
  referenceAnalysis: Ref<MatchEqAnalysis | null>;
  /** True while the reference comparison runs. */
  analyzingReference: Ref<boolean>;
  /** Why the compare button is unavailable, or null. */
  compareBlocked: ComputedRef<string | null>;
  /** Decodes the reference file chosen in the file input. */
  onReferenceFile(event: Event): Promise<void>;
  /** Compares the processed render with the reference. */
  onCompareReference(): Promise<void>;
}

/**
 * Creates the preview analyses of the mastering panel.
 *
 * @param options - The panel props, chain, error banner, command runner and preview.
 * @returns Each analysis's state, result and actions.
 */
export function useMasteringPreviewAnalysis(
  options: UseMasteringPreviewAnalysisOptions,
): MasteringPreviewAnalysis {
  const { props, chain, error, runCommand, preview } = options;
  const { previewState, previewStale, previewRevision, projectRevision, onPreview } = preview;
  const appSettings = useAppSettings();
  const { t } = useI18n();

  // --- Mastering assistant --------------------------------------------------------

  const suggestion = ref<MasteringAssistantResult | null>(null);
  const suggesting = ref(false);
  /** Preset values the last suggestion tuned, applied as that preset's overrides. */
  const suggestionTuning = ref<{
    preset: string;
    entries: SuggestionAdjustment[];
  } | null>(null);
  const suggestionAdjustments = computed(() =>
    suggestionTuning.value && suggestionTuning.value.preset === chain.value.preset
      ? suggestionTuning.value.entries
      : [],
  );

  /**
   * The rendered channels as a left/right pair, or null when the render is not
   * stereo. A `0.5 * (left + right)` downmix cancels on decorrelated material and
   * measures the program several dB low, so a stereo render is analyzed through
   * the channel-summing entry points instead of {@link downmixToMono}.
   */
  function stereoPair(
    channels: ReadonlyArray<Float32Array>,
  ): { left: Float32Array; right: Float32Array } | null {
    if (channels.length !== 2) return null;
    const [left, right] = channels;
    return left && right ? { left, right } : null;
  }

  /**
   * Analyzes the chain-free (bypassed) render of the preview range with the
   * libsonare mastering assistant. The assistant starts from the selected
   * mastering preset, or streaming when no compatible preset is selected, then
   * applies the returned chain tuning as overrides in one undoable edit.
   * Renders a preview first when none is ready.
   */
  async function onAutoSuggest(): Promise<void> {
    if (suggesting.value) return;
    suggesting.value = true;
    error.value = '';
    try {
      if (!previewState.value?.bypassed || previewStale.value) await onPreview();
      const source = previewState.value?.bypassed;
      const analyzedRevision = previewRevision.value;
      if (!source || previewStale.value || analyzedRevision === null) {
        if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
        return;
      }
      const wasm = await ensureWasm();
      const pair = stereoPair(source.channels);
      const suggestStereo = wasm.masteringAssistantSuggestStereo;
      const suggest = wasm.masteringAssistantSuggest;
      const selectedPreset = chain.value.preset;
      const preset =
        selectedPreset && masteringPresetInfo(selectedPreset)?.kind === 'mastering'
          ? selectedPreset
          : 'streaming';
      const settings = { preset };
      let result: MasteringAssistantResult;
      if (pair && typeof suggestStereo === 'function') {
        result = suggestStereo({ ...pair, sampleRate: source.sampleRate, ...settings });
      } else if (typeof suggest === 'function') {
        result = suggest(downmixToMono(source.channels), source.sampleRate, settings);
      } else {
        error.value = t.value.shell.mastering.assistant.unavailable;
        return;
      }
      if (
        previewState.value?.bypassed !== source ||
        previewRevision.value !== analyzedRevision ||
        projectRevision.value !== analyzedRevision
      ) {
        error.value = t.value.shell.mastering.assistant.needsPreview;
        return;
      }
      suggestion.value = result;
      // The assistant response describes the named base preset, so compare its
      // complete tuned chain with that preset before storing only the deltas.
      const baseParams = wasm.masteringPresetParams(preset);
      const overrides = suggestedPresetOverrides(result.chainConfig, baseParams);
      suggestionTuning.value = {
        preset,
        entries: suggestedAdjustments(result.chainConfig, baseParams),
      };
      runCommand(() => applyMasteringPresetWithOverrides(preset, overrides));
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      suggesting.value = false;
    }
  }

  const suggestBlocked = computed(() =>
    firstBlock([suggesting.value, t.value.shell.mastering.reasons.analyzing]),
  );

  // --- Streaming targets ----------------------------------------------------------

  const streamingTargets = ref<StreamingTarget[] | null>(null);
  const streamingPlatforms = ref<StreamingPlatform[]>([...appSettings.settings.streamingPlatforms]);
  watch(
    streamingPlatforms,
    (platforms) => {
      // Keep invalid rows editable so the panel can show its validation message;
      // only durable, valid configurations replace the last saved preference.
      if (invalidStreamingPlatformCount(platforms) === 0) {
        appSettings.set('streamingPlatforms', normalizeStreamingPlatforms(platforms));
      }
    },
    { deep: true },
  );
  const checkingTargets = ref(false);

  /**
   * Measures the chain-applied (processed) render against the editable
   * streaming-platform loudness targets and shows, per platform, the
   * normalization gain each would apply and whether that gain risks clipping the
   * ceiling. Renders a preview first when none is ready.
   */
  async function onCheckTargets(): Promise<void> {
    if (checkingTargets.value) return;
    checkingTargets.value = true;
    error.value = '';
    // Read on both sides of the render: the list stays editable while it runs.
    const validPlatforms = (): StreamingPlatform[] | null => {
      if (invalidStreamingPlatformCount(streamingPlatforms.value) > 0) {
        error.value = t.value.shell.mastering.streaming.invalidTargets;
        return null;
      }
      const platforms = normalizeStreamingPlatforms(streamingPlatforms.value);
      if (platforms.length === 0) {
        error.value = t.value.shell.mastering.streaming.noTargets;
        return null;
      }
      return platforms;
    };
    try {
      if (validPlatforms() === null) return;
      if (!previewState.value?.processed || previewStale.value) await onPreview();
      const source = previewState.value?.processed;
      if (!source || previewStale.value) {
        if (!error.value) error.value = t.value.shell.mastering.assistant.needsPreview;
        return;
      }
      const platforms = validPlatforms();
      if (platforms === null) return;
      const reportTargets = streamingTargetsFromReport(source.report, platforms);
      if (reportTargets) {
        streamingTargets.value = reportTargets;
        return;
      }
      const wasm = await ensureWasm();
      const pair = stereoPair(source.channels);
      const previewStereo = wasm.masteringStreamingPreviewStereo;
      const preview = wasm.masteringStreamingPreview;
      let result: MasteringStreamingPreviewResult;
      if (pair && typeof previewStereo === 'function') {
        result = previewStereo({ ...pair, sampleRate: source.sampleRate, platforms });
      } else if (typeof preview === 'function') {
        result = preview(downmixToMono(source.channels), source.sampleRate, { platforms });
      } else {
        error.value = t.value.shell.mastering.streaming.unavailable;
        return;
      }
      streamingTargets.value = streamingTargetsFromPreview(result);
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      checkingTargets.value = false;
    }
  }

  function onAddStreamingPlatform(): void {
    streamingPlatforms.value = [
      ...streamingPlatforms.value,
      { name: t.value.shell.mastering.streaming.customTarget, targetLufs: -14, ceilingDbtp: -1 },
    ];
    streamingTargets.value = null;
  }

  function onRemoveStreamingPlatform(index: number): void {
    if (streamingPlatforms.value.length <= 1) return;
    streamingPlatforms.value = streamingPlatforms.value.filter((_, i) => i !== index);
    streamingTargets.value = null;
  }

  function onUpdateStreamingPlatform(
    index: number,
    field: keyof StreamingPlatform,
    value: string,
  ): void {
    const current = streamingPlatforms.value[index];
    if (!current) return;
    const next: StreamingPlatform = { ...current };
    if (field === 'name') next.name = value;
    else next[field] = parseNumber(value) ?? Number.NaN;
    streamingPlatforms.value = streamingPlatforms.value.map((entry, i) =>
      i === index ? next : entry,
    );
    streamingTargets.value = null;
  }

  // --- Reference comparison -------------------------------------------------------

  const referenceAudio = shallowRef<MasteringReferenceAudio | null>(null);
  const referenceAnalysis = ref<MatchEqAnalysis | null>(null);
  const analyzingReference = ref(false);

  const compareBlocked = computed(() =>
    firstBlock(
      [!referenceAudio.value, t.value.shell.mastering.reasons.noReference],
      [analyzingReference.value, t.value.shell.mastering.reasons.comparing],
    ),
  );

  async function onReferenceFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      referenceAudio.value = await (props.decodeReference ?? decodeMasteringReference)(file);
      referenceAnalysis.value = null;
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  async function onCompareReference(): Promise<void> {
    const reference = referenceAudio.value;
    if (!reference || analyzingReference.value) return;
    analyzingReference.value = true;
    error.value = '';
    try {
      if (!previewState.value?.processed || previewStale.value) await onPreview();
      const source = previewState.value?.processed;
      if (!source || previewStale.value) {
        if (!error.value) error.value = t.value.shell.mastering.reference.needsPreview;
        return;
      }
      const wasm = await ensureWasm();
      referenceAnalysis.value = analyzeMatchEqToReference(
        wasm,
        source.channels,
        source.sampleRate,
        downmixToMono(reference.channels),
        null,
        reference.sampleRate,
      );
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    } finally {
      analyzingReference.value = false;
    }
  }

  watch(
    () => previewState.value?.processed,
    () => {
      referenceAnalysis.value = null;
    },
  );

  return {
    suggestion,
    suggesting,
    suggestionAdjustments,
    suggestBlocked,
    onAutoSuggest,
    streamingTargets,
    streamingPlatforms,
    checkingTargets,
    onCheckTargets,
    onAddStreamingPlatform,
    onRemoveStreamingPlatform,
    onUpdateStreamingPlatform,
    referenceAudio,
    referenceAnalysis,
    analyzingReference,
    compareBlocked,
    onReferenceFile,
    onCompareReference,
  };
}
