<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import ScoreAnnotationPalette from '@/components/score/ScoreAnnotationPalette.vue';
import ScoreToolbar from '@/components/score/ScoreToolbar.vue';
import { timeSigLengthPpq } from '@/notation/model';
import { keyToKeyFifths } from '@/notation/pitch-spelling';
import { VerovioClient } from '@/notation/verovio';
import type { ScoreNoteAnnotation } from '@/project/annotations';
import {
  clearNoteAnnotation,
  type NoteAnnotationUpdate,
  setDisplayTranspose,
  setNoteAnnotation,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { timeSignatureAt } from '@/project/time-signature';
import { MAJOR_MODE_MASK } from '@/project/types';
import { useI18n } from '@/ui/i18n';
import { SCORE_PAGE_FORMATS, type ScoreLayoutSettings } from '@/ui/score/layout';
import { type PlayheadSync, usePlayheadSync } from '@/ui/score/use-playhead-sync';
import { useScoreInteractions } from '@/ui/score/use-score-interactions';
import { useScoreNotation } from '@/ui/score/use-score-notation';
import type { Key } from '@/wasm/index.js';

/**
 * Read-only engraved score view over the piano-roll clip.
 *
 * The notation pipeline is strictly display-only: editor notes are quantized
 * to a NotatedScore (never written back to MIDI), serialized to MusicXML and
 * engraved by the Verovio worker. Display Quantize changes only re-run this
 * pipeline; the project's note data is never touched.
 *
 * Playhead/click sync uses the Verovio timemap. A timemap `qstamp` counts
 * quarter notes from the start of measure 1, and measure 1 begins at the
 * clip start, so `editorPpq = store.clipStartPpq + qstamp` (constant-tempo
 * identity in quarter-note PPQ; tempo does not affect qstamp).
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to disable playhead highlight. */
  positionPpq?: () => number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const store = useProjectStore();
const { t } = useI18n();

/** Delay after the last note edit before the score is re-transcribed. */
const RETRANSCRIBE_DEBOUNCE_MS = 600;

// --- Toolbar state -----------------------------------------------------------

/** One Display Quantize grid choice. Triplet grids are listed but disabled:
 *  the notation model only represents binary (dotted) note values. */
interface DqChoice {
  key: string;
  label: string;
  divisionPpq: number;
  disabled?: boolean;
}

const DQ_CHOICES: ReadonlyArray<DqChoice> = [
  { key: '4', label: '1/4', divisionPpq: 1 },
  { key: '8', label: '1/8', divisionPpq: 0.5 },
  { key: '16', label: '1/16', divisionPpq: 0.25 },
  { key: '32', label: '1/32', divisionPpq: 0.125 },
  { key: '8t', label: '1/8 T', divisionPpq: 1 / 3, disabled: true },
  { key: '16t', label: '1/16 T', divisionPpq: 1 / 6, disabled: true },
];

const dqKey = ref('16');
const chordsEnabled = ref(false);

/** Display Quantize options for the toolbar select (triplet grids disabled). */
const dqOptions = computed(() =>
  DQ_CHOICES.map((choice) => ({
    value: choice.key,
    label: choice.label,
    disabled: choice.disabled,
  })),
);

// --- Annotation state ----------------------------------------------------------

/** True while the Annotate tool is active (note clicks open the palette). */
const annotateEnabled = ref(false);
/** Editor note id the floating palette currently edits (null = closed). */
const annotationNoteId = ref<number | null>(null);
/** Palette position relative to the score body wrapper, in pixels. */
const palettePos = ref({ x: 0, y: 0 });
/** True while waiting for the slur target click ("slur to next selected"). */
const slurArmed = ref(false);

/** Current annotation of the palette's target note (empty when none). */
const annotationCurrent = computed<ScoreNoteAnnotation>(() => {
  const id = annotationNoteId.value;
  if (id === null) return {};
  return store.scoreAnnotations[store.clipId]?.[id] ?? {};
});

const pageFormat = ref<keyof typeof SCORE_PAGE_FORMATS>('a4');
const landscape = ref(false);
const pageMarginMm = ref(10);
const scalePercent = ref(50);
const spacingStaff = ref(12);

/**
 * On-screen zoom of the engraved (single continuous) system.
 *
 * At 100% the system fills the panel width exactly. Zooming IN (>100%) enlarges
 * the notes and the body scrolls horizontally (the SVG grows past the panel).
 * Zooming OUT (<100%) keeps the FULL width and shrinks the notes by padding the
 * line with trailing empty measures — so the staff always spans the panel with
 * no blank tail and no distortion, instead of shrinking into a narrow block.
 */
const viewZoom = ref(1);
const VIEW_ZOOM_MIN = 0.25;
const VIEW_ZOOM_MAX = 4;
const VIEW_ZOOM_STEP = 1.2;

/**
 * Time signature in effect at the clip start, taken from the project's meter
 * map (4/4 fallback when none is modelled). The score is notated in this
 * meter so bar lines, beaming, rests and chord placement match the project.
 */
const clipTimeSig = computed<{ beats: number; beatUnit: number }>(() => {
  const meter = timeSignatureAt(store.timeSignatures, store.clipStartPpq);
  return { beats: meter.numerator, beatUnit: meter.denominator };
});

/** Engraved measure length in PPQ for the clip's time signature. */
const measureLenPpq = computed(() => timeSigLengthPpq(clipTimeSig.value));

/** Whole measures the real clip content spans. */
const actualMeasures = computed(() =>
  Math.max(1, Math.ceil(store.clipLengthPpq / measureLenPpq.value)),
);

/**
 * Empty measures appended to fill the panel width when zoomed out below 100%.
 * Showing `actualMeasures / viewZoom` measures across the same width shrinks the
 * notes proportionally; the extra measures past the real content are blank.
 */
const padMeasures = computed(() =>
  viewZoom.value >= 1
    ? 0
    : Math.max(0, Math.ceil(actualMeasures.value / viewZoom.value) - actualMeasures.value),
);

/** Clip length (real content plus padding) fed to the transcriber, in PPQ. */
const paddedClipLengthPpq = computed(
  () => (actualMeasures.value + padMeasures.value) * measureLenPpq.value,
);

/** CSS width factor: >= 1 so zoom-out fills via padding, never shrinks below. */
const widthFactor = computed(() => Math.max(1, viewZoom.value));

/** On-screen zoom as a rounded percentage for the toolbar readout. */
const zoomPercent = computed(() => Math.round(viewZoom.value * 100));

/** Multiplies the on-screen zoom by a factor, clamped to the zoom bounds. */
function zoomView(factor: number): void {
  viewZoom.value = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, viewZoom.value * factor));
}

