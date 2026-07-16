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

import {
  effectiveTrackMute,
  type InsertSlot,
  type MasteringChainState,
  type MixerStrip,
  type ProjectMixerState,
  type VcaControlState,
  vcaOffsetDb,
} from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { EngineTrackSend, EqBand } from '@/wasm/index.js';
import type { EngineHandle } from './engine';
import {
  engineBusInsertAutomationIndex,
  engineBusStrip,
  engineEqBands,
  stripSceneFieldsHaveDsp,
} from './engine-declaration';
import { linearToDb } from './mixer-sync';

/** Maximum number of mixer buses the realtime engine supports. */
export const MAX_ENGINE_BUSES = 8;

/** Options for {@link createStripSync}. */
export interface StripSyncOptions {
  /** Known insert processor names for validation; null/undefined skips validation. */
  insertCatalog?: ReadonlySet<string> | null;
}

export interface BusSceneJsonOptions {
  /** Include bus EQ metadata for engines that expose the future bus-EQ ABI. */
  includeEq?: boolean;
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
    return { slot: 'pre', processor: slot.processor, params: JSON.stringify(slot.params) };
  });
  // The bus carries the same output trim/width/polarity stages a strip exposes;
  // each is emitted only when non-default so an unshaped bus stays byte-identical.
  const bus: {
    id: string;
    role: string;
    inserts: typeof inserts;
    inputTrimDb?: number;
    width?: number;
    polarityInvertLeft?: boolean;
    polarityInvertRight?: boolean;
    eq?: { enabled: true; bands: EqBand[] };
  } = { id: `bus-${busId}`, role: 'submix', inserts };
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) bus.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (width !== 1) bus.width = width;
  if (strip?.polarityInvertLeft === true) bus.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) bus.polarityInvertRight = true;
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
  const combined = linearToDb(track.volume) + (track.mixer?.gainDb ?? 0) + vcaOffset;
  return Math.min(24, Math.max(-120, combined));
}

/**
 * Builds the scene JSON declaring one strip's insert chain (exported for
 * tests). The strip stays neutral apart from its inserts: no faderDb/pan
 * (those live on the engine's mixer lane) and no EQ (the dedicated strip EQ
 * is edited per band via setStripEq after the JSON send). Each insert's
 * "params" value is a stringified JSON object, as the engine expects.
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
    return { slot: 'pre', processor: slot.processor, params: JSON.stringify(slot.params) };
  });
  const id = target === 'master' ? 'master' : `track-${target}`;
  const sceneStrip: Record<string, unknown> = { id, inserts };
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) sceneStrip.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (width !== 1) sceneStrip.width = width;
  if (strip?.polarityInvertLeft === true) sceneStrip.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) sceneStrip.polarityInvertRight = true;
  return JSON.stringify({ version: 1, strips: [sceneStrip], buses: [], connections: [] });
}

/** Insert params that affect scene structure; numeric values can be patched in place. */
function insertParamStructure(
  params: InsertSlot['params'],
): Record<string, number | boolean | null> {
  return Object.fromEntries(
    Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, typeof value === 'number' ? null : value]),
  );
}

