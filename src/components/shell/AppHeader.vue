<script setup lang="ts">
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSavedAt } from '@/ui/shell/format';

type MenuBarId = 'edit' | 'view' | 'transport';

defineProps<{
  autosaveLastSavedAt: Date | null;
  deviceRackOpen: boolean;
  dirty: boolean;
  helpMenuOpen: boolean;
  layoutMenuOpen: boolean;
  layouts: readonly { name: string }[];
  opfsAvailable: boolean;
  projectMenuOpen: boolean;
  projectName: string;
  recentMenuNames: readonly string[];
  shortcutTitle: (base: string, actionId: string) => string;
}>();

const emit = defineEmits<{
  applyNamedLayout: [name: string];
  audioImportChange: [event: Event];
  audioImportInputRef: [el: HTMLInputElement | null];
  closeProjectMenu: [];
  exportDawproject: [];
  exportMidi2: [];
  exportSmf: [];
  exportSzd: [];
  helpMenuRef: [el: HTMLElement | null];
  importAudio: [];
  importMidi: [];
  layoutMenuRef: [el: HTMLElement | null];
  midiImportChange: [event: Event];
  midiImportInputRef: [el: HTMLInputElement | null];
  openAbout: [];
  openExportDialog: [];
  openMenuBar: [menu: MenuBarId, event: MouseEvent];
  openNewDialog: [];
  openOpenDialog: [];
  openRecentProject: [name: string];
  openShortcutsHelp: [];
  openWelcomeTour: [];
  projectMenuRef: [el: HTMLElement | null];
  saveCurrentLayout: [];
  saveProject: [];
  saveProjectAs: [];
  toggleDeviceRack: [];
  updateHelpMenuOpen: [open: boolean];
  updateLayoutMenuOpen: [open: boolean];
  updateProjectMenuOpen: [open: boolean];
  openSettings: [];
}>();

const { t } = useI18n();
</script>

