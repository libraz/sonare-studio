<script setup lang="ts">
import type { TheoryCard } from '@/compose/explain';

/**
 * Renders a {@link TheoryCard} (a note's theory analysis) as a compact titled
 * card. Presentation only — the host positions it and decides when to show it.
 */

defineProps<{
  /** The card to render. */
  card: TheoryCard;
}>();
</script>

<template>
  <div class="theory-card">
    <div class="theory-card-title">{{ card.title }}</div>
    <div v-for="line in card.lines" :key="line.label" class="theory-card-line">
      <span class="theory-card-label">{{ line.label }}</span>
      <span>{{ line.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.theory-card {
  max-width: 230px;
  padding: 6px 9px;
  border-radius: 5px;
  font: 11px / 1.45 system-ui, sans-serif;
  background: var(--surface-3);
  color: var(--text-1);
  border: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.theory-card-title {
  margin-bottom: 2px;
  font-weight: 600;
}

.theory-card-line {
  display: flex;
  gap: 6px;
}

.theory-card-label {
  flex: none;
  opacity: 0.62;
}
</style>
