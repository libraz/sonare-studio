<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import ArrangementView from '@/components/arrangement/ArrangementView.vue';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import ExportDialog from '@/components/export/ExportDialog.vue';
import LevelMeter from '@/components/LevelMeter.vue';
import ProjectListsPanel from '@/components/lists/ProjectListsPanel.vue';
import MasteringPanel from '@/components/mastering/MasteringPanel.vue';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import HintCard from '@/components/onboarding/HintCard.vue';
import type { TourStep } from '@/components/onboarding/tour-steps';
import WelcomeTour from '@/components/onboarding/WelcomeTour.vue';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollEditor from '@/components/piano-roll/PianoRollEditor.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import ShortcutsHelp from '@/components/settings/ShortcutsHelp.vue';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useAutosave } from '@/composables/useAutosave';
import { useLayouts } from '@/composables/useLayouts';
import { useMusicTyping } from '@/composables/useMusicTyping';
import { useRecording } from '@/composables/useRecording';
import { useShortcuts } from '@/composables/useShortcuts';
import { useStepInput } from '@/composables/useStepInput';
import { useTransport } from '@/composables/useTransport';
import { useWebMidi } from '@/composables/useWebMidi';
import { type AutomationSync, createAutomationSync } from '@/engine/automation-sync';
import { createEngine, type EngineHandle } from '@/engine/engine';
import {
  type MidiNote,
  normalizeGain,
  peakAmplitude,
  prerenderMidiClip,
  resolvePresetName,
} from '@/engine/instruments';
import { createMeterBridge, type MeterBridge, type MeterSource } from '@/engine/meters';
import { createMidiSync, type MidiSync } from '@/engine/midi-sync';
import { createMixerSync, linearToDb, type MixerSync } from '@/engine/mixer-sync';
import { createStripSync, type StripSync } from '@/engine/strip-sync';
import { createTransportSync, type TransportSync } from '@/engine/transport-sync';
import { renderMixdownInWorker } from '@/export/client';
import { dawprojectFilename, exportDawproject } from '@/export/dawproject';
import type { MixdownRangePpq } from '@/export/mixdown';
import { encodeWav } from '@/export/wav';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { loadAssetMeta } from '@/persistence/assets';
import { downloadSzd, pickAndReadSzd } from '@/persistence/local-file';
import {
  deleteProject,
  isOpfsAvailable,
  listProjects,
  loadProject,
  type StoredProjectInfo,
  saveProject,
} from '@/persistence/opfs';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { decodeAndIngest, ingestAudioBuffer } from '@/project/audio-import';
import type { AutomationParam, AutomationPoint } from '@/project/automation';
import {
  addAudioClip,
  addAudioTrack,
  addInsert,
  addMixerBus,
  deleteClip,
  deleteNotes,
  duplicateClip,
  quantizeSelection,
  redo,
  removeAutomationLane,
  removeInsert,
  removeMixerBus,
  removeTrack,
  setActiveClip,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipTakes,
  setInsertEnabled,
  setSelection,
  setSend,
  setTempoSegments,
  undo,
} from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import { exportProjectSmf } from '@/project/export';
import { clampPan } from '@/project/mixer';
import { type ScheduledProjectClip, scheduleProjectClips } from '@/project/scheduling';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { makeDemoDocument, type TemplateName } from '@/project/templates';
import { clipKind, type EditorClip, type EditorTrack, isAudioClip } from '@/project/types';
import {
  type AutomationStripMode,
  automationStripMode,
  disengageAutomationWriteModes,
  setAutomationStripMode,
} from '@/ui/mixer/automation-mode';
import { createFocusTrap, type FocusTrap } from '@/ui/settings/focus-trap';
import { ARRANGE_HEIGHT_MAX_PX, type LayoutBindings } from '@/ui/settings/layouts';
import type { RealtimeEngine } from '@/wasm/index.js';

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

/** Delay after the last edit before the project is re-bounced to the engine. */
const APPLY_DEBOUNCE_MS = 400;
/** Preview note length for music typing / MIDI echo, in PPQ. */
const PREVIEW_DURATION_PPQ = 0.5;
/** Peak level previews are normalized to (matches the scheduled clip default). */
const PREVIEW_TARGET_PEAK = 0.5;

/** Plain (non-reactive) engine objects; the meter bridge must not be wrapped in reactive(). */
const handle = shallowRef<EngineHandle | null>(null);
const bridge = shallowRef<MeterBridge | null>(null);

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

const tempoInput = ref(tempo.value);
const renderInfo = ref('');
const ctxState = ref('');

const store = useProjectStore();
const stepInput = useStepInput();

// --- User preferences ----------------------------------------------------------

const appSettings = useAppSettings();
const shortcuts = useShortcuts();

// Editor-only boot defaults sourced from the user preferences.
store.snapEnabled = appSettings.settings.snapDefault;

// The autosave quiet period follows the preference live (read per schedule).
const autosave = useAutosave({ intervalMs: () => appSettings.settings.autosaveIntervalMs });

/** Destructive-action gate; returns true directly when confirmations are off. */
function confirmAction(message: string): boolean {
  return !appSettings.settings.confirmDestructive || window.confirm(message);
}

// --- Recording -----------------------------------------------------------------

const recording = useRecording(() => handle.value, transport);

// The count-in preference seeds the session; popover edits write back through
// the settings store so the value persists, and the watcher mirrors it here.
recording.countInBars.value = appSettings.settings.countInBars;
watch(
  () => appSettings.settings.countInBars,
  (bars) => {
    recording.countInBars.value = bars;
  },
);
if (appSettings.settings.monitorDefault) recording.setMonitor(true);

/** Record-popover count-in select: persists the choice as a preference. */
function onCountInChange(event: Event): void {
  appSettings.set('countInBars', Number((event.target as HTMLSelectElement).value));
}

/** Armed-track list mirrored down to the arrangement track headers. */
const armedTrackIds = computed(() =>
  recording.armedTrackId.value === null ? [] : [recording.armedTrackId.value],
);

// Recording problems (mic denied, rejected arm, ingest failure) surface in
// the shared error box like every other shell action.
watch(recording.error, (message) => {
  if (message) errorMessage.value = message;
});

/** (Dis)arm requests re-emitted from the arrangement track headers. */
function onArmTrack(trackId: number, armed: boolean): void {
  recording.arm(armed ? trackId : null);
}

/** Record button: starts a take, or ends it (the clip lands; playback keeps rolling). */
function toggleRecord(): void {
  if (recording.isRecording.value) void recording.stopRecord();
  else void recording.record();
}

/** Record-settings popover (input monitor + count-in length). */
const recordMenuOpen = ref(false);
const recordMenuRoot = ref<HTMLElement | null>(null);

/** Runs an async UI action, surfacing any thrown error in the error box. */
async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    await action();
  } catch (err) {
    errorMessage.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- Unsaved-changes tracking -------------------------------------------------

/** True when the project changed since the last save/load. */
const dirty = ref(false);

// The persisted mirror refs are replaced wholesale by every command, so
// identity watching is the canonical change signal (same set useAutosave
// watches; editor-only state is excluded).
watch(
  () =>
    [
      store.projectName,
      store.tracks,
      store.clips,
      store.markers,
      store.sections,
      store.tempoSegments,
      store.timeSignatures,
      store.mixer,
      store.scoreAnnotations,
      store.displayTransposeSemitones,
    ] as const,
  () => {
    if (store.initialized) dirty.value = true;
  },
);

/** Clears the dirty flag after the change watcher saw the latest mutation. */
async function markClean(): Promise<void> {
  await nextTick();
  dirty.value = false;
}

// --- Startup ------------------------------------------------------------------

/** OPFS slot name the autosave composable writes to. */
const AUTOSAVE_SLOT = 'autosave';

let bootPromise: Promise<void> | null = null;

/**
 * First-boot project flow: offer to restore an existing autosave, otherwise
 * load the demo document (the legacy first-run content).
 */
async function bootProject(): Promise<void> {
  let restored = false;
  if (isOpfsAvailable()) {
    try {
      const stored = await listProjects();
      if (
        stored.some((info) => info.name === AUTOSAVE_SLOT) &&
        confirmAction('Restore the autosaved project from your last session?')
      ) {
        restored = await autosave.restoreAutosave();
      }
    } catch (err) {
      errorMessage.value = describeError(err);
    }
  }
  if (!restored) {
    await loadProjectDocument(makeDemoDocument());
  }
  await markClean();
}

// --- Project menu / persistence -------------------------------------------------

const opfsAvailable = isOpfsAvailable();
const projectMenuOpen = ref(false);
const projectMenuRoot = ref<HTMLElement | null>(null);
const newDialogOpen = ref(false);
const openDialogOpen = ref(false);
const storedProjects = ref<StoredProjectInfo[]>([]);

// Open-project dialog modality: trap Tab inside and restore focus on close.
const openDialogRef = ref<HTMLElement | null>(null);
let openDialogTrap: FocusTrap | null = null;

watch(openDialogOpen, (open) => {
  if (open) {
    void nextTick(() => {
      if (openDialogRef.value === null) return;
      openDialogTrap = createFocusTrap(openDialogRef.value);
      openDialogTrap.activate();
    });
  } else {
    openDialogTrap?.deactivate();
    openDialogTrap = null;
  }
});

function onOpenDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    openDialogOpen.value = false;
  }
}

function closeProjectMenu(): void {
  projectMenuOpen.value = false;
}

/** True when the press landed outside the given popover root. */
function isOutsidePress(root: HTMLElement | null, event: PointerEvent): boolean {
  return root !== null && event.target instanceof Node && !root.contains(event.target);
}

