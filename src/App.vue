<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onScopeDispose,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue';
import ArrangementView from '@/components/arrangement/ArrangementView.vue';
import ClipInspector from '@/components/arrangement/ClipInspector.vue';
import ChordGenerateDialog from '@/components/compose/ChordGenerateDialog.vue';
import KeyChangeDialog from '@/components/compose/KeyChangeDialog.vue';
import TrackGenerateDialog, {
  type TrackGenerateOpenWith,
} from '@/components/compose/TrackGenerateDialog.vue';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import ExportDialog from '@/components/export/ExportDialog.vue';
import { formatBarBeatTick } from '@/components/lists/bar-beat';
import ProjectListsPanel, { type ListTab } from '@/components/lists/ProjectListsPanel.vue';
import MasteringPanel from '@/components/mastering/MasteringPanel.vue';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import HintCard from '@/components/onboarding/HintCard.vue';
import WelcomeTour from '@/components/onboarding/WelcomeTour.vue';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollEditor from '@/components/piano-roll/PianoRollEditor.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import OpenProjectDialog from '@/components/project/OpenProjectDialog.vue';
import RevisionsDialog from '@/components/project/RevisionsDialog.vue';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import ShortcutsHelp from '@/components/settings/ShortcutsHelp.vue';
import AboutDialog from '@/components/shell/AboutDialog.vue';
import AppHeader from '@/components/shell/AppHeader.vue';
import CommandPalette from '@/components/shell/CommandPalette.vue';
import ContextMenu from '@/components/shell/ContextMenu.vue';
import DiagnosticsPanel from '@/components/shell/DiagnosticsPanel.vue';
import DialogHost from '@/components/shell/DialogHost.vue';
import ErrorBanner from '@/components/shell/ErrorBanner.vue';
import MidiLearnPanel from '@/components/shell/MidiLearnPanel.vue';
import PwaUpdateBanner from '@/components/shell/PwaUpdateBanner.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import StartScreen from '@/components/shell/StartScreen.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import ToolPalette from '@/components/shell/ToolPalette.vue';
import TransportBar from '@/components/shell/TransportBar.vue';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { useActionGuards } from '@/composables/useActionGuards';
import { useAppLifecycle } from '@/composables/useAppLifecycle';
import { useAppSettings } from '@/composables/useAppSettings';
import { type DockTab, useAppShellLayout } from '@/composables/useAppShellLayout';
import { useAppShortcutsMenu } from '@/composables/useAppShortcutsMenu';
import { useAutosave } from '@/composables/useAutosave';
import { useEditorTool } from '@/composables/useEditorTool';
import { useEngineLifecycle } from '@/composables/useEngineLifecycle';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import { useFileDownloads } from '@/composables/useFileDownloads';
import { useInputControls } from '@/composables/useInputControls';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import { useMidiRecording } from '@/composables/useMidiRecording';
import { useNotePreview } from '@/composables/useNotePreview';
import { useOutsidePopovers } from '@/composables/useOutsidePopovers';
import { useProjectAudioAssets } from '@/composables/useProjectAudioAssets';
import { useProjectExport } from '@/composables/useProjectExport';
import { useProjectPersistence } from '@/composables/useProjectPersistence';
import { usePwaInstallPrompt } from '@/composables/usePwaInstallPrompt';
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
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import {
  canRedo,
  canUndo,
  quantizeSelection,
  redo,
  setActiveTrack,
  type TrackPart,
  undo,
} from '@/project/commands';
import { unfreezeTrack } from '@/project/freeze';
import { partForTrack } from '@/project/generation';
import { persistedProjectStateKey } from '@/project/persisted-state';
import { evaluateProjectCapacity, formatProjectCapacityIssue } from '@/project/project-capacity';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { isAudioClip } from '@/project/types';
import { installPwaReloadPreparation } from '@/pwa';
import { installPwaLaunchQueue, type PwaLaunchQueue } from '@/pwa-launch';
import { clearAudioClipData } from '@/ui/arrangement/audio-clip-data';
import { formatMessage, useI18n } from '@/ui/i18n';
import { useContextMenuState } from '@/ui/menu/context-menu';
import { disengageAutomationWriteModes } from '@/ui/mixer/automation-mode';
import { shortcutBlockingOverlayOpen } from '@/ui/overlay-registry';
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
const autosaveErrorMessage = ref('');
const mediaWarning = ref('');
const busy = ref(false);
const contextMenuState = useContextMenuState();

watch(
  () => contextMenuState.error,
  (error) => {
    if (!error) return;
    errorMessage.value = error;
    contextMenuState.error = '';
  },
);

/** Plain (non-reactive) engine objects; the meter bridge must not be wrapped in reactive(). */
const handle = shallowRef<EngineHandle | null>(null);
const bridge = shallowRef<MeterBridge | null>(null);
const analyser = shallowRef<AnalyserBridge | null>(null);
const scope = shallowRef<ScopeBridge | null>(null);

const transport = useTransport(() => handle.value);
const pianoRollRef = ref<{
  fitSelection: () => void;
  zoomHorizontal: (factor: number) => void;
} | null>(null);
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
const metronomeVolume = ref(0.35);

