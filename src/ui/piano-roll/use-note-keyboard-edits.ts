/**
 * Keyboard note editing for the piano roll: virtual-list note actions, plus the
 * root key handler for arrow nudges, alt-arrow duplication and bracket resizes.
 * Every commit goes through the no-op filter so a boundary key press never
 * lands an undo entry.
 */

import type { Ref } from 'vue';
import { changedNoteUpdates } from '@/components/piano-roll/keyboard-note-updates';
import { clampMoveDelta, clampResizedDuration } from '@/components/piano-roll/nudge-bounds';
import { clamp, minOf } from '@/lib/math';
import { addNotes, setSelection, updateNotes } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { adjacentBarDelta, type MeasureRange } from '@/project/time-signature';
import type { EditorNote } from '@/project/types';
import type { AccessibleObjectAdjustment } from '@/ui/accessibility/object-navigation';
import { MAX_PITCH, MIN_PITCH } from '@/ui/canvas/timeline-range';

/** Inputs for {@link useNoteKeyboardEdits}. */
export interface NoteKeyboardEditsOptions {
  /** Editable source notes inside the active clip's audible window. */
  audibleSourceNotes: Readonly<Ref<ReadonlyArray<EditorNote>>>;
  /** True while the active track's content is frozen. */
  contentReadOnly: Readonly<Ref<boolean>>;
  /** Left edge of the editable window in source coordinates. */
  sourceWindowStartPpq: Readonly<Ref<number>>;
  /** Right edge of the editable window in source coordinates. */
  sourceWindowEndPpq: Readonly<Ref<number>>;
  /** Furthest end an edit may reach (infinite while a commit can grow the clip). */
  noteEndLimit: Readonly<Ref<number>>;
  /** Grid step in PPQ. */
  gridPpq: Readonly<Ref<number>>;
  /** Bar containing a piano-roll position. */
  pianoRollMeasureAt: (ppq: number) => MeasureRange;
  /** Pointer-gesture state machine; Escape cancels an in-flight gesture. */
  interactions: { onKeyDown(key: string): boolean };
}

