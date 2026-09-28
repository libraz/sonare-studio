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
  type MasteringChainState,
  type MixerChannelLayout,
  type MixerStrip,
  mixerChannelLayoutCode,
  type ProjectMixerState,
  returnSoloRouting,
  type StripSend,
  type VcaControlState,
  vcaOffsetDb,
} from '@/project/mixer';
import { isConstructionOnlyParam } from '@/project/processor-controls';
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

/** Maximum number of mixer buses the realtime engine supports. */
export const MAX_ENGINE_BUSES = 8;

/** Bus-map key of the silent bus that parks direct outputs during a return solo. */
const RETURN_SOLO_DISCARD_BUS_KEY = 'return-solo-discard';

/** Options for {@link createStripSync}. */
export interface StripSyncOptions {
  /** Known insert processor names for validation; null/undefined skips validation. */
  insertCatalog?: ReadonlySet<string> | null;
}

export interface BusSceneJsonOptions {
  /** Include bus EQ metadata for engines that expose the bus-EQ ABI. */
  includeEq?: boolean;
  /** Channel layout of the bus; absent keeps the stereo default. */
  channelLayout?: MixerChannelLayout;
}

/**
 * Builds the scene JSON declaring one BUS strip's insert chain (group
 * tracks; exported for tests). Mirrors {@link stripSceneJson} but emits the
 * scene's buses list, which setBusStripJson consumes.
 */
export function busSceneJson(
  busId: number,
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
  options: BusSceneJsonOptions = {},
): string {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } };
  });
  // The bus carries the same output trim/width/polarity stages a strip exposes;
  // each is emitted only when non-default so an unshaped bus stays byte-identical.
  const bus: {
    id: string;
    role: string;
    inserts: typeof inserts;
    layout?: MixerChannelLayout;
    inputTrimDb?: number;
    width?: number;
    polarityInvertLeft?: boolean;
    polarityInvertRight?: boolean;
    pan?: number;
    panMode?: number;
    dualPanLeft?: number;
    dualPanRight?: number;
    panLaw?: number;
    eq?: { enabled: true; bands: EqBand[] };
  } = { id: `bus-${busId}`, role: 'submix', inserts };
  const channelLayout = options.channelLayout;
  const surroundBus = channelLayout === '5.1' || channelLayout === '7.1';
  if (channelLayout !== undefined && channelLayout !== 'stereo') {
    bus.layout = channelLayout;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) bus.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (!surroundBus && width !== 1) bus.width = width;
  if (strip?.polarityInvertLeft === true) bus.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) bus.polarityInvertRight = true;
  const pan = engineBusPanState(strip);
  if (!surroundBus) {
    if (pan.pan !== 0) bus.pan = pan.pan;
    if (pan.panMode !== 0) bus.panMode = pan.panMode;
    if (pan.dualPanLeft !== -1) bus.dualPanLeft = pan.dualPanLeft;
    if (pan.dualPanRight !== 1) bus.dualPanRight = pan.dualPanRight;
    if (pan.panLaw !== 0) bus.panLaw = pan.panLaw;
  }
  const eqBands = options.includeEq ? engineEqBands(strip) : [];
  if (eqBands.length > 0) bus.eq = { enabled: true, bands: eqBands };
  return JSON.stringify({ version: 1, strips: [], buses: [bus], connections: [] });
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

/**
 * Builds the scene JSON declaring one strip's insert chain (exported for
 * tests). Track strips leave faderDb/pan on the mixer lane. Master strip JSON
 * repeats its current fader/pan because replacing the master scene resets
 * those scalars in libsonare. EQ is edited per band after the JSON send. Each insert's
 * "params" value is embedded as an object, the form the engine writes.
 *
 * @param target Track id, or 'master' for the master strip.
 * @param strip Store strip (undefined = neutral, declares an empty strip).
 * @param insertCatalog Known processor names; a non-null catalog rejects
 *   unknown processors instead of silently dropping them.
 * @returns The scene JSON string for setTrackStripJson/setMasterStripJson.
 */
