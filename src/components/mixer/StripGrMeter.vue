<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import { useI18n } from '@/ui/i18n';
import { formatLevel } from '@/ui/mastering/loudness';
import { gainReductionAmountDb, gainReductionFraction } from '@/ui/mixer/master-meter';

/**
 * Compact per-strip gain-reduction readout: a thin right-anchored bar plus a
 * dB magnitude, shown for any track or bus strip whose insert chain reports
 * dynamics gain reduction. Stays hidden while the strip is not reducing so
 * neutral strips show no clutter. The master strip uses the richer
 * MasterMeterReadout instead.
 */

const props = withDefaults(
  defineProps<{
    /** Strip meter source; null leaves the readout hidden. */
    bridge?: MeterSource | null;
  }>(),
  { bridge: null },
);

const { t } = useI18n();

const amountDb = ref<number | null>(null);

/** Bar fraction (0..1) of the current reduction over the display scale. */
const fraction = computed(() =>
  amountDb.value === null ? 0 : gainReductionFraction(amountDb.value),
);

let unsubscribe: (() => void) | null = null;

function update(levels: StereoMeterLevels | undefined): void {
  amountDb.value = gainReductionAmountDb(levels?.gainReductionDb) ?? null;
}

watch(
  () => props.bridge,
  (bridge) => {
    unsubscribe?.();
    unsubscribe = null;
    update(bridge?.latest);
    if (bridge) unsubscribe = bridge.subscribe(update);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <div
    v-if="amountDb !== null"
    class="strip-gr"
    role="meter"
    :aria-label="t.shell.mixer.loudness.gainReduction"
    :aria-valuenow="Number(amountDb.toFixed(1))"
    aria-valuemin="0"
  >
    <span class="strip-gr-label">{{ t.shell.mixer.loudness.gainReduction }}</span>
    <span class="strip-gr-track">
      <span class="strip-gr-fill" :style="{ width: `${fraction * 100}%` }" />
    </span>
    <span class="strip-gr-value">-{{ formatLevel(amountDb) }}</span>
  </div>
</template>

<style scoped>
.strip-gr {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.strip-gr-label {
  font: var(--fw-bold) 7px var(--font-sans);
  letter-spacing: 0.04em;
  color: var(--text-4);
  text-transform: uppercase;
}

.strip-gr-track {
  position: relative;
  flex: 1;
  height: 4px;
  background: var(--surface-inset);
  border-radius: 2px;
  box-shadow: var(--inset-well);
  overflow: hidden;
}

.strip-gr-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: #f59e0b;
}

.strip-gr-value {
  font: 9px var(--font-mono);
  color: var(--text-2);
}
</style>
