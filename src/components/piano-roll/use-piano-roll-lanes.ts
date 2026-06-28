/**
 * Bottom-lane mode state for the piano roll: which note parameter or expression
 * curve (CC / pitch-bend / channel-pressure / poly-pressure) the lane below the
 * grid currently edits, plus the selectors that switch between them so a single
 * mode owns the lane at a time.
 *
 * The composable owns only the switch state; the curve data and commits live in
 * use-piano-roll-cc-lanes. State is plain Vue refs so callers keep reactivity.
 */

import { type ComputedRef, computed, type Ref, ref } from 'vue';
import type { LaneParamId } from './lane-params';

/** Reactive lane-mode state and selectors returned by {@link usePianoRollLanes}. */
export interface PianoRollLanes {
  /** Note parameter shown in the bottom lane (tab strip in the lane header). */
  laneParam: Ref<LaneParamId>;
  /**
   * Active CC controller in the bottom lane, or null when a note-parameter lane
   * is shown. When set, the bottom lane edits the active clip's CC breakpoints
   * for this controller instead of per-note values.
   */
  laneCc: Ref<number | null>;
  /** Whether the bottom lane edits the active clip's pitch-bend curve. */
  lanePitchBend: Ref<boolean>;
  /** Whether the bottom lane edits the active clip's channel-pressure curve. */
  laneChannelPressure: Ref<boolean>;
  /** Whether the bottom lane edits the selected note's poly-pressure curve. */
  lanePolyPressure: Ref<boolean>;
  /** True when a note-parameter lane (not an expression lane) is shown. */
  noteLaneActive: ComputedRef<boolean>;
  /** Clears every non-note lane mode so a single mode owns the bottom lane. */
  clearExpressionLanes(): void;
  /** Switches the bottom lane to a note-parameter view. */
  selectNoteLane(id: LaneParamId): void;
  /** Switches the bottom lane to a CC controller view. */
  selectCcLane(controller: number): void;
  /** Switches the bottom lane to the pitch-bend view. */
  selectPitchBendLane(): void;
  /** Switches the bottom lane to the channel-pressure (aftertouch) view. */
  selectChannelPressureLane(): void;
  /** Switches the bottom lane to the poly-pressure (per-key aftertouch) view. */
  selectPolyPressureLane(): void;
}

/**
 * Creates the bottom-lane mode state for one piano-roll editor.
 *
 * @returns Reactive lane-mode refs plus the lane selectors.
 */
export function usePianoRollLanes(): PianoRollLanes {
  const laneParam = ref<LaneParamId>('velocity');
  const laneCc = ref<number | null>(null);
  const lanePitchBend = ref(false);
  const laneChannelPressure = ref(false);
  const lanePolyPressure = ref(false);

  function clearExpressionLanes(): void {
    laneCc.value = null;
    lanePitchBend.value = false;
    laneChannelPressure.value = false;
    lanePolyPressure.value = false;
  }

  function selectNoteLane(id: LaneParamId): void {
    laneParam.value = id;
    clearExpressionLanes();
  }

  function selectCcLane(controller: number): void {
    clearExpressionLanes();
    laneCc.value = controller;
  }

  function selectPitchBendLane(): void {
    clearExpressionLanes();
    lanePitchBend.value = true;
  }

  function selectChannelPressureLane(): void {
    clearExpressionLanes();
    laneChannelPressure.value = true;
  }

  function selectPolyPressureLane(): void {
    clearExpressionLanes();
    lanePolyPressure.value = true;
  }

  const noteLaneActive = computed(
    () =>
      laneCc.value === null &&
      !lanePitchBend.value &&
      !laneChannelPressure.value &&
      !lanePolyPressure.value,
  );

  return {
    laneParam,
    laneCc,
    lanePitchBend,
    laneChannelPressure,
    lanePolyPressure,
    noteLaneActive,
    clearExpressionLanes,
    selectNoteLane,
    selectCcLane,
    selectPitchBendLane,
    selectChannelPressureLane,
    selectPolyPressureLane,
  };
}
