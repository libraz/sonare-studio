<script setup lang="ts">
import { computed } from 'vue';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { setStripEq } from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripEq } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { formatDb, formatHz } from '@/ui/mixer/db-scale';
import { eqCurve, eqCurvePath } from '@/ui/mixer/eq-curve';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import type { EqBand, EqBandType } from '@/wasm/index.js';
import MixerKnob from './MixerKnob.vue';

/**
 * Channel EQ section: power toggle, a mini response graph and per-band knobs.
 * The strip EQ is a libsonare EqBand list; enabling the section seeds a neutral
 * three-band layout (low shelf / peak / high shelf). Each band's type can be
 * switched (low/high cut, shelf, bell, notch) and bands can be added or removed
 * — the engine sync mirrors the whole band list per strip, so the count is not
 * fixed. Every edit goes through setStripEq, whose per-strip gesture key
 * coalesces a knob drag into one undo entry.
 */

const props = defineProps<{
  /** Strip the section edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

const store = useProjectStore();
const { t } = useI18n();

/** Graph viewBox size in px. */
const GRAPH_W = 78;
const GRAPH_H = 30;

/** Gain range of the band knobs in dB. */
const BAND_GAIN_DB = 15;

/** Resonance (Q) knob range. */
const Q_MIN = 0.1;
const Q_MAX = 18;

/** Most bands a strip EQ exposes in this UI. */
const MAX_BANDS = 6;

/** Band types offered in the type menu, in low-to-high display order. */
const BAND_TYPE_CHOICES: ReadonlyArray<{
  type: EqBandType;
  labelKey: keyof typeof t.value.shell.mixer.eq.types;
}> = [
  { type: 'HighPass', labelKey: 'lowCut' },
  { type: 'LowShelf', labelKey: 'lowShelf' },
  { type: 'Peak', labelKey: 'bell' },
  { type: 'HighShelf', labelKey: 'highShelf' },
  { type: 'LowPass', labelKey: 'highCut' },
  { type: 'Notch', labelKey: 'notch' },
];

/** Band types whose gain knob has no audible effect (cut/notch filters). */
const CUT_TYPES: ReadonlySet<EqBandType> = new Set(['HighPass', 'LowPass', 'Notch', 'BandPass']);

/** True when the band's gain knob is meaningful (shelf/bell). */
function bandUsesGain(band: EqBand): boolean {
  return !CUT_TYPES.has(band.type ?? 'Peak');
}

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const eq = computed<StripEq | undefined>(() => strip.value.eq);

/** Frequency knob range per band type. */
function freqRange(band: EqBand): { min: number; max: number } {
  switch (band.type) {
    case 'HighPass':
      return { min: 20, max: 1000 };
    case 'LowShelf':
      return { min: 30, max: 500 };
    case 'HighShelf':
      return { min: 1000, max: 18000 };
    case 'LowPass':
      return { min: 1000, max: 20000 };
    default:
      return { min: 20, max: 20000 };
  }
}

/** Short label per band type. */
function bandLabel(band: EqBand, index: number): string {
  switch (band.type) {
    case 'HighPass':
      return 'LC';
    case 'LowShelf':
      return 'LF';
    case 'HighShelf':
      return 'HF';
    case 'LowPass':
      return 'HC';
    case 'Notch':
      return 'NF';
    case 'Peak':
      return 'MF';
    default:
      return `B${index + 1}`;
  }
}

/** Neutral three-band starting layout when the EQ is first enabled. */
function defaultEqBands(): EqBand[] {
  return [
    { type: 'LowShelf', frequencyHz: 120, gainDb: 0, q: Math.SQRT1_2, enabled: true },
    { type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 0.9, enabled: true },
    { type: 'HighShelf', frequencyHz: 8000, gainDb: 0, q: Math.SQRT1_2, enabled: true },
  ];
}

/** Reset frequency for a band type (matches the neutral starting layout). */
function defaultFreq(band: EqBand): number {
  switch (band.type) {
    case 'HighPass':
      return 80;
    case 'LowShelf':
      return 120;
    case 'HighShelf':
      return 8000;
    case 'LowPass':
      return 12000;
    default:
      return 1000;
  }
}

/** Reset Q for a band type. */
function defaultQ(band: EqBand): number {
  return band.type === 'Peak' ? 0.9 : Math.SQRT1_2;
}

/** Clamps a value into a closed range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const curvePath = computed(() => {
  const bands = eq.value?.bands ?? [];
  if (bands.length === 0) {
    return `M0 ${GRAPH_H / 2} L${GRAPH_W} ${GRAPH_H / 2}`;
  }
  return eqCurvePath(eqCurve(bands, 48), GRAPH_W, GRAPH_H, BAND_GAIN_DB);
});

function onTogglePower(): void {
  const current = eq.value;
  if (!current) {
    setStripEq(props.target, { enabled: true, bands: defaultEqBands() });
  } else {
    setStripEq(props.target, { ...current, enabled: !current.enabled });
  }
}

// --- Band type / add / remove -------------------------------------------------

/** Current bands, seeding the neutral layout when the EQ is not yet present. */
function currentBands(): EqBand[] {
  return eq.value?.bands ?? defaultEqBands();
}

/** Commits a new band list as one undoable edit, keeping the EQ enabled. */
function commitBands(bands: EqBand[]): void {
  setStripEq(props.target, { enabled: eq.value?.enabled ?? true, bands });
}

/**
 * Switches a band to another filter type, clamping its frequency into the new
 * type's range so the knob and response stay in bounds.
 */
function setBandType(index: number, type: EqBandType): void {
  const bands = currentBands();
  const band = bands[index];
  if (!band || band.type === type) return;
  const range = freqRange({ ...band, type });
  const next: EqBand = {
    ...band,
    type,
    frequencyHz: clamp(band.frequencyHz ?? 1000, range.min, range.max),
  };
  commitBands(bands.map((b, i) => (i === index ? next : b)));
}

/** Appends a neutral bell band when under the band cap. */
function addBand(): void {
  const bands = currentBands();
  if (bands.length >= MAX_BANDS) return;
  const band: EqBand = { type: 'Peak', frequencyHz: 3000, gainDb: 0, q: 0.9, enabled: true };
  commitBands([...bands, band]);
}

/** Removes a band, keeping at least one. */
function removeBand(index: number): void {
  const bands = currentBands();
  if (bands.length <= 1) return;
  gestures.clear();
  commitBands(bands.filter((_, i) => i !== index));
}

/** Opens the per-band action menu: change type or remove the band. */
function openBandMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  const band = currentBands()[index];
  if (!band) return;
  const items: ContextMenuItem[] = BAND_TYPE_CHOICES.map((choice) => ({
    id: `type:${choice.type}`,
    label: t.value.shell.mixer.eq.types[choice.labelKey],
    checked: (band.type ?? 'Peak') === choice.type,
    run: () => setBandType(index, choice.type),
  }));
  if (currentBands().length > 1) {
    items.push({ id: 'sep', separator: true });
    items.push({
      id: 'remove',
      label: t.value.shell.mixer.eq.removeBand,
      danger: true,
      run: () => removeBand(index),
    });
  }
  openContextMenu(event.clientX, event.clientY, items);
}

