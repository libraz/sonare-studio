<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { promptDialog } from '@/composables/useDialogs';
import type { MeterSource } from '@/engine/meters';
import type { ScopeSource } from '@/engine/scope';
import {
  type BusAutomationTarget,
  busAutomationTarget,
  evaluateAutomationValue,
} from '@/project/automation';
import { assertNoBusRoutingCycle, mixerBusTopology } from '@/project/bus-topology';
import { setMixerBusChannelLayout } from '@/project/command/mixer';
import {
  mixerBusStripTarget,
  removeMixerBus,
  renameMixerBus,
  setAutomationLanePoints,
  setMixerBusGain,
  setMixerBusMute,
  setMixerBusSolo,
  setStripOutputBus,
  setStripPan,
} from '@/project/commands';
import {
  canRouteReturnSolo,
  DEFAULT_STRIP_WIDTH,
  MIXER_CHANNEL_LAYOUTS,
  type MixerBus,
  type MixerChannelLayout,
} from '@/project/mixer';
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
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, formatPan } from '@/ui/mixer/db-scale';
import type { SidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';
import InsertRack from './InsertRack.vue';
import MixerFader from './MixerFader.vue';
import MixerKnob from './MixerKnob.vue';
import NumericReadout from './NumericReadout.vue';
import SpectrumAnalyzer from './SpectrumAnalyzer.vue';
import StereoGoniometer from './StereoGoniometer.vue';
import StripEqSection from './StripEqSection.vue';
import StripGrMeter from './StripGrMeter.vue';
import StripMeter from './StripMeter.vue';
import StripOptionsPopover from './StripOptionsPopover.vue';
import StripSends from './StripSends.vue';

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
    /** Engine sidechain refusal lookup for the insert key picker. */
    sidechainRefusal?: SidechainRefusalLookup | null;
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
    sidechainRefusal: null,
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
const pan = computed(() => props.bus.strip?.pan ?? 0);
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
const channelLayout = computed<MixerChannelLayout>(() => props.bus.channelLayout ?? 'stereo');
const isSurroundBus = computed(
  () => channelLayout.value === '5.1' || channelLayout.value === '7.1',
);
const hasStereoPannerState = computed(() => {
  const strip = props.bus.strip;
  return (
    strip !== undefined &&
    ((strip.width ?? DEFAULT_STRIP_WIDTH) !== DEFAULT_STRIP_WIDTH ||
      (strip.pan ?? 0) !== 0 ||
      strip.panMode !== undefined ||
      strip.panLaw !== undefined ||
      strip.dualPan !== undefined)
  );
});
const outputBusValue = computed(() => props.bus.strip?.outputBusId ?? '');
const channelLayoutError = ref('');

/** A return bus can route into another return bus, but never itself or a cycle. */
function isOutputBusAllowed(busId: string): boolean {
  if (busId === props.bus.id) return false;
  try {
    assertNoBusRoutingCycle(
      mixerBusTopology(
        store.mixer,
        store.tracks
          .filter((track) => track.kind === 'group')
          .map((track) => ({ id: track.id, mixer: track.mixer })),
      ),
      props.bus.id,
      busId,
    );
    return true;
  } catch {
    return false;
  }
}

const outputBusOptions = computed(() => [
  { value: '', label: t.value.shell.mixer.strip.master },
  ...store.mixer.buses.map((bus) => ({
    value: bus.id,
    label: bus.name,
    disabled: !isOutputBusAllowed(bus.id),
  })),
]);

const channelLayoutOptions = computed(() =>
  MIXER_CHANNEL_LAYOUTS.map((layout) => {
    const disabled = hasStereoPannerState.value && (layout === '5.1' || layout === '7.1');
    return {
      value: layout,
      label: t.value.shell.mixer.strip.channelLayouts[layout],
      ...(disabled
        ? {
            disabled: true,
            detail: t.value.shell.mixer.strip.surroundLayoutRequiresNeutral,
          }
        : {}),
    };
  }),
);
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

function onPanChange(value: number, commit: boolean): void {
  setStripPan(stripTarget.value, value, { commit });
}

function onOutputBusChange(value: string): void {
  if (value !== '' && !isOutputBusAllowed(value)) return;
  setStripOutputBus(stripTarget.value, value === '' ? null : value);
}

function onChannelLayoutChange(value: MixerChannelLayout): void {
  if (hasStereoPannerState.value && (value === '5.1' || value === '7.1')) {
    channelLayoutError.value = t.value.shell.mixer.strip.surroundLayoutRequiresNeutral;
    return;
  }
  try {
    setMixerBusChannelLayout(props.bus.id, value === 'stereo' ? null : value);
    channelLayoutError.value = '';
  } catch {
    channelLayoutError.value = t.value.shell.mixer.strip.surroundLayoutRequiresNeutral;
  }
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
      <InsertRack
        :target="stripTarget"
        :meter="props.bridge"
        :visible="props.visible"
        :sidechain-refusal="props.sidechainRefusal"
      />
    </div>
    <div class="bus-eq">
      <StripEqSection :target="stripTarget" :scope="props.scope" />
    </div>
    <div v-if="store.mixer.buses.length > 0" class="bus-routing">
      <div class="bus-route-row">
        <span class="bus-route-label">{{ t.shell.mixer.strip.output }}</span>
        <SelectMenu
          :model-value="outputBusValue"
          size="sm"
          :options="outputBusOptions"
          :aria-label="formatMessage(t.shell.mixer.strip.outputBus, { name: props.bus.name })"
          @change="onOutputBusChange"
        />
      </div>
      <div class="bus-route-row">
        <span class="bus-route-label">{{ t.shell.mixer.strip.channelLayout }}</span>
        <SelectMenu
          :model-value="channelLayout"
          size="sm"
          :options="channelLayoutOptions"
          :aria-label="t.shell.mixer.strip.channelLayout"
          @change="(value) => onChannelLayoutChange(value as MixerChannelLayout)"
        />
      </div>
      <span v-if="channelLayoutError" class="bus-route-error" role="alert" aria-live="polite">
        {{ channelLayoutError }}
      </span>
    </div>
    <div v-if="store.mixer.buses.length > 0" class="bus-sends">
      <StripSends :target="stripTarget" />
    </div>
    <div
      class="bus-pan"
      :class="{ disabled: isSurroundBus }"
      v-tooltip="isSurroundBus ? t.shell.mixer.strip.stereoControlsUnavailable : undefined"
    >
      <div class="bus-pan-knob">
        <MixerKnob
          :value="pan"
          :min="-1"
          :max="1"
          :default-value="0"
          :label="t.shell.mixer.strip.pan"
          :display="formatPan(pan)"
          :size="24"
          :disabled="isSurroundBus"
          @change="onPanChange"
        />
        <NumericReadout
          :value="pan"
          :min="-1"
          :max="1"
          :step="0.01"
          :display="formatPan(pan)"
          :ariaLabel="t.shell.mixer.strip.pan"
          :disabled="isSurroundBus"
          @change="(value) => onPanChange(value, true)"
        />
      </div>
      <span v-if="isSurroundBus" class="bus-pan-note" role="note">
        {{ t.shell.mixer.strip.stereoOnly }}
      </span>
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

.bus-eq {
  width: 100%;
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--sp-2);
}

.bus-routing,
.bus-sends {
  width: 100%;
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--sp-2);
}

.bus-routing {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.bus-route-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.bus-route-label {
  flex: none;
  width: 2.25rem;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-4);
  user-select: none;
}

.bus-route-row :deep(.select-menu) {
  min-width: 0;
  flex: 1;
}

.bus-route-row :deep(.select-trigger) {
  width: 100%;
  min-width: 0;
}

.bus-route-error {
  font: var(--fs-2xs) / 1.3 var(--font-sans);
  color: var(--danger-text);
}

.bus-pan {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  width: 100%;
}

.bus-pan.disabled {
  color: var(--text-4);
  cursor: not-allowed;
  opacity: 0.72;
}

.bus-pan-note {
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-4);
  user-select: none;
}

.bus-pan-knob {
  display: flex;
  align-items: center;
  gap: 2px;
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
  font: var(--fw-bold) var(--fs-chrome-lg) var(--font-sans);
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
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
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
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
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
  font: var(--fw-medium) var(--fs-chrome-lg) var(--font-mono);
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
