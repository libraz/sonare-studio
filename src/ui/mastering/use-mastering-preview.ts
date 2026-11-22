/**
 * A/B mixdown preview of the mastering panel: the export-worker render of the
 * preview range, its staleness against project edits, the mono-compatibility
 * check, and level-matched playback on a panel-local AudioContext that never
 * touches the engine.
 */

import type { StereoMonoCompatCheckResult } from '@libraz/libsonare';
import {
  type ComputedRef,
  computed,
  onBeforeUnmount,
  type Ref,
  ref,
  type ShallowRef,
  shallowRef,
  watch,
} from 'vue';
import { renderMixdownInWorker } from '@/export/client';
import { dbToLinear } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { editRevision } from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import {
  createMasteringPreviewController,
  type MasteringPreviewState,
  type PreviewRenderFn,
} from '@/ui/mastering/preview';
import { derivePreviewRange } from '@/ui/mastering/preview-range';
import {
  calculatePreviewLevelMatch,
  createABAudioPreview,
  DEFAULT_PREVIEW_GAIN,
  type PreviewContextFactory,
  type PreviewLevelMatch,
} from '@/ui/media/preview';

/** Configuration for {@link useMasteringPreview}. */
export interface UseMasteringPreviewOptions {
  /** Panel props: the preview range source and the test overrides. */
  props: {
    readonly loopEnabled: boolean;
    readonly loopStartPpq: number;
    readonly loopEndPpq: number;
    readonly previewBars: number;
    readonly renderMixdown: PreviewRenderFn | null;
    readonly previewContextFactory: PreviewContextFactory | null;
  };
  /** The panel's error banner, set when the project cannot be serialized. */
  error: Ref<string>;
}

/** Preview render and playback state returned by {@link useMasteringPreview}. */
export interface MasteringPreview {
  /** Render controller state: status, progress and both rendered variants. */
  previewState: ShallowRef<MasteringPreviewState | undefined>;
  /** Mono-compatibility check of the processed render, or null. */
  monoCompatibility: Ref<StereoMonoCompatCheckResult | null>;
  /** The monitored variant: A = chain applied, B = chain bypassed. */
  variant: Ref<'processed' | 'bypassed'>;
  /** True when A/B monitoring is level matched. */
  levelMatchEnabled: Ref<boolean>;
  /** True when both variants are rendered. */
  canPlayPreview: ComputedRef<boolean>;
  /** Bumped on any project change that could affect the rendered preview. */
  projectRevision: Ref<number>;
  /** projectRevision at the time of the last applied preview render. */
  previewRevision: Ref<number | null>;
  /** True when a ready preview predates the latest project change. */
  previewStale: ComputedRef<boolean>;
  /** Monitor gains that match the two variants' loudness. */
  levelMatch: ComputedRef<PreviewLevelMatch>;
  /** Renders both variants of the preview range, then checks mono compatibility. */
  onPreview(): Promise<void>;
  /** Cancels the in-flight render. */
  onCancelPreview(): void;
  /** True while the preview is playing. */
  isPlaying: ComputedRef<boolean>;
  /** Starts or stops preview playback. */
  onTogglePlay(): void;
  /** Switches the monitored variant without moving the playback position. */
  onSelectVariant(next: 'processed' | 'bypassed'): void;
  /** Turns monitor level matching on or off. */
  onToggleLevelMatch(enabled: boolean): void;
  /** Render failure message, surfaced only while the controller is in error. */
  renderError: ComputedRef<string | null>;
}

/**
 * Creates the mastering preview render and its panel-local playback.
 *
 * @param options - The panel props and error banner.
 * @returns Render state, playback state and their actions.
 */