function setMetronomeVolume(value: number): void {
  const next = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : metronomeVolume.value;
  metronomeVolume.value = next;
  transport.toggleMetronome(metronomeEnabled.value, next);
}

function setLoopRange(startPpq: number, endPpq: number): void {
  if (endPpq > startPpq) transport.setLoop(startPpq, endPpq, true);
}

/** Genuine audio-engine status once running: sample rate and transport mode. */
const store = useProjectStore();
const snapChoice = computed<number | 'bar'>({
  get: () => (store.snapBar ? 'bar' : store.snapDivision),
  set: (value) => {
    store.snapBar = value === 'bar';
    if (value !== 'bar') store.snapDivision = value;
  },
});
const stepInput = useStepInput();
const historyCanUndo = computed(() => {
  store.tracks.length;
  store.clips.length;
  store.notes.length;
  store.markers.length;
  store.sections.length;
  store.automationLanes.length;
  store.midiCcBindings.size;
  store.projectName;
  store.displayTransposeSemitones;
  return canUndo();
});
const historyCanRedo = computed(() => {
  store.tracks.length;
  store.clips.length;
  store.notes.length;
  store.markers.length;
  store.sections.length;
  store.automationLanes.length;
  store.midiCcBindings.size;
  store.projectName;
  store.displayTransposeSemitones;
  return canRedo();
});

/** Keep header history controls on the same user-visible error surface as menus and shortcuts. */
function onUndo(): void {
  try {
    undo();
  } catch (error) {
    errorMessage.value = describeError(error);
  }
}

function onRedo(): void {
  try {
    redo();
  } catch (error) {
    errorMessage.value = describeError(error);
  }
}

// --- User preferences ----------------------------------------------------------

const appSettings = useAppSettings();
const { t } = useI18n();
const mediaWarningIntro = computed(() => t.value.shell.media.missingWarning);

// Project-capacity warnings are derived purely from the project snapshot: the
// engine addresses mixer strips and internal instruments through fixed-width id
// spaces, so a project that outgrows them silently loses telemetry or misroutes
// control. Dismiss hides the current set; a changed set re-surfaces.
const capacityIssues = computed(() =>
  evaluateProjectCapacity(store.tracks, store.projectExternalMidi),
);
const dismissedCapacityKey = ref('');
const capacityWarning = computed(() => {
  const issues = capacityIssues.value;
  if (issues.length === 0) return '';
  const key = JSON.stringify(issues);
  if (key === dismissedCapacityKey.value) return '';
  const strings = t.value.shell.capacity;
  const lines = issues.map((issue) => formatProjectCapacityIssue(issue, strings));
  return [strings.warningIntro, ...lines].join('\n');
});
function dismissCapacityWarning(): void {
  dismissedCapacityKey.value = JSON.stringify(capacityIssues.value);
}
const shortcuts = useShortcuts();
const { tool: editorTool, setTool: setEditorTool } = useEditorTool();
function toggleTheme(): void {
  appSettings.set('theme', appSettings.resolvedTheme.value === 'dark' ? 'light' : 'dark');
}
const applyStateText = computed(() => {
  if (!handle.value) return t.value.shell.editor.engineOff;
  if (applyPending.value) return t.value.shell.editor.pending;
  return formatMessage(t.value.shell.editor.clipCount, { count: String(scheduledCount.value) });
});