/** Closes the transport-bar popovers on any press outside of them. */
function onWindowPointerDown(event: PointerEvent): void {
  if (projectMenuOpen.value && isOutsidePress(projectMenuRoot.value, event)) {
    closeProjectMenu();
  }
  if (recordMenuOpen.value && isOutsidePress(recordMenuRoot.value, event)) {
    recordMenuOpen.value = false;
  }
  if (layoutMenuOpen.value && isOutsidePress(layoutMenuRoot.value, event)) {
    layoutMenuOpen.value = false;
  }
  if (helpMenuOpen.value && isOutsidePress(helpMenuRoot.value, event)) {
    helpMenuOpen.value = false;
  }
}

function openNewDialog(): void {
  closeProjectMenu();
  newDialogOpen.value = true;
}

function onCreateProject(payload: { document: ProjectDocument; template: TemplateName }): void {
  newDialogOpen.value = false;
  void runAction(async () => {
    await loadProjectDocument(payload.document);
    await markClean();
  });
}

async function refreshStoredProjects(): Promise<void> {
  if (!opfsAvailable) {
    storedProjects.value = [];
    return;
  }
  storedProjects.value = (await listProjects()).filter((info) => info.name !== AUTOSAVE_SLOT);
}

function openOpenDialog(): void {
  closeProjectMenu();
  openDialogOpen.value = true;
  void runAction(refreshStoredProjects);
}

/** Confirms discarding unsaved changes before a destructive load. */
function confirmDiscard(): boolean {
  return !dirty.value || confirmAction('Discard unsaved changes in the current project?');
}

function openStoredProject(name: string): void {
  if (!confirmDiscard()) return;
  void runAction(async () => {
    const bytes = await loadProject(name);
    await loadProjectDocument(decodeSzd(bytes));
    // Keep Save writing back to the slot the project was opened from.
    store.projectName = name;
    await markClean();
    openDialogOpen.value = false;
  });
}

function deleteStoredProject(name: string): void {
  if (!confirmAction(`Delete the saved project "${name}"?`)) return;
  void runAction(async () => {
    await deleteProject(name);
    await refreshStoredProjects();
  });
}

function importSzdFile(): void {
  if (!confirmDiscard()) return;
  void runAction(async () => {
    const picked = await pickAndReadSzd();
    if (!picked) return;
    await loadProjectDocument(decodeSzd(picked.bytes));
    await markClean();
    openDialogOpen.value = false;
  });
}

/** Saves the project to OPFS and refreshes the autosave slot to match. */
async function saveToOpfs(name: string): Promise<void> {
  const doc = serializeProject();
  const bytes = encodeSzd(doc, { savedAt: new Date().toISOString() });
  await saveProject(name, bytes);
  // A crash right after a manual save should restore the saved state.
  await autosave.saveNow();
  await markClean();
}

function saveProjectAction(): void {
  closeProjectMenu();
  void runAction(async () => {
    await saveToOpfs(store.projectName);
  });
}

function saveProjectAsAction(): void {
  closeProjectMenu();
  const name = window.prompt('Save project as:', store.projectName)?.trim();
  if (!name) return;
  void runAction(async () => {
    store.projectName = name;
    await saveToOpfs(name);
  });
}

function exportSzdAction(): void {
  closeProjectMenu();
  void runAction(async () => {
    const bytes = encodeSzd(serializeProject(), { savedAt: new Date().toISOString() });
    downloadSzd(store.projectName, bytes);
  });
}

function exportSmfAction(): void {
  closeProjectMenu();
  void runAction(async () => {
    const result = exportProjectSmf();
    downloadBlobFile(
      new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
      result.filename,
    );
  });
}

// --- Audio export / DAWproject ---------------------------------------------------

/** Whether the audio export dialog is shown. */
const exportDialogOpen = ref(false);

/** Transport loop window as a PPQ range for the export dialog (null = no usable loop). */
const exportLoopRegion = computed<MixdownRangePpq | null>(() =>
  loopEnabled.value && loopEndPpq.value > loopStartPpq.value
    ? { startPpq: loopStartPpq.value, endPpq: loopEndPpq.value }
    : null,
);

function openExportDialog(): void {
  closeProjectMenu();
  exportDialogOpen.value = true;
}

/** Last file handed to the download seam (read by the dev test hook). */
let lastDownload: { filename: string; blob: Blob } | null = null;

/** Shared download seam: transient anchor around an object URL. */
function downloadBlobFile(blob: Blob, filename: string): void {
  if (import.meta.env.DEV) lastDownload = { filename, blob };
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Project menu "Export DAWproject": interchange zip with the audio assets embedded. */
function exportDawprojectAction(): void {
  closeProjectMenu();
  void runAction(async () => {
    const bytes = await exportDawproject(serializeProject(), { includeAudio: true });
    downloadBlobFile(
      new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
      dawprojectFilename(store.projectName),
    );
  });
}

// --- Audio assets in the project ------------------------------------------------

const audioImportInput = ref<HTMLInputElement | null>(null);

/**
 * Places a stored audio asset as a new clip at the playhead on the first
 * audio track with room for it (the Project rejects overlapping clips on one
 * track; a new audio track is created when none fits) and selects it.
 */
async function placeAssetAtPlayhead(assetId: string): Promise<number> {
  const meta = await loadAssetMeta(assetId);
  const startPpq = Math.max(0, positionPpq.value);
  const lengthPpq = (meta.numFrames / meta.sampleRate) * (store.tempoBpm / 60);
  const overlaps = (trackId: number): boolean =>
    store.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        clip.startPpq < startPpq + lengthPpq &&
        startPpq < clip.startPpq + clip.lengthPpq,
    );
  const audioTrack = store.tracks.find((track) => track.kind === 'audio' && !overlaps(track.id));
  const trackId = audioTrack ? audioTrack.id : addAudioTrack();
  const newClipId = await addAudioClip({ trackId, assetId, startPpq, lengthPpq, name: meta.name });
  setActiveClip(newClipId);
  return newClipId;
}

/** "Add" from the media browser: drop the asset into the arrangement. */
function onAddAssetToProject(assetId: string): void {
  void runAction(async () => {
    await placeAssetAtPlayhead(assetId);
  });
}

/** Project menu "Import audio…": opens the audio file picker. */
function importAudioAction(): void {
  closeProjectMenu();
  audioImportInput.value?.click();
}

/** Decodes the picked audio files into assets and places each at the playhead. */
function onAudioImportChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length === 0) return;
  void runAction(async () => {
    for (const file of files) {
      const meta = await decodeAndIngest(file);
      await placeAssetAtPlayhead(meta.id);
    }
  });
}

/** Asset id behind the selected audio clip (drives the Sample editor tab). */
const sampleAssetId = computed(() => {
  const clip = store.activeClip;
  return clip && isAudioClip(clip) && clip.assetId ? clip.assetId : null;
});

/**
 * Replaces an audio clip with one referencing another asset at the same
 * placement and selects the replacement. The closest available source rebind
 * today: an add + delete (two undo steps).
 */
async function swapClipAsset(clipId: number, assetId: string): Promise<void> {
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const placement = {
    trackId: clip.trackId,
    startPpq: clip.startPpq,
    lengthPpq: clip.lengthPpq,
    gain: clip.gain,
    name: clip.name,
  };
  // Delete first: the Project rejects overlapping clips on one track, and
  // the replacement lands exactly where the original was.
  deleteClip(clipId);
  const newClipId = await addAudioClip({ assetId, ...placement });
  setActiveClip(newClipId);
}

/** A sample-editor edit stored a new asset version: offer to rebind the clip. */
function onAssetCreated(newAssetId: string, sourceAssetId: string): void {
  const clip = store.activeClip;
  if (!clip || !isAudioClip(clip) || clip.assetId !== sourceAssetId) return;
  if (!window.confirm('Use the edited audio for the selected clip?')) return;
  const clipId = clip.id;
  void runAction(() => swapClipAsset(clipId, newAssetId));
}

/** Explicit "Use in project" from the sample editor: rebind without asking. */
function onApplyAsset(assetId: string): void {
  const clip = store.activeClip;
  if (!clip || !isAudioClip(clip) || clip.assetId === assetId) return;
  const clipId = clip.id;
  void runAction(() => swapClipAsset(clipId, assetId));
}

function formatSavedAt(date: Date): string {
  return `saved ${date.toLocaleTimeString()}`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

// --- Edit-to-sound loop (prerender bounce) ----------------------------------

/** Clips currently scheduled in the engine from the last apply. */
let scheduledClips: ScheduledProjectClip[] = [];
let mixerSync: MixerSync | null = null;
let stripSync: StripSync | null = null;
let automationSync: AutomationSync | null = null;
let midiSync: MidiSync | null = null;
let transportSync: TransportSync | null = null;
/** Number of clips scheduled by the last apply (display only). */
const scheduledCount = ref(0);
/** True while edits exist that have not been bounced to the engine yet. */
const applyPending = ref(false);

let applyGeneration = 0;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-bounces every audible project clip and swaps the set into the engine,
 * replacing the previously scheduled clips. Stale async results (superseded
 * by a newer apply or an engine restart) are discarded.
 */
async function applyToEngine(): Promise<void> {
  const h = handle.value;
  if (!h || !store.initialized) return;
  const generation = ++applyGeneration;
  applyPending.value = false;
  try {
    const next = await scheduleProjectClips(h);
    if (generation !== applyGeneration || handle.value !== h) {
      for (const clip of next) h.engine.removeClip(clip.engineClipId);
      return;
    }
    for (const clip of scheduledClips) h.engine.removeClip(clip.engineClipId);
    scheduledClips = next;
    scheduledCount.value = next.length;
  } catch (err) {
    errorMessage.value = describeError(err);
  }
}

/** Schedules a debounced bounce after the latest edit settles. */
function scheduleApply(): void {
  if (!handle.value) return;
  applyPending.value = true;
  if (applyTimer !== null) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    void applyToEngine();
  }, APPLY_DEBOUNCE_MS);
}

