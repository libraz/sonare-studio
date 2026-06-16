import {
  cloneInstrument,
  instrumentEquals,
  type TrackInstrument,
  validateTrackInstrument,
} from '../instrument';
import {
  cloneStrip,
  createDefaultStrip,
  type InsertSlot,
  MAX_MIXER_BUSES,
  MAX_STRIP_GAIN_DB,
  MAX_VCA_GROUPS,
  MIN_STRIP_GAIN_DB,
  type MixerStrip,
  type StripEq,
} from '../mixer';
import { useProjectStore } from '../store';
import type { EditorTrack } from '../types';
import { type CommandGestureOptions, execute, executeApp, hasPendingGesture } from './history';
import { validateInsertParams } from './insert-params';
import { requireTrack } from './utils';

// ---------------------------------------------------------------------------
// Instrument / mixer commands (app-level metadata, execute(0)-style)
// ---------------------------------------------------------------------------

/**
 * Sets a track's instrument as one undoable edit. Instruments are app-level
 * metadata applied when the track's MIDI clips are prerendered.
 *
 * @param trackId Id of the track.
 * @param instrument New instrument, or null to clear back to the default
 *   synth preset.
 * @param options Gesture coalescing (quick-control drags edit patch fields
 *   continuously).
 */
export function setTrackInstrument(
  trackId: number,
  instrument: TrackInstrument | null,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (instrument !== null) validateTrackInstrument(instrument);
  const key = `track-instrument:${trackId}`;
  const current = track.instrument ?? null;
  const unchanged =
    instrument === null
      ? current === null
      : current !== null && instrumentEquals(current, instrument);
  if (unchanged && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      store.tracks = store.tracks.map((t) => {
        if (t.id !== trackId) return t;
        if (instrument === null) {
          const { instrument: _dropped, ...rest } = t;
          return rest;
        }
        return { ...t, instrument: cloneInstrument(instrument) };
      });
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/** Addresses a mixer strip: a track id, or 'master' for the master strip. */
export type MixerStripTarget = number | 'master';

/** Returns the current strip of a target (a neutral strip when absent). */
function currentStrip(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
): MixerStrip {
  if (target === 'master') return store.mixer.master;
  const track = requireTrack(store, target);
  return track.mixer ?? createDefaultStrip();
}

/** Writes a strip back onto its target (track mirror or master). */
function writeStrip(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
  strip: MixerStrip,
): void {
  if (target === 'master') {
    store.mixer = { ...store.mixer, master: strip };
    return;
  }
  store.tracks = store.tracks.map((t) => (t.id === target ? { ...t, mixer: strip } : t));
}

/** Returns the insert slot at an index, or throws RangeError. */
function requireInsert(strip: MixerStrip, index: number): InsertSlot {
  if (!Number.isInteger(index) || index < 0 || index >= strip.inserts.length) {
    throw new RangeError(`Unknown insert index: ${index}`);
  }
  return strip.inserts[index];
}

/**
 * Sets a strip's gain as one undoable edit. Strip gain is audible: it is
 * mirrored to the engine lane (or master) fader in realtime.
 *
 * @param target Track id or 'master'.
 * @param gainDb New gain in dB (finite, within [-96, 24]).
 * @param options Gesture coalescing for fader drags.
 */
export function setStripGain(
  target: MixerStripTarget,
  gainDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (!Number.isFinite(gainDb) || gainDb < MIN_STRIP_GAIN_DB || gainDb > MAX_STRIP_GAIN_DB) {
    throw new RangeError(
      `Strip gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `strip-gain:${String(target)}`;
  if (strip.gainDb === gainDb && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      writeStrip(store, target, { ...cloneStrip(strip), gainDb });
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Sets a strip's pan as one undoable edit. Strip pan is audible: it is
 * mirrored to the engine lane (or master) pan in realtime.
 *
 * @param target Track id or 'master'.
 * @param pan New balance in [-1, 1].
 * @param options Gesture coalescing for knob drags.
 */
export function setStripPan(
  target: MixerStripTarget,
  pan: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
    throw new RangeError(`Strip pan must be in [-1, 1], got ${pan}`);
  }
  const key = `strip-pan:${String(target)}`;
  if (strip.pan === pan && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      writeStrip(store, target, { ...cloneStrip(strip), pan });
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Appends an insert slot to a strip as one undoable edit. The processor is a
 * wasm catalog name (masteringProcessorNames / masteringInsertNames); track
 * and master inserts are audible in realtime (mirrored to the engine strip,
 * see src/engine/strip-sync.ts).
 *
 * @param target Track id or 'master'.
 * @param processor Processor catalog name (non-empty).
 * @param params Initial parameter overrides (camelCase keys).
 * @returns The index of the new slot.
 */
export function addInsert(
  target: MixerStripTarget,
  processor: string,
  params: Record<string, number | boolean> = {},
): number {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (typeof processor !== 'string' || processor.length === 0) {
    throw new RangeError('Insert processor name must not be empty');
  }
  validateInsertParams(params);
  return executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts = [...next.inserts, { processor, params: { ...params }, enabled: true }];
    writeStrip(store, target, next);
    store.refresh();
    return next.inserts.length - 1;
  });
}

/**
 * Removes an insert slot as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param index Slot index (later slots shift down).
 */
export function removeInsert(target: MixerStripTarget, index: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  requireInsert(strip, index);
  executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts = next.inserts.filter((_, i) => i !== index);
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Enables or bypasses an insert slot as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param enabled New enabled state.
 */
export function setInsertEnabled(target: MixerStripTarget, index: number, enabled: boolean): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const slot = requireInsert(strip, index);
  if (slot.enabled === enabled) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts[index] = { ...next.inserts[index], enabled };
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Sets (or clears with null) the sidechain key source of a track insert as
 * one undoable edit. Only track strips support keyed inserts (the master
 * strip has no engine lane to key from).
 *
 * @param trackId Track owning the insert.
 * @param index Insert slot index.
 * @param sourceTrackId Track whose audio keys the insert, or null.
 */
export function setInsertSidechain(
  trackId: number,
  index: number,
  sourceTrackId: number | null,
): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  const strip = track.mixer;
  if (!strip) throw new RangeError(`Track ${trackId} has no mixer strip`);
  const slot = requireInsert(strip, index);
  if (sourceTrackId !== null) {
    requireTrack(store, sourceTrackId);
    if (sourceTrackId === trackId) {
      throw new RangeError('An insert cannot key from its own track');
    }
  }
  if ((slot.sidechainSourceTrackId ?? null) === sourceTrackId) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    const updated = { ...next.inserts[index] };
    if (sourceTrackId === null) delete updated.sidechainSourceTrackId;
    else updated.sidechainSourceTrackId = sourceTrackId;
    next.inserts[index] = updated;
    writeStrip(store, trackId, next);
    store.refresh();
  });
}

/**
 * Sets one parameter of an insert slot as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param index Slot index.
 * @param param Parameter name (camelCase, see masteringInsertParamNames).
 * @param value New value (finite number or boolean).
 * @param options Gesture coalescing for knob drags.
 */
export function setInsertParam(
  target: MixerStripTarget,
  index: number,
  param: string,
  value: number | boolean,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const slot = requireInsert(strip, index);
  if (param.length === 0) throw new RangeError('Insert param name must not be empty');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Insert param "${param}" must be finite, got ${value}`);
  }
  const key = `insert-param:${String(target)}:${index}:${param}`;
  if (slot.params[param] === value && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      const next = cloneStrip(strip);
      next.inserts[index] = {
        ...next.inserts[index],
        params: { ...next.inserts[index].params, [param]: value },
      };
      writeStrip(store, target, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Replaces a strip's EQ as one undoable edit. Track and master EQ are audible
 * in realtime (mirrored to the engine strip EQ, see src/engine/strip-sync.ts).
 *
 * @param target Track id or 'master'.
 * @param eq New EQ state, or null to remove the EQ.
 * @param options Gesture coalescing for band drags.
 */
export function setStripEq(
  target: MixerStripTarget,
  eq: StripEq | null,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (eq !== null && !Array.isArray(eq.bands)) {
    throw new RangeError('Strip EQ requires a bands array');
  }
  const key = `strip-eq:${String(target)}`;
  executeApp(
    () => {
      const next = cloneStrip(strip);
      if (eq === null) delete next.eq;
      else next.eq = JSON.parse(JSON.stringify(eq)) as StripEq;
      writeStrip(store, target, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Adds, updates or removes a send from a strip to a bus as one undoable edit.
 * Track sends feed the engine's realtime bus lanes (post-fader); master sends
 * have no engine routing and stay UI-only.
 *
 * @param target Track id or 'master'.
 * @param busId Destination bus id (must exist).
 * @param send New level/enabled state, or null to remove the send.
 */
export function setSend(
  target: MixerStripTarget,
  busId: string,
  send: { levelDb: number; enabled?: boolean } | null,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (!store.mixer.buses.some((bus) => bus.id === busId)) {
    throw new RangeError(`Unknown mixer bus id: ${busId}`);
  }
  if (send !== null && !Number.isFinite(send.levelDb)) {
    throw new RangeError(`Send level must be finite, got ${send.levelDb}`);
  }
  executeApp(() => {
    const next = cloneStrip(strip);
    const existing = next.sends.findIndex((s) => s.busId === busId);
    if (send === null) {
      if (existing >= 0) next.sends = next.sends.filter((s) => s.busId !== busId);
    } else {
      const entry = { busId, levelDb: send.levelDb, enabled: send.enabled ?? true };
      if (existing >= 0) next.sends[existing] = entry;
      else next.sends = [...next.sends, entry];
    }
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Routes a track strip's post-fader output into a send bus (or back to the
 * master mix) as one undoable edit. The routing is audible: strip-sync points
 * the engine lane at the bus, which sums into the master mix. Group members
 * ignore this (their group bus always wins), and the master strip has no lane
 * to route, so both are rejected.
 *
 * @param target Track id (not 'master').
 * @param busId Destination bus id, or null to restore the master mix.
 */
export function setStripOutputBus(target: MixerStripTarget, busId: string | null): void {
  const store = useProjectStore();
  if (target === 'master') {
    throw new RangeError('The master strip has no output bus to route');
  }
  const track = requireTrack(store, target);
  if (track.kind === 'group') {
    throw new RangeError('Group tracks carry their own bus and cannot be re-routed');
  }
  if (busId !== null && !store.mixer.buses.some((bus) => bus.id === busId)) {
    throw new RangeError(`Unknown mixer bus id: ${busId}`);
  }
  const strip = track.mixer ?? createDefaultStrip();
  if ((strip.outputBusId ?? null) === busId) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    if (busId === null) delete next.outputBusId;
    else next.outputBusId = busId;
    writeStrip(store, target, next);
    store.refresh();
  });
}

/** Optional fields for {@link addMixerBus}. */
export interface AddMixerBusInput {
  /** Bus id; defaults to the first free "bus-N". */
  id?: string;
  /** Display name; defaults to the id. */
  name?: string;
}

/**
 * Adds a mixer bus as one undoable edit. Buses are audible send destinations:
 * they are declared as realtime engine bus lanes (engine limit
 * {@link MAX_MIXER_BUSES}, enforced here).
 *
 * @param input Optional id/name overrides.
 * @returns The bus id.
 */
export function addMixerBus(input: AddMixerBusInput = {}): string {
  const store = useProjectStore();
  if (store.mixer.buses.length >= MAX_MIXER_BUSES) {
    throw new RangeError(`Mixer bus limit reached (${MAX_MIXER_BUSES})`);
  }
  let id = input.id;
  if (id !== undefined) {
    if (id.length === 0) throw new RangeError('Mixer bus id must not be empty');
    if (store.mixer.buses.some((bus) => bus.id === id)) {
      throw new RangeError(`Mixer bus id already exists: ${id}`);
    }
  } else {
    let n = 1;
    while (store.mixer.buses.some((bus) => bus.id === `bus-${n}`)) n++;
    id = `bus-${n}`;
  }
  const busId = id;
  const name = input.name ?? busId;
  return executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: [...store.mixer.buses, { id: busId, name, gainDb: 0 }],
    };
    store.refresh();
    return busId;
  });
}

/**
 * Removes a mixer bus as one undoable edit; sends targeting the bus are
 * removed from every strip (tracks and master).
 *
 * @param busId Id of the bus to remove.
 */
export function removeMixerBus(busId: string): void {
  const store = useProjectStore();
  if (!store.mixer.buses.some((bus) => bus.id === busId)) {
    throw new RangeError(`Unknown mixer bus id: ${busId}`);
  }
  executeApp(() => {
    // Drop sends to the bus and reset any output routing pointed at it, so no
    // strip is left referencing a bus the engine no longer declares.
    const detachBus = (strip: MixerStrip): MixerStrip => {
      const sendsBus = strip.sends.some((send) => send.busId === busId);
      const routesBus = strip.outputBusId === busId;
      if (!sendsBus && !routesBus) return strip;
      const next = cloneStrip(strip);
      if (sendsBus) next.sends = next.sends.filter((send) => send.busId !== busId);
      if (routesBus) delete next.outputBusId;
      return next;
    };
    store.tracks = store.tracks.map((track) =>
      track.mixer ? { ...track, mixer: detachBus(track.mixer) } : track,
    );
    store.mixer = {
      ...store.mixer,
      master: detachBus(store.mixer.master),
      buses: store.mixer.buses.filter((bus) => bus.id !== busId),
    };
    store.refresh();
  });
}

/**
 * Sets a mixer bus's gain in dB. Drag coalescing follows the strip-gain
 * protocol (pass `commit: false` while dragging). The strip sync mirrors the
 * new gain onto the engine bus lane.
 *
 * @param busId Target bus id.
 * @param gainDb Gain in dB within the strip-gain range.
 * @param options Gesture coalescing (`commit: false` while dragging).
 */
export function setMixerBusGain(
  busId: string,
  gainDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const bus = store.mixer.buses.find((entry) => entry.id === busId);
  if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
  if (!Number.isFinite(gainDb) || gainDb < MIN_STRIP_GAIN_DB || gainDb > MAX_STRIP_GAIN_DB) {
    throw new RangeError(
      `Bus gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `bus-gain:${busId}`;
  if (bus.gainDb === gainDb && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      store.mixer = {
        ...store.mixer,
        buses: store.mixer.buses.map((entry) =>
          entry.id === busId ? { ...entry, gainDb } : entry,
        ),
      };
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Sets a track's solo-safe flag as one undoable edit. Solo-safe is mirrored to
 * the engine in realtime: a safe track stays in the solo group, so soloing
 * other tracks no longer silences it.
 *
 * @param trackId Id of the track.
 * @param soloSafe New solo-safe state.
 */
export function setTrackSoloSafe(trackId: number, soloSafe: boolean): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if ((track.soloSafe ?? false) === soloSafe) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) =>
      t.id === trackId ? withTrackFlag(t, 'soloSafe', soloSafe) : t,
    );
    store.refresh();
  });
}

/** Sets or clears an optional boolean track flag, dropping it when false. */
function withTrackFlag(track: EditorTrack, key: 'soloSafe', value: boolean): EditorTrack {
  const next = { ...track };
  if (value) next[key] = true;
  else delete next[key];
  return next;
}

/**
 * Adds a VCA control group as one undoable edit. A VCA fader offsets the gain
 * of every member track (see {@link setTrackVca}); it carries no audio of its
 * own, so the offset is applied in the realtime mixer sync.
 *
 * @param input Optional id/name overrides.
 * @returns The group id.
 */
export function addVcaGroup(input: { id?: string; name?: string } = {}): string {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  if (groups.length >= MAX_VCA_GROUPS) {
    throw new RangeError(`VCA group limit reached (${MAX_VCA_GROUPS})`);
  }
  let id = input.id;
  if (id !== undefined) {
    if (id.length === 0) throw new RangeError('VCA group id must not be empty');
    if (groups.some((group) => group.id === id)) {
      throw new RangeError(`VCA group id already exists: ${id}`);
    }
  } else {
    let n = 1;
    while (groups.some((group) => group.id === `vca-${n}`)) n++;
    id = `vca-${n}`;
  }
  const groupId = id;
  const name = input.name ?? `VCA ${groups.length + 1}`;
  return executeApp(() => {
    store.mixer = {
      ...store.mixer,
      vcaGroups: [...groups, { id: groupId, name, gainDb: 0 }],
    };
    store.refresh();
    return groupId;
  });
}

/**
 * Removes a VCA control group as one undoable edit; member tracks are
 * unassigned in the same step so no track references a missing group.
 *
 * @param groupId Id of the group to remove.
 */
export function removeVcaGroup(groupId: string): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  if (!groups.some((group) => group.id === groupId)) {
    throw new RangeError(`Unknown VCA group id: ${groupId}`);
  }
  executeApp(() => {
    store.tracks = store.tracks.map((track) => {
      if (track.vcaId !== groupId) return track;
      const next = { ...track };
      delete next.vcaId;
      return next;
    });
    store.mixer = {
      ...store.mixer,
      vcaGroups: groups.filter((group) => group.id !== groupId),
    };
    store.refresh();
  });
}

/**
 * Sets a VCA group's fader offset in dB. Drag coalescing follows the
 * strip-gain protocol (pass `commit: false` while dragging); the mixer sync
 * re-applies the offset to every member lane.
 *
 * @param groupId Target group id.
 * @param gainDb Offset in dB within the strip-gain range.
 * @param options Gesture coalescing (`commit: false` while dragging).
 */
export function setVcaGroupGain(
  groupId: string,
  gainDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const groups = store.mixer.vcaGroups ?? [];
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) throw new RangeError(`Unknown VCA group id: ${groupId}`);
  if (!Number.isFinite(gainDb) || gainDb < MIN_STRIP_GAIN_DB || gainDb > MAX_STRIP_GAIN_DB) {
    throw new RangeError(
      `VCA gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `vca-gain:${groupId}`;
  if (group.gainDb === gainDb && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      store.mixer = {
        ...store.mixer,
        vcaGroups: (store.mixer.vcaGroups ?? []).map((entry) =>
          entry.id === groupId ? { ...entry, gainDb } : entry,
        ),
      };
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Assigns a track to a VCA group (or clears the assignment) as one undoable
 * edit. The group's fader offset applies to the track's lane in realtime.
 *
 * @param trackId Id of the track.
 * @param groupId Target VCA group id, or null to unassign.
 */
export function setTrackVca(trackId: number, groupId: string | null): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  if (groupId !== null && !(store.mixer.vcaGroups ?? []).some((group) => group.id === groupId)) {
    throw new RangeError(`Unknown VCA group id: ${groupId}`);
  }
  if ((track.vcaId ?? null) === groupId) return;
  execute(0, () => {
    store.tracks = store.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = { ...t };
      if (groupId === null) delete next.vcaId;
      else next.vcaId = groupId;
      return next;
    });
    store.refresh();
  });
}
