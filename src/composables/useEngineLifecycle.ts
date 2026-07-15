import type { Ref, ShallowRef } from 'vue';
import type {
  ApplyToEngineOptions,
  EngineSyncHandles,
  InitialEngineSyncOptions,
} from '@/composables/useEngineProjectSync';
import type { useTransport } from '@/composables/useTransport';
import { type AnalyserBridge, createAnalyserBridge } from '@/engine/analyser';
import { createAutomationSync } from '@/engine/automation-sync';
import { createEngine, type EngineHandle } from '@/engine/engine';
import { resolvePresetName } from '@/engine/instruments';
import { createMeterBridge, type MeterBridge } from '@/engine/meters';
import { createMidiSync } from '@/engine/midi-sync';
import { createMixerSync } from '@/engine/mixer-sync';
import { createScopeBridge, type ScopeBridge } from '@/engine/scope';
import { createStripSync, groupBusGainDb } from '@/engine/strip-sync';
import { createTransportSync } from '@/engine/transport-sync';
import { createWebMidiOutput } from '@/engine/web-midi-output';
import { ensureWasm } from '@/lib/wasm';
import {
  busIdFromAutomationTarget,
  isBusAutomationTarget,
  parseInsertAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import {
  insertIndexForAutomationRef,
  masteringIndexForAutomationRef,
  stripForAutomationTarget,
} from '@/project/automation-insert';
import {
  type InsertLatencyCatalogEntry,
  insertLatencyResolverFromCatalog,
} from '@/project/insert-latency';
import {
  clampPan,
  effectiveTrackMute,
  laneGainDb,
  type MixerStrip,
  vcaOffsetDb,
} from '@/project/mixer';
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
  applyToEngine: (options?: ApplyToEngineOptions) => Promise<void>;
  bootPromise: () => Promise<void> | null;
  runAction: RunAction;
  resetEngineProjectSync: () => void;
  setEngineSyncHandles: (handles: EngineSyncHandles) => void;
  syncAutomationState: (options?: InitialEngineSyncOptions) => void;
  syncMidiState: (options?: InitialEngineSyncOptions) => Promise<void>;
  syncMixerState: (options?: InitialEngineSyncOptions) => void;
  syncTransportState: (options?: InitialEngineSyncOptions) => void;
}

