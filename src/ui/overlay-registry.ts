import type { MaybeRef } from 'vue';
import { computed, getCurrentScope, onScopeDispose, reactive, unref, watch } from 'vue';

const shortcutBlockingOverlays = reactive(new Set<symbol>());

/** True while any registered overlay should block app-level shortcuts. */
export const shortcutBlockingOverlayOpen = computed(() => shortcutBlockingOverlays.size > 0);

/**
 * Registers a reactive overlay-open flag as a shortcut blocker for the current
 * Vue effect scope. The token is removed automatically on unmount/dispose.
 */
export function useShortcutBlockingOverlay(open: MaybeRef<boolean>): void {
  const token = Symbol('shortcut-blocking-overlay');
  const setActive = (active: boolean): void => {
    if (active) shortcutBlockingOverlays.add(token);
    else shortcutBlockingOverlays.delete(token);
  };
  const stop = watch(() => unref(open), setActive, { immediate: true });
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stop();
      shortcutBlockingOverlays.delete(token);
    });
  }
}

/** Test helper for composables that use the module-level registry. */
export function resetShortcutBlockingOverlaysForTest(): void {
  shortcutBlockingOverlays.clear();
}