/**
 * Mirrors mixer state onto the engine immediately — no re-bounce needed:
 * levels and routing (volume, pan, solo/mute, master gain/pan) go to the
 * mixer lanes, strip DSP (inserts/EQ) and buses/sends go to the engine
 * channel strips. Lane declaration order matters, so the lane sync runs
 * before the strip sync.
 */
function syncMixerState(): void {
  if (!mixerSync || !stripSync || !store.initialized) return;
  mixerSync.sync(store.tracks, store.mixer.master);
  stripSync.sync(store.tracks, store.mixer);
}

/**
 * Mirrors automation lanes onto the engine's reserved mixer parameters. Runs
 * after syncMixerState so lanes for newly declared tracks resolve against the
 * engine's lane registry.
 */
function syncAutomationState(): void {
  if (!automationSync || !store.initialized) return;
  automationSync.sync(store.automationLanes);
}

/**
 * Resolves a track's live meter source: the engine emits one meter record per
 * mixer lane (target id = lane index + 1), and the lane order is whatever the
 * mixer sync declared. Null until the engine runs or the track has no lane.
 */
function trackMeterSource(trackId: number): MeterSource | null {
  const b = bridge.value;
  const sync = mixerSync;
  if (!b || !sync) return null;
  const laneIndex = sync.laneTrackIds().indexOf(trackId);
  return laneIndex >= 0 ? b.forTarget(laneIndex + 1) : null;
}

/** The project tempo map (a single constant segment when none is defined). */
function effectiveTempoSegments(): { startPpq: number; bpm: number; endBpm?: number }[] {
  return store.tempoSegments.length > 0
    ? store.tempoSegments.map((segment) => ({ ...segment }))
    : [{ startPpq: 0, bpm: store.tempoBpm }];
}

/**
 * Mirrors the musical timeline onto the engine: tempo segments, time
 * signatures and markers. Also hands the tempo map to the transport so the
 * playhead PPQ conversion matches the engine's timing exactly.
 */
function syncTransportState(): void {
  if (!transportSync || !store.initialized) return;
  transportSync.sync(store.tempoSegments, store.timeSignatures, store.markers);
  transport.setTempoMap(effectiveTempoSegments());
}

/** Serializes async MIDI syncs so rapid edits cannot interleave out of order. */
let midiSyncQueue: Promise<void> = Promise.resolve();

/**
 * Mirrors MIDI content onto the engine immediately: track instruments and the
 * compiled MIDI clip schedules. Note edits, instrument changes and tempo
 * changes all land here — no re-bounce. Instrument swaps are stop-gated by
 * the engine itself (they apply when playback stops).
 */
function syncMidiState(): void {
  const m = midiSync;
  if (!m || !store.initialized) return;
  midiSyncQueue = midiSyncQueue
    .then(() => m.sync(store.tracks, store.clips, effectiveTempoSegments()))
    .catch((err) => {
      errorMessage.value = describeError(err);
    });
}

/**
 * The audio-bounce identity of a track: id and kind. Everything else —
 * instrument, mixer levels, strip DSP — is realtime engine state.
 */
function trackScheduleKey(track: EditorTrack): string {
  return `${track.id}|${track.kind}`;
}

/**
 * The scheduling-relevant identity of a clip. The display name is excluded;
 * everything else (position, content, gain, fades, asset) feeds either the
 * audio bounce or the realtime MIDI schedule.
 */
function clipScheduleKey(clip: EditorClip): string {
  const { name: _name, ...rest } = clip;
  return JSON.stringify(rest);
}

// The mirror arrays are replaced wholesale per command (including by
// store.refresh()), so identity-based watches would fire on every edit.
// The watchers therefore compare content keys. Only AUDIO clip content
// re-bounces; MIDI clips, instruments and tempo mirror to the engine's
// realtime MIDI schedule, and mixer state (levels, strip DSP, buses/sends)
// mirrors to the engine mixer — none of those re-schedule.
watch(
  () => store.clips.filter(isAudioClip).map(clipScheduleKey).join('\n'),
  (next, prev) => {
    if (next !== prev) scheduleApply();
  },
);
watch(
  () => store.tracks.map(trackScheduleKey).join('\n'),
  (next, prev) => {
    if (next !== prev) scheduleApply();
  },
);
watch(
  () =>
    [
      store.clips
        .filter((clip) => !isAudioClip(clip))
        .map(clipScheduleKey)
        .join('\n'),
      store.tracks
        .map((track) => `${track.id}|${JSON.stringify(track.instrument ?? null)}`)
        .join('\n'),
      JSON.stringify(effectiveTempoSegments()),
    ].join(' '),
  (next, prev) => {
    if (next !== prev) syncMidiState();
  },
);
// Automation re-syncs right after the mixer sync so lanes addressing tracks
// that the mixer sync just declared resolve to valid engine parameter ids.
watch(
  () => store.tracks,
  () => {
    syncMixerState();
    syncAutomationState();
  },
);
watch(
  () => store.mixer,
  () => {
    syncMixerState();
    syncAutomationState();
  },
);
watch(
  () => JSON.stringify(store.automationLanes),
  (next, prev) => {
    if (next !== prev) syncAutomationState();
  },
);
watch(
  () =>
    [
      JSON.stringify(store.tempoSegments),
      JSON.stringify(store.timeSignatures),
      JSON.stringify(store.markers),
    ].join('|'),
  (next, prev) => {
    if (next !== prev) syncTransportState();
  },
);

/** Applies the pending edits to the engine immediately. */
function applyNow(): void {
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  void applyToEngine();
}

// --- Live note preview -------------------------------------------------------

/**
 * Plays a short single-note preview. When the active track is a MIDI track,
 * the note goes through the engine's live MIDI input — it sounds through the
 * track's own instrument and channel strip, whether the transport plays or
 * not. Otherwise (audio track, no engine) it falls back to a prerendered
 * one-shot buffer on the AudioContext.
 */
async function previewNote(pitch: number, velocity: number): Promise<void> {
  const h = handle.value;
  if (!h) return;
  const activeTrack = store.tracks.find((track) => track.id === store.activeTrackId);
  if (activeTrack && activeTrack.kind === 'midi' && midiSync) {
    const durationMs = (PREVIEW_DURATION_PPQ * 60000) / Math.max(1, store.tempoBpm);
    try {
      h.engine.pushMidiNoteOn(activeTrack.id, 0, 0, pitch, velocity);
      setTimeout(() => {
        try {
          h.engine.pushMidiNoteOff(activeTrack.id, 0, 0, pitch);
        } catch {
          // The engine may be disposed before the note-off timer fires.
        }
      }, durationMs);
    } catch (err) {
      errorMessage.value = describeError(err);
    }
    return;
  }
  const phrase: MidiNote[] = [
    { note: pitch, velocity, startPpq: 0, durationPpq: PREVIEW_DURATION_PPQ },
  ];
  try {
    const channels = await prerenderMidiClip(phrase, { sampleRate: h.ctx.sampleRate });
    if (channels.length === 0 || channels[0].length === 0 || handle.value !== h) return;
    const buffer = h.ctx.createBuffer(channels.length, channels[0].length, h.ctx.sampleRate);
    for (let i = 0; i < channels.length; i++) {
      buffer.getChannelData(i).set(channels[i]);
    }
    const gain = h.ctx.createGain();
    gain.gain.value = normalizeGain(peakAmplitude(channels), PREVIEW_TARGET_PEAK);
    const source = h.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain).connect(h.ctx.destination);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  } catch (err) {
    errorMessage.value = describeError(err);
  }
}

// --- Music typing / step input / Web MIDI ------------------------------------

const musicTyping = useMusicTyping({
  onNoteOn: ({ pitch, velocity }) => {
    void previewNote(pitch, velocity);
  },
  stepInput,
});

function toggleMusicTyping(): void {
  if (musicTyping.enabled.value) musicTyping.disable();
  else musicTyping.enable();
}

function toggleStepInput(): void {
  if (stepInput.armed.value) stepInput.disarm();
  else stepInput.arm(positionPpq.value);
}

const webMidi = useWebMidi({
  onNoteOn: ({ pitch, velocity }) => {
    void previewNote(pitch, velocity);
    stepInput.enterNote(pitch, velocity);
  },
});

// Routing target for bindWebMidi. The realtime AudioWorklet engine is not
// exposed by the SonareEngine facade, so the binding feeds a detached
// RealtimeEngine instance; audibility comes from the preview/step callbacks.
let midiRoutingEngine: RealtimeEngine | null = null;

function connectWebMidi(): Promise<void> {
  return runAction(async () => {
    const wasm = await ensureWasm();
    if (!midiRoutingEngine) midiRoutingEngine = new wasm.RealtimeEngine();
    const ok = await webMidi.connect(midiRoutingEngine);
    if (!ok) {
      errorMessage.value = webMidi.error.value ?? 'Web MIDI is unavailable in this browser.';
    }
  });
}

// --- Engine ------------------------------------------------------------------

