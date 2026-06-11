<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useLayouts } from '@/composables/useLayouts';
import { useShortcuts } from '@/composables/useShortcuts';
import {
  AUTOSAVE_INTERVAL_MAX_MS,
  AUTOSAVE_INTERVAL_MIN_MS,
  COUNT_IN_BARS_MAX,
  COUNT_IN_BARS_MIN,
} from '@/ui/settings/app-settings';
import { createFocusTrap, type FocusTrap } from '@/ui/settings/focus-trap';
import {
  comboFromEvent,
  comboToString,
  detectPlatform,
  formatKeyCombo,
} from '@/ui/settings/key-combo';
import type { LayoutBindings } from '@/ui/settings/layouts';
import type { ShortcutActionDef } from '@/ui/settings/shortcuts';

/**
 * Tabbed application-settings modal: General preferences, shortcut remapping
 * (press keys inline to rebind) and named workspace layouts. The shell passes
 * its layout refs via `layoutBindings` so layouts can be captured and applied
 * without this dialog knowing the shell internals.
 */

const props = withDefaults(
  defineProps<{
    /** Whether the dialog is visible. */
    open: boolean;
    /** Shell layout refs for the Layouts tab (omit to disable capture/apply). */
    layoutBindings?: LayoutBindings | null;
  }>(),
  { layoutBindings: null },
);

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
}>();

const appSettings = useAppSettings();
const shortcuts = useShortcuts();
const namedLayouts = useLayouts();
const platform = detectPlatform();

type TabId = 'general' | 'shortcuts' | 'layouts';
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'layouts', label: 'Layouts' },
];
const activeTab = ref<TabId>('general');

const dialogRef = ref<HTMLElement | null>(null);
let trap: FocusTrap | null = null;

function close(): void {
  emit('close');
}

function onDialogKeydown(event: KeyboardEvent): void {
  // While capturing a shortcut, the window-level capture listener consumes
  // every key (including Escape), so this handler never closes mid-capture.
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

/** Moves the tab selection by `delta`, wrapping around. */
function moveTab(delta: number): void {
  const index = TABS.findIndex((tab) => tab.id === activeTab.value);
  const next = (index + delta + TABS.length) % TABS.length;
  activeTab.value = TABS[next].id;
}

function onTabKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveTab(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveTab(-1);
  }
}

// --- General tab -----------------------------------------------------------

const autosaveSeconds = computed<number>(() =>
  Math.round(appSettings.settings.autosaveIntervalMs / 1000),
);

function onAutosaveSecondsInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  appSettings.set('autosaveIntervalMs', value * 1000);
}

function onCountInInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  appSettings.set('countInBars', value);
}

// --- Shortcuts tab ----------------------------------------------------------

/** Action id currently listening for a new key combo, or null. */
const capturingId = ref<string | null>(null);

const conflictActionIds = computed<ReadonlySet<string>>(() => {
  const ids = new Set<string>();
  for (const conflict of shortcuts.conflicts.value) {
    for (const id of conflict.actionIds) ids.add(id);
  }
  return ids;
});

function keysText(action: ShortcutActionDef): string {
  if (action.keysLabel !== undefined) return action.keysLabel;
  const keys = shortcuts.keysFor(action.id);
  if (keys.length === 0) return '—';
  return keys.map((combo) => formatKeyCombo(combo, platform)).join(' / ');
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
  if (actionId !== null) shortcuts.setKeys(actionId, [comboToString(combo)]);
}

/** Resets one action's keys; the reset button unmounts itself, so focus is
 *  moved back onto the dialog to keep Escape and Tab working. */
function resetActionKeys(actionId: string): void {
  shortcuts.resetKeys(actionId);
  dialogRef.value?.focus();
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

// --- Layouts tab ------------------------------------------------------------

const newLayoutName = ref('');
const layoutError = ref('');

function applyLayout(name: string): void {
  if (props.layoutBindings === null) return;
  namedLayouts.apply(name, props.layoutBindings);
}

function saveCurrentLayout(): void {
  if (props.layoutBindings === null) return;
  const name = newLayoutName.value.trim();
  if (namedLayouts.saveCurrent(name, props.layoutBindings)) {
    newLayoutName.value = '';
    layoutError.value = '';
  } else {
    layoutError.value =
      name === ''
        ? 'Enter a layout name.'
        : namedLayouts.isPreset(name)
          ? 'That name is reserved for a preset.'
          : 'Could not save the layout.';
  }
}

function deleteLayout(name: string): void {
  namedLayouts.remove(name);
}

function renameLayout(name: string): void {
  const next = window.prompt('Rename layout', name);
  if (next === null) return;
  if (!namedLayouts.rename(name, next)) {
    layoutError.value = 'Could not rename the layout (name empty or already used).';
  } else {
    layoutError.value = '';
  }
}

// --- Open/close lifecycle ----------------------------------------------------
// Registered last so the immediate run can safely reach every declaration.

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
      stopCapture();
      trap?.deactivate();
      trap = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopCapture();
  trap?.deactivate();
  trap = null;
});
</script>

