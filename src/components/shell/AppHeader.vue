<script setup lang="ts">
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
  exportSmf: [];
  exportSzd: [];
  helpMenuRef: [el: HTMLElement | null];
  importAudio: [];
  layoutMenuRef: [el: HTMLElement | null];
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
        Project ▾
      </button>
      <div v-if="projectMenuOpen" class="menu-pop" role="menu" aria-label="Project menu">
        <button type="button" role="menuitem" @click="emit('openNewDialog')">New…</button>
        <button
          type="button"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle('Open a saved project', 'project.open')"
          @click="emit('openOpenDialog')"
        >
          Open…
        </button>
        <button
          type="button"
          class="menu-save"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle('Save to browser storage', 'project.save')"
          @click="emit('saveProject')"
        >
          Save
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!opfsAvailable"
          :title="shortcutTitle('Save under a new name', 'project.saveAs')"
          @click="emit('saveProjectAs')"
        >
          Save As…
        </button>
        <template v-if="recentMenuNames.length > 0">
          <hr class="menu-rule" />
          <span class="menu-section">Recent</span>
          <button
            v-for="name in recentMenuNames"
            :key="name"
            type="button"
            role="menuitem"
            class="menu-recent"
            :disabled="!opfsAvailable"
            :title="`Open ${name}`"
            @click="emit('openRecentProject', name)"
          >
            {{ name }}
          </button>
        </template>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('importAudio')">Import audio…</button>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('exportSzd')">Export .szd</button>
        <button type="button" role="menuitem" @click="emit('exportSmf')">Export SMF</button>
        <button type="button" role="menuitem" @click="emit('openExportDialog')">
          Export Audio…
        </button>
        <button type="button" role="menuitem" @click="emit('exportDawproject')">
          Export DAWproject
        </button>
      </div>
    </div>
    <nav class="menu-bar" aria-label="Edit, view and transport menus">
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        title="Edit: undo, redo, selection, quantize"
        @click="emit('openMenuBar', 'edit', $event)"
      >
        Edit
      </button>
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        title="View: snap, score panel, editor tools"
        @click="emit('openMenuBar', 'view', $event)"
      >
        View
      </button>
      <button
        type="button"
        class="menu-trigger"
        aria-haspopup="menu"
        title="Transport: play, loop, record, navigation"
        @click="emit('openMenuBar', 'transport', $event)"
      >
        Transport
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
    <span class="project-name" :title="projectName">
      {{ projectName }}<span v-if="dirty" class="dirty-dot" title="Unsaved changes">•</span>
    </span>
    <span class="bar-spacer" />
    <button
      type="button"
      class="devices-toggle"
      :class="{ active: deviceRackOpen }"
      :aria-pressed="deviceRackOpen"
      title="Toggle the device rack panel"
      @click="emit('toggleDeviceRack')"
    >
      Devices
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
        title="Workspace layouts (presets and saved layouts)"
        @click="emit('updateLayoutMenuOpen', !layoutMenuOpen)"
      >
        Layout ▾
      </button>
      <div v-if="layoutMenuOpen" class="menu-pop" role="menu" aria-label="Layout menu">
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
          Save current…
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
        Help ▾
      </button>
      <div v-if="helpMenuOpen" class="menu-pop" role="menu" aria-label="Help menu">
        <button type="button" role="menuitem" @click="emit('openShortcutsHelp')">
          Keyboard shortcuts (?)
        </button>
        <button type="button" role="menuitem" @click="emit('openWelcomeTour')">Welcome tour</button>
        <hr class="menu-rule" />
        <button type="button" role="menuitem" @click="emit('openAbout')">
          About sonare studio
        </button>
      </div>
    </div>
    <button
      type="button"
      class="settings-button"
      aria-label="Settings"
      aria-haspopup="dialog"
      title="Settings (Cmd+,)"
      @click="emit('openSettings')"
    >
      ⚙
    </button>
    <span v-if="autosaveLastSavedAt" class="autosave-state">
      {{ formatSavedAt(autosaveLastSavedAt) }}
    </span>
  </header>
</template>

<style scoped src="@/ui/shell/app-header.css"></style>
