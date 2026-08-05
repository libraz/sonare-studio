import type { EditorNote } from './types';

/** One repeating timing-offset template, measured from a straight grid. */
export interface GrooveTemplate {
  gridPpq: number;
  offsetsPpq: number[];
}

/** Extracts average onset offsets for each step of one grid-sized bar. */
export function extractGrooveTemplate(
  notes: ReadonlyArray<Pick<EditorNote, 'startPpq'>>,
  gridPpq: number,
  steps = 16,
): GrooveTemplate {
  const sums = new Array<number>(steps).fill(0);
  const counts = new Array<number>(steps).fill(0);
  for (const note of notes) {
    const raw = note.startPpq / gridPpq;
    const nearest = Math.round(raw);
    const index = ((nearest % steps) + steps) % steps;
    sums[index] += note.startPpq - nearest * gridPpq;
    counts[index] += 1;
  }
  return {
    gridPpq,
    offsetsPpq: sums.map((sum, index) => (counts[index] === 0 ? 0 : sum / counts[index])),
  };
}

/** Applies a repeating groove to note starts, preserving durations and pitches. */
export function applyGrooveTemplate(
  notes: ReadonlyArray<EditorNote>,
  groove: GrooveTemplate,
  strength = 1,
): EditorNote[] {
  const amount = Math.min(1, Math.max(0, strength));
  if (!(groove.gridPpq > 0) || groove.offsetsPpq.length === 0 || amount === 0)
    return notes.map((n) => ({ ...n }));
  return notes.map((note) => {
    const step = Math.round(note.startPpq / groove.gridPpq);
    const offset =
      groove.offsetsPpq[
        ((step % groove.offsetsPpq.length) + groove.offsetsPpq.length) % groove.offsetsPpq.length
      ] ?? 0;
    return { ...note, startPpq: Math.max(0, note.startPpq + offset * amount) };
  });
}
