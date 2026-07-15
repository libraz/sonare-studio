<script setup lang="ts">
/**
 * Native-style application menu bar. Renders a row of menu triggers and, for
 * the open one, an anchored dropdown. Behaves like a desktop menu bar:
 *
 * - clicking a trigger toggles its menu;
 * - while any menu is open, hovering a sibling trigger switches to it;
 * - Arrow keys move within a menu and Left/Right hop between menus;
 * - Enter / Space activate, Escape closes and returns focus to the trigger;
 * - a pointer-down outside, or blur away from the bar, closes the menu.
 *
 * The bar is purely presentational over a {@link MenuBarMenu} model: every row
 * carries its own `run`, so this component never needs to know what the actions
 * are. The same component drives both the left command bar and the right-hand
 * Layout menu (via `align="end"`).
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import TransportIcon from '@/components/shell/TransportIcon.vue';
import { cleanMenuItems, isNavigable, type MenuBarMenu } from '@/ui/menu/menu-bar';

const props = withDefaults(
  defineProps<{
    menus: readonly MenuBarMenu[];
    ariaLabel?: string;
    /** Which edge the dropdown aligns to under its trigger. */
    align?: 'start' | 'end';
    /** Shows a disclosure chevron on triggers (used by picker-style menus). */
    chevron?: boolean;
  }>(),
  { align: 'start', chevron: false },
);

const openId = ref<string | null>(null);
/** Id of the row highlighted for keyboard activation, if any. */
const activeRowId = ref<string | null>(null);

const triggerEls = new Map<string, HTMLButtonElement>();
const panelEls = new Map<string, HTMLElement>();
const rootEl = ref<HTMLElement | null>(null);

/** Rows of the open menu, cleaned of stray separators / dangling headings. */
const openItems = computed(() => {
  const menu = props.menus.find((m) => m.id === openId.value);
  return menu ? cleanMenuItems(menu.items) : [];
});

const navigableIds = computed(() => openItems.value.filter(isNavigable).map((item) => item.id));

function rowDomId(menuId: string, itemId: string): string {
  return `menubar-${menuId}-${itemId}`;
}

function triggerDomId(menuId: string): string {
  return `menubar-trigger-${menuId}`;
}

function panelDomId(menuId: string): string {
  return `menubar-panel-${menuId}`;
}

function setTriggerEl(id: string, el: HTMLButtonElement | null): void {
  if (el) triggerEls.set(id, el);
  else triggerEls.delete(id);
}

function setPanelEl(id: string, el: HTMLElement | null): void {
  if (el) panelEls.set(id, el);
  else panelEls.delete(id);
}

function attach(): void {
  window.addEventListener('pointerdown', onPointerDown, true);
}

function detach(): void {
  window.removeEventListener('pointerdown', onPointerDown, true);
}

function openMenu(id: string, focusPanel = false): void {
  openId.value = id;
  activeRowId.value = null;
  attach();
  if (focusPanel) void nextTick(() => panelEls.get(id)?.focus());
}

function close(focusTrigger = false): void {
  const id = openId.value;
  openId.value = null;
  activeRowId.value = null;
  detach();
  if (focusTrigger && id) triggerEls.get(id)?.focus();
}

function toggle(id: string): void {
  if (openId.value === id) close();
  else openMenu(id);
}

function onTriggerHover(id: string): void {
  if (openId.value !== null && openId.value !== id) openMenu(id);
}

function activate(itemId: string): void {
  const item = openItems.value.find((i) => i.id === itemId);
  if (!item || !isNavigable(item)) return;
  const run = item.run;
  close(true);
  run?.();
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Node && rootEl.value?.contains(target)) return;
  close();
}

/** Moves the keyboard highlight by `delta`, wrapping, opening at an end. */
function moveActive(delta: 1 | -1): void {
  const ids = navigableIds.value;
  if (ids.length === 0) return;
  const current = activeRowId.value ? ids.indexOf(activeRowId.value) : -1;
  let next: number;
  if (current === -1) next = delta === 1 ? 0 : ids.length - 1;
  else next = (current + delta + ids.length) % ids.length;
  activeRowId.value = ids[next];
}

