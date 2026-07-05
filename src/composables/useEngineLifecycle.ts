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
import { createWebMidiOutput } from '@/engine/web-midi-output';
import { ensureWasm } from '@/lib/wasm';
import {
  busIdFromAutomationTarget,
  isBusAutomationTarget,
  parseInsertAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { enabledInsertAutomationIndex } from '@/project/automation-insert';
import {
  type InsertLatencyCatalogEntry,
  insertLatencyResolverFromCatalog,
} from '@/project/insert-latency';
import { clampPan, laneGainDb, type MixerStrip, vcaOffsetDb } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';

type Transport = ReturnType<typeof useTransport>;
type RunAction = (action: () => Promise<void>) => Promise<void>;

interface AudioContextStateLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export function canRestoreTrackInsertAutomationParam(
  track: Pick<EditorTrack, 'frozen'> | undefined,
): boolean {
  return track?.frozen === undefined;
}

export function bindAudioContextState(ctx: AudioContextStateLike, target: Ref<string>): () => void {
  const update = (): void => {
    target.value = ctx.state;
  };
  update();
  ctx.addEventListener('statechange', update);
  return () => {
    ctx.removeEventListener('statechange', update);
  };
}

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
  let disposeCtxState: (() => void) | null = null;

  function disposeEngineLifecycle(): void {
    disposeCtxState?.();
    disposeCtxState = null;
  }

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
      const wasm = (await ensureWasm()) as unknown as {
        masteringInsertNames?: () => string[];
        masteringProcessorCatalog?: () => InsertLatencyCatalogEntry[];
      };
      const insertCatalog =
        typeof wasm.masteringInsertNames === 'function'
          ? new Set(wasm.masteringInsertNames())
          : null;
      const insertLatency =
        typeof wasm.masteringProcessorCatalog === 'function'
          ? insertLatencyResolverFromCatalog(wasm.masteringProcessorCatalog(), {
              sampleRate: h.ctx.sampleRate,
            })
          : undefined;
      const nextMixerSync = createMixerSync(h, { insertLatency });
      const nextStripSync = createStripSync(h, { insertCatalog });
      const masteringInsertIndexFor = (processorIndex: number): number | undefined => {
        const processors = store.mixer.masteringChain?.processors ?? [];
        const slot = processors[processorIndex];
        if (!slot?.enabled) return undefined;
        if (insertCatalog && !insertCatalog.has(slot.processor)) return undefined;
        let engineIndex = store.mixer.master.inserts.length;
        for (let i = 0; i < processorIndex; i += 1) {
          const previous = processors[i];
          if (previous?.enabled && (!insertCatalog || insertCatalog.has(previous.processor))) {
            engineIndex += 1;
          }
        }
        return engineIndex;
      };
      const nextAutomationSync = createAutomationSync(h, {
        knownTrackIds: () => nextMixerSync.laneTrackIds(),
        busIdFor: (storeBusId) => nextStripSync.busIdFor(storeBusId),
        groupBusIdFor: (trackId) => nextStripSync.groupBusIdFor(trackId),
        busInsertIndexFor: (storeBusId, index) =>
          enabledInsertAutomationIndex(
            store.mixer.buses.find((entry) => entry.id === storeBusId)?.strip,
            index,
          ),
        groupInsertIndexFor: (trackId, index) =>
          enabledInsertAutomationIndex(
            store.tracks.find((entry) => entry.id === trackId)?.mixer,
            index,
          ),
        masteringInsertIndexFor,
        vcaOffsetFor: (trackId) => {
          const track = store.tracks.find((entry) => entry.id === trackId);
          const vcaGroups = store.mixer.vcaGroups ?? [];
          const vcaGainDb = vcaGroups.length
            ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
            : undefined;
          return vcaOffsetDb(track?.vcaId, vcaGainDb);
        },
        restoreParam: (target, param) => {
          const masteringRef = parseMasteringAutomationParam(param);
          if (masteringRef) {
            if (target !== 'master') return;
            const slot = store.mixer.masteringChain?.processors[masteringRef.processorIndex];
            const value = slot?.params[masteringRef.paramName];
            const engineInsertIndex = masteringInsertIndexFor(masteringRef.processorIndex);
            if (typeof value === 'number' && engineInsertIndex !== undefined) {
              h.engine.setMasterStripInsertParamByName(
                engineInsertIndex,
                masteringRef.paramName,
                value,
              );
            }
            return;
          }
          const insertRef = parseInsertAutomationParam(param);
          if (insertRef) {
            // Clearing an insert lane leaves the engine at its last automated
            // sample; re-push the strip's stored manual value so the parameter
            // returns to its project value.
            const slotValue = (strip: MixerStrip | undefined): number | undefined => {
              const raw = strip?.inserts[insertRef.insertIndex]?.params[insertRef.paramName];
              return typeof raw === 'number' ? raw : undefined;
            };
            if (target === 'master') {
              const value = slotValue(store.mixer.master);
              if (value !== undefined) {
                h.engine.setMasterStripInsertParamByName(
                  insertRef.insertIndex,
                  insertRef.paramName,
                  value,
                );
              }
            } else if (isBusAutomationTarget(target)) {
              const storeBusId = busIdFromAutomationTarget(target);
              const busId = nextStripSync.busIdFor(storeBusId);
              const bus = store.mixer.buses.find((entry) => entry.id === storeBusId);
              const value = slotValue(bus?.strip);
              const engineInsertIndex = enabledInsertAutomationIndex(
                bus?.strip,
                insertRef.insertIndex,
              );
              if (busId !== undefined && value !== undefined && engineInsertIndex !== undefined) {
                h.engine.setBusStripInsertParamByName(
                  busId,
                  engineInsertIndex,
                  insertRef.paramName,
                  value,
                );
              }
            } else if (typeof target === 'number') {
              const track = store.tracks.find((entry) => entry.id === target);
              if (!canRestoreTrackInsertAutomationParam(track)) return;
              const groupBusId = nextStripSync.groupBusIdFor(target);
              const value = slotValue(track?.mixer);
              const engineInsertIndex = enabledInsertAutomationIndex(
                track?.mixer,
                insertRef.insertIndex,
              );
              if (
                groupBusId !== undefined &&
                value !== undefined &&
                engineInsertIndex !== undefined
              ) {
                h.engine.setBusStripInsertParamByName(
                  groupBusId,
                  engineInsertIndex,
                  insertRef.paramName,
                  value,
                );
                return;
              }
              if (value !== undefined) {
                h.engine.setTrackStripInsertParamByName(
                  target,
                  insertRef.insertIndex,
                  insertRef.paramName,
                  value,
                );
              }
            }
            return;
          }
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
          const groupBusId =
            typeof target === 'number' ? nextStripSync.groupBusIdFor(target) : undefined;
          if (groupBusId !== undefined) {
            if (param !== 'faderDb') return;
            const vcaGroups = store.mixer.vcaGroups ?? [];
            const vcaGainDb = vcaGroups.length
              ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
              : undefined;
            h.engine.setBusGain(
              groupBusId,
              laneGainDb(track.volume, track.mixer?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDb)),
            );
            return;
          }
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
      // External-MIDI delivery: subscribes to the engine's drained MIDI output
      // and writes it to Web MIDI ports. Best-effort access request — when Web
      // MIDI is unavailable or denied the bridge stays idle (internal tracks
      // are unaffected).
      const nextWebMidiOutput = createWebMidiOutput(h);
      void nextWebMidiOutput.start();
      options.setEngineSyncHandles({
        mixerSync: nextMixerSync,
        stripSync: nextStripSync,
        automationSync: nextAutomationSync,
        midiSync: nextMidiSync,
        transportSync: nextTransportSync,
        webMidiOutput: nextWebMidiOutput,
      });
      options.bridge.value = createMeterBridge(h);
      options.analyser.value = createAnalyserBridge(h);
      options.scope.value = createScopeBridge(h);
      disposeEngineLifecycle();
      disposeCtxState = bindAudioContextState(h.ctx, options.ctxState);
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
    disposeEngineLifecycle,
    ensureEngineStarted,
    playTestTone,
    renderOffline,
    startEngine,
  };
}
