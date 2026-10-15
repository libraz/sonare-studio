<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import { clamp } from '@/lib/math';
import type { StoredProjectInfo } from '@/persistence/opfs';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSize } from '@/ui/shell/format';

const props = defineProps<{
  open: boolean;
  storedProjects: StoredProjectInfo[];
}>();

const emit = defineEmits<{
  close: [];
  deleteProject: [name: string];
  renameProject: [name: string];
  importSzd: [];
  openProject: [name: string];
}>();

const { t } = useI18n();

/** Index of the keyboard-highlighted row within `storedProjects`. */
const selectedIndex = ref(0);
const listRef = ref<HTMLElement | null>(null);

/** Stable DOM id for a row, used to wire `aria-activedescendant`. */
function rowId(index: number): string {
  return `open-project-row-${index}`;
}

/** Id of the active row, or `undefined` when the list is empty. */
const activeRowId = computed(() =>
  props.storedProjects.length > 0 ? rowId(selectedIndex.value) : undefined,
);

/** Scrolls the active row into view after the DOM reflects the selection. */
function scrollSelectedIntoView(): void {
  void nextTick(() => {
    const row = listRef.value?.querySelector<HTMLElement>(`#${rowId(selectedIndex.value)}`);
    row?.scrollIntoView({ block: 'nearest' });
  });
}

// Reset the highlight whenever the dialog opens or its contents change so the
// active row never points past the end of a shorter list.
watch(
  () => [props.open, props.storedProjects.length] as const,
  () => {
    selectedIndex.value = 0;
    if (props.open) scrollSelectedIntoView();
  },
);

/** Moves the highlight by `delta`, clamped to the list bounds. */
function moveSelection(delta: number): void {
  const count = props.storedProjects.length;
  if (count === 0) return;
  selectedIndex.value = clamp(selectedIndex.value + delta, 0, count - 1);
  scrollSelectedIntoView();
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveSelection(-1);
      break;
    case 'Enter': {
      const info = props.storedProjects[selectedIndex.value];
      if (info) {
        event.preventDefault();
        emit('openProject', info.name);
      }
      break;
    }
    // Escape and the focus trap are owned by AppModal.
  }
}
</script>

<template>
  <AppModal
    :open="open"
    size="sm"
    :aria-label="t.dialogs.openProject.title"
    @close="emit('close')"
    @keydown="onKeydown"
  >
    <template #title>{{ t.dialogs.openProject.title }}</template>
      <ul
        ref="listRef"
        class="stored-list"
        role="listbox"
        tabindex="0"
        :aria-label="t.dialogs.openProject.projectsList"
        :aria-activedescendant="activeRowId"
      >
        <li
          v-for="(info, index) in storedProjects"
          :key="info.name"
          class="stored-row"
          role="presentation"
        >
          <button
            :id="rowId(index)"
            type="button"
            class="stored-load"
            :class="{ selected: index === selectedIndex }"
            role="option"
            :aria-selected="index === selectedIndex"
            v-tooltip="formatMessage(t.dialogs.openProject.loadProject, { name: info.name })"
            @focus="selectedIndex = index"
            @click="emit('openProject', info.name)"
          >
            {{ info.name }}
          </button>
          <span class="stored-size">{{ formatSize(info.size) }}</span>
          <button
            type="button"
            class="stored-rename"
            v-tooltip="formatMessage(t.dialogs.openProject.renameProject, { name: info.name })"
            @click="emit('renameProject', info.name)"
          >
            {{ t.dialogs.openProject.rename }}
          </button>
          <button
            type="button"
            class="stored-delete"
            v-tooltip="formatMessage(t.dialogs.openProject.deleteProject, { name: info.name })"
            @click="emit('deleteProject', info.name)"
          >
            {{ t.common.delete }}
          </button>
        </li>
        <li v-if="storedProjects.length === 0" class="stored-empty">
          {{ t.dialogs.openProject.empty }}
        </li>
      </ul>
    <template #actions>
      <button type="button" @click="emit('importSzd')">
        {{ t.dialogs.openProject.importSzd }}
      </button>
      <span class="bar-spacer" />
      <button type="button" @click="emit('close')">{{ t.common.close }}</button>
    </template>
  </AppModal>
</template>

<style scoped src="@/ui/shell/open-project-dialog.css"></style>
