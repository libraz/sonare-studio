<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import LevelMeter from '@/components/LevelMeter.vue';
import { useTransport } from '@/composables/useTransport';
import { createEngine, type EngineHandle } from '@/engine/engine';
import { makeDemoNotes, scheduleMidiClip } from '@/engine/instruments';
import { createMeterBridge, type MeterBridge } from '@/engine/meters';
import { ensureWasm } from '@/lib/wasm';

const version = ref('…');
const isolated = ref(globalThis.crossOriginIsolated === true);
const errorMessage = ref('');
const busy = ref(false);

/** Plain (non-reactive) engine objects; the meter bridge must not be wrapped in reactive(). */
const handle = shallowRef<EngineHandle | null>(null);
const bridge = shallowRef<MeterBridge | null>(null);

const transport = useTransport(() => handle.value);
const { isPlaying, positionSeconds, positionPpq, tempo, loopEnabled, metronomeEnabled } = transport;

const tempoInput = ref(tempo.value);
const demoClipId = ref<number | null>(null);
const renderInfo = ref('');

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

const ctxState = ref('');

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

/** Prerenders the demo phrase at the current tempo and schedules it at PPQ 0. */
function loadDemoClip(): Promise<void> {
  return runAction(async () => {
    const h = handle.value;
    if (!h) throw new Error('Start the engine first.');
    if (demoClipId.value !== null) {
      h.engine.removeClip(demoClipId.value);
      demoClipId.value = null;
    }
    // The render tempo is baked into the audio; keep the engine transport in sync.
    transport.setTempo(tempo.value);
    demoClipId.value = await scheduleMidiClip(h, 'demo-track', makeDemoNotes(), 0, {
      tempoBpm: tempo.value,
    });
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

function applyTempo(): void {
  const bpm = Number(tempoInput.value);
  if (Number.isFinite(bpm) && bpm > 0) {
    transport.setTempo(bpm);
  }
}

function toggleLoop(): void {
  // Demo phrase spans PPQ [0, 8): loop the full two bars.
  transport.setLoop(0, 8, !loopEnabled.value);
}

function formatSeconds(s: number): string {
  return s.toFixed(2);
}

onMounted(async () => {
  try {
    const wasm = await ensureWasm();
    version.value = wasm.version();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
});

onBeforeUnmount(async () => {
  bridge.value?.dispose();
  bridge.value = null;
  await handle.value?.dispose();
  handle.value = null;
});
</script>

<template>
  <main style="font-family: system-ui; padding: 2rem; max-width: 720px">
    <h1>sonare studio</h1>
    <p>
      libsonare: <strong>{{ version }}</strong> · crossOriginIsolated:
      <strong>{{ isolated }}</strong> (SAB {{ isolated ? 'available' : 'unavailable' }})
    </p>

    <p
      v-if="errorMessage"
      style="background: #fee2e2; border: 1px solid #ef4444; color: #7f1d1d; padding: 0.75rem; border-radius: 4px; white-space: pre-wrap"
      role="alert"
    >
      {{ errorMessage }}
    </p>

    <section>
      <h2>Engine</h2>
      <button type="button" :disabled="busy || handle !== null" @click="startEngine">
        Start engine
      </button>
      <button type="button" :disabled="busy || !handle" @click="playTestTone">
        Test tone (1 s, bypasses engine)
      </button>
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
    </section>

    <section style="display: flex; gap: 1.5rem; align-items: flex-start">
      <div>
        <h2>Transport</h2>
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap">
          <button type="button" :disabled="!handle || isPlaying" @click="transport.play()">
            Play
          </button>
          <button type="button" :disabled="!handle || !isPlaying" @click="transport.stop()">
            Stop
          </button>
          <label>
            Tempo
            <input
              v-model.number="tempoInput"
              type="number"
              min="20"
              max="300"
              step="1"
              style="width: 4.5rem"
              :disabled="!handle"
              @change="applyTempo"
            />
            BPM
          </label>
          <label>
            <input
              type="checkbox"
              :checked="loopEnabled"
              :disabled="!handle"
              @change="toggleLoop"
            />
            Loop (bars 1-2)
          </label>
          <label>
            <input
              type="checkbox"
              :checked="metronomeEnabled"
              :disabled="!handle"
              @change="transport.toggleMetronome()"
            />
            Metronome
          </label>
        </div>
        <p>
          Position: <strong>{{ formatSeconds(positionSeconds) }}</strong> s ·
          <strong>{{ positionPpq.toFixed(2) }}</strong> PPQ
          <span v-if="isPlaying">(playing)</span>
        </p>

        <h2>Demo clip</h2>
        <button type="button" :disabled="busy || !handle" @click="loadDemoClip">
          Load demo clip
        </button>
        <span v-if="demoClipId !== null"> clipId: {{ demoClipId }}</span>

        <h2>Offline render</h2>
        <button type="button" :disabled="busy || !handle" @click="renderOffline">
          Render offline (3 s)
        </button>
        <p v-if="renderInfo">{{ renderInfo }}</p>
      </div>
      <div>
        <h2>Output</h2>
        <LevelMeter :bridge="bridge" />
      </div>
    </section>
  </main>
</template>
