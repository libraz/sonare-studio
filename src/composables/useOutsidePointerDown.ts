import { onScopeDispose, type WatchSource, watch } from 'vue';

/**
 * True for a node inside an open SelectMenu list. The list is teleported to
 * `<body>` above the surface that opened it, so a press there is never outside.
 */
export function isInsideSelectList(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return element?.closest('[data-select-list]') != null;
}

/**
 * Calls `onOutside` for a capture-phase pointerdown outside the elements
 * `contains` accepts and outside any open SelectMenu list, listening only while
 * `isOpen` is true.
 */
export function useOutsidePointerDown(
  isOpen: WatchSource<boolean>,
  contains: (target: Node) => boolean,
  onOutside: (event: PointerEvent) => void,
): void {
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && (contains(target) || isInsideSelectList(target))) return;
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