/** Creates the engine and meter bridge (requires a user gesture for the AudioContext). */
function startEngine(): Promise<void> {
  return runAction(async () => {
    if (handle.value) return;
    const h = await createEngine();
    handle.value = h;
    mixerSync = createMixerSync(h);
    const wasm = (await ensureWasm()) as unknown as { masteringInsertNames?: () => string[] };
    const insertCatalog =
      typeof wasm.masteringInsertNames === 'function' ? new Set(wasm.masteringInsertNames()) : null;
    stripSync = createStripSync(h, { insertCatalog });
    automationSync = createAutomationSync(h, {
      knownTrackIds: () => mixerSync?.laneTrackIds() ?? [],
      // Clearing an engine lane leaves the strip at the last automated value;
      // re-push the manual value the same way the mixer sync derives it.
      restoreParam: (target, param) => {
        if (target === 'master') {
          if (param === 'faderDb') h.engine.setStripGain('master', store.mixer.master.gainDb);
          else h.engine.setStripPan('master', clampPan(store.mixer.master.pan));
          return;
        }
        const track = store.tracks.find((entry) => entry.id === target);
        if (!track) return;
        if (param === 'faderDb') {
          h.engine.setStripGain(target, linearToDb(track.volume) + (track.mixer?.gainDb ?? 0));
        } else {
          h.engine.setStripPan(target, clampPan(track.mixer?.pan ?? 0));
        }
      },
    });
    midiSync = createMidiSync(h, {
      resolvePreset: (preset) => resolvePresetName(wasm as never, preset),
    });
    transportSync = createTransportSync(h);
    bridge.value = createMeterBridge(h);
    ctxState.value = h.ctx.state;
    h.ctx.addEventListener('statechange', () => {
      ctxState.value = h.ctx.state;
    });
    // A worklet crash during process() is otherwise silent — surface it.
    h.engine.node.onprocessorerror = () => {
      errorMessage.value = 'Engine worklet processor crashed during processing (onprocessorerror).';
    };
    if (bootPromise) await bootPromise;
    await store.init({ sampleRate: h.ctx.sampleRate });
    transport.setTempo(store.tempoBpm);
    syncMixerState();
    syncAutomationState();
    syncTransportState();
    syncMidiState();
    await applyToEngine();
  });
}

/** Plays a plain oscillator beep directly into the destination, bypassing the engine. */
function playTestTone(): Promise<void> {
  return runAction(async () => {
    const h = handle.value;
    if (!h) throw new Error('Start the engine first.');
    if (h.ctx.state === 'suspended') await h.ctx.resume();
    const osc = h.ctx.createOscillator();
    const gain = h.ctx.createGain();
    gain.gain.value = 0.2;
    osc.frequency.value = 440;
    osc.connect(gain).connect(h.ctx.destination);
    osc.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    osc.stop();
    osc.disconnect();
    gain.disconnect();
  });
}

/** Renders a few seconds offline and reports channel count + lengths (stereo check). */
function renderOffline(): Promise<void> {
  return runAction(async () => {
    const h = handle.value;
    if (!h) throw new Error('Start the engine first.');
    const seconds = 3;
    const frames = Math.round(h.ctx.sampleRate * seconds);
    const buffers = await h.engine.renderOffline(frames);
    const lengths = buffers.map((b) => b.length).join(', ');
    renderInfo.value = `${buffers.length} channel(s), lengths [${lengths}] (${seconds}s @ ${h.ctx.sampleRate} Hz)`;
    console.info('renderOffline result:', buffers.length, 'channels', buffers);
  });
}

// --- Transport bar -----------------------------------------------------------

function togglePlayback(): void {
  if (isPlaying.value) transport.stop();
  else transport.play();
}

// Stopping the transport ends touch recording: strips left in 'write' fall
// back to 'read' so resumed playback follows the recorded lanes.
watch(isPlaying, (playing) => {
  if (!playing) disengageAutomationWriteModes();
});

/**
 * Commits the tempo input to the project tempo map (first segment) so the
 * change is undoable and persisted; the transport follows via the
 * store.tempoBpm watcher below.
 */
function applyTempo(): void {
  const bpm = Number(tempoInput.value);
  if (!Number.isFinite(bpm) || bpm <= 0) return;
  if (!store.initialized) {
    transport.setTempo(bpm);
    return;
  }
  try {
    const segments =
      store.tempoSegments.length > 0
        ? store.tempoSegments.map((segment, index) =>
            index === 0 ? { ...segment, bpm } : { ...segment },
          )
        : [{ startPpq: 0, bpm }];
    setTempoSegments(segments);
  } catch (err) {
    errorMessage.value = describeError(err);
  }
}

// The project tempo map is authoritative: edits from the tempo input, the
// lists editor, undo/redo and project loads all land here, then drive the
// transport rate, the audio re-bounce (clip windows are sliced at the
// tempo) and the realtime MIDI re-bake (via the MIDI content watcher).
watch(
  () => store.tempoBpm,
  (bpm) => {
    tempoInput.value = bpm;
    if (handle.value) {
      transport.setTempo(bpm);
      syncTransportState();
      scheduleApply();
    }
  },
);

function toggleLoop(): void {
  const endPpq = Math.max(8, ...store.clips.map((clip) => clip.startPpq + clip.lengthPpq));
  transport.setLoop(0, endPpq, !loopEnabled.value);
}

function formatSeconds(s: number): string {
  return s.toFixed(2);
}

/** Seek requests from the arrangement ruler/sections, score and marker list. */
function onSeek(ppq: number): void {
  transport.seekPpq(ppq);
}

// --- Layout: arrangement/editor split ------------------------------------------

/** localStorage key persisting the arrangement zone height. */
const ARRANGE_HEIGHT_KEY = 'sonare-studio.arrangeHeightPx';
const ARRANGE_MIN_HEIGHT = 120;
const ARRANGE_DEFAULT_HEIGHT = 260;

function readStoredArrangeHeight(): number {
  try {
    const value = Number(window.localStorage.getItem(ARRANGE_HEIGHT_KEY));
    if (Number.isFinite(value) && value >= ARRANGE_MIN_HEIGHT) return value;
  } catch {
    // Storage access can be denied; fall through to the default.
  }
  return ARRANGE_DEFAULT_HEIGHT;
}

/** Arrangement zone height in px (the editor dock takes the rest). */
const arrangeHeight = ref(readStoredArrangeHeight());

let dividerDrag: { startY: number; startHeight: number } | null = null;
let dividerRaf = 0;
let dividerPendingY = 0;

/** Largest height the split allows for the current window. */
function maxArrangeHeight(): number {
  return Math.max(ARRANGE_MIN_HEIGHT, window.innerHeight - 240);
}

function clampArrangeHeight(next: number): number {
  return Math.min(maxArrangeHeight(), Math.max(ARRANGE_MIN_HEIGHT, next));
}

function persistArrangeHeight(): void {
  try {
    window.localStorage.setItem(ARRANGE_HEIGHT_KEY, String(Math.round(arrangeHeight.value)));
  } catch {
    // Persisting the height is best-effort only.
  }
}

function onDividerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dividerDrag = { startY: event.clientY, startHeight: arrangeHeight.value };
}

// Pointer moves are coalesced to one height write per animation frame: each
// write changes flexBasis and reflows both canvas zones, so writing on every
// pointer event would trigger repeated canvas backing-store reallocations.
function onDividerPointerMove(event: PointerEvent): void {
  if (!dividerDrag) return;
  dividerPendingY = event.clientY;
  if (dividerRaf !== 0) return;
  dividerRaf = requestAnimationFrame(() => {
    dividerRaf = 0;
    if (!dividerDrag) return;
    arrangeHeight.value = clampArrangeHeight(
      dividerDrag.startHeight + (dividerPendingY - dividerDrag.startY),
    );
  });
}

function onDividerPointerUp(): void {
  if (!dividerDrag) return;
  dividerDrag = null;
  if (dividerRaf !== 0) {
    cancelAnimationFrame(dividerRaf);
    dividerRaf = 0;
  }
  persistArrangeHeight();
}

/** Keyboard resize for the split divider (role=separator). */
function onDividerKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 4 : 16;
  let delta = 0;
  if (event.key === 'ArrowUp') delta = -step;
  else if (event.key === 'ArrowDown') delta = step;
  else return;
  event.preventDefault();
  arrangeHeight.value = clampArrangeHeight(arrangeHeight.value + delta);
  persistArrangeHeight();
}

// --- Right zone: device rack ---------------------------------------------------

/** localStorage key persisting the device-rack panel visibility. */
const DEVICE_RACK_OPEN_KEY = 'sonare-studio.deviceRackOpen';

function readStoredDeviceRackOpen(): boolean {
  try {
    return window.localStorage.getItem(DEVICE_RACK_OPEN_KEY) === '1';
  } catch {
    // Storage access can be denied; start collapsed.
    return false;
  }
}

/** Whether the device-rack panel on the right side is shown. */
const deviceRackOpen = ref(readStoredDeviceRackOpen());

function toggleDeviceRack(): void {
  deviceRackOpen.value = !deviceRackOpen.value;
  try {
    window.localStorage.setItem(DEVICE_RACK_OPEN_KEY, deviceRackOpen.value ? '1' : '0');
  } catch {
    // Persisting the panel state is best-effort only.
  }
}

// --- Editor dock tabs ----------------------------------------------------------

type DockTab = 'roll' | 'mixer' | 'mastering' | 'steps' | 'lists' | 'media' | 'sample';

/** Active editor-dock tab. */
const dockTab = ref<DockTab>('roll');

/** Whether the read-only score panel is shown below the piano roll. */
const scoreVisible = ref(false);

