import type { InjectionKey, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref } from 'vue';
import {
  clearAllMidiCcBindings,
  clearMidiCcBinding,
  type MixerStripTarget,
  setMidiCcBinding,
  setStripGain,
  setStripPan,
} from '@/project/commands';
import {
  listQuickControls,
  type QuickControlTarget,
  setQuickControl,
} from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import {
  ccToGainDb,
  ccToPan,
  ccToRange,
  type MidiCcBinding,
  type MidiCcMessage,
  type MidiLearnParam,
  type MidiLearnScope,
  midiLearnTargetId,
  parseMidiLearnInsertTargetId,
  parseMidiLearnInstrumentTargetId,
  parseMidiLearnTargetId,
} from '@/ui/midi/midi-learn';

/**
 * Idle gap after the last CC before a binding's coalesced gesture is committed
 * as one undo entry. A continuous controller sweep stays a single history step.
 */
const COMMIT_DELAY_MS = 250;

/** Reactive MIDI-learn state and controls returned by {@link useMidiLearn}. */
export interface MidiLearnHandle {
  /** Live bindings keyed by target id (reactive). */
  bindings: Map<string, MidiCcBinding>;
  /** Target id currently waiting to capture the next CC, or null. */
  armed: Ref<string | null>;
  /** Arms a target so the next incoming CC binds to it (toggles off if re-armed). */
  arm(param: MidiLearnParam, scope: MidiLearnScope): void;
  /** Cancels any pending arm without binding. */
  cancelArm(): void;
  /** Removes a target's binding (and any pending commit). */
  clear(param: MidiLearnParam, scope: MidiLearnScope): void;
  /** Removes every binding. */
  clearAll(): void;
  /** True when this target is the one waiting to capture a CC. */
  isArmed(param: MidiLearnParam, scope: MidiLearnScope): boolean;
  /** Returns a target's binding, or undefined when unbound. */
  bindingFor(param: MidiLearnParam, scope: MidiLearnScope): MidiCcBinding | undefined;
  /** Arms an arbitrary target id (toggles off if already armed). */
  armId(id: string): void;
  /** Removes the binding (and pending commit) of an arbitrary target id. */
  clearId(id: string): void;
  /** True when the given target id is the one waiting to capture a CC. */
  isArmedId(id: string): boolean;
  /** Returns the binding of an arbitrary target id, or undefined when unbound. */
  bindingForId(id: string): MidiCcBinding | undefined;
  /**
   * Handles an incoming CC: binds it to the armed target, or applies it to
   * every target bound to that channel + controller.
   */
  handleCc(message: MidiCcMessage): void;
}

/** Injection key sharing the app's single MIDI-learn handle with descendants. */
export const MIDI_LEARN_KEY: InjectionKey<MidiLearnHandle> = Symbol('midiLearn');

/**
 * App-level MIDI CC "learn": maps hardware controllers to mixer strip gain/pan
 * and instrument/insert quick controls, driving them through the real commands
 * so a moved knob is audible through the engine in realtime. Bindings live in
 * the project store and persist with the document; because target ids are
 * stable within a project, a restored binding always drives the same target,
 * and a binding whose target no longer exists is dropped on first use.
 *
 * Rapid CC streams are coalesced: each value is applied immediately as an
 * uncommitted gesture, and a single undo entry is committed once the stream
 * goes idle.
 *
 * @returns Reactive MIDI-learn state and arm/clear/handle controls.
 */
