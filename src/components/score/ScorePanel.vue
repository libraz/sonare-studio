<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import AccessibleObjectNavigator from '@/components/accessibility/AccessibleObjectNavigator.vue';
import TheoryCardView from '@/components/compose/TheoryCardView.vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import ScoreAnnotationPalette from '@/components/score/ScoreAnnotationPalette.vue';
import ScoreToolbar from '@/components/score/ScoreToolbar.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import { GM_PERCUSSION_CHANNEL, isDrumTrack, preferredNoteChannel } from '@/compose/tracks';
import { describeError } from '@/lib/errors';
import { clamp } from '@/lib/math';
import { scoreClipWindow } from '@/notation/score-clip-window';
import { VerovioClient } from '@/notation/verovio';
import {
  SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ,
  type ScoreDisplayQuantizeKey,
  type ScoreDisplaySettings,
} from '@/project/annotations';
import { addNote, applyNoteEdits, clearTrackMidiFx, setDisplayTranspose } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { MAX_PITCH, MIN_PITCH } from '@/ui/canvas/timeline-range';
import { useI18n } from '@/ui/i18n';
import type { ScoreLayoutSettings } from '@/ui/score/layout';
import { scoreOmitsMidiFx } from '@/ui/score/midi-fx-notice';
import { type PlayheadSync, usePlayheadSync } from '@/ui/score/use-playhead-sync';
import { useScoreAccessibleNotes } from '@/ui/score/use-score-accessible-notes';
import { useScoreAnnotations } from '@/ui/score/use-score-annotations';
import { useScoreInteractions } from '@/ui/score/use-score-interactions';
import { useScoreMarkerTools } from '@/ui/score/use-score-marker-tools';
import { useScoreNotation } from '@/ui/score/use-score-notation';
import { CARD_POINTER_OFFSET_PX, useScoreTheoryCard } from '@/ui/score/use-score-theory-card';

/**
 * Engraved score view over the piano-roll clip.
 *
 * The notation pipeline is display-only: editor notes are quantized to a
 * NotatedScore (never written back to MIDI), serialized to MusicXML and
 * engraved by the Verovio worker. Display Quantize changes only re-run this
 * pipeline; the project's note data is never touched. The panel's own gestures
 * (N to add, double-click to insert, vertical drag to re-pitch) are undoable
 * note commands on the clip.
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
  /** Skip harmonic analysis while the score is hidden in another dock tab. */
  guidanceEnabled?: boolean;
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
  key: ScoreDisplayQuantizeKey;
  label: string;
}

function displayQuantizeLabel(key: ScoreDisplayQuantizeKey): string {
  const triplet = key.endsWith('t');
  return `1/${triplet ? key.slice(0, -1) : key}${triplet ? ' T' : ''}`;
}

const DQ_CHOICES: ReadonlyArray<DqChoice> = (
  Object.keys(SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ) as ScoreDisplayQuantizeKey[]
).map((key) => ({ key, label: displayQuantizeLabel(key) }));

function projectScoreSetting<K extends keyof ScoreDisplaySettings>(key: K) {
  return computed<ScoreDisplaySettings[K]>({
    get: () => store.scoreDisplaySettings[key],
    set: (value) => {
      store.scoreDisplaySettings = { ...store.scoreDisplaySettings, [key]: value };
    },
  });
}

const dqKey = projectScoreSetting('displayQuantizeKey');
const chordsEnabled = projectScoreSetting('chordsEnabled');
const fullScoreEnabled = projectScoreSetting('fullScoreEnabled');
const estimateFingering = projectScoreSetting('estimateFingering');

/** Display Quantize options for the toolbar select. */
const dqOptions = computed(() =>
  DQ_CHOICES.map((choice) => ({
    value: choice.key,
    label: choice.label,
  })),
);

const pageFormat = projectScoreSetting('pageFormat');
const landscape = projectScoreSetting('landscape');
const pageMarginMm = projectScoreSetting('pageMarginMm');
const scalePercent = projectScoreSetting('scalePercent');
const spacingStaff = projectScoreSetting('spacingStaff');
const barsPerSystem = projectScoreSetting('barsPerSystem');
const barsPerPage = projectScoreSetting('barsPerPage');
const grandStaffSplitPitch = projectScoreSetting('grandStaffSplitPitch');

