<script setup lang="ts">
import type { EqBandInput, EqBandPhase, EqBandType, EqStereoPlacement } from '@libraz/libsonare';
import { computed, inject, onBeforeUnmount, shallowRef, watch } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { ScopeFrame, ScopeSource } from '@/engine/scope';
import { isMixerBusStripTarget, mixerBusIdFromTarget } from '@/project/command/mixer-internal';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { setStripEq } from '@/project/commands';
import { createDefaultStrip, type MixerStrip, type StripEq } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { type MidiLearnEqParam, midiLearnEqTargetId } from '@/ui/midi/midi-learn';
import { formatDb, formatHz } from '@/ui/mixer/db-scale';
import { clampToRange } from '@/ui/mixer/drag';
import { eqCurve, eqCurvePath } from '@/ui/mixer/eq-curve';
import { matchFlatEqBands } from '@/ui/mixer/match-eq';
import {
  frequencyToFraction,
  SPECTRUM_MAX_FREQ,
  SPECTRUM_MIN_DB,
  SPECTRUM_MIN_FREQ,
  spectrumDbToFraction,
} from '@/ui/mixer/spectrum-model';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';
import MixerKnob from './MixerKnob.vue';

/**
 * Channel EQ section: power toggle, a mini response graph and per-band knobs.
 * The strip EQ is a libsonare EqBandInput list; enabling the section seeds a neutral
 * three-band layout (low shelf / peak / high shelf). Each band's type can be
 * switched (low/high cut, shelf, bell, notch) and bands can be added or removed
 * — the engine sync mirrors the whole band list per track, group or return bus,
 * so the count is not fixed. Every edit goes through setStripEq, whose
 * per-strip gesture key coalesces a knob drag into one undo entry.
 */

const props = withDefaults(
  defineProps<{
    /** Strip the section edits: a track id or 'master'. */
    target: MixerStripTarget;
    /** Per-strip engine spectrum source used as the EQ graph background. */
    scope?: ScopeSource | null;
    /** Whether the mixer dock is visible and the spectrum backdrop should update. */
    visible?: boolean;
  }>(),
  { scope: null, visible: true },
);

const store = useProjectStore();
const { t } = useI18n();
const midiLearn = inject(MIDI_LEARN_KEY, null);

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
  { type: 'highPass', labelKey: 'lowCut' },
  { type: 'lowShelf', labelKey: 'lowShelf' },
  { type: 'peak', labelKey: 'bell' },
  { type: 'highShelf', labelKey: 'highShelf' },
  { type: 'lowPass', labelKey: 'highCut' },
  { type: 'notch', labelKey: 'notch' },
];

/** Stereo placements exposed by the compact strip EQ menu. */
const PLACEMENT_CHOICES: ReadonlyArray<{
  placement: EqStereoPlacement;
  labelKey: keyof typeof t.value.shell.mixer.eq.placement;
}> = [
  { placement: 'stereo', labelKey: 'stereo' },
  { placement: 'mid', labelKey: 'mid' },
  { placement: 'side', labelKey: 'side' },
];

/** Per-band phase modes supported by the engine EQ. */
const PHASE_CHOICES: ReadonlyArray<{
  phase: EqBandPhase;
  labelKey: keyof typeof t.value.shell.mixer.eq.phase;
}> = [
  { phase: 'inherit', labelKey: 'inherit' },
  { phase: 'zeroLatency', labelKey: 'zeroLatency' },
  { phase: 'naturalPhase', labelKey: 'natural' },
  { phase: 'linearPhase', labelKey: 'linear' },
];

/** Band types whose gain knob has no audible effect (cut/notch filters). */
const CUT_TYPES: ReadonlySet<EqBandType> = new Set(['highPass', 'lowPass', 'notch', 'bandPass']);

/** True when the band's gain knob is meaningful (shelf/bell). */
function bandUsesGain(band: EqBandInput): boolean {
  return !CUT_TYPES.has(band.type ?? 'peak');
}

const strip = computed<MixerStrip>(() => {
  if (props.target === 'master') return store.mixer.master;
  if (isMixerBusStripTarget(props.target)) {
    const busId = mixerBusIdFromTarget(props.target);
    return store.mixer.buses.find((bus) => bus.id === busId)?.strip ?? createDefaultStrip();
  }
  const track = store.tracks.find((t) => t.id === props.target);
  return track?.mixer ?? createDefaultStrip();
});

