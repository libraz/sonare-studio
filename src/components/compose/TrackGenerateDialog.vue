<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { toSafetyProfile } from '@/compose/guidance-profile';
import {
  type BatchPartSpec,
  type BatchTarget,
  createLeadMelodyCommand,
  generateTracksBatchCommand,
  MAX_DRUM_DIFFICULTY,
  MIN_DRUM_DIFFICULTY,
  type TrackPart,
} from '@/project/commands';
import { normalizeGenerationSeed, partForTrack, partSeed } from '@/project/generation';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Flow B: the track generator. A checklist of the five instrumental parts
 * (motif, drums, bass, counter melody, backing), each with a write target and
 * an expandable parameter panel, generated together in one undoable batch. The
 * whole flow is gated behind a chord progression: with no chords the body is a
 * hard gate that routes back to Flow A.
 */

/** Context for opening pre-focused on one part (track-header "regenerate"). */
export interface TrackGenerateOpenWith {
  part: TrackPart;
  target: BatchTarget;
}

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** Optional pre-selection when opened from a track-header "regenerate". */
  openWith?: TrackGenerateOpenWith | null;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
  /** Request to open Flow A (gate's "create" button, or "edit chords" link). */
  openChords: [];
  /** The lead target was created or selected from the completion state. */
  composeLead: [];
}>();

const store = useProjectStore();
const appSettings = useAppSettings();
const { t } = useI18n();

const g = computed(() => t.value.shell.generate.track);

/** Beats per bar the generators assume (4/4). */
const BEATS_PER_BAR = 4;

const PART_IDS: readonly TrackPart[] = ['motif', 'drums', 'bass', 'counter', 'backing'];

/** Parts that occupy the mid register (may collide with one another). */
const MID_RANGE_PARTS: ReadonlySet<TrackPart> = new Set(['motif', 'counter', 'backing']);

const PART_LABEL_KEYS: Record<
  TrackPart,
  'partMotif' | 'partDrums' | 'partBass' | 'partCounter' | 'partBacking'
> = {
  motif: 'partMotif',
  drums: 'partDrums',
  bass: 'partBass',
  counter: 'partCounter',
  backing: 'partBacking',
};

const PART_ROLE_KEYS: Record<TrackPart, 'roleMid' | 'roleRhythm' | 'roleLow' | 'roleMidHigh'> = {
  motif: 'roleMid',
  drums: 'roleRhythm',
  bass: 'roleLow',
  counter: 'roleMidHigh',
  backing: 'roleMid',
};

/** Per-part checklist state (params live in the dedicated refs below). */
interface PartState {
  checked: boolean;
  expanded: boolean;
  /** Encoded target: 'new', `replace:<id>`, 'clip:append', 'clip:replace'. */
  target: string;
  /**
   * How many times this part has been rerolled under the project seed. Bumping
   * it gives the part unrelated material and leaves the other parts alone.
   */
  reroll: number;
}

function newPartState(): PartState {
  return { checked: false, expanded: false, target: 'new', reroll: 0 };
}

const parts = reactive<Record<TrackPart, PartState>>({
  motif: newPartState(),
  drums: newPartState(),
  bass: newPartState(),
  counter: newPartState(),
  backing: newPartState(),
});

/** The project seed, bound to the store so it is saved with the project. */
const projectSeed = computed({
  get: () => store.generationSeed,
  set: (value: number) => {
    store.generationSeed = normalizeGenerationSeed(value);
  },
});

/** Draws the seed for a part from the project seed and the part's reroll count. */
function seedFor(part: TrackPart): number {
  return partSeed(store.generationSeed, part, parts[part].reroll);
}

/** Rerolls one part, leaving every other part on the seed it already had. */
function reroll(part: TrackPart): void {
  parts[part].reroll += 1;
}

const error = ref<string | null>(null);
const generating = ref(false);
const done = ref(false);

// --- Length basis --------------------------------------------------------------

/** Chord progression length in whole bars (0 when there is no chord track). */
const chordProgressionBars = computed(() => {
  const end = store.chords.reduce((max, chord) => Math.max(max, chord.endPpq), 0);
  return Math.max(0, Math.round(end / BEATS_PER_BAR));
});

/** Active editable MIDI clip (enables motif's clip targets). */
const activeMidiClip = computed(() => {
  const clip = store.activeClip;
  const track = clip ? store.tracks.find((entry) => entry.id === clip.trackId) : null;
  return clip !== null && clipKind(clip) === 'midi' && track?.frozen === undefined ? clip : null;
});

