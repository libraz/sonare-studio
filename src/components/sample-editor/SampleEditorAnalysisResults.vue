<script setup lang="ts">
import type { MasteringRepairAnalysis, MasteringRepairStageName } from '@libraz/libsonare';
import { computed } from 'vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useI18n } from '@/ui/i18n';
import type { MatchEqAnalysis } from '@/ui/sample-editor/match-eq-analysis';
import { declipWithheld, repairChannelSummaries } from '@/ui/sample-editor/repair-analysis';
import {
  type AcousticAnalysisSummary,
  formatMeasure,
  type RoomEstimateSummary,
  roomEstimateHasGeometry,
} from '@/ui/sample-editor/room-acoustics';
import {
  MATCH_EQ_CURVE_HEIGHT,
  MATCH_EQ_CURVE_WIDTH,
} from '@/ui/sample-editor/use-sample-operations';

const props = defineProps<{
  repairAnalysis: MasteringRepairAnalysis | null;
  repairStageChecked: Partial<Record<MasteringRepairStageName, boolean>>;
  repairStagesBlocked: string | null;
  applyRepairBlocked: string | null;
  matchEqAnalysis: MatchEqAnalysis | null;
  matchEqCurvePoints: string;
  roomEstimate: RoomEstimateSummary | null;
  acousticAnalysis: AcousticAnalysisSummary | null;
}>();

const emit = defineEmits<{
  'set-repair-stage': [stage: MasteringRepairStageName, checked: boolean];
  'apply-repair': [];
}>();

const { t } = useI18n();
const se = computed(() => t.value.shell.sampleEditor);

const repairSummaries = computed(() =>
  props.repairAnalysis ? repairChannelSummaries(props.repairAnalysis) : [],
);

/** Tooltip of a repair stage toggle: the single-stage button's description. */
function repairStageTitle(stage: MasteringRepairStageName): string {
  const text = t.value.shell.sampleEditor;
  const titles: Record<MasteringRepairStageName, string> = {
    declip: text.declipTitle,
    declick: text.declickTitle,
    decrackle: text.decrackleTitle,
    dehum: text.dehumTitle,
    denoise: text.denoiseTitle,
    dereverb: text.dereverbTitle,
  };
  return titles[stage];
}
</script>

