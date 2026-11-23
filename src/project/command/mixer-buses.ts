import { busAutomationTarget } from '../automation';
import { assertKnownBusDestination, assertValidMixerBusId } from '../bus-topology';
import { defaultName } from '../default-names';
import {
  assertCanAddEngineBus,
  canRouteReturnSolo,
  createDefaultStrip,
  isMixerChannelLayout,
  isMixerGainDb,
  MAX_MIXER_BUSES,
  MAX_STRIP_GAIN_DB,
  MIN_STRIP_GAIN_DB,
  type MixerChannelLayout,
} from '../mixer';
import { useProjectStore } from '../store';
import { reconcileStructureTargetReferences } from '../target-reference-registry';
import type { EditorTrack } from '../types';
import { type CommandGestureOptions, execute, executeApp, hasPendingGesture } from './history';
import { patchMixerMirror } from './mixer-internal';
import { requireTrack } from './utils';

/** Optional fields for {@link addMixerBus}. */
export interface AddMixerBusInput {
  /** Bus id; defaults to the first free "bus-N". */
  id?: string;
  /** Display name; defaults to the id. */
  name?: string;
  /** Channel layout; absent keeps the stereo default. */
  channelLayout?: MixerChannelLayout;
  /** Optional output bus route; absent routes to the master mix. */
  outputBusId?: string;
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
  assertCanAddEngineBus(store.mixer.buses, store.tracks);
  const knownBusIds = new Set(store.mixer.buses.map((bus) => bus.id));
  let id = input.id;
  let busNumber = knownBusIds.size + 1;
  if (id !== undefined) {
    assertValidMixerBusId(id, knownBusIds);
  } else {
    let n = 1;
    while (knownBusIds.has(`bus-${n}`)) n++;
    id = `bus-${n}`;
    busNumber = n;
  }
  const busId = id;
  const name = input.name ?? defaultName('bus', { number: busNumber });
  if (input.channelLayout !== undefined && !isMixerChannelLayout(input.channelLayout)) {
    throw new RangeError(`Unknown mixer bus channel layout: ${String(input.channelLayout)}`);
  }
  if (input.outputBusId !== undefined) {
    // The new bus is not in the old list yet, but it is the route source.
    assertKnownBusDestination(input.outputBusId, knownBusIds, busId);
  }
  return executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: [
        ...store.mixer.buses,
        {
          id: busId,
          name,
          gainDb: 0,
          ...(input.channelLayout !== undefined ? { channelLayout: input.channelLayout } : {}),
          ...(input.outputBusId !== undefined
            ? { strip: { ...createDefaultStrip(), outputBusId: input.outputBusId } }
            : {}),
        },
      ],
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
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.filter((bus) => bus.id !== busId),
    };
    // Sends, output routes, sidechain keys and learn bindings naming the bus go
    // with it, so no strip is left referencing a bus the engine no longer declares.
    reconcileStructureTargetReferences(store);
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
  if (!isMixerGainDb(gainDb)) {
    throw new RangeError(
      `Bus gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `bus-gain:${busId}`;
  if (bus.gainDb === gainDb && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((entry) => (entry.id === busId ? { ...entry, gainDb } : entry)),
    };
  });
}

/** Sets a return-bus mute as one undoable edit without changing its fader. */
export function setMixerBusMute(busId: string, mute: boolean): void {
  const store = useProjectStore();
  const bus = store.mixer.buses.find((entry) => entry.id === busId);
  if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
  if ((bus.mute ?? false) === mute) return;
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((entry) => {
        if (entry.id !== busId) return entry;
        if (mute) return { ...entry, mute: true };
        const { mute: _mute, ...unmuted } = entry;
        return unmuted;
      }),
    };
    store.refresh();
  });
}

/**
 * Solos (auditions) a return bus as one undoable edit.
 *
 * A return has no lane of its own, so the audition is a routing override
 * instead of a lane mute: direct track outputs move to a silent discard bus
 * while their sends keep feeding the soloed return (see
 * {@link returnSoloRouting}). That discard bus occupies one engine bus slot,
 * so soloing is refused when the project already uses them all.
 *
 * @param busId Target bus id.
 * @param solo True to audition this return alone.
 * @throws RangeError for an unknown bus, or when no engine bus slot is free.
 */
export function setMixerBusSolo(busId: string, solo: boolean): void {
  const store = useProjectStore();
  const bus = store.mixer.buses.find((entry) => entry.id === busId);
  if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
  if ((bus.solo ?? false) === solo) return;
  if (solo && !canRouteReturnSolo(store.mixer.buses.length, store.tracks)) {
    throw new RangeError(
      'Return solo needs one free engine bus for the silenced direct outputs; ' +
        'remove a bus or a group track first',
    );
  }
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((entry) => {
        // Auditioning one return at a time keeps the audition meaningful.
        if (entry.id !== busId) {
          if (entry.solo !== true) return entry;
          const { solo: _solo, ...cleared } = entry;
          return cleared;
        }
        if (solo) return { ...entry, solo: true };
        const { solo: _solo, ...unsoloed } = entry;
        return unsoloed;
      }),
    };
    store.refresh();
  });
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

/** Sets a return bus's channel layout as one undoable edit. */
export function setMixerBusChannelLayout(
  busId: string,
  channelLayout: MixerChannelLayout | null,
): void {
  const store = useProjectStore();
  const bus = store.mixer.buses.find((entry) => entry.id === busId);
  if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
  if (channelLayout !== null && !isMixerChannelLayout(channelLayout)) {
    throw new RangeError(`Unknown mixer bus channel layout: ${String(channelLayout)}`);
  }
  if ((bus.channelLayout ?? 'stereo') === (channelLayout ?? 'stereo')) return;
  if (channelLayout === '5.1' || channelLayout === '7.1') {
    const strip = bus.strip;
    if (
      strip &&
      ((strip.width ?? 1) !== 1 ||
        (strip.pan ?? 0) !== 0 ||
        strip.panMode !== undefined ||
        strip.panLaw !== undefined ||
        strip.dualPan !== undefined)
    ) {
      throw new RangeError('Surround mixer buses cannot carry a stereo pan or width stage');
    }
  }
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((entry) => {
        if (entry.id !== busId) return entry;
        if (channelLayout === null || channelLayout === 'stereo') {
          const { channelLayout: _channelLayout, ...withoutLayout } = entry;
          return withoutLayout;
        }
        return { ...entry, channelLayout };
      }),
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
