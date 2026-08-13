<script setup lang="ts">
import { useI18n } from '@/ui/i18n';
import {
  formatLevel,
  type LoudnessRow,
  loudnessBarFraction,
  rangeBarFraction,
} from '@/ui/mastering/loudness';

defineProps<{
  rows: ReadonlyArray<LoudnessRow>;
  clipWarning: boolean;
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="rows.length > 0" class="loudness-readout">
    <div class="loudness-head">
      <span class="loudness-label" />
      <span class="loudness-col">{{ t.shell.mastering.loudness.aChain }}</span>
      <span class="loudness-col">{{ t.shell.mastering.loudness.bBypass }}</span>
    </div>
    <div v-for="row in rows" :key="row.label" class="loudness-row">
      <span class="loudness-label">{{ row.label }}</span>
      <span class="loudness-cell">
        <span class="loudness-bar">
          <span
            class="loudness-fill"
            :style="{
              width: `${(row.barScale === 'range' ? rangeBarFraction(row.a) : loudnessBarFraction(row.a)) * 100}%`,
            }"
          />
        </span>
        <span class="loudness-value">{{ formatLevel(row.a) }} {{ row.unit }}</span>
      </span>
      <span class="loudness-cell">
        <span class="loudness-bar">
          <span
            class="loudness-fill"
            :style="{
              width: `${(row.barScale === 'range' ? rangeBarFraction(row.b) : loudnessBarFraction(row.b)) * 100}%`,
            }"
          />
        </span>
        <span class="loudness-value">{{ formatLevel(row.b) }} {{ row.unit }}</span>
      </span>
    </div>
    <p v-if="clipWarning" class="clip-warning" role="alert">
      {{ t.shell.mastering.loudness.clipWarning }}
    </p>
  </div>
</template>

<style scoped src="./mastering-loudness-readout.css"></style>
