<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import PianoRollEditor from '@/components/piano-roll/PianoRollEditor.vue';
import { useMusicTyping } from '@/composables/useMusicTyping';
import { useStepInput } from '@/composables/useStepInput';
import { useTransport } from '@/composables/useTransport';
import { useWebMidi } from '@/composables/useWebMidi';
import { createEngine, type EngineHandle } from '@/engine/engine';
import {
  type MidiNote,
  makeDemoNotes,
  normalizeGain,
  peakAmplitude,
  prerenderMidiClip,
  scheduleMidiClip,
} from '@/engine/instruments';
import { createMeterBridge, type MeterBridge } from '@/engine/meters';
import { ensureWasm } from '@/lib/wasm';
import {
  addNote,
  clearHistory,
  deleteNotes,
  quantizeSelection,
  redo,
  setSelection,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { editorNotesToMidiNotes, midiNoteToNewEditorNote } from '@/project/types';
import type { RealtimeEngine } from '@/wasm/index.js';

/**
 * Single-window app shell: a transport bar on top, the editor dock with the
 * piano roll below, and a collapsible diagnostics section for the engine test
 * bench. Edits are bounced to the engine as audio via the prerender loop.
 */

const version = ref('…');
const isolated = ref(globalThis.crossOriginIsolated === true);
const errorMessage = ref('');
const busy = ref(false);

/** Delay after the last edit before the clip is re-bounced to the engine. */
const APPLY_DEBOUNCE_MS = 400;
/** Preview note length for music typing / MIDI echo, in PPQ. */
const PREVIEW_DURATION_PPQ = 0.5;
/** Peak level previews are normalized to (matches the scheduled clip default). */
const PREVIEW_TARGET_PEAK = 0.5;

/** Plain (non-reactive) engine objects; the meter bridge must not be wrapped in reactive(). */
const handle = shallowRef<EngineHandle | null>(null);
const bridge = shallowRef<MeterBridge | null>(null);

const transport = useTransport(() => handle.value);
const { isPlaying, positionSeconds, positionPpq, tempo, loopEnabled, metronomeEnabled } = transport;

const tempoInput = ref(tempo.value);
const renderInfo = ref('');
const ctxState = ref('');

const store = useProjectStore();
const stepInput = useStepInput();

/** Runs an async UI action, surfacing any thrown error in the error box. */
async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = '';
  try {
    await action();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

// --- Project seeding --------------------------------------------------------

/** Initializes the project store and seeds the demo phrase into an empty clip. */
async function initProject(): Promise<void> {
  await store.init({ ...(handle.value ? { sampleRate: handle.value.ctx.sampleRate } : {}) });
  if (store.notes.length === 0) {
    for (const note of makeDemoNotes()) {
      addNote(midiNoteToNewEditorNote(note));
    }
    // The seed is the editing baseline, not an undoable user action.
    clearHistory();
  }
}

// --- Edit-to-sound loop (prerender bounce) ----------------------------------

/** Engine clip id of the last applied editor bounce, or null. */
const editorClipId = ref<number | null>(null);
/** True while edits exist that have not been bounced to the engine yet. */
const applyPending = ref(false);

let applyGeneration = 0;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-bounces the edited clip and swaps it into the engine, replacing the
 * previous editor clip. Stale async results (superseded by a newer apply or
 * an engine restart) are discarded.
 */
async function applyToEngine(): Promise<void> {
  const h = handle.value;
  if (!h || !store.initialized) return;
  const generation = ++applyGeneration;
  applyPending.value = false;
  try {
    let clipId: number | null = null;
    if (store.notes.length > 0) {
      clipId = await scheduleMidiClip(
        h,
        'editor',
        editorNotesToMidiNotes(store.notes),
        store.clipStartPpq,
        { tempoBpm: tempo.value },
      );
    }
    if (generation !== applyGeneration || handle.value !== h) {
      if (clipId !== null) h.engine.removeClip(clipId);
      return;
    }
    if (editorClipId.value !== null) h.engine.removeClip(editorClipId.value);
    editorClipId.value = clipId;
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
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

// The store mirror is replaced wholesale on every command, so identity
// tracking fires once per edit (including undo/redo). Tempo changes also
// require a re-bounce because the render tempo is baked into the audio.
watch(() => store.notes, scheduleApply);
watch(tempo, scheduleApply);

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
    errorMessage.value = err instanceof Error ? err.message : String(err);
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
    await initProject();
    transport.setTempo(tempo.value);
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

function applyTempo(): void {
  const bpm = Number(tempoInput.value);
  if (Number.isFinite(bpm) && bpm > 0) {
    transport.setTempo(bpm);
  }
}

function toggleLoop(): void {
  const endPpq = store.clipLengthPpq > 0 ? store.clipLengthPpq : 8;
  transport.setLoop(0, endPpq, !loopEnabled.value);
}

function formatSeconds(s: number): string {
  return s.toFixed(2);
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

function selectAllNotes(): void {
  if (!store.initialized) return;
  setSelection(store.notes.map((note) => note.id));
}

function deleteSelectedNotes(): void {
  if (store.selection.size === 0) return;
  deleteNotes([...store.selection]);
}

// --- App-level keyboard shortcuts ---------------------------------------------

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
  if (meta && lower === 'g') {
    event.preventDefault();
    store.snapEnabled = !store.snapEnabled;
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
  if (key === 'Backspace' || key === 'Delete') {
    if (store.selection.size > 0) {
      event.preventDefault();
      deleteSelectedNotes();
    }
  }
}

// --- Lifecycle ----------------------------------------------------------------

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeyDown);
  try {
    const wasm = await ensureWasm();
    version.value = wasm.version();
    await initProject();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
  if (import.meta.env.DEV) {
    // Test hook for browser automation (dev builds only).
    (window as { __sonareDebug?: unknown }).__sonareDebug = {
      noteCount: () => store.notes.length,
      selectionCount: () => store.selection.size,
      initialized: () => store.initialized,
    };
  }
});

onBeforeUnmount(async () => {
  window.removeEventListener('keydown', onGlobalKeyDown);
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
      <button type="button" :disabled="busy || handle !== null" @click="startEngine">
        Start engine
      </button>
      <button type="button" :disabled="!handle" @click="togglePlayback">
        {{ isPlaying ? 'Stop' : 'Play' }}
      </button>
      <label class="bar-field">
        Tempo
        <input
          v-model.number="tempoInput"
          type="number"
          min="20"
          max="300"
          step="1"
          class="tempo-input"
          :disabled="!handle"
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
      <span class="bar-spacer" />
      <LevelMeter :bridge="bridge" :width="120" :height="36" />
    </header>

    <p v-if="errorMessage" class="error-box" role="alert">{{ errorMessage }}</p>

    <main class="editor-dock">
      <div class="dock-tabs">
        <button type="button" class="dock-tab active">Piano Roll</button>
      </div>
      <section class="dock-body">
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
            <input :checked="musicTyping.enabled.value" type="checkbox" @change="toggleMusicTyping" />
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
            title="Bounce the edited clip to the engine now"
            @click="applyNow"
          >
            Apply to engine
          </button>
          <span class="apply-state">
            {{ !handle ? 'engine off' : applyPending ? 'pending…' : editorClipId !== null ? `clip #${editorClipId}` : 'empty' }}
          </span>
        </div>
        <InfoLine />
        <PianoRollEditor class="piano-roll-host" :position-ppq="() => positionPpq" />
      </section>
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

.bar-field {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 12px;
  white-space: nowrap;
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
</style>
