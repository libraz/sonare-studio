<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import ScoreAnnotationPalette from '@/components/score/ScoreAnnotationPalette.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import { exportMusicXml } from '@/notation/io';
import { timeSigLengthPpq } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { keyToKeyFifths } from '@/notation/pitch-spelling';
import { downloadBlob, exportPdf, printScore } from '@/notation/print';
import { quantizeToScore } from '@/notation/quantize';
import { VerovioClient } from '@/notation/verovio';
import {
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  type ScoreNoteAnnotation,
} from '@/project/annotations';
import {
  clearNoteAnnotation,
  type NoteAnnotationUpdate,
  setDisplayTranspose,
  setNoteAnnotation,
  setSelection,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';
import {
  SCORE_PAGE_FORMATS,
  type ScoreLayoutSettings,
  scorePageDimsMm,
  scorePrintLayoutOptions,
  scoreScreenLayoutOptions,
} from '@/ui/score/layout';
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

/** Delay after the last note edit before the score is re-transcribed. */
const RETRANSCRIBE_DEBOUNCE_MS = 600;
/** Selection matching tolerance on the quantized onset grid, in PPQ. */
const ONSET_MATCH_EPSILON_PPQ = 1e-3;
/** Default time signature until the project models a meter map. */
const DEFAULT_TIME_SIG = { beats: 4, beatUnit: 4 } as const;

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

/** Display transpose choices offered in the layout popover (semitones). */
const TRANSPOSE_CHOICES: ReadonlyArray<number> = Array.from(
  { length: DISPLAY_TRANSPOSE_MAX - DISPLAY_TRANSPOSE_MIN + 1 },
  (_, i) => DISPLAY_TRANSPOSE_MIN + i,
);

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

const layoutOpen = ref(false);
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

/** Engraved measure length in PPQ (the score is always notated in 4/4). */
const MEASURE_LEN_PPQ = timeSigLengthPpq(DEFAULT_TIME_SIG);

/** Whole measures the real clip content spans. */
const actualMeasures = computed(() =>
  Math.max(1, Math.ceil(store.clipLengthPpq / MEASURE_LEN_PPQ)),
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
  () => (actualMeasures.value + padMeasures.value) * MEASURE_LEN_PPQ,
);

/** CSS width factor: >= 1 so zoom-out fills via padding, never shrinks below. */
const widthFactor = computed(() => Math.max(1, viewZoom.value));

/** On-screen zoom as a rounded percentage for the toolbar readout. */
const zoomPercent = computed(() => Math.round(viewZoom.value * 100));

/** Multiplies the on-screen zoom by a factor, clamped to the zoom bounds. */
function zoomView(factor: number): void {
  viewZoom.value = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, viewZoom.value * factor));
}

/** Page format options for the layout popover select. */
const pageFormatOptions = computed(() =>
  Object.entries(SCORE_PAGE_FORMATS).map(([key, format]) => ({ value: key, label: format.label })),
);

/** Orientation options; values mirror the boolean `landscape` flag. */
const ORIENTATION_OPTIONS: ReadonlyArray<{ value: 'portrait' | 'landscape'; label: string }> = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

/** String proxy over the boolean `landscape` flag for the select binding. */
const orientation = computed<'portrait' | 'landscape'>({
  get: () => (landscape.value ? 'landscape' : 'portrait'),
  set: (value) => {
    landscape.value = value === 'landscape';
  },
});

/** Display transpose options for the layout popover select (semitones). */
const transposeOptions = computed(() =>
  TRANSPOSE_CHOICES.map((n) => ({ value: n, label: n > 0 ? `+${n}` : String(n) })),
);

// --- Render state ------------------------------------------------------------

const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const svg = ref('');
const page = ref(1);
const pageCount = ref(0);
const svgHost = ref<HTMLDivElement | null>(null);

/** MusicXML of the last successful transcription (export source). */
let currentXml = '';
/** Timemap of the last successful load (paired with the same load's SVG ids). */
let timemap: ReadonlyArray<{ qstamp: number; on?: string[]; off?: string[] }> = [];
/** Verovio worker client; created on mount, disposed on unmount. */
const client = shallowRef<VerovioClient | null>(null);