<template>
  <div v-if="repairAnalysis" class="match-eq-analysis repair-analysis" role="status">
    <div class="match-eq-head">
      <span class="match-eq-title">{{ se.repairAnalysisTitle }}</span>
      <span v-if="Number.isFinite(repairAnalysis.integratedLufs)" class="match-eq-loudness">
        {{ repairAnalysis.integratedLufs.toFixed(1) }} LUFS
      </span>
    </div>
    <dl class="repair-channels">
      <template v-for="row in repairSummaries" :key="row.channel">
        <dt>{{ row.channel }}</dt>
        <dd>
          <span v-for="item in row.items" :key="item.kind" class="repair-defect">
            <span class="repair-defect-label">{{ se.repairDefects[item.kind] }}</span>
            {{ item.value }}
          </span>
          <span v-if="row.items.length === 0">—</span>
        </dd>
      </template>
    </dl>
    <p v-if="declipWithheld(repairAnalysis)" class="repair-note">
      {{ se.repairDeclipWithheld }}
    </p>
    <div
      v-if="repairAnalysis.recommended.length > 0"
      class="toolbar"
      role="group"
      :aria-label="se.repairStages"
    >
      <ToggleButton
        v-for="stage in repairAnalysis.recommended"
        :key="stage.stage"
        :model-value="repairStageChecked[stage.stage] === true"
        :label="se[stage.stage]"
        :title="repairStageTitle(stage.stage)"
        :reason="repairStagesBlocked"
        size="sm"
        @update:model-value="(checked: boolean) => emit('set-repair-stage', stage.stage, checked)"
      />
      <button
        type="button"
        :disabled="!!applyRepairBlocked"
        v-tooltip="{ text: se.repairApplyTitle, reason: applyRepairBlocked }"
        @click="emit('apply-repair')"
      >
        {{ se.repairApply }}
      </button>
    </div>
    <p v-else class="repair-note">{{ se.repairNoStages }}</p>
  </div>
  <div v-if="matchEqAnalysis" class="match-eq-analysis">
    <div class="match-eq-head">
      <span class="match-eq-title">{{ se.matchEqAnalysisTitle }}</span>
      <span v-if="matchEqAnalysis.loudness" class="match-eq-loudness">
        {{ se.matchEqLoudness }}:
        {{ matchEqAnalysis.loudness.sourceLufs.toFixed(1) }} →
        {{ matchEqAnalysis.loudness.referenceLufs.toFixed(1) }} LUFS
        ({{ matchEqAnalysis.loudness.gainToMatchDb >= 0 ? '+' : ''
        }}{{ matchEqAnalysis.loudness.gainToMatchDb.toFixed(1) }} dB)
      </span>
    </div>
    <svg
      v-if="matchEqCurvePoints"
      class="match-eq-curve"
      :viewBox="`0 0 ${MATCH_EQ_CURVE_WIDTH} ${MATCH_EQ_CURVE_HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="se.matchEqCurveLabel"
    >
      <line
        class="match-eq-zero"
        x1="0"
        :y1="MATCH_EQ_CURVE_HEIGHT / 2"
        :x2="MATCH_EQ_CURVE_WIDTH"
        :y2="MATCH_EQ_CURVE_HEIGHT / 2"
      />
      <polyline class="match-eq-line" :points="matchEqCurvePoints" />
    </svg>
    <ul v-if="matchEqAnalysis.tonalBalance.length > 0" class="match-eq-bands">
      <li
        v-for="(band, index) in matchEqAnalysis.tonalBalance"
        :key="index"
        :class="{ over: band.deviationDb > 0, under: band.deviationDb < 0 }"
      >
        <span class="match-eq-band-hz">{{ Math.round(band.lowHz) }}–{{ Math.round(band.highHz) }} Hz</span>
        <span class="match-eq-band-db">
          {{ band.deviationDb >= 0 ? '+' : '' }}{{ band.deviationDb.toFixed(1) }} dB
        </span>
      </li>
    </ul>
  </div>
  <div v-if="roomEstimate" class="match-eq-analysis room-estimate" role="status">
    <div class="match-eq-head">
      <span class="match-eq-title">{{ se.roomEstimateTitle }}</span>
      <span class="match-eq-loudness">
        {{ se.roomEstimateConfidence }}:
        {{ Math.round(roomEstimate.confidence * 100) }}%
      </span>
    </div>
    <dl class="room-estimate-grid">
      <dt>{{ se.roomEstimateSize }}</dt>
      <dd v-if="roomEstimateHasGeometry(roomEstimate)">
        {{ roomEstimate.length.toFixed(1) }} × {{ roomEstimate.width.toFixed(1) }} ×
        {{ roomEstimate.height.toFixed(1) }} m
      </dd>
      <dd v-else>—</dd>
      <dt>{{ se.roomEstimateVolume }}</dt>
      <dd>{{ formatMeasure(roomEstimate.volume, 0, ' m³') }}</dd>
      <dt>{{ se.roomEstimateRt60 }}</dt>
      <dd>{{ formatMeasure(roomEstimate.rt60Mid, 2, ' s') }}</dd>
      <dt>{{ se.roomEstimateDrr }}</dt>
      <dd>{{ formatMeasure(roomEstimate.drrDb, 1, ' dB') }}</dd>
    </dl>
  </div>
  <div v-if="acousticAnalysis" class="match-eq-analysis room-estimate" role="status">
    <div class="match-eq-head">
      <span class="match-eq-title">
        {{
          acousticAnalysis.kind === 'impulse'
            ? se.impulseAnalysisTitle
            : se.acousticAnalysisTitle
        }}
      </span>
      <span class="match-eq-loudness">
        {{ se.roomEstimateConfidence }}:
        {{ Math.round(acousticAnalysis.confidence * 100) }}%
      </span>
    </div>
    <dl class="room-estimate-grid">
      <dt>{{ se.roomEstimateRt60 }}</dt>
      <dd>{{ formatMeasure(acousticAnalysis.rt60, 2, ' s') }}</dd>
      <dt>{{ se.acousticEdt }}</dt>
      <dd>{{ formatMeasure(acousticAnalysis.edt, 2, ' s') }}</dd>
      <dt>{{ se.acousticClarity }}</dt>
      <dd>
        C50 {{ formatMeasure(acousticAnalysis.c50, 1, ' dB') }} / C80
        {{ formatMeasure(acousticAnalysis.c80, 1, ' dB') }}
      </dd>
      <dt>{{ se.acousticDefinition }}</dt>
      <dd>{{ formatMeasure(Math.round(acousticAnalysis.d50 * 100), 0, '%') }}</dd>
    </dl>
  </div>
</template>

<style scoped src="./sample-editor-panel.css"></style>

<style scoped>
.match-eq-analysis {
  animation: view-enter var(--dur-2) var(--ease-out);
}

.repair-channels,
.room-estimate-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--sp-1) var(--sp-4);
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.repair-channels dt,
.room-estimate-grid dt {
  color: var(--text-3);
  font-weight: var(--fw-semibold);
}

.repair-channels dd {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-5);
  margin: 0;
  color: var(--text-1);
}

.room-estimate-grid dd {
  margin: 0;
  color: var(--text-1);
}

.repair-defect-label {
  color: var(--text-3);
}

.repair-note {
  margin: 0;
  color: var(--text-3);
}

.match-eq-analysis {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.match-eq-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-4);
  justify-content: space-between;
}

.match-eq-title {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.match-eq-loudness {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.match-eq-curve {
  width: 100%;
  height: 64px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.match-eq-zero {
  stroke: var(--border);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.match-eq-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.match-eq-bands {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-5);
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}

.match-eq-bands li {
  display: flex;
  gap: var(--sp-2);
  color: var(--text-3);
}

.match-eq-bands li.over .match-eq-band-db {
  color: var(--warning);
}

.match-eq-bands li.under .match-eq-band-db {
  color: var(--accent);
}
</style>