// --- Render state ------------------------------------------------------------

const svgHost = ref<HTMLDivElement | null>(null);

/** Verovio worker client; created on mount, disposed on unmount. */
const client = shallowRef<VerovioClient | null>(null);

let retranscribeTimer: ReturnType<typeof setTimeout> | null = null;

/** Current Display Quantize grid step in PPQ. */
function divisionPpq(): number {
  const choice = DQ_CHOICES.find((c) => c.key === dqKey.value && !c.disabled);
  return choice ? choice.divisionPpq : 0.25;
}

/**
 * Key signature fifths derived from the scale highlight configuration. Only
 * the major mode mask is mappable; other masks fall back to C major.
 */
function keyFifths(): number {
  const cfg = store.scaleHighlight;
  if (!cfg.enabled || cfg.modeMask !== MAJOR_MODE_MASK) return 0;
  const root = (((cfg.rootPc % 12) + 12) % 12) as Key['root'];
  return keyToKeyFifths({ root, mode: 0 });
}

function layoutSettings(): ScoreLayoutSettings {
  return {
    pageFormat: pageFormat.value,
    landscape: landscape.value,
    pageMarginMm: pageMarginMm.value,
    scalePercent: scalePercent.value,
    spacingStaff: spacingStaff.value,
  };
}

// --- Transcription pipeline ---------------------------------------------------

let playhead: PlayheadSync | undefined;

