<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useOutsidePointerDown } from '@/composables/useOutsidePointerDown';
import { useShortcutBlockingOverlay } from '@/ui/overlay-registry';

/**
 * Accessible, matte replacement for the native <select>. Drop-in: bind
 * `v-model` and pass an `options` array. The trigger mirrors the tokenized
 * control baseline; the popover is teleported to the body, positioned under the
 * trigger (flipping above when there is no room) and supports full keyboard
 * navigation (arrows, Home/End, Enter/Space, Escape, type-ahead).
 */

interface Option {
  value: T;
  label: string;
  /** Secondary line rendered under the label, e.g. a notation or hint. */
  detail?: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    /** Currently selected value. */
    modelValue: T;
    /** Selectable options in display order. */
    options: readonly Option[];
    /** Shown when the value matches no option. */
    placeholder?: string;
    /** Disable the whole control. */
    disabled?: boolean;
    /** Accessible label for the trigger. */
    ariaLabel?: string;
    /** Tooltip text for the trigger. */
    title?: string;
    /** Why the menu is unavailable; a non-empty reason also disables it. */
    reason?: string | null;
    /** Compact trigger height. */
    size?: 'sm' | 'md';
  }>(),
  { placeholder: 'Select…', disabled: false, size: 'md' },
);

const emit = defineEmits<{
  'update:modelValue': [value: T];
  change: [value: T];
}>();

const isDisabled = computed(() => props.disabled || !!props.reason);
const open = ref(false);
useShortcutBlockingOverlay(open);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);
const menuStyle = ref<Record<string, string>>({});

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));
const label = computed(() => selected.value?.label ?? props.placeholder);

// APG select-only combobox: focus stays on the trigger, so the active option is
// announced through aria-activedescendant rather than by moving DOM focus.
const listboxId = useId();
const optionId = (index: number): string => `${listboxId}-option-${index}`;
const activeDescendantId = computed(() =>
  open.value && activeIndex.value >= 0 ? optionId(activeIndex.value) : undefined,
);

/** Positions the popover under (or above) the trigger using fixed coordinates. */
function reposition(): void {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  // A teleported list cannot cover a native top-layer popover. Place it just
  // outside that popover so every option remains visible and clickable.
  const host = trigger.closest<HTMLElement>('[popover]:popover-open');
  const edge = host?.getBoundingClientRect() ?? rect;
  const below = window.innerHeight - edge.bottom;
  const maxHeight = Math.min(320, Math.max(below, edge.top) - 16);
  const openUp = below < 220 && edge.top > below;
  menuStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    minWidth: `${rect.width}px`,
    maxHeight: `${maxHeight}px`,
    ...(openUp
      ? { bottom: `${window.innerHeight - edge.top + 6}px` }
      : { top: `${edge.bottom + 6}px` }),
  };
}

let repositionFrame: number | null = null;

/** Coalesces viewport changes into one reposition per frame, ignoring the list's own scroll. */
function scheduleReposition(event: Event): void {
  if (event.target instanceof Node && listRef.value?.contains(event.target)) return;
  if (repositionFrame !== null) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = null;
    reposition();
  });
}

function cancelScheduledReposition(): void {
  if (repositionFrame === null) return;
  cancelAnimationFrame(repositionFrame);
  repositionFrame = null;
}

function openMenu(): void {
  if (isDisabled.value) return;
  open.value = true;
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  );
  void nextTick().then(() => {
    reposition();
    scrollActiveIntoView();
  });
}

function closeMenu(focusTrigger = true): void {
  open.value = false;
  if (focusTrigger) triggerRef.value?.focus();
}

function toggle(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function choose(option: Option): void {
  if (option.disabled) return;
  if (option.value !== props.modelValue) {
    emit('update:modelValue', option.value);
    emit('change', option.value);
  }
  closeMenu();
}

function scrollActiveIntoView(): void {
  const list = listRef.value;
  if (!list) return;
  const node = list.children[activeIndex.value] as HTMLElement | undefined;
  node?.scrollIntoView({ block: 'nearest' });
}

/** Moves the active highlight by `delta`, skipping disabled options. */
function move(delta: number): void {
  const count = props.options.length;
  if (count === 0) return;
  let index = activeIndex.value;
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count;
    if (!props.options[index]?.disabled) break;
  }
  activeIndex.value = index;
  scrollActiveIntoView();
}

let typeahead = '';
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

function onTypeahead(key: string): void {
  typeahead += key.toLowerCase();
  clearTimeout(typeaheadTimer);
  typeaheadTimer = setTimeout(() => {
    typeahead = '';
  }, 600);
  const match = props.options.findIndex(
    (o) => !o.disabled && o.label.toLowerCase().startsWith(typeahead),
  );
  if (match !== -1) {
    activeIndex.value = match;
    scrollActiveIntoView();
  }
}

/** Returns the first enabled option index from the requested edge. */
function enabledEdgeIndex(fromEnd: boolean): number {
  const options = fromEnd ? [...props.options].reverse() : props.options;
  const offset = options.findIndex((option) => !option.disabled);
  if (offset < 0) return activeIndex.value;
  return fromEnd ? props.options.length - 1 - offset : offset;
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open.value) openMenu();
      else move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (!open.value) openMenu();
      else move(-1);
      break;
    case 'Home':
      if (open.value) {
        event.preventDefault();
        activeIndex.value = enabledEdgeIndex(false);
        scrollActiveIntoView();
      }
      break;
    case 'End':
      if (open.value) {
        event.preventDefault();
        activeIndex.value = enabledEdgeIndex(true);
        scrollActiveIntoView();
      }
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (!open.value) openMenu();
      else {
        const option = props.options[activeIndex.value];
        if (option) choose(option);
      }
      break;
    case 'Escape':
      if (open.value) {
        event.preventDefault();
        closeMenu();
      }
      break;
    case 'Tab':
      if (open.value) closeMenu(false);
      break;
    default:
      if (open.value && event.key.length === 1) onTypeahead(event.key);
      break;
  }
}

