/**
 * Fit-to-content view commands for the piano roll: fit the time axis to the
 * clip, all notes or the selection, and the pitch axis to the notes fitted.
 */

import type { Ref } from 'vue';
import { maxOf, minOf } from '@/lib/math';
import { audibleMidiSourceWindow } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import type { EditorNote } from '@/project/types';
import { MAX_PITCH, MIN_PITCH, type TimelineRange } from '@/ui/canvas/timeline-range';
import { centerRangeOnPitch } from '@/ui/piano-roll/use-piano-roll-viewport';
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT } from '@/ui/piano-roll/use-piano-roll-zoom';

/** Inputs for {@link usePianoRollFit}. */
export interface PianoRollFitOptions {
  /** Shared timeline range being fitted. */
  range: TimelineRange;
  /** Requests a repaint after the range changed. */
  bump: () => void;
  /** Editable source notes inside the active clip's audible window. */
  audibleSourceNotes: Readonly<Ref<ReadonlyArray<EditorNote>>>;
}

/** Fit commands returned by {@link usePianoRollFit}. */
export interface PianoRollFit {
  fitClip(): void;
  fitNotes(): void;
  fitSelection(): void;
}

/** Creates the fit commands for one piano-roll editor. */
export function usePianoRollFit(options: PianoRollFitOptions): PianoRollFit {
  const { range, bump, audibleSourceNotes } = options;
  const store = useProjectStore();

  function fitTimeToSpan(startPpq: number, endPpq: number): void {
    const width = Math.max(1, range.widthPx);
    const paddedStart = Math.max(0, startPpq - 0.5);
    const paddedEnd = Math.max(paddedStart + 0.25, endPpq + 0.5);
    const targetPxPerPpq = width / (paddedEnd - paddedStart);
    range.zoomAt(0, targetPxPerPpq / range.pxPerPpq);
    range.setStartPpq(paddedStart);
    bump();
  }

  function fitPitchToNotes(notes: ReadonlyArray<{ pitch: number }>): void {
    if (notes.length === 0 || range.heightPx <= 0) return;
    let minPitch = MAX_PITCH;
    let maxPitch = MIN_PITCH;
    for (const note of notes) {
      minPitch = Math.min(minPitch, note.pitch);
      maxPitch = Math.max(maxPitch, note.pitch);
    }
    const span = Math.max(1, maxPitch - minPitch + 1);
    const rowHeight = Math.min(
      MAX_ROW_HEIGHT,
      Math.max(MIN_ROW_HEIGHT, (range.heightPx - 16) / (span + 2)),
    );
    range.setRowHeight(rowHeight);
    centerRangeOnPitch(range, (minPitch + maxPitch) / 2);
  }

  function fitClip(): void {
    const clip = store.activeClip;
    const window = clip ? audibleMidiSourceWindow(clip) : null;
    fitTimeToSpan(window?.startPpq ?? 0, window?.endPpq ?? store.clipLengthPpq);
  }

  function fitNotes(): void {
    if (audibleSourceNotes.value.length === 0) {
      fitClip();
      return;
    }
    const endPpq = maxOf(audibleSourceNotes.value.map((note) => note.startPpq + note.durationPpq));
    const startPpq = minOf(audibleSourceNotes.value.map((note) => note.startPpq));
    fitTimeToSpan(startPpq, endPpq);
    fitPitchToNotes(audibleSourceNotes.value);
    bump();
  }

  function fitSelection(): void {
    const selected = audibleSourceNotes.value.filter((note) => store.selection.has(note.id));
    if (selected.length === 0) {
      fitNotes();
      return;
    }
    const endPpq = maxOf(selected.map((note) => note.startPpq + note.durationPpq));
    const startPpq = minOf(selected.map((note) => note.startPpq));
    fitTimeToSpan(startPpq, endPpq);
    fitPitchToNotes(selected);
    bump();
  }

  return { fitClip, fitNotes, fitSelection };
}
