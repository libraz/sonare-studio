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
  border: 1px dashed #2a2e38;
  border-radius: 8px;
  color: #8b93a3;
  font-size: 12px;
  text-align: center;
}

.hint-title {
  margin: 0;
  color: #b6bdca;
  font-size: 12px;
  font-weight: 600;
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
