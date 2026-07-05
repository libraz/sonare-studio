/**
 * Expression-curve data for the piano-roll bottom lane: the active clip's CC,
 * pitch-bend, channel-pressure and poly-pressure breakpoints derived from the
 * store for the current lane mode, the commit helpers that write them back
 * through the project commands, and the grid-aware horizontal snap shared by
 * every breakpoint lane.
 *
 * Reactivity is preserved: the lane-mode refs and store are read inside
 * computeds, so switching the lane or editing the clip re-evaluates the points.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import {
  setClipCcLane,
  setClipChannelPressure,
  setClipPitchBend,
  setClipPolyPressure,
  setClipPolyPressureForPitches,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { ClipCcPoint, ClipPitchBendPoint, ClipPressurePoint } from '@/project/types';
import type { PianoRollLanes } from './use-piano-roll-lanes';

/** Reactive curve data and commits returned by {@link usePianoRollCcLanes}. */
export interface PianoRollCcLanes {
  /**
   * Pitch the poly-pressure lane targets: the single selected note's pitch, or
   * null when zero or several notes are selected (per-key pressure needs one).
   */
  polyPressurePitch: ComputedRef<number | null>;
  /** Unique pitches targeted by the poly-pressure lane, derived from selected notes. */
  polyPressurePitches: ComputedRef<number[]>;
  /** Breakpoints of the active clip's selected CC lane on the lane channel (empty when none). */
  activeCcPoints: ComputedRef<ClipCcPoint[]>;
  /** Breakpoints of the active clip's pitch-bend lane on the lane channel (empty when none). */
  activePitchBendPoints: ComputedRef<ClipPitchBendPoint[]>;
  /** Breakpoints of the active clip's channel-pressure lane on the lane channel (empty when none). */
  activeChannelPressurePoints: ComputedRef<ClipPressurePoint[]>;
  /** Breakpoints of the selected note's poly-pressure lane on the lane channel (empty when none). */
  activePolyPressurePoints: ComputedRef<ClipPressurePoint[]>;
  /** Commits a CC lane edit for the active controller on the lane channel. */
  commitCcPoints(points: ClipCcPoint[]): void;
  /** Commits a pitch-bend lane edit on the lane channel. */
  commitPitchBendPoints(points: ClipPitchBendPoint[]): void;
  /** Commits a channel-pressure lane edit on the lane channel. */
  commitChannelPressurePoints(points: ClipPressurePoint[]): void;
  /** Commits a poly-pressure lane edit for the selected note's pitch on the lane channel. */
  commitPolyPressurePoints(points: ClipPressurePoint[]): void;
  /** Horizontal snap for lane points, following the grid when snapping is on. */
  ccSnap(ppq: number): number;
}

/** Configuration for {@link usePianoRollCcLanes}. */
export interface UsePianoRollCcLanesOptions {
  /** Bottom-lane mode state (which expression curve, if any, is active). */
  lanes: PianoRollLanes;
  /** Current snap grid step in PPQ (the configured division). */
  gridPpq: Ref<number>;
}

/**
 * Creates the expression-curve data and commits for one piano-roll editor.
 *
 * @param options - Lane-mode state and the grid step.
 * @returns Reactive curve point computeds plus their commit helpers.
 */
export function usePianoRollCcLanes(options: UsePianoRollCcLanesOptions): PianoRollCcLanes {
  const { lanes, gridPpq } = options;
  const store = useProjectStore();

  const polyPressurePitches = computed<number[]>(() => {
    const pitches = [...store.selection]
      .map((id) => store.notes.find((n) => n.id === id)?.pitch)
      .filter((pitch): pitch is number => pitch !== undefined);
    return [...new Set(pitches)].sort((a, b) => a - b);
  });

  const polyPressurePitch = computed<number | null>(() => polyPressurePitches.value[0] ?? null);

  const activeCcPoints = computed<ClipCcPoint[]>(() => {
    if (lanes.laneCc.value === null) return [];
    const lane = store.activeClip?.ccLanes?.find(
      (l) => l.controller === lanes.laneCc.value && l.channel === lanes.laneChannel.value,
    );
    return lane?.points ?? [];
  });

  const activePitchBendPoints = computed<ClipPitchBendPoint[]>(() => {
    if (!lanes.lanePitchBend.value) return [];
    const lane = store.activeClip?.pitchBendLanes?.find(
      (l) => l.channel === lanes.laneChannel.value,
    );
    return lane?.points ?? [];
  });

  const activeChannelPressurePoints = computed<ClipPressurePoint[]>(() => {
    if (!lanes.laneChannelPressure.value) return [];
    const lane = store.activeClip?.channelPressureLanes?.find(
      (l) => l.channel === lanes.laneChannel.value,
    );
    return lane?.points ?? [];
  });

  const activePolyPressurePoints = computed<ClipPressurePoint[]>(() => {
    const pitches = polyPressurePitches.value;
    if (!lanes.lanePolyPressure.value || pitches.length === 0) return [];
    const pitchSet = new Set(pitches);
    const lane = store.activeClip?.polyPressureLanes?.find(
      (l) => l.channel === lanes.laneChannel.value && pitchSet.has(l.pitch),
    );
    return lane?.points ?? [];
  });

  function commitCcPoints(points: ClipCcPoint[]): void {
    if (lanes.laneCc.value === null) return;
    setClipCcLane(store.clipId, lanes.laneCc.value, lanes.laneChannel.value, points);
  }

  function commitPitchBendPoints(points: ClipPitchBendPoint[]): void {
    setClipPitchBend(store.clipId, lanes.laneChannel.value, points);
  }

  function commitChannelPressurePoints(points: ClipPressurePoint[]): void {
    setClipChannelPressure(store.clipId, lanes.laneChannel.value, points);
  }

  function commitPolyPressurePoints(points: ClipPressurePoint[]): void {
    const pitches = polyPressurePitches.value;
    if (pitches.length === 0) return;
    if (pitches.length === 1) {
      setClipPolyPressure(store.clipId, lanes.laneChannel.value, pitches[0], points);
      return;
    }
    setClipPolyPressureForPitches(store.clipId, lanes.laneChannel.value, pitches, points);
  }

  function ccSnap(ppq: number): number {
    if (!store.snapEnabled) return ppq;
    const step = gridPpq.value;
    return step > 0 ? Math.round(ppq / step) * step : ppq;
  }

  return {
    polyPressurePitch,
    polyPressurePitches,
    activeCcPoints,
    activePitchBendPoints,
    activeChannelPressurePoints,
    activePolyPressurePoints,
    commitCcPoints,
    commitPitchBendPoints,
    commitChannelPressurePoints,
    commitPolyPressurePoints,
    ccSnap,
  };
}
