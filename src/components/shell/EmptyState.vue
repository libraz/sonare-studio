<script setup lang="ts">
/**
 * Shared empty-state primitive — one consistent treatment for "there's nothing
 * here yet" across panels, racks and lists. Two variants:
 *
 * - `panel` (default): a centred block that fills its container, with an
 *   optional glyph (pass via the `icon` slot), a semibold message and an
 *   optional secondary `hint`. For full-panel empties (media browser, score,
 *   sample editor).
 * - `inline`: compact centred muted text with vertical padding, for empties
 *   that sit inside a small list, rack or popover.
 *
 * The message comes from the `message` prop or the default slot. The block
 * fades and rises in on appear; the entrance collapses to nothing under
 * `prefers-reduced-motion` via the shared duration tokens.
 */
defineProps<{
  /** Primary message; the default slot takes precedence when both are given. */
  message?: string;
  /** Optional secondary line shown beneath the message (panel variant). */
  hint?: string;
  /** Layout density. */
  variant?: 'panel' | 'inline';
}>();
</script>

<template>
  <div class="empty-state" :class="`is-${variant ?? 'panel'}`" role="status">
    <span v-if="$slots.icon" class="empty-state-icon" aria-hidden="true">
      <slot name="icon" />
    </span>
    <p class="empty-state-message"><slot>{{ message }}</slot></p>
    <p v-if="hint" class="empty-state-hint">{{ hint }}</p>
    <div v-if="$slots.action" class="empty-state-action"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: var(--text-3);
  animation: empty-state-in var(--dur-2) var(--ease-out);
}

.empty-state.is-panel {
  flex: 1;
  justify-content: center;
  gap: var(--sp-3);
  min-height: 0;
  padding: var(--sp-7);
}

.empty-state.is-inline {
  gap: var(--sp-1);
  padding: var(--sp-5) 0;
}

.empty-state-icon {
  display: inline-flex;
  color: var(--text-4);
}

.empty-state-message {
  margin: 0;
}

.empty-state.is-panel .empty-state-message {
  font-weight: var(--fw-semibold);
}

.empty-state-hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.empty-state-action {
  margin-top: var(--sp-4);
}

@keyframes empty-state-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
</style>