/** Virtual-list note action forwarded by the grid's accessible note list. */
export type NoteKeyboardAction =
  | { noteId: number; kind: 'select' }
  | { noteId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
  | { noteId: number; kind: 'set'; controlId: string; value: number };

/** Keyboard handlers returned by {@link useNoteKeyboardEdits}. */
export interface NoteKeyboardEdits {
  onNoteKeyboardAction(payload: NoteKeyboardAction): void;
  onKeyDown(event: KeyboardEvent): void;
}

/** Creates the keyboard edit handlers for one piano-roll editor. */
export function useNoteKeyboardEdits(options: NoteKeyboardEditsOptions): NoteKeyboardEdits {
  const {
    audibleSourceNotes,
    contentReadOnly,
    sourceWindowStartPpq,
    sourceWindowEndPpq,
    noteEndLimit,
    gridPpq,
    pianoRollMeasureAt,
    interactions,
  } = options;
  const store = useProjectStore();

  /** Commits keyboard note updates, skipping those that change nothing. */
  function applyKeyboardUpdates(updates: Parameters<typeof updateNotes>[0]): void {
    const changed = changedNoteUpdates(audibleSourceNotes.value, updates);
    if (changed.length > 0) updateNotes(changed);
  }

  /** Applies virtual-list note actions through the same selection and undo commands as pointer edits. */
  function onNoteKeyboardAction(payload: NoteKeyboardAction): void {
    const note = audibleSourceNotes.value.find((item) => item.id === payload.noteId);
    if (!note) return;
    setSelection([note.id]);
    if (payload.kind === 'select' || contentReadOnly.value) return;
    const minimum = sourceWindowStartPpq.value;
    const maximum = sourceWindowEndPpq.value;
    if (payload.kind === 'set') {
      if (payload.controlId === 'pitch') {
        applyKeyboardUpdates([
          { id: note.id, pitch: clamp(Math.round(payload.value), MIN_PITCH, MAX_PITCH) },
        ]);
      } else if (payload.controlId === 'start') {
        applyKeyboardUpdates([
          {
            id: note.id,
            startPpq: clamp(payload.value, minimum, maximum - note.durationPpq),
          },
        ]);
      } else if (payload.controlId === 'duration') {
        applyKeyboardUpdates([
          {
            id: note.id,
            durationPpq: Math.min(maximum - note.startPpq, Math.max(0.0625, payload.value)),
          },
        ]);
      } else if (payload.controlId === 'velocity') {
        applyKeyboardUpdates([{ id: note.id, velocity: clamp(Math.round(payload.value), 1, 127) }]);
      }
      return;
    }
    const { direction, resize, coarse } = payload.adjustment;
    const step = Math.max(0.0625, store.snapEnabled ? gridPpq.value : 0.0625) * (coarse ? 4 : 1);
    if (direction === 'up' || direction === 'down') {
      const delta = direction === 'up' ? (coarse ? 12 : 1) : coarse ? -12 : -1;
      applyKeyboardUpdates([
        { id: note.id, pitch: clamp(note.pitch + delta, MIN_PITCH, MAX_PITCH) },
      ]);
      return;
    }
    const delta =
      store.snapEnabled && store.snapBar
        ? adjacentBarDelta(pianoRollMeasureAt, note.startPpq, direction, coarse)
        : direction === 'left'
          ? -step
          : step;
    if (resize) {
      applyKeyboardUpdates([
        { id: note.id, durationPpq: clampResizedDuration(note, delta, maximum) },
      ]);
    } else {
      applyKeyboardUpdates([
        { id: note.id, startPpq: note.startPpq + clampMoveDelta(delta, [note], minimum, maximum) },
      ]);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target !== event.currentTarget &&
      target.closest(
        'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
      )
    ) {
      return;
    }
    // Undo, redo and delete bubble to the global handler, which resolves them through the registry.
    if (contentReadOnly.value) return;
    if (handleKeyboardEdit(event)) return;
    if (event.key === 'Escape' && interactions.onKeyDown(event.key)) event.preventDefault();
  }

  function handleKeyboardEdit(event: KeyboardEvent): boolean {
    const selected = audibleSourceNotes.value.filter((note) => store.selection.has(note.id));
    if (selected.length === 0) return false;
    const step = store.snapEnabled ? gridPpq.value : 0.0625;
    let updates: Parameters<typeof updateNotes>[0] = [];
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowLeft' ? 'left' : 'right';
      const minStart = minOf(selected.map((note) => note.startPpq));
      const requestedDelta =
        store.snapEnabled && store.snapBar
          ? adjacentBarDelta(pianoRollMeasureAt, minStart, direction, event.shiftKey)
          : direction === 'left'
            ? -step
            : step;
      const delta = clampMoveDelta(
        requestedDelta,
        selected,
        sourceWindowStartPpq.value,
        noteEndLimit.value,
      );
      if (event.altKey) {
        if (delta === 0) {
          event.preventDefault();
          return true;
        }
        const ids = addNotes(
          selected.map((note) => ({
            pitch: note.pitch,
            startPpq: note.startPpq + delta,
            durationPpq: note.durationPpq,
            velocity: note.velocity,
            channel: note.channel,
            ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
          })),
        );
        setSelection(ids);
      } else {
        updates = selected.map((note) => ({
          id: note.id,
          startPpq: note.startPpq + delta,
        }));
      }
    } else if (event.key === '[' || event.key === ']') {
      const delta = event.key === '[' ? -step : step;
      updates = selected.map((note) => ({
        id: note.id,
        durationPpq: clampResizedDuration(note, delta, noteEndLimit.value),
      }));
    } else {
      return false;
    }
    event.preventDefault();
    if (updates.length > 0) applyKeyboardUpdates(updates);
    return true;
  }

  return { onNoteKeyboardAction, onKeyDown };
}
