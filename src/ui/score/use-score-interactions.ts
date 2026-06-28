/**
 * Click-to-seek / select behavior for the engraved score.
 *
 * A click on an engraved note is resolved through the Verovio timemap to a
 * quarter-note position, then back to the editor notes it stands for: primarily
 * notes whose quantized onset matches the position, falling back to notes whose
 * raw interval contains it (e.g. the tail of a tie chain). The transport is
 * seeked there and the source notes are selected.
 *
 * The annotate tool layers on top: when active, the resolved ids are handed to
 * the injected `onAnnotateClick` before the seek/select still runs.
 */

import type { VerovioTimemapEntry } from '@/notation/verovio';
import { setSelection } from '@/project/commands';
import type { useProjectStore } from '@/project/store';

/** Selection matching tolerance on the quantized onset grid, in PPQ. */
export const ONSET_MATCH_EPSILON_PPQ = 1e-3;

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Options wiring the interactions to the store, grid and transport. */
export interface ScoreInteractionsOptions {
  /** The project store (clip window and notes). */
  store: ProjectStore;
  /** Reads the loaded score's timemap (paired with the current SVG's ids). */
  getTimemap: () => ReadonlyArray<VerovioTimemapEntry>;
  /** Current Display Quantize grid step in PPQ. */
  getDivisionPpq: () => number;
  /** Requests a transport seek to an absolute PPQ position. */
  seek: (ppq: number) => void;
  /** Annotate-mode hook invoked with the resolved note ids before seek/select. */
  onAnnotateClick?: (event: MouseEvent, ids: number[]) => void;
  /** True while the annotate tool is active. */
  isAnnotateEnabled: () => boolean;
}

/** The interaction surface bound by the score panel. */
export interface ScoreInteractions {
  /** Bound to the score body `@click`: seek + select the source notes. */
  onSvgClick: (event: MouseEvent) => void;
  /** Resolves the editor note ids standing at a quarter-note PPQ position. */
  noteIdsAt: (ppq: number) => number[];
}

/** Wires click-to-seek / select (and annotate routing) for the score body. */
export function useScoreInteractions(options: ScoreInteractionsOptions): ScoreInteractions {
  const { store } = options;

  /**
   * Quantized onset of an editor note, mirroring the display quantizer's grid
   * rounding (nearest grid step anchored at the clip start, clamped into the
   * clip window). Returns null for notes outside the notated window.
   */
  function quantizedOnsetPpq(note: { startPpq: number; durationPpq: number }): number | null {
    const clipStart = store.clipStartPpq;
    const clipEnd = clipStart + store.clipLengthPpq;
    if (note.startPpq + note.durationPpq <= clipStart || note.startPpq >= clipEnd) return null;
    const grid = options.getDivisionPpq();
    const snapped = clipStart + Math.round((note.startPpq - clipStart) / grid) * grid;
    return Math.min(Math.max(snapped, clipStart), clipEnd - grid);
  }

  /**
   * Resolves the editor notes a clicked score note stands for: primarily notes
   * whose quantized onset matches the note's qstamp; when none match (e.g. the
   * tail of a tie chain), notes whose raw interval contains the position.
   */
  function noteIdsAt(ppq: number): number[] {
    const exact: number[] = [];
    const sounding: number[] = [];
    for (const note of store.notes) {
      const onset = quantizedOnsetPpq(note);
      if (onset !== null && Math.abs(onset - ppq) < ONSET_MATCH_EPSILON_PPQ) exact.push(note.id);
      if (note.startPpq <= ppq && ppq < note.startPpq + note.durationPpq) sounding.push(note.id);
    }
    return exact.length > 0 ? exact : sounding;
  }

  /** Click on an engraved note: seek the transport and select the source notes. */
  function onSvgClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const group = target.closest('g.note');
    if (!group?.id) return;
    const entry = options.getTimemap().find((e) => e.on?.includes(group.id));
    if (!entry) return;
    const ppq = store.clipStartPpq + entry.qstamp;
    const ids = noteIdsAt(ppq);
    if (options.isAnnotateEnabled()) options.onAnnotateClick?.(event, ids);
    options.seek(ppq);
    setSelection(ids);
  }

  return { onSvgClick, noteIdsAt };
}