export function useMasteringPreview(options: UseMasteringPreviewOptions): MasteringPreview {
  const { props, error } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  // --- Preview ---------------------------------------------------------------------

  const previewState = shallowRef<MasteringPreviewState>();
  const monoCompatibility = ref<StereoMonoCompatCheckResult | null>(null);

  const controller = createMasteringPreviewController({
    render: (doc, options, onProgress) =>
      (props.renderMixdown ?? renderMixdownInWorker)(doc, options, onProgress),
    onChange: (state) => {
      previewState.value = state;
    },
  });
  previewState.value = controller.state();

  /** A = chain applied, B = chain bypassed. */
  const variant = ref<'processed' | 'bypassed'>('processed');
  /** Monitor-only A/B level matching; enabled by default for fair comparisons. */
  const levelMatchEnabled = ref(true);

  const canPlayPreview = computed(
    () => !!previewState.value?.processed && !!previewState.value?.bypassed,
  );

  /** Bumped on any project change that could affect the rendered preview. */
  const projectRevision = ref(0);
  /** projectRevision at the time of the last applied preview render. */
  const previewRevision = ref<number | null>(null);

  watch(
    [
      editRevision,
      () => store.documentGeneration,
      () => props.loopEnabled,
      () => props.loopStartPpq,
      () => props.loopEndPpq,
      () => props.previewBars,
    ],
    () => {
      projectRevision.value += 1;
    },
  );

  const previewStale = computed(
    () => previewState.value?.status === 'ready' && previewRevision.value !== projectRevision.value,
  );

  const levelMatch = computed<PreviewLevelMatch>(() => {
    if (previewStale.value) {
      return { available: false, processedGainDb: 0, bypassedGainDb: 0 };
    }
    return calculatePreviewLevelMatch(
      previewState.value?.processed?.report.lufs,
      previewState.value?.bypassed?.report.lufs,
    );
  });

  async function onPreview(): Promise<void> {
    let doc: ReturnType<typeof serializeProject>;
    try {
      doc = serializeProject();
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
      return;
    }
    const range = derivePreviewRange(
      {
        enabled: props.loopEnabled,
        startPpq: props.loopStartPpq,
        endPpq: props.loopEndPpq,
      },
      store.timeSignatures,
      props.previewBars,
    );
    const revision = projectRevision.value;
    audioPreview.stop();
    monoCompatibility.value = null;
    const applied = await controller.request(doc, range);
    if (applied) {
      previewRevision.value = revision;
      await analyzeMonoCompatibility();
    }
  }

  function onCancelPreview(): void {
    controller.cancel();
  }

  // --- Preview playback (panel-local AudioContext, never the engine) ----------------

  const playingId = ref<string | null>(null);

  const audioPreview = createABAudioPreview({
    ...(props.previewContextFactory ? { contextFactory: props.previewContextFactory } : {}),
    onChange: (id) => {
      playingId.value = id;
    },
  });

  const isPlaying = computed(() => playingId.value !== null);

  function monitorPreviewGains(): { processed: number; bypassed: number } {
    if (!levelMatchEnabled.value || !levelMatch.value.available) {
      return { processed: DEFAULT_PREVIEW_GAIN, bypassed: DEFAULT_PREVIEW_GAIN };
    }
    return {
      processed: DEFAULT_PREVIEW_GAIN * dbToLinear(levelMatch.value.processedGainDb),
      bypassed: DEFAULT_PREVIEW_GAIN * dbToLinear(levelMatch.value.bypassedGainDb),
    };
  }

  function playActiveResult(offsetSeconds = 0): void {
    const processed = previewState.value?.processed;
    const bypassed = previewState.value?.bypassed;
    if (!processed || !bypassed) return;
    audioPreview.play(
      'mastering-preview',
      {
        processed: { channels: processed.channels, sampleRate: processed.sampleRate },
        bypassed: { channels: bypassed.channels, sampleRate: bypassed.sampleRate },
      },
      variant.value,
      monitorPreviewGains(),
      offsetSeconds,
    );
  }

  function onTogglePlay(): void {
    if (isPlaying.value) audioPreview.stop();
    else playActiveResult();
  }

  function onSelectVariant(next: 'processed' | 'bypassed'): void {
    if (variant.value === next) return;
    variant.value = next;
    // Both variants are already running at the same audio time. Switching only
    // ramps their separate monitor gains, so playback position never jumps.
    if (isPlaying.value) audioPreview.selectVariant(next);
  }

  function onToggleLevelMatch(enabled: boolean): void {
    levelMatchEnabled.value = enabled;
    if (isPlaying.value) audioPreview.setGains(monitorPreviewGains());
  }

  watch([levelMatch, levelMatchEnabled], () => {
    // A project edit can make the rendered report stale while playback is
    // active. Keep the monitor target in sync with the visible Unavailable state.
    if (isPlaying.value) audioPreview.setGains(monitorPreviewGains());
  });

  async function analyzeMonoCompatibility(): Promise<void> {
    const source = previewState.value?.processed;
    if (!source || source.channels.length < 2) return;
    try {
      const wasm = await ensureWasm();
      const analyze = wasm.masteringAnalyzeStereo;
      if (typeof analyze !== 'function') return;
      monoCompatibility.value = analyze({
        analysis: 'stereo.monoCompatCheck',
        left: source.channels[0],
        right: source.channels[1],
        sampleRate: source.sampleRate,
      });
    } catch {
      monoCompatibility.value = null;
    }
  }

  /** Render failure message, surfaced only while the controller is in error. */
  const renderError = computed(() =>
    previewState.value?.status === 'error' ? (previewState.value?.error ?? null) : null,
  );

  onBeforeUnmount(() => {
    controller.dispose();
    audioPreview.dispose();
  });

  return {
    previewState,
    monoCompatibility,
    variant,
    levelMatchEnabled,
    canPlayPreview,
    projectRevision,
    previewRevision,
    previewStale,
    levelMatch,
    onPreview,
    onCancelPreview,
    isPlaying,
    onTogglePlay,
    onSelectVariant,
    onToggleLevelMatch,
    renderError,
  };
}
