<script setup lang="ts">
/**
 * Compact flat toggle — the canonical replacement for the inline
 * `<label><input type="checkbox"> Text</label>` pattern in toolbars and option
 * strips. A quiet ghost face holds the label; turning it on adds an accent-tinted
 * selection edge. The label width and layout stay fixed across the toggle.
 *
 * Drop-in: bind `v-model` to a boolean and pass a `label` (or default slot).
 * Exposes `aria-pressed` for assistive tech.
 */

const model = defineModel<boolean>({ required: true });

const props = withDefaults(
  defineProps<{
    /** Visible label; omit when a default slot is supplied. */
    label?: string;
    /** Accessible label for the trigger (defaults to `label`). */
    ariaLabel?: string;
    /** Tooltip/title text for the trigger. */
    title?: string;
    /** Disable the control. */
    disabled?: boolean;
    /** Compact height for dense toolbars. */
    size?: 'sm' | 'md';
  }>(),
  { disabled: false, size: 'md' },
);

/** Flips the bound flag unless disabled. */
function toggle(): void {
  if (props.disabled) return;
  model.value = !model.value;
}
</script>

<template>
  <button
    type="button"
    class="toggle-pill"
    :class="[`is-${props.size}`, { 'is-on': model }]"
    :disabled="props.disabled"
    :aria-pressed="model"
    :aria-label="props.ariaLabel ?? props.label"
    :title="props.title"
    @click="toggle"
  >
    <span class="toggle-label"><slot>{{ props.label }}</slot></span>
  </button>
</template>

<style scoped>
/* Off state: a quiet ghost control that does not add another outline to a bar. */
.toggle-pill {
  display: inline-flex;
  align-items: center;
  flex: none;
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  box-shadow: none;
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.toggle-pill.is-sm {
  font-size: var(--fs-xs);
  padding: var(--sp-1) var(--sp-3);
}

.toggle-pill:hover:not(:disabled) {
  background: var(--control-bg-hover);
  box-shadow: none;
  color: var(--text-1);
}

.toggle-pill:active:not(:disabled) {
  background: var(--control-bg-active);
}

/*
 * On state: selected surface and accent type. No glyph is added, so
 * the label width and toolbar layout remain identical to the off state.
 */
.toggle-pill.is-on {
  background: var(--surface-selection);
  color: var(--accent);
  font-weight: var(--fw-semibold);
  box-shadow: none;
}

.toggle-pill.is-on:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-selection));
  color: var(--accent-strong);
}

.toggle-pill.is-on:active:not(:disabled) {
  background: var(--surface-selection);
}

.toggle-pill:focus-visible {
  outline: 2px solid transparent;
  box-shadow: var(--control-edge), var(--ring);
}

.toggle-pill.is-on:focus-visible {
  box-shadow: var(--ring);
}

.toggle-pill:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
