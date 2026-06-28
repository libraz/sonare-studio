<script setup lang="ts">
/**
 * Small empty-state hint the shell drops into zones that have nothing to show
 * yet (no tracks, no clips, engine off): one line of guidance plus an
 * optional action button supplied through the `action` slot. Purely
 * presentational; any action wiring stays with the caller.
 */

defineProps<{
  /** One-line guidance text. */
  message: string;
  /** Optional short heading shown above the message. */
  title?: string;
}>();
</script>

<template>
  <div class="hint-card" role="note">
    <h3 v-if="title" class="hint-title">{{ title }}</h3>
    <p class="hint-message">{{ message }}</p>
    <div v-if="$slots.action" class="hint-action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.hint-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 22rem;
  margin: auto;
  padding: var(--sp-5) var(--sp-6);
  background: var(--canvas-surface-2);
  border-radius: var(--radius-lg);
  color: var(--text-3);
  font-size: var(--fs-sm);
  text-align: center;
  /* Soft solid edge + drop shadow reads as a finished surface rather than
     the wireframe feel a dashed border gives. */
  box-shadow: var(--control-edge), var(--shadow-1);
}

.hint-title {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
}

.hint-message {
  margin: 0;
  line-height: 1.5;
}

.hint-action {
  margin-top: var(--sp-1);
}
</style>
