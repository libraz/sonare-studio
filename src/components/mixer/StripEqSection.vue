<script setup lang="ts">
import { computed } from 'vue';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { setStripEq } from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripEq } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { formatDb, formatHz, hzToNorm, normToHz } from '@/ui/mixer/db-scale';
import { eqCurve, eqCurvePath } from '@/ui/mixer/eq-curve';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import type { EqBand } from '@/wasm/index.js';
import MixerKnob from './MixerKnob.vue';

/**
 * Channel EQ section: power toggle, a mini response graph and per-band
 * frequency/gain knobs. The strip EQ is a libsonare EqBand list; enabling the
 * section seeds a neutral three-band layout (low shelf / peak / high shelf).
 * Every edit goes through setStripEq, whose per-strip gesture key coalesces a
 * knob drag into one undo entry.
 */

const props = defineProps<{
  /** Strip the section edits: a track id or 'master'. */
  target: MixerStripTarget;
}>();

const store = useProjectStore();

/** Graph viewBox size in px. */
const GRAPH_W = 78;
const GRAPH_H = 30;

/** Gain range of the band knobs in dB. */
const BAND_GAIN_DB = 15;

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const eq = computed<StripEq | undefined>(() => strip.value.eq);

/** Frequency knob range per band type. */
function freqRange(band: EqBand): { min: number; max: number } {
  switch (band.type) {
    case 'LowShelf':
      return { min: 30, max: 500 };
    case 'HighShelf':
      return { min: 1000, max: 18000 };
    default:
      return { min: 20, max: 20000 };
  }
}

/** Short label per band type. */
function bandLabel(band: EqBand, index: number): string {
  switch (band.type) {
    case 'LowShelf':
      return 'LF';
    case 'HighShelf':
      return 'HF';
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

// --- Band knob gestures -------------------------------------------------------

/** Builds the next EQ state with one band field replaced. */
function withBandField(bandIndex: number, field: 'frequencyHz' | 'gainDb', value: number): StripEq {
  const current = eq.value ?? { enabled: true, bands: defaultEqBands() };
  const bands = current.bands.map((band, i) =>
    i === bandIndex ? { ...band, [field]: value } : band,
  );
  return { ...current, bands };
}

const gestures = new Map<string, ValueGesture>();

function applyBandField(
  bandIndex: number,
  field: 'frequencyHz' | 'gainDb',
  value: number,
  commit: boolean,
): void {
  const key = `${bandIndex}:${field}`;
  const apply = (v: number, options: CommandGestureOptions): void => {
    setStripEq(props.target, withBandField(bandIndex, field, v), options);
  };
  if (!commit) {
    let gesture = gestures.get(key);
    if (!gesture) {
      const band = eq.value?.bands[bandIndex];
      const initial = (band?.[field] as number | undefined) ?? (field === 'gainDb' ? 0 : 1000);
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

function onGainChange(bandIndex: number, value: number, commit: boolean): void {
  applyBandField(bandIndex, 'gainDb', value, commit);
}

/** Frequency knobs run on a normalized log scale (0..1 over the band range). */
function onFreqChange(bandIndex: number, norm: number, commit: boolean): void {
  const band = eq.value?.bands[bandIndex];
  if (!band) return;
  const range = freqRange(band);
  applyBandField(bandIndex, 'frequencyHz', normToHz(norm, range.min, range.max), commit);
}

function freqNorm(band: EqBand): number {
  const range = freqRange(band);
  return hzToNorm(band.frequencyHz ?? 1000, range.min, range.max);
}
</script>

<template>
  <div class="eq-section" :class="{ off: !eq?.enabled }">
    <div class="eq-head">
      <button
        type="button"
        class="eq-power"
        :class="{ on: eq?.enabled }"
        :title="eq?.enabled ? 'Bypass EQ' : 'Enable EQ'"
        @click="onTogglePower"
      />
      <span class="eq-title">EQ</span>
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
        <span class="eq-band-label">{{ bandLabel(band, index) }}</span>
        <MixerKnob
          :value="freqNorm(band)"
          :min="0"
          :max="1"
          :display="formatHz(band.frequencyHz ?? 1000)"
          :size="18"
          :disabled="!eq.enabled"
          @change="(value, commit) => onFreqChange(index, value, commit)"
        />
        <MixerKnob
          :value="band.gainDb ?? 0"
          :min="-BAND_GAIN_DB"
          :max="BAND_GAIN_DB"
          :default-value="0"
          :display="`${formatDb(band.gainDb ?? 0)} dB`"
          :size="18"
          :disabled="!eq.enabled"
          @change="(value, commit) => onGainChange(index, value, commit)"
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
  border: 1px solid #3a4150;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.eq-power.on {
  background: #4ade80;
  border-color: #4ade80;
}

.eq-title {
  font: 700 8px system-ui, sans-serif;
  letter-spacing: 0.06em;
  color: #5b6270;
}

.eq-graph {
  display: block;
  width: 100%;
  height: auto;
  background: #111418;
  border-radius: 2px;
}

.eq-zero {
  stroke: #23262e;
  stroke-width: 1;
}

.eq-curve {
  stroke: #60a5fa;
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
  font: 7px system-ui, sans-serif;
  color: #5b6270;
  user-select: none;
}
</style>
