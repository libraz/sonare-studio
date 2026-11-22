<script setup lang="ts">
import { computed } from 'vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { NumericInputValue } from '@/ui/numeric-input';
import type { WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  onsetFrames: number[];
}>();

const emit = defineEmits<{
  'detect-transients': [];
  'detect-notes': [];
  'split-silence': [];
  'clear-transients': [];
}>();

const silenceThresholdInput = defineModel<NumericInputValue>('silenceThresholdInput', {
  required: true,
});

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.markers">
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!opBlocked.detectOnsets"
        v-tooltip="{ text: se.detectTransientsTitle, reason: opBlocked.detectOnsets }"
        @click="emit('detect-transients')"
      >
        {{ se.detectTransients }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.detectNotes"
        v-tooltip="{ text: se.detectNotesTitle, reason: opBlocked.detectNotes }"
        @click="emit('detect-notes')"
      >
        {{ se.detectNotes }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ text: se.silenceThresholdTitle, reason: opBlocked.splitSilence }">
        {{ se.silenceThreshold }}
        <input
          v-model="silenceThresholdInput"
          class="num"
          type="number"
          step="1"
          min="1"
          :disabled="!!opBlocked.splitSilence"
        />
        <span class="unit">dB</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.splitSilence"
        v-tooltip="{ text: se.splitSilenceTitle, reason: opBlocked.splitSilence }"
        @click="emit('split-silence')"
      >
        {{ se.splitSilence }}
      </button>
    </div>
    <div v-if="onsetFrames.length > 0" class="op-cluster">
      <button
        type="button"
        v-tooltip="se.clearTransientsTitle"
        @click="emit('clear-transients')"
      >
        {{ formatMessage(se.clearTransients, { count: onsetFrames.length }) }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