<template>
  <div v-if="props.open" class="dialog-overlay" @click.self="close">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <h2 class="dialog-title">Settings</h2>
      <div class="tabs" role="tablist" aria-label="Settings sections" @keydown="onTabKeydown">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ active: activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`settings-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div
        v-if="activeTab === 'general'"
        id="settings-panel-general"
        class="panel"
        role="tabpanel"
        aria-label="General"
      >
        <label class="row">
          <span class="row-label">Editor density</span>
          <select
            :value="appSettings.settings.editorDensity"
            @change="
              appSettings.set(
                'editorDensity',
                ($event.target as HTMLSelectElement).value as 'comfortable' | 'compact',
              )
            "
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label class="row">
          <span class="row-label">Snap to grid by default</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.snapDefault"
            @change="appSettings.set('snapDefault', ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span class="row-label">Count-in (bars)</span>
          <input
            type="number"
            :min="COUNT_IN_BARS_MIN"
            :max="COUNT_IN_BARS_MAX"
            :value="appSettings.settings.countInBars"
            @change="onCountInInput"
          />
        </label>
        <label class="row">
          <span class="row-label">Monitor input when arming</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.monitorDefault"
            @change="appSettings.set('monitorDefault', ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span class="row-label">Autosave interval (seconds)</span>
          <input
            type="number"
            :min="AUTOSAVE_INTERVAL_MIN_MS / 1000"
            :max="AUTOSAVE_INTERVAL_MAX_MS / 1000"
            :value="autosaveSeconds"
            @change="onAutosaveSecondsInput"
          />
        </label>
        <label class="row">
          <span class="row-label">Scroll view to follow playhead</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.scrollFollowPlayhead"
            @change="
              appSettings.set('scrollFollowPlayhead', ($event.target as HTMLInputElement).checked)
            "
          />
        </label>
        <label class="row">
          <span class="row-label">Confirm destructive actions</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.confirmDestructive"
            @change="
              appSettings.set('confirmDestructive', ($event.target as HTMLInputElement).checked)
            "
          />
        </label>
        <div class="panel-actions">
          <button type="button" @click="appSettings.reset()">Reset to defaults</button>
        </div>
      </div>

      <div
        v-else-if="activeTab === 'shortcuts'"
        id="settings-panel-shortcuts"
        class="panel"
        role="tabpanel"
        aria-label="Shortcuts"
      >
        <p v-if="shortcuts.conflicts.value.length > 0" class="conflict-banner" role="alert">
          Some shortcuts share the same keys; highlighted rows may shadow each other.
        </p>
        <table class="shortcut-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Scope</th>
              <th scope="col">Keys</th>
              <th scope="col"><span class="visually-hidden">Edit</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="action in shortcuts.actions"
              :key="action.id"
              :class="{ conflict: conflictActionIds.has(action.id) }"
              :data-action-id="action.id"
            >
              <td>{{ action.label }}</td>
              <td class="scope-cell">{{ action.when }}</td>
              <td class="keys-cell">
                <span v-if="capturingId === action.id" class="capturing">
                  Press keys… (Esc cancels)
                </span>
                <span v-else>{{ keysText(action) }}</span>
              </td>
              <td class="edit-cell">
                <template v-if="action.customizable">
                  <button
                    type="button"
                    class="small"
                    :aria-label="`Change keys for ${action.label}`"
                    @click="capturingId === action.id ? stopCapture() : startCapture(action.id)"
                  >
                    {{ capturingId === action.id ? 'Cancel' : 'Edit' }}
                  </button>
                  <button
                    v-if="shortcuts.isOverridden(action.id)"
                    type="button"
                    class="small"
                    :aria-label="`Reset keys for ${action.label}`"
                    @click="resetActionKeys(action.id)"
                  >
                    Reset
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="panel-actions">
          <button type="button" @click="shortcuts.resetAll()">Reset all shortcuts</button>
        </div>
      </div>

      <div
        v-else
        id="settings-panel-layouts"
        class="panel"
        role="tabpanel"
        aria-label="Layouts"
      >
        <h3 class="panel-heading">Presets</h3>
        <ul class="layout-list">
          <li v-for="layout in namedLayouts.presets" :key="layout.name" class="layout-item">
            <span class="layout-name">{{ layout.name }}</span>
            <span class="layout-actions">
              <button
                type="button"
                class="small"
                :disabled="props.layoutBindings === null"
                @click="applyLayout(layout.name)"
              >
                Apply
              </button>
            </span>
          </li>
        </ul>
        <h3 class="panel-heading">My layouts</h3>
        <p v-if="namedLayouts.userLayouts.value.length === 0" class="layout-empty">
          No saved layouts yet.
        </p>
        <ul v-else class="layout-list">
          <li
            v-for="layout in namedLayouts.userLayouts.value"
            :key="layout.name"
            class="layout-item"
          >
            <span class="layout-name">{{ layout.name }}</span>
            <span class="layout-actions">
              <button
                type="button"
                class="small"
                :disabled="props.layoutBindings === null"
                @click="applyLayout(layout.name)"
              >
                Apply
              </button>
              <button type="button" class="small" @click="renameLayout(layout.name)">Rename</button>
              <button type="button" class="small" @click="deleteLayout(layout.name)">Delete</button>
            </span>
          </li>
        </ul>
        <div class="layout-save">
          <input
            v-model="newLayoutName"
            type="text"
            placeholder="Layout name"
            aria-label="New layout name"
            @keydown.enter.prevent="saveCurrentLayout"
          />
          <button
            type="button"
            :disabled="props.layoutBindings === null"
            @click="saveCurrentLayout"
          >
            Save current layout
          </button>
        </div>
        <p v-if="layoutError !== ''" class="layout-error" role="alert">{{ layoutError }}</p>
      </div>

      <div class="dialog-actions">
        <button type="button" class="primary" @click="close">Close</button>
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
  background: rgba(0, 0, 0, 0.55);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(38rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: 1rem 1.25rem;
  background: #1b1e25;
  border: 1px solid #000;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
  color: #e2e6ee;
  font-size: 12px;
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #2a2e38;
}

.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #8b93a3;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  font-size: 12px;
}

.tab.active {
  color: #e2e6ee;
  border-bottom-color: #60a5fa;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  overflow: auto;
  min-height: 12rem;
}

.panel-heading {
  margin: 0.2rem 0 0;
  font-size: 11px;
  font-weight: 600;
  color: #8b93a3;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.row-label {
  color: #c4cad6;
}

.row input[type='number'] {
  width: 4.5rem;
}

.row select,
.row input {
  background: #11141a;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #e2e6ee;
  padding: 0.15rem 0.3rem;
}

.shortcut-table {
  width: 100%;
  border-collapse: collapse;
}

.shortcut-table th {
  text-align: left;
  color: #8b93a3;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.4rem;
  border-bottom: 1px solid #2a2e38;
}

.shortcut-table td {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid #14161b;
}

.shortcut-table tr.conflict td {
  background: #3a1f1f;
}

.scope-cell {
  color: #8b93a3;
  font-size: 11px;
}

.keys-cell {
  font-family: ui-monospace, monospace;
  white-space: nowrap;
}

.capturing {
  color: #fbbf24;
}

.edit-cell {
  white-space: nowrap;
  text-align: right;
}

.conflict-banner {
  margin: 0;
  background: #3a2a0c;
  border: 1px solid #fbbf24;
  border-radius: 4px;
  color: #fde68a;
  padding: 0.4rem 0.6rem;
}

button.small {
  background: #232733;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #c4cad6;
  font-size: 11px;
  padding: 0.1rem 0.5rem;
  cursor: pointer;
  margin-left: 0.25rem;
}

button.small:disabled {
  opacity: 0.5;
  cursor: default;
}

.layout-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.layout-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0.2rem;
  border-bottom: 1px solid #14161b;
}

.layout-name {
  font-weight: 600;
}

.layout-empty {
  margin: 0;
  color: #8b93a3;
}

.layout-save {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.3rem;
}

.layout-save input {
  flex: 1;
  background: #11141a;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #e2e6ee;
  padding: 0.2rem 0.4rem;
}

.layout-error {
  margin: 0;
  color: #f87171;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.3rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-actions .primary {
  background: #2453a8;
  border: 1px solid #60a5fa;
  color: #e2e6ee;
  border-radius: 4px;
  padding: 0.25rem 0.9rem;
  cursor: pointer;
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