// --- Band knob gestures -------------------------------------------------------

/** EQ band fields the knobs edit. */
type BandField = 'frequencyHz' | 'gainDb' | 'q';

/** Neutral fallback per field when a band has no stored value yet. */
const FIELD_FALLBACK: Record<BandField, number> = { frequencyHz: 1000, gainDb: 0, q: 0.7 };

/** Builds the next EQ state with one band field replaced. */
function withBandField(bandIndex: number, field: BandField, value: number): StripEq {
  const current = eq.value ?? { enabled: true, bands: defaultEqBands() };
  const bands = current.bands.map((band, i) =>
    i === bandIndex ? { ...band, [field]: value } : band,
  );
  return { ...current, bands };
}

const gestures = new Map<string, ValueGesture>();

function applyBandField(bandIndex: number, field: BandField, value: number, commit: boolean): void {
  const key = `${bandIndex}:${field}`;
  const apply = (v: number, options: CommandGestureOptions): void => {
    setStripEq(props.target, withBandField(bandIndex, field, v), options);
  };
  if (!commit) {
    let gesture = gestures.get(key);
    if (!gesture) {
      const band = eq.value?.bands[bandIndex];
      const initial = (band?.[field] as number | undefined) ?? FIELD_FALLBACK[field];
      gesture = createValueGesture(apply, initial);
      gestures.set(key, gesture);
    }
    gesture.update(value);
  } else {
    const gesture = gestures.get(key);
    if (gesture) gesture.end(value);
    else apply(value, { commit: true });
    gestures.delete(key);
  }
}

function onFreqChange(bandIndex: number, hz: number, commit: boolean): void {
  applyBandField(bandIndex, 'frequencyHz', hz, commit);
}

function onGainChange(bandIndex: number, value: number, commit: boolean): void {
  applyBandField(bandIndex, 'gainDb', value, commit);
}

function onQChange(bandIndex: number, value: number, commit: boolean): void {
  applyBandField(bandIndex, 'q', value, commit);
}
</script>

