<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from '@/ui/i18n';
import ChordListEditor from './ChordListEditor.vue';
import KeyListEditor from './KeyListEditor.vue';
import MarkerListEditor from './MarkerListEditor.vue';
import TempoMapEditor from './TempoMapEditor.vue';
import TimeSignatureEditor from './TimeSignatureEditor.vue';

/**
 * Tabbed container for the project list editors (tempo map, time signatures,
 * key, chords, markers). Suited for the editor dock or a popover host; the
 * panel itself only routes the playhead getter and seek requests to the
 * chord and marker lists.
 */

export type ListTab = 'tempo' | 'meter' | 'key' | 'chords' | 'markers';

const props = defineProps<{
  /** Playhead position getter in PPQ, forwarded to the marker list. */
  positionPpq?: () => number;
  /**
   * One-shot deep-link: switches to this tab whenever the value changes
   * (e.g. the chord lane's "open the chord list" action). The user's own tab
   * clicks afterward are unaffected — this only seeds/redirects, it does not
   * hold the tab open.
   */
  initialTab?: ListTab;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const { t } = useI18n();

const TABS: ReadonlyArray<{ id: ListTab }> = [
  { id: 'tempo' },
  { id: 'meter' },
  { id: 'key' },
  { id: 'chords' },
  { id: 'markers' },
];

const activeTab = ref<ListTab>(props.initialTab ?? 'tempo');

watch(
  () => props.initialTab,
  (tab) => {
    if (tab !== undefined) activeTab.value = tab;
  },
);
</script>

<template>
  <section class="project-lists">
    <div v-tablist class="list-tabs" role="tablist" :aria-label="t.shell.lists.label">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="list-tab"
        :data-tab-id="tab.id"
        :class="{ active: activeTab === tab.id }"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ t.shell.lists.tabs[tab.id] }}
      </button>
    </div>
    <div class="list-tab-body" role="tabpanel">
      <TempoMapEditor v-show="activeTab === 'tempo'" />
      <TimeSignatureEditor v-show="activeTab === 'meter'" />
      <KeyListEditor v-show="activeTab === 'key'" />
      <ChordListEditor
        v-show="activeTab === 'chords'"
        :position-ppq="props.positionPpq"
        @seek="emit('seek', $event)"
      />
      <MarkerListEditor
        v-show="activeTab === 'markers'"
        :position-ppq="props.positionPpq"
        @seek="emit('seek', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.project-lists {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
}

.list-tabs {
  display: flex;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.list-tab {
  background: none;
  border: none;
  box-shadow: none;
  border-radius: 0;
  color: var(--text-3);
  font: var(--fw-semibold) var(--fs-sm) var(--font-sans);
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  transition: color var(--dur-1) var(--ease-out);
}

.list-tab.active {
  color: var(--text-1);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.list-tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
</style>