/** Active MIDI clip used as the counter-melody source, including frozen clips. */
const counterSourceClip = computed(() => {
  const clip = store.activeClip;
  return clip !== null && clipKind(clip) === 'midi' ? clip : null;
});

/** Active MIDI clip's melody length in bars, or null when none is active. */
const counterBars = computed(() => {
  const clip = counterSourceClip.value;
  if (clip === null) return null;
  const notes = projectMidiNoteOccurrences(clip);
  if (notes.length === 0) return null;
  const end = notes.reduce((max, note) => Math.max(max, note.startPpq + note.durationPpq), 0);
  return Math.max(1, Math.round(end / BEATS_PER_BAR));
});

const hasChords = computed(() => store.chords.length > 0);
const counterAvailable = computed(() => counterBars.value !== null);

function isPartAvailable(part: TrackPart): boolean {
  return part !== 'counter' || counterAvailable.value;
}

// --- Part parameters -----------------------------------------------------------

type MotifContour = 'arch' | 'ascending' | 'descending' | 'wave';
const CONTOURS: ReadonlyArray<{
  id: MotifContour;
  labelKey: 'contourArch' | 'contourAscending' | 'contourDescending' | 'contourWave';
}> = [
  { id: 'arch', labelKey: 'contourArch' },
  { id: 'ascending', labelKey: 'contourAscending' },
  { id: 'descending', labelKey: 'contourDescending' },
  { id: 'wave', labelKey: 'contourWave' },
];
const motifBars = ref(2);
const motifBarsDirty = ref(false);
const motifContour = ref<MotifContour>('arch');
const motifDevelop = ref(true);

type GrooveId =
  | 'standard'
  | 'funk'
  | 'shuffle'
  | 'bossa'
  | 'trap'
  | 'halftime'
  | 'breakbeat'
  | 'house'
  | 'synthpop';
const GROOVES: ReadonlyArray<{
  id: GrooveId;
  labelKey:
    | 'grooveStandard'
    | 'grooveFunk'
    | 'grooveShuffle'
    | 'grooveBossa'
    | 'grooveTrap'
    | 'grooveHalftime'
    | 'grooveBreakbeat'
    | 'grooveHouse'
    | 'grooveSynthpop';
}> = [
  { id: 'standard', labelKey: 'grooveStandard' },
  { id: 'funk', labelKey: 'grooveFunk' },
  { id: 'shuffle', labelKey: 'grooveShuffle' },
  { id: 'bossa', labelKey: 'grooveBossa' },
  { id: 'trap', labelKey: 'grooveTrap' },
  { id: 'halftime', labelKey: 'grooveHalftime' },
  { id: 'breakbeat', labelKey: 'grooveBreakbeat' },
  { id: 'house', labelKey: 'grooveHouse' },
  { id: 'synthpop', labelKey: 'grooveSynthpop' },
];
type SectionId = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro';
const SECTIONS: ReadonlyArray<{
  id: SectionId;
  labelKey:
    | 'sectionIntro'
    | 'sectionVerse'
    | 'sectionPrechorus'
    | 'sectionChorus'
    | 'sectionBridge'
    | 'sectionOutro';
}> = [
  { id: 'intro', labelKey: 'sectionIntro' },
  { id: 'verse', labelKey: 'sectionVerse' },
  { id: 'prechorus', labelKey: 'sectionPrechorus' },
  { id: 'chorus', labelKey: 'sectionChorus' },
  { id: 'bridge', labelKey: 'sectionBridge' },
  { id: 'outro', labelKey: 'sectionOutro' },
];
const drumStyle = ref<GrooveId>('standard');
const drumSection = ref<SectionId>('verse');
const drumBars = ref(4);
const drumBarsDirty = ref(false);
const drumDensity = ref(0.6);
const drumFills = ref(true);
/**
 * Playing-difficulty ceiling for the groove; 0 means none. It rejects strokes
 * the density asked for and the tempo makes too fast to sustain, so it thins a
 * fast groove more than a slow one, and the two dials are not interchangeable.
 */
const drumDifficulty = ref(0);
const DRUM_DIFFICULTIES: ReadonlyArray<number> = Array.from(
  { length: MAX_DRUM_DIFFICULTY - MIN_DRUM_DIFFICULTY + 1 },
  (_unused, index) => MIN_DRUM_DIFFICULTY + index,
);

