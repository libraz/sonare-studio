import type { Ref } from 'vue';
import { getCurrentScope, onScopeDispose, reactive, ref } from 'vue';
import { type MixerStripTarget, setStripGain, setStripPan } from '@/project/commands';
import {
  ccToGainDb,
  ccToPan,
  type MidiCcBinding,
  type MidiCcMessage,
  type MidiLearnParam,
  type MidiLearnScope,
  midiLearnTargetId,
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
  /**
   * Handles an incoming CC: binds it to the armed target, or applies it to
   * every target bound to that channel + controller.
   */
  handleCc(message: MidiCcMessage): void;
}

/**
 * App-level MIDI CC "learn": maps hardware controllers to mixer strip gain/pan
 * and drives them through the real mixer commands so a moved knob is audible
 * through the engine in realtime. Bindings are session state (not persisted),
 * so a stale track id can never silently mis-route after a reload.
 *
 * Rapid CC streams are coalesced: each value is applied immediately as an
 * uncommitted gesture, and a single undo entry is committed once the stream
 * goes idle. A binding whose track no longer exists is dropped on first use.
 *
 * @returns Reactive MIDI-learn state and arm/clear/handle controls.
 */
export function useMidiLearn(): MidiLearnHandle {
  const bindings = reactive(new Map<string, MidiCcBinding>());
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

  /** Applies a value to the strip command, returning false on a stale target. */
  function dispatch(id: string, value: number, commit: boolean): boolean {
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

  function arm(param: MidiLearnParam, scope: MidiLearnScope): void {
    const id = midiLearnTargetId(param, scope);
    armed.value = armed.value === id ? null : id;
  }

  function cancelArm(): void {
    armed.value = null;
  }

  function clear(param: MidiLearnParam, scope: MidiLearnScope): void {
    const id = midiLearnTargetId(param, scope);
    clearTimer(id);
    bindings.delete(id);
    if (armed.value === id) armed.value = null;
  }

  function clearAll(): void {
    for (const id of commitTimers.keys()) clearTimer(id);
    bindings.clear();
    armed.value = null;
  }

  function isArmed(param: MidiLearnParam, scope: MidiLearnScope): boolean {
    return armed.value === midiLearnTargetId(param, scope);
  }

  function bindingFor(param: MidiLearnParam, scope: MidiLearnScope): MidiCcBinding | undefined {
    return bindings.get(midiLearnTargetId(param, scope));
  }

  function handleCc(message: MidiCcMessage): void {
    if (armed.value !== null) {
      const id = armed.value;
      armed.value = null;
      bindings.set(id, { channel: message.channel, controller: message.controller });
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
    handleCc,
  };
}
