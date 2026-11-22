<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useI18n } from '@/ui/i18n';
import type { WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  estimateRoomBlocked: string | null;
  analyzeImpulseBlocked: string | null;
  detectAcousticBlocked: string | null;
  roomPresetOptions: ReadonlyArray<{ value: string; label: string }>;
}>();

const emit = defineEmits<{
  'place-in-room': [];
  'synthesize-rir': [];
  'estimate-room': [];
  'analyze-impulse-response': [];
  'detect-acoustic': [];
}>();

const roomPresetId = defineModel<string>('roomPresetId', { required: true });
const roomWetInput = defineModel<string>('roomWetInput', { required: true });
const roomAirAbsorption = defineModel<boolean>('roomAirAbsorption', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.room">
    <div class="op-cluster">
      <SelectMenu
        :model-value="roomPresetId"
        size="sm"
        :options="roomPresetOptions"
        :disabled="!!opBlocked.roomMorph"
        :reason="opBlocked.roomMorph"
        :aria-label="se.roomPreset"
        @change="(value: string) => (roomPresetId = value)"
      />
      <label v-tooltip="{ text: se.roomWetTitle, reason: opBlocked.roomMorph }">
        {{ se.roomWet }}
        <input
          v-model="roomWetInput"
          class="num"
          type="number"
          step="5"
          min="0"
          max="100"
          :disabled="!!opBlocked.roomMorph"
        />
        <span class="unit">%</span>
      </label>
      <ToggleButton
        v-model="roomAirAbsorption"
        :label="se.roomAirAbsorption"
        :title="se.roomAirAbsorptionTitle"
        :reason="opBlocked.roomMorph"
        size="sm"
      />
      <button
        type="button"
        :disabled="!!opBlocked.roomMorph"
        v-tooltip="{ text: se.placeInRoomTitle, reason: opBlocked.roomMorph }"
        @click="emit('place-in-room')"
      >
        {{ se.placeInRoom }}
      </button>
      <button
        type="button"
        :disabled="!!opBlocked.synthesizeRir"
        v-tooltip="{ text: se.synthesizeRirTitle, reason: opBlocked.synthesizeRir }"
        @click="emit('synthesize-rir')"
      >
        {{ se.synthesizeRir }}
      </button>
    </div>
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!estimateRoomBlocked"
        v-tooltip="{ text: se.estimateRoomTitle, reason: estimateRoomBlocked }"
        @click="emit('estimate-room')"
      >
        {{ se.estimateRoom }}
      </button>
      <button
        type="button"
        :disabled="!!analyzeImpulseBlocked"
        v-tooltip="{ text: se.analyzeImpulseTitle, reason: analyzeImpulseBlocked }"
        @click="emit('analyze-impulse-response')"
      >
        {{ se.analyzeImpulse }}
      </button>
      <button
        type="button"
        :disabled="!!detectAcousticBlocked"
        v-tooltip="{ text: se.detectAcousticTitle, reason: detectAcousticBlocked }"
        @click="emit('detect-acoustic')"
      >
        {{ se.detectAcoustic }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
