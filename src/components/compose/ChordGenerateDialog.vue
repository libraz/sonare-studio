<script setup lang="ts">
import { type ProgStyle, progressionsByStyle } from '@libraz/libcantus';
import { computed, reactive, ref, watch } from 'vue';
import ProgressionPresetPicker from '@/components/compose/ProgressionPresetPicker.vue';
import { keyLabel, matchModeChoiceId } from '@/components/lists/key-modes';
import AppModal from '@/components/shell/AppModal.vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { effectiveKeyScale } from '@/compose/key';
import { generateProgressionCommand, harmonizeFromMelodyCommand } from '@/project/commands';
import { normalizeGenerationSeed, partSeed } from '@/project/generation';
import { projectMidiClipNoteOccurrences } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap, ppqDurationSeconds } from '@/project/tempo-map';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Flow A: the chord-progression editor. Writes the project's single chord
 * track, either by generating a fresh progression or by fitting chords to the
 * active clip's melody. After a successful write the dialog stays open on a
 * success screen offering to continue into track generation (Flow B).
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed. */
  close: [];
  /** Request to reveal the project key editor (progression's "change" link). */
  openKey: [];
  /** Continue into track generation after a successful chord write. */
  generateTracks: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const { system: noteNameSystem } = useNoteNames();

const g = computed(() => t.value.shell.generate.chord);

type Mode = 'progression' | 'harmonize';
const mode = ref<Mode>('progression');
const phase = ref<'edit' | 'done'>('edit');
const error = ref<string | null>(null);
/** Set by a mode switch so the swapped body settles in; the modal's own entrance covers the open. */
const modeSwitched = ref(false);

const MODES: ReadonlyArray<{ id: Mode; labelKey: 'modeProgression' | 'modeHarmonize' }> = [
  { id: 'progression', labelKey: 'modeProgression' },
  { id: 'harmonize', labelKey: 'modeHarmonize' },
];

// Reset to the editing phase whenever the dialog is (re)opened.
watch(
  () => props.open,
  (open) => {
    if (open) {
      phase.value = 'edit';
      error.value = null;
      modeSwitched.value = false;
    }
  },
);

/** Read-only display of the project's current key/scale, e.g. "C Dorian". */
const keyReadout = computed(() =>
  keyLabel(
    store.scaleHighlight.rootPc,
    matchModeChoiceId(store.scaleHighlight.modeMask),
    t.value.shell.lists.key,
    noteNameSystem.value,
  ),
);

/** Whether the active clip carries a melody the harmonizer can read. */
const hasMelody = computed(() => {
  const clip = store.activeClip;
  return clip !== null && projectMidiClipNoteOccurrences(clip).length > 0;
});

/** Append/replace is only meaningful when a chord track already exists. */
const hasChords = computed(() => store.chords.length > 0);

// Progression options.
const progStyle = ref<ProgStyle>('idol');
const progBars = ref(4);
const progReharmonize = ref(false);
const progMode = ref<'replace' | 'append'>('replace');

/** Empty string selects the "auto" sentinel: today's seed-driven random pick. */
const progPreset = ref('');

/** Beats per bar the progression generator assumes (4/4), independent of the project's own time signature. */
const PROGRESSION_BEATS_PER_BAR = 4;

/** The selected preset's natural pattern length in bars (one bar per degree), or null for the auto sentinel. */
const progPatternBars = computed(() => {
  if (progPreset.value === '') return null;
  const preset = progressionsByStyle(progStyle.value).find((p) => p.id === progPreset.value);
  return preset ? preset.degrees.length : null;
});

/** Quick-set multipliers for repeating the selected preset's pattern length. */
const REPEAT_MULTIPLIERS = [1, 2, 4, 8] as const;

/** Sets the bar count to a multiple of the selected preset's pattern length, capped at the field's max. */
function setRepeatCount(multiplier: number): void {
  const pattern = progPatternBars.value;
  if (pattern === null) return;
  progBars.value = Math.min(64, pattern * multiplier);
}