function toggleScorePanel(): void {
  scoreVisible.value = !scoreVisible.value;
  if (scoreVisible.value) dockTab.value = 'roll';
}

// --- Settings, shortcut help, named layouts, welcome tour -----------------------

const settingsOpen = ref(false);
const helpOpen = ref(false);
const helpMenuOpen = ref(false);
const helpMenuRoot = ref<HTMLElement | null>(null);
const layoutMenuOpen = ref(false);
const layoutMenuRoot = ref<HTMLElement | null>(null);
const tourRef = ref<InstanceType<typeof WelcomeTour> | null>(null);

const namedLayouts = useLayouts();

/** Shell layout refs handed to the named-layout feature and settings dialog. */
const layoutBindings: LayoutBindings = {
  arrangeHeightPx: arrangeHeight,
  dockTab,
  deviceRackOpen,
  scoreOpen: scoreVisible,
};

/** Applies a named layout and persists the keys the shell already stores. */
function applyNamedLayout(name: string): void {
  layoutMenuOpen.value = false;
  if (!namedLayouts.apply(name, layoutBindings)) return;
  persistArrangeHeight();
  try {
    window.localStorage.setItem(DEVICE_RACK_OPEN_KEY, deviceRackOpen.value ? '1' : '0');
  } catch {
    // Persisting the panel state is best-effort only.
  }
}

/** "Save current…" in the Layout menu: snapshots the zones under a new name. */
function saveCurrentLayoutAction(): void {
  layoutMenuOpen.value = false;
  const name = window.prompt('Save layout as:')?.trim();
  if (!name) return;
  if (!namedLayouts.saveCurrent(name, layoutBindings)) {
    errorMessage.value = namedLayouts.isPreset(name)
      ? `"${name}" is a built-in preset name; choose another.`
      : 'Could not save the layout (too many saved layouts).';
  }
}

function openShortcutsHelp(): void {
  helpMenuOpen.value = false;
  helpOpen.value = true;
}

function openWelcomeTour(): void {
  helpMenuOpen.value = false;
  tourRef.value?.open();
}

/** Welcome tour stops, anchored to stable shell selectors. */
const TOUR_STEPS: TourStep[] = [
  {
    id: 'engine',
    target: '.engine-start',
    title: 'Start the engine',
    body: 'Opens the audio device. Nothing sounds yet — playback only begins when you press Play.',
  },
  {
    id: 'transport',
    target: '.transport-bar',
    title: 'Transport bar',
    body: 'Play, record, tempo, loop, layouts and the project menu live here.',
  },
  {
    id: 'arrange',
    target: '.arrange-zone',
    title: 'Arrangement',
    body: 'Tracks and clips on the timeline. Double-click an empty lane to create a clip.',
  },
  {
    id: 'dock',
    target: '.dock-tabs',
    title: 'Editor dock',
    body: 'Switch between the piano roll, mixer, mastering, step sequencer and more.',
    placement: 'top',
  },
  {
    id: 'roll',
    target: '.piano-roll-host',
    title: 'Piano roll',
    body: 'Double-click to create notes, drag to move or resize them. Every edit is undoable.',
    placement: 'top',
  },
  {
    id: 'score',
    target: '.dock-tab-score',
    title: 'Score view',
    body: 'Engraves the active clip as notation — display-only, your MIDI never changes.',
    placement: 'top',
  },
  {
    id: 'menu',
    target: '.project-menu',
    title: 'Project menu',
    body: 'New, open, save, audio import and all export options.',
  },
];

function selectAllNotes(): void {
  if (!store.initialized) return;
  setSelection(store.notes.map((note) => note.id));
}

function deleteSelectedNotes(): void {
  if (store.selection.size === 0) return;
  deleteNotes([...store.selection]);
}

// --- Editor toolbar ----------------------------------------------------------

/** Snap grid choices as divisions per whole note. */
const SNAP_CHOICES = [
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8, label: '1/8' },
  { value: 16, label: '1/16' },
  { value: 32, label: '1/32' },
];

// --- App-level keyboard shortcuts ---------------------------------------------

/**
 * Last zone the user pressed into; disambiguates shared shortcuts (Delete,
 * Cmd+D, B) between arrangement clips and piano-roll notes.
 */
const focusZone = ref<'arrange' | 'editor'>('editor');

const arrangementRef = ref<InstanceType<typeof ArrangementView> | null>(null);

/** True when the event originates from a text-editing element. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Runs the shell action bound to a shortcut registry id.
 *
 * @returns True when the action ran (the caller prevents the default); false
 *   when its guard failed and the key should fall through untouched.
 */
function runShortcutAction(actionId: string): boolean {
  switch (actionId) {
    case 'transport.togglePlayback':
      togglePlayback();
      return true;
    case 'transport.toggleLoop':
      toggleLoop();
      return true;
    case 'project.save':
      saveProjectAction();
      return true;
    case 'edit.undo':
      undo();
      return true;
    case 'edit.redo':
      redo();
      return true;
    case 'edit.selectAllNotes':
      selectAllNotes();
      return true;
    case 'edit.quantizeSelection':
      quantizeSelection();
      return true;
    case 'edit.deleteSelectedNotes':
      if (store.selection.size === 0) return false;
      deleteSelectedNotes();
      return true;
    case 'arrange.duplicateClip': {
      // Duplicate the selected arrangement clip right after itself.
      const clip = store.activeClip;
      if (!clip) return false;
      duplicateClip(clip.id, clip.startPpq + clip.lengthPpq);
      return true;
    }
    case 'arrange.splitClipAtPlayhead':
      arrangementRef.value?.cutAtPlayhead();
      return true;
    case 'arrange.deleteClip':
      if (store.clipId === -1) {
        // No clip selected: fall through to the note selection, preserving
        // the historic Backspace behavior in the arrangement zone.
        if (store.selection.size === 0) return false;
        deleteSelectedNotes();
        return true;
      }
      deleteClip(store.clipId);
      return true;
    case 'view.toggleSnap':
      store.snapEnabled = !store.snapEnabled;
      return true;
    case 'view.toggleScorePanel':
      toggleScorePanel();
      return true;
    case 'app.settings':
      settingsOpen.value = true;
      return true;
    case 'help.shortcuts':
      helpOpen.value = true;
      return true;
    default:
      return false;
  }
}

/**
 * Global shortcuts, resolved through the remappable registry. Events already
 * consumed closer to their target (piano roll undo/delete, music typing keys,
 * dialog keys) arrive with defaultPrevented and are skipped, so nothing fires
 * twice. The focus zone picks the scope so shared keys (Delete, Cmd+D, B)
 * disambiguate between arrangement clips and piano-roll notes.
 */
function onGlobalKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || isEditableTarget(event.target)) return;
  const scope = focusZone.value === 'arrange' ? 'arrangement' : 'editor';
  const actionId = shortcuts.match(event, scope);
  if (actionId === null) return;
  if (runShortcutAction(actionId)) event.preventDefault();
}