/** On-screen zoom relative to the height-fit score size. */
const viewZoom = projectScoreSetting('viewZoom');
const VIEW_ZOOM_MIN = 0.25;
const VIEW_ZOOM_MAX = 4;
const VIEW_ZOOM_STEP = 1.2;

/**
 * Time signature in effect at the clip start, taken from the project's meter
 * map (4/4 fallback when none is modelled). The score is notated in this
 * meter so bar lines, beaming, rests and chord placement match the project.
 */
const clipScoreWindow = computed(() =>
  scoreClipWindow({
    clipStartPpq: store.clipStartPpq,
    clipLengthPpq: store.clipLengthPpq,
    pickupLengthPpq: store.pickupLengthPpq,
    timeSignatures: store.timeSignatures,
  }),
);

const clipTimeSig = computed(() => clipScoreWindow.value.timeSig);

/** Engraved measure length in PPQ for the clip's time signature. */
const measureLenPpq = computed(() => clipScoreWindow.value.measureLenPpq);

/** Clip length fed to the transcriber, preserving an opening pickup boundary. */
const screenClipLengthPpq = computed(() => clipScoreWindow.value.clipLengthPpq);

/** On-screen zoom as a rounded percentage for the toolbar readout. */
const zoomPercent = computed(() => Math.round(viewZoom.value * 100));
const midiFxNoticeVisible = computed(() => scoreOmitsMidiFx(store.activeTrack));

/** Multiplies the on-screen zoom by a factor, clamped to the zoom bounds. */
function zoomView(factor: number): void {
  viewZoom.value = clamp(viewZoom.value * factor, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
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
  return SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ[dqKey.value];
}

/**
 * Key signature fifths derived from the scale highlight configuration.
 * Diatonic mode masks map to their matching MusicXML key signature; custom
 * masks fall back to C major.
 */
function keyFifths(): number {
  return keyFifthsForScaleHighlight(store.scaleHighlight);
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
  getPickupLengthPpq: () => store.pickupLengthPpq,
  getKeyFifths: keyFifths,
  getChordsEnabled: () => chordsEnabled.value,
  getFullScoreEnabled: () => fullScoreEnabled.value,
  getEstimateFingering: () => estimateFingering.value,
  getGrandStaffSplitPitch: () => grandStaffSplitPitch.value,
  getLayoutSettings: layoutSettings,
  resetPlayheadScan: () => playhead?.resetScan(),
  createClient: () => new VerovioClient(),
});
// Resolving the current artifact rebuilds its identity, so cache it instead of
// recomputing it on every render.
const hasCurrentXml = computed(() => !!notation.getCurrentXml());
const currentPartName = computed(() => notation.getCurrentPartName());

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

// --- Annotation palette ------------------------------------------------------------

const {
  annotateEnabled,
  annotationNoteId,
  annotationClipId,
  palettePos,
  slurArmed,
  hairpinArmed,
  lineSpanArmed,
  annotationCurrent,
  openPalette,
  armSlur,
  armHairpin,
  armLineSpan,
  onAnnotateClick,
  onAnnotateStaffDrag,
  applyAnnotation,
  clearAnnotation,
  closePalette,
} = useScoreAnnotations({
  store,
  svgHost,
  tryScoreEdit,
  transcribe: () => notation.transcribe(),
});

const {
  accessibleScoreSources,
  accessibleScoreItems,
  activateAccessibleScoreNote,
  annotateAccessibleScoreNote,
} = useScoreAccessibleNotes({
  store,
  getFullScoreEnabled: () => fullScoreEnabled.value,
  getScreenClipLengthPpq: () => screenClipLengthPpq.value,
  seek: (ppq) => emit('seek', ppq),
  openPalette,
});

