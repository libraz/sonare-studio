<script setup lang="ts">
import { ref } from 'vue';
import LayoutPopover from '@/components/score/LayoutPopover.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useI18n } from '@/ui/i18n';
import type { ScorePageFormatKey } from '@/ui/score/layout';

/**
 * Toolbar for the engraved score: Display Quantize grid, transcribe / refresh,
 * chord toggle, annotate toggle, the layout popover host, on-screen zoom, page
 * navigation and the print / PDF / MusicXML export actions. The owner keeps the
 * notation state and pipeline; the toolbar only surfaces it and relays intents.
 */

defineProps<{
  /** Display Quantize options for the grid select. */
  dqOptions: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
  /** True while a render is in flight (disables transcribe / refresh / nav). */
  loading: boolean;
  /** True while a print/export action is running. */
  exporting: boolean;
  /** Total page count of the loaded score. */
  pageCount: number;
  /** Whether a MusicXML export source is available. */
  hasXml: boolean;
  /** On-screen zoom as a rounded percentage for the readout. */
  zoomPercent: number;
  /** Lower zoom bound; the zoom-out button disables at it. */
  zoomMin: number;
  /** Upper zoom bound; the zoom-in button disables at it. */
  zoomMax: number;
  /** Multiplicative step for one zoom notch. */
  zoomStep: number;
  /** Current on-screen zoom factor (compared against the bounds). */
  viewZoom: number;
  /** Current display transpose in semitones (driven by the project store). */
  transpose: number;
}>();

const dqKey = defineModel<string>('dqKey', { required: true });
const chordsEnabled = defineModel<boolean>('chordsEnabled', { required: true });
const fullScoreEnabled = defineModel<boolean>('fullScoreEnabled', { required: true });
const estimateFingering = defineModel<boolean>('estimateFingering', { required: true });
const annotateEnabled = defineModel<boolean>('annotateEnabled', { required: true });
const pageFormat = defineModel<ScorePageFormatKey>('pageFormat', { required: true });
const landscape = defineModel<boolean>('landscape', { required: true });
const pageMarginMm = defineModel<number>('pageMarginMm', { required: true });
const scalePercent = defineModel<number>('scalePercent', { required: true });
const spacingStaff = defineModel<number>('spacingStaff', { required: true });
const barsPerSystem = defineModel<number>('barsPerSystem', { required: true });
const barsPerPage = defineModel<number>('barsPerPage', { required: true });
const grandStaffSplitPitch = defineModel<number>('grandStaffSplitPitch', { required: true });
const page = defineModel<number>('page', { required: true });

const emit = defineEmits<{
  /** Run the full transcription pipeline. */
  transcribe: [];
  /** Re-render the current page from the loaded score. */
  refresh: [];
  /** Multiply the on-screen zoom by a factor. */
  zoom: [factor: number];
  /** Navigate to a target page (clamped by the owner). */
  gotoPage: [target: number];
  /** Print the score. */
  print: [];
  /** Export the score to PDF. */
  exportPdf: [];
  /** Export the score's MusicXML. */
  exportMusicXml: [];
  /** Export the current part as MusicXML. */
  exportPartMusicXml: [];
  /** Request a display transpose change in semitones. */
  transposeChange: [value: number];
}>();

const { t } = useI18n();

const layoutOpen = ref(false);
</script>

<template>
  <div class="score-toolbar" role="toolbar" :aria-label="t.shell.score.tools">
    <label class="bar-field" v-tooltip="t.shell.score.displayQuantizeTitle">
      {{ t.shell.score.displayQuantizeShort }}
      <SelectMenu
        v-model="dqKey"
        :options="dqOptions"
        :aria-label="t.shell.score.displayQuantize"
        size="sm"
      />
    </label>
    <button
      type="button"
      :disabled="loading"
      v-tooltip="t.shell.score.transcribeTitle"
      @click="emit('transcribe')"
    >
      {{ t.shell.score.transcribe }}
    </button>
    <button
      type="button"
      :disabled="loading || pageCount === 0"
      v-tooltip="t.shell.score.refreshTitle"
      @click="emit('refresh')"
    >
      {{ t.shell.score.refresh }}
    </button>
    <ToggleButton
      v-model="chordsEnabled"
      :label="t.shell.score.chords"
      :title="t.shell.score.chordsTitle"
      size="sm"
    />
    <ToggleButton
      v-model="fullScoreEnabled"
      :label="t.shell.score.fullScore"
      :title="t.shell.score.fullScoreTitle"
      size="sm"
    />
    <ToggleButton
      v-model="estimateFingering"
      :label="t.shell.score.fingering"
      :title="t.shell.score.fingeringTitle"
      size="sm"
    />
    <ToggleButton
      v-model="annotateEnabled"
      :label="t.shell.score.annotate"
      :title="t.shell.score.annotateTitle"
      size="sm"
    />
    <div class="layout-host">
      <button type="button" aria-haspopup="true" :aria-expanded="layoutOpen" @click="layoutOpen = !layoutOpen">
        {{ t.shell.score.layout }}
      </button>
      <Transition name="popover">
        <LayoutPopover
          v-if="layoutOpen"
          v-model:page-format="pageFormat"
          v-model:landscape="landscape"
          v-model:page-margin-mm="pageMarginMm"
          v-model:scale-percent="scalePercent"
          v-model:spacing-staff="spacingStaff"
          v-model:bars-per-system="barsPerSystem"
          v-model:bars-per-page="barsPerPage"
          v-model:grand-staff-split-pitch="grandStaffSplitPitch"
          :transpose="transpose"
          @transpose-change="emit('transposeChange', $event)"
        />
      </Transition>
    </div>
    <div class="score-zoom" role="group" :aria-label="t.shell.score.zoom">
      <button
        type="button"
        class="score-zoom-btn"
        :disabled="viewZoom <= zoomMin"
        :aria-label="t.shell.score.zoomOut"
        v-tooltip="t.shell.score.zoomOut"
        @click="emit('zoom', 1 / zoomStep)"
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path
            d="M3 7h8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <span class="score-zoom-readout" aria-live="polite">{{ zoomPercent }}%</span>
      <button
        type="button"
        class="score-zoom-btn"
        :disabled="viewZoom >= zoomMax"
        :aria-label="t.shell.score.zoomIn"
        v-tooltip="t.shell.score.zoomIn"
        @click="emit('zoom', zoomStep)"
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path
            d="M7 3v8M3 7h8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
    <span class="bar-spacer" />
    <button
      type="button"
      :disabled="page <= 1 || loading"
      :aria-label="t.shell.score.previousPage"
      @click="emit('gotoPage', page - 1)"
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <path
          d="M9 3L5 7l4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <span class="score-page-indicator" aria-live="polite">
      {{ pageCount > 0 ? `${page} / ${pageCount}` : '– / –' }}
    </span>
    <button
      type="button"
      :disabled="page >= pageCount || loading"
      :aria-label="t.shell.score.nextPage"
      @click="emit('gotoPage', page + 1)"
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <path
          d="M5 3l4 4-4 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <span class="bar-spacer" />
    <button type="button" :disabled="exporting || pageCount === 0" @click="emit('print')">
      {{ t.shell.score.print }}
    </button>
    <button type="button" :disabled="exporting || pageCount === 0" @click="emit('exportPdf')">
      PDF
    </button>
    <button type="button" :disabled="exporting || !hasXml" @click="emit('exportMusicXml')">
      MusicXML
    </button>
    <button type="button" :disabled="exporting || !hasXml" @click="emit('exportPartMusicXml')">
      Part XML
    </button>
  </div>
</template>

<style scoped src="./score-toolbar.css"></style>
