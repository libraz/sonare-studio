<script setup lang="ts">
import type { ProgStyle } from '@libraz/libcantus';
import { computed, ref } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import {
  generateArrangementCommand,
  generateBackingCommand,
  generateBassLineCommand,
  generateCounterMelodyCommand,
  generateDrumsCommand,
  generateMotifCommand,
  generateProgressionCommand,
  harmonizeFromMelodyCommand,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/**
 * Unified music-generation dialog. A top segmented control picks one of the
 * generators (progression, harmonize, motif, drums, bass, counter melody);
 * the body shows only the selected generator's options and the Generate
 * button runs the matching command (one undoable edit), then dismisses. The
 * dialog never mutates the store directly beyond that command call.
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed (cancel, Escape, overlay, or after generating). */
  close: [];
}>();

const store = useProjectStore();
const { t } = useI18n();

const g = computed(() => t.value.shell.generate.dialog);

type GeneratorMode =
  | 'progression'
  | 'harmonize'
  | 'motif'
  | 'drums'
  | 'bass'
  | 'counter'
  | 'backing'
  | 'arrangement';

const MODES: ReadonlyArray<{
  id: GeneratorMode;
  labelKey:
    | 'generatorProgression'
    | 'generatorHarmonize'
    | 'generatorMotif'
    | 'generatorDrums'
    | 'generatorBass'
    | 'generatorCounter'
    | 'generatorBacking'
    | 'generatorArrangement';
}> = [
  { id: 'progression', labelKey: 'generatorProgression' },
  { id: 'harmonize', labelKey: 'generatorHarmonize' },
  { id: 'motif', labelKey: 'generatorMotif' },
  { id: 'drums', labelKey: 'generatorDrums' },
  { id: 'bass', labelKey: 'generatorBass' },
  { id: 'counter', labelKey: 'generatorCounter' },
  { id: 'backing', labelKey: 'generatorBacking' },
  { id: 'arrangement', labelKey: 'generatorArrangement' },
];

const generator = ref<GeneratorMode>('progression');
const error = ref<string | null>(null);

/** Whether the active clip carries a melody the generators can read. */
const hasMelody = computed(() => store.activeClip !== null && store.activeClip.notes.length > 0);

/** Append is only meaningful when a chord track already exists. */
const canAppend = computed(() => store.chords.length > 0);

/** Returns true when the generator's input material is missing. */
function isBlocked(mode: GeneratorMode): boolean {
  if (mode === 'harmonize' || mode === 'counter') return !hasMelody.value;
  if (mode === 'bass' || mode === 'backing') return !canAppend.value;
  return false;
}

/** Hint shown in place of an actionable form when the selection is blocked. */
const blockedHint = computed<string | null>(() => {
  if (!isBlocked(generator.value)) return null;
  return generator.value === 'bass' || generator.value === 'backing'
    ? g.value.hintNeedsChords
    : g.value.hintNeedsMelody;
});

// Progression options.
const STYLES: ReadonlyArray<{
  id: ProgStyle;
  labelKey: 'styleMinimal' | 'styleDance' | 'styleIdol' | 'styleRock';
}> = [
  { id: 'minimal', labelKey: 'styleMinimal' },
  { id: 'dance', labelKey: 'styleDance' },
  { id: 'idol', labelKey: 'styleIdol' },
  { id: 'rock', labelKey: 'styleRock' },
];
const progStyle = ref<ProgStyle>('idol');
const progBars = ref(4);
const progSeed = ref(0);
const progReharmonize = ref(false);
const progMode = ref<'replace' | 'append'>('replace');

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
const harmSeed = ref(0);

// Motif options.
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
const motifContour = ref<MotifContour>('arch');
const motifDevelop = ref(true);
const motifMode = ref<'append' | 'replace'>('append');
const motifSeed = ref(0);

// Drums options.
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
const drumDensity = ref(0.6);
const drumFills = ref(true);
const drumSeed = ref(0);

// Bass options.
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
const bassSeed = ref(0);

// Counter-melody options.
const counterRegister = ref<'above' | 'below'>('below');
const counterRhythm = ref<'complement' | 'follow'>('complement');
const counterSeed = ref(0);

// Backing (voicing) options.
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

// Arrangement options: which parts to lay down in one transaction.
const arrangeBars = ref(4);
const arrangeSeed = ref(0);
const arrangeProgression = ref(true);
const arrangeDrums = ref(true);
const arrangeBass = ref(true);
const arrangeBacking = ref(true);

function onCancel(): void {
  emit('close');
}

/** Rounds a bar-count input, or returns null (and sets the error) when invalid. */
function validBars(value: number): number | null {
  const barCount = Math.round(value);
  if (!Number.isFinite(barCount) || barCount <= 0) {
    error.value = 'Bars must be a positive number.';
    return null;
  }
  return barCount;
}

function seedOf(value: number): number {
  return Math.round(value) || 0;
}