const {
  lyricInput,
  lyricVerseInput,
  lyricSyllabicInput,
  lyricExtendInput,
  keyRootInput,
  keyModeInput,
  keyRootOptions,
  keyModeOptions,
  lyricSyllabicOptions,
  onLyricEnter,
  addLyricMarker,
  addKeyMarker,
} = useScoreMarkerTools({
  store,
  getPositionPpq: () => props.positionPpq?.(),
  getScreenClipLengthPpq: () => screenClipLengthPpq.value,
  getSources: () => accessibleScoreSources.value,
  tryScoreEdit,
  transcribe: () => notation.transcribe(),
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
  onNotePitchDrag: (ids, semitones) => {
    const clip = store.activeClip;
    if (!clip) return;
    tryScoreEdit(() =>
      applyNoteEdits({
        updates: ids.map((id, index) => {
          const note = clip.notes.find((entry) => entry.id === id);
          return note === undefined
            ? { id }
            : { id, pitch: clamp(note.pitch + semitones[index], MIN_PITCH, MAX_PITCH) };
        }),
      }),
    );
  },
  onInsertAt: (startPpq) => {
    const source = store.notes.find((note) => store.selection.has(note.id));
    const track = store.activeTrack;
    const trackNotes = track
      ? (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes)
      : store.notes;
    const drum = isDrumTrack(track, trackNotes);
    tryScoreEdit(() =>
      addNote({
        pitch: source?.pitch ?? (drum ? 36 : 60),
        velocity: source?.velocity ?? 96,
        channel: drum
          ? GM_PERCUSSION_CHANNEL
          : (source?.channel ?? preferredNoteChannel(track, trackNotes)),
        startPpq,
        durationPpq: source?.durationPpq ?? divisionPpq(),
      }),
    );
  },
});

// --- Theory hover card -------------------------------------------------------------

const guidance = useCompositionGuidance({ enabled: () => props.guidanceEnabled !== false });
const { hoverCard, hoverCardPos, cardHold, onScorePointerMove, onScorePointerLeave } =
  useScoreTheoryCard({
    store,
    guidance,
    interactions,
    svgHost,
    isAnnotateEnabled: () => annotateEnabled.value,
  });

/** Score-local add-note key; delete, undo and locator keys bubble to the global handler. */
function onScoreKeyDown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() !== 'n') return;
  const selected = store.notes.filter((note) => store.selection.has(note.id));
  if (selected.length === 0) return;
  event.preventDefault();
  // One note per physical press: a held key must not stack duplicates.
  if (event.repeat) return;
  const source = selected[selected.length - 1];
  tryScoreEdit(() =>
    addNote({
      pitch: source.pitch,
      velocity: source.velocity,
      channel: source.channel,
      startPpq: source.startPpq + source.durationPpq,
      durationPpq: source.durationPpq,
      ...(source.offVelocity !== undefined ? { offVelocity: source.offVelocity } : {}),
    }),
  );
}

/** Runs a score edit, clearing the panel error on success and surfacing a thrown one. */
function tryScoreEdit(edit: () => void): boolean {
  try {
    edit();
    notation.setError('');
    return true;
  } catch (err) {
    notation.setError(describeError(err, t.value.notices.errors));
    return false;
  }
}

/** Removes the active track's live MIDI FX as one undoable edit. */
function clearActiveTrackMidiFx(): void {
  const trackId = store.activeTrack?.id;
  if (trackId === undefined) return;
  tryScoreEdit(() => clearTrackMidiFx(trackId));
}

