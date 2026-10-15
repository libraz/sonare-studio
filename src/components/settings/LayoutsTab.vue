<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { confirmDestructive, promptDialog } from '@/composables/useDialogs';
import { useLayouts } from '@/composables/useLayouts';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type LayoutBindings, localizedLayoutName } from '@/ui/settings/layouts';

/**
 * Named workspace layouts panel: applies built-in presets and saved layouts to
 * the shell's layout refs, and creates/renames/deletes user layouts. The shell
 * passes its layout refs via `layoutBindings`; when omitted, capture/apply are
 * disabled.
 */

const props = withDefaults(
  defineProps<{
    /** Shell layout refs (omit to disable capture/apply). */
    layoutBindings?: LayoutBindings | null;
  }>(),
  { layoutBindings: null },
);

const namedLayouts = useLayouts();
const { t } = useI18n();

const newLayoutName = ref('');
const layoutError = ref('');

const applyBlocked = computed(() =>
  firstBlock([props.layoutBindings === null, t.value.settings.layouts.reasons.noWorkspace]),
);
const saveBlocked = computed(() =>
  firstBlock(applyBlocked.value, [
    newLayoutName.value.trim() === '',
    t.value.settings.layouts.enterName,
  ]),
);

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
  void (async () => {
    if (
      !(await confirmDestructive({
        title: t.value.settings.layouts.deleteTitle,
        message: formatMessage(t.value.settings.layouts.deleteMessage, { name }),
        confirmLabel: t.value.common.delete,
      }))
    )
      return;
    namedLayouts.remove(name);
  })();
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
</script>

<template>
  <div
    id="settings-panel-layouts"
    class="panel"
    role="tabpanel"
    :aria-label="t.settings.tabs.layouts"
  >
    <section class="settings-section">
      <h3 class="settings-section__title">{{ t.settings.layouts.presets }}</h3>
      <div class="settings-group">
        <div
          v-for="layout in namedLayouts.presets"
          :key="layout.name"
          class="settings-row"
        >
          <span class="settings-row__label layout-name">
            {{ localizedLayoutName(layout.name, t.settings.layouts.presetNames) }}
          </span>
          <span class="settings-row__control">
            <button
              type="button"
              class="small"
              :disabled="!!applyBlocked"
              v-tooltip="{ reason: applyBlocked }"
              @click="applyLayout(layout.name)"
            >
              {{ t.common.apply }}
            </button>
          </span>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section__title">{{ t.settings.layouts.myLayouts }}</h3>
      <EmptyState
        v-if="namedLayouts.userLayouts.value.length === 0"
        variant="inline"
        :message="t.settings.layouts.noSaved"
      />
      <div v-else class="settings-group">
        <div
          v-for="layout in namedLayouts.userLayouts.value"
          :key="layout.name"
          class="settings-row"
        >
          <span class="settings-row__label layout-name">{{ layout.name }}</span>
          <span class="settings-row__control">
            <button
              type="button"
              class="small"
              :disabled="!!applyBlocked"
              v-tooltip="{ reason: applyBlocked }"
              @click="applyLayout(layout.name)"
            >
              {{ t.common.apply }}
            </button>
            <button type="button" class="small" @click="renameLayout(layout.name)">
              {{ t.settings.layouts.rename }}
            </button>
            <button type="button" class="small" @click="deleteLayout(layout.name)">
              {{ t.common.delete }}
            </button>
          </span>
        </div>
      </div>
    </section>

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
        :disabled="!!saveBlocked"
        v-tooltip="{ text: t.settings.layouts.saveCurrentTitle, reason: saveBlocked }"
        @click="saveCurrentLayout"
      >
        {{ t.settings.layouts.saveCurrent }}
      </button>
    </div>
    <p v-if="layoutError !== ''" class="layout-error view-enter" role="alert">{{ layoutError }}</p>
  </div>
</template>

<style scoped>
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

.layout-name {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout-save {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.1rem;
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
</style>
