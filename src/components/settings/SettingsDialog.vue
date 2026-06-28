<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import GeneralTab from '@/components/settings/GeneralTab.vue';
import LayoutsTab from '@/components/settings/LayoutsTab.vue';
import ShortcutsTab from '@/components/settings/ShortcutsTab.vue';
import { useI18n } from '@/ui/i18n';
import { createFocusTrap, type FocusTrap } from '@/ui/settings/focus-trap';
import type { LayoutBindings } from '@/ui/settings/layouts';

/**
 * Tabbed application-settings modal: General preferences, shortcut remapping
 * (press keys inline to rebind) and named workspace layouts. The shell passes
 * its layout refs via `layoutBindings` so layouts can be captured and applied
 * without this dialog knowing the shell internals. This component owns the
 * dialog frame, tab switching and focus-trap lifecycle; each tab's content
 * lives in its own panel component.
 */

const props = withDefaults(
  defineProps<{
    /** Whether the dialog is visible. */
    open: boolean;
    /** Shell layout refs for the Layouts tab (omit to disable capture/apply). */
    layoutBindings?: LayoutBindings | null;
  }>(),
  { layoutBindings: null },
);

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
}>();

const { t } = useI18n();

type TabId = 'general' | 'shortcuts' | 'layouts';
const TABS = computed<ReadonlyArray<{ id: TabId; label: string }>>(() => [
  { id: 'general', label: t.value.settings.tabs.general },
  { id: 'shortcuts', label: t.value.settings.tabs.shortcuts },
  { id: 'layouts', label: t.value.settings.tabs.layouts },
]);
const activeTab = ref<TabId>('general');

const dialogRef = ref<HTMLElement | null>(null);
const shortcutsTab = ref<InstanceType<typeof ShortcutsTab> | null>(null);
let trap: FocusTrap | null = null;

function close(): void {
  emit('close');
}

function onDialogKeydown(event: KeyboardEvent): void {
  // While capturing a shortcut, the window-level capture listener consumes
  // every key (including Escape), so this handler never closes mid-capture.
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

/** Moves the tab selection by `delta`, wrapping around. */
function moveTab(delta: number): void {
  const tabs = TABS.value;
  const index = tabs.findIndex((tab) => tab.id === activeTab.value);
  const next = (index + delta + tabs.length) % tabs.length;
  activeTab.value = tabs[next].id;
}

function onTabKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveTab(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveTab(-1);
  }
}

/** Reclaims focus onto the dialog after a tab removes a focused control. */
function focusDialog(): void {
  dialogRef.value?.focus();
}

// --- Open/close lifecycle ----------------------------------------------------
// Registered last so the immediate run can safely reach every declaration.

watch(
  () => props.open,
  (open) => {
    if (open) {
      void nextTick(() => {
        if (dialogRef.value === null) return;
        trap = createFocusTrap(dialogRef.value);
        trap.activate();
      });
    } else {
      shortcutsTab.value?.stopCapture();
      trap?.deactivate();
      trap = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  shortcutsTab.value?.stopCapture();
  trap?.deactivate();
  trap = null;
});
</script>

<template>
  <Transition name="dialog">
    <div v-if="props.open" class="dialog-overlay" @click.self="close">
      <div
        ref="dialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t.settings.title"
        tabindex="-1"
        @keydown="onDialogKeydown"
      >
        <h2 class="dialog-title">{{ t.settings.title }}</h2>
        <div
          class="tabs"
          role="tablist"
          :aria-label="t.settings.sectionsLabel"
          @keydown="onTabKeydown"
        >
          <button
            v-for="tab in TABS"
            :key="tab.id"
            type="button"
            class="tab"
            :class="{ active: activeTab === tab.id }"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`settings-panel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <GeneralTab v-if="activeTab === 'general'" />
        <ShortcutsTab
          v-else-if="activeTab === 'shortcuts'"
          ref="shortcutsTab"
          @request-focus="focusDialog"
        />
        <LayoutsTab v-else :layout-bindings="props.layoutBindings" />

        <div class="dialog-actions">
          <button type="button" class="primary" @click="close">{{ t.settings.close }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  -webkit-backdrop-filter: var(--scrim-blur);
  backdrop-filter: var(--scrim-blur);
}

/* Entrance/exit motion mirrors the canonical modal: the scrim fades while the
 * panel springs in. Durations collapse to 0 under prefers-reduced-motion. */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-2) var(--ease-out);
}

.dialog-enter-active .dialog {
  transition: transform var(--dur-3) var(--ease-spring),
    opacity var(--dur-2) var(--ease-out);
}

.dialog-leave-active .dialog {
  transition: transform var(--dur-2) var(--ease-out),
    opacity var(--dur-2) var(--ease-out);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-from .dialog {
  opacity: 0;
  transform: scale(0.94) translateY(8px);
}

.dialog-leave-to .dialog {
  opacity: 0;
  transform: scale(0.97);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: min(38rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: var(--sp-6);
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
}

.tabs {
  display: flex;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.tab {
  background: none;
  border: none;
  box-shadow: none;
  border-radius: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  padding: var(--sp-3) var(--sp-5);
  cursor: pointer;
  font-size: var(--fs-sm);
  transition:
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.tab.active {
  color: var(--text-1);
  border-bottom-color: var(--accent);
}

/* The panel root lives in each tab component; this rule reaches it because a
 * child component's root inherits this scope id. Each tab mounts fresh on
 * switch, so the one-shot keyframe (from motion.css) fades the new panel in. */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  overflow: auto;
  min-height: 12rem;
  animation: view-enter var(--dur-2) var(--ease-out);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-actions .primary {
  background: var(--accent-strong);
  border: 1px solid var(--accent);
  color: var(--text-1);
  border-radius: var(--radius-sm);
  padding: 0.25rem 0.9rem;
  cursor: pointer;
  box-shadow: var(--raise-hi);
  transition: background var(--dur-1) var(--ease-out);
}

.dialog-actions .primary:hover {
  background: var(--accent-hover);
}
</style>