<template>
  <div class="eq-section" :class="{ off: !eq?.enabled }">
    <div class="eq-head">
      <button
        type="button"
        class="eq-power"
        :class="{ on: eq?.enabled }"
        :title="eq?.enabled ? t.shell.mixer.eq.bypass : t.shell.mixer.eq.enable"
        :aria-label="t.shell.mixer.eq.power"
        :aria-pressed="eq?.enabled === true"
        @click="onTogglePower"
      />
      <span class="eq-title">EQ</span>
      <span class="eq-head-spacer" />
      <button
        v-if="eq && eq.bands.length < MAX_BANDS"
        type="button"
        class="eq-add"
        :title="t.shell.mixer.eq.addTitle"
        :aria-label="t.shell.mixer.eq.add"
        @click="addBand"
      >
        +
      </button>
    </div>
    <svg
      class="eq-graph"
      :viewBox="`0 0 ${GRAPH_W} ${GRAPH_H}`"
      :width="GRAPH_W"
      :height="GRAPH_H"
      aria-hidden="true"
    >
      <line x1="0" :y1="GRAPH_H / 2" :x2="GRAPH_W" :y2="GRAPH_H / 2" class="eq-zero" />
      <path :d="curvePath" class="eq-curve" fill="none" />
    </svg>
    <div v-if="eq" class="eq-bands">
      <div v-for="(band, index) in eq.bands" :key="index" class="eq-band">
        <button
          type="button"
          class="eq-band-label"
          :title="
            formatMessage(t.shell.mixer.eq.bandTypeTitle, { label: bandLabel(band, index) })
          "
          @click="openBandMenu(index, $event)"
          @contextmenu="openBandMenu(index, $event)"
        >
          {{ bandLabel(band, index) }}
        </button>
        <MixerKnob
          :value="band.frequencyHz ?? 1000"
          :min="freqRange(band).min"
          :max="freqRange(band).max"
          scale="log"
          :aria-label="formatMessage(t.shell.mixer.eq.frequency, { label: bandLabel(band, index) })"
          :default-value="defaultFreq(band)"
          :display="`${formatHz(band.frequencyHz ?? 1000)} Hz`"
          :size="18"
          :disabled="!eq.enabled"
          @change="(value, commit) => onFreqChange(index, value, commit)"
        />
        <MixerKnob
          v-if="bandUsesGain(band)"
          :value="band.gainDb ?? 0"
          :min="-BAND_GAIN_DB"
          :max="BAND_GAIN_DB"
          :aria-label="formatMessage(t.shell.mixer.eq.gain, { label: bandLabel(band, index) })"
          :default-value="0"
          :display="`${formatDb(band.gainDb ?? 0)} dB`"
          :size="18"
          :disabled="!eq.enabled"
          @change="(value, commit) => onGainChange(index, value, commit)"
        />
        <MixerKnob
          :value="band.q ?? 0.7"
          :min="Q_MIN"
          :max="Q_MAX"
          scale="log"
          :aria-label="formatMessage(t.shell.mixer.eq.q, { label: bandLabel(band, index) })"
          :default-value="defaultQ(band)"
          :display="`Q ${(band.q ?? 0.7).toFixed(2)}`"
          :size="18"
          :disabled="!eq.enabled"
          @change="(value, commit) => onQChange(index, value, commit)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.eq-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.eq-section.off .eq-graph,
.eq-section.off .eq-band-label {
  opacity: 0.4;
}

.eq-head {
  display: flex;
  align-items: center;
  gap: 4px;
}

.eq-power {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  border: none;
  background: var(--surface-3);
  box-shadow: var(--control-edge);
  padding: 0;
  cursor: pointer;
}

.eq-power.on {
  background: var(--success);
}

.eq-title {
  font: var(--fw-bold) 8px var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
}

.eq-head-spacer {
  flex: 1;
}

.eq-add {
  flex: none;
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-3);
  font: var(--fw-bold) 10px var(--font-sans);
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.eq-add:hover {
  color: var(--text-1);
  box-shadow: var(--control-lift-hover);
}

.eq-graph {
  display: block;
  width: 100%;
  height: auto;
  background: var(--surface-inset);
  border-radius: 2px;
}

.eq-zero {
  stroke: #23262e;
  stroke-width: 1;
}

.eq-curve {
  stroke: var(--accent);
  stroke-width: 1.2;
}

.eq-bands {
  display: flex;
  justify-content: space-between;
  gap: 2px;
}

.eq-band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.eq-band-label {
  font: var(--fw-semibold) 7px var(--font-sans);
  color: var(--text-4);
  user-select: none;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.eq-band-label:hover {
  color: var(--accent);
  background: var(--accent-muted);
}
</style>
