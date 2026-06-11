<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import {
  canonicalizeChordSymbols,
  type EstimatedChordSymbol,
  estimateChordSymbols,
} from '@/notation/chords';
import { exportMusicXml } from '@/notation/io';
import { timeSigLengthPpq } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { keyToKeyFifths } from '@/notation/pitch-spelling';
import { downloadBlob, exportPdf, type PageLayout, printScore } from '@/notation/print';
import { quantizeToScore } from '@/notation/quantize';
import { type LayoutOptions, VerovioClient } from '@/notation/verovio';
import {
  DISPLAY_TRANSPOSE_MAX,
  DISPLAY_TRANSPOSE_MIN,
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  type NoteArticulation,
  type NoteDynamics,
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

// --- Annotation state ----------------------------------------------------------

/** Display labels for the articulation palette buttons. */
const ARTICULATION_LABELS: Readonly<Record<NoteArticulation, string>> = {
  staccato: 'Stacc.',
  accent: 'Accent',
  tenuto: 'Ten.',
  marcato: 'Marc.',
};

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

/** Page formats offered in the layout popover, in millimeters. */
const PAGE_FORMATS = {
  a4: { label: 'A4', widthMm: 210, heightMm: 297 },
  letter: { label: 'Letter', widthMm: 215.9, heightMm: 279.4 },
} as const;

type PageFormatKey = keyof typeof PAGE_FORMATS;

const layoutOpen = ref(false);
const pageFormat = ref<PageFormatKey>('a4');
const landscape = ref(false);
const pageMarginMm = ref(10);
const scalePercent = ref(50);
const spacingStaff = ref(12);

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

/** Page dimensions in millimeters honoring the orientation setting. */
function pageDimsMm(): PageLayout {
  const format = PAGE_FORMATS[pageFormat.value];
  return landscape.value
    ? { pageWidthMm: format.heightMm, pageHeightMm: format.widthMm }
    : { pageWidthMm: format.widthMm, pageHeightMm: format.heightMm };
}

/** Verovio layout options for the current settings (page units are 1/10 mm). */
function layoutOptions(): LayoutOptions {
  const dims = pageDimsMm();
  const margin = Math.round(Math.max(0, pageMarginMm.value) * 10);
  return {
    pageWidth: Math.round(dims.pageWidthMm * 10),
    pageHeight: Math.round(dims.pageHeightMm * 10),
    pageMarginTop: margin,
    pageMarginBottom: margin,
    pageMarginLeft: margin,
    pageMarginRight: margin,
    scale: Math.min(100, Math.max(20, Math.round(scalePercent.value))),
    spacingStaff: Math.max(0, Math.round(spacingStaff.value)),
    breaks: 'auto',
    svgViewBox: true,
    header: 'none',
    footer: 'none',
  };
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
      clipLengthPpq: store.clipLengthPpq,
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
    const count = await verovio.load(xml, layoutOptions());
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
    const count = await verovio.setLayout(layoutOptions());
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

/** Renders every page of the loaded score to SVG strings. */
async function renderAllPages(): Promise<string[]> {
  const verovio = client.value;
  if (!verovio || pageCount.value === 0) return [];
  const pages: string[] = [];
  for (let p = 1; p <= pageCount.value; p++) {
    pages.push(await verovio.renderPage(p));
  }
  return pages;
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
    if (pages.length > 0) printScore(pages, pageDimsMm());
  });
}

