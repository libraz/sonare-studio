<script setup lang="ts">
import { computed, provide, ref, shallowRef, watch } from 'vue';
import ArrangementView from '@/components/arrangement/ArrangementView.vue';
import ClipInspector from '@/components/arrangement/ClipInspector.vue';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import ExportDialog from '@/components/export/ExportDialog.vue';
import { formatBarBeatTick } from '@/components/lists/bar-beat';
import ProjectListsPanel from '@/components/lists/ProjectListsPanel.vue';
import MasteringPanel from '@/components/mastering/MasteringPanel.vue';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import HintCard from '@/components/onboarding/HintCard.vue';
import WelcomeTour from '@/components/onboarding/WelcomeTour.vue';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollEditor from '@/components/piano-roll/PianoRollEditor.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import OpenProjectDialog from '@/components/project/OpenProjectDialog.vue';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import ShortcutsHelp from '@/components/settings/ShortcutsHelp.vue';
import AboutDialog from '@/components/shell/AboutDialog.vue';
import AppHeader from '@/components/shell/AppHeader.vue';
import ContextMenu from '@/components/shell/ContextMenu.vue';
import DiagnosticsPanel from '@/components/shell/DiagnosticsPanel.vue';
import DialogHost from '@/components/shell/DialogHost.vue';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToolPalette from '@/components/shell/ToolPalette.vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { useActionGuards } from '@/composables/useActionGuards';
import { useAppLifecycle } from '@/composables/useAppLifecycle';
import { useAppSettings } from '@/composables/useAppSettings';
import { useAppShellLayout } from '@/composables/useAppShellLayout';
import { useAppShortcutsMenu } from '@/composables/useAppShortcutsMenu';
import { useAutosave } from '@/composables/useAutosave';
import { useEditorTool } from '@/composables/useEditorTool';
import { useEngineLifecycle } from '@/composables/useEngineLifecycle';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import { useFileDownloads } from '@/composables/useFileDownloads';
import { useInputControls } from '@/composables/useInputControls';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import { useNotePreview } from '@/composables/useNotePreview';
import { useOutsidePopovers } from '@/composables/useOutsidePopovers';
import { useProjectAudioAssets } from '@/composables/useProjectAudioAssets';
import { useProjectExport } from '@/composables/useProjectExport';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { useRecording } from '@/composables/useRecording';
import { useRecordingControls } from '@/composables/useRecordingControls';
import { useShellPanels } from '@/composables/useShellPanels';
import { useShortcuts } from '@/composables/useShortcuts';
import { useStepInput } from '@/composables/useStepInput';
import { useTransport } from '@/composables/useTransport';
import { useTransportControls } from '@/composables/useTransportControls';
import type { AnalyserBridge } from '@/engine/analyser';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import type { ScopeBridge } from '@/engine/scope';
import { ensureWasm } from '@/lib/wasm';
import { quantizeSelection } from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { isAudioClip } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { disengageAutomationWriteModes } from '@/ui/mixer/automation-mode';
import { COUNT_IN_CHOICES, SNAP_CHOICES, TOUR_STEPS } from '@/ui/shell/app-shell-options';
import { installSonareDevDebug } from '@/ui/shell/dev-debug';

/**
 * Single-window app shell: a transport bar with the project menu on top, the
 * arrangement view (track headers + clip timeline) in the middle, and the
 * editor dock (piano roll / lists tabs) below, separated by a draggable
 * divider. Edits are bounced to the engine per clip via the prerender loop.
 */

const version = ref('…');
const isolated = ref(globalThis.crossOriginIsolated === true);
const errorMessage = ref('');
const busy = ref(false);

/** Plain (non-reactive) engine objects; the meter bridge must not be wrapped in reactive(). */
const handle = shallowRef<EngineHandle | null>(null);
const bridge = shallowRef<MeterBridge | null>(null);
const analyser = shallowRef<AnalyserBridge | null>(null);
const scope = shallowRef<ScopeBridge | null>(null);

const transport = useTransport(() => handle.value);
const {
  isPlaying,
  positionSeconds,
  positionPpq,
  tempo,
  loopEnabled,
  loopStartPpq,
  loopEndPpq,
  metronomeEnabled,
} = transport;

const renderInfo = ref('');
const ctxState = ref('');

