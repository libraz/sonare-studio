<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import ArrangementView from '@/components/arrangement/ArrangementView.vue';
import DeviceRack from '@/components/devices/DeviceRack.vue';
import LevelMeter from '@/components/LevelMeter.vue';
import ProjectListsPanel from '@/components/lists/ProjectListsPanel.vue';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import MixerPanel from '@/components/mixer/MixerPanel.vue';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollEditor from '@/components/piano-roll/PianoRollEditor.vue';
import NewProjectDialog from '@/components/project/NewProjectDialog.vue';
import SampleEditor from '@/components/sample-editor/SampleEditor.vue';
import ScorePanel from '@/components/score/ScorePanel.vue';
import StepSequencer from '@/components/step-sequencer/StepSequencer.vue';
import { useAutosave } from '@/composables/useAutosave';
import { useMusicTyping } from '@/composables/useMusicTyping';
import { useRecording } from '@/composables/useRecording';
import { useStepInput } from '@/composables/useStepInput';
import { useTransport } from '@/composables/useTransport';
import { useWebMidi } from '@/composables/useWebMidi';
import { createEngine, type EngineHandle } from '@/engine/engine';
import {
  type MidiNote,
  normalizeGain,
  peakAmplitude,
  prerenderMidiClip,
} from '@/engine/instruments';
import { createMeterBridge, type MeterBridge } from '@/engine/meters';
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
import { decodeAndIngest } from '@/project/audio-import';
import {
  addAudioClip,
  addAudioTrack,
  deleteClip,
  deleteNotes,
  duplicateClip,
  quantizeSelection,
  redo,
  setActiveClip,
  setSelection,
  setTempoSegments,
  undo,
} from '@/project/commands';
import { exportProjectSmf } from '@/project/export';
import { type ScheduledProjectClip, scheduleProjectClips } from '@/project/scheduling';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { makeDemoDocument, type TemplateName } from '@/project/templates';
import { clipKind, isAudioClip } from '@/project/types';
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
const autosave = useAutosave();

// --- Recording -----------------------------------------------------------------

const recording = useRecording(() => handle.value, transport);

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
        window.confirm('Restore the autosaved project from your last session?')
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

function closeProjectMenu(): void {
  projectMenuOpen.value = false;
}

/** True when the press landed outside the given popover root. */
function isOutsidePress(root: HTMLElement | null, event: PointerEvent): boolean {
  return root !== null && event.target instanceof Node && !root.contains(event.target);
}

