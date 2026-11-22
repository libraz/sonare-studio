<script setup lang="ts">
import { computed } from 'vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useI18n } from '@/ui/i18n';
import type { WasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

defineProps<{
  opBlocked: Record<keyof WasmOpAvailability, string | null>;
  stretchInputBlocked: string | null;
  noteStretchBlocked: string | null;
  noteMoveBlocked: string | null;
}>();

const emit = defineEmits<{
  'time-stretch': [];
  'note-stretch': [];
  'note-move': [];
  'voice-change': [];
}>();

const stretchInput = defineModel<string>('stretchInput', { required: true });
const noteShiftMsInput = defineModel<string>('noteShiftMsInput', { required: true });
const voicePitchInput = defineModel<string>('voicePitchInput', { required: true });
const voiceFormantInput = defineModel<string>('voiceFormantInput', { required: true });
const voiceFormantAbsolute = defineModel<boolean>('voiceFormantAbsolute', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.time">
    <div class="op-cluster">
      <label v-tooltip="{ text: se.stretchTitle, reason: stretchInputBlocked }">
        {{ se.stretch }}
        <input
          v-model="stretchInput"
          class="num"
          type="number"
          step="0.05"
          min="0.1"
          :disabled="!!stretchInputBlocked"
        />
        <span class="unit">×</span>
      </label>
      <button
        type="button"
        :disabled="!!opBlocked.timeStretch"
        v-tooltip="{ text: se.stretchTitle, reason: opBlocked.timeStretch }"
        @click="emit('time-stretch')"
      >
        {{ t.common.apply }}
      </button>
      <button
        type="button"
        :disabled="!!noteStretchBlocked"
        v-tooltip="{ text: se.noteStretchTitle, reason: noteStretchBlocked }"
        @click="emit('note-stretch')"
      >
        {{ se.noteStretch }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ text: se.noteMoveTitle, reason: noteMoveBlocked }">
        {{ se.noteShift }}
        <input
          v-model="noteShiftMsInput"
          class="num"
          type="number"
          step="5"
          :disabled="!!noteMoveBlocked"
        />
        <span class="unit">ms</span>
      </label>
      <button
        type="button"
        :disabled="!!noteMoveBlocked"
        v-tooltip="{ text: se.noteMoveTitle, reason: noteMoveBlocked }"
        @click="emit('note-move')"
      >
        {{ se.noteMove }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ reason: opBlocked.voiceChange }">
        {{ se.voicePitch }}
        <input
          v-model="voicePitchInput"
          class="num"
          type="number"
          step="1"
          :disabled="!!opBlocked.voiceChange"
        />
        <span class="unit">st</span>
      </label>
      <label v-tooltip="{ reason: opBlocked.voiceChange }">
        {{ se.voiceFormant }}
        <input
          v-model="voiceFormantInput"
          class="num"
          type="number"
          step="0.05"
          min="0.1"
          :disabled="!!opBlocked.voiceChange"
        />
        <span class="unit">×</span>
      </label>
      <ToggleButton
        v-model="voiceFormantAbsolute"
        :label="se.voiceFormantAbsolute"
        :title="se.voiceFormantAbsoluteTitle"
        :reason="opBlocked.voiceChange"
        size="sm"
      />
      <button
        type="button"
        :disabled="!!opBlocked.voiceChange"
        v-tooltip="{ text: se.voiceTitle, reason: opBlocked.voiceChange }"
        @click="emit('voice-change')"
      >
        {{ se.voice }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