/** Genuine audio-engine status once running: sample rate and transport mode. */
const store = useProjectStore();
const stepInput = useStepInput();

// --- User preferences ----------------------------------------------------------

const appSettings = useAppSettings();
const { t } = useI18n();
const shortcuts = useShortcuts();
const { tool: editorTool, setTool: setEditorTool } = useEditorTool();
const applyStateText = computed(() => {
  if (!handle.value) return t.value.shell.editor.engineOff;
  if (applyPending.value) return t.value.shell.editor.pending;
  return formatMessage(t.value.shell.editor.clipCount, { count: String(scheduledCount.value) });
});
const localizedTourSteps = computed(() =>
  TOUR_STEPS.map((step) => {
    const copy = { ...step };
    const translated = t.value.shell.tour.steps[step.id as keyof typeof t.value.shell.tour.steps];
    return translated ? { ...copy, title: translated.title, body: translated.body } : copy;
  }),
);

// Editor-only boot defaults sourced from the user preferences.
store.snapEnabled = appSettings.settings.snapDefault;

// The autosave quiet period follows the preference live (read per schedule).
const autosave = useAutosave({ intervalMs: () => appSettings.settings.autosaveIntervalMs });

// Surface a failed background autosave: the user's recent edits are not on
// disk, so warn them to save manually rather than failing silently.
watch(autosave.lastError, (error) => {
  if (error) errorMessage.value = t.value.shell.autosaveFailed;
});
const { downloadBlobFile, lastDownload } = useFileDownloads();

const { confirmAction, runAction } = useActionGuards({ appSettings, busy, errorMessage });

// --- Recording -----------------------------------------------------------------

const recording = useRecording(() => handle.value, transport);
const { armedTrackIds, recordMenuOpen, recordMenuRoot, onArmTrack, onCountInChange, toggleRecord } =
  useRecordingControls({ appSettings, errorMessage, recording });

let bootPromise: Promise<void> | null = null;

// --- Project menu / persistence -------------------------------------------------

const {
  dirty,
  opfsAvailable,
  projectMenuOpen,
  projectMenuRoot,
  midiImportInput,
  newDialogOpen,
  openDialogOpen,
  storedProjects,
  recentMenuNames,
  openDialogRef,
  bootProject,
  markClean,
  closeProjectMenu,
  onOpenDialogKeydown,
  openNewDialog,
  onCreateProject,
  openOpenDialog,
  openStoredProject,
  openRecentProject,
  deleteStoredProject,
  importSzdFile,
  importMidiAction,
  onMidiImportChange,
  saveProjectAction,
  saveProjectAsAction,
  exportSzdAction,
  exportSmfAction,
  exportMidi2Action,
  disposeProjectPersistence,
} = useProjectPersistence({
  autosave,
  confirmAction,
  downloadBlobFile,
  errorMessage,
  runAction,
});

// --- Audio export / DAWproject ---------------------------------------------------

const { exportDialogOpen, exportLoopRegion, exportDawprojectAction, openExportDialog } =
  useProjectExport({
    closeProjectMenu,
    downloadBlobFile,
    loopEnabled,
    loopEndPpq,
    loopStartPpq,
    runAction,
  });

// --- Audio assets in the project ------------------------------------------------

const {
  audioImportInput,
  sampleAssetId,
  importAudioAction,
  onAddAssetToProject,
  onApplyAsset,
  onAssetCreated,
  onAudioImportChange,
  onRedetectClipTempo,
  placeAssetAtPlayhead,
} = useProjectAudioAssets({
  closeProjectMenu,
  positionPpq,
  renderInfo,
  runAction,
});

// --- Edit-to-sound loop (prerender bounce) ----------------------------------

const {
  applyPending,
  scheduledCount,
  applyNow,
  applyToEngine,
  disposeEngineProjectSync,
  effectiveTempoSegments,
  hasMidiSync,
  scheduleApply,
  scheduledClips,
  setEngineSyncHandles,
  syncAutomationState,
  syncMidiState,
  syncMixerState,
  syncTransportState,
  trackMeterSource,
  busMeterSource,
  masterScopeSource,
  trackScopeSource,
  busScopeSource,
  automationSync,
  midiSync,
  mixerLaneTrackIds,
} = useEngineProjectSync({ bridge, scope, errorMessage, handle, transport });

