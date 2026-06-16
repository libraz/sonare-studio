<script setup lang="ts">
import type { StoredProjectInfo } from '@/persistence/opfs';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSize } from '@/ui/shell/format';

defineProps<{
  open: boolean;
  storedProjects: StoredProjectInfo[];
}>();

const emit = defineEmits<{
  close: [];
  deleteProject: [name: string];
  dialogRef: [el: HTMLElement | null];
  importSzd: [];
  keydown: [event: KeyboardEvent];
  openProject: [name: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div
      :ref="(el) => emit('dialogRef', el as HTMLElement | null)"
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t.dialogs.openProject.title"
      tabindex="-1"
      @keydown="emit('keydown', $event)"
    >
      <h2 class="modal-title">{{ t.dialogs.openProject.title }}</h2>
      <ul class="stored-list">
        <li v-for="info in storedProjects" :key="info.name" class="stored-row">
          <button
            type="button"
            class="stored-load"
            :title="formatMessage(t.dialogs.openProject.loadProject, { name: info.name })"
            @click="emit('openProject', info.name)"
          >
            {{ info.name }}
          </button>
          <span class="stored-size">{{ formatSize(info.size) }}</span>
          <button
            type="button"
            class="stored-delete"
            :title="formatMessage(t.dialogs.openProject.deleteProject, { name: info.name })"
            @click="emit('deleteProject', info.name)"
          >
            {{ t.dialogs.openProject.delete }}
          </button>
        </li>
        <li v-if="storedProjects.length === 0" class="stored-empty">
          {{ t.dialogs.openProject.empty }}
        </li>
      </ul>
      <div class="modal-actions">
        <button type="button" @click="emit('importSzd')">
          {{ t.dialogs.openProject.importSzd }}
        </button>
        <span class="bar-spacer" />
        <button type="button" @click="emit('close')">{{ t.dialogs.openProject.close }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@/ui/shell/open-project-dialog.css"></style>
