/**
 * Descriptor table for the five MIDI clip lane kinds (CC, pitch bend, program
 * change, channel pressure, polyphonic pressure) plus the generic join, clone
 * and window-transform helpers that iterate it. A kind differs only in its lane
 * identity key, ordering, point sanitizer, the identity fields of a lane and the
 * point a cut places (interpolated on ramping lanes, held on program changes).
 * Pure and canvas-free.
 */

import {
  curveT,
  isValidChannel,
  isValidController,
  sanitizeCcPoints,
  sanitizePitchBendPoints,
  sanitizePressurePoints,
  sanitizeProgramChangePoints,
} from './midi-cc';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipExpressionCurve,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
} from './types';

/** Lane-list fields shared by EditorClip and MidiClipTake. */
export interface MidiLaneFields {
  ccLanes: ClipCcLane[];
  pitchBendLanes: ClipPitchBendLane[];
  programChangeLanes: ClipProgramChangeLane[];
  channelPressureLanes: ClipChannelPressureLane[];
  polyPressureLanes: ClipPolyPressureLane[];
}

/** Name of a lane-list field. */
export type MidiLaneField = keyof MidiLaneFields;

/** Lane type stored under field `F`. */
export type MidiLaneOf<F extends MidiLaneField> = MidiLaneFields[F][number];

type AnyLane = MidiLaneOf<MidiLaneField>;
type AnyPoint = AnyLane['points'][number];

/** Per-kind behaviour the generic lane helpers rely on. */
export interface MidiLaneKind<F extends MidiLaneField> {
  /** Lane-list field on EditorClip / MidiClipTake. */
  field: F;
  /** Identity key: lanes with equal keys describe the same lane. */
  key(lane: MidiLaneOf<F>): string;
  /** Sort order of lanes within a list. */
  compare(a: MidiLaneOf<F>, b: MidiLaneOf<F>): number;
  /** Normalizes merged points to the clip window `[0, lengthPpq]`. */
  sanitize(
    points: ReadonlyArray<MidiLaneOf<F>['points'][number]>,
    lengthPpq: number,
  ): MidiLaneOf<F>['points'];
  /** Copy of the lane's identity fields with an empty point list. */
  shell(lane: MidiLaneOf<F>): MidiLaneOf<F>;
  /** Validated {@link shell} of an untrusted stored lane, or null when its identity is invalid. */
  parseShell(lane: StoredLane): MidiLaneOf<F> | null;
  /** True when the segment starting at `point` ramps toward the next point. */
  ramps(point: MidiLaneOf<F>['points'][number]): boolean;
  /** Point a cut at `ppq` places: what `previous` has reached there on its way to `next`. */
  pointAt(
    previous: MidiLaneOf<F>['points'][number],
    next: MidiLaneOf<F>['points'][number] | undefined,
    ppq: number,
  ): MidiLaneOf<F>['points'][number];
  /** True when cloning drops lanes that have no points. */
  dropEmptyOnClone: boolean;
}

/** A lane as read from stored data, before validation. */
type StoredLane = { readonly [field: string]: unknown };

/** Kind with its lane type erased, for loops over every kind. */
export type AnyMidiLaneKind = MidiLaneKind<MidiLaneField>;
type ErasedKind = AnyMidiLaneKind;

function defineKind<F extends MidiLaneField>(kind: MidiLaneKind<F>): ErasedKind {
  return kind as unknown as ErasedKind;
}

interface RampPoint {
  ppq: number;
  value: number;
  curve?: ClipExpressionCurve;
}

function rampCurve(point: RampPoint): boolean {
  return point.curve === 'linear' || point.curve === 's-curve';
}

function rampPointAt<P extends RampPoint>(previous: P, next: P | undefined, ppq: number): P {
  if (next === undefined || !rampCurve(previous) || !(next.ppq > previous.ppq)) {
    return { ...previous, ppq };
  }
  const t = Math.min(1, Math.max(0, (ppq - previous.ppq) / (next.ppq - previous.ppq)));
  return {
    ...previous,
    ppq,
    value: Math.round(previous.value + (next.value - previous.value) * curveT(previous.curve, t)),
  };
}

function channelShell(lane: StoredLane): { channel: number; points: [] } | null {
  const channel = lane.channel as number;
  return isValidChannel(channel) ? { channel, points: [] } : null;
}

function holdPointAt<P extends { ppq: number }>(previous: P, _next: P | undefined, ppq: number): P {
  return { ...previous, ppq };
}

