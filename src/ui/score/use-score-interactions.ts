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

import { scoreOnsetResolver } from '@/notation/score-clip-window';
import { scoreSourceIdentitiesFromXmlId } from '@/notation/source-identity';
import type { VerovioTimemapEntry } from '@/notation/verovio';
import { setActiveClip, setSelection } from '@/project/commands';
import { midiTimelinePpqToSource, projectMidiNoteOccurrences } from '@/project/midi-projection';
import type { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';

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
  /** Normal-mode vertical drag writes a semitone delta back to source notes. */
  onNotePitchDrag?: (ids: number[], semitones: number[]) => void;
  /** Double-click insertion target in active-clip source coordinates. */
  onInsertAt?: (sourcePpq: number) => void;
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
  /** Bound to double-click: inserts at the nearest notated onset. */
  onSvgDoubleClick: (event: MouseEvent) => void;
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
   * Quantized onset of each editor note, from the display quantizer's own
   * per-measure grid and window. Returns null for notes outside the window.
   */
  function onsetResolver(): (note: { startPpq: number; durationPpq: number }) => number | null {
    return scoreOnsetResolver(
      {
        clipStartPpq: store.clipStartPpq,
        clipLengthPpq: store.clipLengthPpq,
        pickupLengthPpq: store.pickupLengthPpq,
        timeSignatures: store.timeSignatures,
      },
      options.getDivisionPpq(),
    );
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
    const quantizedOnsetPpq = onsetResolver();
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

  function onSvgDoubleClick(event: MouseEvent): void {
    let nearest: { ppq: number; distance: number } | undefined;
    for (const entry of options.getTimemap()) {
      for (const id of entry.on ?? []) {
        const element = document.getElementById(id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
        if (nearest === undefined || distance < nearest.distance) {
          nearest = { ppq: store.clipStartPpq + entry.qstamp, distance };
        }
      }
    }
    if (nearest === undefined) return;
    const clip = store.activeClip;
    if (!clip || clipKind(clip) !== 'midi') return;
    const sourcePpq = midiTimelinePpqToSource(clip, nearest.ppq);
    if (sourcePpq === null) return;
    options.onInsertAt?.(sourcePpq);
  }

  function onSvgPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
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
    if (options.isAnnotateEnabled()) {
      options.onAnnotateStaffDrag?.(drag.ids, deltaY < 0 ? 1 : 2);
    } else {
      const semitones = Math.round(-deltaY / STAFF_DRAG_THRESHOLD_PX);
      if (semitones !== 0)
        options.onNotePitchDrag?.(
          drag.ids,
          drag.ids.map(() => semitones),
        );
    }
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
    onSvgDoubleClick,
    onSvgPointerDown,
    onSvgPointerMove,
    onSvgPointerUp,
    onSvgPointerCancel,
    noteIdsAt,
    noteIdsAtEvent: (event: Event) => noteSourceFromEventTarget(event.target)?.ids ?? [],
  };
}
