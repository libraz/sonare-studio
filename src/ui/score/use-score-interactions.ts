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

import { scoreSourceIdentitiesFromXmlId } from '@/notation/source-identity';
import type { VerovioTimemapEntry } from '@/notation/verovio';
import { setActiveClip, setSelection } from '@/project/commands';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import type { useProjectStore } from '@/project/store';

/** Selection matching tolerance on the quantized onset grid, in PPQ. */
export const ONSET_MATCH_EPSILON_PPQ = 1e-3;

/** Minimum vertical pointer motion before an annotate drag becomes a staff edit. */
export const STAFF_DRAG_THRESHOLD_PX = 24;

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
  /** Annotate-mode hook invoked when a note is dragged vertically between staves. */
  onAnnotateStaffDrag?: (ids: number[], staff: 1 | 2) => void;
  /** True while the annotate tool is active. */
  isAnnotateEnabled: () => boolean;
}

/** The interaction surface bound by the score panel. */
export interface ScoreInteractions {
  /** Bound to the score body `@click`: seek + select the source notes. */
  onSvgClick: (event: MouseEvent) => void;
  /** Bound to `@pointerdown`: starts an annotate-mode staff drag. */
  onSvgPointerDown: (event: PointerEvent) => void;
  /** Bound to `@pointermove`: tracks an annotate-mode staff drag. */
  onSvgPointerMove: (event: PointerEvent) => void;
  /** Bound to `@pointerup`: commits an annotate-mode staff drag. */
  onSvgPointerUp: (event: PointerEvent) => void;
  /** Bound to `@pointercancel`: aborts an annotate-mode staff drag. */
  onSvgPointerCancel: (event: PointerEvent) => void;
  /** Resolves the editor note ids standing at a quarter-note PPQ position. */
  noteIdsAt: (ppq: number) => number[];
  /** Resolves the editor note ids under an event's engraved-note target. */
  noteIdsAtEvent: (event: Event) => number[];
}

/** Wires click-to-seek / select (and annotate routing) for the score body. */
export function useScoreInteractions(options: ScoreInteractionsOptions): ScoreInteractions {
  const { store } = options;
  let staffDrag:
    | {
        pointerId: number;
        startY: number;
        currentY: number;
        ids: number[];
        clipId?: number;
        dragging: boolean;
      }
    | undefined;
  let suppressNextClick = false;

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
    const notes = store.activeClip ? projectMidiNoteOccurrences(store.activeClip) : store.notes;
    for (const note of notes) {
      const onset = quantizedOnsetPpq(note);
      if (onset !== null && Math.abs(onset - ppq) < ONSET_MATCH_EPSILON_PPQ) exact.push(note.id);
      if (note.startPpq <= ppq && ppq < note.startPpq + note.durationPpq) sounding.push(note.id);
    }
    return exact.length > 0 ? exact : sounding;
  }

  function noteSourceFromEventTarget(
    target: EventTarget | null,
  ): { clipId?: number; ids: number[]; ppq: number } | null {
    if (!(target instanceof Element)) return null;
    const group = target.closest('g.note');
    if (!group?.id) return null;
    const entry = options.getTimemap().find((e) => e.on?.includes(group.id));
    if (!entry) return null;
    const ppq = store.clipStartPpq + entry.qstamp;
    const identities = scoreSourceIdentitiesFromXmlId(group.id);
    const first = identities[0];
    if (first) {
      return {
        clipId: first.clipId,
        ids: identities
          .filter((identity) => identity.clipId === first.clipId)
          .map((identity) => identity.noteId),
        ppq,
      };
    }
    return { ids: noteIdsAt(ppq), ppq };
  }

  /** Click on an engraved note: seek the transport and select the source notes. */
  function onSvgClick(event: MouseEvent): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const source = noteSourceFromEventTarget(event.target);
    if (!source) return;
    if (source.clipId !== undefined && source.clipId !== store.clipId) {
      setActiveClip(source.clipId);
    }
    if (options.isAnnotateEnabled()) options.onAnnotateClick?.(event, source.ids);
    options.seek(source.ppq);
    setSelection(source.ids);
  }

  function onSvgPointerDown(event: PointerEvent): void {
    if (!options.isAnnotateEnabled() || event.button !== 0) return;
    const source = noteSourceFromEventTarget(event.target);
    if (!source || source.ids.length === 0) return;
    staffDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      currentY: event.clientY,
      ids: source.ids,
      clipId: source.clipId,
      dragging: false,
    };
    if (event.currentTarget instanceof Element) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  function onSvgPointerMove(event: PointerEvent): void {
    if (staffDrag === undefined || event.pointerId !== staffDrag.pointerId) return;
    staffDrag.currentY = event.clientY;
    if (Math.abs(staffDrag.currentY - staffDrag.startY) >= STAFF_DRAG_THRESHOLD_PX) {
      staffDrag.dragging = true;
      event.preventDefault();
    }
  }

  function onSvgPointerUp(event: PointerEvent): void {
    if (staffDrag === undefined || event.pointerId !== staffDrag.pointerId) return;
    const drag = staffDrag;
    staffDrag = undefined;
    if (event.currentTarget instanceof Element) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    const deltaY = event.clientY - drag.startY;
    if (!drag.dragging || Math.abs(deltaY) < STAFF_DRAG_THRESHOLD_PX) return;
    if (drag.clipId !== undefined && drag.clipId !== store.clipId) setActiveClip(drag.clipId);
    options.onAnnotateStaffDrag?.(drag.ids, deltaY < 0 ? 1 : 2);
    suppressNextClick = true;
    event.preventDefault();
    event.stopPropagation();
  }

  function onSvgPointerCancel(event: PointerEvent): void {
    if (staffDrag === undefined || event.pointerId !== staffDrag.pointerId) return;
    staffDrag = undefined;
  }

  return {
    onSvgClick,
    onSvgPointerDown,
    onSvgPointerMove,
    onSvgPointerUp,
    onSvgPointerCancel,
    noteIdsAt,
    noteIdsAtEvent: (event: Event) => noteSourceFromEventTarget(event.target)?.ids ?? [],
  };
}
