/**
 * Realtime strip synchronisation: mirrors the store's per-track insert
 * chains, dedicated strip EQs, mixer buses and track sends (plus the master
 * strip inserts/EQ) onto a running engine, transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - A track strip set via setTrackStripJson is an extra processing stage
 *   independent of the lane fader/pan owned by mixer-sync (setStripGain /
 *   setStripPan), so the scene strips sent here stay neutral: inserts and EQ
 *   only, no faderDb/pan deviation.
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
 * - The master strip has no engine-side sends; mixer.master.sends is ignored.
 */

import type { MixerStrip, ProjectMixerState } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { EngineTrackSend, EqBand } from '@/wasm/index.js';
import type { EngineHandle } from './engine';

/** Maximum number of mixer buses the realtime engine supports. */
export const MAX_ENGINE_BUSES = 8;

/** Options for {@link createStripSync}. */
export interface StripSyncOptions {
  /** Known insert processor names for validation; null/undefined skips validation. */
  insertCatalog?: ReadonlySet<string> | null;
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
  return JSON.stringify({ version: 1, strips: [{ id, inserts }], buses: [], connections: [] });
}

/** What was last sent for one strip target, kept for change detection. */
interface StripMemory {
  /** Insert structure identity (processor + params; enabled flags excluded). */
  structureKey: string;
  /** Per-insert enabled flag as last applied (index = scene insert index). */
  enabled: boolean[];
  /** Serialized EQ band as last applied (index = engine band index). */
  eqBandJson: string[];
}

/** Mirrors store strip/bus/send state onto a running engine. */
export interface StripSync {
  /** Diffs the given state against what was last sent and emits only the changed engine calls. */
  sync(tracks: ReadonlyArray<EditorTrack>, mixer: ProjectMixerState): void;
  /** Engine bus id assigned to a store bus id (undefined when never seen). */
  busIdFor(storeBusId: string): number | undefined;
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
  // Engine bus numbers are assigned once per store bus id and never reused
  // within the session, so stale sends can never alias a recycled number.
  const busNumberByStoreId = new Map<string, number>();
  let nextBusNumber = 1;
  let lastBusList: number[] = [];
  const lastBusGain = new Map<number, number>();
  const lastSendsByTrack = new Map<number, string>();
  const trackStripMemory = new Map<number, StripMemory>();
  let masterStripMemory: StripMemory | undefined;

  /**
   * Syncs one strip target, returning the new memory (undefined when the
   * target still has nothing to declare).
   */
  const syncStrip = (
    target: number | 'master',
    strip: MixerStrip | undefined,
    memory: StripMemory | undefined,
    sendStripJson: (sceneJson: string) => void,
  ): StripMemory | undefined => {
    const inserts = strip?.inserts ?? [];
    const structureKey = JSON.stringify(
      inserts.map((slot) => ({ processor: slot.processor, params: slot.params })),
    );
    // Individual band enabled/bypassed flags are forwarded as-is inside the
    // band objects; an EQ disabled as a whole contributes no bands.
    const effectiveEqBands: EqBand[] = strip?.eq?.enabled ? strip.eq.bands : [];
    const enabled = inserts.map((slot) => slot.enabled);

    if (!memory && inserts.length === 0 && effectiveEqBands.length === 0) {
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
      return { structureKey, enabled, eqBandJson };
    }

    // Structure unchanged: toggle bypass flags and diff EQ bands in place.
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
    return { structureKey, enabled, eqBandJson };
  };

  // The sync phase order is load-bearing:
  // 1. assign engine numbers to unseen store buses,
  // 2. prune sends still referencing a bus about to disappear (the engine
  //    must never hold a send to an undeclared bus),
  // 3. declare/re-declare the bus set, or adjust changed gains in place,
  // 4. send the final per-track send lists,
  // 5. sync the track strips, then the master strip.
  const sync = (tracks: ReadonlyArray<EditorTrack>, mixer: ProjectMixerState): void => {
    if (mixer.buses.length > MAX_ENGINE_BUSES) {
      throw new Error(
        `Too many mixer buses for the engine: ${mixer.buses.length} > ${MAX_ENGINE_BUSES}`,
      );
    }

    for (const bus of mixer.buses) {
      if (!busNumberByStoreId.has(bus.id)) {
        busNumberByStoreId.set(bus.id, nextBusNumber);
        nextBusNumber += 1;
      }
    }
    const newBusIds = mixer.buses.map((bus) => busNumberByStoreId.get(bus.id) as number);
    const newBusIdSet = new Set(newBusIds);

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
      handle.engine.setTrackBuses(
        mixer.buses.map((bus) => ({
          busId: busNumberByStoreId.get(bus.id) as number,
          gainDb: bus.gainDb,
        })),
      );
      lastBusList = newBusIds;
      lastBusGain.clear();
      for (const bus of mixer.buses) {
        lastBusGain.set(busNumberByStoreId.get(bus.id) as number, bus.gainDb);
      }
    } else {
      for (const bus of mixer.buses) {
        const busId = busNumberByStoreId.get(bus.id) as number;
        if (lastBusGain.get(busId) !== bus.gainDb) {
          handle.engine.setBusGain(busId, bus.gainDb);
          lastBusGain.set(busId, bus.gainDb);
        }
      }
    }

    // Final per-track sends (deduped; an absent entry means "no sends sent",
    // which matches the engine's initial state).
    for (const track of tracks) {
      const desired: EngineTrackSend[] = [];
      for (const send of track.mixer?.sends ?? []) {
        const busId = busNumberByStoreId.get(send.busId);
        if (busId === undefined || !newBusIdSet.has(busId)) continue;
        desired.push({ busId, levelDb: send.levelDb, enabled: send.enabled });
      }
      const json = JSON.stringify(desired);
      if ((lastSendsByTrack.get(track.id) ?? '[]') !== json) {
        handle.engine.setSends(track.id, desired);
        lastSendsByTrack.set(track.id, json);
      }
    }

    // Track strips, then the master strip.
    for (const track of tracks) {
      const memory = syncStrip(track.id, track.mixer, trackStripMemory.get(track.id), (json) =>
        handle.engine.setTrackStripJson(track.id, json),
      );
      if (memory) trackStripMemory.set(track.id, memory);
    }
    masterStripMemory = syncStrip('master', mixer.master, masterStripMemory, (json) =>
      handle.engine.setMasterStripJson(json),
    );
  };

  return { sync, busIdFor: (storeBusId) => busNumberByStoreId.get(storeBusId) };
}
