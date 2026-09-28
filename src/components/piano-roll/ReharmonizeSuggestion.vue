<script setup lang="ts">
import { computed } from 'vue';
import type { PendingChordChange } from '@/composables/useReactiveReharmonization';
import { useI18n } from '@/ui/i18n';

/**
 * Floating approval chip for a pending reharmonization proposal. Sits at the
 * top of the note grid without stealing focus or blocking editing: it lists
 * (up to a few of) the chords the proposal would change and offers Apply /
 * dismiss. The host mounts it only while a proposal is pending and removes it
 * when the composer keeps editing.
 */

const props = defineProps<{
  /** Chords the pending proposal changes, in track order. */
  changes: ReadonlyArray<PendingChordChange>;
}>();

const emit = defineEmits<{
  /** Commit the pending proposal. */
  apply: [];
  /** Discard the pending proposal. */
  dismiss: [];
}>();

const { t } = useI18n();

/** How many chord changes the chip spells out before collapsing to "+n". */
const MAX_SHOWN_CHANGES = 3;

const shownChanges = computed(() => props.changes.slice(0, MAX_SHOWN_CHANGES));
const overflowCount = computed(() => Math.max(0, props.changes.length - MAX_SHOWN_CHANGES));
</script>

<template>
  <div class="reharm-chip" role="status" aria-live="polite">
    <span class="chip-label">{{ t.shell.pianoRoll.reharmonize.suggestionLabel }}</span>
    <span class="chip-changes">
      <span v-for="change in shownChanges" :key="change.index" class="chip-change">
        <span class="chip-from">{{ change.from }}</span>
        <span class="chip-arrow" aria-hidden="true">→</span>
        <span class="chip-to">{{ change.to }}</span>
      </span>
      <span v-if="overflowCount > 0" class="chip-overflow">+{{ overflowCount }}</span>
    </span>
    <button
      type="button"
      class="chip-apply"
      :title="t.shell.pianoRoll.reharmonize.applyTitle"
      @click="emit('apply')"
    >
      {{ t.shell.pianoRoll.reharmonize.apply }}
    </button>
    <button
      type="button"
      class="chip-dismiss"
      :aria-label="t.shell.pianoRoll.reharmonize.dismiss"
      @click="emit('dismiss')"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
.reharm-chip {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: min(90%, 34rem);
  padding: 0.25rem 0.35rem 0.25rem 0.65rem;
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--raise-hi), var(--shadow-1);
  font: var(--fs-xs)/1.4 var(--font-sans);
  color: var(--text-2);
  white-space: nowrap;
}

.chip-label {
  flex: none;
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.chip-changes {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  overflow: hidden;
}

.chip-change {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.05rem 0.4rem;
  background: var(--surface-inset);
  border-radius: var(--radius-xs);
}

.chip-from {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-color: var(--text-4);
}

.chip-arrow {
  color: var(--text-4);
}

.chip-to {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.chip-overflow {
  flex: none;
  color: var(--text-3);
}

.chip-apply {
  flex: none;
  padding: 0.1rem 0.6rem;
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  border-radius: var(--radius-sm);
  font: var(--fw-semibold) var(--fs-xs)/1.4 var(--font-sans);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.chip-apply:hover {
  background: var(--accent-hover);
}

.chip-dismiss {
  flex: none;
  padding: 0.1rem 0.3rem;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  line-height: 1;
  cursor: pointer;
}

.chip-dismiss:hover {
  color: var(--text-1);
}
</style>
