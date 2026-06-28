<script setup lang="ts">
import { useI18n } from '@/ui/i18n';

/**
 * App-level error/notice banner. Renders nothing while `message` is empty and
 * shows a dismissible alert otherwise. Dismissing is the user's only way to
 * clear notices that have no natural lifetime (e.g. a failed background
 * autosave), so the close button must always be reachable.
 */
defineProps<{ message: string }>();
const emit = defineEmits<{ dismiss: [] }>();

const { t } = useI18n();
</script>

<template>
  <p v-if="message" class="error-box" role="alert">
    <span class="error-text">{{ message }}</span>
    <button
      type="button"
      class="error-dismiss"
      :aria-label="t.shell.dismissError"
      :title="t.shell.dismissError"
      @click="emit('dismiss')"
    >
      ✕
    </button>
  </p>
</template>

<style scoped>
.error-box {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.4rem 0.75rem;
  background: var(--danger-surface);
  border: 1px solid color-mix(in srgb, var(--danger), transparent 60%);
  color: var(--danger-text);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-1);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
}

.error-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
}

.error-dismiss {
  flex: none;
  padding: 0 0.35rem;
  background: transparent;
  border: 0;
  color: inherit;
  font-size: var(--fs-sm);
  line-height: 1.4;
  cursor: pointer;
  opacity: 0.75;
}

.error-dismiss:hover {
  opacity: 1;
}
</style>
