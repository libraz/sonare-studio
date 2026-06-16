<script setup lang="ts" generic="T extends string | number">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

/**
 * Accessible, frosted-glass replacement for the native <select>. Drop-in: bind
 * `v-model` and pass an `options` array. The trigger mirrors the tokenized
 * control baseline; the popover is teleported to the body, positioned under the
 * trigger (flipping above when there is no room) and supports full keyboard
 * navigation (arrows, Home/End, Enter/Space, Escape, type-ahead).
 */

interface Option {
  value: T;
  label: string;
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
    /** Compact trigger height. */
    size?: 'sm' | 'md';
  }>(),
  { placeholder: 'Select…', disabled: false, size: 'md' },
);

const emit = defineEmits<{
  'update:modelValue': [value: T];
  change: [value: T];
}>();

const open = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);
const menuStyle = ref<Record<string, string>>({});

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));
const label = computed(() => selected.value?.label ?? props.placeholder);

/** Positions the popover under (or above) the trigger using fixed coordinates. */
function reposition(): void {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  const maxHeight = Math.min(320, Math.max(below, rect.top) - 16);
  const openUp = below < 220 && rect.top > below;
  menuStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    minWidth: `${rect.width}px`,
    maxHeight: `${maxHeight}px`,
    ...(openUp
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` }),
  };
}

function openMenu(): void {
  if (props.disabled) return;
  open.value = true;
  activeIndex.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  );
  void nextTick(() => {
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
        activeIndex.value = 0;
        move(0);
      }
      break;
    case 'End':
      if (open.value) {
        event.preventDefault();
        activeIndex.value = props.options.length - 1;
        move(0);
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

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node;
  if (triggerRef.value?.contains(target) || listRef.value?.contains(target)) return;
  closeMenu(false);
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition, true);
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
      :disabled="props.disabled"
      :aria-label="props.ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
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
        ref="listRef"
        class="select-list"
        :style="menuStyle"
        role="listbox"
        :aria-label="props.ariaLabel"
        @keydown="onKeydown"
      >
        <li
          v-for="(option, index) in props.options"
          :key="String(option.value)"
          class="select-option"
          :class="{
            'is-active': index === activeIndex,
            'is-selected': option.value === props.modelValue,
            'is-disabled': option.disabled,
          }"
          role="option"
          :aria-selected="option.value === props.modelValue"
          :aria-disabled="option.disabled"
          @click="choose(option)"
          @mousemove="activeIndex = index"
        >
          <span class="select-option-label">{{ option.label }}</span>
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
  /* Native macOS pop-up button: a raised face, not a sunken form field. */
  background: var(--control-bg);
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
  overflow: auto;
  background: var(--glass-3);
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
  border-radius: var(--radius-sm);
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}

.select-option.is-active {
  background: var(--accent);
  color: var(--accent-text);
}

.select-option.is-selected {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.select-option.is-active.is-selected {
  color: var(--accent-text);
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
  color: var(--accent-text);
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
