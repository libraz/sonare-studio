<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import type { MeterSource } from '@/engine/meters';
import type { ScopeSource } from '@/engine/scope';
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
  setMixerBusMute,
  setMixerBusSolo,
} from '@/project/commands';
import type { MixerBus } from '@/project/mixer';
import { canRouteReturnSolo } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  type AutomationWriteGesture,
  type AutomationWriteScheduleEvent,
  automationStripMode,
  createAutomationWriteGesture,
  isAutomationWriteMode,
  toggleAutomationStripMode,
} from '@/ui/mixer/automation-mode';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb } from '@/ui/mixer/db-scale';
import InsertRack from './InsertRack.vue';
import MixerFader from './MixerFader.vue';
import NumericReadout from './NumericReadout.vue';
import SpectrumAnalyzer from './SpectrumAnalyzer.vue';
import StereoGoniometer from './StereoGoniometer.vue';
import StripGrMeter from './StripGrMeter.vue';
import StripMeter from './StripMeter.vue';
import StripOptionsPopover from './StripOptionsPopover.vue';

/**
 * Compact mixer strip for a send/return bus: a name header, an insert rack, the
 * gain fader with its live meter, and a remove button. The fader writes through
 * setMixerBusGain, which the strip sync mirrors onto the engine bus lane, and
 * the meter reads the engine's per-bus meter record. A shaping popover exposes
 * the bus's output trim, stereo width, and polarity invert — the same controls a
 * channel strip offers, applied to the bus's summed output.
 */