// --- Lifecycle ----------------------------------------------------------------

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('pointerdown', onWindowPointerDown);
  if (import.meta.env.DEV) {
    // Test hook for browser automation (dev builds only).
    (window as { __sonareDebug?: unknown }).__sonareDebug = {
      noteCount: () => store.notes.length,
      selectionCount: () => store.selection.size,
      initialized: () => store.initialized,
      trackCount: () => store.tracks.length,
      trackIds: () => store.tracks.map((track) => track.id),
      clipCount: () => store.clips.length,
      clipKinds: () => store.clips.map((clip) => clipKind(clip)),
      audioClipCount: () => store.clips.filter((clip) => isAudioClip(clip)).length,
      armedTrackId: () => recording.armedTrackId.value,
      isRecording: () => recording.isRecording.value,
      inputLevel: () => recording.inputLevel.value,
      setInputMonitor: (enabled: boolean) => recording.setMonitor(enabled),
      projectName: () => store.projectName,
      activeTrackId: () => store.activeTrackId,
      activeClipId: () => store.clipId,
      applyPending: () => applyPending.value,
      scheduledClipIds: () => scheduledClips.map((clip) => clip.engineClipId),
      engineMidiClipCount: () => midiSync?.scheduledClipCount() ?? 0,
      trackInstruments: () =>
        store.tracks.map((track) =>
          track.instrument === undefined
            ? null
            : track.instrument.kind === 'synth-preset'
              ? track.instrument.preset
              : track.instrument.kind,
        ),
      trackInsertCounts: () => store.tracks.map((track) => track.mixer?.inserts.length ?? 0),
      trackInsertStates: () =>
        store.tracks.map((track) => (track.mixer?.inserts ?? []).map((slot) => slot.enabled)),
      masterInsertCount: () => store.mixer.master.inserts.length,
      addMasterInsert: (processor: string, params?: Record<string, number | boolean>) =>
        addInsert('master', processor, params),
      setMasterInsertEnabled: (index: number, enabled: boolean) =>
        setInsertEnabled('master', index, enabled),
      removeMasterInsert: (index: number) => removeInsert('master', index),
      masteringProcessors: () =>
        (store.mixer.masteringChain?.processors ?? []).map((slot) => slot.processor),
      lastDownload: () => lastDownload,
      // Renders the project mixdown through the export worker and returns an
      // audio signature, so automation can verify the real render path and
      // that toggling the master chain changes the bytes.
      exportProbe: async (
        includeMasterChain = true,
        range?: { startPpq: number; endPpq: number },
        stems = false,
      ) => {
        const result = await renderMixdownInWorker(serializeProject(), {
          includeMasterChain,
          ...(range !== undefined ? { range } : {}),
          ...(stems ? { stems } : {}),
        }).result;
        const wav = encodeWav(result.channels, result.sampleRate, { bitDepth: 16 });
        let hash = 0x811c9dc5;
        for (const byte of wav) hash = Math.imul(hash ^ byte, 0x01000193);
        const peakOf = (channels: Float32Array[]) => {
          let peak = 0;
          for (const channel of channels) {
            for (const sample of channel) {
              const a = Math.abs(sample);
              if (a > peak) peak = a;
            }
          }
          return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
        };
        return {
          totalFrames: result.totalFrames,
          sampleRate: result.sampleRate,
          peakDb: result.report.peakDb,
          truePeakDb: result.report.truePeakDb ?? null,
          lufs: result.report.lufs ?? null,
          wavBytes: wav.length,
          riff: String.fromCharCode(wav[0], wav[1], wav[2], wav[3]),
          hash: (hash >>> 0).toString(16),
          stems:
            result.stems?.map((stem) => ({
              trackIndex: stem.trackIndex,
              name: stem.name,
              peakDb: peakOf(stem.channels),
            })) ?? null,
        };
      },
      meterPeakDb: () => {
        const latest = bridge.value?.latest;
        return latest ? Math.max(latest.peakDbL, latest.peakDbR) : null;
      },
      trackMeterDb: (trackId: number) => {
        const source = trackMeterSource(trackId);
        return source ? Math.max(source.latest.peakDbL, source.latest.peakDbR) : null;
      },
      masterLufs: () => bridge.value?.latest.momentaryLufs ?? null,
      positionPpq: () => positionPpq.value,
      setTempoSegments: (segments: { startPpq: number; bpm: number }[]) =>
        setTempoSegments(segments),
      setLoopRange: (startPpq: number, endPpq: number, enabled: boolean) =>
        transport.setLoop(startPpq, endPpq, enabled),
      setAutomationLanePoints: (
        target: number | 'master',
        param: AutomationParam,
        points: AutomationPoint[],
      ) => setAutomationLanePoints(target, param, points),
      removeAutomationLane: (target: number | 'master', param: AutomationParam) =>
        removeAutomationLane(target, param),
      automationLanePoints: (target: number | 'master', param: AutomationParam) =>
        store.automationLanes.find((lane) => lane.target === target && lane.param === param)
          ?.points ?? [],
      stripAutomationMode: (target: number | 'master') => automationStripMode(target),
      setStripAutomationMode: (target: number | 'master', mode: AutomationStripMode) =>
        setAutomationStripMode(target, mode),
      automationLaneCount: () => handle.value?.engine.automationLaneCount() ?? 0,
      automationInstalledParamIds: () => automationSync?.installedParamIds() ?? [],
      seekPpq: (ppq: number) => transport.seekPpq(ppq),
      addAudioTrack: (name?: string) => addAudioTrack(name !== undefined ? { name } : {}),
      removeTrack: (trackId: number) => removeTrack(trackId),
      armTrack: (trackId: number | null) => recording.arm(trackId),
      clipTakesInfo: (trackId: number) =>
        store.clips
          .filter((clip) => clip.trackId === trackId && isAudioClip(clip))
          .map((clip) => ({
            clipId: clip.id,
            startPpq: clip.startPpq,
            lengthPpq: clip.lengthPpq,
            takeCount: clip.takes?.length ?? 0,
            segments: (clip.compSegments ?? []).map((segment) => ({ ...segment })),
          })),
      setClipTakes: (clipId: number, takes: { assetId: string; name: string }[], active?: number) =>
        setClipTakes(clipId, takes, active),
      setClipActiveTake: (clipId: number, takeIndex: number) =>
        setClipActiveTake(clipId, takeIndex),
      setClipCompSegments: (clipId: number, segments: { startPpq: number; takeIndex: number }[]) =>
        setClipCompSegments(clipId, segments),
      flattenClipComp: (clipId: number) => flattenClipComp(clipId),
      ingestToneAsset: async (seconds: number, frequencyHz: number, amplitude: number) => {
        const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
        const frames = Math.round(seconds * sampleRate);
        const data = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          data[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
        }
        const meta = await ingestAudioBuffer([data], sampleRate, `tone-${frequencyHz}`, {
          analysis: null,
        });
        return meta.id;
      },
      addMixerBus: (name?: string) => addMixerBus(name !== undefined ? { name } : {}),
      removeMixerBus: (busId: string) => removeMixerBus(busId),
      setSend: (
        target: number | 'master',
        busId: string,
        send: { levelDb: number; enabled?: boolean } | null,
      ) => setSend(target, busId, send),
      // Renders one note with the given synth preset and returns an audio
      // signature, so automation can verify two presets produce different sound.
      renderProbe: async (preset: string) => {
        const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
        const channels = await prerenderMidiClip(
          [{ note: 60, velocity: 100, startPpq: 0, durationPpq: 0.5 }],
          { sampleRate, preset },
        );
        let sum = 0;
        let count = 0;
        // FNV-1a over the samples quantized to 16 bit, so float noise does
        // not destabilize the signature.
        let hash = 0x811c9dc5;
        for (const channel of channels) {
          for (const sample of channel) {
            sum += Math.abs(sample);
            count += 1;
            const q = Math.max(-32768, Math.min(32767, Math.round(sample * 32767))) & 0xffff;
            hash = Math.imul(hash ^ (q & 0xff), 0x01000193);
            hash = Math.imul(hash ^ (q >> 8), 0x01000193);
          }
        }
        return {
          frames: channels[0]?.length ?? 0,
          peak: peakAmplitude(channels),
          mean: count > 0 ? sum / count : 0,
          hash: (hash >>> 0).toString(16),
        };
      },
    };
  }
  try {
    const wasm = await ensureWasm();
    version.value = wasm.version();
    bootPromise = bootProject();
    await bootPromise;
  } catch (err) {
    errorMessage.value = describeError(err);
  }
});

onBeforeUnmount(async () => {
  window.removeEventListener('keydown', onGlobalKeyDown);
  window.removeEventListener('pointerdown', onWindowPointerDown);
  openDialogTrap?.deactivate();
  openDialogTrap = null;
  if (dividerRaf !== 0) {
    cancelAnimationFrame(dividerRaf);
    dividerRaf = 0;
  }
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  bridge.value?.dispose();
  bridge.value = null;
  mixerSync = null;
  stripSync = null;
  automationSync = null;
  midiSync = null;
  transportSync = null;
  await handle.value?.dispose();
  handle.value = null;
});
</script>

