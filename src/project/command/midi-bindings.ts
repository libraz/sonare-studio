import type { MidiCcBinding } from '../midi-learn-targets';
import { useProjectStore } from '../store';
import { executeApp } from './history';

/**
 * Binds (or rebinds) a MIDI-learn target to a CC source as one undoable edit.
 * The binding map persists with the document, so routing the change through the
 * command layer marks the project dirty, schedules an autosave and makes the
 * binding reversible.
 *
 * @param id Target id (mixer strip or quick control) the controller drives.
 * @param binding MIDI channel + controller to capture for that target.
 *   No-op (and no history entry) when the target is already bound to it.
 */
export function setMidiCcBinding(id: string, binding: MidiCcBinding): void {
  const bindings = useProjectStore().midiCcBindings;
  const current = bindings.get(id);
  if (
    current !== undefined &&
    current.channel === binding.channel &&
    current.controller === binding.controller &&
    current.kind === binding.kind &&
    current.parameter === binding.parameter
  ) {
    return;
  }
  executeApp(() => {
    bindings.set(id, { ...binding });
  });
}

/**
 * Removes a single MIDI-learn binding as one undoable edit. No-op (and no
 * history entry) when the target was not bound.
 *
 * @param id Target id whose binding is removed.
 * @returns True when a binding existed and was removed.
 */
export function clearMidiCcBinding(id: string): boolean {
  const bindings = useProjectStore().midiCcBindings;
  if (!bindings.has(id)) return false;
  executeApp(() => {
    bindings.delete(id);
  });
  return true;
}

/**
 * Removes every MIDI-learn binding as one undoable edit, so an accidental
 * clear-all can be reverted. No-op when there are no bindings.
 *
 * @returns True when at least one binding was removed.
 */
export function clearAllMidiCcBindings(): boolean {
  const bindings = useProjectStore().midiCcBindings;
  if (bindings.size === 0) return false;
  executeApp(() => {
    bindings.clear();
  });
  return true;
}