let generation = 0;
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

/** Verovio layout options for the current settings (page units are 1/10 mm). */
function layoutOptions() {
  return scorePrintLayoutOptions(layoutSettings());
}

/**
 * On-screen layout: one continuous system with NO line/system breaks, cropped
 * to the content on both axes. The engraved strip then scrolls horizontally
 * instead of wrapping to multiple lines. Print/PDF use the paginated
 * `layoutOptions()` above instead.
 */
function screenLayoutOptions() {
  return scoreScreenLayoutOptions(layoutSettings());
}

// --- Transcription pipeline ---------------------------------------------------

/**
 * Re-runs the full non-destructive pipeline:
 * notes -> quantizeToScore -> (optional chord symbols) -> MusicXML -> Verovio.
 */
async function transcribe(): Promise<void> {
  const verovio = client.value;
  if (!verovio || !store.initialized || store.clipLengthPpq <= 0) return;
  const gen = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const fifths = keyFifths();
    const score = quantizeToScore(store.notes, {
      divisionPpq: divisionPpq(),
      timeSig: { ...DEFAULT_TIME_SIG },
      keyFifths: fifths,
      clipStartPpq: store.clipStartPpq,
      // Padded with trailing empty measures so the line fills the width when
      // zoomed out (never shrinks into a narrow block).
      clipLengthPpq: paddedClipLengthPpq.value,
      clef: 'grand',
      partName: 'Piano',
      // Engraving-only transpose; the underlying MIDI notes never change.
      displayTransposeSemitones: store.displayTransposeSemitones,
    });
    const annotations = store.scoreAnnotations[store.clipId];
    if (annotations && Object.keys(annotations).length > 0) {
      score.noteAnnotations = { ...annotations };
    }
    if (chordsEnabled.value) {
      // Chord symbols are best-effort: any wasm failure degrades silently to
      // a score without harmony instead of failing the whole render.
      try {
        const estimated: EstimatedChordSymbol[] = estimateChordSymbols(store.notes, {
          clipStartPpq: store.clipStartPpq,
          clipLengthPpq: store.clipLengthPpq,
          measureLengthPpq: timeSigLengthPpq(DEFAULT_TIME_SIG),
          keyFifths: fifths,
        });
        const symbols = await canonicalizeChordSymbols(estimated);
        if (symbols.length > 0) score.chordSymbols = symbols;
      } catch {
        // Degrade silently: render the score without chord symbols.
      }
    }
    const xml = serializeMusicXml(score);
    const count = await verovio.load(xml, screenLayoutOptions());
    if (gen !== generation) return;
    currentXml = xml;
    pageCount.value = count;
    page.value = Math.min(Math.max(page.value, 1), Math.max(count, 1));
    const [pageSvg, entries] = await Promise.all([
      verovio.renderPage(page.value),
      verovio.getTimemap(),
    ]);
    if (gen !== generation) return;
    svg.value = pageSvg;
    timemap = entries;
    resetPlayheadScan();
  } catch (err) {
    if (gen !== generation) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (gen === generation) loading.value = false;
  }
}

/** Re-renders the current page from the already loaded score. */
async function refresh(): Promise<void> {
  const verovio = client.value;
  if (!verovio || pageCount.value === 0) return;
  const gen = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const pageSvg = await verovio.renderPage(page.value);
    if (gen !== generation) return;
    svg.value = pageSvg;
    resetPlayheadScan();
  } catch (err) {
    if (gen !== generation) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (gen === generation) loading.value = false;
  }
}

/** Applies the layout settings to the loaded score and re-renders. */
async function applyLayout(): Promise<void> {
  const verovio = client.value;
  if (!verovio || pageCount.value === 0) {
    void transcribe();
    return;
  }
  const gen = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const count = await verovio.setLayout(screenLayoutOptions());
    if (gen !== generation) return;
    pageCount.value = count;
    page.value = Math.min(Math.max(page.value, 1), Math.max(count, 1));
    // Note ids survive redoLayout, so the existing timemap stays valid.
    const pageSvg = await verovio.renderPage(page.value);
    if (gen !== generation) return;
    svg.value = pageSvg;
    resetPlayheadScan();
  } catch (err) {
    if (gen !== generation) return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (gen === generation) loading.value = false;
  }
}