const eq = computed<StripEq | undefined>(() => strip.value.eq);

/** Frequency knob range per band type. */
function freqRange(band: EqBandInput): { min: number; max: number } {
  switch (band.type) {
    case 'highPass':
      return { min: 20, max: 1000 };
    case 'lowShelf':
      return { min: 30, max: 500 };
    case 'highShelf':
      return { min: 1000, max: 18000 };
    case 'lowPass':
      return { min: 1000, max: 20000 };
    default:
      return { min: 20, max: 20000 };
  }
}

/** Short label per band type. */
function bandLabel(band: EqBandInput, index: number): string {
  switch (band.type) {
    case 'highPass':
      return 'LC';
    case 'lowShelf':
      return 'LF';
    case 'highShelf':
      return 'HF';
    case 'lowPass':
      return 'HC';
    case 'notch':
      return 'NF';
    case 'peak':
      return 'MF';
    default:
      return `B${index + 1}`;
  }
}

/** Reset frequency and Q per band type; unlisted types use {@link BAND_FALLBACK}. */
const BAND_DEFAULTS: Partial<Record<EqBandType, { frequencyHz: number; q: number }>> = {
  highPass: { frequencyHz: 80, q: Math.SQRT1_2 },
  lowShelf: { frequencyHz: 120, q: Math.SQRT1_2 },
  peak: { frequencyHz: 1000, q: 0.9 },
  highShelf: { frequencyHz: 8000, q: Math.SQRT1_2 },
  lowPass: { frequencyHz: 12000, q: Math.SQRT1_2 },
};
const BAND_FALLBACK = { frequencyHz: 1000, q: Math.SQRT1_2 };

/** Centre frequency of a band appended with the add button. */
const ADDED_BAND_FREQ = 3000;

function bandDefaults(type: EqBandType | undefined): { frequencyHz: number; q: number } {
  return (type && BAND_DEFAULTS[type]) || BAND_FALLBACK;
}

/** Neutral three-band starting layout when the EQ is first enabled. */
function defaultEqBands(): EqBandInput[] {
  return (['lowShelf', 'peak', 'highShelf'] as const).map((type) => ({
    type,
    ...bandDefaults(type),
    gainDb: 0,
    enabled: true,
  }));
}

/** Reset frequency for a band type (matches the neutral starting layout). */
function defaultFreq(band: EqBandInput): number {
  return bandDefaults(band.type).frequencyHz;
}

/** Reset Q for a band type. */
function defaultQ(band: EqBandInput): number {
  return bandDefaults(band.type).q;
}

const curvePath = computed(() => {
  const bands = eq.value?.bands ?? [];
  if (bands.length === 0) {
    return `M0 ${GRAPH_H / 2} L${GRAPH_W} ${GRAPH_H / 2}`;
  }
  return eqCurvePath(eqCurve(bands, 48), GRAPH_W, GRAPH_H, BAND_GAIN_DB);
});

const scopeFrame = shallowRef<ScopeFrame | null>(null);
let unsubscribeScope: (() => void) | null = null;

/** Follows the scope only while the dock is visible; hidden strips hold no subscription. */
function bindScope(source: ScopeSource | null | undefined, visible: boolean): void {
  unsubscribeScope?.();
  unsubscribeScope = null;
  scopeFrame.value = visible && source?.available ? (source.latest ?? null) : null;
  if (!visible || !source?.available) return;
  unsubscribeScope = source.subscribe((frame) => {
    scopeFrame.value = frame;
  });
}

watch(
  () => [props.scope, props.visible] as const,
  ([source, visible]) => bindScope(source, visible),
  { immediate: true },
);

onBeforeUnmount(() => {
  unsubscribeScope?.();
  unsubscribeScope = null;
  for (const gesture of gestures.values()) gesture.end();
  gestures.clear();
});