const { ensureEngineStarted, playTestTone, renderOffline, startEngine } = useEngineLifecycle({
  bridge,
  analyser,
  scope,
  ctxState,
  errorMessage,
  handle,
  renderInfo,
  transport,
  applyToEngine,
  bootPromise: () => bootPromise,
  runAction,
  setEngineSyncHandles,
  syncAutomationState,
  syncMidiState,
  syncMixerState,
  syncTransportState,
});

// --- Live note preview -------------------------------------------------------

const { auditionNote, previewNote, previewNoteOn, previewNoteOff } = useNotePreview({
  errorMessage,
  handle,
  hasMidiSync,
  ensureEngineStarted,
});

// --- Music typing / step input / Web MIDI ------------------------------------

const {
  midiInputChoices,
  midiInputSelection,
  midiLearn,
  midiLearnOpen,
  musicTyping,
  webMidi,
  connectWebMidi,
  toggleMusicTyping,
  toggleStepInput,
} = useInputControls({
  errorMessage,
  positionPpq,
  stepInput,
  ensureWasm,
  previewNote,
  previewNoteOn,
  previewNoteOff,
  runAction,
});

// Share the single learn handle so insert-knob menus can bind CC too.
provide(MIDI_LEARN_KEY, midiLearn);

// --- Transport bar -----------------------------------------------------------

const {
  autoPunchEnabled,
  applyTempo,
  bbtDisplay,
  bbtDraft,
  bbtEditing,
  hasLocatorWindow,
  nudgeByBar,
  onBbtCommit,
  onBbtFocus,
  onSeek,
  seekToEnd,
  seekToStart,
  setLeftLocator,
  setRightLocator,
  startPlayback,
  stopPlayback,
  tempoInput,
  toggleAutoPunch,
  toggleLoop,
  togglePlayback,
} = useTransportControls({
  errorMessage,
  handle,
  isPlaying,
  loopEnabled,
  loopEndPpq,
  loopStartPpq,
  positionPpq,
  recording,
  tempo,
  transport,
  ensureEngineStarted,
  onStopped: disengageAutomationWriteModes,
  scheduleApply,
  syncTransportState,
});

// --- Layout: arrangement/editor split ------------------------------------------

const {
  arrangeHeight,
  deviceRackOpen,
  dockTab,
  dockCollapsed,
  arrangeHeightMin,
  arrangeHeightMax,
  scoreVisible,
  scoreHeight,
  scoreResized,
  scoreHeightMin,
  layoutBindings,
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
  onDividerKeydown,
  onScoreDividerPointerDown,
  onScoreDividerPointerMove,
  onScoreDividerPointerUp,
  onScoreDividerKeydown,
  persistArrangeHeight,
  persistDeviceRackOpen,
  persistDockCollapsed,
  disposeLayout,
  toggleDeviceRack,
  toggleDockCollapsed,
  selectDockTab,
  toggleScorePanel,
} = useAppShellLayout();

// --- Settings, shortcut help, named layouts, welcome tour -----------------------

const {
  aboutOpen,
  helpMenuOpen,
  helpMenuRoot,
  helpOpen,
  layoutMenuOpen,
  layoutMenuRoot,
  namedLayouts,
  settingsOpen,
  tourRef,
  applyNamedLayout,
  openAbout,
  openShortcutsHelp,
  openWelcomeTour,
  saveCurrentLayoutAction,
} = useShellPanels({
  errorMessage,
  layoutBindings,
  persistArrangeHeight,
  persistDeviceRackOpen,
  persistDockCollapsed,
});

const { onWindowPointerDown } = useOutsidePopovers([
  { open: projectMenuOpen, root: projectMenuRoot, close: closeProjectMenu },
  { open: recordMenuOpen, root: recordMenuRoot, close: () => (recordMenuOpen.value = false) },
  { open: layoutMenuOpen, root: layoutMenuRoot, close: () => (layoutMenuOpen.value = false) },
  { open: helpMenuOpen, root: helpMenuRoot, close: () => (helpMenuOpen.value = false) },
]);

// --- App-level keyboard shortcuts ---------------------------------------------

