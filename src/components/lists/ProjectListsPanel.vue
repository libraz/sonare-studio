<script setup lang="ts">
import { ref } from 'vue';
import KeyListEditor from './KeyListEditor.vue';
import MarkerListEditor from './MarkerListEditor.vue';
import TempoMapEditor from './TempoMapEditor.vue';
import TimeSignatureEditor from './TimeSignatureEditor.vue';

/**
 * Tabbed container for the project list editors (tempo map, time signatures,
 * key, markers). Suited for the editor dock or a popover host; the panel
 * itself only routes the playhead getter and seek requests to the marker
 * list.
 */

const props = defineProps<{
  /** Playhead position getter in PPQ, forwarded to the marker list. */
  positionPpq?: () => number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

type ListTab = 'tempo' | 'meter' | 'key' | 'markers';

const TABS: ReadonlyArray<{ id: ListTab; label: string }> = [
  { id: 'tempo', label: 'Tempo' },
  { id: 'meter', label: 'Time Sig' },
  { id: 'key', label: 'Key' },
  { id: 'markers', label: 'Markers' },
];

const activeTab = ref<ListTab>('tempo');
</script>

<template>
  <section class="project-lists">
    <div class="list-tabs" role="tablist" aria-label="Project lists">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="list-tab"
        :class="{ active: activeTab === tab.id }"
        role="tab"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>
    <div class="list-tab-body" role="tabpanel">
      <TempoMapEditor v-if="activeTab === 'tempo'" />
      <TimeSignatureEditor v-else-if="activeTab === 'meter'" />
      <KeyListEditor v-else-if="activeTab === 'key'" />
      <MarkerListEditor v-else :position-ppq="props.positionPpq" @seek="emit('seek', $event)" />
    </div>
  </section>
</template>

<style scoped>
.project-lists {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #14161b;
  border: 1px solid #000;
}

.list-tabs {
  display: flex;
  background: #101216;
  border-bottom: 1px solid #000;
}

.list-tab {
  background: none;
  border: none;
  color: #8b93a3;
  font: 600 12px system-ui, sans-serif;
  padding: 0.4rem 0.9rem;
  cursor: pointer;
}

.list-tab.active {
  color: #e2e6ee;
  box-shadow: inset 0 -2px 0 #60a5fa;
}

.list-tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
</style>
