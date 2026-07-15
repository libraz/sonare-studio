import type { SendTiming } from '@/wasm/index.js';
import {
  cloneInstrument,
  type ExternalMidiInstrument,
  instrumentEquals,
  type TrackInstrument,
  validateTrackInstrument,
} from '../instrument';
import {
  cloneStrip,
  createDefaultStrip,
  createProcessorId,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_STRIP_GAIN_DB,
  MAX_STRIP_WIDTH,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_GAIN_DB,
  MIN_STRIP_WIDTH,
  type MixerSoloMode,
  normalizeMixerSoloMode,
  PAN_LAW_IDS,
  PAN_MODE_IDS,
  type PanLawId,
  type PanModeId,
  type StripEq,
  type StripSend,
} from '../mixer';
import { useProjectStore } from '../store';
import {
  pruneInsertProcessorReferences,
  reorderInsertProcessorReferences,
} from '../target-reference-registry';
import { type CommandGestureOptions, execute, executeApp, hasPendingGesture } from './history';
import { validateInsertParams } from './insert-params';
import {
  currentStrip,
  isMixerBusStripTarget,
  type MixerStripTarget,
  requireInsert,
  writeStrip,
} from './mixer-internal';
import { requireTrack } from './utils';

// ---------------------------------------------------------------------------
// Instrument / mixer commands (app-level metadata, execute(0)-style)
// ---------------------------------------------------------------------------

/** Sets the project-wide solo audition mode as one undoable edit. */
export function setMixerSoloMode(mode: MixerSoloMode): void {
  const store = useProjectStore();
  const next = normalizeMixerSoloMode(mode);
  if ((store.mixer.soloMode ?? 'inPlace') === next) return;
  execute(0, () => {
    store.mixer = {
      ...store.mixer,
      ...(next === 'inPlace' ? { soloMode: undefined } : { soloMode: next }),
    };
    store.refresh();
  });
}

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
          const { externalMidiMode: _mode, instrument: _dropped, ...rest } = t;
          return rest;
        }
        const { externalMidiMode: _mode, ...rest } = t;
        return { ...rest, instrument: cloneInstrument(instrument) };
      });
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
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
 * Sets a strip's pre-insert input trim as one undoable edit. The trim is
 * encoded into the engine strip scene JSON, so track, group-bus and master
 * strips all render it in realtime and export.
 *
 * @param target Track id or 'master'.
 * @param trimDb New input trim in dB (finite, within [-48, 48]).
 * @param options Gesture coalescing for slider drags.
 */