const notation = useScoreNotation({
  store,
  client,
  getDivisionPpq: divisionPpq,
  getTimeSig: () => clipTimeSig.value,
  getMeasureLenPpq: () => measureLenPpq.value,
  getPaddedClipLengthPpq: () => paddedClipLengthPpq.value,
  getKeyFifths: keyFifths,
  getChordsEnabled: () => chordsEnabled.value,
  getLayoutSettings: layoutSettings,
  resetPlayheadScan: () => playhead?.resetScan(),
});

// --- Playhead highlight ---------------------------------------------------------

playhead = usePlayheadSync({
  svgHost,
  svg: computed(() => notation.svg.value),
  getTimemap: () => notation.getTimemap(),
  getClipStartPpq: () => store.clipStartPpq,
  getPositionPpq: () => props.positionPpq,
});

// --- Click-to-seek / select ------------------------------------------------------

const interactions = useScoreInteractions({
  store,
  getTimemap: () => notation.getTimemap(),
  getDivisionPpq: divisionPpq,
  seek: (ppq) => emit('seek', ppq),
  isAnnotateEnabled: () => annotateEnabled.value,
  onAnnotateClick,
});

// --- Annotation palette ------------------------------------------------------------

/**
 * Annotate-mode note click: completes an armed slur (click A, "Slur…",
 * click B), otherwise retargets the floating palette at the clicked note.
 */
function onAnnotateClick(event: MouseEvent, ids: number[]): void {
  const clicked = ids[0];
  if (clicked === undefined) {
    closePalette();
    return;
  }
  if (slurArmed.value && annotationNoteId.value !== null && clicked !== annotationNoteId.value) {
    slurArmed.value = false;
    applyAnnotation({ slurToNoteId: clicked });
    return;
  }
  slurArmed.value = false;
  annotationNoteId.value = clicked;
  const wrap = svgHost.value?.parentElement;
  const rect = wrap?.getBoundingClientRect();
  palettePos.value = {
    x: event.clientX - (rect?.left ?? 0) + 8,
    y: event.clientY - (rect?.top ?? 0) + 8,
  };
}

/** Applies a field-wise annotation edit to the palette's target note. */
function applyAnnotation(update: NoteAnnotationUpdate): void {
  const id = annotationNoteId.value;
  if (id === null) return;
  try {
    setNoteAnnotation(store.clipId, id, update);
    notation.setError('');
  } catch (err) {
    notation.setError(err instanceof Error ? err.message : String(err));
  }
}

/** Removes every annotation of the target note. */
function clearAnnotation(): void {
  const id = annotationNoteId.value;
  if (id === null) return;
  try {
    clearNoteAnnotation(store.clipId, id);
    notation.setError('');
  } catch (err) {
    notation.setError(err instanceof Error ? err.message : String(err));
  }
}

/** Closes the floating palette and disarms any pending slur. */
function closePalette(): void {
  annotationNoteId.value = null;
  slurArmed.value = false;
}

/** Layout popover change handler for the display transpose select. */
function onTransposeChange(value: number): void {
  try {
    setDisplayTranspose(value);
    notation.setError('');
  } catch (err) {
    notation.setError(err instanceof Error ? err.message : String(err));
  }
}

// --- Reactive re-transcription -----------------------------------------------------

function scheduleRetranscribe(): void {
  if (retranscribeTimer !== null) clearTimeout(retranscribeTimer);
  retranscribeTimer = setTimeout(() => {
    retranscribeTimer = null;
    void notation.transcribe();
  }, RETRANSCRIBE_DEBOUNCE_MS);
}

// The note mirror is replaced wholesale on every command, so identity
// tracking fires once per edit. Option changes re-transcribe immediately.
watch(() => store.notes, scheduleRetranscribe);
// Annotations and display transpose are replaced wholesale by their commands
// too; both only affect engraving, so they re-transcribe debounced like edits.
watch([() => store.scoreAnnotations, () => store.displayTransposeSemitones], scheduleRetranscribe);
watch([dqKey, chordsEnabled, () => store.scaleHighlight], () => void notation.transcribe(), {
  deep: true,
});
// Zoom-out padding changes the number of (empty) measures, so the score must be
// re-engraved; zoom-in (padMeasures stays 0) only updates the CSS width.
watch(padMeasures, () => void notation.transcribe());
watch(
  [pageFormat, landscape, pageMarginMm, scalePercent, spacingStaff],
  () => void notation.applyLayout(),
);
watch(annotateEnabled, (enabled) => {
  if (!enabled) closePalette();
});
// The palette targets a note of the active clip; close it on clip switches
// and when its note disappears (deleted or replaced by other edits).
watch(
  () => store.clipId,
  () => closePalette(),
);
watch(
  () => store.notes,
  (notes) => {
    const id = annotationNoteId.value;
    if (id !== null && !notes.some((note) => note.id === id)) closePalette();
  },
);

