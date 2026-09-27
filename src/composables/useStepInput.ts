import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { preferredNoteChannel } from '@/compose/tracks';
import { addNote } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { meterBarLengthPpq, timeSignatureAt } from '@/project/time-signature';

/** Step-input state and actions returned by {@link useStepInput}. */
export interface StepInputHandle {
  /** True while step input is armed; {@link StepInputHandle.enterNote} only writes when armed. */
  armed: Ref<boolean>;
  /** Cursor position in PPQ where the next entered note will be written. */
  cursorPpq: Ref<number>;
  /** Current grid step in PPQ, derived from the selected numeric grid or active bar. */
  stepPpq: ComputedRef<number>;
  /**
   * Arms step input.
   *
   * @param startPpq Optional cursor position to start from (clamped to >= 0).
   */
  arm(startPpq?: number): void;
  /** Disarms step input; the cursor keeps its position. */
  disarm(): void;
  /** Toggles the armed state. */
  toggle(): void;
  /**
   * Moves the cursor to an absolute position.
   *
   * @param ppq Target position in PPQ (clamped to >= 0).
   */
  setCursor(ppq: number): void;
  /**
   * Writes one note of the current grid-step length at the cursor and
   * advances the cursor by one step. No-op while disarmed.
   *
   * @param pitch MIDI note number (integer, 0-127).
   * @param velocity Note-on velocity (integer, 1-127); omitted = command default.
   * @returns The new editor note id, or null while disarmed.
   */
  enterNote(pitch: number, velocity?: number): number | null;
  /** Advances the cursor one grid step without writing a note (a rest). */
  rest(): void;
  /** Moves the cursor back one grid step (clamped at 0). */
  back(): void;
}

/**
 * Vue composable holding the step-input cursor for the piano roll.
 *
 * While armed, each entered note (from music typing or a MIDI input) is
 * written into the edited clip at the cursor through the project commands
 * (each note = one undoable edit) and the cursor advances by the current
 * grid step. The step tracks the project store's numeric snap division, or
 * the active meter's complete bar while Bar snap is selected.
 *
 * @returns Reactive step-input state and actions.
 */
export function useStepInput(): StepInputHandle {
  const store = useProjectStore();
  const armed = ref(false);
  const cursorPpq = ref(0);

  const stepPpq = computed(() =>
    store.snapBar
      ? meterBarLengthPpq(timeSignatureAt(store.timeSignatures, cursorPpq.value))
      : 4 / store.snapDivision,
  );

  function setCursor(ppq: number): void {
    cursorPpq.value = Math.max(0, ppq);
  }

  function arm(startPpq?: number): void {
    if (startPpq !== undefined) setCursor(startPpq);
    armed.value = true;
  }

  function disarm(): void {
    armed.value = false;
  }

  function toggle(): void {
    armed.value = !armed.value;
  }

  function enterNote(pitch: number, velocity?: number): number | null {
    if (!armed.value) return null;
    const clip = store.activeClip;
    const durationPpq = clip ? Math.min(stepPpq.value, clip.lengthPpq) : stepPpq.value;
    const timelineStart = clip
      ? Math.min(
          Math.max(cursorPpq.value, clip.startPpq),
          clip.startPpq + Math.max(0, clip.lengthPpq - durationPpq),
        )
      : cursorPpq.value;
    const sourceStart = clip ? timelineStart - clip.startPpq + clip.sourceOffsetPpq : timelineStart;
    const trackNotes = store.activeTrack
      ? (store.clipsByTrack.get(store.activeTrack.id) ?? []).flatMap((item) => item.notes)
      : store.notes;
    const channel = preferredNoteChannel(store.activeTrack, trackNotes);
    const id = addNote({
      pitch,
      startPpq: sourceStart,
      durationPpq,
      ...(velocity !== undefined ? { velocity } : {}),
      ...(channel === 0 ? {} : { channel }),
    });
    cursorPpq.value = timelineStart + durationPpq;
    return id;
  }

  function rest(): void {
    cursorPpq.value += stepPpq.value;
  }

  function back(): void {
    cursorPpq.value = Math.max(0, cursorPpq.value - stepPpq.value);
  }

  return { armed, cursorPpq, stepPpq, arm, disarm, toggle, setCursor, enterNote, rest, back };
}
