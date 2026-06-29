<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
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
  setStripInputTrim,
  setStripPolarityInvert,
  setStripWidth,
} from '@/project/commands';
import {
  DEFAULT_STRIP_WIDTH,
  MAX_INPUT_TRIM_DB,
  MAX_STRIP_WIDTH,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_WIDTH,
  type MixerBus,
} from '@/project/mixer';
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
import StripGrMeter from './StripGrMeter.vue';
import StripMeter from './StripMeter.vue';

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

// --- Output shaping popover (trim, width, polarity) ---------------------------

const optionsOpen = ref(false);
const optionsMenu = ref<HTMLDivElement | null>(null);

/** Current bus output trim in dB (0 when unset). */
const inputTrimDb = computed(() => props.bus.strip?.inputTrimDb ?? 0);
/** Current bus stereo width multiplier (1 when unset). */
const stripWidth = computed(() => props.bus.strip?.width ?? DEFAULT_STRIP_WIDTH);
const polarityLeft = computed(() => props.bus.strip?.polarityInvertLeft === true);
const polarityRight = computed(() => props.bus.strip?.polarityInvertRight === true);

/** True when any output-shaping control deviates from neutral. */
const hasStripOptions = computed(
  () =>
    inputTrimDb.value !== 0 ||
    stripWidth.value !== DEFAULT_STRIP_WIDTH ||
    polarityLeft.value ||
    polarityRight.value,
);

function onInputTrimInput(event: Event, commit: boolean): void {
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw)
    ? Math.min(MAX_INPUT_TRIM_DB, Math.max(MIN_INPUT_TRIM_DB, raw))
    : 0;
  setStripInputTrim(stripTarget.value, value, { commit });
}

function onWidthInput(event: Event, commit: boolean): void {
  const raw = Number.parseFloat((event.target as HTMLInputElement).value);
  const value = Number.isFinite(raw)
    ? Math.min(MAX_STRIP_WIDTH, Math.max(MIN_STRIP_WIDTH, raw))
    : DEFAULT_STRIP_WIDTH;
  setStripWidth(stripTarget.value, value, { commit });
}

function onPolarityToggle(channel: 'left' | 'right'): void {
  const left = channel === 'left' ? !polarityLeft.value : polarityLeft.value;
  const right = channel === 'right' ? !polarityRight.value : polarityRight.value;
  setStripPolarityInvert(stripTarget.value, left, right);
}

function onOptionsPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !optionsMenu.value?.contains(event.target)) {
    optionsOpen.value = false;
  }
}

watch(optionsOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onOptionsPointerDown, true);
  else document.removeEventListener('pointerdown', onOptionsPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOptionsPointerDown, true);
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
      <div ref="optionsMenu" class="strip-options">
        <button
          type="button"
          class="strip-options-btn"
          :class="{ on: hasStripOptions }"
          v-tooltip="t.shell.mixer.strip.options"
          :aria-label="formatMessage(t.shell.mixer.strip.optionsNamed, { name: props.bus.name })"
          aria-haspopup="menu"
          :aria-expanded="optionsOpen"
          @click="optionsOpen = !optionsOpen"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
            stroke-width="1.3" aria-hidden="true">
            <circle cx="8" cy="8" r="2.1" />
            <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
          </svg>
        </button>
        <Transition name="pop">
        <div v-if="optionsOpen" class="strip-options-popover" role="menu">
          <label class="strip-options-row">
            <span class="strip-options-label">{{ t.shell.mixer.strip.inputTrim }}</span>
            <span class="strip-options-field">
              <input
                type="range"
                :min="MIN_INPUT_TRIM_DB"
                :max="MAX_INPUT_TRIM_DB"
                step="0.5"
                :value="inputTrimDb"
                :aria-label="t.shell.mixer.strip.inputTrim"
                @input="onInputTrimInput($event, false)"
                @change="onInputTrimInput($event, true)"
              />
              <span class="strip-options-unit">{{ formatDb(inputTrimDb) }}</span>
            </span>
          </label>
          <label class="strip-options-row">
            <span class="strip-options-label">{{ t.shell.mixer.strip.width }}</span>
            <span class="strip-options-field">
              <input
                type="range"
                :min="MIN_STRIP_WIDTH"
                :max="MAX_STRIP_WIDTH"
                step="0.01"
                :value="stripWidth"
                :aria-label="t.shell.mixer.strip.width"
                @input="onWidthInput($event, false)"
                @change="onWidthInput($event, true)"
              />
              <span class="strip-options-unit">{{ stripWidth.toFixed(2) }}</span>
            </span>
          </label>
          <div class="strip-options-row">
            <span class="strip-options-label">{{ t.shell.mixer.strip.polarity }}</span>
            <span class="strip-options-field strip-options-toggles">
              <button
                type="button"
                class="toggle"
                :class="{ on: polarityLeft }"
                :aria-pressed="polarityLeft"
                :aria-label="t.shell.mixer.strip.polarityLeft"
                @click="onPolarityToggle('left')"
              >
                L
              </button>
              <button
                type="button"
                class="toggle"
                :class="{ on: polarityRight }"
                :aria-pressed="polarityRight"
                :aria-label="t.shell.mixer.strip.polarityRight"
                @click="onPolarityToggle('right')"
              >
                R
              </button>
            </span>
          </div>
        </div>
        </Transition>
      </div>
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
      <StripMeter :bridge="props.bridge" :placeholder="!props.bridge" :height="120" />
    </div>
    <span class="bus-readout">{{ formatDb(gainDb) }} dB</span>
    <StripGrMeter :bridge="props.bridge" />
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

/* Output-shaping popover (trim, width, polarity) — mirrors the channel strip. */
.strip-options {
  position: relative;
  flex: none;
}

.strip-options-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  line-height: 1;
  color: var(--text-4);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  cursor: pointer;
}

.strip-options-btn.on {
  color: var(--accent);
}

.strip-options-popover {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 20;
  min-width: 132px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-raised);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  transform-origin: top right;
}

.strip-options-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.strip-options-label {
  font: var(--fw-semibold) 8px var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.strip-options-field {
  display: flex;
  align-items: center;
  gap: 4px;
}

.strip-options-toggles {
  gap: var(--sp-1);
}

.strip-options-field input {
  width: 64px;
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--control-edge), var(--inset-well);
  padding: 1px 4px;
}

.strip-options-unit {
  font: 8px var(--font-sans);
  color: var(--text-4);
}

.toggle {
  width: 16px;
  height: 14px;
  font: 700 9px var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border: none;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

.toggle.on {
  color: var(--surface-0);
  background: var(--accent);
}
</style>
