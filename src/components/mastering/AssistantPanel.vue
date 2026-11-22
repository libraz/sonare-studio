<script setup lang="ts">
import type { MasteringAssistantResult } from '@libraz/libsonare';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { SuggestionAdjustment } from '@/ui/mastering/assistant';
import { formatLevel } from '@/ui/mastering/loudness';
import { humanizePresetName } from '@/ui/mastering/preset-catalog';

/**
 * Result block for the mastering assistant: the named base preset, the preset
 * values the suggestion tuned, the assistant's explanation lines and the
 * measured loudness profile.
 * The analysis and the (undoable) preset apply are owned by the panel; this
 * component only renders the suggestion.
 */

defineProps<{
  /** Assistant suggestion to display. */
  suggestion: MasteringAssistantResult;
  /** Base preset used for this suggestion. */
  preset: string | undefined;
  /** Preset values the suggestion tuned, applied as the preset's overrides. */
  adjustments: ReadonlyArray<SuggestionAdjustment>;
}>();

const { t } = useI18n();

/** Compact display of a chain config value. */
function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
</script>

<template>
  <section class="assist-result" :aria-label="t.shell.mastering.assistant.recommended">
    <div class="assist-section">
      <div class="assist-heading">{{ t.shell.mastering.assistant.recommended }}</div>
      <span :key="preset ?? ''" class="assist-chip active animate-pop" role="status">
        <span class="assist-chip-name">{{ humanizePresetName(preset ?? 'streaming') }}</span>
      </span>
    </div>
    <div v-if="adjustments.length" class="assist-section">
      <div class="assist-heading">{{ t.shell.mastering.assistant.adjusted }}</div>
      <ul class="assist-adjustments">
        <li v-for="adjustment in adjustments" :key="adjustment.key">
          <span class="assist-adjustment-key">{{ adjustment.key }}</span>
          <span class="assist-adjustment-values">
            {{ formatValue(adjustment.from) }} → {{ formatValue(adjustment.to) }}
          </span>
        </li>
      </ul>
    </div>
    <div v-if="suggestion.explanation.length" class="assist-section">
      <ul class="assist-explain">
        <li v-for="(line, index) in suggestion.explanation" :key="index">{{ line }}</li>
      </ul>
    </div>
    <div class="assist-profile">
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.lufs, {
          value: formatLevel(suggestion.profile.integratedLufs),
        })
      }}</span>
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.lra, {
          value: suggestion.profile.loudnessRangeLu.toFixed(1),
        })
      }}</span>
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.truePeak, {
          value: suggestion.profile.truePeakDbtp.toFixed(1),
        })
      }}</span>
    </div>
  </section>
</template>

<style scoped src="./assistant-panel.css"></style>
