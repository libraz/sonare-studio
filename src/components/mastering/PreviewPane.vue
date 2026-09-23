<script setup lang="ts">
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
import StreamingTargetsTable from '@/components/mastering/StreamingTargetsTable.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { useI18n } from '@/ui/i18n';
import { formatLevel, type LoudnessRow } from '@/ui/mastering/loudness';
import type { MonoCompatibilityReport } from '@/ui/mastering/stereo-analysis';
import type { StreamingPlatformConfig, StreamingTarget } from '@/ui/mastering/streaming';

/**
 * Preview pane: the render controls (render / cancel), the A/B comparison
 * toggle, preview playback, the streaming-target check, the render progress
 * bar, the loudness readout and the streaming-target table. Presentational —
 * the preview controller, the panel-local playback and the wasm measurement
 * are owned by the panel, which this pane drives through emitted intents.
 */

defineProps<{
  /** True while a preview render is in flight. */
  rendering: boolean;
  /** Render progress over both variants (0..1). */
  progress: number;
  /** Last reported render stage. */
  stage: string;
  /** Render failure message, or null when there is none. */
  renderError: string | null;
  /** True when the chain-applied render is available. */
  hasProcessed: boolean;
  /** True when the chain-bypassed render is available. */
  hasBypassed: boolean;
  /** Active A/B variant. */
  variant: 'processed' | 'bypassed';
  /** True when the active variant has a playable render. */
  canPlay: boolean;
  /** True while preview playback is running. */
  isPlaying: boolean;
  /** True when the ready render no longer matches the current project. */
  stale: boolean;
  /** True while a streaming-target check is in flight. */
  checkingTargets: boolean;
  /** Editable platform target configs passed to libsonare. */
  streamingPlatforms: ReadonlyArray<StreamingPlatformConfig>;
  /** Loudness readout rows (A/B per metric). */
  loudnessRows: ReadonlyArray<LoudnessRow>;
  /** True when the processed render risks clipping the ceiling. */
  clipWarning: boolean;
  /** Extent of the clipping in the processed preview; empty when clean. */
  clipCensus: string;
  /** Why the preset missed its loudness target; empty when it reached it. */
  targetLimited: string;
  /** Processed-render mono compatibility analysis, or null until unavailable/not measured. */
  monoCompatibility: MonoCompatibilityReport | null;
  /** Per-platform streaming targets, or null until checked. */
  streamingTargets: ReadonlyArray<StreamingTarget> | null;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'cancel'): void;
  (event: 'select-variant', variant: 'processed' | 'bypassed'): void;
  (event: 'toggle-play'): void;
  (event: 'check-targets'): void;
  (event: 'add-streaming-platform'): void;
  (event: 'remove-streaming-platform', index: number): void;
  (
    event: 'update-streaming-platform',
    index: number,
    field: keyof StreamingPlatformConfig,
    value: string,
  ): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="preview-pane">
    <div class="preview-controls">
      <button type="button" class="preview-button" :disabled="rendering" @click="emit('preview')">
        {{ t.shell.mastering.preview }}
      </button>
      <button v-if="rendering" type="button" class="preview-cancel" @click="emit('cancel')">
        {{ t.shell.mastering.cancel }}
      </button>
      <div class="ab-toggle" role="group" :aria-label="t.shell.mastering.abComparison">
        <button
          type="button"
          class="ab-button"
          :class="{ active: variant === 'processed' }"
          :disabled="!hasProcessed"
          v-tooltip="t.shell.mastering.withChain"
          :aria-label="t.shell.mastering.previewWithChain"
          :aria-pressed="variant === 'processed'"
          @click="emit('select-variant', 'processed')"
        >
          A
        </button>
        <button
          type="button"
          class="ab-button"
          :class="{ active: variant === 'bypassed' }"
          :disabled="!hasBypassed"
          v-tooltip="t.shell.mastering.chainBypassed"
          :aria-label="t.shell.mastering.previewBypassed"
          :aria-pressed="variant === 'bypassed'"
          @click="emit('select-variant', 'bypassed')"
        >
          B
        </button>
      </div>
      <button type="button" class="play-button" :disabled="!canPlay" @click="emit('toggle-play')">
        <TransportIcon :name="isPlaying ? 'stop' : 'play'" class="play-icon" />
        <span>{{ isPlaying ? t.shell.mastering.stop : t.shell.mastering.play }}</span>
      </button>
      <span v-if="stale" class="preview-stale" v-tooltip="t.shell.mastering.staleTitle">
        {{ t.shell.mastering.stale }}
      </span>
      <button
        type="button"
        class="targets-button"
        :disabled="checkingTargets"
        v-tooltip="t.shell.mastering.streaming.title"
        @click="emit('check-targets')"
      >
        {{ checkingTargets ? t.shell.mastering.streaming.checking : t.shell.mastering.streaming.check }}
      </button>
    </div>
    <div class="targets-editor" :aria-label="t.shell.mastering.streaming.targets">
      <div class="targets-editor-head">
        <span>{{ t.shell.mastering.streaming.targets }}</span>
        <button
          type="button"
          class="targets-add"
          v-tooltip="t.shell.mastering.streaming.add"
          :aria-label="t.shell.mastering.streaming.add"
          @click="emit('add-streaming-platform')"
        >
          +
        </button>
      </div>
      <div
        v-for="(platform, index) in streamingPlatforms"
        :key="`${platform.name}:${index}`"
        class="targets-editor-row"
      >
        <input
          class="targets-name-input"
          :aria-label="t.shell.mastering.streaming.platform"
          :value="platform.name"
          @input="
            emit(
              'update-streaming-platform',
              index,
              'name',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
        <input
          class="targets-number-input"
          type="number"
          step="0.1"
          :aria-label="t.shell.mastering.streaming.targetLufs"
          :value="platform.targetLufs"
          @input="
            emit(
              'update-streaming-platform',
              index,
              'targetLufs',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
        <input
          class="targets-number-input"
          type="number"
          step="0.1"
          :aria-label="t.shell.mastering.streaming.ceiling"
          :value="platform.ceilingDb"
          @input="
            emit(
              'update-streaming-platform',
              index,
              'ceilingDb',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
        <button
          type="button"
          class="targets-remove"
          v-tooltip="t.shell.mastering.streaming.remove"
          :aria-label="t.shell.mastering.streaming.remove"
          :disabled="streamingPlatforms.length <= 1"
          @click="emit('remove-streaming-platform', index)"
        >
          ×
        </button>
      </div>
    </div>
    <div v-if="rendering" class="preview-progress">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${Math.round(progress * 100)}%` }" />
      </div>
      <span class="progress-stage">{{ stage }}</span>
    </div>
    <p v-if="renderError" class="mastering-error" role="alert">
      {{ renderError }}
    </p>
    <MasteringLoudnessReadout
      :rows="loudnessRows"
      :clip-warning="clipWarning"
      :clip-census="clipCensus"
      :target-limited="targetLimited"
    />
    <section
      v-if="monoCompatibility"
      class="mono-compat"
      :class="{ risk: !monoCompatibility.compatible }"
      :aria-label="t.shell.mastering.monoCompatibility.title"
    >
      <div class="mono-head">
        <span class="mono-title">{{ t.shell.mastering.monoCompatibility.title }}</span>
        <span class="mono-status">
          {{
            monoCompatibility.compatible
              ? t.shell.mastering.monoCompatibility.pass
              : t.shell.mastering.monoCompatibility.warn
          }}
        </span>
      </div>
      <dl class="mono-grid">
        <div>
          <dt>{{ t.shell.mastering.monoCompatibility.correlation }}</dt>
          <dd>{{ monoCompatibility.correlation.toFixed(2) }}</dd>
        </div>
        <div>
          <dt>{{ t.shell.mastering.monoCompatibility.width }}</dt>
          <dd>{{ monoCompatibility.width.toFixed(2) }}</dd>
        </div>
        <div>
          <dt>{{ t.shell.mastering.monoCompatibility.monoPeak }}</dt>
          <dd>{{ formatLevel(monoCompatibility.monoPeakDb) }} dBFS</dd>
        </div>
      </dl>
    </section>
    <StreamingTargetsTable
      v-if="streamingTargets && streamingTargets.length"
      :targets="streamingTargets"
    />
  </div>
</template>

<style scoped src="./preview-pane.css"></style>
