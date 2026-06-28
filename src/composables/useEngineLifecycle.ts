import type { Ref, ShallowRef } from 'vue';
import type { EngineSyncHandles } from '@/composables/useEngineProjectSync';
import type { useTransport } from '@/composables/useTransport';
import { type AnalyserBridge, createAnalyserBridge } from '@/engine/analyser';
import { createAutomationSync } from '@/engine/automation-sync';
import { createEngine, type EngineHandle } from '@/engine/engine';
import { resolvePresetName } from '@/engine/instruments';
import { createMeterBridge, type MeterBridge } from '@/engine/meters';
import { createMidiSync } from '@/engine/midi-sync';
import { createMixerSync } from '@/engine/mixer-sync';
import { createScopeBridge, type ScopeBridge } from '@/engine/scope';
import { createStripSync } from '@/engine/strip-sync';
import { createTransportSync } from '@/engine/transport-sync';
import { ensureWasm } from '@/lib/wasm';
import { busIdFromAutomationTarget, isBusAutomationTarget } from '@/project/automation';
import { clampPan, laneGainDb, vcaOffsetDb } from '@/project/mixer';
import { useProjectStore } from '@/project/store';

type Transport = ReturnType<typeof useTransport>;
type RunAction = (action: () => Promise<void>) => Promise<void>;

export interface EngineLifecycleOptions {
  bridge: ShallowRef<MeterBridge | null>;
  analyser: ShallowRef<AnalyserBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  ctxState: Ref<string>;
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  renderInfo: Ref<string>;
  transport: Transport;
  applyToEngine: () => Promise<void>;
  bootPromise: () => Promise<void> | null;
  runAction: RunAction;
  setEngineSyncHandles: (handles: EngineSyncHandles) => void;
  syncAutomationState: () => void;
  syncMidiState: () => Promise<void>;
  syncMixerState: () => void;
  syncTransportState: () => void;
}

export function useEngineLifecycle(options: EngineLifecycleOptions) {
  const store = useProjectStore();
  let engineStartPromise: Promise<void> | null = null;

  async function ensureEngineStarted(): Promise<EngineHandle | null> {
    if (options.handle.value) {
      if (options.handle.value.ctx.state === 'suspended') {
        await options.handle.value.ctx.resume().catch(() => undefined);
      }
      return options.handle.value;
    }
    if (!engineStartPromise) {
      engineStartPromise = startEngine().finally(() => {
        engineStartPromise = null;
      });
    }
    await engineStartPromise;
    return options.handle.value;
  }

  function startEngine(): Promise<void> {
    return options.runAction(async () => {
      if (options.handle.value) return;
      const h = await createEngine();
      options.handle.value = h;
      const nextMixerSync = createMixerSync(h);
      const wasm = (await ensureWasm()) as unknown as { masteringInsertNames?: () => string[] };
      const insertCatalog =
        typeof wasm.masteringInsertNames === 'function'
          ? new Set(wasm.masteringInsertNames())
          : null;
      const nextStripSync = createStripSync(h, { insertCatalog });
      const nextAutomationSync = createAutomationSync(h, {
        knownTrackIds: () => nextMixerSync.laneTrackIds(),
        busIdFor: (storeBusId) => nextStripSync.busIdFor(storeBusId),
        restoreParam: (target, param) => {
          if (isBusAutomationTarget(target)) {
            if (param !== 'faderDb') return;
            const storeBusId = busIdFromAutomationTarget(target);
            const busId = nextStripSync.busIdFor(storeBusId);
            const bus = store.mixer.buses.find((entry) => entry.id === storeBusId);
            if (busId !== undefined && bus) h.engine.setBusGain(busId, bus.gainDb);
            return;
          }
          if (target === 'master') {
            if (param === 'faderDb') h.engine.setStripGain('master', store.mixer.master.gainDb);
            else h.engine.setStripPan('master', clampPan(store.mixer.master.pan));
            return;
          }
          const track = store.tracks.find((entry) => entry.id === target);
          if (!track) return;
          if (param === 'faderDb') {
            // Restore the same effective level mixer-sync holds, VCA offset
            // included, so a VCA member doesn't jump when its automation clears.
            const vcaGroups = store.mixer.vcaGroups ?? [];
            const vcaGainDb = vcaGroups.length
              ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
              : undefined;
            h.engine.setStripGain(
              target,
              laneGainDb(track.volume, track.mixer?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDb)),
            );
          } else {
            h.engine.setStripPan(target, clampPan(track.mixer?.pan ?? 0));
          }
        },
      });
      const nextMidiSync = createMidiSync(h, {
        resolvePreset: (preset) => resolvePresetName(wasm as never, preset),
      });
      const nextTransportSync = createTransportSync(h);
      options.setEngineSyncHandles({
        mixerSync: nextMixerSync,
        stripSync: nextStripSync,
        automationSync: nextAutomationSync,
        midiSync: nextMidiSync,
        transportSync: nextTransportSync,
      });
      options.bridge.value = createMeterBridge(h);
      options.analyser.value = createAnalyserBridge(h);
      options.scope.value = createScopeBridge(h);
      options.ctxState.value = h.ctx.state;
      h.ctx.addEventListener('statechange', () => {
        options.ctxState.value = h.ctx.state;
      });
      h.engine.node.onprocessorerror = () => {
        options.errorMessage.value =
          'Engine worklet processor crashed during processing (onprocessorerror).';
      };
      const bootPromise = options.bootPromise();
      if (bootPromise) await bootPromise;
      await store.init({ sampleRate: h.ctx.sampleRate });
      options.transport.setTempo(store.tempoBpm);
      options.syncMixerState();
      options.syncAutomationState();
      options.syncTransportState();
      await options.syncMidiState();
      await options.applyToEngine();
    });
  }

  function playTestTone(): Promise<void> {
    return options.runAction(async () => {
      const h = options.handle.value;
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

  function renderOffline(): Promise<void> {
    return options.runAction(async () => {
      const h = options.handle.value;
      if (!h) throw new Error('Start the engine first.');
      const seconds = 3;
      const frames = Math.round(h.ctx.sampleRate * seconds);
      const buffers = await h.engine.renderOffline(frames);
      const lengths = buffers.map((b) => b.length).join(', ');
      options.renderInfo.value = `${buffers.length} channel(s), lengths [${lengths}] (${seconds}s @ ${h.ctx.sampleRate} Hz)`;
      console.info('renderOffline result:', buffers.length, 'channels', buffers);
    });
  }

  return {
    ensureEngineStarted,
    playTestTone,
    renderOffline,
    startEngine,
  };
}
