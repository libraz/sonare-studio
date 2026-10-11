<script setup lang="ts">
import { computed, ref } from 'vue';
import LayoutPopover from '@/components/score/LayoutPopover.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import type { ScoreDisplayQuantizeKey } from '@/project/annotations';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { ScorePageFormatKey } from '@/ui/score/layout';

/**
 * Toolbar for the engraved score: Display Quantize grid, transcribe / refresh,
 * chord toggle, annotate toggle, the layout popover host, on-screen zoom, page
 * navigation and the print / PDF / MusicXML export actions. The owner keeps the
 * notation state and pipeline; the toolbar only surfaces it and relays intents.
 */

const props = defineProps<{
  /** Display Quantize options for the grid select. */
  dqOptions: ReadonlyArray<{
    value: ScoreDisplayQuantizeKey;
    label: string;
    disabled?: boolean;
  }>;
  /** True while a render is in flight (disables transcribe / refresh / nav). */
  loading: boolean;
  /** True while a print/export action is running. */
  exporting: boolean;
  /** Total page count of the loaded score. */
  pageCount: number;
  /** Whether a MusicXML export source is available. */
  hasXml: boolean;
  /** Active track's exported part name, or empty when it has no score part. */
  partName: string;
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

const dqKey = defineModel<ScoreDisplayQuantizeKey>('dqKey', { required: true });
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

const reasons = computed(() => t.value.shell.score.reasons);
const engravingGate = computed(() => [props.loading, reasons.value.engraving] as const);
const transcribeBlocked = computed(() => firstBlock(engravingGate.value));
const refreshBlocked = computed(() =>
  firstBlock(engravingGate.value, [props.pageCount === 0, reasons.value.noScore]),
);
const zoomOutBlocked = computed(() =>
  firstBlock([props.viewZoom <= props.zoomMin, reasons.value.minZoom]),
);
const zoomInBlocked = computed(() =>
  firstBlock([props.viewZoom >= props.zoomMax, reasons.value.maxZoom]),
);
const previousBlocked = computed(() =>
  firstBlock(
    engravingGate.value,
    [props.pageCount === 0, reasons.value.noScore],
    [page.value <= 1, reasons.value.firstPage],
  ),
);
const nextBlocked = computed(() =>
  firstBlock(
    engravingGate.value,
    [props.pageCount === 0, reasons.value.noScore],
    [page.value >= props.pageCount, reasons.value.lastPage],
  ),
);
/** MusicXML needs a transcribed source; print and PDF also need rendered pages. */
const musicXmlBlocked = computed(() =>
  firstBlock(
    engravingGate.value,
    [props.exporting, t.value.reasons.busy],
    [!props.hasXml, reasons.value.noScore],
  ),
);
const renderedExportBlocked = computed(() =>
  firstBlock(musicXmlBlocked.value, [props.pageCount === 0, reasons.value.noScore]),
);
const partXmlBlocked = computed(() =>
  firstBlock(musicXmlBlocked.value, [!props.partName, reasons.value.noPart]),
);
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
    <span class="tb-group">
      <button
        type="button"
        class="tb-action"
        :disabled="!!transcribeBlocked"
        v-tooltip="{ text: t.shell.score.transcribeTitle, reason: transcribeBlocked }"
        @click="emit('transcribe')"
      >
        {{ t.shell.score.transcribe }}
      </button>
      <button
        type="button"
        class="tb-action"
        :disabled="!!refreshBlocked"
        v-tooltip="{ text: t.shell.score.refreshTitle, reason: refreshBlocked }"
        @click="emit('refresh')"
      >
        {{ t.shell.score.refresh }}
      </button>
    </span>
    <span class="tb-sep" aria-hidden="true" />
    <span class="tb-group">
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
    </span>
    <span class="tb-sep" aria-hidden="true" />
    <div class="layout-host">
      <button
        type="button"
        class="tb-menu"
        :class="{ 'is-open': layoutOpen }"
        aria-haspopup="true"
        :aria-expanded="layoutOpen"
        v-tooltip="t.shell.score.layoutTitle"
        @click="layoutOpen = !layoutOpen"
      >
        {{ t.shell.score.layout }}
        <svg class="tb-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <Transition name="pop">
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
        :disabled="!!zoomOutBlocked"
        :aria-label="t.shell.score.zoomOut"
        v-tooltip="{ text: t.shell.score.zoomOut, reason: zoomOutBlocked }"
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
      <span
        class="score-zoom-readout"
        aria-live="polite"
        v-tooltip="t.shell.score.zoomReadoutTitle"
      >{{ zoomPercent }}%</span>
      <button
        type="button"
        class="score-zoom-btn"
        :disabled="!!zoomInBlocked"
        :aria-label="t.shell.score.zoomIn"
        v-tooltip="{ text: t.shell.score.zoomIn, reason: zoomInBlocked }"
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
    <span class="tb-group" role="group" :aria-label="t.shell.score.page">
      <button
        type="button"
        class="score-zoom-btn"
        :disabled="!!previousBlocked"
        :aria-label="t.shell.score.previousPage"
        v-tooltip="{ text: t.shell.score.previousPage, reason: previousBlocked }"
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
      <span
        class="score-page-indicator"
        aria-live="polite"
        v-tooltip="t.shell.score.pageIndicatorTitle"
      >
        {{ pageCount > 0 ? `${page} / ${pageCount}` : '– / –' }}
      </span>
      <button
        type="button"
        class="score-zoom-btn"
        :disabled="!!nextBlocked"
        :aria-label="t.shell.score.nextPage"
        v-tooltip="{ text: t.shell.score.nextPage, reason: nextBlocked }"
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
    </span>
    <span class="tb-sep" aria-hidden="true" />
    <span class="tb-group">
      <button
        type="button"
        class="tb-action"
        :disabled="!!renderedExportBlocked"
        v-tooltip="{ text: t.shell.score.printTitle, reason: renderedExportBlocked }"
        @click="emit('print')"
      >
        {{ t.shell.score.print }}
      </button>
      <button
        type="button"
        class="tb-action"
        :disabled="!!renderedExportBlocked"
        v-tooltip="{ text: t.shell.score.pdfTitle, reason: renderedExportBlocked }"
        @click="emit('exportPdf')"
      >
        {{ t.shell.score.pdf }}
      </button>
      <button
        type="button"
        class="tb-action"
        :disabled="!!musicXmlBlocked"
        v-tooltip="{ text: t.shell.score.musicXmlTitle, reason: musicXmlBlocked }"
        @click="emit('exportMusicXml')"
      >
        {{ t.shell.score.musicXml }}
      </button>
      <button
        type="button"
        class="tb-action"
        :disabled="!!partXmlBlocked"
        v-tooltip="{ text: t.shell.score.partXmlTitle, reason: partXmlBlocked }"
        @click="emit('exportPartMusicXml')"
      >
        {{
          partName
            ? formatMessage(t.shell.score.partXmlNamed, { name: partName })
            : t.shell.score.partXml
        }}
      </button>
    </span>
  </div>
</template>

<style scoped src="./score-toolbar.css"></style>