function runSelectedGenerator(): boolean {
  switch (generator.value) {
    case 'progression': {
      const barCount = validBars(progBars.value);
      if (barCount === null) return false;
      generateProgressionCommand({
        style: progStyle.value,
        bars: barCount,
        seed: seedOf(progSeed.value),
        reharmonize: progReharmonize.value,
        mode: canAppend.value ? progMode.value : 'replace',
      });
      return true;
    }
    case 'harmonize':
      harmonizeFromMelodyCommand({
        reharmonize: harmStrength.value,
        transpose: harmTranspose.value,
        seed: seedOf(harmSeed.value),
      });
      return true;
    case 'motif': {
      const barCount = validBars(motifBars.value);
      if (barCount === null) return false;
      generateMotifCommand({
        bars: barCount,
        contour: motifContour.value,
        develop: motifDevelop.value,
        mode: motifMode.value,
        seed: seedOf(motifSeed.value),
      });
      return true;
    }
    case 'drums': {
      const barCount = validBars(drumBars.value);
      if (barCount === null) return false;
      generateDrumsCommand({
        bars: barCount,
        style: drumStyle.value,
        section: drumSection.value,
        density: Math.min(1, Math.max(0, drumDensity.value)),
        fills: drumFills.value,
        seed: seedOf(drumSeed.value),
      });
      return true;
    }
    case 'bass':
      generateBassLineCommand({ style: bassStyle.value, seed: seedOf(bassSeed.value) });
      return true;
    case 'counter':
      generateCounterMelodyCommand({
        register: counterRegister.value,
        rhythm: counterRhythm.value,
        seed: seedOf(counterSeed.value),
      });
      return true;
    case 'backing':
      generateBackingCommand({ style: backingStyle.value });
      return true;
    case 'arrangement': {
      const barCount = validBars(arrangeBars.value);
      if (barCount === null) return false;
      generateArrangementCommand({
        bars: barCount,
        seed: seedOf(arrangeSeed.value),
        progression: arrangeProgression.value,
        drums: arrangeDrums.value,
        bass: arrangeBass.value,
        backing: arrangeBacking.value,
      });
      return true;
    }
  }
}