/** Numeric insert params last seen by the engine, keyed by insert index. */
function insertNumericParams(inserts: ReadonlyArray<InsertSlot>): Array<Record<string, number>> {
  return inserts.map((slot) =>
    Object.fromEntries(
      Object.entries(slot.params)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
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
function busStripDspKey(strip: MixerStrip | undefined, includeEnabled: boolean): string {
  return JSON.stringify({
    inserts: (strip?.inserts ?? []).map((slot) => ({
      processor: slot.processor,
      params: insertParamStructure(slot.params),
      ...(includeEnabled ? { enabled: slot.enabled } : {}),
    })),
    inputTrimDb: strip?.inputTrimDb ?? 0,
    width: strip?.width ?? 1,
    polarityInvertLeft: strip?.polarityInvertLeft === true,
    polarityInvertRight: strip?.polarityInvertRight === true,
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
}

type BusInsertBypassEngine = {
  setBusStripInsertBypassed?: (busId: number, insertIndex: number, bypassed: boolean) => void;
};

type BusEqEngine = {
  setBusStripEq?: (busId: number, bandIndex: number, band: EqBand) => void;
};

/** Mirrors store strip/bus/send state onto a running engine. */
export interface StripSync {
  /** Diffs the given state against what was last sent and emits only the changed engine calls. */
  sync(tracks: ReadonlyArray<EditorTrack>, mixer: ProjectMixerState): void;
  /** Engine bus id assigned to a store bus id (undefined when never seen). */
  busIdFor(storeBusId: string): number | undefined;
  /** Engine bus id assigned to a group track id (undefined when never seen). */
  groupBusIdFor(trackId: number): number | undefined;
  /** Monotonic generation of logical-to-engine bus number assignments. */
  busMappingGeneration(): number;
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
  const busEq = (handle.engine as unknown as BusEqEngine).setBusStripEq;
  // Engine bus numbers are compacted to the currently declared bus set so UI
  // meter/scope targets stay within the engine's fixed bus telemetry range.
  // When a number is reassigned, bus-related diff caches are reset and sends /
  // output routing are replayed so stale engine state cannot alias the new bus.
  const busNumberByStoreId = new Map<string, number>();
  let busMappingGeneration = 0;
  let lastBusList: number[] = [];
  const lastBusGain = new Map<number, number>();
  const lastSendsByTrack = new Map<number, string>();
  const trackStripMemory = new Map<number, StripMemory>();
  const lastOutputBus = new Map<number, number>();
  const lastBusStrip = new Map<number, StripMemory>();
  const lastSidechains = new Map<string, { trackId: number; index: number; source: number }>();
  let masterStripMemory: StripMemory | undefined;
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
  ): StripMemory | undefined => {
    const inserts = strip?.inserts ?? [];
    const insertParams = insertNumericParams(inserts);
    const structureKey = JSON.stringify({
      inputTrimDb: strip?.inputTrimDb ?? 0,
      width: strip?.width ?? 1,
      polarityInvertLeft: strip?.polarityInvertLeft === true,
      polarityInvertRight: strip?.polarityInvertRight === true,
      inserts: inserts.map((slot) => ({
        processor: slot.processor,
        params: insertParamStructure(slot.params),
      })),
    });
    // Individual band enabled/bypassed flags are forwarded as-is inside the
    // band objects; an EQ disabled as a whole contributes no bands.
    const effectiveEqBands = engineEqBands(strip);
    const enabled = inserts.map((slot) => slot.enabled);

    const hasSceneDsp = stripSceneFieldsHaveDsp(strip);
    if (!memory && !hasSceneDsp && inserts.length === 0 && effectiveEqBands.length === 0) {
      return undefined;
    }

    if (!memory || memory.structureKey !== structureKey) {
      // Full re-send: the engine replaces the whole strip, resetting its EQ
      // bands and bypass flags, so both are replayed after the JSON.
      sendStripJson(stripSceneJson(target, strip, insertCatalog));
      const eqBandJson: string[] = [];
      for (let i = 0; i < inserts.length; i += 1) {
        if (!enabled[i]) handle.engine.setStripInsertBypassed(target, i, true);
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
  ): StripMemory | undefined => {
    const supportsBypass = typeof busInsertBypass === 'function';
    const supportsBusEq = typeof busEq === 'function';
    const structureKey = busStripDspKey(strip, !supportsBypass);
    const sceneStrip = supportsBypass ? strip : engineBusStrip(strip);
    const sceneInserts = sceneStrip?.inserts ?? [];
    const insertParams = insertNumericParams(sceneInserts);
    const enabled = sceneInserts.map((slot) => slot.enabled);
    const effectiveEqBands = supportsBusEq ? engineEqBands(strip) : [];
    const hasSceneDsp = stripSceneFieldsHaveDsp(strip) || effectiveEqBands.length > 0;

    if (!memory && !hasSceneDsp && sceneInserts.length === 0) {
      return undefined;
    }

    if (!memory || memory.structureKey !== structureKey) {
      handle.engine.setBusStripJson(
        busId,
        busSceneJson(busId, sceneStrip, insertCatalog, { includeEq: supportsBusEq }),
      );
      if (supportsBypass) {
        enabled.forEach((slotEnabled, insertIndex) => {
          if (!slotEnabled) busInsertBypass(busId, insertIndex, true);
        });
      }
      const eqBandJson: string[] = [];
      if (supportsBusEq) {
        effectiveEqBands.forEach((band, bandIndex) => {
          busEq(busId, bandIndex, band);
          eqBandJson.push(JSON.stringify(band));
        });
      }
      return { structureKey, insertParams, enabled, eqBandJson };
    }

    syncInsertNumericParams(memory.insertParams, insertParams, (insertIndex, paramName, value) => {
      handle.engine.setBusStripInsertParamByName(busId, insertIndex, paramName, value);
    });
    if (supportsBypass) {
      enabled.forEach((slotEnabled, insertIndex) => {
        if (memory.enabled[insertIndex] !== slotEnabled) {
          busInsertBypass(busId, insertIndex, !slotEnabled);
        }
      });
    }
    const bandCount = Math.max(memory.eqBandJson.length, effectiveEqBands.length);
    const eqBandJson: string[] = [];
    if (supportsBusEq) {
      for (let i = 0; i < bandCount; i += 1) {
        const nextBand: EqBand = effectiveEqBands[i] ?? { enabled: false };
        const json = JSON.stringify(nextBand);
        if (memory.eqBandJson[i] !== json) busEq(busId, i, nextBand);
        eqBandJson.push(json);
      }
    }
    return { structureKey, insertParams, enabled, eqBandJson };
  };

  // The sync phase order is load-bearing:
  // 1. assign engine numbers to unseen store buses,
  // 2. prune sends still referencing a bus about to disappear (the engine
  //    must never hold a send to an undeclared bus),
  // 3. declare/re-declare the bus set, or adjust changed gains in place,
  // 4. send the final per-track send lists,
  // 5. sync the track strips, then the master strip.
  const sync = (tracks: ReadonlyArray<EditorTrack>, mixer: ProjectMixerState): void => {
    // Group tracks consume engine buses next to the user send buses.
    const groupTracks = tracks.filter((track) => track.kind === 'group');
    const vcaGainDb = new Map((mixer.vcaGroups ?? []).map((group) => [group.id, group.gainDb]));
    const vcaControls: ReadonlyMap<string, VcaControlState> = new Map(
      (mixer.vcaGroups ?? []).map((group) => [group.id, group]),
    );
    if (mixer.buses.length + groupTracks.length > MAX_ENGINE_BUSES) {
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
    ];
    const busMappingChanged =
      busNumberByStoreId.size !== busKeys.length ||
      busKeys.some((key, index) => busNumberByStoreId.get(key) !== index + 1);
    if (busMappingChanged) {
      busMappingGeneration += 1;
      busNumberByStoreId.clear();
      busKeys.forEach((key, index) => {
        busNumberByStoreId.set(key, index + 1);
      });
      lastBusList = [];
      lastBusGain.clear();
      lastBusStrip.clear();
    }
    const groupBusByTrackId = new Map(
      groupTracks.map((group) => [group.id, busNumberByStoreId.get(`group:${group.id}`) as number]),
    );
    const newBusIds = [
      ...mixer.buses.map((bus) => busNumberByStoreId.get(bus.id) as number),
      ...groupTracks.map((group) => groupBusByTrackId.get(group.id) as number),
    ];
    const newBusIdSet = new Set(newBusIds);
    const busGainEntries: Array<{ busId: number; gainDb: number }> = [
      ...mixer.buses.map((bus) => ({
        busId: busNumberByStoreId.get(bus.id) as number,
        gainDb: bus.gainDb,
      })),
      ...groupTracks.map((group) => ({
        busId: groupBusByTrackId.get(group.id) as number,
        gainDb: groupBusGainDb(
          group,
          vcaOffsetDb(group.vcaId, vcaGainDb),
          effectiveTrackMute(group.mute, group.vcaId, vcaControls),
        ),
      })),
    ];

    // Prune stale sends before re-declaring the bus set.
    for (const track of tracks) {
      const lastJson = lastSendsByTrack.get(track.id);
      if (lastJson === undefined) continue;
      const lastSends = JSON.parse(lastJson) as EngineTrackSend[];
      if (lastSends.some((send) => !newBusIdSet.has(send.busId))) {
        const pruned = lastSends.filter((send) => newBusIdSet.has(send.busId));
        handle.engine.setSends(track.id, pruned);
        lastSendsByTrack.set(track.id, JSON.stringify(pruned));
      }
    }

    // Declare buses, or adjust gains of an unchanged bus set in place.
    if (
      newBusIds.length !== lastBusList.length ||
      newBusIds.some((busId, i) => busId !== lastBusList[i])
    ) {
      handle.engine.setTrackBuses(busGainEntries.map((entry) => ({ ...entry })));
      lastBusList = newBusIds;
      lastBusGain.clear();
      for (const entry of busGainEntries) {
        lastBusGain.set(entry.busId, entry.gainDb);
      }
    } else {
      for (const entry of busGainEntries) {
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
      let outputBus = 0;
      if (track.groupId !== undefined) {
        outputBus = groupBusByTrackId.get(track.groupId) ?? 0;
      } else if (track.kind !== 'group') {
        const userBusId = track.mixer?.outputBusId;
        if (userBusId !== undefined) {
          const busNumber = busNumberByStoreId.get(userBusId);
          if (busNumber !== undefined && newBusIdSet.has(busNumber)) outputBus = busNumber;
        }
      }
      if ((lastOutputBus.get(track.id) ?? 0) !== outputBus) {
        handle.engine.setTrackOutputBus(track.id, outputBus);
        lastOutputBus.set(track.id, outputBus);
      }
    }

    // Final per-track sends (deduped; an absent entry means "no sends sent",
    // which matches the engine's initial state).
    for (const track of tracks) {
      const desired: EngineTrackSend[] = [];
      for (const send of track.mixer?.sends ?? []) {
        const busId = busNumberByStoreId.get(send.busId);
        if (busId === undefined || !newBusIdSet.has(busId)) continue;
        const entry: EngineTrackSend = { busId, levelDb: send.levelDb, enabled: send.enabled };
        // Default (post-fader) stays absent so the JSON change-detection below
        // matches existing scenes; only pre-fader is sent explicitly.
        if (send.timing === 'preFader') entry.sendTiming = 'preFader';
        desired.push(entry);
      }
      const json = JSON.stringify(desired);
      if ((lastSendsByTrack.get(track.id) ?? '[]') !== json) {
        handle.engine.setSends(track.id, desired);
        lastSendsByTrack.set(track.id, json);
      }
    }

    // Track strips (group tracks carry their inserts on their bus strip
    // instead of the silent lane strip), then return-bus strips and master.
    for (const bus of mixer.buses) {
      const busId = busNumberByStoreId.get(bus.id) as number;
      if (!bus.strip && !lastBusStrip.has(busId)) continue;
      const memory = syncBusStrip(busId, bus.strip, lastBusStrip.get(busId));
      if (memory) lastBusStrip.set(busId, memory);
    }

    for (const track of tracks) {
      if (track.kind === 'group') {
        const busId = groupBusByTrackId.get(track.id) as number;
        const memory = syncBusStrip(busId, track.mixer, lastBusStrip.get(busId));
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
        handle.engine.setMasterStripJson(json);
      },
      (insertIndex, paramName, value) =>
        handle.engine.setMasterStripInsertParamByName(insertIndex, paramName, value),
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
  };

  return {
    sync,
    busIdFor: (storeBusId) => busNumberByStoreId.get(storeBusId),
    groupBusIdFor: (trackId) => busNumberByStoreId.get(`group:${trackId}`),
    busMappingGeneration: () => busMappingGeneration,
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
