<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useI18n } from '@/ui/i18n';
import { NORMALIZE_TARGET_OPTIONS } from '@/ui/sample-editor/use-sample-operations';

defineProps<{
  editBlocked: string | null;
  trimBlocked: string | null;
  deleteBlocked: string | null;
}>();

const emit = defineEmits<{
  gain: [];
  normalize: [];
  'fade-in': [];
  'fade-out': [];
  reverse: [];
  silence: [];
  trim: [];
  delete: [];
  duplicate: [];
}>();

const gainDbInput = defineModel<string>('gainDbInput', { required: true });
const normalizeTargetInput = defineModel<string>('normalizeTargetInput', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.edit">
    <div class="op-cluster">
      <label v-tooltip="{ text: se.gainTitle, reason: editBlocked }">
        {{ se.gain }}
        <input v-model="gainDbInput" class="num" type="number" step="0.5" :disabled="!!editBlocked" />
        <span class="unit">dB</span>
      </label>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.gainTitle, reason: editBlocked }"
        @click="emit('gain')"
      >
        {{ t.common.apply }}
      </button>
    </div>
    <div class="op-cluster">
      <label>
        {{ se.normalize }}
        <SelectMenu
          v-model="normalizeTargetInput"
          :options="NORMALIZE_TARGET_OPTIONS"
          :aria-label="se.normalizeTarget"
          :disabled="!!editBlocked"
          :reason="editBlocked"
          size="sm"
        />
      </label>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.normalizeTitle, reason: editBlocked }"
        @click="emit('normalize')"
      >
        {{ t.common.apply }}
      </button>
    </div>
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.fadeInTitle, reason: editBlocked }"
        @click="emit('fade-in')"
      >
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 14 14 2v12Z" fill="currentColor" />
        </svg>
        {{ se.fadeIn }}
      </button>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.fadeOutTitle, reason: editBlocked }"
        @click="emit('fade-out')"
      >
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 2 14 14H2Z" fill="currentColor" />
        </svg>
        {{ se.fadeOut }}
      </button>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.reverseTitle, reason: editBlocked }"
        @click="emit('reverse')"
      >
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 5h8l-2-2M13 11H5l2 2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ se.reverse }}
      </button>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.silenceTitle, reason: editBlocked }"
        @click="emit('silence')"
      >
        {{ se.silence }}
      </button>
    </div>
    <div class="op-cluster">
      <button
        type="button"
        :disabled="!!trimBlocked"
        v-tooltip="{ text: se.trimTitle, reason: trimBlocked }"
        @click="emit('trim')"
      >
        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M14 3 6.5 9M14 13 6.5 7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="4" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="4" cy="11" r="2" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
        {{ se.trim }}
      </button>
      <button
        type="button"
        :disabled="!!deleteBlocked"
        v-tooltip="{ text: se.deleteTitle, reason: deleteBlocked }"
        @click="emit('delete')"
      >
        {{ t.common.delete }}
      </button>
      <button
        type="button"
        :disabled="!!editBlocked"
        v-tooltip="{ text: se.duplicateTitle, reason: editBlocked }"
        @click="emit('duplicate')"
      >
        {{ se.duplicate }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