/** Opens the adjacent menu when traversing the bar with Left/Right. */
function hopMenu(delta: 1 | -1): void {
  if (props.menus.length === 0) return;
  const fromId = openId.value ?? focusedTriggerId();
  const from = fromId ? props.menus.findIndex((m) => m.id === fromId) : -1;
  const start = from === -1 ? (delta === 1 ? -1 : 0) : from;
  const next = (start + delta + props.menus.length) % props.menus.length;
  const target = props.menus[next];
  if (openId.value) openMenu(target.id, true);
  else triggerEls.get(target.id)?.focus();
}

function focusedTriggerId(): string | null {
  const active = document.activeElement;
  for (const [id, el] of triggerEls) {
    if (el === active) return id;
  }
  return null;
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      hopMenu(-1);
      return;
    case 'ArrowRight':
      event.preventDefault();
      hopMenu(1);
      return;
    case 'Escape':
      if (openId.value) {
        event.preventDefault();
        close(true);
      }
      return;
  }

  if (!openId.value) {
    // A trigger is focused but its menu is closed: open downward / upward.
    const focused = focusedTriggerId();
    if (focused && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      openMenu(focused, true);
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    }
    return;
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveActive(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveActive(-1);
      break;
    case 'Home':
      event.preventDefault();
      activeRowId.value = navigableIds.value[0] ?? null;
      break;
    case 'End': {
      event.preventDefault();
      const ids = navigableIds.value;
      activeRowId.value = ids[ids.length - 1] ?? null;
      break;
    }
    case 'Enter':
    case ' ':
      if (activeRowId.value) {
        event.preventDefault();
        activate(activeRowId.value);
      }
      break;
    case 'Tab':
      close();
      break;
  }
}

onBeforeUnmount(detach);
</script>

<template>
  <nav
    ref="rootEl"
    class="app-menubar"
    :class="{ 'app-menubar--end': align === 'end' }"
    role="menubar"
    :aria-label="ariaLabel"
    @keydown="onKeydown"
  >
    <div v-for="menu in menus" :key="menu.id" class="app-menubar__slot" role="none">
      <button
        :ref="(el) => setTriggerEl(menu.id, el as HTMLButtonElement | null)"
        type="button"
        :id="triggerDomId(menu.id)"
        class="app-menubar__trigger"
        :class="{ open: openId === menu.id }"
        aria-haspopup="menu"
        role="menuitem"
        :aria-expanded="openId === menu.id"
        :aria-controls="openId === menu.id ? panelDomId(menu.id) : undefined"
        @click="toggle(menu.id)"
        @pointerenter="onTriggerHover(menu.id)"
      >
        {{ menu.label }}
        <TransportIcon v-if="chevron" class="app-menubar__chevron" name="chevron-down" />
      </button>
      <Transition name="pop">
        <div
          v-if="openId === menu.id"
          :id="panelDomId(menu.id)"
          :ref="(el) => setPanelEl(menu.id, el as HTMLElement | null)"
          class="menu-panel"
          :class="{ 'menu-panel--end': align === 'end' }"
          role="menu"
          tabindex="-1"
          :aria-label="menu.ariaLabel"
          :aria-labelledby="menu.ariaLabel ? undefined : triggerDomId(menu.id)"
          :aria-activedescendant="
            activeRowId ? rowDomId(menu.id, activeRowId) : undefined
          "
        >
          <template v-for="item in openItems" :key="item.id">
            <div
              v-if="item.separator"
              class="menu-panel__sep"
              role="separator"
            />
            <div
              v-else-if="item.heading"
              class="menu-panel__heading"
              role="presentation"
            >
              {{ item.heading }}
            </div>
            <button
              v-else
              :id="rowDomId(menu.id, item.id)"
              type="button"
              tabindex="-1"
              class="menu-panel__item"
              :class="{
                danger: item.danger,
                active: activeRowId === item.id,
              }"
              role="menuitem"
              :disabled="item.disabled"
              :aria-checked="item.checked === undefined ? undefined : item.checked"
              @click="activate(item.id)"
              @pointermove="activeRowId = item.id"
            >
              <span class="menu-panel__check" aria-hidden="true">{{
                item.checked ? '✓' : ''
              }}</span>
              <span class="menu-panel__label">{{ item.label }}</span>
              <span v-if="item.hint" class="menu-panel__hint">{{ item.hint }}</span>
            </button>
          </template>
        </div>
      </Transition>
    </div>
  </nav>
</template>

<style scoped src="@/ui/shell/menu-bar.css"></style>
