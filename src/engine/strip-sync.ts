/**
 * Realtime strip synchronisation: mirrors the store's per-track insert
 * chains, dedicated strip EQs, mixer buses and track sends (plus the master
 * strip inserts/EQ) onto a running engine, transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - A track strip set via setTrackStripJson is an extra processing stage
 *   independent of the lane fader/pan owned by mixer-sync (setStripGain /
 *   setStripPan). Scene strips therefore omit faderDb/pan, but they do carry
 *   channel-strip DSP fields such as input trim, stereo width and polarity.
 * - The strip has a dedicated per-band EQ (separate from the inserts) edited
 *   via setStripEq. It starts empty after every strip JSON send — a full
 *   re-send replaces the whole strip, so the bypass flags and every EQ band
 *   must be replayed right after it.
 * - The scene JSON has no per-insert enabled flag: all inserts (enabled and
 *   disabled) are declared in store order, then each disabled one is bypassed
 *   via setStripInsertBypassed, which indexes that inserts array.
 * - setTrackBuses replaces the whole bus set (max MAX_ENGINE_BUSES) and
 *   resets each bus gain to the passed gainDb; setBusGain adjusts a declared
 *   bus smoothly without re-declaring.
 * - Every send must reference an already-declared bus or the engine throws.
 *   Sends are post-fader and auto-create a neutral strip engine-side, so
 *   sends alone never require a strip JSON.
 * - Older engines have no per-bus-insert bypass setter. Disabled bus inserts
 *   are then omitted from the bus scene, so toggling one rebuilds that bus
 *   strip. Engines that expose setBusStripInsertBypassed keep every bus insert
 *   declared and toggle only the bypass flag, matching track/master behavior.
 * - The master strip has no engine-side sends; mixer.master.sends is ignored.
 */

import { SILENCE_DB } from '@/lib/db';
import {
  DEFAULT_SURROUND_PAN,
  effectiveTrackMute,
  type InsertSlot,
  laneGainDb,
  type MixerChannelLayout,
  type MixerStrip,
  mixerChannelLayoutCode,
  type ProjectMixerState,
  returnSoloRouting,
  type StripSend,
  type VcaControlState,
  vcaOffsetDb,
} from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { EngineTrackSend, EqBand } from '@/wasm/index.js';
import type { EngineHandle } from './engine';
import {
  engineBusInsertAutomationIndex,
  engineBusPanHasDsp,
  engineBusPanState,
  engineBusStrip,
  engineEqBands,
  engineMasterPannerHasDsp,
  stripSceneFieldsHaveDsp,
} from './engine-declaration';
import {
  busStripDspKey,
  hasRemovedPatchableRootParam,
  insertNumericParams,
  insertParamStructure,
  syncInsertNumericParams,
} from './insert-param-patching';
import { createRetryTimer } from './retry-timer';
import { busSceneJson, liveMasterStrip, stripSceneJson } from './strip-scene';

export type { BusSceneJsonOptions } from './strip-scene';
export { busSceneJson, liveMasterStrip, stripSceneJson };

/** Maximum number of mixer buses the realtime engine supports. */
export const MAX_ENGINE_BUSES = 8;

/** Bus-map key of the silent bus that parks direct outputs during a return solo. */
const RETURN_SOLO_DISCARD_BUS_KEY = 'return-solo-discard';

/** Options for {@link createStripSync}. */
export interface StripSyncOptions {
  /** Known insert processor names for validation; null/undefined skips validation. */
  insertCatalog?: ReadonlySet<string> | null;
}

/**
 * Combined audible gain of a group track in dB: track volume and strip gain
 * stacked (mixer-sync lane semantics), muted groups floored to silence, the
 * result clamped to the engine's bus gain range.
 */
export function groupBusGainDb(track: EditorTrack, vcaOffset = 0, muted = track.mute): number {
  if (muted) return -120;
  const combined = laneGainDb(track.volume, track.mixer?.gainDb, vcaOffset);
  return Math.min(24, Math.max(-120, combined));
}

/** What was last sent for one strip target, kept for change detection. */
interface StripMemory {
  /** Insert structure identity (processor + non-numeric params; enabled flags excluded). */
  structureKey: string;
  /** Numeric insert params last applied through the scene or param setter. */
  insertParams: Array<Record<string, number>>;
  /** Per-insert enabled flag as last applied (index = scene insert index). */
  enabled: boolean[];
  /** Serialized EQ band as last applied (index = engine band index). */
  eqBandJson: string[];
  /** Numeric bus panner state last applied; absent for track/master strips. */
  busPan?: ReturnType<typeof engineBusPanState>;
}

type BusInsertBypassEngine = {
  setBusStripInsertBypassed?: (busId: number, insertIndex: number, bypassed: boolean) => void;
};

type BusEqEngine = {
  setBusStripEqBand?: (busId: number, bandIndex: number, band: EqBand) => void;
};

type BusPanEngine = {
  setBusStripPan?: (busId: number, pan: number) => void;
  setBusStripPanLaw?: (busId: number, panLaw: number) => void;
  setBusStripPanMode?: (busId: number, panMode: number) => void;
  setBusStripDualPan?: (busId: number, leftPan: number, rightPan: number) => void;
};

/** The current realtime bus declaration, including routing metadata. */
interface EngineBusDeclaration {
  busId: number;
  gainDb: number;
  channelLayout?: number;
  outputBusId?: number;
  sends?: EngineTrackSend[];
}

type SidechainSourceKind = 'track' | 'bus';

interface SidechainBinding {
  sourceKind: SidechainSourceKind;
  sourceId: number;
}

