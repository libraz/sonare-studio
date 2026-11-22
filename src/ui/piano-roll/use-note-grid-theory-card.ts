/**
 * Hover theory card of the note grid: the card resolved for the editable note
 * under the pointer, the hold that lets it outlive the hover, and its
 * fixed-viewport position next to the note it was picked up on.
 */

import { type ComputedRef, computed, type Ref, ref, watch } from 'vue';
import type { GhostNote } from '@/components/piano-roll/overlay';
import type { TheoryCard } from '@/compose/explain';
import type { EditorNote } from '@/project/types';
import { type TheoryCardHold, useTheoryCardHold } from '@/ui/compose/use-theory-card-hold';
import type { InteractionPoint, NoteInteractions } from './use-note-interactions';

/** Configuration for {@link useNoteGridTheoryCard}. */
export interface UseNoteGridTheoryCardOptions {
  /** Grid props: the card resolver, the gesture state and the note mirror. */
  props: {
    readonly noteCard?: (noteId: number) => TheoryCard | null;
    readonly interactions: NoteInteractions;
    readonly notes: EditorNote[];
  };
  /** Grid root element the pinned card point is relative to. */
  wrapper: Ref<HTMLDivElement | null>;
  /** Ghost note under the pointer; suppresses the card. */
  hoveredGhost: Ref<GhostNote | null>;
  /** Editable note under the pointer during a passive hover. */
  hoveredNote: Ref<EditorNote | null>;
}

/** Theory-card state returned by {@link useNoteGridTheoryCard}. */
export interface NoteGridTheoryCard {
  /** Theory card of the hovered note; state, so it can outlive the hover itself. */
  hoveredCard: Ref<TheoryCard | null>;
  /** Grace-period hold that keeps the card up while the pointer reaches it. */
  cardHold: TheoryCardHold;
  /** Resolves the card for the note under the pointer. */
  updateTheoryCard(point: InteractionPoint): void;
  /** Fixed-viewport position of the card, or null when there is none. */
  theoryCardStyle: ComputedRef<Record<string, string> | null>;
}

/**
 * Creates the hover theory-card state of one note grid.
 *
 * @param options - The grid props, root element and hover state.
 * @returns The card, its hold, the hover resolver and the card position.
 */
export function useNoteGridTheoryCard(options: UseNoteGridTheoryCardOptions): NoteGridTheoryCard {
  const { props, wrapper, hoveredGhost, hoveredNote } = options;

  /** Offset of the hover theory card from the pointer, in px. */
  const CARD_POINTER_OFFSET_PX = 14;
  /** Assumed card extent used to keep it inside the viewport (and to flip near edges). */
  const CARD_ESTIMATED_WIDTH_PX = 230;
  const CARD_ESTIMATED_HEIGHT_PX = 150;

  /** Theory card of the hovered note; state, so it can outlive the hover itself. */
  const hoveredCard = ref<TheoryCard | null>(null);
  /** Note the shown card was resolved for. */
  const cardNoteId = ref<number | null>(null);
  /** Local grid point the shown card is pinned at. */
  const cardPoint = ref<InteractionPoint | null>(null);

  const cardHold = useTheoryCardHold(() => {
    hoveredCard.value = null;
    cardNoteId.value = null;
    cardPoint.value = null;
  });

  /**
   * Resolves the theory card for the note under the pointer through the `noteCard`
   * prop. The card is pinned where its note was picked up — one that follows the
   * pointer can never be aimed at, so its ⓘ affordance would stay out of reach —
   * and it survives a moment off the note so that affordance can be reached.
   * Suppressed while a ghost is hovered or a gesture readout is showing, matching
   * the canvas hover HUD.
   */
  function updateTheoryCard(point: InteractionPoint): void {
    if (hoveredGhost.value || (props.interactions.gestureReadout?.value ?? null)) {
      cardHold.dismiss();
      return;
    }
    const resolve = props.noteCard;
    const note = hoveredNote.value;
    if (!resolve || !note) {
      cardHold.release();
      return;
    }
    cardHold.keep();
    if (note.id === cardNoteId.value) return;
    cardNoteId.value = note.id;
    hoveredCard.value = resolve(note.id);
    cardPoint.value = point;
  }

  /** Re-resolves the pinned card when chord/key guidance changes under it. */
  function refreshTheoryCard(): void {
    const resolve = props.noteCard;
    if (!resolve) {
      if (hoveredCard.value !== null) cardHold.dismiss();
      return;
    }
    const note =
      hoveredNote.value ??
      (cardNoteId.value === null
        ? undefined
        : props.notes.find((entry) => entry.id === cardNoteId.value));
    if (!note) return;
    const next = resolve(note.id);
    if (next === null) {
      cardHold.dismiss();
      return;
    }
    cardHold.keep();
    cardNoteId.value = note.id;
    hoveredCard.value = next;
  }

  watch(() => props.noteCard, refreshTheoryCard, { flush: 'sync' });

  /**
   * Fixed-viewport position of the hover theory card. The card is teleported to
   * the document body (so a lower-stacking bottom panel can never cover it and the
   * grid's `overflow: hidden` can never clip it), so its coordinates are the grid
   * rect plus the pinned local point. It flips to the opposite side of that point
   * near the right/bottom viewport edges and is clamped fully on screen.
   */
  const theoryCardStyle = computed<Record<string, string> | null>(() => {
    const point = cardPoint.value;
    const el = wrapper.value;
    if (!point || !el) return null;
    const rect = el.getBoundingClientRect();
    const px = rect.left + point.x;
    const py = rect.top + point.y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = px + CARD_POINTER_OFFSET_PX;
    if (left + CARD_ESTIMATED_WIDTH_PX + 4 > vw) {
      left = px - CARD_POINTER_OFFSET_PX - CARD_ESTIMATED_WIDTH_PX;
    }
    left = Math.max(4, Math.min(left, vw - CARD_ESTIMATED_WIDTH_PX - 4));
    let top = py + CARD_POINTER_OFFSET_PX;
    if (top + CARD_ESTIMATED_HEIGHT_PX + 4 > vh) {
      top = py - CARD_POINTER_OFFSET_PX - CARD_ESTIMATED_HEIGHT_PX;
    }
    top = Math.max(4, Math.min(top, vh - CARD_ESTIMATED_HEIGHT_PX - 4));
    return {
      left: `${left}px`,
      top: `${top}px`,
      '--theory-card-reach': `${CARD_POINTER_OFFSET_PX}px`,
    };
  });

  return { hoveredCard, cardHold, updateTheoryCard, theoryCardStyle };
}
