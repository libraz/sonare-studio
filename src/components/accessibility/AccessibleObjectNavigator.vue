<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type {
  AccessibleObjectAdjustment,
  AccessibleObjectItem,
} from '@/ui/accessibility/object-navigation';

const props = defineProps<{
  label: string;
  emptyLabel: string;
  instructions: string;
  editLabel: string;
  contextLabel: string;
  items: ReadonlyArray<AccessibleObjectItem>;
}>();

const emit = defineEmits<{
  activate: [id: string];
  context: [id: string];
  adjust: [adjustment: AccessibleObjectAdjustment];
  'set-value': [payload: { id: string; controlId: string; value: number }];
}>();

const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, '-');
const activeIndex = ref(0);
const announcement = ref('');

const activeItem = computed(() => props.items[activeIndex.value] ?? null);
const activeDescendant = computed(() =>
  activeItem.value ? optionDomId(activeItem.value.id) : undefined,
);

function optionDomId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '-');
  return `accessible-object-${instanceId}-${safe}`;
}

async function announce(message: string): Promise<void> {
  announcement.value = '';
  await nextTick();
  announcement.value = message;
}

function moveActive(delta: number): void {
  if (props.items.length === 0) return;
  activeIndex.value = Math.min(props.items.length - 1, Math.max(0, activeIndex.value + delta));
  const item = activeItem.value;
  if (item) void announce(item.label);
}

function activate(): void {
  const item = activeItem.value;
  if (!item) return;
  emit('activate', item.id);
  void announce(item.label);
}

function openContext(): void {
  const item = activeItem.value;
  if (!item) return;
  emit('context', item.id);
}

function onKeyDown(event: KeyboardEvent): void {
  const direction =
    event.key === 'ArrowLeft'
      ? 'left'
      : event.key === 'ArrowRight'
        ? 'right'
        : event.key === 'ArrowUp'
          ? 'up'
          : event.key === 'ArrowDown'
            ? 'down'
            : null;
  if (direction !== null && (event.ctrlKey || event.metaKey || event.shiftKey)) {
    const item = activeItem.value;
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    emit('adjust', {
      id: item.id,
      direction,
      resize: event.shiftKey && (direction === 'left' || direction === 'right'),
      coarse: event.altKey,
    });
    return;
  }
  if (direction !== null) {
    event.preventDefault();
    event.stopPropagation();
    moveActive(direction === 'left' || direction === 'up' ? -1 : 1);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    event.stopPropagation();
    activeIndex.value = event.key === 'Home' ? 0 : Math.max(0, props.items.length - 1);
    const item = activeItem.value;
    if (item) void announce(item.label);
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    activate();
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    event.stopPropagation();
    openContext();
  }
}

function onControlInput(itemId: string, controlId: string, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) emit('set-value', { id: itemId, controlId, value });
}

watch(
  () => props.items.map((item) => item.id),
  (ids, previousIds) => {
    const previousId = previousIds?.[activeIndex.value];
    const preservedIndex = previousId === undefined ? -1 : ids.indexOf(previousId);
    if (preservedIndex >= 0) {
      activeIndex.value = preservedIndex;
      return;
    }
    const selectedIndex = props.items.findIndex((item) => item.selected);
    activeIndex.value =
      selectedIndex >= 0 ? selectedIndex : Math.min(activeIndex.value, ids.length - 1);
    if (activeIndex.value < 0) activeIndex.value = 0;
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="accessible-object-navigator"
    role="region"
    :aria-label="props.label"
  >
    <span class="navigator-summary" aria-hidden="true">
      {{ activeItem?.label ?? props.emptyLabel }}
    </span>
    <span class="navigator-instructions" aria-hidden="true">{{ props.instructions }}</span>
    <div
      class="navigator-listbox"
      role="listbox"
      tabindex="0"
      :aria-label="props.label"
      :aria-activedescendant="activeDescendant"
      @keydown="onKeyDown"
      @focus="activeItem && announce(activeItem.label)"
    >
      <div class="navigator-virtual-options">
        <div
          v-for="item in props.items"
          :id="optionDomId(item.id)"
          :key="item.id"
          role="option"
          :aria-selected="item.selected"
        >
          {{ item.label }}
        </div>
      </div>
    </div>

    <fieldset v-if="activeItem?.controls?.length" class="navigator-controls">
      <legend>{{ props.editLabel }}</legend>
      <label v-for="control in activeItem.controls" :key="control.id">
        <span>{{ control.label }}</span>
        <input
          type="range"
          :min="control.min"
          :max="control.max"
          :step="control.step"
          :value="control.value"
          :aria-valuetext="control.valueText"
          @input="onControlInput(activeItem.id, control.id, $event)"
        />
      </label>
    </fieldset>
    <button v-if="activeItem" type="button" class="navigator-context" @click="openContext">
      {{ props.contextLabel }}
    </button>
    <div class="navigator-live" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </div>
</template>

<style scoped>
.accessible-object-navigator {
  position: absolute;
  z-index: 20;
  top: 4px;
  left: 4px;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.accessible-object-navigator:focus-within {
  width: min(440px, calc(100% - 8px));
  height: auto;
  max-height: calc(100% - 8px);
  padding: 8px;
  overflow: auto;
  clip-path: none;
  white-space: normal;
  border: 2px solid var(--focus-ring, var(--accent));
  border-radius: var(--radius-sm, 4px);
  background: var(--surface-1, #171717);
  color: var(--text-1, #fff);
  box-shadow: var(--shadow-popover, 0 4px 16px #0008);
}

.navigator-summary {
  display: block;
  font: var(--fw-semibold) var(--fs-sm, 13px) / 1.35 var(--font-sans, sans-serif);
}

.navigator-instructions {
  display: block;
  margin-top: 4px;
  color: var(--text-3, #bbb);
  font: var(--fs-xs) / 1.35 var(--font-sans, sans-serif);
}

.navigator-virtual-options,
.navigator-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.navigator-controls {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding: 6px;
  border: 1px solid var(--border, #555);
}

.navigator-controls label {
  display: grid;
  grid-template-columns: minmax(5rem, auto) 1fr;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-xs);
}

.navigator-context {
  margin-top: 6px;
}
</style>
