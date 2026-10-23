import type { EditorNote, EditorNoteUpdate } from '@/project/types';

const FIELDS = ['pitch', 'velocity', 'startPpq', 'durationPpq', 'channel', 'offVelocity'] as const;

/**
 * Drops the updates that would leave their note unchanged, so a keyboard edit
 * pinned at a boundary commits nothing (no history entry, redo stays intact).
 */
export function changedNoteUpdates(
  notes: ReadonlyArray<EditorNote>,
  updates: ReadonlyArray<EditorNoteUpdate>,
): EditorNoteUpdate[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return updates.filter((update) => {
    const note = byId.get(update.id);
    if (!note) return false;
    return FIELDS.some((field) => update[field] !== undefined && update[field] !== note[field]);
  });
}