export function setStripInputTrim(
  target: MixerStripTarget,
  trimDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (!Number.isFinite(trimDb) || trimDb < MIN_INPUT_TRIM_DB || trimDb > MAX_INPUT_TRIM_DB) {
    throw new RangeError(
      `Input trim must be within [${MIN_INPUT_TRIM_DB}, ${MAX_INPUT_TRIM_DB}] dB, got ${trimDb}`,
    );
  }
  const key = `strip-input-trim:${String(target)}`;
  if ((strip.inputTrimDb ?? 0) === trimDb && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      const next = cloneStrip(strip);
      if (trimDb === 0) delete next.inputTrimDb;
      else next.inputTrimDb = trimDb;
      writeStrip(store, target, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Sets a strip's stereo width multiplier as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param width New width in [0, 2].
 * @param options Gesture coalescing for slider drags.
 */
export function setStripWidth(
  target: MixerStripTarget,
  width: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (!Number.isFinite(width) || width < MIN_STRIP_WIDTH || width > MAX_STRIP_WIDTH) {
    throw new RangeError(
      `Strip width must be in [${MIN_STRIP_WIDTH}, ${MAX_STRIP_WIDTH}], got ${width}`,
    );
  }
  const key = `strip-width:${String(target)}`;
  if ((strip.width ?? DEFAULT_STRIP_WIDTH) === width && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      const next = cloneStrip(strip);
      if (width === DEFAULT_STRIP_WIDTH) delete next.width;
      else next.width = width;
      writeStrip(store, target, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Sets left/right polarity inversion as one undoable edit.
 *
 * @param target Track id or 'master'.
 * @param left Whether to invert the left channel.
 * @param right Whether to invert the right channel.
 */
export function setStripPolarityInvert(
  target: MixerStripTarget,
  left: boolean,
  right: boolean,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (
    (strip.polarityInvertLeft === true) === left &&
    (strip.polarityInvertRight === true) === right
  ) {
    return;
  }
  executeApp(() => {
    const next = cloneStrip(strip);
    if (left) next.polarityInvertLeft = true;
    else delete next.polarityInvertLeft;
    if (right) next.polarityInvertRight = true;
    else delete next.polarityInvertRight;
    writeStrip(store, target, next);
    store.refresh();
  });
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
    next.inserts = [
      ...next.inserts,
      { id: createProcessorId(), processor, params: { ...params }, enabled: true },
    ];
    writeStrip(store, target, next);
    store.refresh();
    return next.inserts.length - 1;
  });
}

/**
 * Removes an insert slot as one undoable edit. Insert-parameter automation
 * lanes targeting this strip are remapped in the same edit (the removed slot's
 * lane drops, later slots shift down by one), so undo restores both the strip
 * and the lanes together.
 *
 * @param target Track id or 'master'.
 * @param index Slot index (later slots shift down).
 */
export function removeInsert(target: MixerStripTarget, index: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  const removed = requireInsert(strip, index);
  executeApp(() => {
    const next = cloneStrip(strip);
    next.inserts = next.inserts.filter((_, i) => i !== index);
    writeStrip(store, target, next);
    pruneInsertProcessorReferences(store, target, index, removed.id);
    store.refresh();
  });
}

/**
 * Moves an insert slot to a new position within a strip as one undoable edit.
 * Insert-parameter automation lanes targeting this strip follow their slot to
 * the new index (see {@link remapInsertLanesAfterReorder}), so undo restores
 * both the chain order and the lanes together. The destination is clamped into
 * range; a no-op move (same position) does nothing.
 *
 * @param target Track id or 'master'.
 * @param fromIndex Slot index to move.
 * @param toIndex Destination index (clamped into [0, inserts.length - 1]).
 */
export function reorderInsert(target: MixerStripTarget, fromIndex: number, toIndex: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  requireInsert(strip, fromIndex);
  const clamped = Math.min(strip.inserts.length - 1, Math.max(0, Math.trunc(toIndex)));
  if (clamped === fromIndex) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    const inserts = [...next.inserts];
    const [moved] = inserts.splice(fromIndex, 1);
    inserts.splice(clamped, 0, moved);
    next.inserts = inserts;
    writeStrip(store, target, next);
    reorderInsertProcessorReferences(store, target, fromIndex, clamped);
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
 * one undoable edit. Only non-group track strips support keyed inserts: group
 * track inserts are rendered as engine bus strips, and the current engine has
 * no bus-strip sidechain binding API.
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
  if (track.kind === 'group') {
    throw new RangeError('Group track inserts do not support sidechain keys');
  }
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
 * Bus return strips currently have no engine-side EQ ABI, so they are rejected
 * instead of storing an inert EQ state.
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
  if (isMixerBusStripTarget(target)) {
    throw new RangeError('Bus return strips do not support EQ');
  }
  const strip = currentStrip(store, target);
  if (eq !== null && !Array.isArray(eq.bands)) {
    throw new RangeError('Strip EQ requires a bands array');
  }
  const key = `strip-eq:${String(target)}`;
  // Skip a redundant edit so re-applying an unchanged EQ adds no undo step;
  // a live band drag (pending gesture) still commits so coalescing works.
  if (JSON.stringify(strip.eq ?? null) === JSON.stringify(eq) && !hasPendingGesture(key)) return;
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
 * Adds, updates or removes a send from a track strip to a bus as one undoable
 * edit. Track sends feed the engine's realtime bus lanes. The master strip has
 * no engine send bus, so new master sends are rejected; clearing a legacy
 * master send remains allowed for document cleanup.
 *
 * @param target Track id or 'master'.
 * @param busId Destination bus id (must exist).
 * @param send New level/enabled/timing state, or null to remove the send.
 */
export function setSend(
  target: MixerStripTarget,
  busId: string,
  send: { levelDb: number; enabled?: boolean; timing?: SendTiming } | null,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, target);
  if (target === 'master' && send !== null) {
    throw new RangeError('The master strip has no audible send bus');
  }
  if (!store.mixer.buses.some((bus) => bus.id === busId)) {
    throw new RangeError(`Unknown mixer bus id: ${busId}`);
  }
  if (send !== null && !Number.isFinite(send.levelDb)) {
    throw new RangeError(`Send level must be finite, got ${send.levelDb}`);
  }
  const key = `strip-send:${String(target)}:${busId}`;
  executeApp(
    () => {
      const next = cloneStrip(strip);
      const existing = next.sends.findIndex((s) => s.busId === busId);
      if (send === null) {
        if (existing >= 0) next.sends = next.sends.filter((s) => s.busId !== busId);
      } else {
        const prevTiming = existing >= 0 ? next.sends[existing].timing : undefined;
        const timing = send.timing ?? prevTiming;
        const entry: StripSend = { busId, levelDb: send.levelDb, enabled: send.enabled ?? true };
        // Keep the field absent for the default (post-fader) so neutral strips stay neutral.
        if (timing !== undefined && timing !== 'postFader') entry.timing = timing;
        if (existing >= 0) next.sends[existing] = entry;
        else next.sends = [...next.sends, entry];
      }
      writeStrip(store, target, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Sets a track strip's channel alignment delay in whole samples as one
 * undoable edit. Mirrored to the engine strip panner
 * (setTrackStripChannelDelaySamples) and folded into plugin-delay
 * compensation. Track strips only (the master/bus lanes have no alignment
 * delay stage).
 *
 * @param trackId Id of the track.
 * @param samples Delay in samples (integer in [0, MAX_CHANNEL_DELAY_SAMPLES]).
 */
export function setStripChannelDelaySamples(trackId: number, samples: number): void {
  const store = useProjectStore();
  const strip = currentStrip(store, trackId);
  if (!Number.isInteger(samples) || samples < 0 || samples > MAX_CHANNEL_DELAY_SAMPLES) {
    throw new RangeError(
      `Channel delay must be an integer in [0, ${MAX_CHANNEL_DELAY_SAMPLES}] samples, got ${samples}`,
    );
  }
  if ((strip.channelDelaySamples ?? 0) === samples) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    // Keep the field absent at 0 so neutral strips stay neutral.
    if (samples === 0) delete next.channelDelaySamples;
    else next.channelDelaySamples = samples;
    writeStrip(store, trackId, next);
    store.refresh();
  });
}

/**
 * Sets a track strip's pan law as one undoable edit. Mirrored to the engine
 * strip panner (setTrackStripPanLaw). Track strips only (the master/bus lanes
 * have no strip panner).
 *
 * @param trackId Id of the track.
 * @param law New pan law (one of {@link PAN_LAW_IDS}).
 */
export function setStripPanLaw(trackId: number, law: PanLawId): void {
  const store = useProjectStore();
  const strip = currentStrip(store, trackId);
  if (!PAN_LAW_IDS.includes(law)) {
    throw new RangeError(`Unknown pan law: ${law}`);
  }
  if ((strip.panLaw ?? DEFAULT_PAN_LAW) === law) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    // Keep the field absent at the default so neutral strips stay neutral.
    if (law === DEFAULT_PAN_LAW) delete next.panLaw;
    else next.panLaw = law;
    writeStrip(store, trackId, next);
    store.refresh();
  });
}

/**
 * Sets a track strip's pan mode as one undoable edit. Mirrored to the engine
 * strip panner (setTrackStripPanMode). Track strips only.
 *
 * @param trackId Id of the track.
 * @param mode New pan mode (one of {@link PAN_MODE_IDS}).
 */
export function setStripPanMode(trackId: number, mode: PanModeId): void {
  const store = useProjectStore();
  const strip = currentStrip(store, trackId);
  if (!PAN_MODE_IDS.includes(mode)) {
    throw new RangeError(`Unknown pan mode: ${mode}`);
  }
  if ((strip.panMode ?? DEFAULT_PAN_MODE) === mode) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    // Keep the field absent at the default so neutral strips stay neutral.
    if (mode === DEFAULT_PAN_MODE) delete next.panMode;
    else next.panMode = mode;
    writeStrip(store, trackId, next);
    store.refresh();
  });
}

/**
 * Sets a track strip's independent left/right pan positions (used in 'dualPan'
 * mode) as one undoable edit. Mirrored to the engine strip panner
 * (setTrackStripDualPan). Track strips only.
 *
 * @param trackId Id of the track.
 * @param left New left-channel pan in [-1, 1].
 * @param right New right-channel pan in [-1, 1].
 * @param options Gesture coalescing for slider drags.
 */
export function setStripDualPan(
  trackId: number,
  left: number,
  right: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, trackId);
  if (!Number.isFinite(left) || left < -1 || left > 1) {
    throw new RangeError(`Dual-pan left must be in [-1, 1], got ${left}`);
  }
  if (!Number.isFinite(right) || right < -1 || right > 1) {
    throw new RangeError(`Dual-pan right must be in [-1, 1], got ${right}`);
  }
  const key = `strip-dual-pan:${trackId}`;
  if (strip.dualPan?.left === left && strip.dualPan?.right === right && !hasPendingGesture(key)) {
    return;
  }
  executeApp(
    () => {
      const next = cloneStrip(strip);
      next.dualPan = { left, right };
      writeStrip(store, trackId, next);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
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
  if (isMixerBusStripTarget(target)) {
    throw new RangeError('A bus return strip has no output bus to route');
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
