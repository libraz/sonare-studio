/**
 * Per-strip automation R/T/L modes and the touch-record write gesture.
 *
 * The mode map is session-only UI state. Channel strips toggle their R/T/L
 * buttons and the app shell drops the write-class
 * modes (touch/latch) back to `read` when the transport stops. A write gesture
 * turns a fader/pan drag into automation breakpoints: while playing it records
 * a throttled point stream, stationary it moves a single breakpoint at the
 * playhead, and gesture end merges the recording into the lane's existing
 * points in one undoable command call (made by the caller-provided commit).
 *
 * The two write-class modes differ only in how the recording is merged on
 * release: 'touch' replaces just the touched span and reads the existing
 * automation back on either side, while 'latch' replaces the touched span and
 * everything after it, so the last recorded value latches (holds) to the end
 * of the lane.
 */

import { reactive, ref } from 'vue';
import type { AutomationPoint, AutomationTarget } from '@/project/automation';

/**
 * Automation mode of one mixer strip ('off' = no follow, no recording;
 * 'read' = follow the lane; 'touch'/'latch' = record drags, see the module
 * doc for the release difference).
 */
export type AutomationStripMode = 'off' | 'read' | 'touch' | 'latch';

/** Write-class modes that record a drag (as opposed to 'off'/'read'). */
export type AutomationWriteMode = 'touch' | 'latch';

/** Minimum playhead advance between recorded points while playing, in PPQ. */
export const AUTOMATION_WRITE_THROTTLE_PPQ = 1 / 16;

/** Replace window around a single recorded breakpoint, in PPQ. */
export const AUTOMATION_WRITE_REPLACE_WINDOW_PPQ = 1 / 32;

/** True when a mode records drags (touch or latch). */
export function isAutomationWriteMode(mode: AutomationStripMode): mode is AutomationWriteMode {
  return mode === 'touch' || mode === 'latch';
}

/** Session-only mode per strip target; absent entries mean UI-off. */
const modes = reactive(new Map<AutomationTarget, AutomationStripMode>());
const revision = ref(0);

/** Monotonic token that changes whenever any strip automation mode changes. */
export function automationStripModeRevision(): number {
  return revision.value;
}

/**
 * Returns the automation mode of a strip.
 *
 * @param target Strip target: a track id, 'master', or a mixer bus target.
 */
export function automationStripMode(target: AutomationTarget): AutomationStripMode {
  return modes.get(target) ?? 'off';
}

/**
 * Whether a persisted lane may be sent to playback. An absent UI mode is a
 * safe read default after loading; only an explicit off suppresses playback.
 */
export function isAutomationStripPlaybackEnabled(target: AutomationTarget): boolean {
  return modes.get(target) !== 'off';
}

/**
 * Toggles a strip's automation mode. Activating one mode deactivates the
 * others (read/touch/latch are mutually exclusive); toggling the active mode
 * turns it off.
 *
 * @param target Strip target: a track id, 'master', or a mixer bus target.
 * @param mode Mode the button represents.
 */
export function toggleAutomationStripMode(
  target: AutomationTarget,
  mode: 'read' | AutomationWriteMode,
): void {
  if (modes.get(target) === mode) modes.set(target, 'off');
  else modes.set(target, mode);
  revision.value += 1;
}

/**
 * Sets a strip's automation mode directly.
 *
 * @param target Strip target: a track id, 'master', or a mixer bus target.
 * @param mode New mode.
 */
export function setAutomationStripMode(target: AutomationTarget, mode: AutomationStripMode): void {
  const current = automationStripMode(target);
  if (current === mode) return;
  modes.set(target, mode);
  revision.value += 1;
}

/** Drops every strip in a write-class mode back to 'read' (transport stop). */
export function disengageAutomationWriteModes(): void {
  let changed = false;
  for (const [target, mode] of modes) {
    if (isAutomationWriteMode(mode)) {
      modes.set(target, 'read');
      changed = true;
    }
  }
  if (changed) revision.value += 1;
}

/** Clears all strip automation modes (tests). */
export function resetAutomationStripModes(): void {
  if (modes.size > 0) revision.value += 1;
  modes.clear();
}

/** Dependencies of one automation write (touch-record) gesture. */
export interface AutomationWriteScheduleEvent {
  /** Current playhead position in PPQ. */
  ppq: number;
  /** Current playhead position in samples, when the caller can provide it. */
  samplePos?: number;
  /** Dragged value in the lane's parameter domain. */
  value: number;
}

/** Dependencies of one automation write (touch-record) gesture. */
export interface AutomationWriteGestureOptions {
  /** Write-class mode that controls the release merge (touch vs latch). */
  mode: AutomationWriteMode;
  /** Lane points as they were when the gesture started (copied, not held). */
  existingPoints: ReadonlyArray<AutomationPoint>;
  /** Current playhead position in PPQ. */
  positionPpq: () => number;
  /** Current playhead sample position, used by future sample-accurate engine scheduling. */
  positionSample?: () => number;
  /** True while the transport runs (enables continuous recording). */
  isPlaying: () => boolean;
  /** Optional realtime scheduling hook; receives every playing drag update. */
  schedule?: (event: AutomationWriteScheduleEvent) => void;
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
 * one point per {@link AUTOMATION_WRITE_THROTTLE_PPQ} of playhead advance.
 * When the playhead jumps backward (loop wrap), the new pass replaces any
 * already-recorded points at or after the wrapped PPQ, so the last pass wins.
 * Stationary, the gesture keeps a single breakpoint that follows the latest
 * value. `end()` merges the recording into the existing points and hands the
 * result to `commit` exactly once; ending without any update commits nothing.
 *
 * The merge depends on the mode: 'touch' replaces only the recorded PPQ span
 * (a single breakpoint uses a ±{@link AUTOMATION_WRITE_REPLACE_WINDOW_PPQ}
 * window) and keeps existing points on either side, so automation reads back
 * after the touched region; 'latch' keeps existing points before the span but
 * drops every point from the span onward, so the last recorded value latches
 * (holds flat) to the end of the lane.
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
      options.schedule?.({
        ppq,
        value,
        ...(options.positionSample !== undefined
          ? { samplePos: Math.max(0, Math.round(options.positionSample())) }
          : {}),
      });
      const last = recorded[recorded.length - 1];
      if (last && ppq < last.ppq) {
        while (recorded.length > 0 && recorded[recorded.length - 1].ppq >= ppq) recorded.pop();
        if (pending && pending.ppq >= ppq) pending = null;
      }
      const nextLast = recorded[recorded.length - 1];
      if (!nextLast || ppq - nextLast.ppq >= AUTOMATION_WRITE_THROTTLE_PPQ) {
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
      // Touch keeps existing points on both sides of the recorded span; latch
      // keeps only those before it, so the last value holds to the lane end.
      const kept =
        options.mode === 'latch'
          ? existing.filter((point) => point.ppq < lo)
          : existing.filter((point) => point.ppq < lo || point.ppq > hi);
      options.commit(kept.concat(recorded));
    },
  };
}
