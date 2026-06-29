<script setup lang="ts">
import MenuBar from '@/components/shell/MenuBar.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';
import { formatSavedAt } from '@/ui/shell/format';

defineProps<{
  autosaveLastSavedAt: Date | null;
  deviceRackOpen: boolean;
  dirty: boolean;
  layoutMenu: MenuBarMenu;
  menus: readonly MenuBarMenu[];
  projectName: string;
}>();

const emit = defineEmits<{
  audioImportChange: [event: Event];
  audioImportInputRef: [el: HTMLInputElement | null];
  midiImportChange: [event: Event];
  midiImportInputRef: [el: HTMLInputElement | null];
  openSettings: [];
  toggleDeviceRack: [];
}>();

const { t } = useI18n();
</script>

<template>
  <header class="app-bar">
    <span class="app-title">sonare studio</span>

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
        class="dirty-dot"
        v-tooltip="t.shell.project.unsavedChanges"
        aria-hidden="true"
      ></span>
    </span>

    <span class="bar-spacer" />

    <button
      type="button"
      class="devices-toggle"
      :class="{ active: deviceRackOpen }"
      :aria-pressed="deviceRackOpen"
      v-tooltip="t.shell.devices.toggleTitle"
      @click="emit('toggleDeviceRack')"
    >
      {{ t.shell.devices.toggle }}
    </button>

    <MenuBar :menus="[layoutMenu]" align="end" chevron :aria-label="layoutMenu.label" />

    <button
      type="button"
      class="settings-button"
      :aria-label="t.shell.settingsButton.label"
      aria-haspopup="dialog"
      v-tooltip="t.shell.settingsButton.title"
      @click="emit('openSettings')"
    >
      <TransportIcon name="settings" />
    </button>

    <span v-if="autosaveLastSavedAt" class="autosave-state">
      {{ formatMessage(t.shell.savedAt, { time: formatSavedAt(autosaveLastSavedAt) }) }}
    </span>
  </header>
</template>

<style scoped src="@/ui/shell/app-header.css"></style>