<template>
  <header class="app-bar">
    <span class="app-title">sonare studio</span>
    <div
      :ref="(el) => emit('projectMenuRef', el as HTMLElement | null)"
      class="project-menu"
      @keydown.escape="emit('closeProjectMenu')"
    >
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :aria-expanded="projectMenuOpen"
        @click="emit('updateProjectMenuOpen', !projectMenuOpen)"
      >
        {{ t.shell.project.trigger }}
        <TransportIcon class="menu-chevron" name="chevron-down" />
      </button>
      <div
        v-if="projectMenuOpen"
        class="menu-pop"
        role="menu"
        :aria-label="t.shell.project.menuLabel"
      >
        <button type="button" role="menuitem" @click="emit('openNewDialog')">
          {{ t.shell.project.new }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle(t.shell.project.openTitle, 'project.open')"
          @click="emit('openOpenDialog')"
        >
          {{ t.shell.project.open }}
        </button>
        <button
          type="button"
          class="menu-save"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle(t.shell.project.saveTitle, 'project.save')"
          @click="emit('saveProject')"
        >
          {{ t.shell.project.save }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle(t.shell.project.saveAsTitle, 'project.saveAs')"
          @click="emit('saveProjectAs')"
        >
          {{ t.shell.project.saveAs }}
        </button>
        <template v-if="recentMenuNames.length > 0">
          <hr class="menu-rule" />
          <span class="menu-section">{{ t.shell.project.recent }}</span>
          <button
            v-for="name in recentMenuNames"
            :key="name"
            type="button"
            role="menuitem"
            class="menu-recent"
            :disabled="!opfsAvailable"
            :title="formatMessage(t.shell.project.openRecent, { name })"
            @click="emit('openRecentProject', name)"
          >
            {{ name }}
          </button>
        </template>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('importMidi')">
          {{ t.shell.project.importMidi }}
        </button>
        <button type="button" role="menuitem" @click="emit('importAudio')">
          {{ t.shell.project.importAudio }}
        </button>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('exportSzd')">
          {{ t.shell.project.exportSzd }}
        </button>
        <button type="button" role="menuitem" @click="emit('exportSmf')">
          {{ t.shell.project.exportSmf }}
        </button>
        <button type="button" role="menuitem" @click="emit('exportMidi2')">
          {{ t.shell.project.exportMidi2 }}
        </button>
        <button type="button" role="menuitem" @click="emit('openExportDialog')">
          {{ t.shell.project.exportAudio }}
        </button>
        <button type="button" role="menuitem" @click="emit('exportDawproject')">
          {{ t.shell.project.exportDawproject }}
        </button>
      </div>
    </div>
    <nav class="menu-bar" :aria-label="t.shell.menus.barLabel">
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :title="t.shell.menus.editTitle"
        @click="emit('openMenuBar', 'edit', $event)"
      >
        {{ t.shell.menus.edit }}
      </button>
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :title="t.shell.menus.viewTitle"
        @click="emit('openMenuBar', 'view', $event)"
      >
        {{ t.shell.menus.view }}
      </button>
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :title="t.shell.menus.transportTitle"
        @click="emit('openMenuBar', 'transport', $event)"
      >
        {{ t.shell.menus.transport }}
      </button>
    </nav>
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
    <span class="project-name" :title="projectName">
      {{ projectName }}
      <span
        v-if="dirty"
        class="dirty-dot"
        :title="t.shell.project.unsavedChanges"
        aria-hidden="true"
      ></span>
    </span>
    <span class="bar-spacer" />
    <button
      type="button"
      class="devices-toggle"
      :class="{ active: deviceRackOpen }"
      :aria-pressed="deviceRackOpen"
      :title="t.shell.devices.toggleTitle"
      @click="emit('toggleDeviceRack')"
    >
      {{ t.shell.devices.toggle }}
    </button>
    <div
      :ref="(el) => emit('layoutMenuRef', el as HTMLElement | null)"
      class="project-menu"
      @keydown.escape="emit('updateLayoutMenuOpen', false)"
    >
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :aria-expanded="layoutMenuOpen"
        :title="t.shell.layout.title"
        @click="emit('updateLayoutMenuOpen', !layoutMenuOpen)"
      >
        {{ t.shell.layout.trigger }}
        <TransportIcon class="menu-chevron" name="chevron-down" />
      </button>
      <div
        v-if="layoutMenuOpen"
        class="menu-pop"
        role="menu"
        :aria-label="t.shell.layout.menuLabel"
      >
        <button
          v-for="layout in layouts"
          :key="layout.name"
          type="button"
          role="menuitem"
          @click="emit('applyNamedLayout', layout.name)"
        >
          {{ layout.name }}
        </button>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('saveCurrentLayout')">
          {{ t.shell.layout.saveCurrent }}
        </button>
      </div>
    </div>
    <div
      :ref="(el) => emit('helpMenuRef', el as HTMLElement | null)"
      class="project-menu"
      @keydown.escape="emit('updateHelpMenuOpen', false)"
    >
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        :aria-expanded="helpMenuOpen"
        @click="emit('updateHelpMenuOpen', !helpMenuOpen)"
      >
        {{ t.shell.help.trigger }}
        <TransportIcon class="menu-chevron" name="chevron-down" />
      </button>
      <div v-if="helpMenuOpen" class="menu-pop" role="menu" :aria-label="t.shell.help.menuLabel">
        <button type="button" role="menuitem" @click="emit('openShortcutsHelp')">
          {{ t.shell.help.shortcuts }}
        </button>
        <button type="button" role="menuitem" @click="emit('openWelcomeTour')">
          {{ t.shell.help.welcomeTour }}
        </button>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('openAbout')">
          {{ t.shell.help.about }}
        </button>
      </div>
    </div>
    <button
      type="button"
      class="settings-button"
      :aria-label="t.shell.settingsButton.label"
      aria-haspopup="dialog"
      :title="t.shell.settingsButton.title"
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