function onExportPdf(): void {
  void runExport(async () => {
    const pages = await renderAllPages();
    if (pages.length === 0) return;
    const blob = await exportPdf(pages, pageDimsMm());
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

/** Toggles a dynamics marking on the target note (same value clears it). */
function toggleDynamics(value: NoteDynamics): void {
  applyAnnotation({ dynamics: annotationCurrent.value.dynamics === value ? null : value });
}

/** Toggles an articulation marking on the target note (same value clears it). */
function toggleArticulation(value: NoteArticulation): void {
  applyAnnotation({ articulation: annotationCurrent.value.articulation === value ? null : value });
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
function onTransposeChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
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
        <select v-model="dqKey">
          <option
            v-for="choice in DQ_CHOICES"
            :key="choice.key"
            :value="choice.key"
            :disabled="choice.disabled"
          >
            {{ choice.label }}
          </option>
        </select>
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
            <select v-model="pageFormat">
              <option v-for="(format, key) in PAGE_FORMATS" :key="key" :value="key">
                {{ format.label }}
              </option>
            </select>
          </label>
          <label class="layout-row">
            Orientation
            <select v-model="landscape">
              <option :value="false">Portrait</option>
              <option :value="true">Landscape</option>
            </select>
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
            <select :value="store.displayTransposeSemitones" @change="onTransposeChange">
              <option v-for="n in TRANSPOSE_CHOICES" :key="n" :value="n">
                {{ n > 0 ? `+${n}` : String(n) }}
              </option>
            </select>
          </label>
        </div>
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
        @click="onSvgClick"
        v-html="svg"
      />
      <div v-if="loading" class="score-loading">Engraving…</div>
      <div v-else-if="!svg" class="score-empty">No score yet — press Transcribe.</div>
      <div
        v-if="annotateEnabled && annotationNoteId !== null"
        class="annotation-palette"
        role="dialog"
        aria-label="Note annotations"
        :style="{ left: `${palettePos.x}px`, top: `${palettePos.y}px` }"
      >
        <div class="palette-row">
          <button
            v-for="d in NOTE_DYNAMICS"
            :key="d"
            type="button"
            class="palette-dynamics"
            :class="{ active: annotationCurrent.dynamics === d }"
            :aria-pressed="annotationCurrent.dynamics === d"
            @click="toggleDynamics(d)"
          >
            {{ d }}
          </button>
        </div>
        <div class="palette-row">
          <button
            v-for="a in NOTE_ARTICULATIONS"
            :key="a"
            type="button"
            :class="{ active: annotationCurrent.articulation === a }"
            :aria-pressed="annotationCurrent.articulation === a"
            @click="toggleArticulation(a)"
          >
            {{ ARTICULATION_LABELS[a] }}
          </button>
        </div>
        <div class="palette-row">
          <button
            type="button"
            :class="{ active: slurArmed }"
            :aria-pressed="slurArmed"
            title="Slur to another note: arm, then click the target note in the score"
            @click="slurArmed = !slurArmed"
          >
            {{ slurArmed ? 'Click target…' : 'Slur…' }}
          </button>
          <button
            v-if="annotationCurrent.slurToNoteId !== undefined"
            type="button"
            title="Remove the slur starting on this note"
            @click="applyAnnotation({ slurToNoteId: null })"
          >
            Unslur
          </button>
          <button type="button" title="Remove all annotations of this note" @click="clearAnnotation">
            Clear
          </button>
          <button type="button" aria-label="Close annotation palette" @click="closePalette">×</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.score-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #15171c;
  border-top: 1px solid #000;
}

.score-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  background: #101216;
  border-bottom: 1px solid #000;
  flex-wrap: wrap;
  font-size: 12px;
}

.bar-field {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}

.bar-spacer {
  width: 0.75rem;
}

.score-page-indicator {
  font-variant-numeric: tabular-nums;
  color: #8b93a3;
  min-width: 3.5rem;
  text-align: center;
}

.layout-host {
  position: relative;
}

.layout-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  background: #1b1e25;
  border: 1px solid #000;
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  font-size: 12px;
  min-width: 12rem;
}

.layout-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  white-space: nowrap;
}

.layout-row input,
.layout-row select {
  width: 6rem;
}

.score-error {
  margin: 0;
  background: #3b1219;
  border-bottom: 1px solid #ef4444;
  color: #ffb4b4;
  padding: 0.4rem 0.75rem;
  font-size: 12px;
  white-space: pre-wrap;
}

.score-body-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.score-body {
  height: 100%;
  overflow: auto;
  background: #f5f2ea;
  padding: 0.5rem;
}

.score-body :deep(svg) {
  display: block;
  margin: 0 auto;
  max-width: 100%;
  height: auto;
  background: #fff;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
}

.score-body :deep(g.note) {
  cursor: pointer;
  /* Make the whole note group (notehead + stem + the space between) clickable,
     not just the painted glyph outlines. */
  pointer-events: bounding-box;
}

.score-body :deep(.score-note-playing),
.score-body :deep(.score-note-playing *) {
  fill: #2563eb;
  color: #2563eb;
  stroke: #2563eb;
}

.score-toolbar button.active {
  background: #2563eb;
  color: #fff;
}

.annotation-palette {
  position: absolute;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.45rem 0.5rem;
  background: #1b1e25;
  border: 1px solid #000;
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  font-size: 11px;
}

.palette-row {
  display: flex;
  gap: 0.25rem;
}

.annotation-palette button.active {
  background: #2563eb;
  color: #fff;
}

.palette-dynamics {
  font-style: italic;
  font-weight: 600;
  min-width: 1.8rem;
}

.score-loading,
.score-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #4b5563;
  pointer-events: none;
}

.score-loading {
  background: rgba(245, 242, 234, 0.6);
}
</style>
