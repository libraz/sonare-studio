import type { PanLaw, SendTiming } from '@libraz/libsonare';
import {
  assertKnownBusDestination,
  assertNoBusRoutingCycle,
  mixerBusTopology,
} from '../bus-topology';
import { cloneJson } from '../clone-json';
import {
  cloneStrip,
  DEFAULT_DUAL_PAN,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  hasAudibleOutputRoute,
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
  type PanModeId,
  type StripEq,
  type StripSend,
} from '../mixer';
import { useProjectStore } from '../store';
import { type CommandGestureOptions, executeApp, hasPendingGesture } from './history';
import { setMixerBusGain } from './mixer-buses';
import {
  currentStrip,
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
  patchMixerMirror,
  sidechainTargetTopologyId,
  writeStrip,
} from './mixer-internal';
import { requireTrack } from './utils';

export {
  addInsert,
  removeInsert,
  reorderInsert,
  replaceInsert,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
} from './mixer-inserts';
export {
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setTrackExternalMidiMode,
  setTrackExternalMidiModes,
  setTrackInstrument,
  setTrackInstruments,
} from './track-instruments';

/** Rejects stereo-only strip stages on a surround return bus. */
function assertStereoBusStageAllowed(
  store: ReturnType<typeof useProjectStore>,
  target: MixerStripTarget,
): void {
  if (!isMixerBusStripTarget(target)) return;
  const bus = store.mixer.buses.find((entry) => entry.id === mixerBusIdFromTarget(target));
  if (bus?.channelLayout === '5.1' || bus?.channelLayout === '7.1') {
    throw new RangeError('Surround mixer buses cannot carry a stereo pan or width stage');
  }
}

/** Rejects a bus route to an unknown or own destination, or one that closes a routing cycle. */
function assertBusRouteAllowed(
  store: ReturnType<typeof useProjectStore>,
  sourceBusId: string,
  destinationBusId: string,
): void {
  const knownBusIds = new Set(store.mixer.buses.map((bus) => bus.id));
  assertKnownBusDestination(destinationBusId, knownBusIds, sourceBusId);
  assertNoBusRoutingCycle(
    mixerBusTopology(
      store.mixer,
      store.tracks
        .filter((track) => track.kind === 'group')
        .map((track) => ({ id: track.id, mixer: track.mixer })),
    ),
    sourceBusId,
    destinationBusId,
  );
}

// ---------------------------------------------------------------------------
// Instrument / mixer commands (app-level metadata, execute(0)-style)
// ---------------------------------------------------------------------------

/** Sets the project-wide solo audition mode as one undoable edit. */
export function setMixerSoloMode(mode: MixerSoloMode): void {
  const store = useProjectStore();
  const next = normalizeMixerSoloMode(mode);
  if ((store.mixer.soloMode ?? 'inPlace') === next) return;
  executeApp(() => {
    store.mixer = {
      ...store.mixer,
      ...(next === 'inPlace' ? { soloMode: undefined } : { soloMode: next }),
    };
    store.refresh();
  });
}

/**
 * Sets a strip's gain as one undoable edit. Strip gain is audible: it is
 * mirrored to the engine lane (or master) fader in realtime.
 *
 * @param target Track id, return/group bus target, or 'master'.
 * @param gainDb New gain in dB (finite, within [-96, 24]).
 * @param options Gesture coalescing for fader drags.
 */
export function setStripGain(
  target: MixerStripTarget,
  gainDb: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  if (isMixerBusStripTarget(target)) {
    setMixerBusGain(mixerBusIdFromTarget(target), gainDb, options);
    return;
  }
  const strip = currentStrip(store, target);
  if (!Number.isFinite(gainDb) || gainDb < MIN_STRIP_GAIN_DB || gainDb > MAX_STRIP_GAIN_DB) {
    throw new RangeError(
      `Strip gain must be within [${MIN_STRIP_GAIN_DB}, ${MAX_STRIP_GAIN_DB}] dB, got ${gainDb}`,
    );
  }
  const key = `strip-gain:${String(target)}`;
  if (strip.gainDb === gainDb && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    writeStrip(store, target, { ...cloneStrip(strip), gainDb });
  });
}

/**
 * Sets a strip's pan as one undoable edit. Strip pan is audible: it is
 * mirrored to the engine lane (or master) pan in realtime.
 *
 * @param target Track id, return/group bus target, or 'master'.
 * @param pan New balance in [-1, 1].
 * @param options Gesture coalescing for knob drags.
 */
