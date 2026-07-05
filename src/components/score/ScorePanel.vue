<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { matchModeChoiceId, modeOrdinalForChoice } from '@/components/lists/key-modes';
import ScoreAnnotationPalette from '@/components/score/ScoreAnnotationPalette.vue';
import ScoreToolbar from '@/components/score/ScoreToolbar.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { timeSigLengthPpq } from '@/notation/model';
import { keyToKeyFifths } from '@/notation/pitch-spelling';
import { VerovioClient } from '@/notation/verovio';
import type { NoteHairpin, NoteLineSpan, ScoreNoteAnnotation } from '@/project/annotations';
import {
  clearNoteAnnotation,
  type NoteAnnotationUpdate,
  setDisplayTranspose,
  setMarker,
  setNoteAnnotation,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { timeSignatureAt } from '@/project/time-signature';
import { useI18n } from '@/ui/i18n';
import { SCORE_PAGE_FORMATS, type ScoreLayoutSettings } from '@/ui/score/layout';
import {
  SCORE_KEY_MODES,
  SCORE_KEY_ROOTS,
  SCORE_LYRIC_SYLLABICS,
  type ScoreKeyMode,
  type ScoreKeyRoot,
  scoreEditPpq,
  scoreKeyMarkerName,
  scoreLyricMarkerName,
  scoreMeasureStartPpq,
} from '@/ui/score/marker-editors';
import { scoreOmitsMidiFx } from '@/ui/score/midi-fx-notice';
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
  /** True while the transport is playing; enables horizontal score following. */
  isPlaying?: boolean;
  /** True when the transport loop region should be engraved as repeats. */
  loopEnabled?: boolean;
  /** Transport loop start in project PPQ. */
  loopStartPpq?: number;
  /** Transport loop end in project PPQ. */
  loopEndPpq?: number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const appSettings = useAppSettings();

/** Delay after the last note edit before the score is re-transcribed. */
const RETRANSCRIBE_DEBOUNCE_MS = 600;

// --- Toolbar state -----------------------------------------------------------

/** One Display Quantize grid choice. */
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
  { key: '8t', label: '1/8 T', divisionPpq: 1 / 3 },
  { key: '16t', label: '1/16 T', divisionPpq: 1 / 6 },
];

const dqKey = ref('16');
const chordsEnabled = ref(false);
const fullScoreEnabled = ref(false);
const lyricInput = ref('');
const lyricVerseInput = ref(1);
const lyricSyllabicInput = ref<(typeof SCORE_LYRIC_SYLLABICS)[number]>('single');
const lyricExtendInput = ref(false);
const keyRootInput = ref<ScoreKeyRoot>('C');
const keyModeInput = ref<ScoreKeyMode>('major');