function gotoPage(target: number): void {
  if (pageCount.value === 0) return;
  const next = Math.min(Math.max(target, 1), pageCount.value);
  if (next === page.value) return;
  page.value = next;
  void refresh();
}

// --- Print / export ------------------------------------------------------------

/**
 * Renders every page for print/export using the PAGINATED A4 layout (the
 * on-screen view is a single continuous system, which would print as one
 * oversized strip), then restores the continuous screen layout.
 */
async function renderAllPages(): Promise<string[]> {
  const verovio = client.value;
  if (!verovio || pageCount.value === 0) return [];
  try {
    const count = await verovio.setLayout(layoutOptions());
    const pages: string[] = [];
    for (let p = 1; p <= count; p++) {
      pages.push(await verovio.renderPage(p));
    }
    return pages;
  } finally {
    // Restore the on-screen continuous layout and re-render the current page.
    const screenCount = await verovio.setLayout(screenLayoutOptions());
    pageCount.value = screenCount;
    page.value = Math.min(Math.max(page.value, 1), Math.max(screenCount, 1));
    svg.value = await verovio.renderPage(page.value);
    resetPlayheadScan();
  }
}

/** Runs an export action with the busy flag and error reporting. */
async function runExport(action: () => Promise<void>): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  error.value = '';
  try {
    await action();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    exporting.value = false;
  }
}

function onPrint(): void {
  void runExport(async () => {
    const pages = await renderAllPages();
    if (pages.length > 0) printScore(pages, scorePageDimsMm(layoutSettings()));
  });
}

function onExportPdf(): void {
  void runExport(async () => {
    const pages = await renderAllPages();
    if (pages.length === 0) return;
    const blob = await exportPdf(pages, scorePageDimsMm(layoutSettings()));
    downloadBlob(blob, 'score.pdf');
  });
}

function onExportMusicXml(): void {
  if (!currentXml) return;
  void runExport(async () => {
    exportMusicXml(currentXml, 'score.musicxml');
  });
}

// --- Playhead highlight ---------------------------------------------------------

/** Incremental timemap scan state (reset on every render / backwards seek). */
let scanIndex = 0;
let scanQstamp = Number.NEGATIVE_INFINITY;
const soundingIds = new Set<string>();
const highlightedIds = new Set<string>();

function resetPlayheadScan(): void {
  scanIndex = 0;
  scanQstamp = Number.NEGATIVE_INFINITY;
  soundingIds.clear();
  highlightedIds.clear();
}

/** Note ids sounding at a quarter-note position (amortized forward scan). */
function soundingIdsAt(qpos: number): ReadonlySet<string> {
  if (qpos < scanQstamp) {
    scanIndex = 0;
    soundingIds.clear();
  }
  scanQstamp = qpos;
  while (scanIndex < timemap.length && timemap[scanIndex].qstamp <= qpos) {
    const entry = timemap[scanIndex];
    for (const id of entry.off ?? []) soundingIds.delete(id);
    for (const id of entry.on ?? []) soundingIds.add(id);
    scanIndex++;
  }
  return soundingIds;
}

/** Toggles the playing CSS class on SVG note groups to match the playhead. */
function updatePlayhead(ppq: number): void {
  const host = svgHost.value;
  if (!host) return;
  const next = soundingIdsAt(ppq - store.clipStartPpq);
  for (const id of [...highlightedIds]) {
    if (!next.has(id)) {
      host.querySelector(`#${CSS.escape(id)}`)?.classList.remove('score-note-playing');
      highlightedIds.delete(id);
    }
  }
  for (const id of next) {
    if (!highlightedIds.has(id)) {
      const el = host.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        el.classList.add('score-note-playing');
        highlightedIds.add(id);
      }
    }
  }
}

watchEffect(() => {
  // Track both the rendered SVG and the playhead position.
  void svg.value;
  const getter = props.positionPpq;
  if (!getter) return;
  updatePlayhead(getter());
});

// --- Click-to-seek / select ------------------------------------------------------

