<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { useShortcuts } from '@/composables/useShortcuts';
import { formatMessage, useI18n } from '@/ui/i18n';
import { comboFromEvent, comboToString, detectPlatform } from '@/ui/settings/key-combo';
import type { ShortcutScope } from '@/ui/settings/shortcuts';
import { useShortcutFilter } from '@/ui/settings/use-shortcut-filter';

/**
 * Shortcut remapping panel: search/category filtering, conflict highlighting
 * and inline key capture. While capturing, a window-level keydown listener
 * (registered in the capture phase) consumes every key so the press adds a
 * binding without leaking to the rest of the app.
 */

const emit = defineEmits<{
  /** A row action removed itself; ask the dialog to reclaim focus. */
  'request-focus': [];
}>();

const shortcuts = useShortcuts();
const appSettings = useAppSettings();
const { t } = useI18n();
const platform = detectPlatform();

/** Action id currently listening for a new key combo, or null. */
const capturingId = ref<string | null>(null);

/** Free-text filter over action label, group and current keys. */
const shortcutQuery = ref('');
/** Selected category filter, or 'all' for every group. */
const shortcutGroup = ref('all');

const filter = useShortcutFilter(shortcuts, t, platform, shortcutQuery, shortcutGroup);

function shortcutScopeLabel(scope: ShortcutScope): string {
  return t.value.dialogs.shortcutsHelp.scopes[scope] ?? scope;
}

function onCaptureKeydown(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    stopCapture();
    return;
  }
  const combo = comboFromEvent(event);
  if (combo === null) return; // Modifier alone; keep listening.
  const actionId = capturingId.value;
  stopCapture();
  if (actionId !== null) {
    shortcuts.setKeys(actionId, [...shortcuts.keysFor(actionId), comboToString(combo)]);
  }
}

/** Explicitly stores an empty binding list, disabling the shortcut. */
function clearActionKeys(actionId: string): void {
  shortcuts.setKeys(actionId, []);
  emit('request-focus');
}

/** Resets one action's keys; the reset button unmounts itself, so focus is
 *  moved back onto the dialog to keep Escape and Tab working. */
function resetActionKeys(actionId: string): void {
  shortcuts.resetKeys(actionId);
  emit('request-focus');
}

function resetAll(): void {
  void (async () => {
    if (
      appSettings.settings.confirmDestructive &&
      !(await confirmDialog({
        title: t.value.settings.shortcuts.resetAllTitle,
        message: t.value.settings.shortcuts.resetAllMessage,
        danger: true,
        confirmLabel: t.value.settings.shortcuts.resetAll,
      }))
    )
      return;
    shortcuts.resetAll();
  })();
}

function startCapture(actionId: string): void {
  if (capturingId.value !== null) stopCapture();
  capturingId.value = actionId;
  window.addEventListener('keydown', onCaptureKeydown, true);
}

function stopCapture(): void {
  if (capturingId.value === null) return;
  capturingId.value = null;
  window.removeEventListener('keydown', onCaptureKeydown, true);
}

defineExpose({ stopCapture });

onBeforeUnmount(stopCapture);
</script>