/** Lane kinds in canonical field order. */
export const MIDI_LANE_KINDS: readonly ErasedKind[] = [
  defineKind({
    field: 'ccLanes',
    key: (lane: ClipCcLane) => `${lane.controller}:${lane.channel}`,
    compare: (a: ClipCcLane, b: ClipCcLane) => a.controller - b.controller || a.channel - b.channel,
    sanitize: sanitizeCcPoints,
    shell: (lane: ClipCcLane): ClipCcLane => ({
      controller: lane.controller,
      channel: lane.channel,
      points: [],
    }),
    parseShell: (lane: StoredLane): ClipCcLane | null => {
      const controller = lane.controller as number;
      const channel = lane.channel as number;
      return isValidController(controller) && isValidChannel(channel)
        ? { controller, channel, points: [] }
        : null;
    },
    ramps: rampCurve,
    pointAt: rampPointAt,
    dropEmptyOnClone: true,
  }),
  defineKind({
    field: 'pitchBendLanes',
    key: (lane: ClipPitchBendLane) => String(lane.channel),
    compare: (a: ClipPitchBendLane, b: ClipPitchBendLane) => a.channel - b.channel,
    sanitize: sanitizePitchBendPoints,
    shell: (lane: ClipPitchBendLane): ClipPitchBendLane => ({ channel: lane.channel, points: [] }),
    parseShell: channelShell,
    ramps: rampCurve,
    pointAt: rampPointAt,
    dropEmptyOnClone: false,
  }),
  defineKind({
    field: 'programChangeLanes',
    key: (lane: ClipProgramChangeLane) => String(lane.channel),
    compare: (a: ClipProgramChangeLane, b: ClipProgramChangeLane) => a.channel - b.channel,
    sanitize: sanitizeProgramChangePoints,
    shell: (lane: ClipProgramChangeLane): ClipProgramChangeLane => ({
      channel: lane.channel,
      points: [],
    }),
    parseShell: channelShell,
    ramps: () => false,
    pointAt: holdPointAt,
    dropEmptyOnClone: false,
  }),
  defineKind({
    field: 'channelPressureLanes',
    key: (lane: ClipChannelPressureLane) => String(lane.channel),
    compare: (a: ClipChannelPressureLane, b: ClipChannelPressureLane) => a.channel - b.channel,
    sanitize: sanitizePressurePoints,
    shell: (lane: ClipChannelPressureLane): ClipChannelPressureLane => ({
      channel: lane.channel,
      points: [],
    }),
    parseShell: channelShell,
    ramps: rampCurve,
    pointAt: rampPointAt,
    dropEmptyOnClone: false,
  }),
  defineKind({
    field: 'polyPressureLanes',
    key: (lane: ClipPolyPressureLane) => `${lane.channel}:${lane.pitch}`,
    compare: (a: ClipPolyPressureLane, b: ClipPolyPressureLane) =>
      a.channel - b.channel || a.pitch - b.pitch,
    sanitize: sanitizePressurePoints,
    shell: (lane: ClipPolyPressureLane): ClipPolyPressureLane => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: [],
    }),
    parseShell: (lane: StoredLane): ClipPolyPressureLane | null => {
      const channel = lane.channel as number;
      const pitch = Math.round(Number(lane.pitch));
      return isValidChannel(channel) && Number.isInteger(pitch) && pitch >= 0 && pitch <= 127
        ? { channel, pitch, points: [] }
        : null;
    },
    ramps: rampCurve,
    pointAt: rampPointAt,
    dropEmptyOnClone: false,
  }),
];

type LaneRecord = Partial<Record<MidiLaneField, AnyLane[]>>;

/** Maps lane points through `transform`, keeping each lane's identity fields. */
type PointsTransform = <P extends { ppq: number }>(
  points: ReadonlyArray<P>,
  kind: AnyMidiLaneKind,
) => P[];

/**
 * Merges the lanes of several source clips into one lane list per kind. Lanes
 * with the same identity key are concatenated, points are sanitized to
 * `[0, lengthPpq]`, empty lanes are dropped and the result is sorted.
 *
 * @param sources Source clips, in merge order.
 * @param lengthPpq Length of the merged window.
 * @param placePoints Maps a source lane's points into the merged window.
 * @returns Only the kinds that ended up with at least one lane.
 */
export function joinMidiLaneFields<S extends Partial<MidiLaneFields>>(
  sources: readonly S[],
  lengthPpq: number,
  placePoints: (points: ReadonlyArray<AnyPoint>, source: S, kind: AnyMidiLaneKind) => AnyPoint[],
): Partial<MidiLaneFields> {
  const out: LaneRecord = {};
  for (const kind of MIDI_LANE_KINDS) {
    const lanes = new Map<string, AnyLane>();
    for (const source of sources) {
      for (const lane of source[kind.field] ?? []) {
        const key = kind.key(lane);
        const current = lanes.get(key) ?? kind.shell(lane);
        (current.points as AnyPoint[]).push(...placePoints(lane.points, source, kind));
        lanes.set(key, current);
      }
    }
    const joined = [...lanes.values()]
      .map((lane) => ({ ...lane, points: kind.sanitize(lane.points, lengthPpq) }) as AnyLane)
      .filter((lane) => lane.points.length > 0)
      .sort(kind.compare);
    if (joined.length > 0) out[kind.field] = joined;
  }
  return out as Partial<MidiLaneFields>;
}