/**
 * Quantized onset of an editor note, mirroring the display quantizer's grid
 * rounding (nearest grid step anchored at the clip start, clamped into the
 * clip window). Returns null for notes outside the notated window.
 */
function quantizedOnsetPpq(note: { startPpq: number; durationPpq: number }): number | null {
  const clipStart = store.clipStartPpq;
  const clipEnd = clipStart + store.clipLengthPpq;
  if (note.startPpq + note.durationPpq <= clipStart || note.startPpq >= clipEnd) return null;
  const grid = divisionPpq();
  const snapped = clipStart + Math.round((note.startPpq - clipStart) / grid) * grid;
  return Math.min(Math.max(snapped, clipStart), clipEnd - grid);
}

/**
 * Resolves the editor notes a clicked score note stands for: primarily notes
 * whose quantized onset matches the note's qstamp; when none match (e.g. the
 * tail of a tie chain), notes whose raw interval contains the position.
 */
function noteIdsAt(ppq: number): number[] {
  const exact: number[] = [];
  const sounding: number[] = [];
  for (const note of store.notes) {
    const onset = quantizedOnsetPpq(note);
    if (onset !== null && Math.abs(onset - ppq) < ONSET_MATCH_EPSILON_PPQ) exact.push(note.id);
    if (note.startPpq <= ppq && ppq < note.startPpq + note.durationPpq) sounding.push(note.id);
  }
  return exact.length > 0 ? exact : sounding;
}

/** Click on an engraved note: seek the transport and select the source notes. */
function onSvgClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const group = target.closest('g.note');
  if (!group?.id) return;
  const entry = timemap.find((e) => e.on?.includes(group.id));
  if (!entry) return;
  const ppq = store.clipStartPpq + entry.qstamp;
  const ids = noteIdsAt(ppq);
  if (annotateEnabled.value) onAnnotateClick(event, ids);
  emit('seek', ppq);
  setSelection(ids);
}

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
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Removes every annotation of the target note. */
function clearAnnotation(): void {
  const id = annotationNoteId.value;
  if (id === null) return;
  try {
    clearNoteAnnotation(store.clipId, id);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
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
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

// --- Reactive re-transcription -----------------------------------------------------

function scheduleRetranscribe(): void {
  if (retranscribeTimer !== null) clearTimeout(retranscribeTimer);
  retranscribeTimer = setTimeout(() => {
    retranscribeTimer = null;
    void transcribe();
  }, RETRANSCRIBE_DEBOUNCE_MS);
}

// The note mirror is replaced wholesale on every command, so identity
// tracking fires once per edit. Option changes re-transcribe immediately.
watch(() => store.notes, scheduleRetranscribe);
// Annotations and display transpose are replaced wholesale by their commands
// too; both only affect engraving, so they re-transcribe debounced like edits.
watch([() => store.scoreAnnotations, () => store.displayTransposeSemitones], scheduleRetranscribe);
watch([dqKey, chordsEnabled, () => store.scaleHighlight], () => void transcribe(), { deep: true });
// Zoom-out padding changes the number of (empty) measures, so the score must be
// re-engraved; zoom-in (padMeasures stays 0) only updates the CSS width.
watch(padMeasures, () => void transcribe());
watch([pageFormat, landscape, pageMarginMm, scalePercent, spacingStaff], () => void applyLayout());
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
  void transcribe();
});

onBeforeUnmount(() => {
  if (retranscribeTimer !== null) {
    clearTimeout(retranscribeTimer);
    retranscribeTimer = null;
  }
  generation++;
  client.value?.dispose();
  client.value = null;
});
</script>