onMounted(() => {
  client.value = new VerovioClient();
  void notation.transcribe();
});

onBeforeUnmount(() => {
  if (retranscribeTimer !== null) {
    clearTimeout(retranscribeTimer);
    retranscribeTimer = null;
  }
  notation.bumpGeneration();
  client.value?.dispose();
  client.value = null;
});
</script>

<template>
  <section class="score-panel">
    <ScoreToolbar
      v-model:dq-key="dqKey"
      v-model:chords-enabled="chordsEnabled"
      v-model:annotate-enabled="annotateEnabled"
      v-model:page-format="pageFormat"
      v-model:landscape="landscape"
      v-model:page-margin-mm="pageMarginMm"
      v-model:scale-percent="scalePercent"
      v-model:spacing-staff="spacingStaff"
      v-model:page="notation.page.value"
      :dq-options="dqOptions"
      :loading="notation.loading.value"
      :exporting="notation.exporting.value"
      :page-count="notation.pageCount.value"
      :has-xml="!!notation.getCurrentXml()"
      :zoom-percent="zoomPercent"
      :zoom-min="VIEW_ZOOM_MIN"
      :zoom-max="VIEW_ZOOM_MAX"
      :zoom-step="VIEW_ZOOM_STEP"
      :view-zoom="viewZoom"
      :transpose="store.displayTransposeSemitones"
      @transcribe="notation.transcribe"
      @refresh="notation.refresh"
      @zoom="zoomView"
      @goto-page="notation.gotoPage"
      @print="notation.onPrint"
      @export-pdf="notation.onExportPdf"
      @export-music-xml="notation.onExportMusicXml"
      @transpose-change="onTransposeChange"
    />
    <p v-if="notation.error.value" class="score-error" role="alert">{{ notation.error.value }}</p>
    <div class="score-body-wrap">
      <!-- biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced locally by the Verovio worker -->
      <div
        ref="svgHost"
        class="score-body"
        role="img"
        :aria-label="t.shell.score.engravedScore"
        :style="{ '--score-zoom': widthFactor }"
        @click="interactions.onSvgClick"
        v-html="notation.svg.value"
      />
      <div v-if="notation.loading.value" class="score-loading">
        <span class="score-state-text">{{ t.shell.score.engraving }}</span>
      </div>
      <div v-else-if="!notation.svg.value" class="score-empty">
        <svg
          class="score-empty-glyph"
          viewBox="0 0 24 36"
          width="40"
          height="60"
          aria-hidden="true"
        >
          <!-- Five-line staff with a stylised treble clef as a visual anchor. -->
          <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
            <path d="M2 8h20M2 13h20M2 18h20M2 23h20M2 28h20" opacity="0.45" />
            <path
              d="M13 4c-3 1-4 4-3.5 7l2 11c.4 2.6-1.4 4.5-3.2 4.2-1.6-.3-2.4-2-1.4-3.2.9-1 2.5-.5 2.5.8"
              stroke-width="1.6"
            />
          </g>
        </svg>
        <span class="score-state-text">{{ t.shell.score.empty }}</span>
      </div>
      <Transition name="popover">
        <ScoreAnnotationPalette
          v-if="annotateEnabled && annotationNoteId !== null"
          :annotation="annotationCurrent"
          :position="palettePos"
          :slur-armed="slurArmed"
          @apply="applyAnnotation"
          @clear="clearAnnotation"
          @close="closePalette"
          @slur-armed-change="slurArmed = $event"
        />
      </Transition>
    </div>
  </section>
</template>

<style scoped src="./score-panel.css"></style>
