/**
 * Fader and pan drag handling for a channel strip, including the in-flight
 * gesture lifecycle.
 *
 * Each handler receives the control's `(value, commit)` stream. In a manual
 * (non-write) mode a drag drives the coalescing gain/pan command gesture; in a
 * write mode (touch/latch) the same drag feeds a touch-record automation
 * gesture from {@link useStripAutomation} and updates its display ref instead.
 *
 * The composable owns every gesture object so it can clean them up exactly as
 * the strip did inline: {@link StripGestures.cleanup} cancels any in-flight
 * manual gesture (committing the initial value back, closing the pending undo
 * entry) and ends any in-flight write gesture (committing its recorded points).
 * The host must call it from `onBeforeUnmount`.
 */

import type { ComputedRef, Ref } from 'vue';
import type { MixerStrip } from '@/project/mixer';
import {
  type AutomationWriteGesture,
  type AutomationWriteMode,
  isAutomationWriteMode,
} from '@/ui/mixer/automation-mode';
import { gainGesture, panGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';

/** Automation pieces the gesture handlers branch on (from useStripAutomation). */
export interface StripGestureAutomation {
  /** Current R/T/L mode of the strip. */
  autoMode: ComputedRef<'off' | 'read' | 'touch' | 'latch'>;
  /** dB offset between the strip fader domain and the engine lane domain. */
  laneOffsetDb: ComputedRef<number>;
  /** Track-volume contribution included in a displayed static fader value. */
  stripGainOffsetDb: ComputedRef<number>;
  /** Live drag value during a write-mode fader gesture (display only). */
  writeGainDb: Ref<number | null>;
  /** Live drag value during a write-mode pan gesture (display only). */
  writePan: Ref<number | null>;
  /** Starts a touch-record gesture for one of the strip's lanes. */
  beginWriteGesture: (
    param: 'faderDb' | 'pan',
    mode: AutomationWriteMode,
  ) => AutomationWriteGesture;
}

/** Inputs the gesture handlers read from the host strip. */
export interface StripGestureOptions {
  /** Strip target: a track id or 'master'. */
  target: () => number | 'master';
  /** The strip's mixer state (read for each gesture's initial value). */
  strip: ComputedRef<MixerStrip>;
  /** Automation surface the handlers branch on in write modes. */
  automation: StripGestureAutomation;
}

/** Fader/pan change handlers plus the unmount cleanup for in-flight gestures. */
export interface StripGestures {
  /** Bound to the fader's `@change="(db, commit) => ..."`. */
  onGainChange: (db: number, commit: boolean) => void;
  /** Bound to the pan knob's `@change="(pan, commit) => ..."`. */
  onPanChange: (pan: number, commit: boolean) => void;
  /** Closes any in-flight gesture; call from the host's `onBeforeUnmount`. */
  cleanup: () => void;
}

/**
 * Wires a strip's fader and pan drag handling.
 *
 * @param options Target, strip state and the automation surface to branch on.
 */
export function useStripGestures(options: StripGestureOptions): StripGestures {
  const { strip, automation } = options;

  let activeGainGesture: ValueGesture | null = null;
  let activePanGesture: ValueGesture | null = null;
  let writeFaderGesture: AutomationWriteGesture | null = null;
  let writePanGesture: AutomationWriteGesture | null = null;

  /** Converts the displayed static fader value back to persisted strip trim. */
  const stripGainDbForDisplay = (db: number): number => db - automation.stripGainOffsetDb.value;

  function onGainChange(db: number, commit: boolean): void {
    if (isAutomationWriteMode(automation.autoMode.value)) {
      // Touch recording: the drag writes lane breakpoints (in the engine lane
      // dB domain) instead of the manual strip command, which a lane overrides.
      if (!writeFaderGesture) {
        writeFaderGesture = automation.beginWriteGesture('faderDb', automation.autoMode.value);
      }
      writeFaderGesture.update(automation.laneOffsetDb.value + db);
      automation.writeGainDb.value = db;
      if (commit) {
        writeFaderGesture.end();
        writeFaderGesture = null;
        automation.writeGainDb.value = null;
      }
      return;
    }
    if (!commit) {
      if (!activeGainGesture) activeGainGesture = gainGesture(options.target(), strip.value.gainDb);
      activeGainGesture.update(stripGainDbForDisplay(db));
      return;
    }
    if (activeGainGesture) activeGainGesture.end(stripGainDbForDisplay(db));
    else gainGesture(options.target(), strip.value.gainDb).end(stripGainDbForDisplay(db));
    activeGainGesture = null;
  }

  function onPanChange(pan: number, commit: boolean): void {
    if (isAutomationWriteMode(automation.autoMode.value)) {
      if (!writePanGesture) {
        writePanGesture = automation.beginWriteGesture('pan', automation.autoMode.value);
      }
      writePanGesture.update(pan);
      automation.writePan.value = pan;
      if (commit) {
        writePanGesture.end();
        writePanGesture = null;
        automation.writePan.value = null;
      }
      return;
    }
    if (!commit) {
      if (!activePanGesture) activePanGesture = panGesture(options.target(), strip.value.pan);
      activePanGesture.update(pan);
      return;
    }
    if (activePanGesture) activePanGesture.end(pan);
    else panGesture(options.target(), strip.value.pan).end(pan);
    activePanGesture = null;
  }

  function cleanup(): void {
    // Close any in-flight gesture so the pending history entry is committed.
    activeGainGesture?.cancel();
    activePanGesture?.cancel();
    // Commit any in-flight touch recording so its points are not lost.
    writeFaderGesture?.end();
    writePanGesture?.end();
  }

  return { onGainChange, onPanChange, cleanup };
}