export function useMidiLearn(): MidiLearnHandle {
  // Bindings are the store's persisted map (stable identity across loads); arm
  // state and pending-commit timers are transient session state.
  const bindings = useProjectStore().midiCcBindings as Map<string, MidiCcBinding>;
  const armed = ref<string | null>(null);
  const commitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cancels a target's pending commit timer, if any. */
  function clearTimer(id: string): void {
    const timer = commitTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      commitTimers.delete(id);
    }
  }

  /** Resolves a target id to the quick-control device + param it drives. */
  function quickControlOf(id: string): { target: QuickControlTarget; paramId: string } | null {
    const insert = parseMidiLearnInsertTargetId(id);
    if (insert) {
      return {
        target: { type: 'insert', trackId: insert.scope, index: insert.index },
        paramId: insert.paramId,
      };
    }
    const instrument = parseMidiLearnInstrumentTargetId(id);
    if (instrument) {
      return {
        target: { type: 'instrument', trackId: instrument.trackId },
        paramId: instrument.paramId,
      };
    }
    return null;
  }

  /**
   * Applies a CC value to an instrument/insert quick control, mapping it across
   * the control's range. Returns false when the device or parameter is gone
   * (the caller drops the stale binding).
   */
  function dispatchQuickControl(
    target: QuickControlTarget,
    paramId: string,
    value: number,
    commit: boolean,
  ): boolean {
    try {
      const control = listQuickControls(target).find((c) => c.id === paramId);
      if (!control) return false;
      setQuickControl(target, paramId, ccToRange(value, control.min, control.max), { commit });
      return true;
    } catch {
      // Stale binding (e.g. the device/track was removed): drop it.
      return false;
    }
  }

  /** Applies a value to the bound command, returning false on a stale target. */
  function dispatch(id: string, value: number, commit: boolean): boolean {
    const quickControl = quickControlOf(id);
    if (quickControl) {
      return dispatchQuickControl(quickControl.target, quickControl.paramId, value, commit);
    }
    const target = parseMidiLearnTargetId(id);
    if (!target) return false;
    const strip: MixerStripTarget = target.scope;
    try {
      if (target.param === 'gain') setStripGain(strip, ccToGainDb(value), { commit });
      else setStripPan(strip, ccToPan(value), { commit });
      return true;
    } catch {
      // Stale binding (e.g. the track was removed): drop it.
      return false;
    }
  }

  /** Applies a CC value to a bound target, coalescing the gesture's commit. */
  function apply(id: string, value: number): void {
    if (!dispatch(id, value, false)) {
      clearTimer(id);
      bindings.delete(id);
      return;
    }
    clearTimer(id);
    commitTimers.set(
      id,
      setTimeout(() => {
        commitTimers.delete(id);
        dispatch(id, value, true);
      }, COMMIT_DELAY_MS),
    );
  }

  function armId(id: string): void {
    armed.value = armed.value === id ? null : id;
  }

  function arm(param: MidiLearnParam, scope: MidiLearnScope): void {
    armId(midiLearnTargetId(param, scope));
  }

  function cancelArm(): void {
    armed.value = null;
  }

  function clearId(id: string): void {
    clearTimer(id);
    clearMidiCcBinding(id);
    if (armed.value === id) armed.value = null;
  }

  function clear(param: MidiLearnParam, scope: MidiLearnScope): void {
    clearId(midiLearnTargetId(param, scope));
  }

  function clearAll(): void {
    for (const id of commitTimers.keys()) clearTimer(id);
    clearAllMidiCcBindings();
    armed.value = null;
  }

  function isArmedId(id: string): boolean {
    return armed.value === id;
  }

  function isArmed(param: MidiLearnParam, scope: MidiLearnScope): boolean {
    return isArmedId(midiLearnTargetId(param, scope));
  }

  function bindingForId(id: string): MidiCcBinding | undefined {
    return bindings.get(id);
  }

  function bindingFor(param: MidiLearnParam, scope: MidiLearnScope): MidiCcBinding | undefined {
    return bindingForId(midiLearnTargetId(param, scope));
  }

  function handleCc(message: MidiCcMessage): void {
    if (armed.value !== null) {
      const id = armed.value;
      armed.value = null;
      setMidiCcBinding(id, { channel: message.channel, controller: message.controller });
      apply(id, message.value);
      return;
    }
    for (const [id, binding] of bindings) {
      if (binding.controller === message.controller && binding.channel === message.channel) {
        apply(id, message.value);
      }
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const id of commitTimers.keys()) clearTimer(id);
    });
  }

  return {
    bindings,
    armed,
    arm,
    cancelArm,
    clear,
    clearAll,
    isArmed,
    bindingFor,
    armId,
    clearId,
    isArmedId,
    bindingForId,
    handleCc,
  };
}
