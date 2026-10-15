import { createDefaultStrip, type InsertSlot, type MixerStrip } from '../mixer';
import type { useProjectStore } from '../store';
import { type CommandGestureOptions, executeApp } from './history';
import { requireTrack } from './utils';

/** Addresses a mixer strip: a track id, 'master', or a send-return bus. */
export type MixerBusStripTarget = `bus:${string}`;
export type MixerStripTarget = number | 'master' | MixerBusStripTarget;

/** Builds the target id used by shared strip UI/components for a mixer bus. */
export function mixerBusStripTarget(busId: string): MixerBusStripTarget {
  return `bus:${busId}`;
}

/** True when a strip target addresses a mixer bus. */
export function isMixerBusStripTarget(target: MixerStripTarget): target is MixerBusStripTarget {
  return typeof target === 'string' && target.startsWith('bus:');
}

/** Returns the bus id embedded in a bus strip target. */
export function mixerBusIdFromTarget(target: MixerBusStripTarget): string {
  return target.slice('bus:'.length);
}

/** Returns the current strip of a target (a neutral strip when absent). */
export function currentStrip(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
): MixerStrip {
  if (target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(target)) {
    const busId = mixerBusIdFromTarget(target);
    const bus = store.mixer.buses.find((entry) => entry.id === busId);
    if (!bus) throw new RangeError(`Unknown mixer bus id: ${busId}`);
    return bus.strip ?? createDefaultStrip();
  }
  const track = requireTrack(store, target);
  return track.mixer ?? createDefaultStrip();
}

/** Writes a strip back onto its target (track, return bus, or master). */
export function writeStrip(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
  strip: MixerStrip,
): void {
  if (target === 'master') {
    store.mixer = { ...store.mixer, master: strip };
    return;
  }
  if (isMixerBusStripTarget(target)) {
    const busId = mixerBusIdFromTarget(target);
    if (!store.mixer.buses.some((bus) => bus.id === busId)) {
      throw new RangeError(`Unknown mixer bus id: ${busId}`);
    }
    store.mixer = {
      ...store.mixer,
      buses: store.mixer.buses.map((bus) => (bus.id === busId ? { ...bus, strip } : bus)),
    };
    return;
  }
  store.tracks = store.tracks.map((t) => (t.id === target ? { ...t, mixer: strip } : t));
}

/**
 * Applies a mixer-mirror-only edit as one undoable step, coalescing a drag
 * (`commit: false`) into a single history entry. The write patches the mirror
 * in place, so no Project re-read runs and clips and notes keep their identity
 * on every drag frame.
 *
 * @param key Gesture key shared by every frame of the drag.
 * @param options Gesture coalescing from the command's caller.
 * @param write Writes the changed mixer state onto the store mirror.
 */
export function patchMixerMirror(
  key: string,
  options: CommandGestureOptions | undefined,
  write: () => void,
): void {
  executeApp(write, { key, commit: options?.commit ?? true });
}

/** Returns the insert slot at an index, or throws RangeError. */
export function requireInsert(strip: MixerStrip, index: number): InsertSlot {
  if (!Number.isInteger(index) || index < 0 || index >= strip.inserts.length) {
    throw new RangeError(`Unknown insert index: ${index}`);
  }
  return strip.inserts[index];
}
