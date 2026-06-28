import { busAutomationTarget } from '../automation';
import {
  cloneStrip,
  MAX_MIXER_BUSES,
  MAX_STRIP_GAIN_DB,
  MIN_STRIP_GAIN_DB,
  type MixerStrip,
} from '../mixer';
import { useProjectStore } from '../store';
import type { EditorTrack } from '../types';
import { type CommandGestureOptions, execute, executeApp, hasPendingGesture } from './history';
import { requireTrack } from './utils';

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
    const target = busAutomationTarget(busId);
    store.automationLanes = store.automationLanes.filter((lane) => lane.target !== target);
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
 * Renames a mixer bus as one undoable edit. The id stays stable, so sends and
 * output-bus routes keep working.
 *
 * @param busId Target bus id.
 * @param name New display name (trimmed, non-empty).
 */
export function renameMixerBus(busId: string, name: string): void {
  const store = useProjectStore();
  const bus = store.mixer.buses.find((entry) => entry.id === busId);
  if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
  const nextName = name.trim();
  if (nextName.length === 0) throw new RangeError('Mixer bus name must not be empty');
  if (bus.name === nextName) return;
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((entry) =>
        entry.id === busId ? { ...entry, name: nextName } : entry,
      ),
    };
    store.refresh();
  });
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
