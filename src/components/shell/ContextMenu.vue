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
  reportContextMenuError,
  useContextMenuState,
} from '@/ui/menu/context-menu';

const state = useContextMenuState();
const menuEl = ref<HTMLElement | null>(null);
const submenuEl = ref<HTMLElement | null>(null);
const activeSubmenuId = ref<string | null>(null);

/** Displayed position, clamped to the viewport after the menu measures. */
const pos = reactive({ x: 0, y: 0 });
const submenu = reactive<{ open: boolean; x: number; y: number; items: ContextMenuItem[] }>({
  open: false,
  x: 0,
  y: 0,
  items: [],
});

watch(
  () => [state.open, state.x, state.y, state.items] as const,
  async () => {
    if (!state.open) return;
    activeSubmenuId.value = null;
    submenu.open = false;
    submenu.items = [];
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
    focusFirstItem(el);
  },
  { flush: 'post' },
);

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLButtonElement>('.context-menu-item')].filter(
    (button) => !button.disabled,
  );
}

function focusFirstItem(root: HTMLElement | null): void {
  menuItems(root)[0]?.focus();
}

function moveFocus(root: HTMLElement | null, direction: -1 | 1): void {
  const items = menuItems(root);
  if (items.length === 0) return;
  const active = document.activeElement;
  const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
  const next = index === -1 ? 0 : (index + direction + items.length) % items.length;
  items[next].focus();
}

function focusEdge(root: HTMLElement | null, edge: 'first' | 'last'): void {
  const items = menuItems(root);
  const item = edge === 'first' ? items[0] : items[items.length - 1];
  item?.focus();
}

function run(item: ContextMenuItem): void {
  if (item.disabled || item.separator || !item.run) return;
  const action = item.run;
  closeContextMenu();
  try {
    void Promise.resolve(action()).catch(reportContextMenuError);
  } catch (error) {
    reportContextMenuError(error);
  }
}

function hasSubmenu(item: ContextMenuItem): boolean {
  return item.children?.some((child) => !child.separator) === true;
}

async function openSubmenu(item: ContextMenuItem, target: HTMLElement): Promise<void> {
  if (!hasSubmenu(item) || item.disabled || !item.children) {
    activeSubmenuId.value = null;
    submenu.open = false;
    submenu.items = [];
    return;
  }
  activeSubmenuId.value = item.id;
  const rect = target.getBoundingClientRect();
  submenu.items = item.children;
  submenu.x = rect.right + 4;
  submenu.y = rect.top;
  submenu.open = true;
  await nextTick();
  const el = submenuEl.value;
  if (!el) return;
  const subRect = el.getBoundingClientRect();
  const margin = 4;
  if (subRect.right > window.innerWidth) {
    submenu.x = Math.max(margin, rect.left - subRect.width - 4);
  }
  if (subRect.bottom > window.innerHeight) {
    submenu.y = Math.max(margin, window.innerHeight - subRect.height - margin);
  }
}

function onItemEnter(item: ContextMenuItem, event: MouseEvent): void {
  void openSubmenu(item, event.currentTarget as HTMLElement);
}

function onItemClick(item: ContextMenuItem, event: MouseEvent): void {
  if (hasSubmenu(item)) {
    void openSubmenu(item, event.currentTarget as HTMLElement);
    return;
  }
  run(item);
}

function itemForButton(button: HTMLButtonElement | null): ContextMenuItem | undefined {
  if (!button) return undefined;
  const id = button.dataset.menuItemId;
  return [...state.items, ...submenu.items].find((item) => item.id === id);
}

function onMenuKeydown(event: KeyboardEvent, root: HTMLElement | null): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveFocus(root, 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveFocus(root, -1);
      break;
    case 'Home':
      event.preventDefault();
      focusEdge(root, 'first');
      break;
    case 'End':
      event.preventDefault();
      focusEdge(root, 'last');
      break;
    case 'Enter':
    case ' ': {
      event.preventDefault();
      const button =
        document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
      const item = itemForButton(button);
      if (!item) return;
      if (hasSubmenu(item) && button) void openSubmenu(item, button);
      else run(item);
      break;
    }
    case 'ArrowRight': {
      const button =
        document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
      const item = itemForButton(button);
      if (!item || !button || !hasSubmenu(item)) return;
      event.preventDefault();
      void openSubmenu(item, button).then(() => focusFirstItem(submenuEl.value));
      break;
    }
    case 'ArrowLeft': {
      if (!submenu.open) return;
      event.preventDefault();
      const parentId = activeSubmenuId.value;
      submenu.open = false;
      submenu.items = [];
      activeSubmenuId.value = null;
      menuItems(menuEl.value)
        .find((button) => button.dataset.menuItemId === parentId)
        ?.focus();
      break;
    }
  }
}
</script>

<template>
  <Transition name="pop">
  <div
    v-if="state.open"
    ref="menuEl"
    class="context-menu control-menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    role="menu"
    @keydown="onMenuKeydown($event, menuEl)"
  >
    <template v-for="item in state.items" :key="item.id">
      <div v-if="item.separator" class="context-menu-sep" role="separator" />
      <button
        v-else
        type="button"
        role="menuitem"
        class="context-menu-item"
        :data-menu-item-id="item.id"
        :class="{
          danger: item.danger,
          'has-submenu': hasSubmenu(item),
          'submenu-open': activeSubmenuId === item.id,
        }"
        :disabled="item.disabled"
        :aria-checked="item.checked === undefined ? undefined : item.checked"
        :aria-haspopup="hasSubmenu(item) ? 'menu' : undefined"
        :aria-expanded="hasSubmenu(item) ? activeSubmenuId === item.id : undefined"
        @mouseenter="onItemEnter(item, $event)"
        @click="onItemClick(item, $event)"
      >
        <span class="context-menu-check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
        <span class="context-menu-label">{{ item.label }}</span>
        <span v-if="item.hint" class="context-menu-hint">{{ item.hint }}</span>
        <span v-if="hasSubmenu(item)" class="context-menu-arrow" aria-hidden="true">›</span>
      </button>
    </template>
  </div>
  </Transition>
  <Transition name="pop">
    <div
      v-if="state.open && submenu.open"
      ref="submenuEl"
      class="context-menu context-submenu control-menu"
      :style="{ left: `${submenu.x}px`, top: `${submenu.y}px` }"
      role="menu"
      @keydown="onMenuKeydown($event, submenuEl)"
    >
      <template v-for="child in submenu.items" :key="child.id">
        <div v-if="child.separator" class="context-menu-sep" role="separator" />
        <button
          v-else
          type="button"
          role="menuitem"
          class="context-menu-item"
          :data-menu-item-id="child.id"
          :class="{ danger: child.danger }"
          :disabled="child.disabled"
          :aria-checked="child.checked === undefined ? undefined : child.checked"
          @click="run(child)"
        >
          <span class="context-menu-check" aria-hidden="true">{{ child.checked ? '✓' : '' }}</span>
          <span class="context-menu-label">{{ child.label }}</span>
          <span v-if="child.hint" class="context-menu-hint">{{ child.hint }}</span>
        </button>
      </template>
    </div>
  </Transition>
</template>
