<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useI18n } from '@/ui/i18n';

defineProps<{
  referencePickerBlocked: string | null;
  matchEqAnalyzeBlocked: string | null;
  matchEqBlocked: string | null;
  referenceOptions: ReadonlyArray<{ value: string; label: string }>;
}>();

const emit = defineEmits<{
  'analyze-match-eq': [];
  'match-eq': [];
}>();

const referenceAssetId = defineModel<string>('referenceAssetId', { required: true });
const matchEqAmountInput = defineModel<string>('matchEqAmountInput', { required: true });

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);
</script>

<template>
  <div class="toolbar ops" role="tabpanel" :aria-label="se.opsGroups.match">
    <div class="op-cluster">
      <SelectMenu
        :model-value="referenceAssetId"
        size="sm"
        :options="referenceOptions"
        :disabled="!!referencePickerBlocked"
        :reason="referencePickerBlocked"
        :aria-label="se.matchReference"
        @change="(value: string) => (referenceAssetId = value)"
      />
      <button
        type="button"
        :disabled="!!matchEqAnalyzeBlocked"
        v-tooltip="{ text: se.matchEqAnalyzeTitle, reason: matchEqAnalyzeBlocked }"
        @click="emit('analyze-match-eq')"
      >
        {{ se.matchEqAnalyze }}
      </button>
    </div>
    <div class="op-cluster">
      <label v-tooltip="{ text: se.matchEqAmountTitle, reason: matchEqBlocked }">
        {{ se.matchEqAmount }}
        <input
          v-model="matchEqAmountInput"
          class="num"
          type="number"
          step="5"
          min="0"
          max="100"
          :disabled="!!matchEqBlocked"
        />
        <span class="unit">%</span>
      </label>
      <button
        type="button"
        :disabled="!!matchEqBlocked"
        v-tooltip="{ text: se.matchEqTitle, reason: matchEqBlocked }"
        @click="emit('match-eq')"
      >
        {{ se.matchEq }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>