/**
 * Rebuilds lane lists from untrusted stored data: lanes with an invalid
 * identity drop, lanes sharing a key merge, points are sanitized to
 * `[0, lengthPpq]`, empty lanes drop and every list is sorted.
 *
 * @returns Only the kinds that kept at least one lane.
 */
export function loadMidiLaneFields(
  stored: { readonly [F in MidiLaneField]?: unknown },
  lengthPpq: number,
): Partial<MidiLaneFields> {
  const parsed: LaneRecord = {};
  for (const kind of MIDI_LANE_KINDS) {
    const lanes = stored[kind.field];
    if (!Array.isArray(lanes)) continue;
    parsed[kind.field] = lanes.flatMap((lane: StoredLane | null) => {
      const shell = lane !== null && typeof lane === 'object' ? kind.parseShell(lane) : null;
      if (shell === null) return [];
      return [{ ...shell, points: Array.isArray(lane?.points) ? lane.points : [] } as AnyLane];
    });
  }
  return joinMidiLaneFields([parsed as Partial<MidiLaneFields>], lengthPpq, (points) => [
    ...points,
  ]);
}

/**
 * Deep-copies every lane list present on `source`. A kind whose
 * `dropEmptyOnClone` is set omits empty lanes and yields `undefined` when none
 * remain; the key is still present so a take copy keeps its shape.
 */
export function cloneMidiLaneFields(source: Partial<MidiLaneFields>): Partial<MidiLaneFields> {
  const out: Partial<Record<MidiLaneField, AnyLane[] | undefined>> = {};
  for (const kind of MIDI_LANE_KINDS) {
    const lanes = source[kind.field] as AnyLane[] | undefined;
    if (lanes === undefined) continue;
    const kept = kind.dropEmptyOnClone ? lanes.filter((lane) => lane.points.length > 0) : lanes;
    const copied = kept.map((lane) => ({
      ...kind.shell(lane),
      points: lane.points.map((point) => ({ ...point })),
    })) as AnyLane[];
    out[kind.field] = kind.dropEmptyOnClone && copied.length === 0 ? undefined : copied;
  }
  return out as Partial<MidiLaneFields>;
}

/** Lane-list fields as read-only input. */
type ReadonlyMidiLaneFields = { readonly [F in MidiLaneField]?: ReadonlyArray<MidiLaneOf<F>> };

/**
 * Copies every lane list present on `source`, spreading each lane (extra
 * properties and empty lanes survive) and copying its points.
 */
export function copyMidiLaneFields(source: ReadonlyMidiLaneFields): Partial<MidiLaneFields> {
  const out: LaneRecord = {};
  for (const kind of MIDI_LANE_KINDS) {
    const lanes = source[kind.field] as ReadonlyArray<AnyLane> | undefined;
    if (lanes === undefined) continue;
    out[kind.field] = lanes.map((lane) => ({
      ...lane,
      points: lane.points.map((point) => ({ ...point })),
    })) as AnyLane[];
  }
  return out as Partial<MidiLaneFields>;
}

/**
 * Re-windows every lane list present on `source` through `transform` and drops
 * lanes left without points.
 *
 * @returns Only the kinds that kept at least one lane.
 */
export function transformMidiLaneFields(
  source: Partial<MidiLaneFields>,
  transform: PointsTransform,
): Partial<MidiLaneFields> {
  const out: LaneRecord = {};
  for (const kind of MIDI_LANE_KINDS) {
    const transformed = (source[kind.field] as AnyLane[] | undefined)
      ?.map(
        (lane) =>
          ({
            ...kind.shell(lane),
            points: transform(lane.points as ReadonlyArray<AnyPoint>, kind),
          }) as AnyLane,
      )
      .filter((lane) => lane.points.length > 0);
    if (transformed !== undefined && transformed.length > 0) out[kind.field] = transformed;
  }
  return out as Partial<MidiLaneFields>;
}

/**
 * Writes the non-empty lane lists of `lanes` onto `target` and deletes the
 * field of every kind that has none, so absent and empty stay indistinguishable.
 */
export function assignMidiLaneFields(
  target: Partial<MidiLaneFields>,
  lanes: Partial<MidiLaneFields>,
): void {
  const fields = target as LaneRecord;
  for (const kind of MIDI_LANE_KINDS) {
    const next = lanes[kind.field] as AnyLane[] | undefined;
    if (next !== undefined && next.length > 0) fields[kind.field] = next;
    else delete fields[kind.field];
  }
}