type SidechainEngine = {
  setBusSidechain?: (
    busId: number,
    insertIndex: number,
    sourceKind: SidechainSourceKind | number,
    sourceId: number,
  ) => void;
  setMasterSidechain?: (
    insertIndex: number,
    sourceKind: SidechainSourceKind | number,
    sourceId: number,
  ) => void;
};

/** Maps a persisted strip send list to the engine's numeric bus ids. */
export function engineBusSends(
  sends: ReadonlyArray<StripSend> | undefined,
  resolveBus: (storeBusId: string) => number | undefined,
  ownBusId?: number,
): EngineTrackSend[] {
  const mapped: EngineTrackSend[] = [];
  const seen = new Set<number>();
  for (const send of sends ?? []) {
    const busId = resolveBus(send.busId);
    // A stale destination can survive an older document migration. The
    // engine rejects it, so omit it until the project points at a declared
    // bus again. Self-sends are invalid in the engine graph as well.
    if (busId === undefined || busId === ownBusId || seen.has(busId)) continue;
    seen.add(busId);
    const entry: EngineTrackSend = {
      busId,
      levelDb: send.levelDb,
      enabled: send.enabled,
    };
    if (send.timing === 'preFader') entry.sendTiming = 'preFader';
    mapped.push(entry);
  }
  return mapped;
}

type SidechainSlotFields = {
  sidechainSourceBusId?: unknown;
  sidechainSourceGroupTrackId?: unknown;
  sidechainSourceKind?: unknown;
  sidechainSourceId?: unknown;
};

/** Resolves the legacy track key and the optional bus-key shape on a slot. */
function sidechainSource(
  slot: InsertSlot,
  trackIds: ReadonlySet<number>,
  resolveBus: (storeBusId: string) => number | undefined,
): SidechainBinding | undefined {
  const fields = slot as InsertSlot & SidechainSlotFields;
  if (fields.sidechainSourceBusId !== undefined) {
    if (typeof fields.sidechainSourceBusId !== 'string') return undefined;
    const sourceId = resolveBus(fields.sidechainSourceBusId);
    return sourceId === undefined ? undefined : { sourceKind: 'bus', sourceId };
  }
  if (fields.sidechainSourceGroupTrackId !== undefined) {
    if (typeof fields.sidechainSourceGroupTrackId !== 'number') return undefined;
    const sourceId = resolveBus(`group:${fields.sidechainSourceGroupTrackId}`);
    return sourceId === undefined ? undefined : { sourceKind: 'bus', sourceId };
  }
  if (fields.sidechainSourceKind !== undefined && fields.sidechainSourceId !== undefined) {
    const kind = fields.sidechainSourceKind;
    if (kind === 'bus' || kind === 1) {
      const sourceId =
        typeof fields.sidechainSourceId === 'string'
          ? resolveBus(fields.sidechainSourceId)
          : typeof fields.sidechainSourceId === 'number'
            ? fields.sidechainSourceId
            : undefined;
      return sourceId !== undefined ? { sourceKind: 'bus', sourceId } : undefined;
    }
    if (kind === 'track' || kind === 0) {
      const sourceId =
        typeof fields.sidechainSourceId === 'number' ? fields.sidechainSourceId : undefined;
      return sourceId !== undefined && trackIds.has(sourceId)
        ? { sourceKind: 'track', sourceId }
        : undefined;
    }
    return undefined;
  }
  const sourceId = slot.sidechainSourceTrackId;
  return sourceId !== undefined && trackIds.has(sourceId)
    ? { sourceKind: 'track', sourceId }
    : undefined;
}

function isSurroundLayout(layout: MixerChannelLayout | undefined): boolean {
  return layout === '5.1' || layout === '7.1';
}

/** Returns the non-default surround metadata that strip scene JSON emits. */
function stripSceneMetadata(strip: MixerStrip | undefined): {
  sourceLayout?: MixerChannelLayout;
  surroundPan?: NonNullable<MixerStrip['surroundPan']>;
} {
  const sourceLayout = strip?.sourceLayout;
  const surroundPan = strip?.surroundPan;
  const hasSurroundPan =
    surroundPan !== undefined &&
    (surroundPan.azimuth !== DEFAULT_SURROUND_PAN.azimuth ||
      surroundPan.elevation !== DEFAULT_SURROUND_PAN.elevation ||
      surroundPan.divergence !== DEFAULT_SURROUND_PAN.divergence ||
      surroundPan.lfe !== DEFAULT_SURROUND_PAN.lfe ||
      surroundPan.distance !== DEFAULT_SURROUND_PAN.distance);
  return {
    ...(sourceLayout !== undefined && sourceLayout !== 'stereo' ? { sourceLayout } : {}),
    ...(hasSurroundPan ? { surroundPan: { ...surroundPan } } : {}),
  };
}

function stripSceneMetadataHasDsp(strip: MixerStrip | undefined): boolean {
  const metadata = stripSceneMetadata(strip);
  return metadata.sourceLayout !== undefined || metadata.surroundPan !== undefined;
}

/** Mirrors store strip/bus/send state onto a running engine. */
export interface StripSync {
  /**
   * Diffs the given state against what was last sent and emits only the changed engine calls.
   * `sceneGeneration` must advance after another mixer facade call can replay
   * retained strip JSON and thereby clear its non-scene EQ/bypass state.
   */
  sync(
    tracks: ReadonlyArray<EditorTrack>,
    mixer: ProjectMixerState,
    sceneGeneration?: number,
    pdcTrackIds?: ReadonlySet<number>,
  ): void;
  /** Engine bus id assigned to a store bus id (undefined when never seen). */
  busIdFor(storeBusId: string): number | undefined;
  /** Engine bus id assigned to a group track id (undefined when never seen). */
  groupBusIdFor(trackId: number): number | undefined;
  /** Monotonic generation of logical-to-engine bus number assignments. */
  busMappingGeneration(): number;
  /** Monotonic generation of structural scene sends that can clear automation. */
  sceneGeneration(): number;
  /** ABI-correct engine insert index for a return-bus strip slot. */
  busInsertIndexFor(storeBusId: string, storeInsertIndex: number): number | undefined;
  /** ABI-correct engine insert index for a group-track strip slot. */
  groupInsertIndexFor(trackId: number, storeInsertIndex: number): number | undefined;
}

