<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import { useI18n } from '@/ui/i18n';
import AppModal from './AppModal.vue';

/**
 * Renders the front request of the shared dialog queue as a frosted-glass
 * modal. Mount once near the root of the shell; every `confirmDialog` /
 * `alertDialog` / `promptDialog` call surfaces here.
 */

/** The request currently shown (front of the queue), or undefined when idle. */
const current = computed(() => dialogQueue[0]);
const { t } = useI18n();

const inputRef = ref<HTMLInputElement | null>(null);
const promptValue = ref('');

// When a prompt becomes current, seed the field and focus it.
watch(
  current,
  (request) => {
    if (request?.kind === 'prompt') {
      promptValue.value = request.defaultValue;
      void nextTick(() => {
        inputRef.value?.focus();
        inputRef.value?.select();
      });
    }
  },
  { immediate: true },
);

function onConfirm(): void {
  const request = current.value;
  if (!request) return;
  if (request.kind === 'prompt') {
    resolveDialog(request.id, promptValue.value.trim());
  } else if (request.kind === 'alert') {
    resolveDialog(request.id, null);
  } else {
    resolveDialog(request.id, true);
  }
}

function onCancel(): void {
  const request = current.value;
  if (!request) return;
  // Alerts have no cancel path; dismissing settles them like the OK button.
  resolveDialog(request.id, request.kind === 'confirm' ? false : null);
}

function onPromptKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    onConfirm();
  }
}
</script>

<template>
  <AppModal
    :open="current !== undefined"
    size="sm"
    :aria-label="current?.title ?? t.common.dialog"
    @close="onCancel"
  >
    <template v-if="current?.title" #title>{{ current.title }}</template>
    <template #default>
      <p class="dialog-message">{{ current?.message }}</p>
      <input
        v-if="current?.kind === 'prompt'"
        ref="inputRef"
        v-model="promptValue"
        type="text"
        class="dialog-input"
        :placeholder="current.placeholder"
        @keydown="onPromptKeydown"
      />
    </template>
    <template #actions>
      <button
        v-if="current?.kind !== 'alert'"
        type="button"
        @click="onCancel"
      >
        {{ current?.cancelLabel }}
      </button>
      <button
        type="button"
        :class="current?.danger ? 'danger-action' : 'primary'"
        @click="onConfirm"
      >
        {{ current?.confirmLabel }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.dialog-message {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-md);
  line-height: 1.5;
  white-space: pre-wrap;
}

.dialog-input {
  margin-top: var(--sp-5);
  width: 100%;
  font-size: var(--fs-md);
  padding: var(--sp-3) var(--sp-4);
}
</style>
