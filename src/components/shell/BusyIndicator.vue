<script setup lang="ts">
/**
 * Shared busy-state primitive — the one treatment for "work is in flight"
 * (decoding, rendering, analysis, engraving). Pairs the motion layer's spinner
 * with a polite live-region label so screen readers hear the same state.
 *
 * - `inline` (default): spinner + label on one line, for toolbars, rows and
 *   buttons' neighbours.
 * - `overlay`: a centred spinner + label over its positioned parent, with a
 *   faint scrim, for panels whose content is being replaced.
 */
defineProps<{
  /** Visible and announced label; omit for a bare spinner (then pass aria-label). */
  label?: string;
  variant?: 'inline' | 'overlay';
  size?: 'sm' | 'md';
}>();
</script>

<template>
  <div
    class="busy-indicator"
    :class="[`is-${variant ?? 'inline'}`, `is-${size ?? 'sm'}`]"
    role="status"
    aria-live="polite"
  >
    <span class="spinner" aria-hidden="true" />
    <span v-if="label" class="busy-indicator-label">{{ label }}</span>
  </div>
</template>

<style scoped>
.busy-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-sm);
  animation: view-enter var(--dur-2) var(--ease-out);
}

.busy-indicator.is-sm {
  --spinner-size: 12px;
}

.busy-indicator.is-md {
  --spinner-size: 18px;
  gap: var(--sp-4);
  font-size: var(--fs-md);
}

.busy-indicator.is-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: color-mix(in srgb, var(--surface-panel) 72%, transparent);
  animation: busy-overlay-in var(--dur-2) var(--ease-out);
}

.busy-indicator-label {
  font-variant-numeric: tabular-nums;
}

@keyframes busy-overlay-in {
  from {
    opacity: 0;
  }
}
</style>
