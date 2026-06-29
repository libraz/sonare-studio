<script setup lang="ts">
import MenuBar from '@/components/shell/MenuBar.vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { MenuBarMenu } from '@/ui/menu/menu-bar';
import type { ResolvedAppTheme } from '@/ui/settings/app-settings';
import { formatSavedAt } from '@/ui/shell/format';

defineProps<{
  autosaveLastSavedAt: Date | null;
  deviceRackOpen: boolean;
  dirty: boolean;
  menus: readonly MenuBarMenu[];
  projectName: string;
  resolvedTheme: ResolvedAppTheme;
}>();

const emit = defineEmits<{
  audioImportChange: [event: Event];
  audioImportInputRef: [el: HTMLInputElement | null];
  midiImportChange: [event: Event];
  midiImportInputRef: [el: HTMLInputElement | null];
  toggleTheme: [];
  toggleDeviceRack: [];
}>();

const { t } = useI18n();
</script>

<template>
  <header class="app-bar">
    <span class="app-title">
      <span class="app-title-mark">sonare</span>
      <span class="app-title-sub">studio</span>
    </span>

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

    <span v-if="autosaveLastSavedAt" class="autosave-state">
      {{ formatMessage(t.shell.savedAt, { time: formatSavedAt(autosaveLastSavedAt) }) }}
    </span>

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
      <TransportIcon :name="resolvedTheme === 'dark' ? 'sun' : 'moon'" />
    </button>
  </header>
</template>

<style scoped src="@/ui/shell/app-header.css"></style>