/** Display Quantize options for the toolbar select. */
const dqOptions = computed(() =>
  DQ_CHOICES.map((choice) => ({
    value: choice.key,
    label: choice.label,
    disabled: choice.disabled,
  })),
);
const keyRootOptions = computed(() =>
  SCORE_KEY_ROOTS.map((root) => ({ value: root, label: root })),
);
const keyModeOptions = computed(() =>
  SCORE_KEY_MODES.map((mode) => ({ value: mode, label: t.value.shell.score.keyModes[mode] })),
);
const lyricSyllabicOptions = computed(() =>
  SCORE_LYRIC_SYLLABICS.map((value) => ({
    value,
    label: t.value.shell.score.lyricSyllabics[value],
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
/** Hairpin type waiting for a target click, or null when not armed. */
const hairpinArmed = ref<NoteHairpin | null>(null);
/** Line/span type waiting for a target click, or null when not armed. */
const lineSpanArmed = ref<NoteLineSpan | null>(null);

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
const barsPerSystem = ref(4);
const barsPerPage = ref(16);
const grandStaffSplitPitch = ref(60);

/** On-screen zoom relative to the height-fit score size. */
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

/** Clip length fed to the transcriber, rounded up to complete measures. */
const screenClipLengthPpq = computed(() => actualMeasures.value * measureLenPpq.value);

/** On-screen zoom as a rounded percentage for the toolbar readout. */
const zoomPercent = computed(() => Math.round(viewZoom.value * 100));
const midiFxNoticeVisible = computed(() => scoreOmitsMidiFx(store.activeTrack));

/** Multiplies the on-screen zoom by a factor, clamped to the zoom bounds. */
function zoomView(factor: number): void {
  viewZoom.value = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, viewZoom.value * factor));
}

// --- Render state ------------------------------------------------------------

const svgHost = ref<HTMLDivElement | null>(null);
const scoreSvgHeightPx = ref(1);

/** Verovio worker client; created on mount, disposed on unmount. */
const client = shallowRef<VerovioClient | null>(null);

let retranscribeTimer: ReturnType<typeof setTimeout> | null = null;
let notesHandledForClipId: number | null = null;

/** Current Display Quantize grid step in PPQ. */
function divisionPpq(): number {
  const choice = DQ_CHOICES.find((c) => c.key === dqKey.value && !c.disabled);
  return choice ? choice.divisionPpq : 0.25;
}

/**
 * Key signature fifths derived from the scale highlight configuration.
 * Diatonic mode masks map to their matching MusicXML key signature; custom
 * masks fall back to C major.
 */
function keyFifths(): number {
  const cfg = store.scaleHighlight;
  if (!cfg.enabled) return 0;
  const modeId = matchModeChoiceId(cfg.modeMask);
  if (modeId === null) return 0;
  const root = (((cfg.rootPc % 12) + 12) % 12) as Key['root'];
  return keyToKeyFifths({ root, mode: modeOrdinalForChoice(modeId) as Key['mode'] });
}

function layoutSettings(): ScoreLayoutSettings {
  return {
    pageFormat: pageFormat.value,
    landscape: landscape.value,
    pageMarginMm: pageMarginMm.value,
    scalePercent: scalePercent.value,
    spacingStaff: spacingStaff.value,
    barsPerSystem: barsPerSystem.value,
    barsPerPage: barsPerPage.value,
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
  getScreenClipLengthPpq: () => screenClipLengthPpq.value,
  getTimeSignatures: () => store.timeSignatures,
  getKeyFifths: keyFifths,
  getChordsEnabled: () => chordsEnabled.value,
  getFullScoreEnabled: () => fullScoreEnabled.value,
  getGrandStaffSplitPitch: () => grandStaffSplitPitch.value,
  getLoopRegion: () =>
    props.loopEnabled === true &&
    props.loopStartPpq !== undefined &&
    props.loopEndPpq !== undefined &&
    props.loopEndPpq > props.loopStartPpq
      ? { startPpq: props.loopStartPpq, endPpq: props.loopEndPpq }
      : null,
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
  getIsPlaying: () => props.isPlaying === true,
  getFollowEnabled: () => appSettings.settings.scrollFollowPlayhead,
});

// --- Click-to-seek / select ------------------------------------------------------

const interactions = useScoreInteractions({
  store,
  getTimemap: () => notation.getTimemap(),
  getDivisionPpq: divisionPpq,
  seek: (ppq) => emit('seek', ppq),
  isAnnotateEnabled: () => annotateEnabled.value,
  onAnnotateClick,
  onAnnotateStaffDrag,
});

// --- Annotation palette ------------------------------------------------------------

/**
 * Annotate-mode note click: completes an armed slur/hairpin (click A, arm,
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
  if (
    hairpinArmed.value !== null &&
    annotationNoteId.value !== null &&
    clicked !== annotationNoteId.value
  ) {
    const hairpin = hairpinArmed.value;
    hairpinArmed.value = null;
    applyAnnotation({ hairpin, hairpinToNoteId: clicked });
    return;
  }
  if (
    lineSpanArmed.value !== null &&
    annotationNoteId.value !== null &&
    clicked !== annotationNoteId.value
  ) {
    const lineSpan = lineSpanArmed.value;
    lineSpanArmed.value = null;
    applyAnnotation({ addLineSpan: { lineSpan, lineSpanToNoteId: clicked } });
    return;
  }
  slurArmed.value = false;
  hairpinArmed.value = null;
  lineSpanArmed.value = null;
  annotationNoteId.value = clicked;
  const wrap = svgHost.value?.parentElement;
  const rect = wrap?.getBoundingClientRect();
  palettePos.value = {
    x: event.clientX - (rect?.left ?? 0) + 8,
    y: event.clientY - (rect?.top ?? 0) + 8,
  };
}

/** Annotate-mode vertical drag: force the clicked note onto the upper/lower staff. */
function onAnnotateStaffDrag(ids: number[], staff: 1 | 2): void {
  const id = ids[0];
  if (id === undefined) return;
  try {
    setNoteAnnotation(store.clipId, id, { staffOverride: staff });
    notation.setError('');
    closePalette();
    void notation.transcribe();
  } catch (err) {
    notation.setError(err instanceof Error ? err.message : String(err));
  }
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
  hairpinArmed.value = null;
  lineSpanArmed.value = null;
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

function markerEditPpq(): number {
  return scoreEditPpq(props.positionPpq?.(), store.clipStartPpq, store.clipLengthPpq);
}

function addLyricMarker(): void {
  try {
    const name = scoreLyricMarkerName(lyricInput.value, {
      verse: lyricVerseInput.value,
      syllabic: lyricSyllabicInput.value,
      extend: lyricExtendInput.value,
    });
    setMarker(null, markerEditPpq(), name);
    lyricInput.value = '';
    notation.setError('');
    void notation.transcribe();
  } catch (err) {
    notation.setError(err instanceof Error ? err.message : String(err));
  }
}

function addKeyMarker(): void {
  try {
    const ppq = scoreMeasureStartPpq(markerEditPpq(), store.clipStartPpq, measureLenPpq.value);
    setMarker(null, ppq, scoreKeyMarkerName(keyRootInput.value, keyModeInput.value));
    notation.setError('');
    void notation.transcribe();
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

// The active clip is navigation, not a note edit: switch the score immediately
// so playhead following does not keep scanning the previous clip's timemap.
watch(
  () => store.clipId,
  () => {
    if (retranscribeTimer !== null) {
      clearTimeout(retranscribeTimer);
      retranscribeTimer = null;
    }
    closePalette();
    playhead?.resetScan();
    notesHandledForClipId = store.clipId;
    void notation.transcribe();
  },
);
// The note mirror is replaced wholesale on every command, so identity
// tracking fires once per edit. Debounce only when the clip itself did not
// change; clip changes are handled immediately above.
watch(
  () => store.notes,
  () => {
    if (notesHandledForClipId === store.clipId) {
      notesHandledForClipId = null;
      return;
    }
    scheduleRetranscribe();
  },
);
// Annotations and display transpose are replaced wholesale by their commands
// too; both only affect engraving, so they re-transcribe debounced like edits.
watch(
  [
    () => store.scoreAnnotations,
    () => store.displayTransposeSemitones,
    () => store.sections,
    () => props.loopEnabled,
    () => props.loopStartPpq,
    () => props.loopEndPpq,
  ],
  scheduleRetranscribe,
);
watch(
  [dqKey, chordsEnabled, fullScoreEnabled, () => store.scaleHighlight],
  () => void notation.transcribe(),
  {
    deep: true,
  },
);
// Meter or clip length changes can alter the rounded measure extent.
watch(screenClipLengthPpq, () => void notation.transcribe());
watch(
  [pageFormat, landscape, pageMarginMm, scalePercent, spacingStaff],
  () => void notation.applyLayout(),
);
watch([barsPerSystem, barsPerPage], () => void notation.transcribe());
watch(grandStaffSplitPitch, () => void notation.transcribe());
watch(annotateEnabled, (enabled) => {
  if (!enabled) closePalette();
});
// The palette targets a note of the active clip; close it when its note
// disappears (deleted or replaced by other edits). Clip switches are handled by
// the immediate transcribe watcher above.
watch(
  () => store.notes,
  (notes) => {
    const id = annotationNoteId.value;
    if (id !== null && !notes.some((note) => note.id === id)) closePalette();
  },
);

let resizeObserver: ResizeObserver | null = null;

function updateScoreFitHeight(): void {
  const el = svgHost.value;
  if (!el) return;
  const style = getComputedStyle(el);
  const paddingTop = Number.parseFloat(style.paddingTop);
  const paddingBottom = Number.parseFloat(style.paddingBottom);
  const paddingY =
    (Number.isFinite(paddingTop) ? paddingTop : 0) +
    (Number.isFinite(paddingBottom) ? paddingBottom : 0);
  scoreSvgHeightPx.value = Math.max(1, el.clientHeight - paddingY);
}

onMounted(() => {
  client.value = new VerovioClient();
  updateScoreFitHeight();
  if (svgHost.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateScoreFitHeight);
    resizeObserver.observe(svgHost.value);
  }
  void notation.transcribe();
});

onBeforeUnmount(() => {
  if (retranscribeTimer !== null) {
    clearTimeout(retranscribeTimer);
    retranscribeTimer = null;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
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
      v-model:full-score-enabled="fullScoreEnabled"
      v-model:annotate-enabled="annotateEnabled"
      v-model:page-format="pageFormat"
      v-model:landscape="landscape"
      v-model:page-margin-mm="pageMarginMm"
      v-model:scale-percent="scalePercent"
      v-model:spacing-staff="spacingStaff"
      v-model:bars-per-system="barsPerSystem"
      v-model:bars-per-page="barsPerPage"
      v-model:grand-staff-split-pitch="grandStaffSplitPitch"
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
      @export-part-music-xml="notation.onExportPartMusicXml"
      @transpose-change="onTransposeChange"
    />
    <p v-if="notation.error.value" class="score-error" role="alert">{{ notation.error.value }}</p>
    <p v-if="midiFxNoticeVisible" class="score-notice" role="note">
      {{ t.shell.score.midiFxNotice }}
    </p>
    <div class="score-marker-tools" role="group" :aria-label="t.shell.score.markerTools">
      <label>
        {{ t.shell.score.lyricText }}
        <input
          v-model="lyricInput"
          type="text"
          :placeholder="t.shell.score.lyricPlaceholder"
          :aria-label="t.shell.score.lyricText"
          @keydown.enter.prevent="addLyricMarker"
        />
      </label>
      <button type="button" @click="addLyricMarker">{{ t.shell.score.addLyric }}</button>
      <label>
        {{ t.shell.score.lyricVerse }}
        <input
          v-model.number="lyricVerseInput"
          type="number"
          min="1"
          max="16"
          step="1"
          class="lyric-verse-input"
          :aria-label="t.shell.score.lyricVerse"
        />
      </label>
      <label>
        {{ t.shell.score.lyricSyllabic }}
        <select v-model="lyricSyllabicInput" :aria-label="t.shell.score.lyricSyllabic">
          <option v-for="option in lyricSyllabicOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="inline-check">
        <input v-model="lyricExtendInput" type="checkbox" />
        {{ t.shell.score.lyricExtend }}
      </label>
      <label>
        {{ t.shell.score.keyRoot }}
        <select v-model="keyRootInput" :aria-label="t.shell.score.keyRoot">
          <option v-for="option in keyRootOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label>
        {{ t.shell.score.keyMode }}
        <select v-model="keyModeInput" :aria-label="t.shell.score.keyMode">
          <option v-for="option in keyModeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button type="button" @click="addKeyMarker">{{ t.shell.score.addKey }}</button>
    </div>
    <div class="score-body-wrap">
      <!-- biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced locally by the Verovio worker -->
      <div
        ref="svgHost"
        class="score-body"
        role="img"
        :aria-label="t.shell.score.engravedScore"
        :style="{ '--score-svg-height': `${scoreSvgHeightPx * viewZoom}px` }"
        @pointerdown="interactions.onSvgPointerDown"
        @pointermove="interactions.onSvgPointerMove"
        @pointerup="interactions.onSvgPointerUp"
        @pointercancel="interactions.onSvgPointerCancel"
        @click="interactions.onSvgClick"
        v-html="notation.svg.value"
      />
      <div v-if="notation.loading.value" class="score-loading">
        <span class="score-state-text">{{ t.shell.score.engraving }}</span>
      </div>
      <EmptyState v-else-if="!notation.svg.value" :message="t.shell.score.empty">
        <template #icon>
          <svg viewBox="0 0 24 36" width="40" height="60" aria-hidden="true">
            <!-- Five-line staff with a stylised treble clef as a visual anchor. -->
            <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
              <path d="M2 8h20M2 13h20M2 18h20M2 23h20M2 28h20" opacity="0.45" />
              <path
                d="M13 4c-3 1-4 4-3.5 7l2 11c.4 2.6-1.4 4.5-3.2 4.2-1.6-.3-2.4-2-1.4-3.2.9-1 2.5-.5 2.5.8"
                stroke-width="1.6"
              />
            </g>
          </svg>
        </template>
      </EmptyState>
      <Transition name="popover">
        <ScoreAnnotationPalette
          v-if="annotateEnabled && annotationNoteId !== null"
          :annotation="annotationCurrent"
          :position="palettePos"
          :slur-armed="slurArmed"
          :hairpin-armed="hairpinArmed"
          :line-span-armed="lineSpanArmed"
          @apply="applyAnnotation"
          @clear="clearAnnotation"
          @close="closePalette"
          @slur-armed-change="
            slurArmed = $event;
            if ($event) {
              hairpinArmed = null;
              lineSpanArmed = null;
            }
          "
          @hairpin-armed-change="
            hairpinArmed = $event;
            if ($event !== null) {
              slurArmed = false;
              lineSpanArmed = null;
            }
          "
          @line-span-armed-change="
            lineSpanArmed = $event;
            if ($event !== null) {
              slurArmed = false;
              hairpinArmed = null;
            }
          "
        />
      </Transition>
    </div>
  </section>
</template>

<style scoped src="./score-panel.css"></style>