const props = withDefaults(
  defineProps<{
    /** The bus this strip controls. */
    bus: MixerBus;
    /** Live meter source for this bus; null shows a placeholder meter. */
    bridge?: MeterSource | null;
    /** Engine scope source (per-target spectrum + goniometer), when available. */
    scope?: ScopeSource | null;
    /** Playhead position getter in PPQ (automation follow/recording). */
    positionPpq?: () => number;
    /** Current playhead sample position, used by future sample-accurate scheduling. */
    positionSample?: () => number;
    /** True while the transport runs (automation touch recording). */
    isPlaying?: boolean;
    /** Whether the mixer dock is visible and realtime displays should run. */
    visible?: boolean;
    /** Optional realtime automation scheduler for write-mode bus fader drags. */
    scheduleAutomationWrite?: (
      target: BusAutomationTarget,
      param: 'faderDb',
      event: AutomationWriteScheduleEvent,
    ) => void;
  }>(),
  {
    bridge: null,
    scope: null,
    positionPpq: undefined,
    positionSample: undefined,
    isPlaying: false,
    visible: true,
  },
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
const muted = computed(() => props.bus.mute === true);
const soloed = computed(() => props.bus.solo === true);
/** A return solo parks the silenced direct outputs on one extra engine bus. */
const canSolo = computed(
  () => soloed.value || canRouteReturnSolo(store.mixer.buses.length, store.tracks),
);

function beginWriteGesture(): AutomationWriteGesture {
  return createAutomationWriteGesture({
    mode: autoMode.value === 'latch' ? 'latch' : 'touch',
    existingPoints: faderLane.value?.points ?? [],
    positionPpq: () => props.positionPpq?.() ?? 0,
    positionSample: props.positionSample,
    isPlaying: () => props.isPlaying,
    schedule: (event) => props.scheduleAutomationWrite?.(automationTarget.value, 'faderDb', event),
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

onBeforeUnmount(() => {
  // A strip can disappear while its fader is held (for example when its bus is
  // removed). Close the write gesture so its pending automation is retained.
  writeFaderGesture?.end();
  writeFaderGesture = null;
  writeGainDb.value = null;
});
</script>

<template>
  <div class="bus-strip">
    <div class="bus-header">
      <span class="bus-tag">{{ t.shell.mixer.strip.bus }}</span>
      <button
        type="button"
        class="bus-name"
        v-tooltip="t.shell.mixer.strip.renameBusTitle"
        @click="onRename"
      >
        {{ props.bus.name }}
      </button>
      <StripOptionsPopover :target="stripTarget" :name="props.bus.name" />
      <button
        type="button"
        class="bus-remove"
        v-tooltip="t.shell.mixer.strip.removeBusTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.removeBus, { name: props.bus.name })"
        @click="onRemove"
      >
        ×
      </button>
    </div>
    <div class="bus-inserts">
      <InsertRack :target="stripTarget" />
    </div>
    <div class="bus-toggles">
      <button
        type="button"
        class="bus-toggle mute"
        :class="{ on: muted }"
        v-tooltip="muted ? t.shell.mixer.strip.unmute : t.shell.mixer.strip.mute"
        :aria-label="formatMessage(t.shell.mixer.strip.muteNamed, { name: props.bus.name })"
        :aria-pressed="muted"
        @click="setMixerBusMute(props.bus.id, !muted)"
      >
        M
      </button>
      <button
        type="button"
        class="bus-toggle solo"
        :class="{ on: soloed }"
        :disabled="!canSolo"
        v-tooltip="canSolo ? t.shell.mixer.strip.solo : t.shell.mixer.returnSoloUnavailable"
        :aria-label="formatMessage(t.shell.mixer.strip.soloNamed, { name: props.bus.name })"
        :aria-pressed="soloed"
        @click="setMixerBusSolo(props.bus.id, !soloed)"
      >
        S
      </button>
    </div>
    <div class="bus-auto">
      <button
        type="button"
        class="bus-auto-button"
        :class="{ on: autoMode === 'read' }"
        v-tooltip="t.shell.mixer.strip.automationReadTitle"
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
        v-tooltip="t.shell.mixer.strip.automationTouchTitle"
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
        v-tooltip="t.shell.mixer.strip.automationLatchTitle"
        :aria-label="formatMessage(t.shell.mixer.strip.automationLatch, { name: props.bus.name })"
        :aria-pressed="autoMode === 'latch'"
        @click="toggleAutomationStripMode(automationTarget, 'latch')"
      >
        L
      </button>
    </div>
    <div class="bus-fader-row">
      <MixerFader :value-db="gainDb" :height="120" @change="onFaderChange" />
      <StripMeter
        :bridge="props.bridge"
        :placeholder="!props.bridge"
        :height="120"
        :visible="props.visible"
      />
    </div>
    <NumericReadout
      class="bus-readout"
      :value="gainDb"
      :min="FADER_MIN_DB"
      :max="FADER_MAX_DB"
      :display="formatDb(gainDb)"
      unit="dB"
      :ariaLabel="t.shell.mixer.controls.stripGain"
      :disabled="followsFader"
      @change="(value) => onFaderChange(value, true)"
    />
    <StripGrMeter :bridge="props.bridge" :visible="props.visible" />

    <div v-if="props.scope?.available" class="strip-analyzers">
      <SpectrumAnalyzer :scope="props.scope" :height="32" :visible="props.visible" />
      <StereoGoniometer :scope="props.scope" :size="64" :visible="props.visible" />
    </div>
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

.bus-toggles {
  display: flex;
  justify-content: center;
  width: 100%;
}

.bus-toggle {
  width: 16px;
  height: 14px;
  border: none;
  border-radius: 3px;
  padding: 0;
  color: var(--text-3);
  background: var(--surface-3);
  font: var(--fw-bold) 9px var(--font-sans);
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.bus-toggle.mute.on {
  color: var(--surface-0);
  background: var(--warning);
}

.bus-auto-button {
  width: 19px;
  height: 16px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--surface-3);
  color: var(--text-4);
  font: var(--fw-bold) 8px var(--font-sans);
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

.bus-auto-button.on {
  color: var(--accent);
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
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
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
  font: var(--fs-xs) var(--font-sans);
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

.strip-analyzers {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-subtle);
}

</style>
