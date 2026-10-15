import { onScopeDispose, type WatchSource, watch } from 'vue';

/**
 * Calls `onOutside` for a capture-phase pointerdown outside the elements
 * `contains` accepts, listening only while `isOpen` is true.
 */
export function useOutsidePointerDown(
  isOpen: WatchSource<boolean>,
  contains: (target: Node) => boolean,
  onOutside: (event: PointerEvent) => void,
): void {
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && contains(target)) return;
    onOutside(event);
  };
  const detach = (): void => window.removeEventListener('pointerdown', onPointerDown, true);
  watch(
    isOpen,
    (open) => {
      detach();
      if (open) window.addEventListener('pointerdown', onPointerDown, true);
    },
    { immediate: true },
  );
  onScopeDispose(detach);
}
