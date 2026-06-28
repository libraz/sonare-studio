<script setup lang="ts">
import { formatMessage, useI18n } from '@/ui/i18n';
import type { MasteringSuggestion } from '@/ui/mastering/assistant';
import { humanizePresetName } from '@/ui/mastering/preset-catalog';

/**
 * Result block for the mastering assistant: the scored preset chips (apply on
 * click), the assistant's explanation lines and the measured loudness profile.
 * The analysis and the (undoable) preset apply are owned by the panel; this
 * component only renders the parsed suggestion and emits the chosen preset.
 */

defineProps<{
  /** Parsed assistant suggestion to display. */
  suggestion: MasteringSuggestion;
  /** Currently selected preset id, used to highlight the matching chip. */
  preset: string | undefined;
}>();

const emit = defineEmits<(event: 'select', preset: string) => void>();

const { t } = useI18n();
</script>

<template>
  <section class="assist-result" :aria-label="t.shell.mastering.assistant.recommended">
    <div v-if="suggestion.genreCandidates.length" class="assist-section">
      <div class="assist-heading">{{ t.shell.mastering.assistant.recommended }}</div>
      <div class="assist-candidates">
        <button
          v-for="candidate in suggestion.genreCandidates"
          :key="candidate.name"
          type="button"
          class="assist-chip"
          :class="{ active: candidate.name === preset }"
          @click="emit('select', candidate.name)"
        >
          <span class="assist-chip-name">{{ humanizePresetName(candidate.name) }}</span>
          <span class="assist-score">{{ Math.round(candidate.score * 100) }}</span>
        </button>
      </div>
    </div>
    <div v-if="suggestion.explanation.length" class="assist-section">
      <ul class="assist-explain">
        <li v-for="(line, index) in suggestion.explanation" :key="index">{{ line }}</li>
      </ul>
    </div>
    <div v-if="suggestion.profile" class="assist-profile">
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.lufs, {
          value: suggestion.profile.integratedLufs.toFixed(1),
        })
      }}</span>
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.lra, {
          value: suggestion.profile.lraLu.toFixed(1),
        })
      }}</span>
      <span class="assist-metric">{{
        formatMessage(t.shell.mastering.assistant.truePeak, {
          value: suggestion.profile.truePeakDb.toFixed(1),
        })
      }}</span>
    </div>
  </section>
</template>

<style scoped src="./assistant-panel.css"></style>
