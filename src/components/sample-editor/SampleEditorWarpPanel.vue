<script setup lang="ts">
import { computed } from 'vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import type { WarpAnchor } from '@/project/types';
import { useI18n } from '@/ui/i18n';
import type { NumericInputValue } from '@/ui/numeric-input';

defineProps<{
  warpEnabled: boolean;
  warpAnchors: ReadonlyArray<WarpAnchor>;
  warpRatioHint: string;
  warpOffBlocked: string | null;
  addAnchorBlocked: string | null;
}>();

const emit = defineEmits<{
  'toggle-warp': [];
  'warp-bpm-change': [];
  'anchor-edit': [index: number, field: 'ppq' | 'sourceSeconds', event: Event];
  'remove-anchor': [index: number];
  'add-anchor': [];
  'auto-warp': [];
}>();

const warpBpmInput = defineModel<NumericInputValue>('warpBpmInput', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="warp">
    <div class="toolbar">
      <span class="warp-title">{{ se.warp }}</span>
      <ToggleButton
        :model-value="warpEnabled"
        :label="se.followTempo"
        :title="se.warpTitle"
        size="sm"
        @update:model-value="emit('toggle-warp')"
      />
      <label v-tooltip="{ text: se.sourceBpmTitle, reason: warpOffBlocked }">
        {{ se.sourceBpm }}
        <input
          v-model="warpBpmInput"
          class="num warp-source-bpm"
          type="number"
          step="0.1"
          min="1"
          :disabled="!!warpOffBlocked"
          @change="emit('warp-bpm-change')"
        />
      </label>
      <button
        type="button"
        class="warp-anchor-add"
        :disabled="!!addAnchorBlocked"
        v-tooltip="{ text: se.addAnchorTitle, reason: addAnchorBlocked }"
        @click="emit('add-anchor')"
      >
        {{ se.addAnchor }}
      </button>
      <button
        type="button"
        class="warp-auto"
        v-tooltip="se.autoWarpTitle"
        @click="emit('auto-warp')"
      >
        {{ se.autoWarp }}
      </button>
      <span
        v-if="warpRatioHint"
        class="warp-segments"
        v-tooltip="se.ratioTitle"
      >
        {{ warpRatioHint }}
      </span>
    </div>
    <div
      v-for="(anchor, index) in warpAnchors"
      :key="`${index}-${anchor.ppq}`"
      class="toolbar warp-anchor"
    >
      <label v-tooltip="{ reason: warpOffBlocked }">
        {{ se.beat }}
        <input
          class="num"
          type="number"
          step="0.25"
          :disabled="!!warpOffBlocked"
          :value="anchor.ppq"
          @change="emit('anchor-edit', index, 'ppq', $event)"
        />
      </label>
      <label v-tooltip="{ reason: warpOffBlocked }">
        {{ se.sourceSeconds }}
        <input
          class="num"
          type="number"
          step="0.01"
          :disabled="!!warpOffBlocked"
          :value="anchor.sourceSeconds"
          @change="emit('anchor-edit', index, 'sourceSeconds', $event)"
        />
      </label>
      <button
        type="button"
        class="warp-anchor-remove"
        :disabled="!!warpOffBlocked"
        v-tooltip="{ text: se.removeAnchorTitle, reason: warpOffBlocked }"
        @click="emit('remove-anchor', index)"
      >
        {{ se.remove }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>

<style scoped>
.warp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
}

.warp-title {
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  margin-right: 2px;
}

.warp-segments {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.warp-anchor {
  padding-left: 14px;
}
</style>