/** Closes the project menu and record popover on any press outside of them. */
function onWindowPointerDown(event: PointerEvent): void {
  if (projectMenuOpen.value && isOutsidePress(projectMenuRoot.value, event)) {
    closeProjectMenu();
  }
  if (recordMenuOpen.value && isOutsidePress(recordMenuRoot.value, event)) {
    recordMenuOpen.value = false;
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
  return !dirty.value || window.confirm('Discard unsaved changes in the current project?');
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
  if (!window.confirm(`Delete the saved project "${name}"?`)) return;
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
    const blob = new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
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

// The mirror arrays are replaced wholesale per command, so identity tracking
// fires once per edit (including undo/redo). Clips cover note/clip/tempo
// edits (every project command rebuilds them); tracks cover mute/solo/volume
// metadata, which changes which clips are audible and at what level.
watch(() => store.clips, scheduleApply);
watch(() => store.tracks, scheduleApply);

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
 * Plays a short single-note preview directly on the AudioContext. The note is
 * prerendered through the shared content-addressed cache (repeats are cheap)
 * and played as a one-shot buffer, so it is audible even while the engine
 * transport is stopped.
 */
async function previewNote(pitch: number, velocity: number): Promise<void> {
  const h = handle.value;
  if (!h) return;
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
// transport rate and the bounce (scheduleApply fires via the clips watcher).
watch(
  () => store.tempoBpm,
  (bpm) => {
    tempoInput.value = bpm;
    if (handle.value) transport.setTempo(bpm);
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

function onDividerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dividerDrag = { startY: event.clientY, startHeight: arrangeHeight.value };
}

function onDividerPointerMove(event: PointerEvent): void {
  if (!dividerDrag) return;
  const max = Math.max(ARRANGE_MIN_HEIGHT, window.innerHeight - 240);
  const next = dividerDrag.startHeight + (event.clientY - dividerDrag.startY);
  arrangeHeight.value = Math.min(max, Math.max(ARRANGE_MIN_HEIGHT, next));
}

function onDividerPointerUp(): void {
  if (!dividerDrag) return;
  dividerDrag = null;
  try {
    window.localStorage.setItem(ARRANGE_HEIGHT_KEY, String(Math.round(arrangeHeight.value)));
  } catch {
    // Persisting the height is best-effort only.
  }
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

type DockTab = 'roll' | 'mixer' | 'steps' | 'lists' | 'media' | 'sample';

/** Active editor-dock tab. */
const dockTab = ref<DockTab>('roll');

/** Whether the read-only score panel is shown below the piano roll. */
const scoreVisible = ref(false);

function toggleScorePanel(): void {
  scoreVisible.value = !scoreVisible.value;
  if (scoreVisible.value) dockTab.value = 'roll';
}

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
 * Global shortcuts. Events already consumed closer to their target (piano
 * roll undo/delete, music typing keys) arrive with defaultPrevented and are
 * skipped, so nothing fires twice.
 */
function onGlobalKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || isEditableTarget(event.target)) return;
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;
  const lower = key.toLowerCase();
  if (meta && lower === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && lower === 'a') {
    event.preventDefault();
    selectAllNotes();
    return;
  }
  if (meta && lower === 'd') {
    // Duplicate the selected arrangement clip right after itself.
    const clip = store.activeClip;
    if (focusZone.value === 'arrange' && clip) {
      event.preventDefault();
      duplicateClip(clip.id, clip.startPpq + clip.lengthPpq);
    }
    return;
  }
  if (meta && lower === 's') {
    event.preventDefault();
    saveProjectAction();
    return;
  }
  if (meta && lower === 'g') {
    event.preventDefault();
    store.snapEnabled = !store.snapEnabled;
    return;
  }
  if (meta && lower === 'e') {
    event.preventDefault();
    toggleScorePanel();
    return;
  }
  if (meta) return;
  if (key === ' ') {
    event.preventDefault();
    togglePlayback();
    return;
  }
  if (lower === 'q') {
    event.preventDefault();
    quantizeSelection();
    return;
  }
  if (lower === 'l') {
    event.preventDefault();
    toggleLoop();
    return;
  }
  if (lower === 'b') {
    // Split the clip under the playhead (arrangement focus only).
    if (focusZone.value === 'arrange') {
      event.preventDefault();
      arrangementRef.value?.cutAtPlayhead();
    }
    return;
  }
  if (key === 'Backspace' || key === 'Delete') {
    if (focusZone.value === 'arrange' && store.clipId !== -1) {
      event.preventDefault();
      deleteClip(store.clipId);
      return;
    }
    if (store.selection.size > 0) {
      event.preventDefault();
      deleteSelectedNotes();
    }
  }
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
      clipCount: () => store.clips.length,
      clipKinds: () => store.clips.map((clip) => clipKind(clip)),
      audioClipCount: () => store.clips.filter((clip) => isAudioClip(clip)).length,
      armedTrackId: () => recording.armedTrackId.value,
      isRecording: () => recording.isRecording.value,
      projectName: () => store.projectName,
      activeTrackId: () => store.activeTrackId,
      activeClipId: () => store.clipId,
      applyPending: () => applyPending.value,
      scheduledClipIds: () => scheduledClips.map((clip) => clip.engineClipId),
      trackInstruments: () =>
        store.tracks.map((track) =>
          track.instrument === undefined
            ? null
            : track.instrument.kind === 'synth-preset'
              ? track.instrument.preset
              : track.instrument.kind,
        ),
      trackInsertCounts: () => store.tracks.map((track) => track.mixer?.inserts.length ?? 0),
      meterPeakDb: () => {
        const latest = bridge.value?.latest;
        return latest ? Math.max(latest.peakDbL, latest.peakDbR) : null;
      },
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
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
  bridge.value?.dispose();
  bridge.value = null;
  await handle.value?.dispose();
  handle.value = null;
});
</script>

<template>
  <div class="app-shell">
    <header class="transport-bar">
      <span class="app-title">sonare studio</span>
      <div ref="projectMenuRoot" class="project-menu">
        <button type="button" class="menu-trigger" @click="projectMenuOpen = !projectMenuOpen">
          Project ▾
        </button>
        <div v-if="projectMenuOpen" class="menu-pop">
          <button type="button" @click="openNewDialog">New…</button>
          <button type="button" :disabled="!opfsAvailable" @click="openOpenDialog">Open…</button>
          <button
            type="button"
            class="menu-save"
            :disabled="!opfsAvailable"
            title="Save to browser storage (Cmd+S)"
            @click="saveProjectAction"
          >
            Save
          </button>
          <button type="button" :disabled="!opfsAvailable" @click="saveProjectAsAction">
            Save As…
          </button>
          <hr class="menu-rule" />
          <button type="button" @click="importAudioAction">Import audio…</button>
          <hr class="menu-rule" />
          <button type="button" @click="exportSzdAction">Export .szd</button>
          <button type="button" @click="exportSmfAction">Export SMF</button>
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
      <button type="button" :disabled="busy || handle !== null" @click="startEngine">
        Start engine
      </button>
      <button type="button" :disabled="!handle" @click="togglePlayback">
        {{ isPlaying ? 'Stop' : 'Play' }}
      </button>
      <div ref="recordMenuRoot" class="record-group">
        <button
          type="button"
          class="record-button"
          :class="{
            recording: recording.isRecording.value,
            'counting-in': recording.isCountingIn.value,
          }"
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
          title="Recording settings"
          @click="recordMenuOpen = !recordMenuOpen"
        >
          ▾
        </button>
        <div v-if="recordMenuOpen" class="menu-pop record-pop">
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
            <select v-model.number="recording.countInBars.value">
              <option :value="0">Off</option>
              <option :value="1">1 bar</option>
              <option :value="2">2 bars</option>
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
        title="Toggle the device rack panel"
        @click="toggleDeviceRack"
      >
        Devices
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
        title="Drag to resize the arrangement"
        @pointerdown="onDividerPointerDown"
        @pointermove="onDividerPointerMove"
        @pointerup="onDividerPointerUp"
        @pointercancel="onDividerPointerUp"
      />

      <section class="editor-dock" @pointerdown.capture="focusZone = 'editor'">
        <div class="dock-tabs">
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'roll' }"
            @click="dockTab = 'roll'"
          >
            Piano Roll
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'mixer' }"
            @click="dockTab = 'mixer'"
          >
            Mixer
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'steps' }"
            @click="dockTab = 'steps'"
          >
            Steps
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'lists' }"
            @click="dockTab = 'lists'"
          >
            Lists
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'media' }"
            @click="dockTab = 'media'"
          >
            Media
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: dockTab === 'sample' }"
            @click="dockTab = 'sample'"
          >
            Sample
          </button>
          <button
            type="button"
            class="dock-tab dock-tab-toggle"
            :class="{ active: scoreVisible }"
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
          <MixerPanel class="mixer-host" :bridge="bridge" />
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
          <p v-else class="dock-empty">
            Select an audio clip in the arrangement to edit its audio here.
          </p>
        </section>
      </section>
      </div>

      <aside v-if="deviceRackOpen" class="right-zone" aria-label="Device rack panel">
        <DeviceRack />
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
        Shortcuts: Space play/stop · Q quantize · L loop · B split clip at playhead (arrangement) ·
        Delete remove notes / selected clip · Cmd+Z undo · Cmd+Shift+Z redo · Cmd+A select all ·
        Cmd+D duplicate clip (arrangement) · Cmd+S save · Cmd+G snap · Cmd+E score
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

    <div
      v-if="openDialogOpen"
      class="modal-overlay"
      @click.self="openDialogOpen = false"
    >
      <div class="modal" role="dialog" aria-label="Open project">
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

.split-divider:hover {
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

.dock-empty {
  margin: 0;
  padding: 0.75rem;
  font-size: 12px;
  color: #5b6270;
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
