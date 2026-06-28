/**
 * Reactive automation state for a channel strip: the R/T/L mode, the fader and
 * pan lanes, the read-mode follow flags, the value shown on the fader/knob
 * (write drag > lane follow > strip state) and a factory for touch-record write
 * gestures.
 *
 * This is the lane-following half of a strip's automation behavior; the
 * gesture lifecycle (manual drags and in-flight write gestures) lives in
 * {@link useStripGestures}, which consumes the write refs and factory exposed
 * here. The display computeds keep their original reactive dependencies so a
 * playhead move while following re-evaluates the lane.
 */

import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { linearToDb } from '@/engine/mixer-sync';
import type { AutomationParam } from '@/project/automation';
import { evaluateAutomationValue } from '@/project/automation';
import { setAutomationLanePoints } from '@/project/commands';
import type { MixerStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import {
  type AutomationWriteGesture,
  type AutomationWriteMode,
  automationStripMode,
  createAutomationWriteGesture,
} from '@/ui/mixer/automation-mode';
import { FADER_MAX_DB, FADER_MIN_DB } from '@/ui/mixer/db-scale';

/** Inputs the automation logic reads from the host strip. */
export interface StripAutomationOptions {
  /** Strip target: a track id or 'master'. */
  target: () => number | 'master';
  /** True when the strip is the master output. */
  isMaster: ComputedRef<boolean>;
  /** The backing track (undefined on the master strip). */
  track: ComputedRef<EditorTrack | undefined>;
  /** The strip's mixer state. */
  strip: ComputedRef<MixerStrip>;
  /** Playhead position getter in PPQ (lane follow / touch recording). */
  positionPpq: () => number;
  /** True while the transport runs (continuous touch recording). */
  isPlaying: () => boolean;
}

/** Reactive automation surface a strip binds to its fader, knob and R/T/L row. */
export interface StripAutomation {
  /** Current R/T/L mode of the strip. */
  autoMode: ComputedRef<'off' | 'read' | 'touch' | 'latch'>;
  /** True when the fader display follows the lane (read mode, usable lane). */
  followsFader: ComputedRef<boolean>;
  /** True when the pan display follows the lane (read mode, usable lane). */
  followsPan: ComputedRef<boolean>;
  /** Fader value shown on the throw: write drag > lane follow > strip state. */
  displayedGainDb: ComputedRef<number>;
  /** Pan value shown on the knob: write drag > lane follow > strip state. */
  displayedPan: ComputedRef<number>;
  /** dB offset between the strip fader domain and the engine lane domain. */
  laneOffsetDb: ComputedRef<number>;
  /** Live drag value during a write-mode fader gesture (display only), or null. */
  writeGainDb: Ref<number | null>;
  /** Live drag value during a write-mode pan gesture (display only), or null. */
  writePan: Ref<number | null>;
  /** Starts a touch-record gesture committing into one of this strip's lanes. */
  beginWriteGesture: (param: AutomationParam, mode: AutomationWriteMode) => AutomationWriteGesture;
}

/**
 * Wires a strip's lane-following automation state.
 *
 * @param options Reactive references the logic reads from the host strip.
 */
export function useStripAutomation(options: StripAutomationOptions): StripAutomation {
  const store = useProjectStore();
  const { isMaster, track, strip, positionPpq, isPlaying } = options;

  const autoMode = computed(() => automationStripMode(options.target()));

  /** Finds this strip's lane for a parameter (undefined when absent). */
  function laneFor(param: AutomationParam) {
    return store.automationLanes.find(
      (lane) => lane.target === options.target() && lane.param === param,
    );
  }

  const faderLane = computed(() => laneFor('faderDb'));
  const panLane = computed(() => laneFor('pan'));

  /**
   * dB offset between the strip fader domain and the engine lane fader domain
   * (the engine lane fader is linearToDb(track.volume) + strip.gainDb; the
   * master strip has no track volume term).
   */
  const laneOffsetDb = computed(() => (isMaster.value ? 0 : linearToDb(track.value?.volume ?? 1)));

  /** True when the fader display follows the lane (read mode, usable lane). */
  const followsFader = computed(
    () =>
      autoMode.value === 'read' &&
      faderLane.value !== undefined &&
      faderLane.value.enabled &&
      faderLane.value.points.length > 0,
  );

  /** True when the pan display follows the lane (read mode, usable lane). */
  const followsPan = computed(
    () =>
      autoMode.value === 'read' &&
      panLane.value !== undefined &&
      panLane.value.enabled &&
      panLane.value.points.length > 0,
  );

  /** Live drag value during a write-mode gesture (display only), or null. */
  const writeGainDb = ref<number | null>(null);
  const writePan = ref<number | null>(null);

  /** Fader value shown on the throw: write drag > lane follow > strip state. */
  const displayedGainDb = computed(() => {
    if (writeGainDb.value !== null) return writeGainDb.value;
    const lane = faderLane.value;
    if (followsFader.value && lane) {
      const db = evaluateAutomationValue(lane.points, positionPpq()) - laneOffsetDb.value;
      return Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db));
    }
    return strip.value.gainDb;
  });

  /** Pan value shown on the knob: write drag > lane follow > strip state. */
  const displayedPan = computed(() => {
    if (writePan.value !== null) return writePan.value;
    const lane = panLane.value;
    if (followsPan.value && lane) {
      return Math.min(1, Math.max(-1, evaluateAutomationValue(lane.points, positionPpq())));
    }
    return strip.value.pan;
  });

  /** Starts a touch-record gesture committing into one of this strip's lanes. */
  function beginWriteGesture(
    param: AutomationParam,
    mode: AutomationWriteMode,
  ): AutomationWriteGesture {
    return createAutomationWriteGesture({
      mode,
      existingPoints: laneFor(param)?.points ?? [],
      positionPpq,
      isPlaying,
      commit: (points) => setAutomationLanePoints(options.target(), param, points),
    });
  }

  return {
    autoMode,
    followsFader,
    followsPan,
    displayedGainDb,
    displayedPan,
    laneOffsetDb,
    writeGainDb,
    writePan,
    beginWriteGesture,
  };
}
