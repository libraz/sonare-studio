<script setup lang="ts">
import type { NoteNameSystem } from '@libraz/libcantus';
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { useI18n } from '@/ui/i18n';
import {
  type AppLanguage,
  type AppTheme,
  AUTOSAVE_INTERVAL_MAX_MS,
  AUTOSAVE_INTERVAL_MIN_MS,
  COUNT_IN_BARS_MAX,
  COUNT_IN_BARS_MIN,
  type ExplainLevel,
  LOUDNESS_TARGET_MAX_LUFS,
  LOUDNESS_TARGET_MIN_LUFS,
  type RecordingCaptureSource,
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

/**
 * Note-name choices. Independent of the language picker above: a Japanese UI
 * may still read C D E, and an English one ハ ニ ホ.
 */
const NOTE_NAME_SYSTEM_OPTIONS = computed<ReadonlyArray<{ value: NoteNameSystem; label: string }>>(
  () => [
    { value: 'english', label: t.value.settings.general.noteNameSystemEnglish },
    { value: 'german', label: t.value.settings.general.noteNameSystemGerman },
    { value: 'japanese', label: t.value.settings.general.noteNameSystemJapanese },
    { value: 'italian', label: t.value.settings.general.noteNameSystemItalian },
    { value: 'fixedDo', label: t.value.settings.general.noteNameSystemFixedDo },
  ],
);

const RECORDING_SOURCE_OPTIONS = computed<
  ReadonlyArray<{ value: RecordingCaptureSource; label: string }>
>(() => [
  { value: 'input', label: t.value.settings.general.recordingSourceInput },
  { value: 'output', label: t.value.settings.general.recordingSourceOutput },
]);

const EXPLAIN_LEVEL_OPTIONS = computed<ReadonlyArray<{ value: ExplainLevel; label: string }>>(
  () => [
    { value: 'beginner', label: t.value.theory.levelName.beginner },
    { value: 'normal', label: t.value.theory.levelName.normal },
    { value: 'theory', label: t.value.theory.levelName.theory },
  ],
);

function onEditorDensityChange(value: 'comfortable' | 'compact'): void {
  appSettings.set('editorDensity', value);
}

function resetDefaults(): void {
  void (async () => {
    if (
      appSettings.settings.confirmDestructive &&
      !(await confirmDialog({
        title: t.value.settings.general.resetTitle,
        message: t.value.settings.general.resetMessage,
        danger: true,
        confirmLabel: t.value.settings.general.resetDefaults,
      }))
    )
      return;
    appSettings.reset();
  })();
}

function onThemeChange(value: AppTheme): void {
  appSettings.set('theme', value);
}

function onLanguageChange(value: AppLanguage): void {
  appSettings.set('language', value);
}

function onNoteNameSystemChange(value: NoteNameSystem): void {
  appSettings.set('noteNameSystem', value);
}

function onRecordingSourceChange(value: RecordingCaptureSource): void {
  appSettings.set('recordingCaptureSource', value);
}

function onExplainLevelChange(value: ExplainLevel): void {
  appSettings.set('explainLevel', value);
}

const autosaveSeconds = computed<number>(() =>
  Math.round(appSettings.settings.autosaveIntervalMs / 1000),
);

function onAutosaveSecondsInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  appSettings.set('autosaveIntervalMs', value * 1000);
  input.value = String(autosaveSeconds.value);
}

function onCountInInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  appSettings.set('countInBars', value);
  input.value = String(appSettings.settings.countInBars);
}

function onLoudnessTargetInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  appSettings.set('loudnessTargetLufs', value);
  input.value = String(appSettings.settings.loudnessTargetLufs);
}
</script>

