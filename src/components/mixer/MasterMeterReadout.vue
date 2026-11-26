<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatLevel, isClippingRisk } from '@/ui/mastering/loudness';
import {
  correlationFraction,
  gainReductionAmountDb,
  gainReductionFraction,
  hasLoudnessData,
  loudnessDeltaLu,
  maxTruePeakDbtp,
} from '@/ui/mixer/master-meter';

/**
 * Master-strip loudness readout: momentary / short-term / integrated LUFS, the
 * true-peak ceiling (flagged when it risks clipping on lossy encodes) and a
 * stereo phase-correlation bar. All values come straight from the master meter
 * source's full record; the readout hides itself when the source carries no
 * loudness data (a silent source or a lightweight lane/bus record).
 */

const props = withDefaults(
  defineProps<{
    /** Master meter source; null leaves the readout empty. */
    bridge?: MeterSource | null;
    /** Integrated-loudness target in LUFS the readout shows the delta against. */
    targetLufs?: number;
    /** Whether the mixer dock is visible and this readout should refresh. */
    visible?: boolean;
  }>(),
  { bridge: null, targetLufs: -14, visible: true },
);

const { t } = useI18n();

/** Display refresh interval; LUFS values move slowly, so ~10 Hz is plenty. */
const REFRESH_MS = 100;

const levels = ref<StereoMeterLevels | null>(null);

/** Active gain-reduction magnitude (dB), or null when the master is not reducing. */
const gainReduction = computed<number | null>(
  () => gainReductionAmountDb(levels.value?.gainReductionDb) ?? null,
);

/** Integrated-loudness delta against the target in LU, or null when unmeasured. */
const loudnessDelta = computed<number | null>(
  () => loudnessDeltaLu(levels.value?.integratedLufs, props.targetLufs) ?? null,
);

/** True once the master is louder than the target by more than the tolerance. */
const overTarget = computed(() => loudnessDelta.value !== null && loudnessDelta.value > 0.5);

/** Signed, one-decimal delta text (e.g. "+2.3" / "-1.0"). */
const loudnessDeltaText = computed(() => {
  const delta = loudnessDelta.value;
  if (delta === null) return '';
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
});

let rafId = 0;
let lastTs = 0;

function stopRefresh(): void {
  if (rafId !== 0) cancelAnimationFrame(rafId);
  rafId = 0;
  lastTs = 0;
}

function startRefresh(): void {
  if (!props.visible || rafId !== 0) return;
  rafId = requestAnimationFrame(tick);
}

function tick(ts: number): void {
  if (!props.visible) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(tick);
  if (ts - lastTs < REFRESH_MS) return;
  lastTs = ts;
  const latest = props.bridge?.latest;
  levels.value = latest && hasLoudnessData(latest) ? latest : null;
}

onMounted(() => {
  startRefresh();
});

onBeforeUnmount(() => {
  stopRefresh();
});

watch(
  () => props.visible,
  (visible) => {
    if (visible) startRefresh();
    else stopRefresh();
  },
);
</script>

