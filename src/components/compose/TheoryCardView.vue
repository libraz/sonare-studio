<script setup lang="ts">
import { ref, watch } from 'vue';
import type { TheoryCard } from '@/compose/explain';

/**
 * Renders a {@link TheoryCard} (a note's theory analysis) as a compact titled
 * card. Lines that refer to a jargon term carry an ⓘ affordance that expands
 * the term's glossary definition in place. Presentation only — the host
 * positions it and decides when to show it; the `hold` event tells the host
 * when the ⓘ is being reached for, so a hover-driven host can keep the card up.
 */

const props = defineProps<{
  /** The card to render. */
  card: TheoryCard;
}>();

const emit = defineEmits<{
  /**
   * True while the ⓘ affordance has the pointer or keyboard focus. Hosts that
   * dismiss the card on hover keep it alive while this is set, otherwise
   * reaching the button would close the card it lives in.
   */
  hold: [held: boolean];
}>();

/** Index of the line whose glossary definition is expanded, or null. */
const openTerm = ref<number | null>(null);

function toggleTerm(index: number): void {
  openTerm.value = openTerm.value === index ? null : index;
}

// Pointer and focus presence on the ⓘ, reported to the host as one flag and
// emitted synchronously: the host arms its dismissal on the very event that
// hands the pointer over, so a deferred hold would arrive too late to be read
// as one continuous reach.
let infoPointer = false;
let infoFocus = false;
let held = false;

function setInfoHold(part: 'pointer' | 'focus', on: boolean): void {
  if (part === 'pointer') infoPointer = on;
  else infoFocus = on;
  const next = infoPointer || infoFocus;
  if (next === held) return;
  held = next;
  emit('hold', next);
}

// A new card (hovering a different note) starts with every definition collapsed.
watch(
  () => props.card,
  () => {
    openTerm.value = null;
  },
);
</script>

<template>
  <div class="theory-card">
    <div class="theory-card-title">{{ card.title }}</div>
    <template v-for="(line, index) in card.lines" :key="index">
      <div class="theory-card-line">
        <span class="theory-card-label">{{ line.label }}</span>
        <span class="theory-card-text">{{ line.text }}</span>
        <button
          v-if="line.term"
          type="button"
          class="theory-card-info"
          :class="{ 'is-open': openTerm === index }"
          :aria-label="line.term.term"
          :aria-expanded="openTerm === index"
          @click="toggleTerm(index)"
          @pointerenter="setInfoHold('pointer', true)"
          @pointerleave="setInfoHold('pointer', false)"
          @focus="setInfoHold('focus', true)"
          @blur="setInfoHold('focus', false)"
        >
          ⓘ
        </button>
      </div>
      <div v-if="line.term && openTerm === index" class="theory-card-glossary">
        <span class="theory-card-glossary-term">{{ line.term.term }}</span>
        <span class="theory-card-glossary-def">{{ line.term.definition }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.theory-card {
  max-width: 230px;
  padding: 6px 9px;
  border-radius: 5px;
  font: var(--fs-xs) / 1.45 var(--font-sans);
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
  align-items: baseline;
  gap: 6px;
}

.theory-card-label {
  flex: none;
  opacity: 0.62;
}

.theory-card-text {
  flex: 1;
  min-width: 0;
}

/* The ⓘ affordance: a borderless ghost glyph that only gains weight when its
   definition is open, so it stays quiet until the reader reaches for it. The
   card is pointer-events:none in some hosts (the score), so the button opts
   itself back into pointer events to stay clickable. */
.theory-card-info {
  flex: none;
  border: none;
  background: none;
  padding: 0;
  color: var(--text-3);
  cursor: pointer;
  line-height: 1;
  pointer-events: auto;
}

.theory-card-info:hover,
.theory-card-info.is-open {
  color: var(--accent);
}

.theory-card-glossary {
  margin: 2px 0 3px;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--surface-inset);
  color: var(--text-2);
}

.theory-card-glossary-term {
  display: block;
  font-weight: 600;
  color: var(--text-1);
}
</style>
