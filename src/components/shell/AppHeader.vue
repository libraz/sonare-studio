<script setup lang="ts">
import BrandMark from '@/components/shell/BrandMark.vue';
import MenuBar from '@/components/shell/MenuBar.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';
import type { ResolvedAppTheme } from '@/ui/settings/app-settings';
import { formatTimestamp } from '@/ui/shell/format';

defineProps<{
  autosaveLastSavedAt: Date | null;
  /** An app-level action is in flight; shows the hairline progress along the bar. */
  busy?: boolean;
  canRedo: boolean;
  canUndo: boolean;
  canInstallPwa: boolean;
  deviceRackOpen: boolean;
  dirty: boolean;
  layoutMenu?: MenuBarMenu | null;
  menus: readonly MenuBarMenu[];
  projectName: string;
  resolvedTheme: ResolvedAppTheme;
}>();

const emit = defineEmits<{
  audioImportChange: [event: Event];
  audioImportInputRef: [el: HTMLInputElement | null];
  stemImportChange: [event: Event];
  stemImportInputRef: [el: HTMLInputElement | null];
  midiImportChange: [event: Event];
  midiImportInputRef: [el: HTMLInputElement | null];
  installPwa: [];
  redo: [];
  toggleTheme: [];
  toggleDeviceRack: [];
  undo: [];
}>();

const { locale, t } = useI18n();
</script>

<template>
  <header class="app-bar">
    <BrandMark class="app-title" size="sm" />

    <MenuBar :menus="menus" :aria-label="t.shell.menus.barLabel" />

    <input
      :ref="(el) => emit('audioImportInputRef', el as HTMLInputElement | null)"
      class="hidden-file-input"
      type="file"
      multiple
      accept="audio/*"
      aria-hidden="true"
      tabindex="-1"
      @change="emit('audioImportChange', $event)"
    />
    <input
      :ref="(el) => emit('stemImportInputRef', el as HTMLInputElement | null)"
      class="hidden-file-input"
      type="file"
      multiple
      accept="audio/*"
      aria-hidden="true"
      tabindex="-1"
      @change="emit('stemImportChange', $event)"
    />
    <input
      :ref="(el) => emit('midiImportInputRef', el as HTMLInputElement | null)"
      class="hidden-file-input"
      type="file"
      accept=".mid,.midi,audio/midi,audio/x-midi"
      aria-hidden="true"
      tabindex="-1"
      @change="emit('midiImportChange', $event)"
    />

    <span class="project-name" v-tooltip="projectName">
      {{ projectName }}
      <span
        v-if="dirty"
        class="dirty-dot animate-pop"
        v-tooltip="t.shell.project.unsavedChanges"
        aria-hidden="true"
      ></span>
    </span>

    <span class="bar-spacer" />

    <MenuBar
      v-if="layoutMenu"
      :menus="[layoutMenu]"
      :aria-label="t.shell.layout.menuLabel"
      align="end"
      chevron
    />

    <div class="history-tools" :aria-label="t.shell.menus.edit">
      <button
        type="button"
        class="header-tool icon-tool undo-toggle"
        :aria-label="t.shortcuts.actions['edit.undo']"
        :disabled="!canUndo"
        v-tooltip="t.shortcuts.actions['edit.undo']"
        @click="emit('undo')"
      >
        <TransportIcon name="undo" />
      </button>
      <button
        type="button"
        class="header-tool icon-tool redo-toggle"
        :aria-label="t.shortcuts.actions['edit.redo']"
        :disabled="!canRedo"
        v-tooltip="t.shortcuts.actions['edit.redo']"
        @click="emit('redo')"
      >
        <TransportIcon name="redo" />
      </button>
    </div>

    <span
      v-if="autosaveLastSavedAt"
      :key="autosaveLastSavedAt.getTime()"
      class="autosave-state"
    >
      {{
        formatMessage(t.shell.savedAt, {
          time: formatTimestamp(autosaveLastSavedAt, locale, 'time'),
        })
      }}
    </span>

    <button
      v-if="canInstallPwa"
      type="button"
      class="header-tool install-toggle"
      :aria-label="t.shell.installPwa"
      v-tooltip="t.shell.installPwa"
      @click="emit('installPwa')"
    >
      {{ t.shell.installPwa }}
    </button>

    <button
      type="button"
      class="header-tool devices-toggle"
      :class="{ active: deviceRackOpen }"
      :aria-label="t.shell.devices.toggleTitle"
      :aria-pressed="deviceRackOpen"
      v-tooltip="t.shell.devices.toggleTitle"
      @click="emit('toggleDeviceRack')"
    >
      <TransportIcon name="panel-right" />
      <span>{{ t.shell.devices.toggle }}</span>
    </button>

    <button
      type="button"
      class="header-tool theme-toggle"
      :aria-label="
        resolvedTheme === 'dark' ? t.shell.theme.switchToLight : t.shell.theme.switchToDark
      "
      v-tooltip="
        resolvedTheme === 'dark' ? t.shell.theme.switchToLight : t.shell.theme.switchToDark
      "
      @click="emit('toggleTheme')"
    >
      <TransportIcon
        :key="resolvedTheme"
        class="theme-icon"
        :name="resolvedTheme === 'dark' ? 'sun' : 'moon'"
      />
    </button>

    <Transition name="fade">
      <div v-if="busy" class="header-busy progress-indeterminate" aria-hidden="true" />
    </Transition>
  </header>
</template>

<style scoped src="@/ui/shell/app-header.css"></style>