<template>
  <div v-if="levels" class="master-meter" :aria-label="t.shell.mixer.loudness.region">
    <div class="mm-lufs">
      <div class="mm-cell" v-tooltip="t.shell.mixer.loudness.momentaryHint">
        <span class="mm-label">{{ t.shell.mixer.loudness.momentary }}</span>
        <span class="mm-value">{{ formatLevel(levels.momentaryLufs) }}</span>
      </div>
      <div class="mm-cell" v-tooltip="t.shell.mixer.loudness.shortTermHint">
        <span class="mm-label">{{ t.shell.mixer.loudness.shortTerm }}</span>
        <span class="mm-value">{{ formatLevel(levels.shortTermLufs) }}</span>
      </div>
      <div class="mm-cell" v-tooltip="t.shell.mixer.loudness.integratedHint">
        <span class="mm-label">{{ t.shell.mixer.loudness.integrated }}</span>
        <span class="mm-value">{{ formatLevel(levels.integratedLufs) }}</span>
      </div>
    </div>
    <div class="mm-unit">{{ t.shell.mixer.loudness.lufs }}</div>
    <div
      v-if="loudnessDelta !== null"
      class="mm-target"
      :class="{ over: overTarget }"
      v-tooltip="t.shell.mixer.loudness.targetHint"
    >
      <span class="mm-label">{{ formatMessage(t.shell.mixer.loudness.target, { target: String(props.targetLufs) }) }}</span>
      <span class="mm-value">{{ loudnessDeltaText }}</span>
      <span class="mm-unit-inline">{{ t.shell.mixer.loudness.lu }}</span>
    </div>
    <div
      class="mm-tp"
      :class="{ risk: isClippingRisk(maxTruePeakDbtp(levels)) }"
      v-tooltip="t.shell.mixer.loudness.truePeakHint"
    >
      <span class="mm-label">{{ t.shell.mixer.loudness.truePeak }}</span>
      <span class="mm-value">{{ formatLevel(maxTruePeakDbtp(levels)) }}</span>
      <span class="mm-unit-inline">{{ t.shell.mixer.loudness.dbtp }}</span>
    </div>
    <div
      v-if="gainReduction !== null"
      class="mm-gr"
      v-tooltip="t.shell.mixer.loudness.gainReductionHint"
    >
      <span class="mm-label">{{ t.shell.mixer.loudness.gainReduction }}</span>
      <span class="mm-gr-track">
        <span class="mm-gr-fill" :style="{ width: `${gainReductionFraction(gainReduction) * 100}%` }" />
      </span>
      <span class="mm-value">-{{ formatLevel(gainReduction) }}</span>
    </div>
    <div
      v-if="levels.correlation !== undefined"
      class="mm-corr"
      role="meter"
      :aria-label="t.shell.mixer.loudness.correlation"
      v-tooltip="t.shell.mixer.loudness.correlation"
      :aria-valuenow="Number(levels.correlation.toFixed(2))"
      aria-valuemin="-1"
      aria-valuemax="1"
    >
      <span class="mm-label">{{ t.shell.mixer.loudness.phase }}</span>
      <span class="mm-corr-track">
        <span class="mm-corr-center" />
        <span
          class="mm-corr-fill"
          :class="{ neg: levels.correlation < 0 }"
          :style="{ left: `${Math.min(50, correlationFraction(levels.correlation) * 100)}%`, right: `${Math.min(50, 100 - correlationFraction(levels.correlation) * 100)}%` }"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.master-meter {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2) 0 0;
  border-top: 1px solid var(--border-subtle);
}

.mm-lufs {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
}

.mm-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.mm-label {
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-4);
  text-transform: uppercase;
}

.mm-value {
  font: var(--fs-2xs) var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}

.mm-unit {
  text-align: center;
  font: var(--fw-bold) var(--fs-chrome-sm) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
}

.mm-target {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 3px;
}

.mm-target .mm-value {
  color: var(--success);
}

.mm-target.over .mm-value {
  color: var(--warning);
  font-weight: 700;
}

.mm-tp {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 3px;
  margin-top: 1px;
}

.mm-tp.risk .mm-value {
  color: var(--danger-text);
  font-weight: 700;
}

.mm-unit-inline {
  font: var(--fs-chrome-sm) var(--font-sans);
  color: var(--text-4);
}

.mm-gr {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.mm-gr-track {
  position: relative;
  flex: 1;
  height: 4px;
  background: var(--surface-inset);
  border-radius: 2px;
  box-shadow: var(--inset-well);
  overflow: hidden;
}

.mm-gr-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: var(--meter-yellow);
}

.mm-corr {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.mm-corr-track {
  position: relative;
  flex: 1;
  height: 4px;
  background: var(--surface-inset);
  border-radius: 2px;
  box-shadow: var(--inset-well);
  overflow: hidden;
}

.mm-corr-center {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-strong);
}

.mm-corr-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--meter-green);
}

.mm-corr-fill.neg {
  background: var(--meter-red);
}
</style>
