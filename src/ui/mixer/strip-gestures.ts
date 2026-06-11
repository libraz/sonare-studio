/**
 * Gesture controllers binding continuous mixer-control drags to the
 * coalescing command layer.
 *
 * The commands in src/project/commands.ts collapse a sequence of calls with
 * `{ commit: false }` plus one final committing call into a single undo
 * entry. These controllers enforce that protocol: every intermediate update
 * passes `commit: false`, ending the gesture commits the last value, and
 * cancelling commits the initial value back (closing the pending entry).
 */

import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { setInsertParam, setStripGain, setStripPan } from '@/project/commands';

/** Applies one gesture value to its command (commit flag per call). */
export type GestureApply = (value: number, options: CommandGestureOptions) => void;

/** One in-flight drag gesture over a single continuous value. */
export interface ValueGesture {
  /** True between the first update and end/cancel. */
  readonly active: boolean;
  /** Applies an intermediate value (one coalesced undo entry per gesture). */
  update(value: number): void;
  /** Commits the gesture; omitting the value commits the last seen one. */
  end(value?: number): void;
  /** Aborts the gesture: commits the initial value back. */
  cancel(): void;
}

/**
 * Creates a gesture controller over an apply function.
 *
 * @param apply Receives every value with the proper commit flag.
 * @param initialValue Value before the gesture (restored by cancel).
 */
export function createValueGesture(apply: GestureApply, initialValue: number): ValueGesture {
  let active = false;
  let last = initialValue;
  return {
    get active(): boolean {
      return active;
    },
    update(value: number): void {
      active = true;
      last = value;
      apply(value, { commit: false });
    },
    end(value?: number): void {
      const final = value ?? last;
      active = false;
      last = final;
      apply(final, { commit: true });
    },
    cancel(): void {
      if (!active) return;
      active = false;
      last = initialValue;
      apply(initialValue, { commit: true });
    },
  };
}

/** Injectable command surface (defaults to the real command layer). */
export interface StripGestureCommands {
  setStripGain: typeof setStripGain;
  setStripPan: typeof setStripPan;
  setInsertParam: typeof setInsertParam;
}

/** The real command layer (default dependency). */
const defaultCommands: StripGestureCommands = { setStripGain, setStripPan, setInsertParam };

/**
 * Gesture controller for a strip gain fader drag.
 *
 * @param target Track id or 'master'.
 * @param initialDb Gain before the drag.
 * @param commands Injectable command layer (tests).
 */
export function gainGesture(
  target: MixerStripTarget,
  initialDb: number,
  commands: StripGestureCommands = defaultCommands,
): ValueGesture {
  return createValueGesture((db, options) => commands.setStripGain(target, db, options), initialDb);
}

/**
 * Gesture controller for a strip pan knob drag.
 *
 * @param target Track id or 'master'.
 * @param initialPan Pan before the drag.
 * @param commands Injectable command layer (tests).
 */
export function panGesture(
  target: MixerStripTarget,
  initialPan: number,
  commands: StripGestureCommands = defaultCommands,
): ValueGesture {
  return createValueGesture(
    (pan, options) => commands.setStripPan(target, pan, options),
    initialPan,
  );
}

/**
 * Gesture controller for an insert parameter knob drag.
 *
 * @param target Track id or 'master'.
 * @param index Insert slot index on the strip.
 * @param param Parameter name (camelCase).
 * @param initialValue Parameter value before the drag.
 * @param commands Injectable command layer (tests).
 */
export function insertParamGesture(
  target: MixerStripTarget,
  index: number,
  param: string,
  initialValue: number,
  commands: StripGestureCommands = defaultCommands,
): ValueGesture {
  return createValueGesture(
    (value, options) => commands.setInsertParam(target, index, param, value, options),
    initialValue,
  );
}
