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
  /** True while the card itself has pointer or keyboard presence. */
  hold: [held: boolean];
}>();

/** Index of the line whose glossary definition is expanded, or null. */
const openTerm = ref<number | null>(null);

function toggleTerm(index: number): void {
  openTerm.value = openTerm.value === index ? null : index;
}

// Pointer and focus presence on the whole card, reported to the host as one
// flag and emitted synchronously: the host arms its dismissal on the very
// event that hands the pointer over, so a deferred hold would arrive too late
// to be read as one continuous reach.
let cardPointer = false;
let cardFocus = false;
let held = false;

function setCardHold(part: 'pointer' | 'focus', on: boolean): void {
  if (part === 'pointer') cardPointer = on;
  else cardFocus = on;
  const next = cardPointer || cardFocus;
  if (next === held) return;
  held = next;
  emit('hold', next);
}

function onCardFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
  setCardHold('focus', false);
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
  <div
    class="theory-card"
    @pointerenter="setCardHold('pointer', true)"
    @pointerleave="setCardHold('pointer', false)"
    @focusin="setCardHold('focus', true)"
    @focusout="onCardFocusOut"
  >
    <div class="theory-card-title">{{ card.title }}</div>
    <template v-for="(line, index) in card.lines" :key="index">
      <div class="theory-card-line">
        <span class="theory-card-label">{{ line.label }}</span>
        <span class="theory-card-text"
          >{{ line.text
          }}<span v-if="line.badge" class="theory-card-badge">{{ line.badge }}</span></span
        >
        <button
          v-if="line.term"
          type="button"
          class="theory-card-info"
          :class="{ 'is-open': openTerm === index }"
          :aria-label="line.term.term"
          :aria-expanded="openTerm === index"
          @click="toggleTerm(index)"
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
  position: relative;
  max-width: 230px;
  padding: 6px 9px;
  border-radius: 5px;
  font: var(--fs-xs) / 1.45 var(--font-sans);
  background: var(--surface-3);
  color: var(--text-1);
  border: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
  /* Hosts set this to the card's pointer offset. The transparent reach area
     bridges the gap between a note and this fixed card without changing the
     card's visible bounds. */
  --theory-card-reach: 12px;
  isolation: isolate;
  /* Opacity only: hosts own the card's position. */
  animation: theory-card-in var(--dur-1) var(--ease-out);
}

@keyframes theory-card-in {
  from {
    opacity: 0;
  }
}

.theory-card::before {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--theory-card-reach));
  z-index: 0;
  border-radius: inherit;
  pointer-events: auto;
}

.theory-card-title {
  position: relative;
  z-index: 1;
  margin-bottom: 2px;
  font-weight: 600;
}

.theory-card-line {
  position: relative;
  z-index: 1;
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

/* Provenance marker: it qualifies the reading rather than continuing it, so it
   is set apart instead of trailing the sentence in brackets. Kept to a fill and
   a muted colour with no border and no accent — it says where a reading came
   from, which is not something to draw the eye to, and this card is already at
   the smallest type in the app, so the quiet has to come from colour rather
   than from size. Inline, so it flows with the text it qualifies and rides
   along when the line wraps.

   The fill is a veil of the text colour rather than the inset surface: an inset
   well is darker than the card in the dark theme, where it reads as a hole
   punched in the card and leaves the word looking like plain muted text. A
   veil of the foreground lifts on a dark card and settles on a light one, so
   the chip keeps the same weight either way. */
.theory-card-badge {
  display: inline-block;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-3) 14%, transparent);
  color: var(--text-3);
  white-space: nowrap;
}

/* The ⓘ affordance: a borderless ghost glyph that only gains weight when its
   definition is open, so it stays quiet until the reader reaches for it. */
.theory-card-info {
  transition: color var(--dur-1) var(--ease-out);
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
  animation: view-enter var(--dur-2) var(--ease-out);
  position: relative;
  z-index: 1;
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