type BassStyle = 'root' | 'rootFifth' | 'pop' | 'walking' | 'arpeggio';
const BASS_STYLES: ReadonlyArray<{
  id: BassStyle;
  labelKey: 'bassRoot' | 'bassRootFifth' | 'bassPop' | 'bassWalking' | 'bassArpeggio';
}> = [
  { id: 'root', labelKey: 'bassRoot' },
  { id: 'rootFifth', labelKey: 'bassRootFifth' },
  { id: 'pop', labelKey: 'bassPop' },
  { id: 'walking', labelKey: 'bassWalking' },
  { id: 'arpeggio', labelKey: 'bassArpeggio' },
];
const bassStyle = ref<BassStyle>('root');

const counterRegister = ref<'above' | 'below'>('below');
const counterRhythm = ref<'complement' | 'follow'>('complement');

type BackingStyleId = 'smooth' | 'close' | 'drop2' | 'drop3' | 'shell' | 'rootless';
const BACKING_STYLES: ReadonlyArray<{
  id: BackingStyleId;
  labelKey:
    | 'backingSmooth'
    | 'backingClose'
    | 'backingDrop2'
    | 'backingDrop3'
    | 'backingShell'
    | 'backingRootless';
}> = [
  { id: 'smooth', labelKey: 'backingSmooth' },
  { id: 'close', labelKey: 'backingClose' },
  { id: 'drop2', labelKey: 'backingDrop2' },
  { id: 'drop3', labelKey: 'backingDrop3' },
  { id: 'shell', labelKey: 'backingShell' },
  { id: 'rootless', labelKey: 'backingRootless' },
];
const backingStyle = ref<BackingStyleId>('smooth');

// --- Length seeding (drums/motif default to the chord-progression length) ------

/** Re-seeds drums/motif bars from the progression length until manually edited. */
function reseedBars(): void {
  const bars = chordProgressionBars.value;
  if (bars > 0) {
    if (!drumBarsDirty.value) drumBars.value = bars;
    if (!motifBarsDirty.value) motifBars.value = bars;
  }
}

watch(chordProgressionBars, reseedBars);
watch(drumBars, (value) => {
  if (value !== chordProgressionBars.value) drumBarsDirty.value = true;
});
watch(motifBars, (value) => {
  if (value !== chordProgressionBars.value) motifBarsDirty.value = true;
});
watch(counterAvailable, (available) => {
  if (!available) {
    parts.counter.checked = false;
    parts.counter.expanded = false;
  }
});

// --- Open / reset --------------------------------------------------------------

function resetState(): void {
  for (const id of PART_IDS) {
    parts[id].checked = false;
    parts[id].expanded = false;
    parts[id].target = 'new';
  }
  error.value = null;
  done.value = false;
  drumBarsDirty.value = false;
  motifBarsDirty.value = false;
  reseedBars();
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    resetState();
    const openWith = props.openWith;
    if (openWith) {
      const state = parts[openWith.part];
      state.checked = isPartAvailable(openWith.part);
      state.expanded = isPartAvailable(openWith.part);
      const target = encodeTarget(openWith.target);
      if (targetOptions(openWith.part).some((option) => option.value === target)) {
        state.target = target;
      } else {
        state.target = 'new';
        error.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
      }
      if (!isPartAvailable(openWith.part)) error.value = g.value.counterUnavailable;
    } else {
      // The normal path is the quick beginner flow: generate a usable
      // accompaniment first, then continue into the lead composer. Keep
      // regeneration focused on the requested part via the branch above.
      presetAccompaniment();
    }
  },
  { immediate: true },
);

// --- Targets -------------------------------------------------------------------

function encodeTarget(target: BatchTarget): string {
  if (target.kind === 'new') return 'new';
  if (target.kind === 'replaceTrack') return `replace:${target.trackId}`;
  return `clip:${target.mode}`;
}

function decodeTarget(value: string): BatchTarget {
  if (value.startsWith('replace:')) {
    return { kind: 'replaceTrack', trackId: Number(value.slice('replace:'.length)) };
  }
  if (value === 'clip:append') return { kind: 'clip', mode: 'append' };
  if (value === 'clip:replace') return { kind: 'clip', mode: 'replace' };
  return { kind: 'new' };
}