<template>
  <section class="score-panel">
    <div class="score-toolbar" role="toolbar" aria-label="Score tools">
      <label class="bar-field" title="Display quantize: changes the engraved view only, never the MIDI data">
        DQ
        <SelectMenu v-model="dqKey" :options="dqOptions" aria-label="Display quantize" size="sm" />
      </label>
      <button type="button" :disabled="loading" title="Re-transcribe the clip (non-destructive)" @click="transcribe">
        Transcribe
      </button>
      <button type="button" :disabled="loading || pageCount === 0" title="Re-render the current page" @click="refresh">
        Refresh
      </button>
      <label class="bar-field" title="Show estimated chord symbols above the staff">
        <input v-model="chordsEnabled" type="checkbox" />
        Chords
      </label>
      <button
        type="button"
        :class="{ active: annotateEnabled }"
        :aria-pressed="annotateEnabled"
        title="Annotate: click an engraved note to add dynamics, articulations and slurs (display-only, never changes MIDI)"
        @click="annotateEnabled = !annotateEnabled"
      >
        Annotate
      </button>
      <div class="layout-host">
        <button type="button" aria-haspopup="true" :aria-expanded="layoutOpen" @click="layoutOpen = !layoutOpen">
          Layout
        </button>
        <div v-if="layoutOpen" class="layout-popover">
          <label class="layout-row">
            Page
            <SelectMenu
              v-model="pageFormat"
              :options="pageFormatOptions"
              aria-label="Page format"
              size="sm"
            />
          </label>
          <label class="layout-row">
            Orientation
            <SelectMenu
              v-model="orientation"
              :options="ORIENTATION_OPTIONS"
              aria-label="Orientation"
              size="sm"
            />
          </label>
          <label class="layout-row">
            Margin (mm)
            <input v-model.number="pageMarginMm" type="number" min="0" max="40" step="1" />
          </label>
          <label class="layout-row">
            Scale (%)
            <input v-model.number="scalePercent" type="number" min="20" max="100" step="5" />
          </label>
          <label class="layout-row">
            Staff spacing
            <input v-model.number="spacingStaff" type="number" min="0" max="48" step="1" />
          </label>
          <label
            class="layout-row"
            title="Shifts the engraved pitches only — the MIDI notes are never changed"
          >
            Transpose (st)
            <SelectMenu
              :model-value="store.displayTransposeSemitones"
              :options="transposeOptions"
              aria-label="Display transpose"
              size="sm"
              @change="onTransposeChange"
            />
          </label>
        </div>
      </div>
      <div class="score-zoom" role="group" aria-label="Score zoom">
        <button
          type="button"
          class="score-zoom-btn"
          :disabled="viewZoom <= VIEW_ZOOM_MIN"
          aria-label="Zoom out"
          title="Zoom out"
          @click="zoomView(1 / VIEW_ZOOM_STEP)"
        >
          −
        </button>
        <span class="score-zoom-readout" aria-live="polite">{{ zoomPercent }}%</span>
        <button
          type="button"
          class="score-zoom-btn"
          :disabled="viewZoom >= VIEW_ZOOM_MAX"
          aria-label="Zoom in"
          title="Zoom in"
          @click="zoomView(VIEW_ZOOM_STEP)"
        >
          +
        </button>
      </div>
      <span class="bar-spacer" />
      <button type="button" :disabled="page <= 1 || loading" aria-label="Previous page" @click="gotoPage(page - 1)">
        ◀
      </button>
      <span class="score-page-indicator" aria-live="polite">
        {{ pageCount > 0 ? `${page} / ${pageCount}` : '– / –' }}
      </span>
      <button
        type="button"
        :disabled="page >= pageCount || loading"
        aria-label="Next page"
        @click="gotoPage(page + 1)"
      >
        ▶
      </button>
      <span class="bar-spacer" />
      <button type="button" :disabled="exporting || pageCount === 0" @click="onPrint">Print</button>
      <button type="button" :disabled="exporting || pageCount === 0" @click="onExportPdf">PDF</button>
      <button type="button" :disabled="exporting || !currentXml" @click="onExportMusicXml">
        MusicXML
      </button>
    </div>
    <p v-if="error" class="score-error" role="alert">{{ error }}</p>
    <div class="score-body-wrap">
      <!-- biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced locally by the Verovio worker -->
      <div
        ref="svgHost"
        class="score-body"
        role="img"
        aria-label="Engraved score"
        :style="{ '--score-zoom': widthFactor }"
        @click="onSvgClick"
        v-html="svg"
      />
      <div v-if="loading" class="score-loading">Engraving…</div>
      <div v-else-if="!svg" class="score-empty">No score yet — press Transcribe.</div>
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
    </div>
  </section>
</template>

<style scoped src="./score-panel.css"></style>
