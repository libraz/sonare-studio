<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useI18n } from '@/ui/i18n';
import {
  type AppLanguage,
  type AppTheme,
  AUTOSAVE_INTERVAL_MAX_MS,
  AUTOSAVE_INTERVAL_MIN_MS,
  COUNT_IN_BARS_MAX,
  COUNT_IN_BARS_MIN,
  LOUDNESS_TARGET_MAX_LUFS,
  LOUDNESS_TARGET_MIN_LUFS,
} from '@/ui/settings/app-settings';

/**
 * General preferences panel: language, theme, editor density and the numeric
 * defaults (snap, count-in, monitor, autosave, loudness, scroll-follow,
 * destructive confirmation). All values are read from and written to the
 * shared app-settings store.
 */

const appSettings = useAppSettings();
const { t } = useI18n();

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

function onLoudnessTargetInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  appSettings.set('loudnessTargetLufs', value);
}
</script>

<template>
  <div
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
      <span class="row-label">{{ t.settings.general.loudnessTarget }}</span>
      <input
        type="number"
        :min="LOUDNESS_TARGET_MIN_LUFS"
        :max="LOUDNESS_TARGET_MAX_LUFS"
        :value="appSettings.settings.loudnessTargetLufs"
        @change="onLoudnessTargetInput"
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
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
}

.row-label {
  color: var(--text-2);
}

.row input[type='number'] {
  width: 4.5rem;
}

/* Tighter radius than the controls.css input baseline; face/focus inherited. */
.row input {
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.3rem;
}

.row-select {
  width: 10rem;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.3rem;
}
</style>
