<script setup lang="ts">
import { computed } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import { useShortcuts } from '@/composables/useShortcuts';
import { useI18n } from '@/ui/i18n';
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

function close(): void {
  emit('close');
}
</script>

<template>
  <AppModal
    :open="props.open"
    size="lg"
    :aria-label="t.dialogs.shortcutsHelp.title"
    @close="close"
  >
    <template #title>{{ t.dialogs.shortcutsHelp.title }}</template>
    <div class="sections">
      <section v-for="section in sections" :key="section.scope" class="scope-section">
        <h3 class="scope-title">{{ section.label }}</h3>
        <dl class="shortcut-list">
          <template v-for="row in section.rows" :key="row.id">
            <dt class="shortcut-label">{{ row.label }}</dt>
            <dd class="shortcut-keys"><span class="keys-chip">{{ row.keys }}</span></dd>
          </template>
        </dl>
      </section>
    </div>
    <template #actions>
      <button type="button" class="primary" @click="close">
        {{ t.dialogs.shortcutsHelp.close }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
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
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
  color: var(--text-1);
}

/* Subtle keycap so the bindings column reads as discrete keys, not prose. */
.keys-chip {
  display: inline-block;
  background: var(--surface-inset);
  box-shadow: var(--control-edge);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-2);
}

.primary {
  background: var(--accent-strong);
  border: 1px solid var(--accent);
  color: var(--text-1);
  border-radius: var(--radius-sm);
  padding: 0.25rem 0.9rem;
  cursor: pointer;
  box-shadow: var(--raise-hi);
  transition: background var(--dur-1) var(--ease-out);
}

.primary:hover {
  background: var(--accent-hover);
}
</style>
