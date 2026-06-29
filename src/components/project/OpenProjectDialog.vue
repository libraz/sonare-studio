<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
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
  dialogRef: [el: HTMLElement | null];
  importSzd: [];
  keydown: [event: KeyboardEvent];
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
  selectedIndex.value = Math.min(count - 1, Math.max(0, selectedIndex.value + delta));
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
    default:
      // Escape and focus-trap handling stay with the shell.
      emit('keydown', event);
      break;
  }
}
</script>

<template>
  <Transition name="dialog">
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div
      :ref="(el) => emit('dialogRef', el as HTMLElement | null)"
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t.dialogs.openProject.title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <h2 class="modal-title">{{ t.dialogs.openProject.title }}</h2>
      <ul
        ref="listRef"
        class="stored-list"
        role="listbox"
        :aria-label="t.dialogs.openProject.projectsList"
        :aria-activedescendant="activeRowId"
      >
        <li
          v-for="(info, index) in storedProjects"
          :id="rowId(index)"
          :key="info.name"
          class="stored-row"
          :class="{ selected: index === selectedIndex }"
          role="option"
          :aria-selected="index === selectedIndex"
        >
          <button
            type="button"
            class="stored-load"
            v-tooltip="formatMessage(t.dialogs.openProject.loadProject, { name: info.name })"
            @click="emit('openProject', info.name)"
          >
            {{ info.name }}
          </button>
          <span class="stored-size">{{ formatSize(info.size) }}</span>
          <button
            type="button"
            class="stored-delete"
            v-tooltip="formatMessage(t.dialogs.openProject.deleteProject, { name: info.name })"
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
  </Transition>
</template>

<style scoped src="@/ui/shell/open-project-dialog.css"></style>
