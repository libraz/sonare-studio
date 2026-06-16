<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { promptDialog } from '@/composables/useDialogs';
import { useLayouts } from '@/composables/useLayouts';
import { useShortcuts } from '@/composables/useShortcuts';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type AppLanguage,
  type AppTheme,
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
const { t } = useI18n();
const shortcuts = useShortcuts();
const namedLayouts = useLayouts();
const platform = detectPlatform();

type TabId = 'general' | 'shortcuts' | 'layouts';
const TABS = computed<ReadonlyArray<{ id: TabId; label: string }>>(() => [
  { id: 'general', label: t.value.settings.tabs.general },
  { id: 'shortcuts', label: t.value.settings.tabs.shortcuts },
  { id: 'layouts', label: t.value.settings.tabs.layouts },
]);
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
  const tabs = TABS.value;
  const index = tabs.findIndex((tab) => tab.id === activeTab.value);
  const next = (index + delta + tabs.length) % tabs.length;
  activeTab.value = tabs[next].id;
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

/** Editor density choices for the General tab picker. */
const EDITOR_DENSITY_OPTIONS = computed<
  ReadonlyArray<{
    value: 'comfortable' | 'compact';
    label: string;
  }>
>(() => [
  { value: 'comfortable', label: t.value.settings.general.densityComfortable },
  { value: 'compact', label: t.value.settings.general.densityCompact },
]);

const THEME_OPTIONS = computed<ReadonlyArray<{ value: AppTheme; label: string }>>(() => [
  { value: 'system', label: t.value.settings.general.themeSystem },
  { value: 'light', label: t.value.settings.general.themeLight },
  { value: 'dark', label: t.value.settings.general.themeDark },
]);

const LANGUAGE_OPTIONS = computed<ReadonlyArray<{ value: AppLanguage; label: string }>>(() => [
  { value: 'system', label: t.value.settings.general.languageSystem },
  { value: 'en', label: t.value.settings.general.languageEnglish },
  { value: 'ja', label: t.value.settings.general.languageJapanese },
]);

function onEditorDensityChange(value: 'comfortable' | 'compact'): void {
  appSettings.set('editorDensity', value);
}

function onThemeChange(value: AppTheme): void {
  appSettings.set('theme', value);
}

function onLanguageChange(value: AppLanguage): void {
  appSettings.set('language', value);
}

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

/** Free-text filter over action label, group and current keys. */
const shortcutQuery = ref('');
/** Selected category filter, or 'all' for every group. */
const shortcutGroup = ref('all');

/** The distinct action groups, in registry order, for the category picker. */
const shortcutGroups = computed<string[]>(() => {
  const seen: string[] = [];
  for (const action of shortcuts.actions) {
    if (!seen.includes(action.group)) seen.push(action.group);
  }
  return seen;
});

/** Category-filter choices: "All categories" plus each distinct action group. */
const shortcutGroupOptions = computed(() => [
  { value: 'all', label: t.value.settings.shortcuts.allCategories },
  ...shortcutGroups.value.map((group) => ({ value: group, label: shortcutGroupLabel(group) })),
]);

/** Actions matching the active category and search query, in registry order. */
const visibleShortcuts = computed<ReadonlyArray<ShortcutActionDef>>(() => {
  const query = shortcutQuery.value.trim().toLowerCase();
  const group = shortcutGroup.value;
  return shortcuts.actions.filter((action) => {
    if (group !== 'all' && action.group !== group) return false;
    if (query === '') return true;
    const haystack =
      `${shortcutActionLabel(action)} ${shortcutGroupLabel(action.group)} ${keysText(action)}`.toLowerCase();
    return haystack.includes(query);
  });
});

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
  if (keys.length === 0) return t.value.settings.shortcuts.emptyKeys;
  return keys.map((combo) => formatKeyCombo(combo, platform)).join(' / ');
}

function shortcutActionLabel(action: ShortcutActionDef): string {
  return (
    t.value.shortcuts.actions[action.id as keyof typeof t.value.shortcuts.actions] ?? action.label
  );
}

function shortcutGroupLabel(group: string): string {
  return t.value.shortcuts.groups[group as keyof typeof t.value.shortcuts.groups] ?? group;
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
        ? t.value.settings.layouts.enterName
        : namedLayouts.isPreset(name)
          ? t.value.settings.layouts.reservedName
          : t.value.settings.layouts.saveFailed;
  }
}

function deleteLayout(name: string): void {
  namedLayouts.remove(name);
}

