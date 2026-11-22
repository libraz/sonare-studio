import { onBeforeUnmount } from 'vue';

/**
 * Dismissal timing shared by the hosts of the hover theory card (score body and
 * note grid).
 *
 * The card floats a few px off the pointer, so reaching the ⓘ affordance inside
 * it means crossing pixels that no longer hit the note — and landing on the
 * button takes the hit target off the host surface, which fires its
 * `pointerleave`. Dismissing on either signal immediately would make the
 * affordance unreachable, so a dismissal is deferred by a short grace period and
 * cancelled as soon as the pointer arrives on the note again or on the ⓘ.
 */

/** Grace period between a dismissal request and the card closing, in ms. */
const DISMISS_GRACE_MS = 260;

export interface TheoryCardHold {
  /** Cancels a pending dismissal: the pointer owns the card again. */
  keep(): void;
  /** Requests a dismissal once the grace period elapses. */
  release(): void;
  /** Dismisses the card now; for surfaces that a gesture or mode has taken over. */
  dismiss(): void;
  /** Handler for the card's `hold` event: the ⓘ has, or lost, the pointer/focus. */
  onHold(held: boolean): void;
}

/**
 * Wires the grace period around a host's own `dismiss` action. Must be called
 * during component setup — it clears any pending timer on unmount.
 */
export function useTheoryCardHold(dismiss: () => void): TheoryCardHold {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** True while the ⓘ has the pointer or focus: the card cannot be dismissed. */
  let held = false;

  function keep(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  // An already pending dismissal keeps its deadline, so a pointer wandering the
  // surface cannot push the card's lifetime out indefinitely.
  function release(): void {
    if (held || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      dismiss();
    }, DISMISS_GRACE_MS);
  }

  function dismissNow(): void {
    held = false;
    keep();
    dismiss();
  }

  function onHold(next: boolean): void {
    held = next;
    if (next) keep();
    else release();
  }

  onBeforeUnmount(keep);

  return { keep, release, dismiss: dismissNow, onHold };
}
