import type { Ref } from 'vue';
import { isInsideSelectList } from './useOutsidePointerDown';

interface PopoverTarget {
  close: () => void;
  open: Ref<boolean>;
  root: Ref<HTMLElement | null>;
}

function isOutsidePress(root: HTMLElement | null, event: PointerEvent): boolean {
  return (
    root !== null &&
    event.target instanceof Node &&
    !root.contains(event.target) &&
    !isInsideSelectList(event.target)
  );
}

export function useOutsidePopovers(targets: PopoverTarget[]) {
  function onWindowPointerDown(event: PointerEvent): void {
    for (const target of targets) {
      if (target.open.value && isOutsidePress(target.root.value, event)) {
        target.close();
      }
    }
  }

  return {
    onWindowPointerDown,
  };
}