useOutsidePointerDown(
  open,
  (target) => !!triggerRef.value?.contains(target) || !!listRef.value?.contains(target),
  () => closeMenu(false),
);

watch(open, (isOpen) => {
  if (isOpen) {
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
  } else {
    window.removeEventListener('resize', scheduleReposition);
    window.removeEventListener('scroll', scheduleReposition, true);
    cancelScheduledReposition();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleReposition);
  window.removeEventListener('scroll', scheduleReposition, true);
  cancelScheduledReposition();
  clearTimeout(typeaheadTimer);
});
</script>

<template>
  <span class="select-menu">
    <button
      ref="triggerRef"
      type="button"
      class="select-trigger"
      :class="[`is-${props.size}`, { 'is-open': open }]"
      :disabled="isDisabled"
      role="combobox"
      :aria-label="props.ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="activeDescendantId"
      v-tooltip="{ text: props.title, reason: props.reason }"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="select-value" :class="{ 'is-placeholder': !selected }">{{ label }}</span>
      <svg class="select-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path
          d="M2.5 4.5L6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <Teleport to="body">
    <Transition name="select-pop">
      <ul
        v-if="open"
        :id="listboxId"
        ref="listRef"
        class="select-list"
        :class="`is-${props.size}`"
        data-select-list
        :style="menuStyle"
        role="listbox"
        :aria-label="props.ariaLabel"
        @keydown="onKeydown"
      >
        <li
          v-for="(option, index) in props.options"
          :id="optionId(index)"
          :key="String(option.value)"
          class="select-option"
          :class="{
            'is-active': index === activeIndex,
            'is-selected': option.value === props.modelValue,
            'is-disabled': option.disabled,
            'has-detail': option.detail,
          }"
          role="option"
          :aria-selected="option.value === props.modelValue"
          :aria-disabled="option.disabled"
          :data-value="option.value"
          @click="choose(option)"
          @mousemove="activeIndex = index"
        >
          <span class="select-option-text">
            <span class="select-option-label">{{ option.label }}</span>
            <span v-if="option.detail" class="select-option-detail">{{ option.detail }}</span>
          </span>
          <svg
            v-if="option.value === props.modelValue"
            class="select-check"
            viewBox="0 0 14 14"
            width="13"
            height="13"
            aria-hidden="true"
          >
            <path
              d="M2.5 7.5L6 11l5.5-7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </li>
        </ul>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.select-menu {
  display: inline-block;
  width: 100%;
  min-width: 0;
}

.select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-width: 0;
  width: 100%;
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  color: var(--text-1);
  /* Field face with a clear edge; menus use the separate floating surface. */
  background: var(--surface-field);
  background-image: none;
  border: none;
  border-radius: var(--radius-md);
  box-shadow: var(--control-lift);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.select-trigger.is-sm {
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-xs);
}

.select-trigger:hover:not(:disabled) {
  background: var(--control-bg-hover);
  box-shadow: var(--control-lift-hover);
}

.select-trigger.is-open {
  box-shadow: var(--control-edge), var(--ring);
}

.select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-value.is-placeholder {
  color: var(--text-4);
}

.select-chevron {
  flex: none;
  color: var(--text-3);
  transition: transform var(--dur-1) var(--ease-out);
}

.select-trigger.is-open .select-chevron {
  transform: rotate(180deg);
  color: var(--accent);
}

.select-list {
  position: fixed;
  z-index: 120;
  margin: 0;
  padding: var(--sp-2);
  list-style: none;
  /* Teleported to <body>, so the list cannot inherit the trigger's context;
   * pin the option type scale to the trigger size instead of the body font. */
  font-size: var(--fs-sm);
  overflow: auto;
  background: var(--surface-floating);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-hairline), var(--shadow-pop);
}

.select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: 0;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
  font-size: inherit;
}

.select-option-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
}

.select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.select-option.has-detail .select-option-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.select-option-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.select-option.is-active .select-option-detail {
  color: var(--text-2);
}

.select-list.is-sm {
  font-size: var(--fs-xs);
}

.select-list.is-sm .select-option {
  padding: var(--sp-1) var(--sp-3);
}

.select-option.is-active {
  background: var(--accent-soft);
  color: var(--text-1);
}

.select-option.is-selected {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.select-option.is-selected.has-detail .select-option-label {
  font-weight: var(--fw-semibold);
}

.select-option.is-active.is-selected {
  color: var(--text-1);
}

.select-option.is-disabled {
  color: var(--text-4);
  cursor: default;
}

.select-option.is-disabled.is-active {
  background: transparent;
  color: var(--text-4);
}

.select-check {
  flex: none;
  color: var(--accent);
}

.select-option.is-active .select-check {
  color: var(--accent);
}

.select-pop-enter-active {
  transition: opacity var(--dur-1) var(--ease-out),
    transform var(--dur-2) var(--ease-out);
}
.select-pop-leave-active {
  transition: opacity var(--dur-1) var(--ease-out);
}
.select-pop-enter-from {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
.select-pop-leave-to {
  opacity: 0;
}
</style>
