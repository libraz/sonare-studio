<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import SearchField from '@/components/shell/SearchField.vue';
import { useI18n } from '@/ui/i18n';

export interface CommandPaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const props = defineProps<{
  open: boolean;
  commands: readonly CommandPaletteItem[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const query = ref('');
const activeIndex = ref(0);
const inputRoot = ref<HTMLElement | null>(null);
const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, '-');
const listId = `command-palette-list-${instanceId}`;

const filtered = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return props.commands;
  return props.commands.filter((command) => {
    const haystack = `${command.label} ${command.hint ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
});

function optionDomId(commandId: string): string {
  return `command-palette-option-${instanceId}-${commandId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

const activeOptionId = computed(() => {
  const command = filtered.value[activeIndex.value];
  return command ? optionDomId(command.id) : undefined;
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    query.value = '';
    activeIndex.value = 0;
    // AppModal focuses its dialog on the first tick; claim focus for the
    // combobox on the following tick so aria-activedescendant has one owner.
    void nextTick().then(() =>
      nextTick().then(() => inputRoot.value?.querySelector('input')?.focus()),
    );
  },
  { immediate: true },
);

watch(filtered, () => {
  activeIndex.value = 0;
});

/** Keeps the active row visible when keyboard navigation moves off-screen. */
function scrollActiveIntoView(): void {
  const id = activeOptionId.value;
  if (!id) return;
  void nextTick().then(() => document.getElementById(id)?.scrollIntoView({ block: 'nearest' }));
}

function move(delta: 1 | -1): void {
  const count = filtered.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
  scrollActiveIntoView();
}

function run(command: CommandPaletteItem): void {
  emit('close');
  command.run();
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      const command = filtered.value[activeIndex.value];
      if (!command) return;
      event.preventDefault();
      run(command);
      break;
    }
  }
}
</script>

<template>
  <AppModal
    :open="props.open"
    size="md"
    :aria-label="t.shell.commandPalette.title"
    @close="emit('close')"
    @keydown="onKeydown"
  >
    <div class="command-palette">
      <div ref="inputRoot">
        <SearchField
          v-model="query"
          class="command-search"
          :placeholder="t.shell.commandPalette.placeholder"
          :aria-label="t.shell.commandPalette.searchLabel"
          input-role="combobox"
          :aria-controls="listId"
          :aria-active-descendant="activeOptionId"
          :aria-expanded="true"
          aria-autocomplete="list"
          size="md"
        />
      </div>
      <div
        :id="listId"
        class="command-list"
        role="listbox"
        :aria-label="t.shell.commandPalette.resultsLabel"
      >
        <button
          v-for="(command, index) in filtered"
          :key="command.id"
          type="button"
          :id="optionDomId(command.id)"
          class="command-row"
          :class="{ active: index === activeIndex }"
          role="option"
          tabindex="-1"
          :aria-selected="index === activeIndex"
          @mouseenter="activeIndex = index"
          @click="run(command)"
        >
          <span class="command-label">{{ command.label }}</span>
          <span v-if="command.hint" class="command-hint">{{ command.hint }}</span>
        </button>
        <p v-if="filtered.length === 0" class="command-empty">
          {{ t.shell.commandPalette.noResults }}
        </p>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.command-palette {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.command-search {
  width: 100%;
}

.command-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-height: min(420px, 56vh);
  overflow: auto;
}

.command-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-4);
  width: 100%;
  min-height: 38px;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  box-shadow: none;
  color: var(--text-1);
  text-align: left;
  /* Rows keyed by command id: only rows a query newly reveals fade in. */
  animation: fade-once var(--dur-2) var(--ease-out);
}

.command-row.active,
.command-row:hover {
  border-color: var(--border);
  background: var(--surface-3);
}

.command-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.command-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
}

.command-hint {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.command-empty {
  animation: fade-once var(--dur-2) var(--ease-out);
  margin: 0;
  padding: var(--sp-5);
  color: var(--text-3);
  text-align: center;
}
</style>