const { arrangementRef, focusZone, onGlobalKeyDown, openMenuBar, shortcutTitle } =
  useAppShortcutsMenu({
    editorTool,
    handle,
    helpOpen,
    isPlaying,
    loopEnabled,
    opfsAvailable,
    recording,
    scoreVisible,
    settingsOpen,
    shortcuts,
    nudgeByBar,
    openOpenDialog,
    saveProjectAction,
    saveProjectAsAction,
    seekToEnd,
    seekToStart,
    setEditorTool,
    setLeftLocator,
    setRightLocator,
    toggleLoop,
    togglePlayback,
    toggleRecord,
    toggleScorePanel,
  });

// --- Lifecycle ----------------------------------------------------------------

if (import.meta.env.DEV) {
  installSonareDevDebug({
    store,
    recording,
    transport,
    handle,
    bridge,
    applyPending,
    errorMessage,
    positionPpq,
    lastDownload,
    scheduledClips,
    midiSync,
    automationSync,
    trackMeterSource,
  });
}

useAppLifecycle({
  bridge,
  analyser,
  scope,
  errorMessage,
  handle,
  version,
  bootProject,
  disposeEngineProjectSync,
  disposeLayout,
  disposeProjectPersistence,
  onGlobalKeyDown,
  onWindowPointerDown,
  setBootPromise: (promise) => {
    bootPromise = promise;
  },
});
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :autosave-last-saved-at="autosave.lastSavedAt.value"
      :device-rack-open="deviceRackOpen"
      :dirty="dirty"
      :help-menu-open="helpMenuOpen"
      :layout-menu-open="layoutMenuOpen"
      :layouts="namedLayouts.layouts.value"
      :opfs-available="opfsAvailable"
      :project-menu-open="projectMenuOpen"
      :project-name="store.projectName"
      :recent-menu-names="recentMenuNames"
      :shortcut-title="shortcutTitle"
      @apply-named-layout="applyNamedLayout"
      @audio-import-change="onAudioImportChange"
      @audio-import-input-ref="(el) => (audioImportInput = el)"
      @close-project-menu="closeProjectMenu"
      @export-dawproject="exportDawprojectAction"
      @export-midi2="exportMidi2Action"
      @export-smf="exportSmfAction"
      @export-szd="exportSzdAction"
      @help-menu-ref="(el) => (helpMenuRoot = el)"
      @import-audio="importAudioAction"
      @import-midi="importMidiAction"
      @layout-menu-ref="(el) => (layoutMenuRoot = el)"
      @midi-import-change="onMidiImportChange"
      @midi-import-input-ref="(el) => (midiImportInput = el)"
      @open-about="openAbout"
      @open-export-dialog="openExportDialog"
      @open-menu-bar="openMenuBar"
      @open-new-dialog="openNewDialog"
      @open-open-dialog="openOpenDialog"
      @open-recent-project="openRecentProject"
      @open-settings="settingsOpen = true"
      @open-shortcuts-help="openShortcutsHelp"
      @open-welcome-tour="openWelcomeTour"
      @project-menu-ref="(el) => (projectMenuRoot = el)"
      @save-current-layout="saveCurrentLayoutAction"
      @save-project="saveProjectAction"
      @save-project-as="saveProjectAsAction"
      @toggle-device-rack="toggleDeviceRack"
      @update-help-menu-open="(open) => (helpMenuOpen = open)"
      @update-layout-menu-open="(open) => (layoutMenuOpen = open)"
      @update-project-menu-open="(open) => (projectMenuOpen = open)"
    />

    <p v-if="errorMessage" class="error-box" role="alert">{{ errorMessage }}</p>

    <main class="main-row">
      <div class="workspace">
      <section
        class="arrange-zone"
        :class="{ 'arrange-grow': dockCollapsed }"
        :style="dockCollapsed ? undefined : { flexBasis: `${arrangeHeight}px` }"
        @pointerdown.capture="focusZone = 'arrange'"
      >
        <ArrangementView
          ref="arrangementRef"
          :position-ppq="() => positionPpq"
          :loop-enabled="loopEnabled"
          :loop-start-ppq="loopStartPpq"
          :loop-end-ppq="loopEndPpq"
          :armed-track-ids="armedTrackIds"
          @seek="onSeek"
          @arm="onArmTrack"
        />
        <ClipInspector :clip="store.activeClip" @redetect-tempo="onRedetectClipTempo" />
      </section>

      <div
        v-if="!dockCollapsed"
        class="split-divider"
        role="separator"
        aria-orientation="horizontal"
        :aria-label="t.shell.editor.resizeArrangement"
        :aria-valuenow="Math.round(arrangeHeight)"
        :aria-valuemin="arrangeHeightMin"
        :aria-valuemax="arrangeHeightMax"
        tabindex="0"
        :title="t.shell.editor.resizeArrangementTitle"
        @pointerdown="onDividerPointerDown"
        @pointermove="onDividerPointerMove"
        @pointerup="onDividerPointerUp"
        @pointercancel="onDividerPointerUp"
        @keydown="onDividerKeydown"
      />

      <section
        class="editor-dock"
        :class="{ collapsed: dockCollapsed }"
        @pointerdown.capture="focusZone = 'editor'"
      >
        <div class="dock-tabs" role="tablist" :aria-label="t.shell.editor.panels">
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'roll' }"
            role="tab"
            :aria-selected="dockTab === 'roll'"
            @click="selectDockTab('roll')"
          >
            {{ t.shell.editor.tabs.pianoRoll }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'mixer' }"
            role="tab"
            :aria-selected="dockTab === 'mixer'"
            @click="selectDockTab('mixer')"
          >
            {{ t.shell.editor.tabs.mixer }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'mastering' }"
            role="tab"
            :aria-selected="dockTab === 'mastering'"
            @click="selectDockTab('mastering')"
          >
            {{ t.shell.editor.tabs.mastering }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'steps' }"
            role="tab"
            :aria-selected="dockTab === 'steps'"
            @click="selectDockTab('steps')"
          >
            {{ t.shell.editor.tabs.steps }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'lists' }"
            role="tab"
            :aria-selected="dockTab === 'lists'"
            @click="selectDockTab('lists')"
          >
            {{ t.shell.editor.tabs.lists }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'media' }"
            role="tab"
            :aria-selected="dockTab === 'media'"
            @click="selectDockTab('media')"
          >
            {{ t.shell.editor.tabs.media }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'sample' }"
            role="tab"
            :aria-selected="dockTab === 'sample'"
            @click="selectDockTab('sample')"
          >
            {{ t.shell.editor.tabs.sample }}
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle dock-tab-score"
            :class="{ active: scoreVisible }"
            :aria-pressed="scoreVisible"
            :title="t.shell.editor.toggleScoreTitle"
            @click="toggleScorePanel"
          >
            {{ t.shell.editor.tabs.score }}
          </button>
          <span class="dock-tabs-spacer" />
          <ToolPalette />
          <button
            type="button"
            class="dock-collapse"
            :aria-pressed="dockCollapsed"
            :title="dockCollapsed ? t.shell.editor.expandDock : t.shell.editor.collapseDock"
            :aria-label="t.shell.editor.toggleDock"
            @click="toggleDockCollapsed"
          >
            {{ dockCollapsed ? '▴' : '▾' }}
          </button>
        </div>
        <section v-show="dockTab === 'roll'" class="dock-body">
          <div class="editor-toolbar">
            <div class="editor-toolbar-scroll">
              <label class="bar-field">
                {{ t.shell.editor.snap }}
                <SelectMenu
                  v-model="store.snapDivision"
                  :options="SNAP_CHOICES"
                  size="sm"
                  :aria-label="t.shell.editor.snap"
                />
              </label>
            <label class="bar-field" :title="t.shell.editor.snapToggleTitle">
              <input v-model="store.snapEnabled" type="checkbox" />
              {{ t.shell.editor.snapOn }}
            </label>
            <button
              type="button"
              :disabled="store.selection.size === 0"
              :title="t.shell.editor.quantizeTitle"
              @click="quantizeSelection()"
            >
              {{ t.shell.editor.quantize }}
            </button>
            <label class="bar-field">
              <input v-model="store.scaleHighlight.enabled" type="checkbox" />
              {{ t.shell.editor.scaleHighlight }}
            </label>
            <label class="bar-field" :title="t.shell.editor.musicTypingTitle">
              <input
                :checked="musicTyping.enabled.value"
                type="checkbox"
                @change="toggleMusicTyping"
              />
              {{ t.shell.editor.musicTyping }}
            </label>
            <label class="bar-field" :title="t.shell.editor.stepInputTitle">
              <input :checked="stepInput.armed.value" type="checkbox" @change="toggleStepInput" />
              {{ t.shell.editor.stepInput }}
            </label>
            <span v-if="stepInput.armed.value" class="step-cursor">
              @ {{ formatBarBeatTick(stepInput.cursorPpq.value, store.timeSignatures) }}
            </span>
            <label class="bar-field">
              {{ t.shell.editor.midiIn }}
              <SelectMenu
                v-model="midiInputSelection"
                :options="midiInputChoices"
                size="sm"
                :aria-label="t.shell.editor.midiIn"
              />
            </label>
            <button
              v-if="!webMidi.connected.value"
              type="button"
              :disabled="busy"
              @click="connectWebMidi"
            >
              {{ t.shell.editor.connectMidi }}
            </button>
            <button v-else type="button" @click="webMidi.disconnect()">
              {{ t.shell.editor.disconnectMidi }}
            </button>
            </div>
            <span class="midi-learn-anchor">
              <button
                type="button"
                class="midi-learn-toggle"
                :class="{ 'midi-learn-toggle-active': midiLearnOpen }"
                :aria-expanded="midiLearnOpen"
                :title="t.shell.editor.midiLearnTitle"
                @click="midiLearnOpen = !midiLearnOpen"
              >
                {{ t.shell.editor.midiLearn }}
              </button>
              <MidiLearnPanel
                v-if="midiLearnOpen"
                :learn="midiLearn"
                :tracks="store.tracks"
                @close="midiLearnOpen = false"
              />
            </span>
            <button
              type="button"
              :disabled="!handle || !store.initialized"
              :title="t.shell.editor.applyTitle"
              @click="applyNow"
            >
              {{ t.shell.editor.apply }}
            </button>
            <span class="apply-state">
              {{ applyStateText }}
            </span>
          </div>
          <InfoLine />
          <PianoRollEditor
            class="piano-roll-host"
            :position-ppq="() => positionPpq"
            :audition="auditionNote"
          />
          <div
            v-if="scoreVisible"
            class="split-divider"
            role="separator"
            aria-orientation="horizontal"
            :aria-label="t.shell.editor.resizeScore"
            :aria-valuenow="Math.round(scoreHeight)"
            :aria-valuemin="scoreHeightMin"
            tabindex="0"
            :title="t.shell.editor.resizeScoreTitle"
            @pointerdown="onScoreDividerPointerDown"
            @pointermove="onScoreDividerPointerMove"
            @pointerup="onScoreDividerPointerUp"
            @pointercancel="onScoreDividerPointerUp"
            @keydown="onScoreDividerKeydown"
          />
          <ScorePanel
            v-if="scoreVisible"
            class="score-host"
            :style="scoreResized ? { flex: 'none', height: `${scoreHeight}px` } : undefined"
            :position-ppq="() => positionPpq"
            @seek="onSeek"
          />
        </section>
        <section v-show="dockTab === 'mixer'" class="dock-body">
          <MixerPanel
            class="mixer-host"
            :bridge="bridge"
            :analyser="analyser"
            :master-scope="masterScopeSource()"
            :meter-for="trackMeterSource"
            :bus-meter-for="busMeterSource"
            :scope-for="trackScopeSource"
            :bus-scope-for="busScopeSource"
            :position-ppq="() => positionPpq"
            :is-playing="isPlaying"
          />
        </section>
        <section v-show="dockTab === 'mastering'" class="dock-body">
          <!-- Kept alive via v-show: the A/B preview renders and playback are
               session-local panel state and must survive tab switches. -->
          <MasteringPanel
            class="mastering-host"
            :loop-enabled="loopEnabled"
            :loop-start-ppq="loopStartPpq"
            :loop-end-ppq="loopEndPpq"
          />
        </section>
        <section v-show="dockTab === 'steps'" class="dock-body dock-body-scroll">
          <!-- Kept alive via v-show: the step pattern is session-local
               component state and must survive tab switches. -->
          <StepSequencer />
        </section>
        <section v-show="dockTab === 'lists'" class="dock-body">
          <ProjectListsPanel
            class="lists-host"
            :position-ppq="() => positionPpq"
            @seek="onSeek"
          />
        </section>
        <section v-show="dockTab === 'media'" class="dock-body">
          <!-- Remounted per open so the asset list picks up recordings and
               menu imports made while the tab was hidden. -->
          <MediaBrowser
            v-if="dockTab === 'media'"
            class="media-host"
            @add-to-project="onAddAssetToProject"
          />
        </section>
        <section v-show="dockTab === 'sample'" class="dock-body">
          <SampleEditor
            v-if="sampleAssetId"
            :key="sampleAssetId"
            :asset-id="sampleAssetId"
            class="sample-host"
            @asset-created="onAssetCreated"
            @apply-asset="onApplyAsset"
          />
          <HintCard
            v-else
            :title="t.shell.sampleEditor.title"
            :message="t.shell.sampleEditor.emptyMessage"
          />
        </section>
      </section>
      </div>

      <aside v-if="deviceRackOpen" class="right-zone" :aria-label="t.shell.devices.panelLabel">
        <DeviceRack :transport-playing="isPlaying" />
      </aside>
    </main>

    <DiagnosticsPanel
      :busy="busy"
      :ctx-state="ctxState"
      :handle="handle"
      :render-info="renderInfo"
      @render-offline="renderOffline"
      @test-tone="playTestTone"
    />

    <TransportBar
      :auto-punch-enabled="autoPunchEnabled"
      :bbt-display="bbtDisplay"
      :bridge="bridge"
      :count-in-choices="COUNT_IN_CHOICES"
      :handle="handle"
      :has-locator-window="hasLocatorWindow"
      :is-playing="isPlaying"
      :loop-enabled="loopEnabled"
      :metronome-enabled="metronomeEnabled"
      :position-seconds="positionSeconds"
      :recording="recording"
      :record-menu-open="recordMenuOpen"
      :shortcut-title="shortcutTitle"
      :store-initialized="store.initialized"
      :tempo-input="tempoInput"
      @apply-tempo="applyTempo"
      @bbt-blur="onBbtCommit"
      @bbt-focus="onBbtFocus"
      @count-in-change="onCountInChange"
      @nudge-by-bar="nudgeByBar"
      @record-menu-ref="(el) => (recordMenuRoot = el)"
      @seek-to-end="seekToEnd"
      @seek-to-start="seekToStart"
      @set-left-locator="setLeftLocator"
      @set-right-locator="setRightLocator"
      @start-playback="startPlayback"
      @stop-playback="stopPlayback"
      @toggle-auto-punch="toggleAutoPunch"
      @toggle-loop="toggleLoop"
      @toggle-metronome="transport.toggleMetronome()"
      @toggle-record="toggleRecord"
      @update-bbt-draft="(value) => (bbtDraft = value)"
      @update-record-menu-open="(open) => (recordMenuOpen = open)"
      @update-tempo-input="(value) => (tempoInput = value)"
    />

    <NewProjectDialog
      :open="newDialogOpen"
      :unsaved-changes="dirty"
      @create="onCreateProject"
      @cancel="newDialogOpen = false"
    />

    <ExportDialog
      :open="exportDialogOpen"
      :get-document="serializeProject"
      :project-name="store.projectName"
      :has-loop="exportLoopRegion !== null"
      :loop-region="exportLoopRegion"
      :download="downloadBlobFile"
      @close="exportDialogOpen = false"
    />

    <OpenProjectDialog
      :open="openDialogOpen"
      :stored-projects="storedProjects"
      @close="openDialogOpen = false"
      @delete-project="deleteStoredProject"
      @dialog-ref="(el) => (openDialogRef = el)"
      @import-szd="importSzdFile"
      @keydown="onOpenDialogKeydown"
      @open-project="openStoredProject"
    />

    <SettingsDialog
      :open="settingsOpen"
      :layout-bindings="layoutBindings"
      @close="settingsOpen = false"
    />

    <ShortcutsHelp :open="helpOpen" @close="helpOpen = false" />

    <AboutDialog
      :open="aboutOpen"
      :version="version"
      :isolated="isolated"
      @close="aboutOpen = false"
    />

    <WelcomeTour ref="tourRef" :steps="localizedTourSteps" />

    <ContextMenu />

    <DialogHost />
  </div>
</template>

<style scoped src="@/ui/shell/app-shell.css"></style>
