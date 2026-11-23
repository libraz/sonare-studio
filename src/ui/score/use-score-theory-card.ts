/**
 * Hover theory card of the score panel: the card resolved for the engraved
 * note under the pointer, the hold that lets it outlive the hover, and its
 * position next to the pointer that picked it up.
 */

import { type Ref, ref, watch } from 'vue';
import type { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import type { TheoryCard } from '@/compose/explain';
import type { useProjectStore } from '@/project/store';
import { useTheoryCardHold } from '@/ui/compose/use-theory-card-hold';
import type { useScoreInteractions } from '@/ui/score/use-score-interactions';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Offset of the hover card from the pointer that picked its note up, in px. */
export const CARD_POINTER_OFFSET_PX = 12;

/** Configuration for {@link useScoreTheoryCard}. */
export interface UseScoreTheoryCardOptions {
  /** The project store (chords re-read the card). */
  store: ProjectStore;
  /** Composition guidance that resolves the card of a note. */
  guidance: ReturnType<typeof useCompositionGuidance>;
  /** Click/drag state of the score body. */
  interactions: ReturnType<typeof useScoreInteractions>;
  /** Score body element whose parent wrapper the card position is relative to. */
  svgHost: Ref<HTMLDivElement | null>;
  /** True while the Annotate tool is active; the card stays hidden then. */
  isAnnotateEnabled: () => boolean;
}

/**
 * Creates the hover theory-card state of one score panel.
 *
 * @param options - The store, guidance, interactions and score body element.
 * @returns The card, its position and hold, and the score-body pointer handlers.
 */
export function useScoreTheoryCard(options: UseScoreTheoryCardOptions) {
  const { store, guidance, interactions, svgHost, isAnnotateEnabled } = options;

  /** Theory card for the note under the pointer, or null when none is hovered. */
  const hoverCard = ref<TheoryCard | null>(null);
  /** Note whose card is currently resolved, avoiding repeated theory work on pointermove. */
  const hoverCardNoteId = ref<number | null>(null);
  /** Position of the hover card within the score body wrap, in px. */
  const hoverCardPos = ref({ x: 0, y: 0 });

  const cardHold = useTheoryCardHold(() => {
    hoverCardNoteId.value = null;
    hoverCard.value = null;
  });

  // Chord edits and Undo can change the reading of a note while the pointer
  // stays still. Refresh the visible card without waiting for another hover.
  watch(
    [() => store.chords, () => (hoverCardNoteId.value === null ? null : guidance.noteCard.value)],
    () => {
      const noteId = hoverCardNoteId.value;
      if (noteId !== null) hoverCard.value = guidance.noteCard.value?.(noteId) ?? null;
    },
  );

  /**
   * Combined score-body pointer move: forwards to the annotate staff-drag tracker
   * and, outside annotate mode, resolves the theory card for the hovered note.
   * The card is pinned where its note was picked up — one that follows the pointer
   * can never be aimed at, so its ⓘ affordance would be out of reach.
   */
  function onScorePointerMove(event: PointerEvent): void {
    interactions.onSvgPointerMove(event);
    if (isAnnotateEnabled()) {
      cardHold.dismiss();
      return;
    }
    const resolve = guidance.noteCard.value;
    const ids = resolve ? interactions.noteIdsAtEvent(event) : [];
    const noteId = ids[0] ?? null;
    if (noteId === null || !resolve) {
      cardHold.release();
      return;
    }
    cardHold.keep();
    if (noteId === hoverCardNoteId.value) return;
    hoverCardNoteId.value = noteId;
    hoverCard.value = resolve(noteId);
    if (hoverCard.value === null) return;
    const rect = svgHost.value?.parentElement?.getBoundingClientRect();
    hoverCardPos.value = {
      x: event.clientX - (rect?.left ?? 0) + CARD_POINTER_OFFSET_PX,
      y: event.clientY - (rect?.top ?? 0) + CARD_POINTER_OFFSET_PX,
    };
  }

  /**
   * Starts the theory card's dismissal when the pointer leaves the score body.
   * The card sits outside the body, so reaching its ⓘ leaves the body too — the
   * grace period is what lets the pointer get there.
   */
  function onScorePointerLeave(): void {
    cardHold.release();
  }

  return { hoverCard, hoverCardPos, cardHold, onScorePointerMove, onScorePointerLeave };
}
