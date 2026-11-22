<script setup lang="ts">
import type { StereoMonoCompatCheckResult, StreamingPlatform } from '@libraz/libsonare';
import { computed } from 'vue';
import MasteringLoudnessReadout from '@/components/mastering/MasteringLoudnessReadout.vue';
import StreamingTargetsTable from '@/components/mastering/StreamingTargetsTable.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { clamp01 } from '@/lib/math';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { formatLevel, type LoudnessRow } from '@/ui/mastering/loudness';
import type { StreamingTarget } from '@/ui/mastering/streaming';

/**
 * Preview pane: the render controls (render / cancel), the A/B comparison
 * toggle, preview playback, the streaming-target check, the render progress
 * bar, the loudness readout and the streaming-target table. Presentational —
 * the preview controller, the panel-local playback and the wasm measurement
 * are owned by the panel, which this pane drives through emitted intents.
 */

const props = defineProps<{
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
  /** True when monitor-only loudness matching is enabled. */
  levelMatchEnabled: boolean;
  /** True when both A/B integrated-LUFS reports are valid and current. */
  levelMatchAvailable: boolean;
  /** Monitor attenuation applied to the processed variant, in dB. */
  processedLevelMatchDb: number;
  /** Monitor attenuation applied to the bypassed variant, in dB. */
  bypassedLevelMatchDb: number;
  /** True when the ready render no longer matches the current project. */
  stale: boolean;
  /** True while a streaming-target check is in flight. */
  checkingTargets: boolean;
  /** Editable platform target configs passed to libsonare. */
  streamingPlatforms: ReadonlyArray<StreamingPlatform>;
  /** Loudness readout rows (A/B per metric). */
  loudnessRows: ReadonlyArray<LoudnessRow>;
  /** True when the processed render risks clipping the ceiling. */
  clipWarning: boolean;
  /** Extent of the clipping in the processed preview; empty when clean. */
  clipCensus: string;
  /** Why the preset missed its loudness target; empty when it reached it. */
  targetLimited: string;
  /** Processed-render mono compatibility analysis, or null until unavailable/not measured. */
  monoCompatibility: StereoMonoCompatCheckResult | null;
  /** Per-platform streaming targets, or null until checked. */
  streamingTargets: ReadonlyArray<StreamingTarget> | null;
}>();

const emit = defineEmits<{
  (event: 'preview'): void;
  (event: 'cancel'): void;
  (event: 'select-variant', variant: 'processed' | 'bypassed'): void;
  (event: 'toggle-play'): void;
  (event: 'toggle-level-match', enabled: boolean): void;
  (event: 'check-targets'): void;
  (event: 'add-streaming-platform'): void;
  (event: 'remove-streaming-platform', index: number): void;
  (
    event: 'update-streaming-platform',
    index: number,
    field: keyof StreamingPlatform,
    value: string,
  ): void;
}>();

const { t } = useI18n();

const reasons = computed(() => t.value.shell.mastering.reasons);
const hasRenders = computed(() => props.hasProcessed && props.hasBypassed);
const previewBlocked = computed(() => firstBlock([props.rendering, reasons.value.rendering]));
const processedBlocked = computed(() => firstBlock([!props.hasProcessed, reasons.value.noPreview]));
const bypassedBlocked = computed(() => firstBlock([!props.hasBypassed, reasons.value.noPreview]));
const playBlocked = computed(() => firstBlock([!props.canPlay, reasons.value.noPreview]));
/** Why level matching is not applied while it is switched on. */
const levelMatchReason = computed(() =>
  props.levelMatchEnabled && !props.levelMatchAvailable
    ? firstBlock(
        [!hasRenders.value, reasons.value.noPreview],
        [props.stale, reasons.value.previewStale],
        [true, reasons.value.noLoudness],
      )
    : null,
);
const checkBlocked = computed(() => firstBlock([props.checkingTargets, reasons.value.checking]));
const removeTargetBlocked = computed(() =>
  firstBlock([props.streamingPlatforms.length <= 1, reasons.value.lastTarget]),
);

function formatAttenuation(value: number): string {
  const db = Math.abs(value) < 0.05 ? 0 : value;
  return `${db.toFixed(1)} dB`;
}
</script>

