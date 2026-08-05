<script setup lang="ts">
import AppModal from '@/components/shell/AppModal.vue';
import type { ProjectRevision } from '@/persistence/revisions';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSize } from '@/ui/shell/format';

/**
 * Named revisions of the current project: pick one to bring back, or drop the
 * ones no longer worth keeping. Restoring replaces the live document but does
 * not overwrite the stored project, so the user still decides whether the
 * older arrangement becomes the saved one.
 */

defineProps<{
  open: boolean;
  revisions: ProjectRevision[];
}>();

const emit = defineEmits<{
  close: [];
  restoreRevision: [slot: string];
  deleteRevision: [slot: string];
  saveRevision: [];
}>();

const { t } = useI18n();

/** Locale-formatted capture time of a revision. */
function formatSavedAt(savedAt: number): string {
  return new Date(savedAt).toLocaleString();
}
</script>

<template>
  <AppModal
    :open="open"
    size="sm"
    :aria-label="t.dialogs.revisions.title"
    @close="emit('close')"
  >
    <template #title>{{ t.dialogs.revisions.title }}</template>
    <p class="revisions-note">{{ t.dialogs.revisions.note }}</p>
    <ul class="stored-list" :aria-label="t.dialogs.revisions.list">
      <li v-for="revision in revisions" :key="revision.slot" class="stored-row">
        <button
          type="button"
          class="stored-load"
          v-tooltip="formatMessage(t.dialogs.revisions.restore, { name: revision.label })"
          @click="emit('restoreRevision', revision.slot)"
        >
          {{ revision.label }}
        </button>
        <span class="stored-size">{{ formatSavedAt(revision.savedAt) }}</span>
        <span class="stored-size">{{ formatSize(revision.size) }}</span>
        <button
          type="button"
          class="stored-delete"
          v-tooltip="formatMessage(t.dialogs.revisions.deleteRevision, { name: revision.label })"
          @click="emit('deleteRevision', revision.slot)"
        >
          {{ t.dialogs.revisions.delete }}
        </button>
      </li>
      <li v-if="revisions.length === 0" class="stored-empty">
        {{ t.dialogs.revisions.empty }}
      </li>
    </ul>
    <template #actions>
      <button type="button" @click="emit('saveRevision')">
        {{ t.dialogs.revisions.saveCurrent }}
      </button>
      <span class="bar-spacer" />
      <button type="button" @click="emit('close')">{{ t.dialogs.revisions.close }}</button>
    </template>
  </AppModal>
</template>

<style scoped src="@/ui/shell/open-project-dialog.css"></style>
