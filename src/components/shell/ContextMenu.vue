<script setup lang="ts">
/**
 * Singleton right-click action menu. Mounted once at the shell; its contents
 * and position come from the shared context-menu store, which any surface
 * drives via `openContextMenu`. After mounting it clamps itself to the viewport
 * so a menu opened near an edge stays fully visible.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import {
  type ContextMenuItem,
  closeContextMenu,
  useContextMenuState,
} from '@/ui/menu/context-menu';

const state = useContextMenuState();
const menuEl = ref<HTMLElement | null>(null);

/** Displayed position, clamped to the viewport after the menu measures. */
const pos = reactive({ x: 0, y: 0 });

watch(
  () => [state.open, state.x, state.y, state.items] as const,
  async () => {
    if (!state.open) return;
    pos.x = state.x;
    pos.y = state.y;
    await nextTick();
    const el = menuEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    if (rect.right > window.innerWidth) {
      pos.x = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (rect.bottom > window.innerHeight) {
      pos.y = Math.max(margin, window.innerHeight - rect.height - margin);
    }
  },
  { flush: 'post' },
);

function run(item: ContextMenuItem): void {
  if (item.disabled || item.separator || !item.run) return;
  const action = item.run;
  closeContextMenu();
  action();
}
</script>

<template>
  <div
    v-if="state.open"
    ref="menuEl"
    class="context-menu control-menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    role="menu"
  >
    <template v-for="item in state.items" :key="item.id">
      <div v-if="item.separator" class="context-menu-sep" role="separator" />
      <button
        v-else
        type="button"
        role="menuitem"
        class="context-menu-item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        :aria-checked="item.checked === undefined ? undefined : item.checked"
        @click="run(item)"
      >
        <span class="context-menu-check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
        <span class="context-menu-label">{{ item.label }}</span>
        <span v-if="item.hint" class="context-menu-hint">{{ item.hint }}</span>
      </button>
    </template>
  </div>
</template>