/**
 * Approximate real-time length of the entered bar count at the project's tempo. This is the progression's
 * own length, not the song's — a real arrangement typically repeats it, hence the "repeat" chips above.
 */
const progDurationLabel = computed(() => {
  const bars = Math.round(progBars.value);
  if (!Number.isFinite(bars) || bars <= 0) return '';
  const startPpq =
    progMode.value === 'append'
      ? store.chords.reduce((max, chord) => Math.max(max, chord.endPpq), 0)
      : 0;
  const totalSeconds = ppqDurationSeconds(
    normalizeTempoMap(store.tempoSegments, store.tempoBpm),
    startPpq,
    bars * PROGRESSION_BEATS_PER_BAR,
  );
  const duration =
    totalSeconds >= 60
      ? `${Math.floor(totalSeconds / 60)}:${String(Math.round(totalSeconds % 60)).padStart(2, '0')}`
      : formatMessage(g.value.durationSecondsUnit, { value: totalSeconds.toFixed(1) });
  return formatMessage(g.value.durationApprox, { duration, bpm: Math.round(store.tempoBpm) });
});

/** True when the entered bar count isn't a multiple of the selected preset's pattern length, so the
 * pattern cuts off mid-cycle on its last repeat (not an error — a deliberately short intro/outro is
 * a legitimate reason to do this — just surfaced rather than left silent). */
const progPatternTruncated = computed(() => {
  const pattern = progPatternBars.value;
  if (pattern === null) return false;
  const bars = Math.round(progBars.value);
  if (!Number.isFinite(bars) || bars <= 0) return false;
  return bars % pattern !== 0;
});

// Harmonize options.
type HarmonizeStrength = 'diatonic' | 'secondaryDominant' | 'borrowed';
const STRENGTHS: ReadonlyArray<{
  id: HarmonizeStrength;
  labelKey: 'harmonizeDiatonic' | 'harmonizeSecondary' | 'harmonizeBorrowed';
}> = [
  { id: 'diatonic', labelKey: 'harmonizeDiatonic' },
  { id: 'secondaryDominant', labelKey: 'harmonizeSecondary' },
  { id: 'borrowed', labelKey: 'harmonizeBorrowed' },
];
const harmStrength = ref<HarmonizeStrength>('diatonic');
const harmTranspose = ref(false);

/** True when the harmonize form has no melody to work from. */
const harmonizeBlocked = computed(() => mode.value === 'harmonize' && !hasMelody.value);

function onCancel(): void {
  emit('close');
}

/** Rounds a bar-count input, or returns null (and sets the error) when invalid. */
function validBars(value: number): number | null {
  const barCount = Math.round(value);
  if (!Number.isFinite(barCount) || barCount <= 0) {
    error.value = g.value.invalidBars;
    return null;
  }
  return barCount;
}

/** The project seed, bound to the store so it is saved with the project. */
const projectSeed = computed({
  get: () => store.generationSeed,
  set: (value: number) => {
    store.generationSeed = normalizeGenerationSeed(value);
  },
});

/** How many times each generator has been rerolled under the project seed. */
const rerolls = reactive({ progression: 0, harmonize: 0 });

/** Rerolls one generator, leaving the other on the seed it already had. */
function reroll(which: 'progression' | 'harmonize'): void {
  rerolls[which] += 1;
}

function runGenerator(): number | null {
  if (mode.value === 'progression') {
    const barCount = validBars(progBars.value);
    if (barCount === null) return null;
    return generateProgressionCommand({
      style: progStyle.value,
      bars: barCount,
      presetId: progPreset.value || undefined,
      seed: partSeed(store.generationSeed, 'progression', rerolls.progression),
      reharmonize: progReharmonize.value,
      mode: hasChords.value ? progMode.value : 'replace',
    });
  }
  return harmonizeFromMelodyCommand({
    reharmonize: harmStrength.value,
    transpose: harmTranspose.value,
    seed: partSeed(store.generationSeed, 'harmonize', rerolls.harmonize),
  });
}