/** Replacement candidates for a part: tracks recorded as (or named after) it. */
function replaceCandidates(part: TrackPart): { value: string; label: string }[] {
  return store.tracks
    .filter((track) => track.frozen === undefined && partForTrack(track) === part)
    .map((track) => ({
      value: `replace:${track.id}`,
      label: formatMessage(g.value.targetReplace, { name: track.name }),
    }));
}

/** Full target dropdown for a part. */
function targetOptions(part: TrackPart): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: 'new', label: g.value.targetNew }];
  if (part === 'motif' && activeMidiClip.value !== null) {
    options.push(
      { value: 'clip:append', label: g.value.targetClipAppend },
      { value: 'clip:replace', label: g.value.targetClipReplace },
    );
  }
  options.push(...replaceCandidates(part));
  return options;
}

// --- Derived checklist state ---------------------------------------------------

const selectedCount = computed(
  () => PART_IDS.filter((id) => parts[id].checked && isPartAvailable(id)).length,
);

const midOverlap = computed(
  () =>
    PART_IDS.filter((id) => parts[id].checked && isPartAvailable(id) && MID_RANGE_PARTS.has(id))
      .length >= 2,
);

/** Result length in bars shown on a part row (null = clip-derived, unknown). */
function resultBarsOf(part: TrackPart): number | null {
  switch (part) {
    case 'drums':
      return Math.max(1, Math.round(drumBars.value));
    case 'motif':
      return Math.max(1, Math.round(motifBars.value));
    case 'bass':
    case 'backing':
      return chordProgressionBars.value;
    case 'counter':
      return counterBars.value ?? chordProgressionBars.value;
  }
}

/** The "N bars" label on a part row, or empty when the length is unknown. */
function resultBarsText(part: TrackPart): string {
  const bars = resultBarsOf(part);
  return bars === null ? '' : formatMessage(g.value.resultBars, { count: bars });
}

/** The trailing "→ …" hint on a part row, from its target. */
function resultTargetOf(part: TrackPart): string {
  const value = parts[part].target;
  if (value.startsWith('clip:')) return g.value.resultToClip;
  if (value.startsWith('replace:')) return g.value.resultToReplace;
  return g.value.resultToNew;
}

// --- Presets -------------------------------------------------------------------

function applyPreset(ids: readonly TrackPart[]): void {
  for (const id of PART_IDS) parts[id].checked = ids.includes(id) && isPartAvailable(id);
}

function presetAccompaniment(): void {
  applyPreset(['drums', 'bass', 'backing']);
}

function presetAll(): void {
  applyPreset(PART_IDS);
}

function presetClear(): void {
  applyPreset([]);
}

// --- Generate ------------------------------------------------------------------

function paramsFor(part: TrackPart): BatchPartSpec['params'] {
  switch (part) {
    case 'motif':
      return {
        bars: Math.round(motifBars.value),
        contour: motifContour.value,
        develop: motifDevelop.value,
        seed: seedFor('motif'),
      };
    case 'drums':
      return {
        bars: Math.round(drumBars.value),
        style: drumStyle.value,
        section: drumSection.value,
        density: Math.min(1, Math.max(0, drumDensity.value)),
        fills: drumFills.value,
        ...(drumDifficulty.value > 0 ? { difficulty: drumDifficulty.value } : {}),
        seed: seedFor('drums'),
      };
    case 'bass':
      return { style: bassStyle.value, seed: seedFor('bass') };
    case 'counter':
      return {
        register: counterRegister.value,
        rhythm: counterRhythm.value,
        profile: toSafetyProfile(appSettings.settings.guidanceProfile),
        seed: seedFor('counter'),
      };
    case 'backing':
      return { style: backingStyle.value };
  }
}

function buildSpecs(): BatchPartSpec[] {
  const specs: BatchPartSpec[] = [];
  for (const part of PART_IDS) {
    if (!parts[part].checked || !isPartAvailable(part)) continue;
    const target = decodeTarget(parts[part].target);
    specs.push({ part, params: paramsFor(part), target } as BatchPartSpec);
  }
  return specs;
}

function onCancel(): void {
  emit('close');
}

function onGenerate(): void {
  if (selectedCount.value === 0 || generating.value) return;
  error.value = null;
  generating.value = true;
  try {
    const written = generateTracksBatchCommand(buildSpecs());
    const isRegeneration = props.openWith !== null && props.openWith !== undefined;
    if (written > 0 && !isRegeneration) done.value = true;
    else if (written > 0) emit('close');
    else error.value = g.value.error;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    generating.value = false;
  }
}

