<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useI18n } from '@/ui/i18n';
import type { WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  analyzeRepairBlocked: string | null;
  restoreBlocked: string | null;
  restorePresetId: string;
  restorePresetOptions: ReadonlyArray<{ value: string; label: string }>;
}>();

const emit = defineEmits<{
  'analyze-repair': [];
  declick: [];
  declip: [];
  decrackle: [];
  dehum: [];
  dereverb: [];
  'trim-silence-repair': [];
  denoise: [];
  restore: [];
  'select-restore-preset': [value: string];
}>();

const denoiseDepthInput = defineModel<string>('denoiseDepthInput', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.repair">
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!analyzeRepairBlocked"
        v-tooltip="{ text: se.analyzeRepairTitle, reason: analyzeRepairBlocked }"
        @click="emit('analyze-repair')"
      >
        {{ se.analyzeRepair }}
      </button>
    </div>
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!opBlocked.declick"
        v-tooltip="{ text: se.declickTitle, reason: opBlocked.declick }"
        @click="emit('declick')"
      >
        {{ se.declick }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.declip"
        v-tooltip="{ text: se.declipTitle, reason: opBlocked.declip }"
        @click="emit('declip')"
      >
        {{ se.declip }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.decrackle"
        v-tooltip="{ text: se.decrackleTitle, reason: opBlocked.decrackle }"
        @click="emit('decrackle')"
      >
        {{ se.decrackle }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.dehum"
        v-tooltip="{ text: se.dehumTitle, reason: opBlocked.dehum }"
        @click="emit('dehum')"
      >
        {{ se.dehum }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.dereverb"
        v-tooltip="{ text: se.dereverbTitle, reason: opBlocked.dereverb }"
        @click="emit('dereverb')"
      >
        {{ se.dereverb }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.trimSilence"
        v-tooltip="{ text: se.trimSilenceTitle, reason: opBlocked.trimSilence }"
        @click="emit('trim-silence-repair')"
      >
        {{ se.trimSilence }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ text: se.denoiseDepthTitle, reason: opBlocked.denoise }">
        {{ se.denoiseDepth }}
        <input
          v-model="denoiseDepthInput"
          class="num"
          type="number"
          min="0"
          step="1"
          :disabled="!!opBlocked.denoise"
        />
        <span class="unit">dB</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.denoise"
        v-tooltip="{ text: se.denoiseTitle, reason: opBlocked.denoise }"
        @click="emit('denoise')"
      >
        {{ se.denoise }}
      </button>
    </div>
    <div class="op-cluster">
      <SelectMenu
        :model-value="restorePresetId"
        size="sm"
        :options="restorePresetOptions"
        :disabled="!!restoreBlocked"
        :reason="restoreBlocked"
        :aria-label="se.restorePreset"
        @change="(value: string) => emit('select-restore-preset', value)"
      />
      <button
        type="button"
        :disabled="!!restoreBlocked"
        v-tooltip="{ text: se.restoreTitle, reason: restoreBlocked }"
        @click="emit('restore')"
      >
        {{ se.restore }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
