import {
  cloneInstrument,
  type ExternalMidiInstrument,
  instrumentEquals,
  type TrackInstrument,
  validateTrackInstrument,
} from '../instrument';
import { useProjectStore } from '../store';
import { type CommandGestureOptions, executeApp, hasPendingGesture } from './history';
import { patchMixerMirror } from './mixer-internal';
import { requireTrack } from './utils';

/**
 * Sets a track's instrument as one undoable edit. Instruments are app-level
 * metadata; src/engine/midi-sync.ts binds the instrument to the track's engine
 * destination.
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
  patchMixerMirror(key, options, () => {
    store.tracks = store.tracks.map((t) => {
      if (t.id !== trackId) return t;
      if (instrument === null) {
        const { externalMidiMode: _mode, instrument: _dropped, ...rest } = t;
        return rest;
      }
      const { externalMidiMode: _mode, ...rest } = t;
      return { ...rest, instrument: cloneInstrument(instrument) };
    });
  });
}

/**
 * Sets the shared project External MIDI route. Tracks opt into this route with
 * {@link setTrackExternalMidiMode}; changing it updates all inherited tracks.
 */
export function setProjectExternalMidiDefault(instrument: ExternalMidiInstrument | null): void {
  const store = useProjectStore();
  if (instrument !== null) validateTrackInstrument(instrument);
  const current = store.projectExternalMidi;
  const unchanged =
    instrument === null
      ? current === null
      : current !== null && instrumentEquals(current, instrument);
  if (unchanged) return;
  executeApp(
    () => {
      store.projectExternalMidi =
        instrument === null ? null : (cloneInstrument(instrument) as ExternalMidiInstrument);
      store.refresh();
    },
    { key: 'project-external-midi', commit: true },
  );
}

/**
 * Sets the shared project External MIDI route and opts the given MIDI tracks
 * into it as one undoable edit.
 */
export function setProjectExternalMidiDefaultForTracks(
  instrument: ExternalMidiInstrument,
  trackIds: ReadonlyArray<number>,
): void {
  const store = useProjectStore();
  validateTrackInstrument(instrument);
  const ids = new Set(trackIds);
  if (ids.size === 0) return;
  for (const id of ids) {
    const track = requireTrack(store, id);
    if (track.kind !== 'midi') {
      throw new RangeError('External MIDI mode is only valid on MIDI tracks');
    }
  }
  const defaultChanged =
    store.projectExternalMidi === null || !instrumentEquals(store.projectExternalMidi, instrument);
  const modeChanged = store.tracks.some(
    (track) => ids.has(track.id) && track.externalMidiMode !== 'project',
  );
  if (!defaultChanged && !modeChanged) return;
  executeApp(
    () => {
      store.projectExternalMidi = cloneInstrument(instrument) as ExternalMidiInstrument;
      store.tracks = store.tracks.map((track) =>
        ids.has(track.id) ? { ...track, externalMidiMode: 'project' } : track,
      );
      store.refresh();
    },
    {
      key: `project-external-midi-tracks:${[...ids].sort((a, b) => a - b).join(',')}`,
      commit: true,
    },
  );
}

/**
 * Chooses whether a track uses the project External MIDI route or its own
 * instrument. Leaving project mode reveals the track's existing instrument.
 */
export function setTrackExternalMidiMode(trackId: number, mode: 'project' | null): void {
  setTrackExternalMidiModes([trackId], mode);
}

/**
 * Chooses External MIDI inheritance mode for several MIDI tracks as one
 * undoable edit.
 */
export function setTrackExternalMidiModes(
  trackIds: ReadonlyArray<number>,
  mode: 'project' | null,
): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  if (ids.size === 0) return;
  for (const id of ids) {
    const track = requireTrack(store, id);
    if (track.kind !== 'midi') {
      throw new RangeError('External MIDI mode is only valid on MIDI tracks');
    }
  }
  const changed = store.tracks.some(
    (track) => ids.has(track.id) && (track.externalMidiMode ?? null) !== mode,
  );
  if (!changed) return;
  executeApp(
    () => {
      store.tracks = store.tracks.map((t) => {
        if (!ids.has(t.id)) return t;
        if (mode === null) {
          const { externalMidiMode: _mode, ...rest } = t;
          return rest;
        }
        return { ...t, externalMidiMode: mode };
      });
      store.refresh();
    },
    { key: `track-external-midi-mode:${[...ids].sort((a, b) => a - b).join(',')}`, commit: true },
  );
}

/**
 * Sets several tracks' instruments as one undoable edit. Used by bulk device
 * actions where per-track commands would create noisy undo history.
 *
 * @param trackIds Track ids to edit.
 * @param instrument New instrument, or null to clear back to the default
 *   synth preset.
 */
export function setTrackInstruments(
  trackIds: ReadonlyArray<number>,
  instrument: TrackInstrument | null,
): void {
  const store = useProjectStore();
  const ids = new Set(trackIds);
  if (ids.size === 0) return;
  for (const id of ids) requireTrack(store, id);
  if (instrument !== null) validateTrackInstrument(instrument);
  const changed = store.tracks.some((track) => {
    if (!ids.has(track.id)) return false;
    const current = track.instrument ?? null;
    if (instrument === null) return current !== null;
    return current === null || !instrumentEquals(current, instrument);
  });
  if (!changed) return;
  executeApp(
    () => {
      store.tracks = store.tracks.map((track) => {
        if (!ids.has(track.id)) return track;
        if (instrument === null) {
          const { externalMidiMode: _mode, instrument: _dropped, ...rest } = track;
          return rest;
        }
        const { externalMidiMode: _mode, ...rest } = track;
        return { ...rest, instrument: cloneInstrument(instrument) };
      });
      store.refresh();
    },
    { key: `track-instruments:${[...ids].sort((a, b) => a - b).join(',')}`, commit: true },
  );
}