/**
 * Creates a strip sync bound to one engine handle. Create a fresh instance
 * per engine start: all sent-state memory restarts with the engine. The
 * caller must run mixer-sync first so the mixer lanes are already declared in
 * track order before strips, buses and sends reference them.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional insert catalog for processor validation.
 * @returns The sync facade.
 */
export function createStripSync(handle: EngineHandle, options: StripSyncOptions = {}): StripSync {
  const insertCatalog = options.insertCatalog ?? null;
  const busInsertBypass = (handle.engine as unknown as BusInsertBypassEngine)
    .setBusStripInsertBypassed;
  const busEq = (handle.engine as unknown as BusEqEngine).setBusStripEqBand;
  const busPanEngine = handle.engine as unknown as BusPanEngine;
  const sidechainEngine = handle.engine as unknown as SidechainEngine;
  const supportsBusSidechain = typeof sidechainEngine.setBusSidechain === 'function';
  const supportsMasterSidechain = typeof sidechainEngine.setMasterSidechain === 'function';
  const supportsBusPan =
    typeof busPanEngine.setBusStripPan === 'function' &&
    typeof busPanEngine.setBusStripPanLaw === 'function' &&
    typeof busPanEngine.setBusStripPanMode === 'function' &&
    typeof busPanEngine.setBusStripDualPan === 'function';
  // Engine bus numbers are compacted to the currently declared bus set so UI
  // meter/scope targets stay within the engine's fixed bus telemetry range.
  // When a number is reassigned, bus-related diff caches are reset and sends /
  // output routing are replayed so stale engine state cannot alias the new bus.
  const busNumberByStoreId = new Map<string, number>();
  let busMappingGeneration = 0;
  let lastBusList: number[] = [];
  let lastBusTopologyKey = '[]';
  const lastBusGain = new Map<number, number>();
  const lastSendsByTrack = new Map<number, string>();
  const trackStripMemory = new Map<number, StripMemory>();
  const lastOutputBus = new Map<number, number>();
  const lastBusStrip = new Map<number, StripMemory>();
  const lastSidechains = new Map<string, { trackId: number; index: number; source: number }>();
  const lastBusSidechains = new Map<string, { busId: number; index: number } & SidechainBinding>();
  const lastMasterSidechains = new Map<number, SidechainBinding>();
  const retry = createRetryTimer(() => handle.ctx.state === 'closed');
  let lastArgs: Parameters<StripSync['sync']> | undefined;

  /**
   * Single owner of track-lane sidechain keys. Keys are cleared before the
   * strip they sit on changes (a replaced strip may be shorter, neutral while
   * frozen, or drop the key itself), and re-applied from the declared strips
   * once the strips exist.
   *
   * @param desired Keys the declared strips call for, by `track:insert`.
   * @param replacedTrackId When set, clear every key of that track only,
   *   because its strip is about to be replaced; nothing is applied.
   */
  const settleTrackSidechains = (
    desired: ReadonlyMap<string, { trackId: number; index: number; source: number }>,
    replacedTrackId?: number,
  ): void => {
    for (const [key, binding] of lastSidechains) {
      if (replacedTrackId === undefined ? desired.has(key) : binding.trackId !== replacedTrackId) {
        continue;
      }
      handle.engine.setLaneSidechain(binding.trackId, binding.index, null);
      lastSidechains.delete(key);
    }
    if (replacedTrackId !== undefined) return;
    for (const [key, binding] of desired) {
      const previous = lastSidechains.get(key);
      if (previous && previous.source === binding.source) continue;
      handle.engine.setLaneSidechain(binding.trackId, binding.index, binding.source);
      lastSidechains.set(key, binding);
    }
  };

  const clearBusSidechains = (busId?: number): void => {
    if (!supportsBusSidechain) return;
    for (const [key, binding] of lastBusSidechains) {
      if (busId !== undefined && binding.busId !== busId) continue;
      sidechainEngine.setBusSidechain?.(binding.busId, binding.index, binding.sourceKind, 0);
      lastBusSidechains.delete(key);
    }
  };
  const clearMasterSidechains = (): void => {
    if (!supportsMasterSidechain) return;
    for (const [insertIndex, binding] of lastMasterSidechains) {
      sidechainEngine.setMasterSidechain?.(insertIndex, binding.sourceKind, 0);
      lastMasterSidechains.delete(insertIndex);
    }
  };
  let masterStripMemory: StripMemory | undefined;
  let lastSceneGeneration: number | undefined;
  let stripSceneGeneration = 0;
  let busStripsByStoreId = new Map<string, MixerStrip | undefined>();
  let groupStripsByTrackId = new Map<number, MixerStrip | undefined>();

  /**
   * Syncs one strip target, returning the new memory (undefined when the
   * target still has nothing to declare).
   */
  const syncStrip = (
    target: number | 'master',
    strip: MixerStrip | undefined,
    memory: StripMemory | undefined,
    sendStripJson: (sceneJson: string) => void,
    sendInsertParam: (insertIndex: number, paramName: string, value: number) => void,
    forceScene = false,
    ensureScene = false,
  ): StripMemory | undefined => {
    const inserts = strip?.inserts ?? [];
    const insertParams = insertNumericParams(inserts);
    const sceneMetadata = stripSceneMetadata(strip);
    const structureKey = JSON.stringify({
      inputTrimDb: strip?.inputTrimDb ?? 0,
      width: strip?.width ?? 1,
      polarityInvertLeft: strip?.polarityInvertLeft === true,
      polarityInvertRight: strip?.polarityInvertRight === true,
      ...sceneMetadata,
      ...(target === 'master' ? { panner: engineBusPanState(strip) } : {}),
      inserts: inserts.map((slot) => ({
        processor: slot.processor,
        params: insertParamStructure(slot),
      })),
    });
    // Individual band enabled/bypassed flags are forwarded as-is inside the
    // band objects; an EQ disabled as a whole contributes no bands.
    const effectiveEqBands = engineEqBands(strip);
    const enabled = inserts.map((slot) => slot.enabled);
    const removedPatchableRootParam =
      memory !== undefined &&
      hasRemovedPatchableRootParam(memory.insertParams, insertParams, inserts);

    const hasSceneDsp =
      stripSceneFieldsHaveDsp(strip) ||
      stripSceneMetadataHasDsp(strip) ||
      (target === 'master' && engineMasterPannerHasDsp(strip));
    if (
      !memory &&
      !ensureScene &&
      !hasSceneDsp &&
      inserts.length === 0 &&
      effectiveEqBands.length === 0
    ) {
      return undefined;
    }

    if (
      forceScene ||
      !memory ||
      memory.structureKey !== structureKey ||
      removedPatchableRootParam
    ) {
      // Full re-send: the engine replaces the whole strip, resetting its EQ
      // bands and bypass flags, so both are replayed after the JSON.
      sendStripJson(stripSceneJson(target, strip, insertCatalog));
      const eqBandJson: string[] = [];
      for (let i = 0; i < inserts.length; i += 1) {
        handle.engine.setStripInsertBypassed(target, i, !enabled[i]);
      }
      for (let i = 0; i < effectiveEqBands.length; i += 1) {
        handle.engine.setStripEq(target, i, effectiveEqBands[i]);
        eqBandJson.push(JSON.stringify(effectiveEqBands[i]));
      }
      return { structureKey, insertParams, enabled, eqBandJson };
    }

    // Structure unchanged: patch numeric insert params, toggle bypass flags
    // and diff EQ bands in place.
    syncInsertNumericParams(memory.insertParams, insertParams, sendInsertParam);
    for (let i = 0; i < enabled.length; i += 1) {
      if (memory.enabled[i] !== enabled[i]) {
        handle.engine.setStripInsertBypassed(target, i, !enabled[i]);
      }
    }
    const bandCount = Math.max(memory.eqBandJson.length, effectiveEqBands.length);
    const eqBandJson: string[] = [];
    for (let i = 0; i < bandCount; i += 1) {
      // Indexes past the new band list are cleared with a disabled band.
      const nextBand: EqBand = effectiveEqBands[i] ?? { enabled: false };
      const json = JSON.stringify(nextBand);
      if (memory.eqBandJson[i] !== json) handle.engine.setStripEq(target, i, nextBand);
      eqBandJson.push(json);
    }
    return { structureKey, insertParams, enabled, eqBandJson };
  };

  const syncBusStrip = (
    busId: number,
    strip: MixerStrip | undefined,
    memory: StripMemory | undefined,
    forceScene = false,
    onSceneSend?: () => void,
    channelLayout?: MixerChannelLayout,
  ): StripMemory | undefined => {
    const supportsBypass = typeof busInsertBypass === 'function';
    const supportsBusEq = typeof busEq === 'function';
    const surroundBus = isSurroundLayout(channelLayout);
    const structureKey = busStripDspKey(
      strip,
      !supportsBypass,
      !supportsBusPan || surroundBus,
      channelLayout,
    );
    const sceneStrip = supportsBypass ? strip : engineBusStrip(strip);
    const sceneInserts = sceneStrip?.inserts ?? [];
    const insertParams = insertNumericParams(sceneInserts);
    const enabled = sceneInserts.map((slot) => slot.enabled);
    const removedPatchableRootParam =
      memory !== undefined &&
      hasRemovedPatchableRootParam(memory.insertParams, insertParams, sceneInserts);
    const effectiveEqBands = supportsBusEq ? engineEqBands(strip) : [];
    const hasSceneDsp =
      stripSceneFieldsHaveDsp(strip) ||
      (!surroundBus && engineBusPanHasDsp(strip)) ||
      effectiveEqBands.length > 0;
    const busPan = surroundBus ? engineBusPanState(undefined) : engineBusPanState(strip);

    if (!memory && !hasSceneDsp && sceneInserts.length === 0 && !forceScene) {
      return undefined;
    }

    if (
      forceScene ||
      !memory ||
      memory.structureKey !== structureKey ||
      removedPatchableRootParam
    ) {
      onSceneSend?.();
      handle.engine.setBusStripJson(
        busId,
        busSceneJson(busId, sceneStrip, insertCatalog, {
          includeEq: supportsBusEq,
          channelLayout,
        }),
      );
      if (supportsBypass) {
        enabled.forEach((slotEnabled, insertIndex) => {
          busInsertBypass.call(handle.engine, busId, insertIndex, !slotEnabled);
        });
      }
      const eqBandJson: string[] = [];
      if (supportsBusEq) {
        effectiveEqBands.forEach((band, bandIndex) => {
          busEq.call(handle.engine, busId, bandIndex, band);
          eqBandJson.push(JSON.stringify(band));
        });
      }
      return { structureKey, insertParams, enabled, eqBandJson, busPan };
    }

    syncInsertNumericParams(memory.insertParams, insertParams, (insertIndex, paramName, value) => {
      handle.engine.setBusStripInsertParamByName(busId, insertIndex, paramName, value);
    });
    if (supportsBypass) {
      enabled.forEach((slotEnabled, insertIndex) => {
        if (memory.enabled[insertIndex] !== slotEnabled) {
          busInsertBypass.call(handle.engine, busId, insertIndex, !slotEnabled);
        }
      });
    }
    const bandCount = Math.max(memory.eqBandJson.length, effectiveEqBands.length);
    const eqBandJson: string[] = [];
    if (supportsBusEq) {
      for (let i = 0; i < bandCount; i += 1) {
        const nextBand: EqBand = effectiveEqBands[i] ?? { enabled: false };
        const json = JSON.stringify(nextBand);
        if (memory.eqBandJson[i] !== json) busEq.call(handle.engine, busId, i, nextBand);
        eqBandJson.push(json);
      }
    }
    if (supportsBusPan && !surroundBus) {
      const previousPan = memory.busPan ?? engineBusPanState(undefined);
      if (previousPan.pan !== busPan.pan) busPanEngine.setBusStripPan?.(busId, busPan.pan);
      if (previousPan.panLaw !== busPan.panLaw) {
        busPanEngine.setBusStripPanLaw?.(busId, busPan.panLaw);
      }
      if (previousPan.panMode !== busPan.panMode) {
        busPanEngine.setBusStripPanMode?.(busId, busPan.panMode);
      }
      if (
        previousPan.dualPanLeft !== busPan.dualPanLeft ||
        previousPan.dualPanRight !== busPan.dualPanRight
      ) {
        busPanEngine.setBusStripDualPan?.(busId, busPan.dualPanLeft, busPan.dualPanRight);
      }
    }
    return { structureKey, insertParams, enabled, eqBandJson, busPan };
  };

  // The sync phase order is load-bearing:
  // 1. assign engine numbers to unseen store buses,
  // 2. prune sends still referencing a bus about to disappear (the engine
  //    must never hold a send to an undeclared bus),
  // 3. declare/re-declare the bus set, or adjust changed gains in place,
  // 4. send the final per-track send lists,
  // 5. sync the track strips, then the master strip.
  const sync = (
    tracks: ReadonlyArray<EditorTrack>,
    mixer: ProjectMixerState,
    sceneGeneration?: number,
    pdcTrackIds?: ReadonlySet<number>,
  ): void => {
    lastArgs = [tracks, mixer, sceneGeneration, pdcTrackIds];
    let gainRefused = false;
    // The facade retains strip JSON and can replay it as part of a structural
    // mixer command (notably setTrackLanes). That replacement clears master
    // EQ, bypass and by-name parameters, which live outside that JSON.
    let replayMasterState =
      sceneGeneration !== undefined && lastSceneGeneration !== sceneGeneration;
    lastSceneGeneration = sceneGeneration;
    // Group tracks consume engine buses next to the user send buses.
    const groupTracks = tracks.filter((track) => track.kind === 'group');
    const vcaGainDb = new Map((mixer.vcaGroups ?? []).map((group) => [group.id, group.gainDb]));
    const vcaControls: ReadonlyMap<string, VcaControlState> = new Map(
      (mixer.vcaGroups ?? []).map((group) => [group.id, group]),
    );
    // A soloed return needs one spare engine bus to park the silenced direct
    // outputs on; the command layer refuses to solo when none is free.
    const returnSolo = returnSoloRouting(mixer.buses);
    const soloDiscardBus =
      returnSolo.active && mixer.buses.length + groupTracks.length < MAX_ENGINE_BUSES;
    if (mixer.buses.length + groupTracks.length + (soloDiscardBus ? 1 : 0) > MAX_ENGINE_BUSES) {
      throw new Error(
        `Too many mixer buses for the engine: ${mixer.buses.length} send buses + ` +
          `${groupTracks.length} group tracks > ${MAX_ENGINE_BUSES}`,
      );
    }
    busStripsByStoreId = new Map(mixer.buses.map((bus) => [bus.id, bus.strip]));
    groupStripsByTrackId = new Map(groupTracks.map((track) => [track.id, track.mixer]));

    const busKeys = [
      ...mixer.buses.map((bus) => bus.id),
      ...groupTracks.map((group) => `group:${group.id}`),
      ...(soloDiscardBus ? [RETURN_SOLO_DISCARD_BUS_KEY] : []),
    ];
    const hadBusMapping = busNumberByStoreId.size > 0;
    const busMappingChanged =
      busNumberByStoreId.size !== busKeys.length ||
      busKeys.some((key, index) => busNumberByStoreId.get(key) !== index + 1);
    if (busMappingChanged) {
      // Clear bindings that use compacted bus numbers before replacing the
      // declaration. Once the new map is installed, the old number may refer
      // to a different logical bus and a retained key would alias it.
      clearBusSidechains();
      clearMasterSidechains();
      // Track sends carry compact numeric ids too. Even when an old id is
      // still present in the replacement list, it may now name a different
      // logical bus; clear before set_buses and replay from the store below.
      for (const [trackId, json] of lastSendsByTrack) {
        if (json === '[]') continue;
        handle.engine.setTrackSends(trackId, []);
        lastSendsByTrack.set(trackId, '[]');
      }
      busMappingGeneration += 1;
      busNumberByStoreId.clear();
      busKeys.forEach((key, index) => {
        busNumberByStoreId.set(key, index + 1);
      });
      lastBusList = [];
      lastBusTopologyKey = '';
      lastBusGain.clear();
      lastBusStrip.clear();
    }
    // A logical bus can inherit a compacted engine number. Re-send a complete
    // (including neutral) scene for every surviving target so prior inserts or
    // EQ from the bus formerly using that number cannot remain in the worklet.
    const reapplyBusScenes = hadBusMapping && busMappingChanged;
    const groupBusByTrackId = new Map(
      groupTracks.map((group) => [group.id, busNumberByStoreId.get(`group:${group.id}`) as number]),
    );
    const discardBusNumber = soloDiscardBus
      ? (busNumberByStoreId.get(RETURN_SOLO_DISCARD_BUS_KEY) as number)
      : undefined;
    const newBusIds = [
      ...mixer.buses.map((bus) => busNumberByStoreId.get(bus.id) as number),
      ...groupTracks.map((group) => groupBusByTrackId.get(group.id) as number),
      ...(discardBusNumber === undefined ? [] : [discardBusNumber]),
    ];
    const newBusIdSet = new Set(newBusIds);
    // The project keeps bus-to-bus routing on the return/group strip. Resolve
    // both ordinary store ids and the synthetic `group:<trackId>` ids before
    // declaring the buses, then omit stale destinations that the engine would
    // reject. Bus topology is compared separately from gain so fader moves can
    // continue using the smoothed setBusGain path.
    const resolveBusId = (storeBusId: string): number | undefined =>
      busNumberByStoreId.get(storeBusId) ?? busNumberByStoreId.get(`group:${storeBusId}`);
    const busDeclaration = (
      busId: number,
      gainDb: number,
      strip: MixerStrip | undefined,
      outputBusIdStore?: string,
      channelLayout?: MixerChannelLayout,
    ): EngineBusDeclaration => {
      const declaration: EngineBusDeclaration = { busId, gainDb };
      if (channelLayout !== undefined && channelLayout !== 'stereo') {
        declaration.channelLayout = mixerChannelLayoutCode(channelLayout);
      }
      const outputBusIdSource = outputBusIdStore ?? strip?.outputBusId;
      const outputBusId =
        outputBusIdSource === undefined ? undefined : resolveBusId(outputBusIdSource);
      if (outputBusId !== undefined && outputBusId !== busId) {
        declaration.outputBusId = outputBusId;
      }
      const sends = engineBusSends(strip?.sends, resolveBusId, busId);
      if (sends.length > 0) declaration.sends = sends;
      return declaration;
    };
    const busDeclarations: EngineBusDeclaration[] = [
      ...mixer.buses.map((bus) =>
        busDeclaration(
          busNumberByStoreId.get(bus.id) as number,
          returnSolo.busGainDb(bus),
          bus.strip,
          bus.strip?.outputBusId,
          bus.channelLayout,
        ),
      ),
      ...groupTracks.map((group) =>
        busDeclaration(
          groupBusByTrackId.get(group.id) as number,
          // A soloed return auditions alone, so group submixes fall silent with
          // the direct outputs of their members.
          returnSolo.active
            ? SILENCE_DB
            : groupBusGainDb(
                group,
                vcaOffsetDb(group.vcaId, vcaGainDb),
                effectiveTrackMute(group.mute, group.vcaId, vcaControls),
              ),
          group.mixer,
          undefined,
          undefined,
        ),
      ),
      ...(discardBusNumber === undefined
        ? []
        : [busDeclaration(discardBusNumber, SILENCE_DB, undefined)]),
    ];
    const busTopologyKey = JSON.stringify(
      busDeclarations.map(({ busId, channelLayout, outputBusId, sends }) => ({
        busId,
        channelLayout,
        outputBusId,
        sends,
      })),
    );
    const busDeclarationChanged =
      newBusIds.length !== lastBusList.length ||
      newBusIds.some((busId, i) => busId !== lastBusList[i]) ||
      busTopologyKey !== lastBusTopologyKey;

    const desiredTrackOutputBus = (track: EditorTrack): number => {
      if (discardBusNumber !== undefined && track.kind !== 'group') {
        // Park the direct output on the silent bus during return solo.
        return discardBusNumber;
      }
      if (track.groupId !== undefined) {
        return groupBusByTrackId.get(track.groupId) ?? 0;
      }
      if (track.kind !== 'group') {
        const userBusId = track.mixer?.outputBusId;
        if (userBusId !== undefined) {
          const busNumber = resolveBusId(userBusId);
          if (busNumber !== undefined && newBusIdSet.has(busNumber)) return busNumber;
        }
      }
      return 0;
    };

    // A deleted track keeps its (now muted) engine lane, but muting only
    // silences the fader path: a pre-fader send would keep feeding its bus, and
    // its lingering send could point at a bus this sync is about to remove
    // (making setTrackBuses reject a send to an undeclared bus). Clear the sends
    // of every track that vanished from the project, and drop the stale
    // per-track memory so it cannot alias or leak.
    const presentTrackIds = new Set(tracks.map((track) => track.id));
    for (const trackId of [...lastSendsByTrack.keys()]) {
      if (presentTrackIds.has(trackId)) continue;
      if (lastSendsByTrack.get(trackId) !== '[]') {
        handle.engine.setTrackSends(trackId, []);
        replayMasterState = true;
      }
      lastSendsByTrack.delete(trackId);
    }
    for (const trackId of [...trackStripMemory.keys()]) {
      if (!presentTrackIds.has(trackId)) trackStripMemory.delete(trackId);
    }
    // set_buses validates every lane's *current* output bus before applying
    // the new declaration. Clear all routes we have installed first, including
    // retired lanes that mixer-sync intentionally keeps alive, then replay the
    // desired destinations after setTrackBuses succeeds. This also handles a
    // compact-number remap where the old numeric id is still declared but now
    // names another logical bus.
    if (busDeclarationChanged) {
      for (const [trackId, outputBus] of lastOutputBus) {
        if (outputBus === 0) continue;
        handle.engine.setTrackOutputBus(trackId, 0);
        replayMasterState = true;
        lastOutputBus.set(trackId, 0);
      }
    }
    for (const trackId of [...lastOutputBus.keys()]) {
      if (presentTrackIds.has(trackId)) continue;
      const outputBus = lastOutputBus.get(trackId) ?? 0;
      if (outputBus !== 0) {
        // Retired lanes remain in the native mixer registry. Clear their
        // route before dropping host memory, otherwise a later bus removal
        // would fail set_buses validation with an output to that stale bus.
        handle.engine.setTrackOutputBus(trackId, 0);
        replayMasterState = true;
      }
      lastOutputBus.delete(trackId);
    }

    // Prune stale sends before re-declaring the bus set.
    for (const track of tracks) {
      const lastJson = lastSendsByTrack.get(track.id);
      if (lastJson === undefined) continue;
      const lastSends = JSON.parse(lastJson) as EngineTrackSend[];
      if (lastSends.some((send) => !newBusIdSet.has(send.busId))) {
        const pruned = lastSends.filter((send) => newBusIdSet.has(send.busId));
        handle.engine.setTrackSends(track.id, pruned);
        replayMasterState = true;
        lastSendsByTrack.set(track.id, JSON.stringify(pruned));
      }
    }

    // A bus declaration replacement can invalidate a keyed bus target or
    // create a new graph cycle with an existing bus source. Clear bindings
    // while the old bus strips still exist; they are rebound after the new
    // bus/strip declarations below. Mapping changes already cleared them
    // above, before the compact ids were assigned.
    if (busDeclarationChanged && !busMappingChanged) {
      clearBusSidechains();
      clearMasterSidechains();
    }

    // Declare buses, or adjust gains of an unchanged bus set in place.
    if (busDeclarationChanged) {
      handle.engine.setTrackBuses(busDeclarations.map((entry) => ({ ...entry })));
      replayMasterState = true;
      lastBusList = newBusIds;
      lastBusTopologyKey = busTopologyKey;
      lastBusGain.clear();
      for (const entry of busDeclarations) {
        lastBusGain.set(entry.busId, entry.gainDb);
      }
    } else {
      for (const entry of busDeclarations) {
        if (lastBusGain.get(entry.busId) !== entry.gainDb) {
          // A refused gain stays unrecorded and is re-sent by the retry.
          if (handle.engine.setBusGain(entry.busId, entry.gainDb)) {
            lastBusGain.set(entry.busId, entry.gainDb);
          } else {
            gainRefused = true;
          }
        }
      }
    }

    // Output-bus routing (group wins over a user-chosen send bus, which wins
    // over the master mix). Group members route through their group's bus; a
    // non-grouped track strip may route into any declared send bus. The bus
    // must already be in the declared set (the engine rejects a lane pointed
    // at an undeclared bus), so an outputBusId naming a pruned/missing bus
    // falls back to the master mix.
    for (const track of tracks) {
      const outputBus = desiredTrackOutputBus(track);
      if ((lastOutputBus.get(track.id) ?? 0) !== outputBus) {
        handle.engine.setTrackOutputBus(track.id, outputBus);
        replayMasterState = true;
        lastOutputBus.set(track.id, outputBus);
      }
    }

    // Final per-track sends (deduped; an absent entry means "no sends sent",
    // which matches the engine's initial state).
    for (const track of tracks) {
      const desired = engineBusSends(track.mixer?.sends, resolveBusId);
      const json = JSON.stringify(desired);
      if ((lastSendsByTrack.get(track.id) ?? '[]') !== json) {
        handle.engine.setTrackSends(track.id, desired);
        replayMasterState = true;
        lastSendsByTrack.set(track.id, json);
      }
    }

    // Track strips (group tracks carry their inserts on their bus strip
    // instead of the silent lane strip), then return-bus strips and master.
    for (const bus of mixer.buses) {
      const busId = busNumberByStoreId.get(bus.id) as number;
      if (!bus.strip && !lastBusStrip.has(busId) && !reapplyBusScenes) continue;
      const memory = syncBusStrip(
        busId,
        bus.strip,
        lastBusStrip.get(busId),
        reapplyBusScenes,
        () => {
          // Replacing a bus strip may drop keyed inserts whose indexes no
          // longer exist. Clear the old binding before the native JSON setter
          // so the later diff never tries to clear an already-dropped slot.
          clearBusSidechains(busId);
          replayMasterState = true;
        },
        bus.channelLayout,
      );
      if (memory) lastBusStrip.set(busId, memory);
    }

    // Bindings are diffed per (track, insertIndex). A frozen track's strip is
    // neutral, so it carries no keys.
    const desiredSidechains = new Map<string, { trackId: number; index: number; source: number }>();
    const trackIds = new Set(tracks.map((track) => track.id));
    for (const track of tracks) {
      if (track.kind === 'group' || track.frozen !== undefined) continue;
      (track.mixer?.inserts ?? []).forEach((slot, index) => {
        const source = slot.sidechainSourceTrackId;
        if (source === undefined || source === track.id || !trackIds.has(source)) return;
        desiredSidechains.set(`${track.id}:${index}`, { trackId: track.id, index, source });
      });
    }

    for (const track of tracks) {
      if (track.kind === 'group') {
        const busId = groupBusByTrackId.get(track.id) as number;
        const memory = syncBusStrip(
          busId,
          track.mixer,
          lastBusStrip.get(busId),
          reapplyBusScenes,
          () => {
            clearBusSidechains(busId);
            replayMasterState = true;
          },
        );
        if (memory) lastBusStrip.set(busId, memory);
        continue;
      }
      // Frozen tracks bypass their strip DSP: the inserts/EQ are baked into
      // the frozen render, so the engine strip goes neutral while frozen.
      const stripState = track.frozen !== undefined ? undefined : track.mixer;
      const memory = syncStrip(
        track.id,
        stripState,
        trackStripMemory.get(track.id),
        (json) => {
          replayMasterState = true;
          settleTrackSidechains(desiredSidechains, track.id);
          handle.engine.setTrackStripJson(track.id, json);
        },
        (insertIndex, paramName, value) =>
          handle.engine.setTrackStripInsertParamByName(track.id, insertIndex, paramName, value),
        false,
        pdcTrackIds?.has(track.id) ?? false,
      );
      if (memory) trackStripMemory.set(track.id, memory);
    }
    masterStripMemory = syncStrip(
      'master',
      liveMasterStrip(mixer.master, mixer.masteringChain, insertCatalog),
      masterStripMemory,
      (json) => {
        // As with buses, the full master strip replacement can retire an
        // insert index. Remove its keyed source while the old chain exists.
        clearMasterSidechains();
        replayMasterState = true;
        handle.engine.setMasterStripJson(json);
      },
      (insertIndex, paramName, value) =>
        handle.engine.setMasterStripInsertParamByName(insertIndex, paramName, value),
      replayMasterState,
    );

    // Insert sidechain keys, replayed after the strips exist.
    settleTrackSidechains(desiredSidechains);

    // Bus and master strips use the newer keyed-source ABI. Bus source ids
    // must be resolved after compacting the project buses, and disabled legacy
    // bus inserts use their compacted engine index when the bypass setter is
    // unavailable.
    if (supportsBusSidechain) {
      const desiredBusSidechains = new Map<
        string,
        { busId: number; index: number } & SidechainBinding
      >();
      const collectBusSidechains = (busId: number, strip: MixerStrip | undefined): void => {
        for (let storeIndex = 0; storeIndex < (strip?.inserts.length ?? 0); storeIndex += 1) {
          const engineIndex = engineBusInsertAutomationIndex(
            strip,
            storeIndex,
            typeof busInsertBypass === 'function',
          );
          if (engineIndex === undefined) continue;
          const source = sidechainSource(
            strip?.inserts[storeIndex] as InsertSlot,
            trackIds,
            resolveBusId,
          );
          if (!source || (source.sourceKind === 'bus' && source.sourceId === busId)) continue;
          desiredBusSidechains.set(`${busId}:${engineIndex}`, {
            busId,
            index: engineIndex,
            ...source,
          });
        }
      };
      for (const bus of mixer.buses) {
        collectBusSidechains(busNumberByStoreId.get(bus.id) as number, bus.strip);
      }
      for (const group of groupTracks) {
        collectBusSidechains(groupBusByTrackId.get(group.id) as number, group.mixer);
      }
      for (const [key, binding] of lastBusSidechains) {
        if (desiredBusSidechains.has(key)) continue;
        sidechainEngine.setBusSidechain?.(binding.busId, binding.index, binding.sourceKind, 0);
        lastBusSidechains.delete(key);
      }
      for (const [key, binding] of desiredBusSidechains) {
        const previous = lastBusSidechains.get(key);
        if (
          previous &&
          previous.sourceKind === binding.sourceKind &&
          previous.sourceId === binding.sourceId
        ) {
          continue;
        }
        sidechainEngine.setBusSidechain?.(
          binding.busId,
          binding.index,
          binding.sourceKind,
          binding.sourceId,
        );
        lastBusSidechains.set(key, binding);
      }
    }

    if (supportsMasterSidechain) {
      const desiredMasterSidechains = new Map<number, SidechainBinding>();
      const master = liveMasterStrip(mixer.master, mixer.masteringChain, insertCatalog);
      master.inserts.forEach((slot, index) => {
        const source = sidechainSource(slot, trackIds, resolveBusId);
        if (source) desiredMasterSidechains.set(index, source);
      });
      for (const [index, binding] of lastMasterSidechains) {
        if (desiredMasterSidechains.has(index)) continue;
        sidechainEngine.setMasterSidechain?.(index, binding.sourceKind, 0);
        lastMasterSidechains.delete(index);
      }
      for (const [index, binding] of desiredMasterSidechains) {
        const previous = lastMasterSidechains.get(index);
        if (
          previous &&
          previous.sourceKind === binding.sourceKind &&
          previous.sourceId === binding.sourceId
        ) {
          continue;
        }
        sidechainEngine.setMasterSidechain?.(index, binding.sourceKind, binding.sourceId);
        lastMasterSidechains.set(index, binding);
      }
    }
    if (replayMasterState) stripSceneGeneration += 1;
    if (gainRefused)
      retry.schedule('sync', () => sync(...(lastArgs as Parameters<StripSync['sync']>)));
  };

  return {
    sync,
    busIdFor: (storeBusId) => busNumberByStoreId.get(storeBusId),
    groupBusIdFor: (trackId) => busNumberByStoreId.get(`group:${trackId}`),
    busMappingGeneration: () => busMappingGeneration,
    sceneGeneration: () => stripSceneGeneration,
    busInsertIndexFor: (storeBusId, storeInsertIndex) =>
      engineBusInsertAutomationIndex(
        busStripsByStoreId.get(storeBusId),
        storeInsertIndex,
        typeof busInsertBypass === 'function',
      ),
    groupInsertIndexFor: (trackId, storeInsertIndex) =>
      engineBusInsertAutomationIndex(
        groupStripsByTrackId.get(trackId),
        storeInsertIndex,
        typeof busInsertBypass === 'function',
      ),
  };
}