/** Engine status dot state: off (no engine), pending (bouncing), or running. */
const engineStatusState = computed(() => {
  if (!handle.value) return 'off';
  if (applyPending.value) return 'pending';
  return 'on';
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
const persistedStateKey = computed(() => persistedProjectStateKey(store));
const autosave = useAutosave({
  intervalMs: () => appSettings.settings.autosaveIntervalMs,
  persistedStateKey,
});
// Service-worker activation/recovery may reload the page. Flush the current
// document first so OPFS writes cannot be abandoned mid-update.
onScopeDispose(
  installPwaReloadPreparation(async () => {
    // The launcher has no live document to save. An update must remain
    // usable before the user creates or opens a project.
    if (!store.initialized) return true;
    const saved = await autosave.saveNow();
    return saved;
  }),
);
onScopeDispose(clearAudioClipData);

// Surface a failed background autosave: the user's recent edits are not on
// disk, so warn them to save manually rather than failing silently.
watch(autosave.lastError, (error) => {
  if (error) autosaveErrorMessage.value = t.value.shell.autosaveFailed;
});
const { downloadBlobFile, lastDownload } = useFileDownloads();

const { confirmAction, confirmLossAction, runAction } = useActionGuards({
  appSettings,
  busy,
  errorMessage,
});
const commandPaletteOpen = ref(false);
const chordGenerateDialogOpen = ref(false);
const trackGenerateDialogOpen = ref(false);
const trackGenerateOpenWith = ref<TrackGenerateOpenWith | null>(null);
const keyChangeDialogOpen = ref(false);

/** Opens Flow B (track generation), optionally pre-focused on one part. */
function openTrackGenerateDialog(openWith: TrackGenerateOpenWith | null = null): void {
  trackGenerateOpenWith.value = openWith;
  chordGenerateDialogOpen.value = false;
  trackGenerateDialogOpen.value = true;
}

/** Opens Flow A (chord progression). */
function openChordGenerateDialog(): void {
  trackGenerateDialogOpen.value = false;
  chordGenerateDialogOpen.value = true;
}

/** Opens the key-change detection dialog from the Generate menu. */
function openKeyChangeDialog(): void {
  trackGenerateDialogOpen.value = false;
  chordGenerateDialogOpen.value = false;
  keyChangeDialogOpen.value = true;
}

/** Track-header "regenerate": opens Flow B pre-focused on replacing this track. */
function onRegenerateTrack(trackId: number, part: TrackPart): void {
  if (store.tracks.find((track) => track.id === trackId)?.frozen !== undefined) {
    errorMessage.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
    return;
  }
  openTrackGenerateDialog({ part, target: { kind: 'replaceTrack', trackId } });
}

/** Start a drum variation at exactly the clicked arrangement section. */
function onRegenerateSectionDrums(sectionId: number): void {
  const section = store.sections.find((entry) => entry.id === sectionId);
  if (!section) return;
  const track = store.tracks.find(
    (entry) =>
      entry.kind === 'midi' &&
      entry.frozen === undefined &&
      (partForTrack(entry) === 'drums' || entry.percussion === true),
  );
  if (!track) {
    errorMessage.value = t.value.shell.arrangement.regenerateSectionDrumsNoTrack;
    return;
  }
  openTrackGenerateDialog({
    part: 'drums',
    target: {
      kind: 'replaceRange',
      trackId: track.id,
      startPpq: section.startPpq,
      endPpq: section.endPpq,
    },
  });
}

/** One-shot deep-link target for the lists dock panel (chord-lane "open list" action). */
const listsInitialTab = ref<ListTab | undefined>(undefined);

// --- Recording -----------------------------------------------------------------

const recording = useRecording(() => handle.value, transport);
const midiRecording = useMidiRecording(transport);
const {
  armedTrackIds,
  canRecord,
  isCountingIn,
  isRecording,
  recordMenuOpen,
  recordMenuRoot,
  recordingInputDeviceOptions,
  onArmTrack,
  onCountInChange,
  onMidiInputQuantizeChange,
  onRecordInputDeviceChange,
  onRecordSourceChange,
  toggleRecord,
} = useRecordingControls({ appSettings, errorMessage, recording, midiRecording, transport });

let bootPromise: Promise<void> | null = null;
let resolveBootStart: (() => void) | null = null;
const bootStarted = new Promise<void>((resolve) => {
  resolveBootStart = resolve;
});

const { canInstall: canInstallPwa, requestInstall: requestPwaInstall } = usePwaInstallPrompt();

// --- Project menu / persistence -------------------------------------------------

const {
  dirty,
  opfsAvailable,
  midiImportInput,
  newDialogOpen,
  openDialogOpen,
  revisions,
  revisionsDialogOpen,
  saveRevisionAction,
  openRevisionsDialog,
  restoreRevision,
  deleteRevision,
  startScreenOpen,
  hasAutosave,
  storedProjects,
  recentMenuNames,
  bootProject,
  openStartScreen,
  continueSession,
  openDemo,
  markClean,
  closeProjectMenu,
  openNewDialog,
  onCreateProject,
  openOpenDialog,
  openStoredProject,
  openRecentProject,
  deleteStoredProject,
  renameStoredProject,
  importSzdFile,
  importLaunchedSzdFile,
  importDawprojectAction,
  importMusicXmlAction,
  importMidiAction,
  onMidiImportChange,
  saveProjectAction,
  saveProjectAsAction,
  exportSzdAction,
  exportBrowserBackupAction,
  importBrowserBackupAction,
  exportSmfAction,
  exportMidi2Action,
  disposeProjectPersistence,
} = useProjectPersistence({
  autosave,
  confirmAction,
  confirmLossAction,
  downloadBlobFile,
  errorMessage,
  runAction,
  persistedStateKey,
  onProjectDocumentWillLoad: clearAudioClipData,
});

function installLaunchQueueConsumer(): void {
  const queue = (globalThis as { launchQueue?: PwaLaunchQueue }).launchQueue;
  installPwaLaunchQueue(queue, {
    importFile: importLaunchedSzdFile,
    onError: (reason) => {
      errorMessage.value = reason instanceof Error ? reason.message : String(reason);
    },
    waitForBoot: async () => {
      await bootStarted;
      await bootPromise;
    },
  });
}

// --- Audio export / DAWproject ---------------------------------------------------

const {
  exportDialogOpen,
  exportLoopRegion,
  exportDawprojectAction,
  exportMusicXmlAction,
  openExportDialog,
} = useProjectExport({
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
  stemImportInput,
  importAudioAction,
  importStemsAction,
  onAddAssetToProject,
  onApplyAsset,
  onAssetCreated,
  onAudioImportChange,
  onRedetectClipTempo,
  onStemImportChange,
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
  sendLiveExternalMidi,
  scheduledClips,
  setEngineRebuildHandler,
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
  sidechainRefusal,
} = useEngineProjectSync({
  bridge,
  scope,
  errorMessage,
  mediaWarning,
  mediaWarningIntro,
  handle,
  transport,
});

const {
  disposeEngineLifecycle,
  ensureEngineStarted,
  playTestTone,
  renderOffline,
  restartEngine,
  startEngine,
} = useEngineLifecycle({
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
  resetEngineProjectSync: disposeEngineProjectSync,
  setEngineSyncHandles,
  syncAutomationState,
  syncMidiState,
  syncMixerState,
  syncTransportState,
});

setEngineRebuildHandler(restartEngine);

// --- Live note preview -------------------------------------------------------

const { auditionNote, previewNote, previewNoteOn, previewNoteOff, previewChannelVoice } =
  useNotePreview({
    errorMessage,
    handle,
    hasMidiSync,
    ensureEngineStarted,
    sendLiveExternalMidi,
  });

// --- Music typing / step input / Web MIDI ------------------------------------

const {
  midiInputChoices,
  midiInputSelection,
  midiLearn,
  midiLearnOpen,
  musicTyping,
  webMidi,
  controlSurface,
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
  previewChannelVoice,
  recordingActive: isRecording,
  onRecordNoteOn: midiRecording.captureNoteOn,
  onRecordNoteOff: midiRecording.captureNoteOff,
  onRecordControlChange: midiRecording.captureControlChange,
  onRecordPitchBend: midiRecording.capturePitchBend,
  onRecordProgramChange: midiRecording.captureProgramChange,
  onRecordChannelPressure: midiRecording.captureChannelPressure,
  onRecordPolyPressure: midiRecording.capturePolyPressure,
  // Learned control-surface buttons drive the same actions as the transport
  // bar; the thunks defer to the transport controls created below.
  transportActions: {
    play: () => togglePlayback(),
    stop: () => stopPlayback(),
    record: () => toggleRecord(),
    loop: () => toggleLoop(),
  },
  rewind: () => seekToStart(),
  forward: () => seekToEnd(),
  // A surface ARM button is momentary, so it toggles whatever the track's
  // current arm state is; SELECT focuses the track the strip points at.
  toggleTrackArm: (trackId: number) => {
    onArmTrack(trackId, !armedTrackIds.value.includes(trackId));
  },
  selectTrack: (trackId: number) => {
    store.activeTrackId = trackId;
  },
  isPlaying,
  isRecording,
  isLooping: loopEnabled,
  armedTrackIds,
  trackMeterSource,
  runAction,
});

function stepInputBack(): void {
  stepInput.back();
}

function stepInputCursorToPlayhead(): void {
  stepInput.setCursor(positionPpq.value);
}

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
  scoreHeightMax,
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

/** Reveals the chord list editor: selects (and un-collapses) the lists dock tab and its chords sub-tab. */
function onOpenChordList(): void {
  selectDockTab('lists');
  listsInitialTab.value = 'chords';
}

/** Closes the generation dialog and reveals the newly selected lead clip. */
function onComposeLead(): void {
  trackGenerateDialogOpen.value = false;
  selectDockTab('roll');
}

/** Reveals the key editor from the Generate dialog's "change key" link: closes the modal dock, then deep-links. */
function onOpenGenerateKey(): void {
  chordGenerateDialogOpen.value = false;
  selectDockTab('lists');
  listsInitialTab.value = 'key';
}

const EDITOR_DOCK_TABS: readonly DockTab[] = [
  'roll',
  'mixer',
  'mastering',
  'steps',
  'lists',
  'media',
  'sample',
];

function dockTabId(tab: DockTab): string {
  return `editor-dock-tab-${tab}`;
}

function dockPanelId(tab: DockTab): string {
  return `editor-dock-panel-${tab}`;
}

const instrumentPickerRequest = ref(0);

async function openTrackInstrumentPicker(trackId: number): Promise<void> {
  setActiveTrack(trackId);
  if (!deviceRackOpen.value) {
    deviceRackOpen.value = true;
    persistDeviceRackOpen();
  }
  await nextTick();
  instrumentPickerRequest.value += 1;
}

// --- Settings, shortcut help, named layouts, welcome tour -----------------------

const {
  aboutOpen,
  diagnosticsOpen,
  helpOpen,
  namedLayouts,
  settingsOpen,
  tourRef,
  applyNamedLayout,
  openAbout,
  openDiagnostics,
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

// Defer the first-run welcome tour until the start screen is dismissed so the
// two onboarding surfaces never overlap. Mirrors WelcomeTour's own seen flag.
const TOUR_SEEN_KEY = 'sonare-studio.tourSeen';
watch(startScreenOpen, (open, wasOpen) => {
  if (!wasOpen || open) return;
  let seen = false;
  try {
    seen = localStorage.getItem(TOUR_SEEN_KEY) !== null;
  } catch {
    seen = false;
  }
  if (!seen) tourRef.value?.open();
});

const globalShortcutsBlocked = computed(() => shortcutBlockingOverlayOpen.value);

const { onWindowPointerDown } = useOutsidePopovers([
  { open: recordMenuOpen, root: recordMenuRoot, close: () => (recordMenuOpen.value = false) },
]);

// --- App-level keyboard shortcuts ---------------------------------------------

const {
  arrangementRef,
  commandPaletteItems,
  focusZone,
  layoutMenu,
  menuBarModel,
  onGlobalKeyDown,
  shortcutTitle,
} = useAppShortcutsMenu({
  commandPaletteOpen,
  canRecord,
  deviceRackOpen,
  editorTool,
  handle,
  helpOpen,
  isGlobalShortcutBlocked: () => globalShortcutsBlocked.value,
  isPlaying,
  isRecording,
  layouts: namedLayouts.layouts,
  loopEnabled,
  opfsAvailable,
  pianoRollRef,
  positionPpq,
  midiRecording,
  recentNames: recentMenuNames,
  recording,
  scoreVisible,
  settingsOpen,
  shortcuts,
  applyNamedLayout,
  exportDawproject: exportDawprojectAction,
  exportBrowserBackup: exportBrowserBackupAction,
  exportMidi2: exportMidi2Action,
  exportMusicXml: exportMusicXmlAction,
  exportSmf: exportSmfAction,
  exportSzd: exportSzdAction,
  importAudio: importAudioAction,
  importStems: importStemsAction,
  importBrowserBackup: importBrowserBackupAction,
  importDawproject: importDawprojectAction,
  importMusicXml: importMusicXmlAction,
  importMidi: importMidiAction,
  nudgeByBar,
  openAbout,
  openDiagnostics,
  openExportDialog,
  openChordGenerateDialog,
  openTrackGenerateDialog: () => openTrackGenerateDialog(),
  openKeyChangeDialog,
  openNewDialog,
  openOpenDialog,
  openRevisionsDialog,
  openRecentProject,
  openStartScreen,
  openDemo,
  openShortcutsHelp,
  openWelcomeTour,
  onError: (message) => {
    errorMessage.value = message;
  },
  saveCurrentLayout: saveCurrentLayoutAction,
  saveProjectAction,
  saveProjectAsAction,
  seekToEnd,
  seekToStart,
  setEditorTool,
  setLeftLocator,
  setRightLocator,
  toggleDeviceRack,
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
    mixerLaneTrackIds,
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
  disposeEngineLifecycle,
  disposeEngineProjectSync,
  disposeLayout,
  disposeProjectPersistence,
  onGlobalKeyDown,
  onWindowPointerDown,
  setBootPromise: (promise) => {
    bootPromise = promise;
    if (promise) {
      resolveBootStart?.();
      resolveBootStart = null;
    }
  },
  flushAutosave: autosave.saveNow,
  shouldBlockUnload: () => dirty.value || autosave.saving.value,
});

// Register after the lifecycle hook so a launchQueue delivery always observes
// the boot promise created during the same mounted pass.
onMounted(installLaunchQueueConsumer);
</script>

<template>
  <div class="app-shell" data-app-shell-focus-fallback tabindex="-1">
    <AppHeader
      :autosave-last-saved-at="autosave.lastSavedAt.value"
      :can-redo="historyCanRedo"
      :can-undo="historyCanUndo"
      :can-install-pwa="canInstallPwa"
      :device-rack-open="deviceRackOpen"
      :dirty="dirty"
      :layout-menu="layoutMenu"
      :menus="menuBarModel"
      :project-name="store.projectName"
      :resolved-theme="appSettings.resolvedTheme.value"
      @audio-import-change="onAudioImportChange"
      @audio-import-input-ref="(el) => (audioImportInput = el)"
      @stem-import-change="onStemImportChange"
      @stem-import-input-ref="(el) => (stemImportInput = el)"
      @midi-import-change="onMidiImportChange"
      @midi-import-input-ref="(el) => (midiImportInput = el)"
      @install-pwa="requestPwaInstall"
      @redo="onRedo"
      @toggle-theme="toggleTheme"
      @toggle-device-rack="toggleDeviceRack"
      @undo="onUndo"
    />

    <ErrorBanner :message="errorMessage" @dismiss="errorMessage = ''" />
    <ErrorBanner
      :message="autosaveErrorMessage"
      :auto-dismiss-ms="0"
      @dismiss="autosaveErrorMessage = ''"
    />
    <ErrorBanner
      :message="mediaWarning"
      :auto-dismiss-ms="0"
      :action-label="t.shell.media.openMedia"
      @action="selectDockTab('media')"
      @dismiss="mediaWarning = ''"
    />
    <ErrorBanner
      :message="capacityWarning"
      :auto-dismiss-ms="0"
      @dismiss="dismissCapacityWarning"
    />
    <PwaUpdateBanner v-if="!startScreenOpen" />

    <main class="main-row">
      <div class="workspace">
      <section
        class="arrange-zone"
        :class="{ 'arrange-grow': dockCollapsed }"
        :style="dockCollapsed ? undefined : { flexBasis: `${arrangeHeight}px` }"
        @pointerdown.capture="focusZone = 'arrange'"
        @focusin="focusZone = 'arrange'"
      >
        <ArrangementView
          ref="arrangementRef"
          :position-ppq="() => positionPpq"
          :is-playing="isPlaying"
          :loop-enabled="loopEnabled"
          :loop-start-ppq="loopStartPpq"
          :loop-end-ppq="loopEndPpq"
          :armed-track-ids="armedTrackIds"
          :record-input-devices="recordingInputDeviceOptions"
          @seek="onSeek"
          @loop-range="setLoopRange"
          @arm="onArmTrack"
          @change-instrument="openTrackInstrumentPicker"
          @generate="openChordGenerateDialog"
          @regenerate-track="onRegenerateTrack"
          @regenerate-section-drums="onRegenerateSectionDrums"
          @open-chords="onOpenChordList"
        />
        <ClipInspector
          :clip="store.activeClip"
          :frozen="store.activeTrack?.frozen !== undefined"
          @redetect-tempo="onRedetectClipTempo"
          @unfreeze="unfreezeTrack"
        />
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
        v-tooltip="t.shell.editor.resizeArrangementTitle"
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
        @focusin="focusZone = 'editor'"
      >
        <div class="dock-tabs">
          <div v-tablist class="dock-tab-scroll" role="tablist" :aria-label="t.shell.editor.panels">
            <button
              :id="dockTabId('roll')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'roll' }"
              role="tab"
              :aria-selected="dockTab === 'roll'"
              :aria-controls="dockPanelId('roll')"
              @click="selectDockTab('roll')"
            >
              {{ t.shell.editor.tabs.pianoRoll }}
            </button>
            <button
              :id="dockTabId('mixer')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'mixer' }"
              role="tab"
              :aria-selected="dockTab === 'mixer'"
              :aria-controls="dockPanelId('mixer')"
              @click="selectDockTab('mixer')"
            >
              {{ t.shell.editor.tabs.mixer }}
            </button>
            <button
              :id="dockTabId('mastering')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'mastering' }"
              role="tab"
              :aria-selected="dockTab === 'mastering'"
              :aria-controls="dockPanelId('mastering')"
              @click="selectDockTab('mastering')"
            >
              {{ t.shell.editor.tabs.mastering }}
            </button>
            <button
              :id="dockTabId('steps')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'steps' }"
              role="tab"
              :aria-selected="dockTab === 'steps'"
              :aria-controls="dockPanelId('steps')"
              @click="selectDockTab('steps')"
            >
              {{ t.shell.editor.tabs.steps }}
            </button>
            <button
              :id="dockTabId('lists')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'lists' }"
              role="tab"
              :aria-selected="dockTab === 'lists'"
              :aria-controls="dockPanelId('lists')"
              @click="selectDockTab('lists')"
            >
              {{ t.shell.editor.tabs.lists }}
            </button>
            <button
              :id="dockTabId('media')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'media' }"
              role="tab"
              :aria-selected="dockTab === 'media'"
              :aria-controls="dockPanelId('media')"
              @click="selectDockTab('media')"
            >
              {{ t.shell.editor.tabs.media }}
            </button>
            <button
              :id="dockTabId('sample')"
              type="button"
              class="dock-tab dock-tab-toggle"
              :class="{ active: dockTab === 'sample' }"
              role="tab"
              :aria-selected="dockTab === 'sample'"
              :aria-controls="dockPanelId('sample')"
              @click="selectDockTab('sample')"
            >
              {{ t.shell.editor.tabs.sample }}
            </button>
          </div>
          <button
            type="button"
            class="dock-tab dock-tab-toggle dock-tab-score"
            :class="{ active: scoreVisible }"
            :aria-pressed="scoreVisible"
            v-tooltip="t.shell.editor.toggleScoreTitle"
            @click="toggleScorePanel"
          >
            {{ t.shell.editor.tabs.score }}
          </button>
          <ToolPalette />
          <button
            type="button"
            class="dock-collapse"
            :aria-pressed="dockCollapsed"
            v-tooltip="dockCollapsed ? t.shell.editor.expandDock : t.shell.editor.collapseDock"
            :aria-label="t.shell.editor.toggleDock"
            @click="toggleDockCollapsed"
          >
            {{ dockCollapsed ? '▴' : '▾' }}
          </button>
        </div>
        <section
          v-show="dockTab === 'roll'"
          :id="dockPanelId('roll')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('roll')"
        >
          <div class="editor-toolbar">
            <div class="editor-toolbar-scroll">
              <label class="bar-field">
                {{ t.shell.editor.snap }}
                <SelectMenu
                  v-model="snapChoice"
                  :options="SNAP_CHOICES"
                  size="sm"
                  :aria-label="t.shell.editor.snap"
                />
              </label>
            <ToggleButton
              v-model="store.snapEnabled"
              size="sm"
              :label="t.shell.editor.snapOn"
              :title="t.shell.editor.snapToggleTitle"
            />
            <button
              type="button"
              :disabled="store.selection.size === 0 || store.activeTrack?.frozen !== undefined"
              v-tooltip="t.shell.editor.quantizeTitle"
              @click="quantizeSelection()"
            >
              {{ t.shell.editor.quantize }}
            </button>
            <label class="bar-field">
              {{ t.shell.editor.quantizeStrength }}
              <input
                v-model.number="store.quantizeStrength"
                type="range"
                min="0"
                max="1"
                step="0.05"
                :aria-label="t.shell.editor.quantizeStrength"
              />
            </label>
            <label class="bar-field">
              {{ t.shell.editor.swing }}
              <input
                v-model.number="store.quantizeSwing"
                type="range"
                min="0"
                max="100"
                step="1"
                :aria-label="t.shell.editor.swing"
              />
            </label>
            <ToggleButton
              v-model="store.scaleHighlight.enabled"
              size="sm"
              :label="t.shell.editor.scaleHighlight"
            />
            <ToggleButton
              :model-value="musicTyping.enabled.value"
              size="sm"
              :label="t.shell.editor.musicTyping"
              :title="t.shell.editor.musicTypingTitle"
              @update:model-value="toggleMusicTyping"
            />
            <ToggleButton
              :model-value="stepInput.armed.value"
              size="sm"
              :label="t.shell.editor.stepInput"
              :title="t.shell.editor.stepInputTitle"
              @update:model-value="toggleStepInput"
            />
            <span v-if="stepInput.armed.value" class="step-cursor">
              @ {{ formatBarBeatTick(stepInput.cursorPpq.value, store.timeSignatures) }}
            </span>
            <button
              v-if="stepInput.armed.value"
              type="button"
              v-tooltip="t.shell.editor.stepBackTitle"
              @click="stepInputBack"
            >
              {{ t.shell.editor.stepBack }}
            </button>
            <button
              v-if="stepInput.armed.value"
              type="button"
              v-tooltip="t.shell.editor.stepCursorToPlayheadTitle"
              @click="stepInputCursorToPlayhead"
            >
              {{ t.shell.editor.stepCursorToPlayhead }}
            </button>
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
                v-tooltip="t.shell.editor.midiLearnTitle"
                @click="midiLearnOpen = !midiLearnOpen"
              >
                {{ t.shell.editor.midiLearn }}
              </button>
              <Transition name="pop">
                <MidiLearnPanel
                  v-if="midiLearnOpen"
                  :learn="midiLearn"
                  :tracks="store.tracks"
                  :surface="controlSurface"
                  @close="midiLearnOpen = false"
                />
              </Transition>
            </span>
            <button
              type="button"
              :disabled="!handle || !store.initialized"
              v-tooltip="t.shell.editor.applyTitle"
              @click="applyNow"
            >
              {{ t.shell.editor.apply }}
            </button>
            <span
              class="engine-status"
              :class="`engine-status-${engineStatusState}`"
              role="status"
              v-tooltip="`${t.shell.editor.engineStatus}: ${applyStateText}`"
              :aria-label="`${t.shell.editor.engineStatus}: ${applyStateText}`"
            >
              <span class="engine-status-dot" aria-hidden="true" />
            </span>
          </div>
          <InfoLine />
          <PianoRollEditor
            ref="pianoRollRef"
            class="piano-roll-host"
            :position-ppq="() => positionPpq"
            :is-playing="isPlaying"
            :force-lane-hidden="scoreVisible"
            :guidance-enabled="dockTab === 'roll' && !dockCollapsed"
            :audition="auditionNote"
            @seek="onSeek"
            @open-chords="onOpenChordList"
          />
          <div
            v-if="scoreVisible"
            class="split-divider"
            role="separator"
            aria-orientation="horizontal"
            :aria-label="t.shell.editor.resizeScore"
            :aria-valuenow="Math.round(scoreHeight)"
            :aria-valuemin="scoreHeightMin"
            :aria-valuemax="scoreHeightMax"
            tabindex="0"
            v-tooltip="t.shell.editor.resizeScoreTitle"
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
            :is-playing="isPlaying"
            :guidance-enabled="dockTab === 'roll' && !dockCollapsed"
            @seek="onSeek"
          />
        </section>
        <section
          v-show="dockTab === 'mixer'"
          :id="dockPanelId('mixer')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('mixer')"
        >
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
            :visible="dockTab === 'mixer'"
            :loop-enabled="loopEnabled"
            :loop-start-ppq="loopStartPpq"
            :loop-end-ppq="loopEndPpq"
            :sidechain-refusal="sidechainRefusal"
          />
        </section>
        <section
          v-show="dockTab === 'mastering'"
          :id="dockPanelId('mastering')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('mastering')"
        >
          <!-- Kept alive via v-show: the A/B preview renders and playback are
               session-local panel state and must survive tab switches. -->
          <MasteringPanel
            class="mastering-host"
            :loop-enabled="loopEnabled"
            :loop-start-ppq="loopStartPpq"
            :loop-end-ppq="loopEndPpq"
          />
        </section>
        <section
          v-show="dockTab === 'steps'"
          :id="dockPanelId('steps')"
          class="dock-body dock-body-scroll"
          role="tabpanel"
          :aria-labelledby="dockTabId('steps')"
        >
          <!-- Kept alive via v-show: the step pattern is session-local
               component state and must survive tab switches. -->
          <StepSequencer />
        </section>
        <section
          v-show="dockTab === 'lists'"
          :id="dockPanelId('lists')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('lists')"
        >
          <ProjectListsPanel
            class="lists-host"
            :position-ppq="() => positionPpq"
            :initial-tab="listsInitialTab"
            @seek="onSeek"
          />
        </section>
        <section
          v-show="dockTab === 'media'"
          :id="dockPanelId('media')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('media')"
        >
          <!-- Remounted per open so the asset list picks up recordings and
               menu imports made while the tab was hidden. -->
          <MediaBrowser
            v-if="dockTab === 'media'"
            class="media-host"
            :visible="dockTab === 'media'"
            @add-to-project="onAddAssetToProject"
          />
        </section>
        <section
          v-show="dockTab === 'sample'"
          :id="dockPanelId('sample')"
          class="dock-body"
          role="tabpanel"
          :aria-labelledby="dockTabId('sample')"
        >
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

      <Transition name="slide-right">
        <aside v-if="deviceRackOpen" class="right-zone" :aria-label="t.shell.devices.panelLabel">
          <DeviceRack
            :transport-playing="isPlaying"
            :position-ppq="() => positionPpq"
            :instrument-picker-request="instrumentPickerRequest"
          />
        </aside>
      </Transition>
    </main>

    <TransportBar
      :auto-punch-enabled="autoPunchEnabled"
      :bbt-display="bbtDisplay"
      :bridge="bridge"
      :can-record="canRecord"
      :count-in-choices="COUNT_IN_CHOICES"
      :handle="handle"
      :has-locator-window="hasLocatorWindow"
      :is-counting-in="isCountingIn"
      :is-playing="isPlaying"
      :is-recording="isRecording"
      :loop-enabled="loopEnabled"
      :metronome-enabled="metronomeEnabled"
      :metronome-volume="metronomeVolume"
      :position-seconds="positionSeconds"
      :recording="recording"
      :recording-input-device-options="recordingInputDeviceOptions"
      :midi-recording="midiRecording"
      :record-menu-open="recordMenuOpen"
      :shortcut-title="shortcutTitle"
      :store-initialized="store.initialized"
      :tempo-input="tempoInput"
      @apply-tempo="applyTempo"
      @bbt-blur="onBbtCommit"
      @bbt-focus="onBbtFocus"
      @count-in-change="onCountInChange"
      @midi-input-quantize-change="onMidiInputQuantizeChange"
      @nudge-by-bar="nudgeByBar"
      @record-input-device-change="onRecordInputDeviceChange"
      @record-source-change="onRecordSourceChange"
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
      @metronome-volume-change="setMetronomeVolume"
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

    <ChordGenerateDialog
      :open="chordGenerateDialogOpen"
      @close="chordGenerateDialogOpen = false"
      @open-key="onOpenGenerateKey"
      @generate-tracks="openTrackGenerateDialog()"
    />

    <TrackGenerateDialog
      :open="trackGenerateDialogOpen"
      :open-with="trackGenerateOpenWith"
      @close="trackGenerateDialogOpen = false"
      @open-chords="openChordGenerateDialog"
      @compose-lead="onComposeLead"
    />

    <KeyChangeDialog :open="keyChangeDialogOpen" @close="keyChangeDialogOpen = false" />

    <ExportDialog
      :open="exportDialogOpen"
      :get-document="serializeProject"
      :project-name="store.projectName"
      :has-loop="exportLoopRegion !== null"
      :loop-region="exportLoopRegion"
      :download="downloadBlobFile"
      @close="exportDialogOpen = false"
    />

    <RevisionsDialog
      :open="revisionsDialogOpen"
      :revisions="revisions"
      @close="revisionsDialogOpen = false"
      @restore-revision="restoreRevision"
      @delete-revision="deleteRevision"
      @save-revision="saveRevisionAction"
    />

    <OpenProjectDialog
      :open="openDialogOpen"
      :stored-projects="storedProjects"
      @close="openDialogOpen = false"
      @delete-project="deleteStoredProject"
      @import-szd="importSzdFile"
      @open-project="openStoredProject"
      @rename-project="renameStoredProject"
    />

    <SettingsDialog
      :open="settingsOpen"
      :layout-bindings="layoutBindings"
      @close="settingsOpen = false"
    />

    <ShortcutsHelp :open="helpOpen" @close="helpOpen = false" />

    <CommandPalette
      :open="commandPaletteOpen"
      :commands="commandPaletteItems"
      @close="commandPaletteOpen = false"
    />

    <AboutDialog
      :open="aboutOpen"
      :version="version"
      :isolated="isolated"
      @close="aboutOpen = false"
    />

    <DiagnosticsPanel
      :open="diagnosticsOpen"
      :busy="busy"
      :ctx-state="ctxState"
      :handle="handle"
      :render-info="renderInfo"
      @close="diagnosticsOpen = false"
      @render-offline="renderOffline"
      @test-tone="playTestTone"
    />

    <WelcomeTour ref="tourRef" :steps="localizedTourSteps" :auto-start="false" />

    <StartScreen
      :open="startScreenOpen"
      :opfs-available="opfsAvailable"
      :has-autosave="hasAutosave"
      :stored-projects="storedProjects"
      @continue-session="continueSession"
      @new-project="openNewDialog"
      @demo="openDemo"
      @open-project="openStoredProject"
      @import-project="importSzdFile"
      @import-backup="importBrowserBackupAction"
      @export-backup="exportBrowserBackupAction"
      @import-midi="importMidiAction"
    />

    <ContextMenu />

    <DialogHost />
  </div>
</template>

<style scoped src="@/ui/shell/app-shell.css"></style>
