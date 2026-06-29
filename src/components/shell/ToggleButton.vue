<script setup lang="ts">
/**
 * Native-app pill toggle — the canonical replacement for the inline
 * `<label><input type="checkbox"> Text</label>` pattern in toolbars and option
 * strips. A single rounded face holds the label; turning it on fills the face
 * with the accent and springs once into place (desktop-DAW-style toggle
 * button), so a state flag reads as part of the app rather than an HTML form
 * control. The on/off difference is carried entirely by the face — fill, lift
 * and the spring pop — never by added glyphs, so the label width and layout
 * stay fixed across the toggle.
 *
 * Drop-in: bind `v-model` to a boolean and pass a `label` (or default slot).
 * Exposes `aria-pressed` for assistive tech; the spring collapses to nothing
 * under reduced motion (the motion tokens resolve to 0ms).
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
/* Off state: a raised control face matching the tokenized button baseline. */
.toggle-pill {
  display: inline-flex;
  align-items: center;
  flex: none;
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-2);
  background: var(--control-bg);
  border: none;
  border-radius: var(--radius-full);
  box-shadow: var(--control-lift);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out),
    transform var(--dur-1) var(--ease-out);
}

.toggle-pill.is-sm {
  font-size: var(--fs-xs);
  padding: var(--sp-1) var(--sp-3);
}

.toggle-pill:hover:not(:disabled) {
  background: var(--control-bg-hover);
  box-shadow: var(--control-lift-hover);
  color: var(--text-1);
}

.toggle-pill:active:not(:disabled) {
  transform: translateY(0.5px);
}

/*
 * On state: accent fill plus a one-shot spring pop. No glyph is added, so the
 * label width and the toolbar layout are identical to the off state — the face
 * alone carries the distinction.
 */
.toggle-pill.is-on {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.28),
    var(--shadow-1);
  animation: control-check-pop var(--dur-2) var(--ease-spring);
}

.toggle-pill.is-on:hover:not(:disabled) {
  background: var(--accent-hover);
  color: var(--accent-text);
}

.toggle-pill:focus-visible {
  outline: 2px solid transparent;
  box-shadow: var(--control-edge), var(--ring);
}

.toggle-pill:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
