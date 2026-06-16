<script setup lang="ts">
import { computed } from 'vue';
import { removeVcaGroup, setVcaGroupGain } from '@/project/commands';
import type { VcaGroup } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatDb } from '@/ui/mixer/db-scale';
import MixerFader from './MixerFader.vue';

/**
 * Compact strip for a VCA control group: a name header, the offset fader, and a
 * remove button. A VCA carries no audio of its own, so there is no meter — the
 * fader writes through setVcaGroupGain, and the mixer sync folds the offset into
 * every member track's lane gain. A member count hints at the group's reach.
 */

const props = defineProps<{
  /** The VCA group this strip controls. */
  group: VcaGroup;
}>();

const store = useProjectStore();

const gainDb = computed(() => props.group.gainDb);

/** Number of tracks currently assigned to this group. */
const memberCount = computed(
  () => store.tracks.filter((track) => track.vcaId === props.group.id).length,
);

function onFaderChange(db: number, commit: boolean): void {
  setVcaGroupGain(props.group.id, db, { commit });
}

function onRemove(): void {
  removeVcaGroup(props.group.id);
}
</script>

<template>
  <div class="vca-strip">
    <div class="vca-header">
      <span class="vca-tag">VCA</span>
      <span class="vca-name" :title="props.group.name">{{ props.group.name }}</span>
      <button
        type="button"
        class="vca-remove"
        title="Remove VCA group (members are unassigned)"
        :aria-label="`Remove VCA group ${props.group.name}`"
        @click="onRemove"
      >
        ×
      </button>
    </div>
    <div class="vca-fader-row">
      <MixerFader :value-db="gainDb" :height="120" @change="onFaderChange" />
    </div>
    <span class="vca-readout">{{ formatDb(gainDb) }} dB</span>
    <span class="vca-members">{{ memberCount }} ch</span>
  </div>
</template>

<style scoped>
.vca-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  width: 72px;
  flex: none;
  box-sizing: border-box;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  border-right: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.vca-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}

.vca-tag {
  font: var(--fw-bold) 7px var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--surface-0);
  background: #fbbf24;
  border-radius: var(--radius-sm);
  padding: 0 3px;
  flex: none;
}

.vca-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--fw-semibold) 10px var(--font-sans);
  color: var(--text-2);
}

.vca-remove {
  flex: none;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font: 11px var(--font-sans);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.vca-remove:hover {
  color: var(--danger-text);
}

.vca-fader-row {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  flex: 1;
  min-height: 0;
}

.vca-readout {
  font: var(--fw-medium) 9px var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.vca-members {
  font: var(--fw-medium) 8px var(--font-sans);
  color: var(--text-4);
}
</style>
