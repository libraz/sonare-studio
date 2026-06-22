<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useShortcuts } from '@/composables/useShortcuts';
import { useI18n } from '@/ui/i18n';
import { createFocusTrap, type FocusTrap } from '@/ui/settings/focus-trap';
import { detectPlatform, formatKeyCombo } from '@/ui/settings/key-combo';
import type { ShortcutActionDef, ShortcutScope } from '@/ui/settings/shortcuts';

/**
 * Read-only keyboard-shortcut cheatsheet overlay, generated from the
 * shortcut registry (so remapped keys show their current bindings). Rows are
 * grouped by scope; Escape or a click outside dismisses it.
 */

const props = defineProps<{
  /** Whether the overlay is visible. */
  open: boolean;
}>();

const emit = defineEmits<{
  /** The overlay was dismissed. */
  close: [];
}>();

const shortcuts = useShortcuts();
const { t } = useI18n();
const platform = detectPlatform();

const SCOPE_ORDER: ReadonlyArray<ShortcutScope> = ['global', 'arrangement', 'editor'];

interface HelpRow {
  id: string;
  label: string;
  keys: string;
}

interface HelpSection {
  scope: ShortcutScope;
  label: string;
  rows: HelpRow[];
}

function rowKeys(action: ShortcutActionDef): string {
  if (action.keysLabel !== undefined) return action.keysLabel;
  const keys = shortcuts.keysFor(action.id);
  if (keys.length === 0) return t.value.dialogs.shortcutsHelp.emptyKeys;
  return keys.map((combo) => formatKeyCombo(combo, platform)).join(' / ');
}

function shortcutActionLabel(action: ShortcutActionDef): string {
  return (
    t.value.shortcuts.actions[action.id as keyof typeof t.value.shortcuts.actions] ?? action.label
  );
}

const sections = computed<HelpSection[]>(() =>
  SCOPE_ORDER.map((scope) => ({
    scope,
    label: t.value.dialogs.shortcutsHelp.scopes[scope],
    rows: shortcuts.actions
      .filter((action) => action.when === scope)
      .map((action) => ({
        id: action.id,
        label: shortcutActionLabel(action),
        keys: rowKeys(action),
      })),
  })).filter((section) => section.rows.length > 0),
);

const dialogRef = ref<HTMLElement | null>(null);
let trap: FocusTrap | null = null;

watch(
  () => props.open,
  (open) => {
    if (open) {
      void nextTick(() => {
        if (dialogRef.value === null) return;
        trap = createFocusTrap(dialogRef.value);
        trap.activate();
      });
    } else {
      trap?.deactivate();
      trap = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  trap?.deactivate();
  trap = null;
});

function close(): void {
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}
</script>

<template>
  <div v-if="props.open" class="dialog-overlay" @click.self="close">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t.dialogs.shortcutsHelp.title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <h2 class="dialog-title">{{ t.dialogs.shortcutsHelp.title }}</h2>
      <div class="sections">
        <section v-for="section in sections" :key="section.scope" class="scope-section">
          <h3 class="scope-title">{{ section.label }}</h3>
          <dl class="shortcut-list">
            <template v-for="row in section.rows" :key="row.id">
              <dt class="shortcut-label">{{ row.label }}</dt>
              <dd class="shortcut-keys">{{ row.keys }}</dd>
            </template>
          </dl>
        </section>
      </div>
      <div class="dialog-actions">
        <button type="button" class="primary" @click="close">
          {{ t.dialogs.shortcutsHelp.close }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(46rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: 1.25rem 1.4rem;
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
}

.sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem;
  overflow: auto;
}

.scope-section {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.7rem;
  box-shadow: var(--raise-hi);
}

.scope-title {
  margin: 0 0 0.35rem;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.shortcut-list {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.15rem 0.75rem;
  margin: 0;
}

.shortcut-label {
  color: var(--text-2);
}

.shortcut-keys {
  margin: 0;
  font-family: var(--font-mono);
  white-space: nowrap;
  text-align: right;
  color: var(--text-1);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
}

.dialog-actions .primary {
  background: var(--accent-strong);
  border: 1px solid var(--accent);
  color: var(--text-1);
  border-radius: var(--radius-sm);
  padding: 0.25rem 0.9rem;
  cursor: pointer;
  box-shadow: var(--raise-hi);
  transition: background var(--dur-1) var(--ease-out);
}

.dialog-actions .primary:hover {
  background: var(--accent-hover);
}
</style>
