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
  /** Breakpoints of the active clip's selected CC lane (empty when none). */
  activeCcPoints: ComputedRef<ClipCcPoint[]>;
  /** Breakpoints of the active clip's pitch-bend lane on channel 0 (empty when none). */
  activePitchBendPoints: ComputedRef<ClipPitchBendPoint[]>;
  /** Breakpoints of the active clip's channel-pressure lane on channel 0 (empty when none). */
  activeChannelPressurePoints: ComputedRef<ClipPressurePoint[]>;
  /** Breakpoints of the selected note's poly-pressure lane on channel 0 (empty when none). */
  activePolyPressurePoints: ComputedRef<ClipPressurePoint[]>;
  /** Commits a CC lane edit for the active controller on channel 0. */
  commitCcPoints(points: ClipCcPoint[]): void;
  /** Commits a pitch-bend lane edit on channel 0. */
  commitPitchBendPoints(points: ClipPitchBendPoint[]): void;
  /** Commits a channel-pressure lane edit on channel 0. */
  commitChannelPressurePoints(points: ClipPressurePoint[]): void;
  /** Commits a poly-pressure lane edit for the selected note's pitch on channel 0. */
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

  const polyPressurePitch = computed<number | null>(() => {
    if (store.selection.size !== 1) return null;
    const [id] = store.selection;
    return store.notes.find((n) => n.id === id)?.pitch ?? null;
  });

  const activeCcPoints = computed<ClipCcPoint[]>(() => {
    if (lanes.laneCc.value === null) return [];
    const lane = store.activeClip?.ccLanes?.find((l) => l.controller === lanes.laneCc.value);
    return lane?.points ?? [];
  });

  const activePitchBendPoints = computed<ClipPitchBendPoint[]>(() => {
    if (!lanes.lanePitchBend.value) return [];
    const lane = store.activeClip?.pitchBendLanes?.find((l) => l.channel === 0);
    return lane?.points ?? [];
  });

  const activeChannelPressurePoints = computed<ClipPressurePoint[]>(() => {
    if (!lanes.laneChannelPressure.value) return [];
    const lane = store.activeClip?.channelPressureLanes?.find((l) => l.channel === 0);
    return lane?.points ?? [];
  });

  const activePolyPressurePoints = computed<ClipPressurePoint[]>(() => {
    const pitch = polyPressurePitch.value;
    if (!lanes.lanePolyPressure.value || pitch === null) return [];
    const lane = store.activeClip?.polyPressureLanes?.find(
      (l) => l.channel === 0 && l.pitch === pitch,
    );
    return lane?.points ?? [];
  });

  function commitCcPoints(points: ClipCcPoint[]): void {
    if (lanes.laneCc.value === null) return;
    setClipCcLane(store.clipId, lanes.laneCc.value, 0, points);
  }

  function commitPitchBendPoints(points: ClipPitchBendPoint[]): void {
    setClipPitchBend(store.clipId, 0, points);
  }

  function commitChannelPressurePoints(points: ClipPressurePoint[]): void {
    setClipChannelPressure(store.clipId, 0, points);
  }

  function commitPolyPressurePoints(points: ClipPressurePoint[]): void {
    const pitch = polyPressurePitch.value;
    if (pitch === null) return;
    setClipPolyPressure(store.clipId, 0, pitch, points);
  }

  function ccSnap(ppq: number): number {
    if (!store.snapEnabled) return ppq;
    const step = gridPpq.value;
    return step > 0 ? Math.round(ppq / step) * step : ppq;
  }

  return {
    polyPressurePitch,
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
