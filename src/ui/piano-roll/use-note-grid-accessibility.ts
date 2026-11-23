/**
 * Screen-reader surface of the note grid: the polite live status describing
 * the selection, and the virtual note objects the accessible navigator edits.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { maxOf, minOf } from '@/lib/math';
import type { EditorNote } from '@/project/types';
import type {
  AccessibleObjectAdjustment,
  AccessibleObjectItem,
} from '@/ui/accessibility/object-navigation';
import { MAX_PITCH, MIN_PITCH } from '@/ui/canvas/timeline-range';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { NoteInteractions } from './use-note-interactions';

/** Configuration for {@link useNoteGridAccessibility}. */
export interface UseNoteGridAccessibilityOptions {
  /** Grid props: notes, selection, edit bounds and the gesture state. */
  props: {
    readonly notes: EditorNote[];
    readonly selection: Set<number>;
    readonly gridPpq: number;
    readonly clipLengthPpq: number;
    readonly minPpq?: number;
    readonly interactions: NoteInteractions;
  };
  /** Grid emit for the edits and menus the navigator routes. */
  emit: {
    (
      event: 'note-context',
      payload: { x: number; y: number; noteId: number | null; ppq: number },
    ): void;
    (
      event: 'note-keyboard-action',
      payload:
        | { noteId: number; kind: 'select' }
        | { noteId: number; kind: 'adjust'; adjustment: AccessibleObjectAdjustment }
        | { noteId: number; kind: 'set'; controlId: string; value: number },
    ): void;
  };
  /** Grid root element a navigator context menu is anchored to. */
  wrapper: Ref<HTMLDivElement | null>;
}

/** Live status and navigator bindings returned by {@link useNoteGridAccessibility}. */
export interface NoteGridAccessibility {
  /** Spoken description of the current selection. */
  liveStatus: ComputedRef<string>;
  /** Navigator items, one per note, in time order. */
  accessibleNotes: ComputedRef<AccessibleObjectItem[]>;
  /** Selects the activated note. */
  onAccessibleNoteActivate(id: string): void;
  /** Opens the note context menu for a navigator item. */
  onAccessibleNoteContext(id: string): void;
  /** Routes a stepped control adjustment. */
  onAccessibleNoteAdjust(adjustment: AccessibleObjectAdjustment): void;
  /** Routes a typed control value. */
  onAccessibleNoteValue(payload: { id: string; controlId: string; value: number }): void;
}

/**
 * Creates the accessible selection status and note navigator of one note grid.
 *
 * @param options - The grid props, emit and root element.
 * @returns The live status, navigator items and their handlers.
 */
