<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useI18n } from '@/ui/i18n';
import type { NumericInputValue } from '@/ui/numeric-input';
import { MODE_OPTIONS } from '@/ui/sample-editor/scales';
import type { WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  rootOptions: ReadonlyArray<{ value: string; label: string }>;
}>();

const emit = defineEmits<{
  'pitch-shift': [];
  'pitch-correct': [];
  'pitch-correct-timevarying': [];
  'tune-reference': [];
  'scale-correct': [];
  'auto-tune': [];
}>();

const pitchInput = defineModel<NumericInputValue>('pitchInput', { required: true });
const tuneNoteInput = defineModel<string>('tuneNoteInput', { required: true });
const scaleRootInput = defineModel<string>('scaleRootInput', { required: true });
const scaleModeInput = defineModel<string>('scaleModeInput', { required: true });
const autoTuneDetect = defineModel<boolean>('autoTuneDetect', { required: true });
const autoTuneStrengthInput = defineModel<NumericInputValue>('autoTuneStrengthInput', {
  required: true,
});

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.pitch">
    <div class="op-cluster">
      <label v-tooltip="{ text: se.pitchTitle, reason: opBlocked.pitchShift }">
        {{ se.pitch }}
        <input
          v-model="pitchInput"
          class="num"
          type="number"
          step="1"
          :disabled="!!opBlocked.pitchShift"
        />
        <span class="unit">st</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.pitchShift"
        v-tooltip="{ text: se.pitchTitle, reason: opBlocked.pitchShift }"
        @click="emit('pitch-shift')"
      >
        {{ t.common.apply }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ text: se.tuneNoteTitle, reason: opBlocked.pitchCorrect }">
        {{ se.tune }}
        <input
          v-model="tuneNoteInput"
          class="num"
          type="text"
          :disabled="!!opBlocked.pitchCorrect"
        />
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.pitchCorrect"
        v-tooltip="{ text: se.tuneTitle, reason: opBlocked.pitchCorrect }"
        @click="emit('pitch-correct')"
      >
        {{ t.common.apply }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.pitchCorrectTimevarying"
        v-tooltip="{ text: se.tuneContourTitle, reason: opBlocked.pitchCorrectTimevarying }"
        @click="emit('pitch-correct-timevarying')"
      >
        {{ se.tuneContour }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.tuneReference"
        v-tooltip="{ text: se.tuneReferenceTitle, reason: opBlocked.tuneReference }"
        @click="emit('tune-reference')"
      >
        {{ se.tuneReference }}
      </button>
    </div>
    <div class="op-cluster">
      <span class="cluster-label">{{ se.tuneScale }}</span>
      <SelectMenu
        :model-value="scaleRootInput"
        size="sm"
        :options="rootOptions"
        :disabled="!!opBlocked.scaleCorrect"
        :reason="opBlocked.scaleCorrect"
        :aria-label="se.scaleRoot"
        @change="(value: string) => (scaleRootInput = value)"
      />
      <SelectMenu
        :model-value="scaleModeInput"
        size="sm"
        :options="MODE_OPTIONS"
        :disabled="!!opBlocked.scaleCorrect"
        :reason="opBlocked.scaleCorrect"
        :aria-label="se.scaleMode"
        @change="(value: string) => (scaleModeInput = value)"
      />
      <button
        type="button"
        :disabled="!!opBlocked.scaleCorrect"
        v-tooltip="{ text: se.tuneScaleTitle, reason: opBlocked.scaleCorrect }"
        @click="emit('scale-correct')"
      >
        {{ t.common.apply }}
      </button>
    </div>
    <div class="op-cluster">
      <ToggleButton
        v-model="autoTuneDetect"
        :label="se.autoTuneDetect"
        :title="se.autoTuneDetectTitle"
        :reason="opBlocked.autoTune"
        size="sm"
      />
      <label v-tooltip="{ text: se.autoTuneStrengthTitle, reason: opBlocked.autoTune }">
        {{ se.autoTuneStrength }}
        <input
          v-model="autoTuneStrengthInput"
          class="num"
          type="number"
          step="5"
          min="0"
          max="100"
          :disabled="!!opBlocked.autoTune"
        />
        <span class="unit">%</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.autoTune"
        v-tooltip="{ text: se.autoTuneTitle, reason: opBlocked.autoTune }"
        @click="emit('auto-tune')"
      >
        {{ se.autoTune }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>

<style scoped>
.cluster-label {
  color: var(--text-2);
}
</style>