export function stripSceneJson(
  target: number | 'master',
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): string {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } };
  });
  const id = target === 'master' ? 'master' : `track-${target}`;
  const sceneStrip: Record<string, unknown> = { id, inserts };
  if (target === 'master') {
    if ((strip?.gainDb ?? 0) !== 0) sceneStrip.faderDb = strip?.gainDb;
    if ((strip?.pan ?? 0) !== 0) sceneStrip.pan = strip?.pan;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) sceneStrip.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (width !== 1) sceneStrip.width = width;
  if (strip?.polarityInvertLeft === true) sceneStrip.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) sceneStrip.polarityInvertRight = true;
  if (strip?.sourceLayout !== undefined && strip.sourceLayout !== 'stereo') {
    sceneStrip.sourceLayout = strip.sourceLayout;
  }
  const surroundPan = strip?.surroundPan;
  if (
    surroundPan &&
    (surroundPan.azimuth !== DEFAULT_SURROUND_PAN.azimuth ||
      surroundPan.elevation !== DEFAULT_SURROUND_PAN.elevation ||
      surroundPan.divergence !== DEFAULT_SURROUND_PAN.divergence ||
      surroundPan.lfe !== DEFAULT_SURROUND_PAN.lfe ||
      surroundPan.distance !== DEFAULT_SURROUND_PAN.distance)
  ) {
    sceneStrip.surroundPan = { ...surroundPan };
  }
  if (target === 'master') {
    const panner = engineBusPanState(strip);
    if (panner.panLaw !== 0) sceneStrip.panLaw = panner.panLaw;
    if (panner.panMode !== 0) sceneStrip.panMode = panner.panMode;
    if (panner.dualPanLeft !== -1) sceneStrip.dualPanLeft = panner.dualPanLeft;
    if (panner.dualPanRight !== 1) sceneStrip.dualPanRight = panner.dualPanRight;
  }
  return JSON.stringify({ version: 1, strips: [sceneStrip], buses: [], connections: [] });
}

/** True for a numeric insert param the engine can patch without rebuilding the insert. */
function isPatchableParam(slot: InsertSlot, key: string, value: unknown): value is number {
  return typeof value === 'number' && !isConstructionOnlyParam(slot.processor, key);
}

/**
 * Insert params that affect scene structure: every value the engine reads only
 * while building the insert. Patchable numeric values are masked out.
 */
function insertParamStructure(slot: InsertSlot): Record<string, number | boolean | null> {
  return Object.fromEntries(
    Object.entries(slot.params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, isPatchableParam(slot, key, value) ? null : value]),
  );
}