function onGenerate(): void {
  if (harmonizeBlocked.value) return;
  error.value = null;
  try {
    const written = runGenerator();
    if (written === null) return;
    if (written > 0) phase.value = 'done';
    else error.value = g.value.noChanges;
  } catch {
    error.value = g.value.generationFailed;
  }
}

function onSelectMode(next: Mode): void {
  if (next !== mode.value) modeSwitched.value = true;
  mode.value = next;
  error.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing && phase.value === 'edit') {
    event.preventDefault();
    onGenerate();
  }
}
</script>

<template>
  <AppModal
    :open="props.open"
    size="md"
    :aria-label="g.title"
    @close="onCancel"
    @keydown="onKeydown"
  >
    <template #title>{{ g.title }}</template>

    <div v-if="phase === 'done'" class="chord-done">
      <svg class="done-badge animate-pop" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" />
        <path d="M6 10.4l2.6 2.6L14 7.6" />
      </svg>
      <p class="done-title">{{ g.doneTitle }}</p>
    </div>

    <div v-else class="chord-fields">
      <div class="segmented mode-select" role="radiogroup" v-radiogroup :aria-label="g.title">
        <button
          v-for="option in MODES"
          :key="option.id"
          type="button"
          class="segment"
          :class="{ active: mode === option.id }"
          role="radio"
          :aria-checked="mode === option.id"
          @click="onSelectMode(option.id)"
        >
          {{ g[option.labelKey] }}
        </button>
      </div>

      <div class="seed-row">
        <label class="number-field">
          <span class="field-label">{{ g.projectSeed }}</span>
          <input v-model.number="projectSeed" type="number" min="0" step="1" />
        </label>
        <span class="seed-caption">{{ g.projectSeedCaption }}</span>
      </div>

      <div :key="mode" class="mode-body" :class="{ 'view-enter': modeSwitched }">
        <template v-if="mode === 'progression'">
          <p class="key-context">
            {{ g.keyContext }}: <strong>{{ keyReadout }}</strong>
            <button type="button" class="key-change" @click="emit('openKey')">
              {{ g.keyChange }}
            </button>
          </p>

          <ProgressionPresetPicker
            v-model:style="progStyle"
            v-model:preset-id="progPreset"
            :key-scale="effectiveKeyScale(store.scaleHighlight)"
          />

          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.bars }}</span>
              <input
                v-model.number="progBars"
                type="number"
                min="1"
                max="64"
                step="1"
                class="bars-input"
              />
            </label>
            <div class="reroll-field">
              <span class="field-label">{{ g.variation }}</span>
              <button type="button" class="reroll-button" @click="reroll('progression')">
                {{ g.reroll }}
              </button>
              <span class="reroll-count">{{
                formatMessage(g.variationIndex, { index: rerolls.progression + 1 })
              }}</span>
            </div>
          </div>

          <p v-if="progDurationLabel" class="bars-detail">
            <span>{{ progDurationLabel }}</span>
            <span v-if="progPatternBars !== null" class="pattern-note">
              · {{ formatMessage(g.patternLength, { bars: progPatternBars }) }}
              <span class="repeat-chips">
                <button
                  v-for="n in REPEAT_MULTIPLIERS"
                  :key="n"
                  type="button"
                  class="repeat-chip"
                  :aria-label="formatMessage(g.repeatSet, { multiplier: n })"
                  @click="setRepeatCount(n)"
                >
                  ×{{ n }}
                </button>
              </span>
            </span>
          </p>
          <p v-if="progPatternTruncated" class="pattern-truncated">{{ g.patternTruncated }}</p>

          <label class="check-label">
            <input v-model="progReharmonize" type="checkbox" class="reharmonize-input" />
            {{ g.reharmonize }}
          </label>

          <template v-if="hasChords">
            <span class="field-label">{{ g.mode }}</span>
            <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.mode">
              <button
                type="button"
                class="segment"
                :class="{ active: progMode === 'replace' }"
                role="radio"
                :aria-checked="progMode === 'replace'"
                @click="progMode = 'replace'"
              >
                {{ g.modeReplace }}
              </button>
              <button
                type="button"
                class="segment"
                :class="{ active: progMode === 'append' }"
                role="radio"
                :aria-checked="progMode === 'append'"
                @click="progMode = 'append'"
              >
                {{ g.modeAppend }}
              </button>
            </div>
            <p v-if="progMode === 'replace'" class="replace-note">{{ g.replaceNote }}</p>
          </template>
        </template>

        <template v-else>
          <p v-if="harmonizeBlocked" class="mode-hint">{{ g.harmonizeEmpty }}</p>
          <template v-else>
            <span class="field-label">{{ g.harmonizeStrength }}</span>
            <div class="segmented" role="radiogroup" v-radiogroup :aria-label="g.harmonizeStrength">
              <button
                v-for="option in STRENGTHS"
                :key="option.id"
                type="button"
                class="segment"
                :class="{ active: harmStrength === option.id }"
                role="radio"
                :aria-checked="harmStrength === option.id"
                @click="harmStrength = option.id"
              >
                {{ g[option.labelKey] }}
              </button>
            </div>

            <label class="check-label">
              <input v-model="harmTranspose" type="checkbox" class="transpose-input" />
              {{ g.harmonizeTranspose }}
            </label>

            <div class="number-row">
              <div class="reroll-field">
                <span class="field-label">{{ g.variation }}</span>
                <button type="button" class="reroll-button" @click="reroll('harmonize')">
                  {{ g.reroll }}
                </button>
                <span class="reroll-count">{{
                  formatMessage(g.variationIndex, { index: rerolls.harmonize + 1 })
                }}</span>
              </div>
            </div>
          </template>
        </template>
      </div>

      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <template v-if="phase === 'done'">
        <button type="button" @click="onCancel">{{ g.close }}</button>
        <button type="button" class="primary continue-tracks" @click="emit('generateTracks')">
          {{ g.continueToTracks }}
        </button>
      </template>
      <template v-else>
        <button type="button" @click="onCancel">{{ g.cancel }}</button>
        <button
          type="button"
          class="primary generate-confirm"
          :disabled="harmonizeBlocked"
          @click="onGenerate"
        >
          {{ g.generate }}
        </button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.chord-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 20rem;
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* Fixed-height body so switching modes never resizes the modal; sized to the
 * taller form (progression, with its key readout and preset picker). */