function scopeSpectrumPath(frame: ScopeFrame | null, sampleRate: number | undefined): string {
  const bands = frame?.bands;
  if (!bands || bands.length === 0 || !sampleRate) return '';
  const nyquist = sampleRate / 2;
  const points: string[] = [];
  for (let i = 0; i < bands.length; i += 1) {
    const freq = ((i + 0.5) / bands.length) * nyquist;
    if (freq < SPECTRUM_MIN_FREQ) continue;
    if (freq > SPECTRUM_MAX_FREQ) break;
    const x = frequencyToFraction(freq) * GRAPH_W;
    const y = (1 - spectrumDbToFraction(bands[i], SPECTRUM_MIN_DB, -12)) * GRAPH_H;
    points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  if (points.length === 0) return '';
  return `M0 ${GRAPH_H} L${points.join(' L')} L${GRAPH_W} ${GRAPH_H} Z`;
}

const spectrumPath = computed(() =>
  scopeSpectrumPath(scopeFrame.value, props.scope?.available ? props.scope.sampleRate : undefined),
);

/** Bands are edited only while the EQ runs; a bypassed EQ would hide every change. */
const bandsBlocked = computed(() =>
  firstBlock([eq.value?.enabled !== true, t.value.shell.mixer.reasons.eqOff]),
);
const addBandBlocked = computed(() =>
  firstBlock(bandsBlocked.value, [
    (eq.value?.bands.length ?? 0) >= MAX_BANDS,
    formatMessage(t.value.shell.mixer.reasons.bandLimit, { max: String(MAX_BANDS) }),
  ]),
);
const matchFlatBlocked = computed(() =>
  firstBlock(
    [props.scope?.available !== true, t.value.shell.mixer.meter.noLive],
    [!canMatchFlat.value, t.value.shell.mixer.reasons.noSpectrum],
  ),
);

const canMatchFlat = computed(() => {
  return (
    props.scope?.available === true &&
    scopeFrame.value !== null &&
    scopeFrame.value.bands.length > 0 &&
    Number.isFinite(props.scope.sampleRate)
  );
});

function onTogglePower(): void {
  const current = eq.value;
  if (!current) {
    setStripEq(props.target, { enabled: true, bands: defaultEqBands() });
  } else {
    setStripEq(props.target, { ...current, enabled: !current.enabled });
  }
}

function onMatchFlat(): void {
  void applyMatchFlat();
}

async function applyMatchFlat(): Promise<void> {
  if (!canMatchFlat.value || !scopeFrame.value || !props.scope) return;
  if (
    (eq.value?.bands.length ?? 0) > 0 &&
    !(await confirmDialog({
      title: t.value.shell.mixer.eq.matchFlatConfirmTitle,
      message: t.value.shell.mixer.eq.matchFlatConfirmMessage,
      danger: true,
      confirmLabel: t.value.shell.mixer.eq.matchFlat,
    }))
  )
    return;
  const bands = matchFlatEqBands(scopeFrame.value.bands, {
    sampleRate: props.scope.sampleRate,
    maxBands: MAX_BANDS,
    existingBands: eq.value?.bands,
  });
  if (bands.length === 0) return;
  setStripEq(props.target, { enabled: true, bands });
}

// --- Band type / add / remove -------------------------------------------------

/** Current bands, seeding the neutral layout when the EQ is not yet present. */
function currentBands(): EqBandInput[] {
  return eq.value?.bands ?? defaultEqBands();
}

/** Commits a new band list as one undoable edit, keeping the EQ enabled. */
function commitBands(bands: EqBandInput[]): void {
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
  const next: EqBandInput = {
    ...band,
    type,
    frequencyHz: clampToRange(band.frequencyHz ?? 1000, range),
  };
  commitBands(bands.map((b, i) => (i === index ? next : b)));
}

/** Sets whether a band processes stereo, mid or side content. */
function setBandPlacement(index: number, placement: EqStereoPlacement): void {
  const bands = currentBands();
  const band = bands[index];
  if (!band || (band.placement ?? 'stereo') === placement) return;
  const next: EqBandInput = { ...band };
  if (placement === 'stereo') delete next.placement;
  else next.placement = placement;
  commitBands(bands.map((b, i) => (i === index ? next : b)));
}

/** Sets a band's phase mode, keeping the default inherited mode implicit. */
function setBandPhase(index: number, phase: EqBandPhase): void {
  const bands = currentBands();
  const band = bands[index];
  if (!band || (band.phase ?? 'inherit') === phase) return;
  const next: EqBandInput = { ...band };
  if (phase === 'inherit') delete next.phase;
  else next.phase = phase;
  commitBands(bands.map((b, i) => (i === index ? next : b)));
}

type DynamicMode = 'off' | 'down' | 'up';

/** Maps a band to the compact dynamic EQ mode shown in the menu. */
function dynamicMode(band: EqBandInput): DynamicMode {
  if (!band.dynamic) return 'off';
  return (band.rangeDb ?? -6) > 0 ? 'up' : 'down';
}

/** Enables or disables dynamic EQ with practical defaults for new bands. */
function setBandDynamicMode(index: number, mode: DynamicMode): void {
  const bands = currentBands();
  const band = bands[index];
  if (!band || dynamicMode(band) === mode) return;
  const next: EqBandInput = { ...band };
  if (mode === 'off') {
    delete next.dynamic;
    delete next.thresholdDb;
    delete next.autoThreshold;
    delete next.ratio;
    delete next.rangeDb;
    delete next.attackMs;
    delete next.releaseMs;
    delete next.detectorDelayMs;
    delete next.externalSidechain;
    delete next.sidechainFreqHz;
    delete next.sidechainQ;
  } else {
    const range = Math.abs(band.rangeDb ?? 6);
    next.dynamic = true;
    next.thresholdDb = band.thresholdDb ?? -24;
    next.ratio = band.ratio ?? 2;
    next.rangeDb = mode === 'up' ? range : -range;
    next.attackMs = band.attackMs ?? 10;
    next.releaseMs = band.releaseMs ?? 120;
  }
  commitBands(bands.map((b, i) => (i === index ? next : b)));
}

/** Appends a neutral bell band when under the band cap. */
function addBand(): void {
  const bands = currentBands();
  if (bands.length >= MAX_BANDS) return;
  const band: EqBandInput = {
    type: 'peak',
    ...bandDefaults('peak'),
    frequencyHz: ADDED_BAND_FREQ,
    gainDb: 0,
    enabled: true,
  };
  commitBands([...bands, band]);
}

/** Removes a band, keeping at least one. */
function removeBand(index: number): void {
  const bands = currentBands();
  if (bands.length <= 1) return;
  gestures.clear();
  commitBands(bands.filter((_, i) => i !== index));
}

type EqControlsKey = keyof typeof t.value.shell.mixer.controls;

const EQ_MIDI_LEARN_LABEL_KEY: Record<MidiLearnEqParam, EqControlsKey> = {
  frequencyHz: 'midiLearnFreq',
  gainDb: 'midiLearnGain',
  q: 'midiLearnQ',
};

const EQ_MIDI_FORGET_LABEL_KEY: Record<MidiLearnEqParam, EqControlsKey> = {
  frequencyHz: 'midiForgetFreq',
  gainDb: 'midiForgetGain',
  q: 'midiForgetQ',
};

function learnEqId(index: number, param: MidiLearnEqParam): string {
  if (typeof props.target !== 'number' && props.target !== 'master') return '';
  return midiLearnEqTargetId(props.target, index, param);
}

function appendMidiLearnItems(items: ContextMenuItem[], index: number, band: EqBandInput): void {
  if (!midiLearn || (typeof props.target !== 'number' && props.target !== 'master')) return;
  const params: MidiLearnEqParam[] = bandUsesGain(band)
    ? ['frequencyHz', 'gainDb', 'q']
    : ['frequencyHz', 'q'];
  items.push({ id: 'sep-midi-learn', separator: true });
  for (const param of params) {
    const id = learnEqId(index, param);
    if (id === '') continue;
    const armed = midiLearn.isArmedId(id);
    const bound = midiLearn.bindingForId(id) !== undefined;
    items.push({
      id: `midi:learn:${param}`,
      label: armed
        ? t.value.shell.mixer.controls.midiLearnListening
        : t.value.shell.mixer.controls[EQ_MIDI_LEARN_LABEL_KEY[param]],
      checked: armed || bound,
      run: () => midiLearn.armId(id),
    });
    if (bound) {
      items.push({
        id: `midi:forget:${param}`,
        label: t.value.shell.mixer.controls[EQ_MIDI_FORGET_LABEL_KEY[param]],
        run: () => midiLearn.clearId(id),
      });
    }
  }
}

/** Opens the per-band action menu: change type or remove the band. */
function openBandMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  const band = currentBands()[index];
  if (!band) return;
  const items: ContextMenuItem[] = BAND_TYPE_CHOICES.map((choice) => ({
    id: `type:${choice.type}`,
    label: t.value.shell.mixer.eq.types[choice.labelKey],
    checked: (band.type ?? 'peak') === choice.type,
    run: () => setBandType(index, choice.type),
  }));
  items.push({ id: 'sep-placement', separator: true });
  for (const choice of PLACEMENT_CHOICES) {
    items.push({
      id: `placement:${choice.placement}`,
      label: t.value.shell.mixer.eq.placement[choice.labelKey],
      checked: (band.placement ?? 'stereo') === choice.placement,
      run: () => setBandPlacement(index, choice.placement),
    });
  }
  items.push({ id: 'sep-phase', separator: true });
  for (const choice of PHASE_CHOICES) {
    items.push({
      id: `phase:${choice.phase}`,
      label: t.value.shell.mixer.eq.phase[choice.labelKey],
      checked: (band.phase ?? 'inherit') === choice.phase,
      run: () => setBandPhase(index, choice.phase),
    });
  }
  items.push({ id: 'sep-dynamic', separator: true });
  const currentDynamic = dynamicMode(band);
  items.push(
    {
      id: 'dynamic:off',
      label: t.value.shell.mixer.eq.dynamic.off,
      checked: currentDynamic === 'off',
      run: () => setBandDynamicMode(index, 'off'),
    },
    {
      id: 'dynamic:down',
      label: t.value.shell.mixer.eq.dynamic.down,
      checked: currentDynamic === 'down',
      run: () => setBandDynamicMode(index, 'down'),
    },
    {
      id: 'dynamic:up',
      label: t.value.shell.mixer.eq.dynamic.up,
      checked: currentDynamic === 'up',
      run: () => setBandDynamicMode(index, 'up'),
    },
  );
  items.push({ id: 'sep', separator: true });
  items.push({
    id: 'remove',
    label: t.value.shell.mixer.eq.removeBand,
    danger: true,
    disabledReason: firstBlock([currentBands().length <= 1, t.value.shell.mixer.reasons.lastBand]),
    run: () => removeBand(index),
  });
  appendMidiLearnItems(items, index, band);
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
        v-tooltip="eq?.enabled ? t.shell.mixer.eq.bypass : t.shell.mixer.eq.enable"
        :aria-label="t.shell.mixer.eq.power"
        :aria-pressed="eq?.enabled === true"
        @click="onTogglePower"
      />
      <span class="eq-title" v-tooltip="t.shell.mixer.eq.sectionTitle">EQ</span>
      <span class="eq-head-spacer" />
      <button
        type="button"
        class="eq-match"
        :disabled="!!matchFlatBlocked"
        v-tooltip="{ text: t.shell.mixer.eq.matchFlatTitle, reason: matchFlatBlocked }"
        :aria-label="t.shell.mixer.eq.matchFlat"
        @click="onMatchFlat"
      >
        ≈
      </button>
      <button
        type="button"
        class="eq-add"
        :disabled="!!addBandBlocked"
        v-tooltip="{ text: t.shell.mixer.eq.addTitle, reason: addBandBlocked }"
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
      <path v-if="spectrumPath" :d="spectrumPath" class="eq-spectrum" />
      <line x1="0" :y1="GRAPH_H / 2" :x2="GRAPH_W" :y2="GRAPH_H / 2" class="eq-zero" />
      <path :d="curvePath" class="eq-curve" fill="none" />
    </svg>
    <div v-if="eq" class="eq-bands">
      <div v-for="(band, index) in eq.bands" :key="index" class="eq-band">
        <button
          type="button"
          class="eq-band-label"
          v-tooltip="
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
          :reason="bandsBlocked"
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
          :reason="bandsBlocked"
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
          :reason="bandsBlocked"
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

.eq-graph,
.eq-band-label {
  transition: opacity var(--dur-2) var(--ease-out);
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
  transition: background var(--dur-2) var(--ease-out);
}

.eq-power.on {
  background: var(--success);
  --latch-from: 0.6;
  animation: toggle-latch var(--dur-3) var(--ease-spring);
}

.eq-title {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
  letter-spacing: 0.06em;
  color: var(--text-4);
}

.eq-head-spacer {
  flex: 1;
}

.eq-add,
.eq-match {
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
  font: var(--fw-bold) var(--fs-2xs) var(--font-sans);
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.eq-match {
  font-size: var(--fs-chrome-lg);
}

.eq-add:hover:not(:disabled),
.eq-match:hover:not(:disabled) {
  color: var(--text-1);
  box-shadow: var(--control-lift-hover);
}

.eq-add:disabled,
.eq-match:disabled {
  opacity: 0.45;
  cursor: default;
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

.eq-spectrum {
  fill: rgba(34, 197, 94, 0.16);
  stroke: rgba(34, 197, 94, 0.35);
  stroke-width: 0.8;
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
  font: var(--fw-semibold) var(--fs-chrome-sm) var(--font-sans);
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
