<script setup lang="ts">
import { computed } from 'vue';
import type { MeterSource } from '@/engine/meters';
import { removeMixerBus, setMixerBusGain } from '@/project/commands';
import type { MixerBus } from '@/project/mixer';
import { formatDb } from '@/ui/mixer/db-scale';
import MixerFader from './MixerFader.vue';
import StripMeter from './StripMeter.vue';

/**
 * Compact mixer strip for a send/return bus: a name header, the gain fader with
 * its live meter, and a remove button. Buses carry only a gain in the project
 * model, so the strip is lighter than a channel strip; the fader writes through
 * setMixerBusGain, which the strip sync mirrors onto the engine bus lane, and
 * the meter reads the engine's per-bus meter record.
 */

const props = withDefaults(
  defineProps<{
    /** The bus this strip controls. */
    bus: MixerBus;
    /** Live meter source for this bus; null shows a placeholder meter. */
    bridge?: MeterSource | null;
  }>(),
  { bridge: null },
);

const gainDb = computed(() => props.bus.gainDb);

function onFaderChange(db: number, commit: boolean): void {
  setMixerBusGain(props.bus.id, db, { commit });
}

function onRemove(): void {
  removeMixerBus(props.bus.id);
}
</script>

<template>
  <div class="bus-strip">
    <div class="bus-header">
      <span class="bus-tag">BUS</span>
      <span class="bus-name" :title="props.bus.name">{{ props.bus.name }}</span>
      <button
        type="button"
        class="bus-remove"
        title="Remove bus (and its sends)"
        :aria-label="`Remove bus ${props.bus.name}`"
        @click="onRemove"
      >
        ×
      </button>
    </div>
    <div class="bus-fader-row">
      <MixerFader :value-db="gainDb" :height="120" @change="onFaderChange" />
      <StripMeter :bridge="props.bridge" :placeholder="!props.bridge" :height="120" />
    </div>
    <span class="bus-readout">{{ formatDb(gainDb) }} dB</span>
  </div>
</template>

<style scoped>
.bus-strip {
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

.bus-header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}

.bus-tag {
  font: var(--fw-bold) 7px var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--accent);
  background: var(--accent-muted);
  border-radius: var(--radius-sm);
  padding: 0 3px;
  flex: none;
}

.bus-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--fw-semibold) 10px var(--font-sans);
  color: var(--text-2);
}

.bus-remove {
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

.bus-remove:hover {
  color: var(--danger-text);
}

.bus-fader-row {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: var(--sp-2);
  flex: 1;
  min-height: 0;
}

.bus-readout {
  font: var(--fw-medium) 9px var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}
</style>
