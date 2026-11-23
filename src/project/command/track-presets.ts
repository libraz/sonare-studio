import { defaultName } from '../default-names';
/** Commands for copying and applying one track's reusable channel settings. */

import { cloneInstrument } from '../instrument';
import { isMidiFxNoop, sanitizeMidiFxConfig } from '../midi-fx';
import { cloneStrip, createProcessorId, hasAudibleOutputRoute, type MixerStrip } from '../mixer';
import { useProjectStore } from '../store';
import { reconcileProcessorTargetReferences } from '../target-reference-registry';
import {
  normalizeTrackChannelPreset,
  type TrackChannelPreset,
  trackChannelPresetFromTrack,
} from '../track-preset';
import { executeApp } from './history';
import { requireTrack } from './utils';

let copiedTrackChannelPreset: TrackChannelPreset | null = null;

/** Copies one track's channel state into the session clipboard. */
export function copyTrackChannelPreset(trackId: number): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  copiedTrackChannelPreset = trackChannelPresetFromTrack(track, defaultName('clipboardPreset'));
}

/** True when this session has a copied channel setting ready to paste. */
export function hasCopiedTrackChannelPreset(): boolean {
  return copiedTrackChannelPreset !== null;
}

/** Applies the session clipboard to a destination track. */
export function pasteTrackChannelPreset(trackId: number): void {
  if (copiedTrackChannelPreset === null) {
    throw new RangeError('No copied track channel settings are available');
  }
  applyTrackChannelPreset(trackId, copiedTrackChannelPreset);
}

/**
 * Produces a destination-safe strip: stale bus/source references disappear and
 * each copied insert gets a new identity so destination automation and MIDI
 * learn bindings cannot accidentally point at pasted processors.
 */
function stripForDestination(
  source: MixerStrip,
  trackId: number,
  groupTrack: boolean,
  routable: boolean,
): MixerStrip {
  const store = useProjectStore();
  const validBusIds = new Set(store.mixer.buses.map((bus) => bus.id));
  const validTrackIds = new Set(store.tracks.map((track) => track.id));
  const next = cloneStrip(source);
  next.inserts = next.inserts.map((slot) => {
    const copied = { ...slot, id: createProcessorId(), params: { ...slot.params } };
    if (
      groupTrack ||
      copied.sidechainSourceTrackId === trackId ||
      !validTrackIds.has(copied.sidechainSourceTrackId ?? -1)
    ) {
      delete copied.sidechainSourceTrackId;
    }
    return copied;
  });
  if (groupTrack) {
    next.sends = [];
    delete next.outputBusId;
  } else {
    next.sends = next.sends.filter((send) => validBusIds.has(send.busId));
    if (!routable || (next.outputBusId !== undefined && !validBusIds.has(next.outputBusId))) {
      delete next.outputBusId;
    }
  }
  return next;
}

/** Applies a saved or copied channel preset as one undoable app-state edit. */
export function applyTrackChannelPreset(trackId: number, source: TrackChannelPreset): void {
  const store = useProjectStore();
  const track = requireTrack(store, trackId);
  const preset = normalizeTrackChannelPreset(source);
  const mixer = stripForDestination(
    preset.strip,
    trackId,
    track.kind === 'group',
    hasAudibleOutputRoute(track),
  );
  executeApp(
    () => {
      store.tracks = store.tracks.map((entry) => {
        if (entry.id !== trackId) return entry;
        let next = { ...entry, mixer, pan: mixer.pan };
        if (entry.kind === 'midi' && preset.instrument !== undefined) {
          const { externalMidiMode: _mode, instrument: _instrument, ...rest } = next;
          next =
            preset.instrument === null
              ? rest
              : { ...rest, instrument: cloneInstrument(preset.instrument) };
        }
        if (entry.kind === 'midi') {
          const midiFx = preset.midiFx && sanitizeMidiFxConfig(preset.midiFx);
          if (midiFx && !isMidiFxNoop(midiFx)) next = { ...next, midiFx };
          else {
            const { midiFx: _midiFx, ...rest } = next;
            next = rest;
          }
        }
        return next;
      });
      // Old insert ids are intentionally removed above. This drops only stale
      // target references, leaving unrelated tracks' automation intact.
      reconcileProcessorTargetReferences(store);
      store.refresh();
    },
    { key: `track-channel-preset:${trackId}`, commit: true },
  );
}
