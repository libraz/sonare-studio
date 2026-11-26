<script setup lang="ts">
import { useI18n } from '@/ui/i18n';
import { formatLevel } from '@/ui/mastering/loudness';
import type { StreamingTarget } from '@/ui/mastering/streaming';

/**
 * Per-platform streaming loudness table: for each target it shows the measured
 * integrated loudness, the normalization gain the platform would apply and the
 * resulting true peak, flagging platforms whose normalized peak risks clipping
 * the ceiling. The wasm measurement is owned by the panel; this component only
 * renders the targets.
 */

defineProps<{
  /** Per-platform loudness verdicts to display. */
  targets: ReadonlyArray<StreamingTarget>;
}>();

const { t } = useI18n();

/** Normalization gain with an explicit sign (e.g. '+1.2', '-3.4'). */
function signedGain(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatLevel(value)}`;
}

/** An unavailable normalization amount is distinct from a measured zero. */
function formatGain(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? '—' : signedGain(value);
}
</script>

<template>
  <table class="targets-table">
    <thead>
      <tr>
        <th class="targets-name">{{ t.shell.mastering.streaming.platform }}</th>
        <th>{{ t.shell.mastering.streaming.lufs }}</th>
        <th v-tooltip="t.shell.mastering.streaming.gainTitle">
          {{ t.shell.mastering.streaming.gain }}
        </th>
        <th v-tooltip="t.shell.mastering.streaming.peakTitle">
          {{ t.shell.mastering.streaming.peak }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="target in targets" :key="target.name">
        <td class="targets-name">{{ target.name }}</td>
        <td>{{ formatLevel(target.integratedLufs) }}</td>
        <td>{{ formatGain(target.normalizationGainDb) }}</td>
        <td :class="{ risk: target.ceilingRisk }" v-tooltip="target.ceilingRisk ? t.shell.mastering.streaming.ceilingRisk : ''">
          {{ formatLevel(target.truePeakDbtp) }}<svg
            v-if="target.ceilingRisk"
            class="targets-warn-icon"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          ><path d="M8 2.5 14.5 13.5H1.5Z" /><path d="M8 6.5v3.2" /><path d="M8 11.8v0.2" /></svg>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped src="./streaming-targets-table.css"></style>