export function setStripPan(
  target: MixerStripTarget,
  pan: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
    throw new RangeError(`Strip pan must be in [-1, 1], got ${pan}`);
  }
  const track = typeof target === 'number' ? requireTrack(store, target) : undefined;
  const strip = currentStrip(store, target);
  const key = `strip-pan:${String(target)}`;
  // EditorTrack.pan remains as a document-compatibility mirror for older
  // project readers. MixerStrip.pan is the single audible source of truth.
  if (strip.pan === pan && (track === undefined || track.pan === pan) && !hasPendingGesture(key)) {
    return;
  }
  assertStereoBusStageAllowed(store, target);
  patchMixerMirror(key, options, () => {
    writeStrip(store, target, { ...cloneStrip(strip), pan });
    if (track !== undefined) {
      store.tracks = store.tracks.map((entry) =>
        entry.id === track.id ? { ...entry, pan } : entry,
      );
    }
  });
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
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    if (trimDb === 0) delete next.inputTrimDb;
    else next.inputTrimDb = trimDb;
    writeStrip(store, target, next);
  });
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
  assertStereoBusStageAllowed(store, target);
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    if (width === DEFAULT_STRIP_WIDTH) delete next.width;
    else next.width = width;
    writeStrip(store, target, next);
  });
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
 * Replaces a strip's EQ as one undoable edit. Track, group-bus, return-bus and
 * master EQ are mirrored to the matching engine strip when supported by the
 * active libsonare ABI.
 *
 * @param target Track id, return/group bus target, or 'master'.
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
  // Skip a redundant edit so re-applying an unchanged EQ adds no undo step;
  // a live band drag (pending gesture) still commits so coalescing works.
  if (JSON.stringify(strip.eq ?? null) === JSON.stringify(eq) && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    if (eq === null) delete next.eq;
    else next.eq = cloneJson(eq);
    writeStrip(store, target, next);
  });
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
  const sendSourceBusId = send === null ? undefined : sidechainTargetTopologyId(store, target);
  if (sendSourceBusId !== undefined) assertBusRouteAllowed(store, sendSourceBusId, busId);
  if (send !== null && !Number.isFinite(send.levelDb)) {
    throw new RangeError(`Send level must be finite, got ${send.levelDb}`);
  }
  const key = `strip-send:${String(target)}:${busId}`;
  const existing = strip.sends.find((entry) => entry.busId === busId);
  if (send === null) {
    if (existing === undefined && !hasPendingGesture(key)) return;
  } else {
    const timing = send.timing ?? existing?.timing;
    if (
      existing !== undefined &&
      existing.levelDb === send.levelDb &&
      existing.enabled === (send.enabled ?? true) &&
      existing.timing === (timing === 'postFader' ? undefined : timing) &&
      !hasPendingGesture(key)
    ) {
      return;
    }
  }
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    const existingIndex = next.sends.findIndex((s) => s.busId === busId);
    if (send === null) {
      if (existingIndex >= 0) next.sends = next.sends.filter((s) => s.busId !== busId);
    } else {
      const prevTiming = existingIndex >= 0 ? next.sends[existingIndex].timing : undefined;
      const timing = send.timing ?? prevTiming;
      const entry: StripSend = { busId, levelDb: send.levelDb, enabled: send.enabled ?? true };
      // Keep the field absent for the default (post-fader) so neutral strips stay neutral.
      if (timing !== undefined && timing !== 'postFader') entry.timing = timing;
      if (existingIndex >= 0) next.sends[existingIndex] = entry;
      else next.sends = [...next.sends, entry];
    }
    writeStrip(store, target, next);
  });
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
 * @param options Gesture coalescing for continuous controllers.
 */
export function setStripChannelDelaySamples(
  trackId: number,
  samples: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const strip = currentStrip(store, trackId);
  if (!Number.isInteger(samples) || samples < 0 || samples > MAX_CHANNEL_DELAY_SAMPLES) {
    throw new RangeError(
      `Channel delay must be an integer in [0, ${MAX_CHANNEL_DELAY_SAMPLES}] samples, got ${samples}`,
    );
  }
  const key = `strip-channel-delay:${trackId}`;
  if ((strip.channelDelaySamples ?? 0) === samples && !hasPendingGesture(key)) return;
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    // Keep the field absent at 0 so neutral strips stay neutral.
    if (samples === 0) delete next.channelDelaySamples;
    else next.channelDelaySamples = samples;
    writeStrip(store, trackId, next);
    store.refresh();
  });
}

/**
 * Sets a track or return/group bus strip's pan law as one undoable edit.
 * Master pan-law state is not accepted because the realtime engine exposes no
 * master-strip setter for it.
 *
 * @param target Track id or return/group bus target.
 * @param law New pan law (one of {@link PAN_LAW_IDS}).
 */
