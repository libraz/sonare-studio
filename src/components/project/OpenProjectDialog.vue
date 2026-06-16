<script setup lang="ts">
import type { StoredProjectInfo } from '@/persistence/opfs';
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
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div
      :ref="(el) => emit('dialogRef', el as HTMLElement | null)"
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Open project"
      tabindex="-1"
      @keydown="emit('keydown', $event)"
    >
      <h2 class="modal-title">Open project</h2>
      <ul class="stored-list">
        <li v-for="info in storedProjects" :key="info.name" class="stored-row">
          <button
            type="button"
            class="stored-load"
            :title="`Load ${info.name}`"
            @click="emit('openProject', info.name)"
          >
            {{ info.name }}
          </button>
          <span class="stored-size">{{ formatSize(info.size) }}</span>
          <button
            type="button"
            class="stored-delete"
            :title="`Delete ${info.name}`"
            @click="emit('deleteProject', info.name)"
          >
            Delete
          </button>
        </li>
        <li v-if="storedProjects.length === 0" class="stored-empty">No saved projects.</li>
      </ul>
      <div class="modal-actions">
        <button type="button" @click="emit('importSzd')">Import .szd…</button>
        <span class="bar-spacer" />
        <button type="button" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@/ui/shell/open-project-dialog.css"></style>
