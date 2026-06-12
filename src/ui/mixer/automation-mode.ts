/**
 * Per-strip automation R/W modes and the touch-record write gesture.
 *
 * The mode map is session-only module state (never persisted): channel strips
 * toggle it from their R/W buttons and the app shell drops 'write' modes back
 * to 'read' when the transport stops. The write gesture turns a fader/pan
 * drag into automation breakpoints: while playing it records a throttled
 * point stream, stationary it moves a single breakpoint at the playhead, and
 * gesture end merges the recording over the lane's existing points in one
 * undoable command call (made by the caller-provided commit).
 */

import { reactive } from 'vue';
import type { AutomationPoint } from '@/project/automation';

/** Automation mode of one mixer strip ('off' = no follow, no recording). */
export type AutomationStripMode = 'off' | 'read' | 'write';

/** Minimum playhead advance between recorded points while playing, in PPQ. */
export const AUTOMATION_WRITE_THROTTLE_PPQ = 1 / 16;

/** Replace window around a single recorded breakpoint, in PPQ. */
export const AUTOMATION_WRITE_REPLACE_WINDOW_PPQ = 1 / 32;

/** Session-only mode per strip target; absent entries mean 'off'. */
const modes = reactive(new Map<number | 'master', AutomationStripMode>());

/**
 * Returns the automation mode of a strip.
 *
 * @param target Strip target: a track id or 'master'.
 */
export function automationStripMode(target: number | 'master'): AutomationStripMode {
  return modes.get(target) ?? 'off';
}

/**
 * Toggles a strip's automation mode. Activating one mode deactivates the
 * other (read/write are exclusive); toggling the active mode turns it off.
 *
 * @param target Strip target: a track id or 'master'.
 * @param mode Mode the button represents.
 */
export function toggleAutomationStripMode(target: number | 'master', mode: 'read' | 'write'): void {
  if (modes.get(target) === mode) modes.delete(target);
  else modes.set(target, mode);
}

/**
 * Sets a strip's automation mode directly ('off' clears the entry).
 *
 * @param target Strip target: a track id or 'master'.
 * @param mode New mode.
 */
export function setAutomationStripMode(target: number | 'master', mode: AutomationStripMode): void {
  if (mode === 'off') modes.delete(target);
  else modes.set(target, mode);
}

/** Drops every strip in 'write' mode back to 'read' (transport stop). */
export function disengageAutomationWriteModes(): void {
  for (const [target, mode] of modes) {
    if (mode === 'write') modes.set(target, 'read');
  }
}

/** Clears all strip automation modes (tests). */
export function resetAutomationStripModes(): void {
  modes.clear();
}

/** Dependencies of one automation write (touch-record) gesture. */
export interface AutomationWriteGestureOptions {
  /** Lane points as they were when the gesture started (copied, not held). */
  existingPoints: ReadonlyArray<AutomationPoint>;
  /** Current playhead position in PPQ. */
  positionPpq: () => number;
  /** True while the transport runs (enables continuous recording). */
  isPlaying: () => boolean;
  /** Receives the merged point list once, at gesture end. */
  commit: (points: AutomationPoint[]) => void;
}

/** One in-flight touch-record drag over a single automation lane. */
export interface AutomationWriteGesture {
  /** Records the dragged value (lane domain) at the current playhead. */
  update(value: number): void;
  /** Merges the recording over the existing points and commits once. */
  end(): void;
}

/**
 * Creates a touch-record gesture for one automation lane.
 *
 * While playing, each update records a point at the playhead, throttled to
 * one point per {@link AUTOMATION_WRITE_THROTTLE_PPQ} of playhead advance
 * (a backward jump — loop wrap — always records). Stationary, the gesture
 * keeps a single breakpoint that follows the latest value. `end()` replaces
 * the existing points inside the recorded PPQ span (a single breakpoint uses
 * a ±{@link AUTOMATION_WRITE_REPLACE_WINDOW_PPQ} window) with the recording
 * and hands the merged list to `commit` exactly once; ending without any
 * update commits nothing.
 *
 * @param options Gesture dependencies (see {@link AutomationWriteGestureOptions}).
 */
export function createAutomationWriteGesture(
  options: AutomationWriteGestureOptions,
): AutomationWriteGesture {
  const existing: AutomationPoint[] = options.existingPoints.map((point) => ({ ...point }));
  const recorded: AutomationPoint[] = [];
  /** Latest throttled-away update, flushed into the recording at end(). */
  let pending: AutomationPoint | null = null;
  let done = false;

  return {
    update(value: number): void {
      if (done) return;
      const ppq = Math.max(0, options.positionPpq());
      if (!options.isPlaying()) {
        // Stationary: one breakpoint at the playhead, following the drag.
        recorded.length = 0;
        recorded.push({ ppq, value });
        pending = null;
        return;
      }
      const last = recorded[recorded.length - 1];
      if (!last || ppq < last.ppq || ppq - last.ppq >= AUTOMATION_WRITE_THROTTLE_PPQ) {
        recorded.push({ ppq, value });
        pending = null;
      } else {
        pending = { ppq, value };
      }
    },
    end(): void {
      if (done) return;
      done = true;
      if (pending) {
        const last = recorded[recorded.length - 1];
        if (last && pending.ppq <= last.ppq) last.value = pending.value;
        else recorded.push(pending);
      }
      if (recorded.length === 0) return;
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const point of recorded) {
        lo = Math.min(lo, point.ppq);
        hi = Math.max(hi, point.ppq);
      }
      if (recorded.length === 1) {
        lo -= AUTOMATION_WRITE_REPLACE_WINDOW_PPQ;
        hi += AUTOMATION_WRITE_REPLACE_WINDOW_PPQ;
      }
      const merged = existing.filter((point) => point.ppq < lo || point.ppq > hi).concat(recorded);
      options.commit(merged);
    },
  };
}