export function setStripPanLaw(target: MixerStripTarget, law: PanLaw): void {
  const store = useProjectStore();
  if (target === 'master') {
    throw new RangeError('Master strip pan law is not supported by the realtime engine');
  }
  const strip = currentStrip(store, target);
  if (!PAN_LAW_IDS.includes(law)) {
    throw new RangeError(`Unknown pan law: ${law}`);
  }
  if ((strip.panLaw ?? DEFAULT_PAN_LAW) === law) return;
  assertStereoBusStageAllowed(store, target);
  executeApp(() => {
    const next = cloneStrip(strip);
    // Keep the field absent at the default so neutral strips stay neutral.
    if (law === DEFAULT_PAN_LAW) delete next.panLaw;
    else next.panLaw = law;
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Sets a track or return/group bus strip's pan mode as one undoable edit.
 * Master pan-mode state is not accepted because the realtime engine exposes no
 * master-strip setter for it.
 *
 * @param target Track id or return/group bus target.
 * @param mode New pan mode (one of {@link PAN_MODE_IDS}).
 */
export function setStripPanMode(target: MixerStripTarget, mode: PanModeId): void {
  const store = useProjectStore();
  if (target === 'master') {
    throw new RangeError('Master strip pan mode is not supported by the realtime engine');
  }
  const strip = currentStrip(store, target);
  if (!PAN_MODE_IDS.includes(mode)) {
    throw new RangeError(`Unknown pan mode: ${mode}`);
  }
  if ((strip.panMode ?? DEFAULT_PAN_MODE) === mode) return;
  assertStereoBusStageAllowed(store, target);
  executeApp(() => {
    const next = cloneStrip(strip);
    // Keep the field absent at the default so neutral strips stay neutral.
    if (mode === DEFAULT_PAN_MODE) delete next.panMode;
    else {
      next.panMode = mode;
      // Persist the dual-pan default at the point the mode changes.  The
      // realtime and offline engines both receive explicit L/R values, and
      // loading the saved document produces the same panner state.
      if (mode === 'dualPan' && next.dualPan === undefined) {
        // A stereo strip's neutral dual-pan identity is L=-1/R=+1. Keep that
        // identity even when the legacy balance knob is currently offset;
        // copying `next.pan` into both channels would collapse the stereo
        // image when the mode changes.
        next.dualPan = { ...DEFAULT_DUAL_PAN };
      }
    }
    writeStrip(store, target, next);
    store.refresh();
  });
}

/**
 * Sets independent left/right pan positions (used in 'dualPan' mode) on a
 * track or return/group bus strip as one undoable edit. Master dual-pan state
 * is not accepted because the realtime engine exposes no master-strip setter.
 *
 * @param target Track id or return/group bus target.
 * @param left New left-channel pan in [-1, 1].
 * @param right New right-channel pan in [-1, 1].
 * @param options Gesture coalescing for slider drags.
 */
export function setStripDualPan(
  target: MixerStripTarget,
  left: number,
  right: number,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  if (target === 'master') {
    throw new RangeError('Master strip dual pan is not supported by the realtime engine');
  }
  const strip = currentStrip(store, target);
  if (!Number.isFinite(left) || left < -1 || left > 1) {
    throw new RangeError(`Dual-pan left must be in [-1, 1], got ${left}`);
  }
  if (!Number.isFinite(right) || right < -1 || right > 1) {
    throw new RangeError(`Dual-pan right must be in [-1, 1], got ${right}`);
  }
  const key = `strip-dual-pan:${String(target)}`;
  if (strip.dualPan?.left === left && strip.dualPan?.right === right && !hasPendingGesture(key)) {
    return;
  }
  assertStereoBusStageAllowed(store, target);
  patchMixerMirror(key, options, () => {
    const next = cloneStrip(strip);
    next.dualPan = { left, right };
    writeStrip(store, target, next);
  });
}

/**
 * Routes a track strip's post-fader output into a send bus (or back to the
 * master mix) as one undoable edit. The routing is audible: strip-sync points
 * the engine lane at the bus, which sums into the master mix. Group members
 * ignore this (their group bus always wins), and the master strip has no lane
 * to route, so both are rejected; a member may still clear a stored route.
 *
 * @param target Track id (not 'master').
 * @param busId Destination bus id, or null to restore the master mix.
 */
export function setStripOutputBus(target: MixerStripTarget, busId: string | null): void {
  const store = useProjectStore();
  if (target === 'master') {
    throw new RangeError('The master strip has no output bus to route');
  }
  if (
    busId !== null &&
    typeof target === 'number' &&
    !hasAudibleOutputRoute(requireTrack(store, target))
  ) {
    throw new RangeError(`Track ${target} is a group member; its group bus sets its output`);
  }
  const sourceBusId = sidechainTargetTopologyId(store, target);
  if (busId !== null && !store.mixer.buses.some((bus) => bus.id === busId)) {
    throw new RangeError(`Unknown mixer bus id: ${busId}`);
  }
  if (busId !== null && sourceBusId !== undefined) {
    assertBusRouteAllowed(store, sourceBusId, busId);
  }
  const strip = currentStrip(store, target);
  if ((strip.outputBusId ?? null) === busId) return;
  executeApp(() => {
    const next = cloneStrip(strip);
    if (busId === null) delete next.outputBusId;
    else next.outputBusId = busId;
    writeStrip(store, target, next);
    store.refresh();
  });
}
