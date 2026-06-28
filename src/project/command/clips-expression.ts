import {
  isValidChannel,
  isValidController,
  sanitizeCcPoints,
  sanitizePitchBendPoints,
  sanitizePressurePoints,
} from '../midi-cc';
import { useProjectStore } from '../store';
import type {
  ClipCcLane,
  ClipCcPoint,
  ClipChannelPressureLane,
  ClipPitchBendLane,
  ClipPitchBendPoint,
  ClipPolyPressureLane,
  ClipPressurePoint,
} from '../types';
import { execute } from './history';

// ---------------------------------------------------------------------------
// Clip expression-lane commands
// ---------------------------------------------------------------------------

/**
 * Replaces one CC automation lane of a MIDI clip as one undoable edit. The
 * points are sanitized (clamped to the clip window and 0-127, sorted, deduped);
 * passing an empty point list removes the lane. CC lanes are app-level metadata
 * baked into the realtime MIDI schedule, so the change is audible on the next
 * sync without a Project edit.
 *
 * @param clipId Id of the MIDI clip.
 * @param controller MIDI controller number (integer, 0-127).
 * @param channel MIDI channel the CC is emitted on (integer, 0-15).
 * @param points Breakpoints (clip-window-relative PPQ + 0-127 value); empty
 *   removes the lane.
 */
export function setClipCcLane(
  clipId: number,
  controller: number,
  channel: number,
  points: ReadonlyArray<ClipCcPoint>,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  if (!isValidController(controller)) {
    throw new RangeError(`CC controller must be an integer in [0, 127], got ${controller}`);
  }
  if (!isValidChannel(channel)) {
    throw new RangeError(`CC channel must be an integer in [0, 15], got ${channel}`);
  }
  const sanitized = sanitizeCcPoints(points, clip.lengthPpq);
  const others = (clip.ccLanes ?? []).filter(
    (lane) => lane.controller !== controller || lane.channel !== channel,
  );
  const nextLanes: ClipCcLane[] =
    sanitized.length > 0 ? [...others, { controller, channel, points: sanitized }] : others;
  nextLanes.sort((a, b) => a.controller - b.controller || a.channel - b.channel);
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (nextLanes.length > 0) updated.ccLanes = nextLanes;
      else delete updated.ccLanes;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Replaces a MIDI clip's pitch-bend lane for one channel as one undoable edit.
 * The points are sanitized (clamped to the clip window and the 14-bit range
 * 0-16383 where 8192 is center, sorted, deduped); passing an empty point list
 * removes the lane. Like CC lanes, pitch-bend lanes are app-level metadata baked
 * into the realtime MIDI schedule, so the change is audible on the next sync.
 *
 * @param clipId Id of the MIDI clip.
 * @param channel MIDI channel the bend applies to (integer, 0-15).
 * @param points Breakpoints (clip-window-relative PPQ + 0-16383 value); empty
 *   removes the lane.
 */
export function setClipPitchBend(
  clipId: number,
  channel: number,
  points: ReadonlyArray<ClipPitchBendPoint>,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  if (!isValidChannel(channel)) {
    throw new RangeError(`Pitch-bend channel must be an integer in [0, 15], got ${channel}`);
  }
  const sanitized = sanitizePitchBendPoints(points, clip.lengthPpq);
  const others = (clip.pitchBendLanes ?? []).filter((lane) => lane.channel !== channel);
  const nextLanes: ClipPitchBendLane[] =
    sanitized.length > 0 ? [...others, { channel, points: sanitized }] : others;
  nextLanes.sort((a, b) => a.channel - b.channel);
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (nextLanes.length > 0) updated.pitchBendLanes = nextLanes;
      else delete updated.pitchBendLanes;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Replaces a MIDI clip's channel-pressure (monophonic aftertouch) lane for one
 * channel as one undoable edit. The points are sanitized (clamped to the clip
 * window and 0-127, sorted, deduped); passing an empty point list removes the
 * lane. Like CC lanes, channel-pressure lanes are app-level metadata baked into
 * the realtime MIDI schedule, so the change is audible on the next sync.
 *
 * @param clipId Id of the MIDI clip.
 * @param channel MIDI channel the pressure applies to (integer, 0-15).
 * @param points Breakpoints (clip-window-relative PPQ + 0-127 value); empty
 *   removes the lane.
 */
export function setClipChannelPressure(
  clipId: number,
  channel: number,
  points: ReadonlyArray<ClipPressurePoint>,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  if (!isValidChannel(channel)) {
    throw new RangeError(`Channel-pressure channel must be an integer in [0, 15], got ${channel}`);
  }
  const sanitized = sanitizePressurePoints(points, clip.lengthPpq);
  const others = (clip.channelPressureLanes ?? []).filter((lane) => lane.channel !== channel);
  const nextLanes: ClipChannelPressureLane[] =
    sanitized.length > 0 ? [...others, { channel, points: sanitized }] : others;
  nextLanes.sort((a, b) => a.channel - b.channel);
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (nextLanes.length > 0) updated.channelPressureLanes = nextLanes;
      else delete updated.channelPressureLanes;
      return updated;
    });
    store.refresh();
  });
}

/**
 * Replaces a MIDI clip's polyphonic key-pressure lane for one channel/pitch as
 * one undoable edit. The points are sanitized (clamped to the clip window and
 * 0-127, sorted, deduped); passing an empty point list removes the lane. Like
 * the other expression lanes, poly-pressure lanes are app-level metadata baked
 * into the realtime MIDI schedule, so the change is audible on the next sync.
 *
 * @param clipId Id of the MIDI clip.
 * @param channel MIDI channel the pressure applies to (integer, 0-15).
 * @param pitch MIDI note number the pressure applies to (integer, 0-127).
 * @param points Breakpoints (clip-window-relative PPQ + 0-127 value); empty
 *   removes the lane.
 */
export function setClipPolyPressure(
  clipId: number,
  channel: number,
  pitch: number,
  points: ReadonlyArray<ClipPressurePoint>,
): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip id ${clipId}`);
  const clip = store.clips[index];
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  if (!isValidChannel(channel)) {
    throw new RangeError(`Poly-pressure channel must be an integer in [0, 15], got ${channel}`);
  }
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
    throw new RangeError(`Poly-pressure pitch must be an integer in [0, 127], got ${pitch}`);
  }
  const sanitized = sanitizePressurePoints(points, clip.lengthPpq);
  const others = (clip.polyPressureLanes ?? []).filter(
    (lane) => lane.channel !== channel || lane.pitch !== pitch,
  );
  const nextLanes: ClipPolyPressureLane[] =
    sanitized.length > 0 ? [...others, { channel, pitch, points: sanitized }] : others;
  nextLanes.sort((a, b) => a.channel - b.channel || a.pitch - b.pitch);
  execute(0, () => {
    store.clips = store.clips.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry };
      if (nextLanes.length > 0) updated.polyPressureLanes = nextLanes;
      else delete updated.polyPressureLanes;
      return updated;
    });
    store.refresh();
  });
}