<template>
  <div class="preview-pane">
    <div class="preview-controls">
      <div class="preview-group">
        <button
          type="button"
          class="preview-button"
          :disabled="!!previewBlocked"
          v-tooltip="{ text: t.shell.mastering.previewTitle, reason: previewBlocked }"
          @click="emit('preview')"
        >
          <span v-if="rendering" class="spinner button-spinner" aria-hidden="true" />
          {{ t.shell.mastering.preview }}
        </button>
        <button
          v-if="rendering"
          type="button"
          class="preview-cancel"
          v-tooltip="t.shell.mastering.cancelTitle"
          @click="emit('cancel')"
        >
          {{ t.common.cancel }}
        </button>
        <span v-if="stale" class="preview-stale animate-pop" v-tooltip="t.shell.mastering.staleTitle">
          {{ t.shell.mastering.stale }}
        </span>
      </div>
      <div class="preview-group">
        <div class="ab-toggle" role="group" :aria-label="t.shell.mastering.abComparison">
          <button
            type="button"
            class="ab-button"
            :class="{ active: variant === 'processed' }"
            :disabled="!!processedBlocked"
            v-tooltip="{ text: t.shell.mastering.withChain, reason: processedBlocked }"
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
            :disabled="!!bypassedBlocked"
            v-tooltip="{ text: t.shell.mastering.chainBypassed, reason: bypassedBlocked }"
            :aria-label="t.shell.mastering.previewBypassed"
            :aria-pressed="variant === 'bypassed'"
            @click="emit('select-variant', 'bypassed')"
          >
            B
          </button>
        </div>
        <button
          type="button"
          class="play-button"
          :class="{ playing: isPlaying }"
          :disabled="!!playBlocked"
          v-tooltip="{ text: t.shell.mastering.playTitle, reason: playBlocked }"
          @click="emit('toggle-play')"
        >
          <TransportIcon :name="isPlaying ? 'stop' : 'play'" class="play-icon" />
          <span>{{ isPlaying ? t.shell.mastering.stop : t.shell.mastering.play }}</span>
        </button>
      </div>
      <div class="preview-group">
        <label class="level-match-toggle" v-tooltip="t.shell.mastering.levelMatchTitle">
          <input
            type="checkbox"
            :checked="levelMatchEnabled"
            :aria-label="t.shell.mastering.levelMatch"
            @change="emit('toggle-level-match', ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t.shell.mastering.levelMatch }}</span>
        </label>
        <span
          class="level-match-status"
          :class="{ unavailable: !!levelMatchReason && hasRenders }"
          role="status"
          :aria-label="t.shell.mastering.levelMatchStatus"
          v-tooltip="{ text: t.shell.mastering.levelMatchStatus, reason: levelMatchReason }"
        >
          <template v-if="!levelMatchEnabled">{{ t.shell.mastering.levelMatchOff }}</template>
          <template v-else-if="!levelMatchAvailable">
            {{ t.shell.mastering.levelMatchUnavailable }}
          </template>
          <template v-else>
            A {{ formatAttenuation(processedLevelMatchDb) }} · B
            {{ formatAttenuation(bypassedLevelMatchDb) }}
          </template>
        </span>
      </div>
      <button
        type="button"
        class="targets-button"
        :disabled="!!checkBlocked"
        v-tooltip="{ text: t.shell.mastering.streaming.title, reason: checkBlocked }"
        @click="emit('check-targets')"
      >
        <span v-if="checkingTargets" class="spinner button-spinner" aria-hidden="true" />
        {{ checkingTargets ? t.shell.mastering.streaming.checking : t.shell.mastering.streaming.check }}
      </button>
    </div>
    <details class="targets-editor">
      <summary class="targets-editor-summary">
        {{ t.shell.mastering.streaming.targets }}
        <span class="targets-editor-count">{{ streamingPlatforms.length }}</span>
      </summary>
      <div class="targets-editor-body">
        <div class="targets-editor-head">
          <span>{{ t.shell.mastering.streaming.platform }}</span>
          <span class="targets-editor-num">{{ t.shell.mastering.streaming.targetLufs }}</span>
          <span class="targets-editor-num">{{ t.shell.mastering.streaming.ceiling }}</span>
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
            :value="platform.ceilingDbtp"
            @input="
              emit(
                'update-streaming-platform',
                index,
                'ceilingDbtp',
                ($event.target as HTMLInputElement).value,
              )
            "
          />
          <button
            type="button"
            class="targets-remove"
            v-tooltip="{ text: t.shell.mastering.streaming.remove, reason: removeTargetBlocked }"
            :aria-label="t.shell.mastering.streaming.remove"
            :disabled="!!removeTargetBlocked"
            @click="emit('remove-streaming-platform', index)"
          >
            ×
          </button>
        </div>
      </div>
    </details>
    <div v-if="rendering" class="preview-progress">
      <div class="progress-track">
        <div class="progress-fill" :style="{ transform: `scaleX(${clamp01(progress)})` }" />
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
      class="mono-compat view-enter"
      :class="{ risk: !monoCompatibility.likelyMonoCompatible }"
      :aria-label="t.shell.mastering.monoCompatibility.title"
    >
      <div class="mono-head">
        <span class="mono-title">{{ t.shell.mastering.monoCompatibility.title }}</span>
        <span class="mono-status">
          {{
            monoCompatibility.likelyMonoCompatible
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
          <dd>{{ formatLevel(monoCompatibility.width, 2) }}</dd>
        </div>
        <div>
          <dt>{{ t.shell.mastering.monoCompatibility.monoPeak }}</dt>
          <dd>{{ formatLevel(monoCompatibility.monoPeak) }} dBFS</dd>
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