<template>
  <div class="app-shell">
    <header class="transport-bar">
      <span class="app-title">sonare studio</span>
      <div ref="projectMenuRoot" class="project-menu" @keydown.escape="closeProjectMenu">
        <button
          type="button"
          class="menu-trigger"
          aria-haspopup="menu"
          :aria-expanded="projectMenuOpen"
          @click="projectMenuOpen = !projectMenuOpen"
        >
          Project ▾
        </button>
        <div v-if="projectMenuOpen" class="menu-pop" role="menu" aria-label="Project menu">
          <button type="button" role="menuitem" @click="openNewDialog">New…</button>
          <button type="button" role="menuitem" :disabled="!opfsAvailable" @click="openOpenDialog">
            Open…
          </button>
          <button
            type="button"
            class="menu-save"
            role="menuitem"
            :disabled="!opfsAvailable"
            title="Save to browser storage (Cmd+S)"
            @click="saveProjectAction"
          >
            Save
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!opfsAvailable"
            @click="saveProjectAsAction"
          >
            Save As…
          </button>
          <hr class="menu-rule" />
          <button type="button" role="menuitem" @click="importAudioAction">Import audio…</button>
          <hr class="menu-rule" />
          <button type="button" role="menuitem" @click="exportSzdAction">Export .szd</button>
          <button type="button" role="menuitem" @click="exportSmfAction">Export SMF</button>
          <button type="button" role="menuitem" @click="openExportDialog">Export Audio…</button>
          <button type="button" role="menuitem" @click="exportDawprojectAction">
            Export DAWproject
          </button>
        </div>
      </div>
      <input
        ref="audioImportInput"
        class="hidden-file-input"
        type="file"
        multiple
        accept="audio/*"
        aria-hidden="true"
        tabindex="-1"
        @change="onAudioImportChange"
      />
      <span class="project-name" :title="store.projectName">
        {{ store.projectName }}<span v-if="dirty" class="dirty-dot" title="Unsaved changes">•</span>
      </span>
      <button
        type="button"
        class="engine-start"
        :disabled="busy || handle !== null"
        @click="startEngine"
      >
        Start engine
      </button>
      <button type="button" :disabled="!handle" @click="togglePlayback">
        {{ isPlaying ? 'Stop' : 'Play' }}
      </button>
      <div ref="recordMenuRoot" class="record-group" @keydown.escape="recordMenuOpen = false">
        <button
          type="button"
          class="record-button"
          :class="{
            recording: recording.isRecording.value,
            'counting-in': recording.isCountingIn.value,
          }"
          aria-label="Record"
          :aria-pressed="recording.isRecording.value"
          :disabled="!handle || (!recording.isRecording.value && recording.armedTrackId.value === null)"
          :title="
            recording.isRecording.value
              ? 'Stop recording (the take lands as a clip)'
              : 'Record onto the armed audio track'
          "
          @click="toggleRecord"
        >
          ●
        </button>
        <button
          type="button"
          class="record-settings"
          aria-label="Recording settings"
          aria-haspopup="true"
          :aria-expanded="recordMenuOpen"
          title="Recording settings"
          @click="recordMenuOpen = !recordMenuOpen"
        >
          ▾
        </button>
        <div
          v-if="recordMenuOpen"
          class="menu-pop record-pop"
          role="group"
          aria-label="Recording settings"
        >
          <label class="bar-field">
            <input
              type="checkbox"
              :checked="recording.monitorEnabled.value"
              @change="recording.setMonitor(!recording.monitorEnabled.value)"
            />
            Monitor input
          </label>
          <label class="bar-field">
            Count-in
            <select :value="recording.countInBars.value" @change="onCountInChange">
              <option :value="0">Off</option>
              <option :value="1">1 bar</option>
              <option :value="2">2 bars</option>
              <option :value="3">3 bars</option>
              <option :value="4">4 bars</option>
            </select>
          </label>
        </div>
        <span
          v-if="recording.armedTrackId.value !== null"
          class="input-level"
          title="Microphone input level"
        >
          <span
            class="input-level-fill"
            :style="{ width: `${Math.min(1, recording.inputLevel.value) * 100}%` }"
          />
        </span>
      </div>
      <label class="bar-field">
        Tempo
        <input
          v-model.number="tempoInput"
          type="number"
          min="20"
          max="300"
          step="1"
          class="tempo-input"
          :disabled="!store.initialized"
          @change="applyTempo"
        />
        BPM
      </label>
      <label class="bar-field">
        <input type="checkbox" :checked="loopEnabled" :disabled="!handle" @change="toggleLoop" />
        Loop
      </label>
      <label class="bar-field">
        <input
          type="checkbox"
          :checked="metronomeEnabled"
          :disabled="!handle"
          @change="transport.toggleMetronome()"
        />
        Click
      </label>
      <span class="position-readout">
        {{ formatSeconds(positionSeconds) }} s · {{ positionPpq.toFixed(2) }} PPQ
        <span v-if="isPlaying">▶</span>
      </span>
      <button
        type="button"
        class="devices-toggle"
        :class="{ active: deviceRackOpen }"
        :aria-pressed="deviceRackOpen"
        title="Toggle the device rack panel"
        @click="toggleDeviceRack"
      >
        Devices
      </button>
      <div ref="layoutMenuRoot" class="project-menu" @keydown.escape="layoutMenuOpen = false">
        <button
          type="button"
          class="menu-trigger"
          aria-haspopup="menu"
          :aria-expanded="layoutMenuOpen"
          title="Workspace layouts (presets and saved layouts)"
          @click="layoutMenuOpen = !layoutMenuOpen"
        >
          Layout ▾
        </button>
        <div v-if="layoutMenuOpen" class="menu-pop" role="menu" aria-label="Layout menu">
          <button
            v-for="layout in namedLayouts.layouts.value"
            :key="layout.name"
            type="button"
            role="menuitem"
            @click="applyNamedLayout(layout.name)"
          >
            {{ layout.name }}
          </button>
          <hr class="menu-rule" />
          <button type="button" role="menuitem" @click="saveCurrentLayoutAction">
            Save current…
          </button>
        </div>
      </div>
      <div ref="helpMenuRoot" class="project-menu" @keydown.escape="helpMenuOpen = false">
        <button
          type="button"
          class="menu-trigger"
          aria-haspopup="menu"
          :aria-expanded="helpMenuOpen"
          @click="helpMenuOpen = !helpMenuOpen"
        >
          Help ▾
        </button>
        <div v-if="helpMenuOpen" class="menu-pop" role="menu" aria-label="Help menu">
          <button type="button" role="menuitem" @click="openShortcutsHelp">
            Keyboard shortcuts (?)
          </button>
          <button type="button" role="menuitem" @click="openWelcomeTour">Welcome tour</button>
        </div>
      </div>
      <button
        type="button"
        class="settings-button"
        aria-label="Settings"
        aria-haspopup="dialog"
        title="Settings (Cmd+,)"
        @click="settingsOpen = true"
      >
        ⚙
      </button>
      <span class="bar-spacer" />
      <span v-if="autosave.lastSavedAt.value" class="autosave-state">
        {{ formatSavedAt(autosave.lastSavedAt.value) }}
      </span>
      <LevelMeter :bridge="bridge" :width="120" :height="36" />
    </header>

    <p v-if="errorMessage" class="error-box" role="alert">{{ errorMessage }}</p>

    <main class="main-row">
      <div class="workspace">
      <section
        class="arrange-zone"
        :style="{ flexBasis: `${arrangeHeight}px` }"
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
      </section>

      <div
        class="split-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the arrangement zone"
        :aria-valuenow="Math.round(arrangeHeight)"
        :aria-valuemin="ARRANGE_MIN_HEIGHT"
        :aria-valuemax="ARRANGE_HEIGHT_MAX_PX"
        tabindex="0"
        title="Drag or use the arrow keys to resize the arrangement"
        @pointerdown="onDividerPointerDown"
        @pointermove="onDividerPointerMove"
        @pointerup="onDividerPointerUp"
        @pointercancel="onDividerPointerUp"
        @keydown="onDividerKeydown"
      />

      <section class="editor-dock" @pointerdown.capture="focusZone = 'editor'">
        <div class="dock-tabs" role="tablist" aria-label="Editor panels">
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'roll' }"
            role="tab"
            :aria-selected="dockTab === 'roll'"
            @click="dockTab = 'roll'"
          >
            Piano Roll
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'mixer' }"
            role="tab"
            :aria-selected="dockTab === 'mixer'"
            @click="dockTab = 'mixer'"
          >
            Mixer
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'mastering' }"
            role="tab"
            :aria-selected="dockTab === 'mastering'"
            @click="dockTab = 'mastering'"
          >
            Mastering
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'steps' }"
            role="tab"
            :aria-selected="dockTab === 'steps'"
            @click="dockTab = 'steps'"
          >
            Steps
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'lists' }"
            role="tab"
            :aria-selected="dockTab === 'lists'"
            @click="dockTab = 'lists'"
          >
            Lists
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'media' }"
            role="tab"
            :aria-selected="dockTab === 'media'"
            @click="dockTab = 'media'"
          >
            Media
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'sample' }"
            role="tab"
            :aria-selected="dockTab === 'sample'"
            @click="dockTab = 'sample'"
          >
            Sample
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle dock-tab-score"
            :class="{ active: scoreVisible }"
            :aria-pressed="scoreVisible"
            title="Toggle the score panel (Cmd+E)"
            @click="toggleScorePanel"
          >
            Score
          </button>
        </div>
        <section v-show="dockTab === 'roll'" class="dock-body">
          <div class="editor-toolbar">
            <label class="bar-field">
              Snap
              <select v-model.number="store.snapDivision">
                <option v-for="choice in SNAP_CHOICES" :key="choice.value" :value="choice.value">
                  {{ choice.label }}
                </option>
              </select>
            </label>
            <label class="bar-field" title="Toggle grid snapping (Cmd+G)">
              <input v-model="store.snapEnabled" type="checkbox" />
              Snap on
            </label>
            <button
              type="button"
              :disabled="store.selection.size === 0"
              title="Quantize selected note starts (Q)"
              @click="quantizeSelection()"
            >
              Quantize
            </button>
            <label class="bar-field">
              <input v-model="store.scaleHighlight.enabled" type="checkbox" />
              Scale highlight
            </label>
            <label class="bar-field" title="QWERTY keys play and enter notes">
              <input
                :checked="musicTyping.enabled.value"
                type="checkbox"
                @change="toggleMusicTyping"
              />
              Music typing
            </label>
            <label class="bar-field" title="Entered notes are written at the step cursor">
              <input :checked="stepInput.armed.value" type="checkbox" @change="toggleStepInput" />
              Step input
            </label>
            <span v-if="stepInput.armed.value" class="step-cursor">
              @ {{ stepInput.cursorPpq.value.toFixed(2) }} PPQ
            </span>
            <label class="bar-field">
              MIDI in
              <select v-model="webMidi.selectedInputId.value">
                <option :value="null">All inputs</option>
                <option v-for="input in webMidi.inputs.value" :key="input.id" :value="input.id">
                  {{ input.name ?? input.id }}
                </option>
              </select>
            </label>
            <button
              v-if="!webMidi.connected.value"
              type="button"
              :disabled="busy"
              @click="connectWebMidi"
            >
              Connect MIDI
            </button>
            <button v-else type="button" @click="webMidi.disconnect()">Disconnect MIDI</button>
            <span class="bar-spacer" />
            <button
              type="button"
              :disabled="!handle || !store.initialized"
              title="Bounce all project clips to the engine now"
              @click="applyNow"
            >
              Apply to engine
            </button>
            <span class="apply-state">
              {{ !handle ? 'engine off' : applyPending ? 'pending…' : `${scheduledCount} clip(s)` }}
            </span>
          </div>
          <HintCard
            v-if="!handle"
            class="engine-hint"
            message="The audio engine is off — edits work now, but nothing sounds until it runs and you press Play."
          >
            <template #action>
              <button type="button" :disabled="busy" @click="startEngine">Start engine</button>
            </template>
          </HintCard>
          <InfoLine />
          <PianoRollEditor class="piano-roll-host" :position-ppq="() => positionPpq" />
          <ScorePanel
            v-if="scoreVisible"
            class="score-host"
            :position-ppq="() => positionPpq"
            @seek="onSeek"
          />
        </section>
        <section v-show="dockTab === 'mixer'" class="dock-body">
          <MixerPanel
            class="mixer-host"
            :bridge="bridge"
            :meter-for="trackMeterSource"
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
            title="Sample editor"
            message="Select an audio clip in the arrangement to edit its audio here."
          />
        </section>
      </section>
      </div>

      <aside v-if="deviceRackOpen" class="right-zone" aria-label="Device rack panel">
        <DeviceRack :transport-playing="isPlaying" />
      </aside>
    </main>

    <details class="diagnostics">
      <summary>Diagnostics</summary>
      <p>
        libsonare: <strong>{{ version }}</strong> · crossOriginIsolated:
        <strong>{{ isolated }}</strong> (SAB {{ isolated ? 'available' : 'unavailable' }})
      </p>
      <div class="diag-actions">
        <button type="button" :disabled="busy || !handle" @click="playTestTone">
          Test tone (1 s, bypasses engine)
        </button>
        <button type="button" :disabled="busy || !handle" @click="renderOffline">
          Render offline (3 s)
        </button>
      </div>
      <p v-if="renderInfo">{{ renderInfo }}</p>
      <p class="diag-shortcuts">
        Shortcuts: press ? for the full cheatsheet. Keys are remappable in Settings (⚙) →
        Shortcuts.
      </p>
      <ul v-if="handle">
        <li>mode: <strong>{{ handle.capabilities.mode }}</strong></li>
        <li>runtimeTarget: <strong>{{ handle.capabilities.runtimeTarget }}</strong></li>
        <li>abiCompatible: <strong>{{ handle.capabilities.abiCompatible ?? 'unknown' }}</strong></li>
        <li v-if="handle.capabilities.degradedReason">
          degradedReason: <strong>{{ handle.capabilities.degradedReason }}</strong>
        </li>
        <li>ctx.state: <strong>{{ ctxState }}</strong></li>
        <li>ctx.sampleRate: <strong>{{ handle.ctx.sampleRate }}</strong> Hz</li>
        <li>destination channels: <strong>{{ handle.ctx.destination.maxChannelCount }}</strong></li>
      </ul>
    </details>

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

    <div
      v-if="openDialogOpen"
      class="modal-overlay"
      @click.self="openDialogOpen = false"
    >
      <div
        ref="openDialogRef"
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Open project"
        tabindex="-1"
        @keydown="onOpenDialogKeydown"
      >
        <h2 class="modal-title">Open project</h2>
        <ul class="stored-list">
          <li v-for="info in storedProjects" :key="info.name" class="stored-row">
            <button
              type="button"
              class="stored-load"
              :title="`Load ${info.name}`"
              @click="openStoredProject(info.name)"
            >
              {{ info.name }}
            </button>
            <span class="stored-size">{{ formatSize(info.size) }}</span>
            <button
              type="button"
              class="stored-delete"
              :title="`Delete ${info.name}`"
              @click="deleteStoredProject(info.name)"
            >
              Delete
            </button>
          </li>
          <li v-if="storedProjects.length === 0" class="stored-empty">No saved projects.</li>
        </ul>
        <div class="modal-actions">
          <button type="button" @click="importSzdFile">Import .szd…</button>
          <span class="bar-spacer" />
          <button type="button" @click="openDialogOpen = false">Close</button>
        </div>
      </div>
    </div>

    <SettingsDialog
      :open="settingsOpen"
      :layout-bindings="layoutBindings"
      @close="settingsOpen = false"
    />

    <ShortcutsHelp :open="helpOpen" @close="helpOpen = false" />

    <WelcomeTour ref="tourRef" :steps="TOUR_STEPS" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-family: system-ui, sans-serif;
  background: #0b0d11;
  color: #c8cdd6;
}