function renameLayout(name: string): void {
  void (async () => {
    const next = await promptDialog({
      title: t.value.settings.layouts.renameTitle,
      message: t.value.settings.layouts.renameMessage,
      defaultValue: name,
      placeholder: t.value.settings.layouts.layoutNamePlaceholder,
      confirmLabel: t.value.settings.layouts.renameConfirm,
    });
    if (next === null) return;
    if (!namedLayouts.rename(name, next)) {
      layoutError.value = t.value.settings.layouts.renameFailed;
    } else {
      layoutError.value = '';
    }
  })();
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
      :aria-label="t.settings.title"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <h2 class="dialog-title">{{ t.settings.title }}</h2>
      <div
        class="tabs"
        role="tablist"
        :aria-label="t.settings.sectionsLabel"
        @keydown="onTabKeydown"
      >
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
        :aria-label="t.settings.tabs.general"
      >
        <div class="row">
          <span class="row-label">{{ t.settings.general.language }}</span>
          <SelectMenu
            class="row-select"
            :model-value="appSettings.settings.language"
            :options="LANGUAGE_OPTIONS"
            :aria-label="t.settings.general.language"
            size="sm"
            @change="onLanguageChange"
          />
        </div>
        <div class="row">
          <span class="row-label">{{ t.settings.general.theme }}</span>
          <SelectMenu
            class="row-select"
            :model-value="appSettings.settings.theme"
            :options="THEME_OPTIONS"
            :aria-label="t.settings.general.theme"
            size="sm"
            @change="onThemeChange"
          />
        </div>
        <div class="row">
          <span class="row-label">{{ t.settings.general.editorDensity }}</span>
          <SelectMenu
            class="row-select"
            :model-value="appSettings.settings.editorDensity"
            :options="EDITOR_DENSITY_OPTIONS"
            :aria-label="t.settings.general.editorDensity"
            size="sm"
            @change="onEditorDensityChange"
          />
        </div>
        <label class="row">
          <span class="row-label">{{ t.settings.general.snapDefault }}</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.snapDefault"
            @change="appSettings.set('snapDefault', ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span class="row-label">{{ t.settings.general.countInBars }}</span>
          <input
            type="number"
            :min="COUNT_IN_BARS_MIN"
            :max="COUNT_IN_BARS_MAX"
            :value="appSettings.settings.countInBars"
            @change="onCountInInput"
          />
        </label>
        <label class="row">
          <span class="row-label">{{ t.settings.general.monitorDefault }}</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.monitorDefault"
            @change="appSettings.set('monitorDefault', ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <label class="row">
          <span class="row-label">{{ t.settings.general.autosaveInterval }}</span>
          <input
            type="number"
            :min="AUTOSAVE_INTERVAL_MIN_MS / 1000"
            :max="AUTOSAVE_INTERVAL_MAX_MS / 1000"
            :value="autosaveSeconds"
            @change="onAutosaveSecondsInput"
          />
        </label>
        <label class="row">
          <span class="row-label">{{ t.settings.general.scrollFollowPlayhead }}</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.scrollFollowPlayhead"
            @change="
              appSettings.set('scrollFollowPlayhead', ($event.target as HTMLInputElement).checked)
            "
          />
        </label>
        <label class="row">
          <span class="row-label">{{ t.settings.general.confirmDestructive }}</span>
          <input
            type="checkbox"
            :checked="appSettings.settings.confirmDestructive"
            @change="
              appSettings.set('confirmDestructive', ($event.target as HTMLInputElement).checked)
            "
          />
        </label>
        <div class="panel-actions">
          <button type="button" @click="appSettings.reset()">
            {{ t.settings.general.resetDefaults }}
          </button>
        </div>
      </div>

      <div
        v-else-if="activeTab === 'shortcuts'"
        id="settings-panel-shortcuts"
        class="panel"
        role="tabpanel"
        :aria-label="t.settings.tabs.shortcuts"
      >
        <p v-if="shortcuts.conflicts.value.length > 0" class="conflict-banner" role="alert">
          {{ t.settings.shortcuts.conflict }}
        </p>
        <div class="shortcut-filters">
          <input
            v-model="shortcutQuery"
            type="search"
            class="shortcut-search"
            :placeholder="t.settings.shortcuts.searchPlaceholder"
            :aria-label="t.settings.shortcuts.searchLabel"
          />
          <SelectMenu
            v-model="shortcutGroup"
            :options="shortcutGroupOptions"
            class="shortcut-group"
            :aria-label="t.settings.shortcuts.categoryLabel"
            size="sm"
          />
        </div>
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
            <tr v-if="visibleShortcuts.length === 0">
              <td class="shortcut-empty" colspan="5">{{ t.settings.shortcuts.noMatches }}</td>
            </tr>
            <tr
              v-for="action in visibleShortcuts"
              :key="action.id"
              :class="{ conflict: conflictActionIds.has(action.id) }"
              :data-action-id="action.id"
            >
              <td>{{ shortcutActionLabel(action) }}</td>
              <td class="group-cell">{{ shortcutGroupLabel(action.group) }}</td>
              <td class="scope-cell">{{ action.when }}</td>
              <td class="keys-cell">
                <span v-if="capturingId === action.id" class="capturing">
                  {{ t.settings.shortcuts.capturing }}
                </span>
                <span v-else>{{ keysText(action) }}</span>
              </td>
              <td class="edit-cell">
                <template v-if="action.customizable">
                  <button
                    type="button"
                    class="small"
                    :aria-label="
                      formatMessage(t.settings.shortcuts.changeKeys, {
                        action: shortcutActionLabel(action),
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
                        action: shortcutActionLabel(action),
                      })
                    "
                    @click="resetActionKeys(action.id)"
                  >
                    {{ t.settings.shortcuts.reset }}
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="panel-actions">
          <button type="button" @click="shortcuts.resetAll()">
            {{ t.settings.shortcuts.resetAll }}
          </button>
        </div>
      </div>

      <div
        v-else
        id="settings-panel-layouts"
        class="panel"
        role="tabpanel"
        :aria-label="t.settings.tabs.layouts"
      >
        <h3 class="panel-heading">{{ t.settings.layouts.presets }}</h3>
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
                {{ t.settings.layouts.apply }}
              </button>
            </span>
          </li>
        </ul>
        <h3 class="panel-heading">{{ t.settings.layouts.myLayouts }}</h3>
        <p v-if="namedLayouts.userLayouts.value.length === 0" class="layout-empty">
          {{ t.settings.layouts.noSaved }}
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
                {{ t.settings.layouts.apply }}
              </button>
              <button type="button" class="small" @click="renameLayout(layout.name)">
                {{ t.settings.layouts.rename }}
              </button>
              <button type="button" class="small" @click="deleteLayout(layout.name)">
                {{ t.settings.layouts.delete }}
              </button>
            </span>
          </li>
        </ul>
        <div class="layout-save">
          <input
            v-model="newLayoutName"
            type="text"
            :placeholder="t.settings.layouts.layoutNamePlaceholder"
            :aria-label="t.settings.layouts.newLayoutName"
            @keydown.enter.prevent="saveCurrentLayout"
          />
          <button
            type="button"
            :disabled="props.layoutBindings === null"
            @click="saveCurrentLayout"
          >
            {{ t.settings.layouts.saveCurrent }}
          </button>
        </div>
        <p v-if="layoutError !== ''" class="layout-error" role="alert">{{ layoutError }}</p>
      </div>

      <div class="dialog-actions">
        <button type="button" class="primary" @click="close">{{ t.settings.close }}</button>
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
  background: rgba(17, 24, 39, 0.28);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(38rem, calc(100vw - 2rem));
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

.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.tab {
  background: none;
  border: none;
  box-shadow: none;
  border-radius: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  font-size: var(--fs-sm);
  transition:
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.tab.active {
  color: var(--text-1);
  border-bottom-color: var(--accent);
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
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
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
  color: var(--text-2);
}

.row input[type='number'] {
  width: 4.5rem;
}

.row input {
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  padding: 0.15rem 0.3rem;
  box-shadow: var(--control-edge), var(--inset-well);
}

.row input:focus,
.row input:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.row-select {
  width: 10rem;
}

.shortcut-filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
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
  padding: 0.6rem 0.4rem;
}

.group-cell {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.shortcut-table {
  width: 100%;
  border-collapse: collapse;
}

.shortcut-table th {
  text-align: left;
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.4rem;
  border-bottom: 1px solid var(--border);
}

.shortcut-table td {
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid var(--surface-2);
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
  white-space: nowrap;
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
  border-bottom: 1px solid var(--surface-2);
}

.layout-name {
  font-weight: 600;
}

.layout-empty {
  margin: 0;
  color: var(--text-3);
}

.layout-save {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.3rem;
}

.layout-save input {
  flex: 1;
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  padding: 0.2rem 0.4rem;
  box-shadow: var(--control-edge), var(--inset-well);
}

.layout-save input:focus,
.layout-save input:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.layout-error {
  margin: 0;
  color: var(--danger-text);
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

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