function onGenerate(): void {
  if (blockedHint.value !== null) return;
  error.value = null;
  try {
    if (runSelectedGenerator()) emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onSelectMode(mode: GeneratorMode): void {
  generator.value = mode;
  error.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    onGenerate();
  }
}
</script>

<template>
  <AppModal
    :open="props.open"
    size="md"
    :aria-label="g.generatorTitle"
    @close="onCancel"
    @keydown="onKeydown"
  >
    <template #title>{{ g.generatorTitle }}</template>

    <div class="generate-fields">
      <span class="field-label">{{ g.generator }}</span>
      <div class="segmented mode-select" role="radiogroup" :aria-label="g.generator">
        <button
          v-for="option in MODES"
          :key="option.id"
          type="button"
          class="segment mode-segment"
          :class="{ active: generator === option.id, blocked: isBlocked(option.id) }"
          role="radio"
          :aria-checked="generator === option.id"
          :aria-disabled="isBlocked(option.id)"
          @click="onSelectMode(option.id)"
        >
          {{ g[option.labelKey] }}
        </button>
      </div>

      <p v-if="blockedHint" class="mode-hint">{{ blockedHint }}</p>

      <div v-else class="mode-fields">
        <template v-if="generator === 'progression'">
          <span class="field-label">{{ g.style }}</span>
          <div class="segmented style-select" role="radiogroup" :aria-label="g.style">
            <button
              v-for="option in STYLES"
              :key="option.id"
              type="button"
              class="segment"
              :class="{ active: progStyle === option.id }"
              role="radio"
              :aria-checked="progStyle === option.id"
              @click="progStyle = option.id"
            >
              {{ g[option.labelKey] }}
            </button>
          </div>

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
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="progSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>

          <label class="check-label">
            <input v-model="progReharmonize" type="checkbox" class="reharmonize-input" />
            {{ g.reharmonize }}
          </label>

          <template v-if="canAppend">
            <span class="field-label">{{ g.mode }}</span>
            <div class="segmented" role="radiogroup" :aria-label="g.mode">
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
          </template>
        </template>

        <template v-else-if="generator === 'harmonize'">
          <span class="field-label">{{ g.harmonizeStrength }}</span>
          <div class="segmented" role="radiogroup" :aria-label="g.harmonizeStrength">
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
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="harmSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>
        </template>

        <template v-else-if="generator === 'motif'">
          <span class="field-label">{{ g.contour }}</span>
          <div class="segmented" role="radiogroup" :aria-label="g.contour">
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
              <input
                v-model.number="motifBars"
                type="number"
                min="1"
                max="64"
                step="1"
                class="bars-input"
              />
            </label>
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="motifSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>

          <label class="check-label">
            <input v-model="motifDevelop" type="checkbox" class="develop-input" />
            {{ g.develop }}
          </label>

          <span class="field-label">{{ g.motifMode }}</span>
          <div class="segmented" role="radiogroup" :aria-label="g.motifMode">
            <button
              type="button"
              class="segment"
              :class="{ active: motifMode === 'append' }"
              role="radio"
              :aria-checked="motifMode === 'append'"
              @click="motifMode = 'append'"
            >
              {{ g.modeAppend }}
            </button>
            <button
              type="button"
              class="segment"
              :class="{ active: motifMode === 'replace' }"
              role="radio"
              :aria-checked="motifMode === 'replace'"
              @click="motifMode = 'replace'"
            >
              {{ g.modeReplace }}
            </button>
          </div>
        </template>

        <template v-else-if="generator === 'drums'">
          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.grooveStyle }}</span>
              <select v-model="drumStyle" class="groove-select">
                <option v-for="option in GROOVES" :key="option.id" :value="option.id">
                  {{ g[option.labelKey] }}
                </option>
              </select>
            </label>
            <label class="number-field">
              <span class="field-label">{{ g.section }}</span>
              <select v-model="drumSection" class="section-select">
                <option v-for="option in SECTIONS" :key="option.id" :value="option.id">
                  {{ g[option.labelKey] }}
                </option>
              </select>
            </label>
          </div>

          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.bars }}</span>
              <input
                v-model.number="drumBars"
                type="number"
                min="1"
                max="64"
                step="1"
                class="bars-input"
              />
            </label>
            <label class="number-field">
              <span class="field-label">{{ g.density }}</span>
              <input
                v-model.number="drumDensity"
                type="number"
                min="0"
                max="1"
                step="0.1"
                class="density-input"
              />
            </label>
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="drumSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>

          <label class="check-label">
            <input v-model="drumFills" type="checkbox" class="fills-input" />
            {{ g.fills }}
          </label>
        </template>

        <template v-else-if="generator === 'bass'">
          <span class="field-label">{{ g.bassStyle }}</span>
          <div class="segmented" role="radiogroup" :aria-label="g.bassStyle">
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

          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="bassSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>
        </template>

        <template v-else-if="generator === 'counter'">
          <span class="field-label">{{ g.register }}</span>
          <div class="segmented" role="radiogroup" :aria-label="g.register">
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
          <div class="segmented" role="radiogroup" :aria-label="g.rhythm">
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

          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="counterSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>
        </template>

        <template v-else-if="generator === 'backing'">
          <label class="number-field">
            <span class="field-label">{{ g.backingStyle }}</span>
            <select v-model="backingStyle" class="backing-select">
              <option v-for="option in BACKING_STYLES" :key="option.id" :value="option.id">
                {{ g[option.labelKey] }}
              </option>
            </select>
          </label>
        </template>

        <template v-else>
          <div class="check-group">
            <label class="check-label">
              <input v-model="arrangeProgression" type="checkbox" />
              {{ g.arrangeProgression }}
            </label>
            <label class="check-label">
              <input v-model="arrangeDrums" type="checkbox" />
              {{ g.arrangeDrums }}
            </label>
            <label class="check-label">
              <input v-model="arrangeBass" type="checkbox" />
              {{ g.arrangeBass }}
            </label>
            <label class="check-label">
              <input v-model="arrangeBacking" type="checkbox" />
              {{ g.arrangeBacking }}
            </label>
          </div>

          <div class="number-row">
            <label class="number-field">
              <span class="field-label">{{ g.bars }}</span>
              <input
                v-model.number="arrangeBars"
                type="number"
                min="1"
                max="64"
                step="1"
                class="bars-input"
              />
            </label>
            <label class="number-field">
              <span class="field-label">{{ g.seed }}</span>
              <input v-model.number="arrangeSeed" type="number" step="1" class="seed-input" />
            </label>
          </div>
        </template>
      </div>

      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <button type="button" @click="onCancel">{{ g.cancel }}</button>
      <button
        type="button"
        class="primary generate-confirm"
        :disabled="blockedHint !== null"
        @click="onGenerate"
      >
        {{ g.generate }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.generate-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-width: 20rem;
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

/* iOS/macOS segmented control: an inset track holding equal-width segments; the
 * active segment reads as a raised pill lifted off the groove. */
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  box-shadow: var(--control-edge), var(--inset-well);
}

/* The generator picker wraps to a 4-column grid so the eight labels keep equal
 * widths across two tidy rows. */
.mode-select {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}

/* Arrangement part toggles stacked as a compact checklist. */
.check-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.segment {
  flex: 1 1 0;
  padding: var(--sp-2) var(--sp-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.segment:hover:not(.active) {
  color: var(--text-1);
  background: none;
}

.segment.active {
  background: var(--surface-2);
  color: var(--text-1);
  box-shadow: var(--control-edge), var(--shadow-1);
}

/* A generator whose input material is missing stays selectable (selecting it
 * reveals the hint) but reads as unavailable. */
.segment.blocked {
  opacity: 0.45;
}

.segment:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* Fixed-height body so switching generators never resizes the modal; sized to
 * the tallest form (drums). */
.mode-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-height: 15rem;
}

.mode-hint {
  min-height: 15rem;
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
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

.check-label {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-md);
  color: var(--text-2);
}

.dialog-error {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  margin: 0;
}
</style>