/** Patchable numeric insert params last seen by the engine, keyed by insert index. */
function insertNumericParams(inserts: ReadonlyArray<InsertSlot>): Array<Record<string, number>> {
  return inserts.map((slot) =>
    Object.fromEntries(
      Object.entries(slot.params)
        .filter((entry): entry is [string, number] => isPatchableParam(slot, entry[0], entry[1]))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

/** Replays changed numeric insert params without replacing the whole strip scene. */
function syncInsertNumericParams(
  previous: ReadonlyArray<Record<string, number>>,
  next: ReadonlyArray<Record<string, number>>,
  sendInsertParam: (insertIndex: number, paramName: string, value: number) => void,
): void {
  for (let insertIndex = 0; insertIndex < next.length; insertIndex += 1) {
    const previousParams = previous[insertIndex] ?? {};
    for (const [paramName, value] of Object.entries(next[insertIndex])) {
      if (previousParams[paramName] !== value) sendInsertParam(insertIndex, paramName, value);
    }
  }
}

/**
 * Change-detection key for a bus strip's audible DSP. Folds the insert structure
 * together with the output trim/width/polarity stages so a change in any of them
 * re-sends the bus scene (the insert structure alone would miss a trim/width/
 * polarity edit that touched no insert). Numeric insert values are excluded so
 * knob drags can use the realtime param setter instead of replacing the scene.
 */
function busStripDspKey(
  strip: MixerStrip | undefined,
  includeEnabled: boolean,
  includePan: boolean,
  channelLayout?: MixerChannelLayout,
): string {
  return JSON.stringify({
    ...(channelLayout !== undefined && channelLayout !== 'stereo' ? { channelLayout } : {}),
    inserts: (strip?.inserts ?? []).map((slot) => ({
      processor: slot.processor,
      params: insertParamStructure(slot),
      ...(includeEnabled ? { enabled: slot.enabled } : {}),
    })),
    inputTrimDb: strip?.inputTrimDb ?? 0,
    width: strip?.width ?? 1,
    polarityInvertLeft: strip?.polarityInvertLeft === true,
    polarityInvertRight: strip?.polarityInvertRight === true,
    ...(includePan ? { pan: engineBusPanState(strip) } : {}),
  });
}

/**
 * Live playback has no separate post-master mastering-chain node. Mirror the
 * realtime-safe processor slots by appending them to the master strip scene;
 * the opaque preset and offline-only processors remain export-only.
 */
export function liveMasterStrip(
  master: MixerStrip,
  chain: MasteringChainState | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): MixerStrip {
  const realtimeProcessors = (chain?.processors ?? []).filter(
    (slot) => slot.enabled && (!insertCatalog || insertCatalog.has(slot.processor)),
  );
  if (realtimeProcessors.length === 0) return master;
  return {
    ...master,
    inserts: [
      ...master.inserts,
      ...realtimeProcessors.map((slot) => ({
        processor: slot.processor,
        params: { ...slot.params },
        enabled: true,
      })),
    ],
  };
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
function engineBusSends(
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

    const hasSceneDsp =
      stripSceneFieldsHaveDsp(strip) ||
      stripSceneMetadataHasDsp(strip) ||
      (target === 'master' && engineMasterPannerHasDsp(strip));
    if (!memory && !hasSceneDsp && inserts.length === 0 && effectiveEqBands.length === 0) {
      return undefined;
    }

    if (forceScene || !memory || memory.structureKey !== structureKey) {
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
    const effectiveEqBands = supportsBusEq ? engineEqBands(strip) : [];
    const hasSceneDsp =
      stripSceneFieldsHaveDsp(strip) ||
      (!surroundBus && engineBusPanHasDsp(strip)) ||
      effectiveEqBands.length > 0;
    const busPan = surroundBus ? engineBusPanState(undefined) : engineBusPanState(strip);

    if (!memory && !hasSceneDsp && sceneInserts.length === 0 && !forceScene) {
      return undefined;
    }

    if (forceScene || !memory || memory.structureKey !== structureKey) {
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
  ): void => {
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
        handle.engine.setSends(trackId, []);
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
        handle.engine.setSends(trackId, []);
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
        handle.engine.setSends(track.id, pruned);
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
          handle.engine.setBusGain(entry.busId, entry.gainDb);
          lastBusGain.set(entry.busId, entry.gainDb);
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
        handle.engine.setSends(track.id, desired);
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
          handle.engine.setTrackStripJson(track.id, json);
        },
        (insertIndex, paramName, value) =>
          handle.engine.setTrackStripInsertParamByName(track.id, insertIndex, paramName, value),
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

    // Insert sidechain keys, replayed after the strips exist. Bindings are
    // diffed per (track, insertIndex); stale ones are cleared with null.
    const desiredSidechains = new Map<string, { trackId: number; index: number; source: number }>();
    const trackIds = new Set(tracks.map((track) => track.id));
    for (const track of tracks) {
      if (track.kind === 'group') continue;
      (track.mixer?.inserts ?? []).forEach((slot, index) => {
        const source = slot.sidechainSourceTrackId;
        if (source === undefined || source === track.id || !trackIds.has(source)) return;
        desiredSidechains.set(`${track.id}:${index}`, { trackId: track.id, index, source });
      });
    }
    for (const [key, binding] of lastSidechains) {
      if (!desiredSidechains.has(key)) {
        handle.engine.setLaneSidechain(binding.trackId, binding.index, null);
        lastSidechains.delete(key);
      }
    }
    for (const [key, binding] of desiredSidechains) {
      const previous = lastSidechains.get(key);
      if (previous && previous.source === binding.source) continue;
      handle.engine.setLaneSidechain(binding.trackId, binding.index, binding.source);
      lastSidechains.set(key, binding);
    }

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
