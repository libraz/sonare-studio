<script setup lang="ts">
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
import StreamingTargetsTable from '@/components/mastering/StreamingTargetsTable.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { useI18n } from '@/ui/i18n';
import type { StreamingTarget } from '@/ui/mastering/streaming';

/**
 * Preview pane: the render controls (render / cancel), the A/B comparison
 * toggle, preview playback, the streaming-target check, the render progress
 * bar, the loudness readout and the streaming-target table. Presentational —
 * the preview controller, the panel-local playback and the wasm measurement
 * are owned by the panel, which this pane drives through emitted intents.
 */

/** One loudness readout row: label plus the A and B values. */
interface LoudnessRow {
  label: string;
  unit: string;
  a: number | undefined;
  b: number | undefined;
}

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
  /** Loudness readout rows (A/B per metric). */
  loudnessRows: ReadonlyArray<LoudnessRow>;
  /** True when the processed render risks clipping the ceiling. */
  clipWarning: boolean;
  /** Per-platform streaming targets, or null until checked. */
  streamingTargets: ReadonlyArray<StreamingTarget> | null;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'cancel'): void;
  (event: 'select-variant', variant: 'processed' | 'bypassed'): void;
  (event: 'toggle-play'): void;
  (event: 'check-targets'): void;
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
          :title="t.shell.mastering.withChain"
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
          :title="t.shell.mastering.chainBypassed"
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
      <span v-if="stale" class="preview-stale" :title="t.shell.mastering.staleTitle">
        {{ t.shell.mastering.stale }}
      </span>
      <button
        type="button"
        class="targets-button"
        :disabled="checkingTargets"
        :title="t.shell.mastering.streaming.title"
        @click="emit('check-targets')"
      >
        {{ checkingTargets ? t.shell.mastering.streaming.checking : t.shell.mastering.streaming.check }}
      </button>
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
    <MasteringLoudnessReadout :rows="loudnessRows" :clip-warning="clipWarning" />
    <StreamingTargetsTable
      v-if="streamingTargets && streamingTargets.length"
      :targets="streamingTargets"
    />
  </div>
</template>

<style scoped src="./preview-pane.css"></style>