.mode-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-height: 18rem;
}

.mode-hint {
  min-height: 18rem;
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.key-context {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.key-context strong {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
}

.key-change {
  margin-left: var(--sp-2);
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-sm);
  cursor: pointer;
}

.key-change:hover {
  text-decoration: underline;
}

.replace-note {
  margin: calc(-1 * var(--sp-3)) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.bars-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin: calc(-1 * var(--sp-3)) 0 0;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.pattern-truncated {
  margin: calc(-1 * var(--sp-3)) 0 0;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-2);
}

.pattern-note {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.repeat-chips {
  display: inline-flex;
  gap: 4px;
}

.repeat-chip {
  padding: 1px var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.repeat-chip:hover {
  background: var(--accent-soft);
  color: var(--text-1);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.repeat-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
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

/* A generator is rerolled rather than given a seed of its own: the button bumps
 * a counter beneath the project seed, so the other one keeps what it had. */
/* The one number every generated part is drawn from. */
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

.number-field input {
  width: 100%;
  box-sizing: border-box;
}

.check-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-md);
  color: var(--text-2);
}

.chord-done {
  animation: view-enter var(--dur-2) var(--ease-out);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--sp-3);
  min-width: 20rem;
  min-height: min(22rem, 52vh);
}

/* Completion mark: springs in once so the finished state reads as an event. */
.done-badge {
  flex: none;
  width: 1.5rem;
  height: 1.5rem;
  fill: color-mix(in srgb, var(--success) 14%, transparent);
  stroke: var(--success);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.done-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.dialog-error {
  animation: view-enter var(--dur-2) var(--ease-out);
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 0;
}
</style>
