<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/ui/i18n';

/**
 * Native-app search field — a single inset well that frames a leading magnifier
 * glyph, the query input and a clear button that fades in once there is text.
 * Replaces bare `<input type="search">`, whose browser-default search affordances
 * (the UA magnifier and the native cancel cross) read as an HTML form control.
 *
 * Drop-in: bind `v-model` to the query string. The wrapper carries the control
 * face, so a host only needs to size it (e.g. flex / width via a passed class);
 * the inner input is transparent and inherits the frame. The clear reveal
 * collapses to a plain swap under reduced motion (the motion tokens are 0ms).
 */

const model = defineModel<string>({ required: true });

const props = withDefaults(
  defineProps<{
    /** Placeholder shown when empty. */
    placeholder?: string;
    /** Accessible label for the input. */
    ariaLabel?: string;
    /** Accessible label for the clear button. */
    clearLabel?: string;
    /** Disable the field. */
    disabled?: boolean;
    /** Compact height for dense pickers / popovers. */
    size?: 'sm' | 'md';
    /** Explicit input role for composite widgets such as a command combobox. */
    inputRole?: 'searchbox' | 'combobox';
    ariaControls?: string;
    ariaActiveDescendant?: string;
    ariaExpanded?: boolean;
    ariaAutocomplete?: 'none' | 'inline' | 'list' | 'both';
  }>(),
  { disabled: false, size: 'md' },
);
const { t } = useI18n();
const localizedClearLabel = computed(() => props.clearLabel ?? t.value.shell.clearSearch);

/** Empties the query. */
function clear(): void {
  model.value = '';
}
</script>

<template>
  <span class="search-field" :class="[`is-${size}`, { 'is-disabled': disabled }]">
    <svg class="search-glyph" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path
        d="M9.2 9.2L13 13"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
    <input
      v-model="model"
      class="search-input"
      type="search"
      spellcheck="false"
      autocomplete="off"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      :role="inputRole"
      :aria-controls="ariaControls"
      :aria-activedescendant="ariaActiveDescendant"
      :aria-expanded="ariaExpanded"
      :aria-autocomplete="ariaAutocomplete"
      :disabled="disabled"
    />
    <Transition name="fade">
      <button
        v-if="model && !disabled"
        type="button"
        class="search-clear"
        :aria-label="localizedClearLabel"
        @click="clear"
      >
        <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
          <path
            d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </Transition>
  </span>
</template>

<style scoped>
.search-field {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  box-sizing: border-box;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  box-shadow: var(--control-edge), var(--inset-well);
  color: var(--text-3);
  transition: box-shadow var(--dur-1) var(--ease-out);
}

.search-field.is-sm {
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-sm);
}

.search-field:focus-within {
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.search-field.is-disabled {
  opacity: 0.5;
}

.search-glyph {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--text-3);
}

.search-field.is-sm .search-glyph {
  width: 11px;
  height: 11px;
}

/* Transparent inside the framed well — class specificity overrides the global
 * input baseline (face, padding, focus ring) from controls.css. */
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  color: var(--text-1);
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
}

.search-field.is-sm .search-input {
  font-size: var(--fs-xs);
}

.search-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}

.search-input::placeholder {
  color: var(--text-4);
}

/* Ghost icon button; brightens on hover, no raised face. */
.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: none;
  box-shadow: none;
  border-radius: var(--radius-full);
  color: var(--text-3);
  cursor: pointer;
  transition:
    color var(--dur-1) var(--ease-out),
    background-color var(--dur-1) var(--ease-out);
}

.search-clear:hover:not(:disabled) {
  background: var(--surface-4);
  color: var(--text-1);
}

.search-clear:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
