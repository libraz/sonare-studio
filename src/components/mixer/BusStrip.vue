<script setup lang="ts">
import { computed, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import type { MeterSource } from '@/engine/meters';
import {
  type BusAutomationTarget,
  busAutomationTarget,
  evaluateAutomationValue,
} from '@/project/automation';
import {
  mixerBusStripTarget,
  removeMixerBus,
  renameMixerBus,
  setAutomationLanePoints,
  setMixerBusGain,
} from '@/project/commands';
import type { MixerBus } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type AutomationWriteGesture,
  automationStripMode,
  createAutomationWriteGesture,
  isAutomationWriteMode,
  toggleAutomationStripMode,
} from '@/ui/mixer/automation-mode';
import { formatDb } from '@/ui/mixer/db-scale';
import InsertRack from './InsertRack.vue';
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
    /** Playhead position getter in PPQ (automation follow/recording). */
    positionPpq?: () => number;
    /** True while the transport runs (automation touch recording). */
    isPlaying?: boolean;
  }>(),
  { bridge: null, positionPpq: undefined, isPlaying: false },
);

const store = useProjectStore();
const automationTarget = computed<BusAutomationTarget>(() => busAutomationTarget(props.bus.id));
const stripTarget = computed(() => mixerBusStripTarget(props.bus.id));
const { t } = useI18n();
const autoMode = computed(() => automationStripMode(automationTarget.value));
const faderLane = computed(() =>
  store.automationLanes.find(
    (lane) => lane.target === automationTarget.value && lane.param === 'faderDb',
  ),
);
const followsFader = computed(
  () =>
    autoMode.value === 'read' &&
    faderLane.value !== undefined &&
    faderLane.value.enabled &&
    faderLane.value.points.length > 0,
);
let writeFaderGesture: AutomationWriteGesture | null = null;
const writeGainDb = ref<number | null>(null);

const gainDb = computed(() =>
  writeGainDb.value !== null
    ? writeGainDb.value
    : followsFader.value && faderLane.value
      ? evaluateAutomationValue(faderLane.value.points, props.positionPpq?.() ?? 0)
      : props.bus.gainDb,
);

function beginWriteGesture(): AutomationWriteGesture {
  return createAutomationWriteGesture({
    mode: autoMode.value === 'latch' ? 'latch' : 'touch',
    existingPoints: faderLane.value?.points ?? [],
    positionPpq: () => props.positionPpq?.() ?? 0,
    isPlaying: () => props.isPlaying,
    commit: (points) => setAutomationLanePoints(automationTarget.value, 'faderDb', points),
  });
}

function onFaderChange(db: number, commit: boolean): void {
  if (isAutomationWriteMode(autoMode.value)) {
    if (!writeFaderGesture) writeFaderGesture = beginWriteGesture();
    writeFaderGesture.update(db);
    writeGainDb.value = db;
    if (commit) {
      writeFaderGesture.end();
      writeFaderGesture = null;
      writeGainDb.value = null;
    }
    return;
  }
  setMixerBusGain(props.bus.id, db, { commit });
}

function onRemove(): void {
  removeMixerBus(props.bus.id);
}

async function onRename(): Promise<void> {
  const next = await promptDialog({
    title: t.value.shell.mixer.strip.renameBusTitle,
    message: t.value.shell.mixer.strip.renameBusMessage,
    defaultValue: props.bus.name,
    placeholder: props.bus.name,
    confirmLabel: t.value.shell.mixer.strip.renameBusConfirm,
  });
  if (next && next !== props.bus.name) renameMixerBus(props.bus.id, next);
}
</script>

<template>
  <div class="bus-strip">
    <div class="bus-header">
      <span class="bus-tag">{{ t.shell.mixer.strip.bus }}</span>
      <button
        type="button"
        class="bus-name"
        :title="t.shell.mixer.strip.renameBusTitle"
        @click="onRename"
      >
        {{ props.bus.name }}
      </button>
      <button
        type="button"
        class="bus-remove"
        :title="t.shell.mixer.strip.removeBusTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.removeBus, { name: props.bus.name })"
        @click="onRemove"
      >
        ×
      </button>
    </div>
    <div class="bus-inserts">
      <InsertRack :target="stripTarget" />
    </div>
    <div class="bus-auto">
      <button
        type="button"
        class="bus-auto-button"
        :class="{ on: autoMode === 'read' }"
        :title="t.shell.mixer.strip.automationReadTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationRead, { name: props.bus.name })"
        :aria-pressed="autoMode === 'read'"
        @click="toggleAutomationStripMode(automationTarget, 'read')"
      >
        R
      </button>
      <button
        type="button"
        class="bus-auto-button"
        :class="{ on: autoMode === 'touch' }"
        :title="t.shell.mixer.strip.automationTouchTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationTouch, { name: props.bus.name })"
        :aria-pressed="autoMode === 'touch'"
        @click="toggleAutomationStripMode(automationTarget, 'touch')"
      >
        T
      </button>
      <button
        type="button"
        class="bus-auto-button"
        :class="{ on: autoMode === 'latch' }"
        :title="t.shell.mixer.strip.automationLatchTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationLatch, { name: props.bus.name })"
        :aria-pressed="autoMode === 'latch'"
        @click="toggleAutomationStripMode(automationTarget, 'latch')"
      >
        L
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
  width: 96px;
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

.bus-inserts {
  width: 100%;
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--sp-2);
}

.bus-auto {
  display: flex;
  justify-content: center;
  gap: var(--sp-1);
  width: 100%;
}

.bus-auto-button {
  width: 19px;
  height: 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text-4);
  font: var(--fw-bold) 8px var(--font-sans);
  cursor: pointer;
}

.bus-auto-button.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-muted);
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
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  text-align: left;
  font: var(--fw-semibold) 10px var(--font-sans);
  color: var(--text-2);
  cursor: pointer;
}

.bus-name:hover {
  color: var(--text-1);
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
