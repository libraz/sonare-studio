<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import GeneralTab from '@/components/settings/GeneralTab.vue';
import LayoutsTab from '@/components/settings/LayoutsTab.vue';
import ShortcutsTab from '@/components/settings/ShortcutsTab.vue';
import AppModal from '@/components/shell/AppModal.vue';
import { useI18n } from '@/ui/i18n';
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

const bodyRef = ref<HTMLElement | null>(null);
const shortcutsTab = ref<InstanceType<typeof ShortcutsTab> | null>(null);

function close(): void {
  emit('close');
}

/** Reclaims focus onto the dialog body after a tab removes a focused control. */
function focusDialog(): void {
  bodyRef.value?.focus();
}

// AppModal owns the overlay, focus trap, Escape and focus restoration; this
// dialog only has to stop an in-flight shortcut capture when it goes away.
watch(
  () => props.open,
  (open) => {
    if (!open) shortcutsTab.value?.stopCapture();
  },
);

onBeforeUnmount(() => {
  shortcutsTab.value?.stopCapture();
});
</script>

<template>
  <AppModal :open="props.open" :aria-label="t.settings.title" @close="close">
    <template #title>{{ t.settings.title }}</template>
    <div ref="bodyRef" class="dialog-body" tabindex="-1">
      <div v-tablist class="tabs" role="tablist" :aria-label="t.settings.sectionsLabel">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ active: activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`settings-panel-${tab.id}`"
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
    </div>
    <template #actions>
      <button type="button" class="primary" @click="close">{{ t.common.close }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.dialog-body:focus {
  outline: none;
}

.tabs {
  display: flex;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

/* Face, active underline and focus underline all come from the canonical `.tab`
 * in controls.css; only the wider gutter for this dialog's tab strip is local.
 * Redeclaring the underline with a border-bottom here would offset it from the
 * inset-shadow focus underline by the border's own 2px. */
.tab {
  padding: var(--sp-3) var(--sp-5);
}

/* The panel root lives in each tab component; this rule reaches it because a
 * child component's root inherits this scope id. Each tab mounts fresh on
 * switch, so the one-shot keyframe (from motion.css) fades the new panel in. */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  overflow: auto;
  min-height: 12rem;
  animation: view-enter var(--dur-2) var(--ease-out);
}
</style>