/** Layout popover change handler for the display transpose select. */
function onTransposeChange(value: number): void {
  tryScoreEdit(() => setDisplayTranspose(value));
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
watch([() => store.documentGeneration, () => store.clipId], ([generation, clipId], [prior]) => {
  if (retranscribeTimer !== null) {
    clearTimeout(retranscribeTimer);
    retranscribeTimer = null;
  }
  // An annotate click that switched the clip already targeted the new clip.
  if (generation !== prior || annotationClipId.value !== clipId) closePalette();
  playhead?.resetScan();
  notesHandledForClipId = store.clipId;
  notation.bumpGeneration(true);
  void notation.transcribe();
});
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
// Annotations, display transpose and the track list are replaced wholesale by
// their commands too, so they re-transcribe debounced like edits.
watch(
  [
    () => store.scoreAnnotations,
    () => store.displayTransposeSemitones,
    () => store.clips,
    () => store.tracks,
    () => store.sections,
    () => store.markers,
    () => store.tempoSegments,
    () => store.tempoBpm,
    () => store.timeSignatures,
    () => store.pickupLengthPpq,
    () => store.projectName,
  ],
  scheduleRetranscribe,
);
watch(
  [dqKey, chordsEnabled, fullScoreEnabled, estimateFingering, () => store.scaleHighlight],
  () => void notation.transcribe(),
  {
    deep: true,
  },
);
watch(
  [pageFormat, landscape, pageMarginMm, scalePercent, spacingStaff],
  () => void notation.applyLayout(),
);
watch([barsPerSystem, barsPerPage], () => void notation.transcribe());
watch(grandStaffSplitPitch, () => void notation.transcribe());

/** True while a freshly swapped-in page SVG plays its page-turn fade. */
const pageTurning = ref(false);
let pageTurnPending = false;

// Only a page navigation fades the new page in; edit re-engravings swap silently.
watch([() => notation.page.value, () => notation.svg.value], ([page, svg], [prevPage, prevSvg]) => {
  if (page !== prevPage) pageTurnPending = true;
  if (svg !== prevSvg && svg && pageTurnPending) {
    pageTurnPending = false;
    pageTurning.value = true;
  }
});

function onScoreAnimationEnd(event: AnimationEvent): void {
  if ((event.target as Element | null)?.parentElement === svgHost.value) pageTurning.value = false;
}

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
  notation.bumpGeneration(true);
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
      v-model:estimate-fingering="estimateFingering"
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
      :has-xml="hasCurrentXml"
      :part-name="currentPartName"
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
      <button type="button" class="score-notice-action" @click="clearActiveTrackMidiFx">
        {{ t.shell.score.midiFxClear }}
      </button>
    </p>
    <div class="score-marker-tools" role="group" :aria-label="t.shell.score.markerTools">
      <label>
        {{ t.shell.score.lyricText }}
        <input
          v-model="lyricInput"
          type="text"
          :placeholder="t.shell.score.lyricPlaceholder"
          :aria-label="t.shell.score.lyricText"
          @keydown.enter="onLyricEnter"
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
        :class="{ 'score-page-turn': pageTurning }"
        tabindex="0"
        role="img"
        :aria-label="t.shell.score.engravedScore"
        :style="{ '--score-svg-height': `${scoreSvgHeightPx * viewZoom}px` }"
        @pointerdown="interactions.onSvgPointerDown"
        @pointermove="onScorePointerMove"
        @pointerup="interactions.onSvgPointerUp"
        @pointercancel="interactions.onSvgPointerCancel"
        @pointerleave="onScorePointerLeave"
        @click="interactions.onSvgClick"
        @dblclick.prevent="interactions.onSvgDoubleClick"
        @keydown="onScoreKeyDown"
        @animationend="onScoreAnimationEnd"
        v-html="notation.svg.value"
      />
      <AccessibleObjectNavigator
        :label="t.shell.score.accessibility.navigator"
        :empty-label="t.shell.score.accessibility.empty"
        :instructions="t.shell.score.accessibility.instructions"
        :edit-label="t.shell.score.accessibility.edit"
        :context-label="t.shell.score.accessibility.context"
        :items="accessibleScoreItems"
        @activate="activateAccessibleScoreNote"
        @context="annotateAccessibleScoreNote"
      />
      <TheoryCardView
        v-if="hoverCard"
        class="score-theory-card"
        :card="hoverCard"
        :style="{
          left: `${hoverCardPos.x}px`,
          top: `${hoverCardPos.y}px`,
          '--theory-card-reach': `${CARD_POINTER_OFFSET_PX}px`,
        }"
        @hold="cardHold.onHold"
      />
      <Transition name="fade">
        <BusyIndicator
          v-if="notation.loading.value"
          class="score-loading"
          variant="overlay"
          size="md"
          :label="t.shell.score.engraving"
        />
      </Transition>
      <EmptyState
        v-if="!notation.loading.value && !notation.svg.value"
        :message="t.shell.score.empty"
      >
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
      <Transition name="pop">
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
          @slur-armed-change="armSlur"
          @hairpin-armed-change="armHairpin"
          @line-span-armed-change="armLineSpan"
        />
      </Transition>
    </div>
  </section>
</template>

<style scoped src="./score-panel.css"></style>
