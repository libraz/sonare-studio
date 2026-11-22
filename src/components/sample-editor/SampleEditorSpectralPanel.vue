<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useI18n } from '@/ui/i18n';
import type { SpectralEditMode, WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  spectralGainBlocked: string | null;
  spectralModeOptions: ReadonlyArray<{ value: string; label: string }>;
}>();

const emit = defineEmits<{
  harmonic: [];
  percussive: [];
  'spectral-denoise': [];
  'spectral-edit': [];
}>();

const spectralModeInput = defineModel<SpectralEditMode>('spectralModeInput', { required: true });
const spectralLowHzInput = defineModel<string>('spectralLowHzInput', { required: true });
const spectralHighHzInput = defineModel<string>('spectralHighHzInput', { required: true });
const spectralGainDbInput = defineModel<string>('spectralGainDbInput', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);

function setSpectralMode(value: string): void {
  spectralModeInput.value = value as SpectralEditMode;
}
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.spectral">
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!opBlocked.harmonic"
        v-tooltip="{ text: se.harmonicTitle, reason: opBlocked.harmonic }"
        @click="emit('harmonic')"
      >
        {{ se.harmonic }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.percussive"
        v-tooltip="{ text: se.percussiveTitle, reason: opBlocked.percussive }"
        @click="emit('percussive')"
      >
        {{ se.percussive }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.spectralEdit"
        v-tooltip="{ text: se.spectralDenoiseTitle, reason: opBlocked.spectralEdit }"
        @click="emit('spectral-denoise')"
      >
        {{ se.spectralDenoise }}
      </button>
    </div>
    <div class="op-cluster">
      <SelectMenu
        :model-value="spectralModeInput"
        size="sm"
        :options="spectralModeOptions"
        :disabled="!!opBlocked.spectralEdit"
        :reason="opBlocked.spectralEdit"
        :aria-label="se.spectralMode"
        @change="setSpectralMode"
      />
      <label v-tooltip="{ text: se.spectralLowTitle, reason: opBlocked.spectralEdit }">
        {{ se.spectralLow }}
        <input
          v-model="spectralLowHzInput"
          class="num freq"
          type="number"
          step="100"
          min="0"
          :disabled="!!opBlocked.spectralEdit"
        />
      </label>
      <label v-tooltip="{ text: se.spectralHighTitle, reason: opBlocked.spectralEdit }">
        {{ se.spectralHigh }}
        <input
          v-model="spectralHighHzInput"
          class="num freq"
          type="number"
          step="100"
          min="0"
          :disabled="!!opBlocked.spectralEdit"
        />
        <span class="unit">Hz</span>
      </label>
      <label v-tooltip="{ text: se.spectralGainTitle, reason: spectralGainBlocked }">
        {{ se.spectralGain }}
        <input
          v-model="spectralGainDbInput"
          class="num"
          type="number"
          step="1"
          :disabled="!!spectralGainBlocked"
        />
        <span class="unit">dB</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.spectralEdit"
        v-tooltip="{ text: se.spectralEditTitle, reason: opBlocked.spectralEdit }"
        @click="emit('spectral-edit')"
      >
        {{ se.spectralEdit }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>

<style scoped>
.toolbar .num.freq {
  width: 72px;
}
</style>
