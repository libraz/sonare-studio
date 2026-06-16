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
  gap: 0.4rem;
  max-width: 22rem;
  margin: auto;
  padding: 0.9rem 1.1rem;
  background: rgba(27, 30, 37, 0.85);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  color: var(--text-3);
  font-size: var(--fs-sm);
  text-align: center;
  box-shadow: var(--shadow-1);
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
  margin-top: 0.2rem;
}
</style>