function onComposeLead(): void {
  error.value = null;
  try {
    const clipId = createLeadMelodyCommand(g.value.leadName);
    if (clipId === null) {
      error.value = g.value.leadError;
      return;
    }
    emit('composeLead');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function toggleExpanded(part: TrackPart): void {
  if (!isPartAvailable(part)) return;
  parts[part].expanded = !parts[part].expanded;
}
</script>

<template>
  <AppModal :open="props.open" size="md" :aria-label="g.title" @close="onCancel">
    <template #title>{{ g.title }}</template>

    <div v-if="!hasChords" class="gate">
      <p class="gate-title">{{ g.gateTitle }}</p>
      <p class="gate-body">{{ g.gateBody }}</p>
    </div>

    <div v-else-if="done" class="track-done">
      <div class="chord-summary">
        <span class="chord-summary-label">{{ g.chordSummaryLabel }}</span>
        <span class="chord-summary-bars">{{
          formatMessage(g.chordBars, { count: chordProgressionBars })
        }}</span>
      </div>
      <div class="done-message">
        <p class="done-title">{{ g.doneTitle }}</p>
        <p class="done-body">{{ g.doneBody }}</p>
      </div>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <div v-else class="track-fields">
      <div class="chord-summary">
        <span class="chord-summary-label">{{ g.chordSummaryLabel }}</span>
        <span class="chord-summary-bars">{{
          formatMessage(g.chordBars, { count: chordProgressionBars })
        }}</span>
        <button type="button" class="edit-chords" @click="emit('openChords')">
          {{ g.editChords }}
        </button>
      </div>

      <div class="seed-row">
        <label class="number-field">
          <span class="field-label">{{ g.projectSeed }}</span>
          <input v-model.number="projectSeed" type="number" min="0" step="1" />
        </label>
        <span class="seed-caption">{{ g.projectSeedCaption }}</span>
      </div>

      <div class="preset-row">
        <span class="field-label">{{ g.presetsLabel }}</span>
        <div class="preset-buttons">
          <button type="button" class="preset-chip" @click="presetAccompaniment">
            {{ g.presetAccompaniment }}
          </button>
          <button type="button" class="preset-chip" @click="presetAll">{{ g.presetAll }}</button>
          <button type="button" class="preset-chip" @click="presetClear">{{ g.presetClear }}</button>
        </div>
      </div>

      <div class="part-list">
        <div
          v-for="part in PART_IDS"
          :key="part"
          class="part-row"
          :class="{ checked: parts[part].checked }"
        >
          <div class="part-head">
            <label class="part-check" :class="{ disabled: !isPartAvailable(part) }">
              <input
                v-model="parts[part].checked"
                type="checkbox"
                :disabled="!isPartAvailable(part)"
                :aria-describedby="!isPartAvailable(part) ? `part-disabled-${part}` : undefined"
              />
              <span class="part-name">{{ g[PART_LABEL_KEYS[part]] }}</span>
            </label>
            <span class="part-role">{{ g[PART_ROLE_KEYS[part]] }}</span>
            <span class="part-result">
              <span>{{ resultBarsText(part) }}</span>
              <span class="part-result-target">{{ resultTargetOf(part) }}</span>
            </span>
            <select
              v-model="parts[part].target"
              class="part-target"
              :disabled="!isPartAvailable(part)"
            >
              <option v-for="option in targetOptions(part)" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <button
              type="button"
              class="part-expand"
              :aria-expanded="parts[part].expanded"
              :disabled="!isPartAvailable(part)"
              @click="toggleExpanded(part)"
            >
              {{ g.details }}
            </button>
          </div>
          <p
            v-if="!isPartAvailable(part)"
            :id="`part-disabled-${part}`"
            class="part-disabled-hint"
          >
            {{ g.counterUnavailable }}
          </p>

          <div v-if="parts[part].expanded" class="part-params">
            <template v-if="part === 'motif'">
              <span class="field-label">{{ g.contour }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.contour">
                <button
                  v-for="option in CONTOURS"
                  :key="option.id"
                  type="button"
                  class="segment"
                  :class="{ active: motifContour === option.id }"
                  role="radio"
                  :aria-checked="motifContour === option.id"
                  @click="motifContour = option.id"
                >
                  {{ g[option.labelKey] }}
                </button>
              </div>
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.bars }}</span>
                  <input v-model.number="motifBars" type="number" min="1" max="64" step="1" />
                  <span class="bars-caption">{{
                    formatMessage(g.barsCaption, { count: chordProgressionBars })
                  }}</span>
                </label>
                <div class="reroll-field">
                  <span class="field-label">{{ g.variation }}</span>
                  <button type="button" class="reroll-button" @click="reroll('motif')">
                    {{ g.reroll }}
                  </button>
                  <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.motif.reroll + 1 }) }}</span>
                </div>
              </div>
              <label class="check-label">
                <input v-model="motifDevelop" type="checkbox" />
                {{ g.develop }}
              </label>
            </template>

            <template v-else-if="part === 'drums'">
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.grooveStyle }}</span>
                  <select v-model="drumStyle">
                    <option v-for="option in GROOVES" :key="option.id" :value="option.id">
                      {{ g[option.labelKey] }}
                    </option>
                  </select>
                </label>
                <label class="number-field">
                  <span class="field-label">{{ g.section }}</span>
                  <select v-model="drumSection">
                    <option v-for="option in SECTIONS" :key="option.id" :value="option.id">
                      {{ g[option.labelKey] }}
                    </option>
                  </select>
                </label>
                <label class="number-field difficulty-field">
                  <span class="field-label">{{ g.difficulty }}</span>
                  <select v-model.number="drumDifficulty" v-tooltip="g.difficultyTitle">
                    <option :value="0">{{ g.difficultyNone }}</option>
                    <option v-for="level in DRUM_DIFFICULTIES" :key="level" :value="level">
                      {{ level }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="number-row">
                <label class="number-field">
                  <span class="field-label">{{ g.bars }}</span>
                  <input v-model.number="drumBars" type="number" min="1" max="64" step="1" />
                  <span class="bars-caption">{{
                    formatMessage(g.barsCaption, { count: chordProgressionBars })
                  }}</span>
                </label>
                <label class="number-field">
                  <span class="field-label">{{ g.density }}</span>
                  <input v-model.number="drumDensity" type="number" min="0" max="1" step="0.1" />
                </label>
                <div class="reroll-field">
                  <span class="field-label">{{ g.variation }}</span>
                  <button type="button" class="reroll-button" @click="reroll('drums')">
                    {{ g.reroll }}
                  </button>
                  <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.drums.reroll + 1 }) }}</span>
                </div>
              </div>
              <label class="check-label">
                <input v-model="drumFills" type="checkbox" />
                {{ g.fills }}
              </label>
            </template>

            <template v-else-if="part === 'bass'">
              <span class="field-label">{{ g.bassStyle }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.bassStyle">
                <button
                  v-for="option in BASS_STYLES"
                  :key="option.id"
                  type="button"
                  class="segment"
                  :class="{ active: bassStyle === option.id }"
                  role="radio"
                  :aria-checked="bassStyle === option.id"
                  @click="bassStyle = option.id"
                >
                  {{ g[option.labelKey] }}
                </button>
              </div>
              <div class="reroll-field">
                <span class="field-label">{{ g.variation }}</span>
                <button type="button" class="reroll-button" @click="reroll('bass')">
                  {{ g.reroll }}
                </button>
                <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.bass.reroll + 1 }) }}</span>
              </div>
            </template>

            <template v-else-if="part === 'counter'">
              <span class="field-label">{{ g.register }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.register">
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRegister === 'above' }"
                  role="radio"
                  :aria-checked="counterRegister === 'above'"
                  @click="counterRegister = 'above'"
                >
                  {{ g.registerAbove }}
                </button>
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRegister === 'below' }"
                  role="radio"
                  :aria-checked="counterRegister === 'below'"
                  @click="counterRegister = 'below'"
                >
                  {{ g.registerBelow }}
                </button>
              </div>
              <span class="field-label">{{ g.rhythm }}</span>
              <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.rhythm">
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRhythm === 'complement' }"
                  role="radio"
                  :aria-checked="counterRhythm === 'complement'"
                  @click="counterRhythm = 'complement'"
                >
                  {{ g.rhythmComplement }}
                </button>
                <button
                  type="button"
                  class="segment"
                  :class="{ active: counterRhythm === 'follow' }"
                  role="radio"
                  :aria-checked="counterRhythm === 'follow'"
                  @click="counterRhythm = 'follow'"
                >
                  {{ g.rhythmFollow }}
                </button>
              </div>
              <div class="reroll-field">
                <span class="field-label">{{ g.variation }}</span>
                <button type="button" class="reroll-button" @click="reroll('counter')">
                  {{ g.reroll }}
                </button>
                <span class="reroll-count">{{ formatMessage(g.variationIndex, { index: parts.counter.reroll + 1 }) }}</span>
              </div>
            </template>

            <template v-else-if="part === 'backing'">
              <label class="number-field">
                <span class="field-label">{{ g.backingStyle }}</span>
                <select v-model="backingStyle">
                  <option v-for="option in BACKING_STYLES" :key="option.id" :value="option.id">
                    {{ g[option.labelKey] }}
                  </option>
                </select>
              </label>
            </template>
          </div>
        </div>
      </div>

      <p v-if="midOverlap" class="collision-inline">{{ g.collisionMidOverlap }}</p>
      <p class="collision-note">{{ g.collisionNote }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <template v-if="!hasChords">
        <button type="button" @click="onCancel">{{ g.gateCancel }}</button>
        <button type="button" class="primary gate-create" @click="emit('openChords')">
          {{ g.gateCreate }}
        </button>
      </template>
      <template v-else-if="done">
        <button type="button" @click="onCancel">{{ g.close }}</button>
        <button type="button" class="primary compose-lead" @click="onComposeLead">
          {{ g.composeLead }}
        </button>
      </template>
      <template v-else>
        <button type="button" @click="onCancel">{{ g.cancel }}</button>
        <button
          type="button"
          class="primary generate-confirm"
          :disabled="selectedCount === 0 || generating"
          @click="onGenerate"
        >
          {{
            selectedCount === 0
              ? g.generateEmpty
              : selectedCount === 1
                ? g.generateOne
                : formatMessage(g.generate, { count: selectedCount })
          }}
        </button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.track-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 24rem;
  min-height: min(22rem, 52vh);
  max-height: 60vh;
  overflow-y: auto;
}