<template>
  <div
    id="settings-panel-shortcuts"
    class="panel"
    role="tabpanel"
    :aria-label="t.settings.tabs.shortcuts"
  >
    <p v-if="shortcuts.conflicts.value.length > 0" class="conflict-banner view-enter" role="alert">
      {{ t.settings.shortcuts.conflict }}
    </p>
    <div class="shortcut-filters">
      <SearchField
        v-model="shortcutQuery"
        class="shortcut-search"
        :placeholder="t.settings.shortcuts.searchPlaceholder"
        :aria-label="t.settings.shortcuts.searchLabel"
      />
      <SelectMenu
        v-model="shortcutGroup"
        :options="filter.groupOptions.value"
        class="shortcut-group"
        :aria-label="t.settings.shortcuts.categoryLabel"
        size="sm"
      />
    </div>
    <div class="settings-group shortcut-card">
    <table class="shortcut-table">
      <thead>
        <tr>
          <th scope="col">{{ t.settings.shortcuts.action }}</th>
          <th scope="col">{{ t.settings.shortcuts.category }}</th>
          <th scope="col">{{ t.settings.shortcuts.scope }}</th>
          <th scope="col">{{ t.settings.shortcuts.keys }}</th>
          <th scope="col">
            <span class="visually-hidden">{{ t.settings.shortcuts.editHidden }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="filter.visible.value.length === 0">
          <td class="shortcut-empty" colspan="5">{{ t.settings.shortcuts.noMatches }}</td>
        </tr>
        <tr
          v-for="action in filter.visible.value"
          :key="action.id"
          :class="{ conflict: filter.conflictActionIds.value.has(action.id) }"
          :data-action-id="action.id"
        >
          <td>{{ filter.actionLabel(action) }}</td>
          <td class="group-cell">{{ filter.groupLabel(action.group) }}</td>
          <td class="scope-cell">{{ shortcutScopeLabel(action.when) }}</td>
          <td class="keys-cell">
            <span v-if="capturingId === action.id" class="capturing">
              {{ t.settings.shortcuts.capturing }}
            </span>
            <span v-else class="keys-chip">{{ filter.keysText(action) }}</span>
          </td>
          <td class="edit-cell">
            <template v-if="action.customizable">
              <button
                type="button"
                class="small"
                :aria-label="
                  formatMessage(t.settings.shortcuts.changeKeys, {
                    action: filter.actionLabel(action),
                  })
                "
                @click="capturingId === action.id ? stopCapture() : startCapture(action.id)"
              >
                {{
                  capturingId === action.id
                    ? t.settings.shortcuts.cancel
                    : t.settings.shortcuts.edit
                }}
              </button>
              <button
                v-if="shortcuts.isOverridden(action.id)"
                type="button"
                class="small"
                :aria-label="
                  formatMessage(t.settings.shortcuts.resetKeys, {
                    action: filter.actionLabel(action),
                  })
                "
                @click="resetActionKeys(action.id)"
              >
                {{ t.settings.shortcuts.reset }}
              </button>
              <button
                v-if="shortcuts.keysFor(action.id).length > 0"
                type="button"
                class="small"
                :aria-label="
                  formatMessage(t.settings.shortcuts.clearKeys, {
                    action: filter.actionLabel(action),
                  })
                "
                @click="clearActionKeys(action.id)"
              >
                {{ t.settings.shortcuts.clear }}
              </button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
    <div class="panel-actions">
      <button type="button" @click="resetAll">
        {{ t.settings.shortcuts.resetAll }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.shortcut-filters {
  display: flex;
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}

.shortcut-search {
  flex: 1;
  min-width: 0;
}

.shortcut-group {
  flex: 0 0 12rem;
}

.shortcut-empty {
  color: var(--text-3);
  font-style: italic;
  text-align: center;
  padding: var(--sp-4) var(--sp-3);
}

.group-cell {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

/* Table sits inside a rounded group card; clip its corners and let the header /
 * rows read as an inset grouped list rather than a bordered spreadsheet. */
.shortcut-card {
  overflow: hidden;
  padding: 0 var(--sp-4);
}

.shortcut-table {
  width: 100%;
  border-collapse: collapse;
}

.shortcut-table th {
  text-align: left;
  color: var(--text-3);
  font-size: var(--fs-2xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: var(--sp-3) var(--sp-2);
  border-bottom: 1px solid var(--border-subtle);
}

.shortcut-table td {
  padding: var(--sp-2) var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

.shortcut-table tbody tr:first-child td {
  border-top: none;
}

.shortcut-table tr.conflict td {
  background: var(--danger-surface);
}

.scope-cell {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.keys-cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Render the current binding as a subtle keycap so the keys column reads as
 * the scannable, editable value rather than plain inline text. */
.keys-chip {
  display: inline-block;
  background: var(--surface-inset);
  box-shadow: var(--control-edge);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-2);
}

.capturing {
  color: var(--warning);
}

.edit-cell {
  white-space: nowrap;
  text-align: right;
}

.conflict-banner {
  margin: 0;
  background: var(--warning-surface);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  color: var(--warning-text);
  padding: 0.4rem 0.6rem;
}

button.small {
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-xs);
  padding: 0.1rem 0.5rem;
  cursor: pointer;
  margin-left: 0.25rem;
  box-shadow: var(--control-lift);
  transition: background var(--dur-1) var(--ease-out);
}

button.small:hover {
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

button.small:active {
  box-shadow: var(--control-edge), var(--inset-well);
}

button.small:disabled {
  opacity: 0.5;
  cursor: default;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.3rem;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