export function useNoteGridAccessibility(
  options: UseNoteGridAccessibilityOptions,
): NoteGridAccessibility {
  const { props, emit, wrapper } = options;
  const { t } = useI18n();
  const { formatPitch } = useNoteNames();

  const selectedNotes = computed(() => props.notes.filter((note) => props.selection.has(note.id)));

  const liveStatus = computed(() => {
    const selected = selectedNotes.value;
    const parts: string[] = [];
    if (selected.length === 0) {
      parts.push(t.value.shell.pianoRoll.accessibility.noNotesSelected);
    } else if (selected.length === 1) {
      const note = selected[0];
      parts.push(
        formatMessage(t.value.shell.pianoRoll.accessibility.noteSelected, {
          pitch: formatPitch(note.pitch),
          start: note.startPpq.toFixed(2),
          duration: note.durationPpq.toFixed(2),
        }),
      );
    } else {
      const low = minOf(selected.map((note) => note.pitch));
      const high = maxOf(selected.map((note) => note.pitch));
      parts.push(
        formatMessage(t.value.shell.pianoRoll.accessibility.notesSelected, {
          count: selected.length,
          low: formatPitch(low),
          high: formatPitch(high),
        }),
      );
    }
    return parts.join('. ');
  });

  /** Sorted navigator items without selection state, so a selection change reuses them. */
  const accessibleNoteBases = computed<
    Array<{ noteId: number; item: Omit<AccessibleObjectItem, 'selected'> }>
  >(() => {
    const minimumPpq = props.minPpq ?? 0;
    const step = Math.max(0.0625, props.gridPpq);
    return [...props.notes]
      .sort((a, b) => a.startPpq - b.startPpq || b.pitch - a.pitch || a.id - b.id)
      .map((note) => ({
        noteId: note.id,
        item: {
          id: `note-${note.id}`,
          label: formatMessage(t.value.shell.pianoRoll.accessibility.note, {
            pitch: formatPitch(note.pitch),
            start: note.startPpq.toFixed(2),
            length: note.durationPpq.toFixed(2),
            velocity: note.velocity,
          }),
          controls: [
            {
              id: 'pitch',
              label: t.value.shell.pianoRoll.accessibility.pitch,
              min: MIN_PITCH,
              max: MAX_PITCH,
              step: 1,
              value: note.pitch,
              valueText: formatPitch(note.pitch),
            },
            {
              id: 'start',
              label: t.value.shell.pianoRoll.accessibility.start,
              min: minimumPpq,
              max: Math.max(minimumPpq, props.clipLengthPpq - note.durationPpq),
              step,
              value: note.startPpq,
              valueText: formatMessage(t.value.shell.pianoRoll.accessibility.ppqValue, {
                value: note.startPpq.toFixed(2),
              }),
            },
            {
              id: 'duration',
              label: t.value.shell.pianoRoll.accessibility.duration,
              min: 0.0625,
              max: Math.max(0.0625, props.clipLengthPpq - note.startPpq),
              step,
              value: note.durationPpq,
              valueText: formatMessage(t.value.shell.pianoRoll.accessibility.ppqValue, {
                value: note.durationPpq.toFixed(2),
              }),
            },
            {
              id: 'velocity',
              label: t.value.shell.pianoRoll.accessibility.velocity,
              min: 1,
              max: 127,
              step: 1,
              value: note.velocity,
            },
          ],
        },
      }));
  });

  const accessibleNotes = computed<AccessibleObjectItem[]>(() =>
    accessibleNoteBases.value.map(({ noteId, item }) => ({
      ...item,
      selected: props.selection.has(noteId),
    })),
  );

  function noteForAccessibleId(id: string): EditorNote | undefined {
    const noteId = Number(id.replace(/^note-/, ''));
    return props.notes.find((note) => note.id === noteId);
  }

  function onAccessibleNoteActivate(id: string): void {
    const note = noteForAccessibleId(id);
    if (!note) return;
    props.interactions.cancel();
    emit('note-keyboard-action', { noteId: note.id, kind: 'select' });
  }

  function onAccessibleNoteContext(id: string): void {
    const note = noteForAccessibleId(id);
    if (!note) return;
    const rect = wrapper.value?.getBoundingClientRect();
    emit('note-context', {
      x: (rect?.left ?? 0) + 24,
      y: (rect?.top ?? 0) + 48,
      noteId: note.id,
      ppq: note.startPpq + note.durationPpq / 2,
    });
  }

  function onAccessibleNoteAdjust(adjustment: AccessibleObjectAdjustment): void {
    const note = noteForAccessibleId(adjustment.id);
    if (note) emit('note-keyboard-action', { noteId: note.id, kind: 'adjust', adjustment });
  }

  function onAccessibleNoteValue(payload: { id: string; controlId: string; value: number }): void {
    const note = noteForAccessibleId(payload.id);
    if (note) emit('note-keyboard-action', { noteId: note.id, kind: 'set', ...payload });
  }

  return {
    liveStatus,
    accessibleNotes,
    onAccessibleNoteActivate,
    onAccessibleNoteContext,
    onAccessibleNoteAdjust,
    onAccessibleNoteValue,
  };
}