export function useEngineLifecycle(options: EngineLifecycleOptions) {
  const store = useProjectStore();
  let engineStartPromise: Promise<void> | null = null;
  let disposeCtxState: (() => void) | null = null;
  let lifecycleEpoch = 0;
  let startController: AbortController | null = null;

  function clearAudioContextStateBinding(): void {
    disposeCtxState?.();
    disposeCtxState = null;
  }

  function disposeEngineLifecycle(): void {
    lifecycleEpoch += 1;
    startController?.abort(new DOMException('Engine lifecycle disposed.', 'AbortError'));
    startController = null;
    clearAudioContextStateBinding();
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
      const epoch = ++lifecycleEpoch;
      startController?.abort(new DOMException('Engine startup superseded.', 'AbortError'));
      const controller = new AbortController();
      startController = controller;
      const assertActive = (): void => {
        if (epoch !== lifecycleEpoch || controller.signal.aborted) {
          throw (
            controller.signal.reason ?? new DOMException('Engine startup aborted.', 'AbortError')
          );
        }
      };
      let h: EngineHandle | null = null;
      let nextBridge: MeterBridge | null = null;
      let nextAnalyser: AnalyserBridge | null = null;
      let nextScope: ScopeBridge | null = null;
      let syncHandlesInstalled = false;
      let published = false;
      try {
        h = await createEngine({ signal: controller.signal });
        const stagedHandle = h;
        assertActive();
        const wasm = (await ensureWasm()) as unknown as {
          masteringInsertNames?: () => string[];
          masteringProcessorCatalog?: () => InsertLatencyCatalogEntry[];
        };
        assertActive();

        const bootPromise = options.bootPromise();
        if (bootPromise) {
          await bootPromise;
          assertActive();
        }
        await store.init({ sampleRate: stagedHandle.ctx.sampleRate });
        assertActive();
        const insertCatalog =
          typeof wasm.masteringInsertNames === 'function'
            ? new Set(wasm.masteringInsertNames())
            : null;
        const insertLatency =
          typeof wasm.masteringProcessorCatalog === 'function'
            ? insertLatencyResolverFromCatalog(wasm.masteringProcessorCatalog(), {
                sampleRate: stagedHandle.ctx.sampleRate,
              })
            : undefined;
        const nextMixerSync = createMixerSync(stagedHandle, { insertLatency });
        const nextStripSync = createStripSync(stagedHandle, { insertCatalog });
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
        const masteringProcessorIndexFor = (processorId: string): number | undefined =>
          masteringIndexForAutomationRef(store.mixer.masteringChain, { processorId });
        const insertLaneContext = () => ({
          trackStrips: new Map(store.tracks.map((track) => [track.id, track.mixer])),
          master: store.mixer.master,
          busStrips: new Map(store.mixer.buses.map((bus) => [bus.id, bus.strip])),
        });
        const insertStoreIndexFor = (
          target: Parameters<typeof stripForAutomationTarget>[0],
          processorId: string,
        ): number | undefined => {
          const strip = stripForAutomationTarget(target, insertLaneContext());
          return strip ? insertIndexForAutomationRef(strip.inserts, { processorId }) : undefined;
        };
        const nextAutomationSync = createAutomationSync(stagedHandle, {
          knownTrackIds: () => nextMixerSync.laneTrackIds(),
          busIdFor: (storeBusId) => nextStripSync.busIdFor(storeBusId),
          groupBusIdFor: (trackId) => nextStripSync.groupBusIdFor(trackId),
          busInsertIndexFor: (storeBusId, index) =>
            nextStripSync.busInsertIndexFor(storeBusId, index),
          groupInsertIndexFor: (trackId, index) =>
            nextStripSync.groupInsertIndexFor(trackId, index),
          masteringInsertIndexFor,
          masteringProcessorIndexFor,
          insertStoreIndexFor,
          vcaOffsetFor: (trackId) => {
            const track = store.tracks.find((entry) => entry.id === trackId);
            const vcaGroups = store.mixer.vcaGroups ?? [];
            const vcaGainDb = vcaGroups.length
              ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
              : undefined;
            return vcaOffsetDb(track?.vcaId, vcaGainDb);
          },
          effectiveMuteFor: (trackId) => {
            const track = store.tracks.find((entry) => entry.id === trackId);
            if (!track) return false;
            const vcaControls = new Map(
              (store.mixer.vcaGroups ?? []).map((group) => [group.id, group]),
            );
            return effectiveTrackMute(track.mute, track.vcaId, vcaControls);
          },
          restoreParam: (target, param) => {
            const masteringRef = parseMasteringAutomationParam(param);
            if (masteringRef) {
              if (target !== 'master') return;
              const processorIndex = masteringIndexForAutomationRef(
                store.mixer.masteringChain,
                masteringRef,
              );
              if (processorIndex === undefined) return;
              const slot = store.mixer.masteringChain?.processors[processorIndex];
              const value = slot?.params[masteringRef.paramName];
              const engineInsertIndex = masteringInsertIndexFor(processorIndex);
              if (typeof value === 'number' && engineInsertIndex !== undefined) {
                stagedHandle.engine.setMasterStripInsertParamByName(
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
              const slotValue = (
                strip: MixerStrip | undefined,
              ): { index: number; value: number } | undefined => {
                if (!strip) return undefined;
                const index = insertIndexForAutomationRef(strip.inserts, insertRef);
                const raw =
                  index === undefined
                    ? undefined
                    : strip.inserts[index]?.params[insertRef.paramName];
                return typeof raw === 'number' && index !== undefined
                  ? { index, value: raw }
                  : undefined;
              };
              if (target === 'master') {
                const resolved = slotValue(store.mixer.master);
                if (resolved) {
                  stagedHandle.engine.setMasterStripInsertParamByName(
                    resolved.index,
                    insertRef.paramName,
                    resolved.value,
                  );
                }
              } else if (isBusAutomationTarget(target)) {
                const storeBusId = busIdFromAutomationTarget(target);
                const busId = nextStripSync.busIdFor(storeBusId);
                const bus = store.mixer.buses.find((entry) => entry.id === storeBusId);
                const resolved = slotValue(bus?.strip);
                const engineInsertIndex = nextStripSync.busInsertIndexFor(
                  storeBusId,
                  resolved?.index ?? -1,
                );
                if (busId !== undefined && resolved && engineInsertIndex !== undefined) {
                  stagedHandle.engine.setBusStripInsertParamByName(
                    busId,
                    engineInsertIndex,
                    insertRef.paramName,
                    resolved.value,
                  );
                }
              } else if (typeof target === 'number') {
                const track = store.tracks.find((entry) => entry.id === target);
                if (!canRestoreTrackInsertAutomationParam(track)) return;
                const groupBusId = nextStripSync.groupBusIdFor(target);
                const resolved = slotValue(track?.mixer);
                const engineInsertIndex = nextStripSync.groupInsertIndexFor(
                  target,
                  resolved?.index ?? -1,
                );
                if (
                  groupBusId !== undefined &&
                  resolved !== undefined &&
                  engineInsertIndex !== undefined
                ) {
                  stagedHandle.engine.setBusStripInsertParamByName(
                    groupBusId,
                    engineInsertIndex,
                    insertRef.paramName,
                    resolved.value,
                  );
                  return;
                }
                if (resolved !== undefined) {
                  stagedHandle.engine.setTrackStripInsertParamByName(
                    target,
                    resolved.index,
                    insertRef.paramName,
                    resolved.value,
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
              if (busId !== undefined && bus) stagedHandle.engine.setBusGain(busId, bus.gainDb);
              return;
            }
            if (target === 'master') {
              if (param === 'faderDb') {
                stagedHandle.engine.setStripGain('master', store.mixer.master.gainDb);
              } else {
                stagedHandle.engine.setStripPan('master', clampPan(store.mixer.master.pan));
              }
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
              const vcaControls = new Map(vcaGroups.map((group) => [group.id, group]));
              stagedHandle.engine.setBusGain(
                groupBusId,
                groupBusGainDb(
                  track,
                  vcaOffsetDb(track.vcaId, vcaGainDb),
                  effectiveTrackMute(track.mute, track.vcaId, vcaControls),
                ),
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
              stagedHandle.engine.setStripGain(
                target,
                laneGainDb(track.volume, track.mixer?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDb)),
              );
            } else {
              stagedHandle.engine.setStripPan(target, clampPan(track.mixer?.pan ?? 0));
            }
          },
        });
        const nextMidiSync = createMidiSync(stagedHandle, {
          resolvePreset: (preset) => resolvePresetName(wasm as never, preset),
        });
        const nextTransportSync = createTransportSync(stagedHandle);
        // External-MIDI delivery: subscribes to the engine's drained MIDI output
        // and writes it to Web MIDI ports. Best-effort access request — when Web
        // MIDI is unavailable or denied the bridge stays idle (internal tracks
        // are unaffected).
        const nextWebMidiOutput = createWebMidiOutput(stagedHandle);
        options.setEngineSyncHandles({
          mixerSync: nextMixerSync,
          stripSync: nextStripSync,
          automationSync: nextAutomationSync,
          midiSync: nextMidiSync,
          transportSync: nextTransportSync,
          webMidiOutput: nextWebMidiOutput,
        });
        syncHandlesInstalled = true;
        nextBridge = createMeterBridge(stagedHandle);
        nextAnalyser = createAnalyserBridge(stagedHandle);
        nextScope = createScopeBridge(stagedHandle);
        stagedHandle.engine.node.onprocessorerror = () => {
          options.errorMessage.value =
            'Engine worklet processor crashed during processing (onprocessorerror).';
        };
        options.transport.setTempo(store.tempoBpm);
        options.syncMixerState({ throwOnError: true });
        options.syncAutomationState({ throwOnError: true });
        options.syncTransportState({ throwOnError: true });
        await options.syncMidiState({ throwOnError: true });
        assertActive();
        await options.applyToEngine({ handle: stagedHandle, throwOnError: true });
        assertActive();

        // Single synchronous publication point: no ref exposes the staged
        // engine until all initialization and initial project sync have passed.
        options.handle.value = stagedHandle;
        options.bridge.value = nextBridge;
        options.analyser.value = nextAnalyser;
        options.scope.value = nextScope;
        clearAudioContextStateBinding();
        disposeCtxState = bindAudioContextState(stagedHandle.ctx, options.ctxState);
        published = true;
        void nextWebMidiOutput.start();
      } catch (error) {
        if (published) {
          clearAudioContextStateBinding();
          if (options.handle.value === h) options.handle.value = null;
          if (options.bridge.value === nextBridge) options.bridge.value = null;
          if (options.analyser.value === nextAnalyser) options.analyser.value = null;
          if (options.scope.value === nextScope) options.scope.value = null;
        }
        nextScope?.dispose();
        nextAnalyser?.dispose();
        nextBridge?.dispose();
        if (syncHandlesInstalled) options.resetEngineProjectSync();
        if (h) {
          h.engine.node.onprocessorerror = null;
          await h.dispose();
        }
        throw error;
      } finally {
        if (startController === controller) startController = null;
      }
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