<template>
  <div
    id="settings-panel-general"
    class="panel"
    role="tabpanel"
    :aria-label="t.settings.tabs.general"
  >
    <section class="settings-section">
      <h3 class="settings-section__title">{{ t.settings.general.sectionAppearance }}</h3>
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.language }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.language"
              :options="LANGUAGE_OPTIONS"
              :aria-label="t.settings.general.language"
              size="sm"
              @change="onLanguageChange"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.noteNameSystem }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.noteNameSystem"
              :options="NOTE_NAME_SYSTEM_OPTIONS"
              :aria-label="t.settings.general.noteNameSystem"
              size="sm"
              @change="onNoteNameSystemChange"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.theme }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.theme"
              :options="THEME_OPTIONS"
              :aria-label="t.settings.general.theme"
              size="sm"
              @change="onThemeChange"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.editorDensity }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.editorDensity"
              :options="EDITOR_DENSITY_OPTIONS"
              :aria-label="t.settings.general.editorDensity"
              size="sm"
              @change="onEditorDensityChange"
            />
          </div>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">{{ t.settings.general.sectionEditing }}</h3>
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.snapDefault }}</span>
          <div class="settings-row__control">
            <ToggleButton
              :model-value="appSettings.settings.snapDefault"
              :label="
                appSettings.settings.snapDefault
                  ? t.settings.general.toggleOn
                  : t.settings.general.toggleOff
              "
              :aria-label="t.settings.general.snapDefault"
              size="sm"
              @update:model-value="appSettings.set('snapDefault', $event)"
            />
          </div>
        </div>
        <label class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.countInBars }}</span>
          <div class="settings-row__control">
            <input
              type="number"
              :min="COUNT_IN_BARS_MIN"
              :max="COUNT_IN_BARS_MAX"
              :value="appSettings.settings.countInBars"
              @change="onCountInInput"
            />
          </div>
        </label>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.scrollFollowPlayhead }}</span>
          <div class="settings-row__control">
            <ToggleButton
              :model-value="appSettings.settings.scrollFollowPlayhead"
              :label="
                appSettings.settings.scrollFollowPlayhead
                  ? t.settings.general.toggleOn
                  : t.settings.general.toggleOff
              "
              :aria-label="t.settings.general.scrollFollowPlayhead"
              size="sm"
              @update:model-value="appSettings.set('scrollFollowPlayhead', $event)"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.explainLevel }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.explainLevel"
              :options="EXPLAIN_LEVEL_OPTIONS"
              :aria-label="t.settings.general.explainLevel"
              size="sm"
              @change="onExplainLevelChange"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.confirmDestructive }}</span>
          <div class="settings-row__control">
            <ToggleButton
              :model-value="appSettings.settings.confirmDestructive"
              :label="
                appSettings.settings.confirmDestructive
                  ? t.settings.general.toggleOn
                  : t.settings.general.toggleOff
              "
              :aria-label="t.settings.general.confirmDestructive"
              size="sm"
              @update:model-value="appSettings.set('confirmDestructive', $event)"
            />
          </div>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">{{ t.settings.general.sectionRecording }}</h3>
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.monitorDefault }}</span>
          <div class="settings-row__control">
            <ToggleButton
              :model-value="appSettings.settings.monitorDefault"
              :label="
                appSettings.settings.monitorDefault
                  ? t.settings.general.toggleOn
                  : t.settings.general.toggleOff
              "
              :aria-label="t.settings.general.monitorDefault"
              size="sm"
              @update:model-value="appSettings.set('monitorDefault', $event)"
            />
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.recordingSource }}</span>
          <div class="settings-row__control">
            <SelectMenu
              class="row-select"
              :model-value="appSettings.settings.recordingCaptureSource"
              :options="RECORDING_SOURCE_OPTIONS"
              :aria-label="t.settings.general.recordingSource"
              size="sm"
              @change="onRecordingSourceChange"
            />
          </div>
        </div>
        <label class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.autosaveInterval }}</span>
          <div class="settings-row__control">
            <input
              type="number"
              :min="AUTOSAVE_INTERVAL_MIN_MS / 1000"
              :max="AUTOSAVE_INTERVAL_MAX_MS / 1000"
              :value="autosaveSeconds"
              @change="onAutosaveSecondsInput"
            />
          </div>
        </label>
        <label class="settings-row">
          <span class="settings-row__label">{{ t.settings.general.loudnessTarget }}</span>
          <div class="settings-row__control">
            <input
              type="number"
              :min="LOUDNESS_TARGET_MIN_LUFS"
              :max="LOUDNESS_TARGET_MAX_LUFS"
              :value="appSettings.settings.loudnessTargetLufs"
              @change="onLoudnessTargetInput"
            />
          </div>
        </label>
      </div>
    </section>

    <div class="panel-actions">
      <button type="button" @click="resetDefaults">
        {{ t.settings.general.resetDefaults }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Layout comes from the shared grouped-list pattern in settings-group.css; only
 * the control metrics are tuned here. */
.settings-row input[type='number'] {
  width: 4.5rem;
}

/* Tighter radius than the controls.css input baseline; face/focus inherited. */
.settings-row input {
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.3rem;
}

.row-select {
  width: 10rem;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--sp-2);
}
</style>
