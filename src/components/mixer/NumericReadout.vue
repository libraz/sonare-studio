<script setup lang="ts">
import { nextTick, ref } from 'vue';

/**
 * Compact value readout that becomes a bounded number input when clicked.
 * Controls keep their specialised drag surface while still permitting exact
 * values to be entered without keyboard nudging.
 */
const props = withDefaults(
  defineProps<{
    /** Current controlled value. */
    value: number;
    /** Inclusive lower input bound. */
    min: number;
    /** Inclusive upper input bound. */
    max: number;
    /** Native number-input increment. */
    step?: number;
    /** Text shown before the readout enters edit mode. */
    display: string;
    /** Optional unit shown after the number. */
    unit?: string;
    /** Accessible control name. */
    ariaLabel: string;
    /** Prevents starting or committing an edit. */
    disabled?: boolean;
  }>(),
  { step: 0.1, unit: '', disabled: false },
);

const emit = defineEmits<{
  /** A finite, clamped value committed by Enter or focus loss. */
  change: [value: number];
}>();

const editing = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

function clamp(value: number): number {
  return Math.min(props.max, Math.max(props.min, value));
}

function startEditing(): void {
  if (props.disabled) return;
  draft.value = String(props.value);
  editing.value = true;
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
}

function finish(commit: boolean): void {
  if (!editing.value) return;
  editing.value = false;
  const text = String(draft.value).trim();
  const value = text === '' ? Number.NaN : Number(text);
  if (commit && Number.isFinite(value)) emit('change', clamp(value));
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    finish(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    finish(false);
  }
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    class="numeric-readout-input"
    type="number"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    :aria-label="props.ariaLabel"
    @blur="finish(true)"
    @keydown="onKeyDown"
  />
  <button
    v-else
    type="button"
    class="numeric-readout"
    :disabled="props.disabled"
    :aria-label="props.ariaLabel"
    @click.stop="startEditing"
  >
    {{ props.unit ? `${props.display} ${props.unit}` : props.display }}
  </button>
</template>

<style scoped>
.numeric-readout,
.numeric-readout-input {
  display: inline-block;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: inherit;
}

.numeric-readout {
  border: 1px solid transparent;
  background: transparent;
  box-shadow: none;
  color: inherit;
  cursor: text;
  padding: 0 2px;
}

.numeric-readout:hover:not(:disabled),
.numeric-readout:focus-visible {
  border-color: var(--border-strong);
  background: var(--surface-3);
  outline: none;
}

.numeric-readout:disabled {
  cursor: default;
  opacity: 0.55;
}

.numeric-readout-input {
  width: 100%;
  min-width: 3.75rem;
  border: 1px solid var(--accent);
  background: var(--surface-0);
  color: var(--text-1);
  padding: 0 2px;
  outline: none;
}
</style>