.track-done {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 24rem;
  min-height: min(22rem, 52vh);
}

.done-message {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: var(--sp-2);
}

.done-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.done-body {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* Header row: the chord-progression basis every part is written against. */
.chord-summary {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.chord-summary-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.chord-summary-bars {
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.edit-chords {
  margin-left: auto;
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-sm);
  cursor: pointer;
}

.edit-chords:hover {
  text-decoration: underline;
}

/* The one number the whole arrangement is drawn from, above the part list so
 * it reads as a project setting rather than a per-part dial. */
.seed-row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
}

.seed-row .number-field {
  flex: 0 0 10rem;
}

.seed-caption {
  padding-bottom: var(--sp-1);
  color: var(--text-3);
  font-size: var(--fs-xs);
}

/* A part is rerolled rather than given a seed of its own: the button bumps a
 * counter beneath the project seed, so the other parts keep what they had. */
.reroll-field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1 1 0;
}

.reroll-button {
  padding: var(--sp-1) var(--sp-3);
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.reroll-button:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.reroll-count {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.preset-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.preset-buttons {
  display: flex;
  gap: var(--sp-2);
}

.preset-chip {
  padding: var(--sp-1) var(--sp-3);
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.preset-chip:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.part-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* One part = a bordered card; checked cards carry the accent language (full
 * 1px border + light tint fill, no one-sided accent stripe). */
.part-row {
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.part-row.checked {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.part-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.part-check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  cursor: pointer;
}

.part-check.disabled {
  cursor: not-allowed;
}

.part-check.disabled .part-name {
  color: var(--text-2);
}

.part-name {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.part-role {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-result {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-result-target {
  color: var(--text-3);
}

.part-disabled-hint {
  margin: var(--sp-2) 0 0 calc(1rem + var(--sp-2));
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.part-target {
  max-width: 12rem;
}

.part-expand {
  padding: var(--sp-1) var(--sp-2);
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.part-expand:hover {
  text-decoration: underline;
}

.part-params {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.number-row {
  display: flex;
  gap: var(--sp-5);
}

.number-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: 1 1 0;
}

.number-field input,
.number-field select {
  width: 100%;
  box-sizing: border-box;
}

.bars-caption {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.check-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-md);
  color: var(--text-2);
}

.collision-inline {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.collision-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.gate {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 22rem;
  min-height: 5rem;
}

.gate-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.gate-body {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.dialog-error {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 0;
}
</style>