.transport-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  background: #14161b;
  border-bottom: 1px solid #000;
  flex-wrap: wrap;
}

.app-title {
  font-weight: 700;
  letter-spacing: 0.04em;
  margin-right: 0.5rem;
}

.project-menu {
  position: relative;
}

.menu-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-width: 10rem;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.menu-pop button {
  text-align: left;
  background: none;
  border: none;
  color: #c8cdd6;
  font-size: 12px;
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
}

.menu-pop button:hover:not(:disabled) {
  background: #242832;
}

.menu-pop button:disabled {
  color: #5b6270;
  cursor: default;
}

.menu-rule {
  border: none;
  border-top: 1px solid #2a2e37;
  margin: 4px 0;
}

.project-name {
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #8b93a3;
}

.dirty-dot {
  color: #fbbf24;
  margin-left: 0.2rem;
}

.autosave-state {
  font-size: 11px;
  color: #5b6270;
  white-space: nowrap;
}

.bar-field {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 12px;
  white-space: nowrap;
}

.record-group {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.record-button {
  color: #ef4444;
  font-size: 13px;
  line-height: 1;
}

.record-button:disabled {
  color: #5b6270;
}

.record-button.recording {
  background: #3b1219;
  border-color: #ef4444;
  animation: record-blink 1s steps(2, start) infinite;
}

.record-button.counting-in {
  animation: record-blink 0.25s steps(2, start) infinite;
}

@keyframes record-blink {
  50% {
    color: #7a1d1d;
  }
}

.record-settings {
  font-size: 10px;
  padding: 0.2rem 0.3rem;
}

.record-pop {
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
}

.input-level {
  width: 56px;
  height: 8px;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  overflow: hidden;
}

.input-level-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #34d399, #fbbf24 75%, #ef4444);
  transition: width 60ms linear;
}

.hidden-file-input {
  display: none;
}

.tempo-input {
  width: 4.5rem;
}

.position-readout {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: #8b93a3;
}

.bar-spacer {
  flex: 1;
}

.error-box {
  margin: 0;
  background: #3b1219;
  border: 1px solid #ef4444;
  color: #ffb4b4;
  padding: 0.5rem 0.75rem;
  white-space: pre-wrap;
  font-size: 12px;
}

.main-row {
  flex: 1;
  min-height: 0;
  display: flex;
}

.workspace {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.right-zone {
  flex: none;
  width: 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #000;
  overflow: hidden;
}

.devices-toggle.active {
  color: #e2e6ee;
  border-color: #60a5fa;
  box-shadow: inset 0 -2px 0 #60a5fa;
}

.settings-button {
  font-size: 14px;
  line-height: 1;
  padding: 0.2rem 0.45rem;
}

/* Slim, row-shaped variant of the hint card: the editor dock is short on
   small windows, so the engine hint must not steal piano-roll height. */
.engine-hint {
  flex: none;
  flex-direction: row;
  justify-content: center;
  max-width: none;
  margin: 0.3rem 0.75rem 0;
  padding: 0.3rem 0.75rem;
}

.engine-hint :deep(.hint-action) {
  margin-top: 0;
}

.arrange-zone {
  flex: 0 0 auto;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.split-divider {
  flex: none;
  height: 6px;
  background: #101216;
  border-top: 1px solid #000;
  border-bottom: 1px solid #000;
  cursor: row-resize;
  touch-action: none;
}

.split-divider:hover,
.split-divider:focus-visible {
  background: #1b2330;
}

.editor-dock {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dock-tabs {
  display: flex;
  background: #101216;
  border-bottom: 1px solid #000;
}

.dock-tab {
  background: none;
  border: none;
  color: #8b93a3;
  font: 600 12px system-ui, sans-serif;
  padding: 0.4rem 1rem;
  cursor: default;
}

.dock-tab.active {
  color: #e2e6ee;
  box-shadow: inset 0 -2px 0 #60a5fa;
}

.dock-tab-toggle {
  cursor: pointer;
}

.dock-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0.75rem;
  background: #101216;
  border-bottom: 1px solid #000;
  flex-wrap: wrap;
  font-size: 12px;
}

.step-cursor {
  font-size: 11px;
  color: #8b93a3;
  font-variant-numeric: tabular-nums;
}

.apply-state {
  font-size: 11px;
  color: #8b93a3;
}

.piano-roll-host {
  flex: 1;
  min-height: 0;
}

.mixer-host {
  flex: 1;
  min-height: 0;
}

.mastering-host {
  flex: 1;
  min-height: 0;
}

.dock-body-scroll {
  overflow: auto;
}

/* The score panel borrows vertical space from the roll; closing it hands the
   full editor height back to the piano roll. */
.score-host {
  flex: 0 0 42%;
  min-height: 220px;
}

.lists-host {
  flex: 1;
  min-height: 0;
}

.media-host {
  flex: 1;
  min-height: 0;
}

.sample-host {
  flex: 1;
  min-height: 0;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.modal {
  width: 26rem;
  max-width: calc(100vw - 2rem);
  max-height: calc(100vh - 4rem);
  overflow: auto;
  background: #14161b;
  border: 1px solid #2a2e37;
  border-radius: 8px;
  padding: 1rem;
}

.modal-title {
  margin: 0 0 0.75rem;
  font-size: 14px;
  color: #e2e6ee;
}

.stored-list {
  list-style: none;
  margin: 0 0 0.75rem;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stored-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.stored-load {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  color: #c8cdd6;
  font-size: 12px;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}

.stored-load:hover {
  background: #242832;
}

.stored-size {
  font-size: 11px;
  color: #5b6270;
  white-space: nowrap;
}

.stored-delete {
  background: none;
  border: none;
  color: #8b93a3;
  font-size: 11px;
  cursor: pointer;
}

.stored-delete:hover {
  color: #ffb4b4;
}

.stored-empty {
  font-size: 12px;
  color: #5b6270;
  padding: 0.35rem 0;
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.diagnostics {
  background: #101216;
  border-top: 1px solid #000;
  padding: 0.4rem 0.75rem;
  font-size: 13px;
}

.diagnostics summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
  color: #8b93a3;
}

.diag-actions {
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.diag-shortcuts {
  font-size: 11px;
  color: #5b6270;
}
</style>
