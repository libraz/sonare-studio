<script setup lang="ts">
import { computed, reactive } from 'vue';
import { bakeClipMidiFx } from '@/project/commands';
import {
  DEFAULT_MIDI_FX_CONFIG,
  isMidiFxNoop,
  MIDI_FX_CHORD_PRESETS,
  MIDI_FX_QUANTIZE_GRIDS,
  type MidiFxConfig,
  sanitizeMidiFxConfig,
} from '@/project/midi-fx';
import { useI18n } from '@/ui/i18n';

/**
 * MIDI-FX transform popover for the active MIDI clip: transpose, grid quantize,
 * velocity scale/offset/curve, timing/velocity humanize and chord harmonize.
 * Apply bakes the transform destructively into the clip's notes through the
 * engine (one undoable edit) — there is no live preview because the bake
 * rewrites stored events, so the panel is honest apply-on-demand.
 */

const props = defineProps<{
  /** Target MIDI clip id. */
  clipId: number;
}>();

const emit = defineEmits<{
  /** Request the host close the panel. */
  close: [];
}>();

const { t } = useI18n();

/** Working transform; mutated by the controls, baked on Apply. */
const config = reactive<MidiFxConfig>({ ...DEFAULT_MIDI_FX_CONFIG, chordIntervals: [] });

/** Currently selected harmonize preset id (matched by interval equality). */
const chordPresetId = computed(() => {
  const current = config.chordIntervals.join(',');
  return (
    MIDI_FX_CHORD_PRESETS.find((preset) => preset.intervals.join(',') === current)?.id ?? 'custom'
  );
});

/** True when the transform would leave every note unchanged. */
const noop = computed(() => isMidiFxNoop(sanitizeMidiFxConfig(config)));

/** Selects a harmonize preset (replaces the interval set). */
function selectChord(intervals: number[]): void {
  config.chordIntervals = [...intervals];
}

/** Restores every control to its identity value. */
function reset(): void {
  Object.assign(config, { ...DEFAULT_MIDI_FX_CONFIG, chordIntervals: [] });
}

/** Bakes the transform into the clip and closes the panel. */
function apply(): void {
  if (noop.value) return;
  bakeClipMidiFx(props.clipId, sanitizeMidiFxConfig(config));
  emit('close');
}

/** Formats a 0..1 strength as a whole-number percentage. */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
</script>

<template>
  <div class="midi-fx-panel" role="dialog" :aria-label="t.shell.pianoRoll.midiTransform.label">
    <header class="fx-head">
      <h2 class="fx-title">{{ t.shell.pianoRoll.midiTransform.title }}</h2>
      <button
        type="button"
        class="fx-close"
        :aria-label="t.shell.pianoRoll.midiTransform.close"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div class="fx-body">
      <section class="fx-group">
        <div class="fx-row">
          <label class="fx-label" for="fx-transpose">
            {{ t.shell.pianoRoll.midiTransform.transpose }}
          </label>
          <input
            id="fx-transpose"
            v-model.number="config.transposeSemitones"
            type="range"
            min="-24"
            max="24"
            step="1"
          />
          <output class="fx-value">{{ config.transposeSemitones > 0 ? '+' : ''
            }}{{ config.transposeSemitones }} st</output>
        </div>
      </section>

      <section class="fx-group">
        <div class="fx-group-head">{{ t.shell.pianoRoll.midiTransform.quantize }}</div>
        <div
          class="fx-grid-tabs"
          role="group"
          :aria-label="t.shell.pianoRoll.midiTransform.quantizeGrid"
        >
          <button
            v-for="grid in MIDI_FX_QUANTIZE_GRIDS"
            :key="grid.id"
            type="button"
            class="fx-chip"
            :class="{ 'fx-chip-active': config.quantizeGrid === grid.ppq }"
            @click="config.quantizeGrid = grid.ppq"
          >
            {{ grid.label }}
          </button>
        </div>
        <div class="fx-row">
          <label class="fx-label" for="fx-q-strength">
            {{ t.shell.pianoRoll.midiTransform.strength }}
          </label>
          <input
            id="fx-q-strength"
            v-model.number="config.quantizeStrength"
            type="range"
            min="0"
            max="1"
            step="0.05"
          />
          <output class="fx-value">{{ pct(config.quantizeStrength) }}</output>
        </div>
      </section>

      <section class="fx-group">
        <div class="fx-group-head">{{ t.shell.pianoRoll.midiTransform.velocity }}</div>
        <div class="fx-row">
          <label class="fx-label" for="fx-v-scale">
            {{ t.shell.pianoRoll.midiTransform.scale }}
          </label>
          <input
            id="fx-v-scale"
            v-model.number="config.velocityScale"
            type="range"
            min="0"
            max="2"
            step="0.05"
          />
          <output class="fx-value">{{ pct(config.velocityScale) }}</output>
        </div>
        <div class="fx-row">
          <label class="fx-label" for="fx-v-offset">
            {{ t.shell.pianoRoll.midiTransform.offset }}
          </label>
          <input
            id="fx-v-offset"
            v-model.number="config.velocityOffset"
            type="range"
            min="-64"
            max="64"
            step="1"
          />
          <output class="fx-value">{{ config.velocityOffset > 0 ? '+' : ''
            }}{{ config.velocityOffset }}</output>
        </div>
        <div class="fx-row">
          <label class="fx-label" for="fx-v-gamma">
            {{ t.shell.pianoRoll.midiTransform.curve }}
          </label>
          <input
            id="fx-v-gamma"
            v-model.number="config.velocityGamma"
            type="range"
            min="0.25"
            max="4"
            step="0.05"
          />
          <output class="fx-value">{{ config.velocityGamma.toFixed(2) }}</output>
        </div>
      </section>

      <section class="fx-group">
        <div class="fx-group-head">{{ t.shell.pianoRoll.midiTransform.humanize }}</div>
        <div class="fx-row">
          <label class="fx-label" for="fx-h-time">
            {{ t.shell.pianoRoll.midiTransform.timing }}
          </label>
          <input
            id="fx-h-time"
            v-model.number="config.humanizeTimingPpq"
            type="range"
            min="0"
            max="0.25"
            step="0.01"
          />
          <output class="fx-value">±{{ config.humanizeTimingPpq.toFixed(2) }} beat</output>
        </div>
        <div class="fx-row">
          <label class="fx-label" for="fx-h-vel">
            {{ t.shell.pianoRoll.midiTransform.velocity }}
          </label>
          <input
            id="fx-h-vel"
            v-model.number="config.humanizeVelocity"
            type="range"
            min="0"
            max="32"
            step="1"
          />
          <output class="fx-value">±{{ config.humanizeVelocity }}</output>
        </div>
      </section>

      <section class="fx-group">
        <div class="fx-group-head">{{ t.shell.pianoRoll.midiTransform.harmonize }}</div>
        <div
          class="fx-grid-tabs"
          role="group"
          :aria-label="t.shell.pianoRoll.midiTransform.harmonizeChord"
        >
          <button
            v-for="preset in MIDI_FX_CHORD_PRESETS"
            :key="preset.id"
            type="button"
            class="fx-chip"
            :class="{ 'fx-chip-active': chordPresetId === preset.id }"
            @click="selectChord(preset.intervals)"
          >
            {{ preset.label }}
          </button>
        </div>
      </section>
    </div>

    <footer class="fx-foot">
      <span class="fx-hint">{{ t.shell.pianoRoll.midiTransform.hint }}</span>
      <span class="fx-spacer" />
      <button type="button" class="fx-btn" @click="reset">
        {{ t.shell.pianoRoll.midiTransform.reset }}
      </button>
      <button type="button" class="fx-btn fx-btn-primary" :disabled="noop" @click="apply">
        {{ t.shell.pianoRoll.midiTransform.apply }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.midi-fx-panel {
  position: absolute;
  top: calc(100% + var(--sp-2));
  right: var(--sp-3);
  z-index: 40;
  width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-family: var(--font-sans);
  color: var(--text-2);
}

.fx-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
}

.fx-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.fx-close {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: var(--fs-lg);
  line-height: 1;
  cursor: pointer;
  padding: 0 var(--sp-1);
}

.fx-close:hover {
  color: var(--text-1);
}

.fx-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3);
  max-height: 60vh;
  overflow-y: auto;
}

.fx-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.fx-group-head {
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.fx-row {
  display: grid;
  grid-template-columns: 4.5rem 1fr 4.5rem;
  align-items: center;
  gap: var(--sp-2);
}

.fx-label {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.fx-row input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.fx-value {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text-3);
}

.fx-grid-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}

.fx-chip {
  flex: 0 0 auto;
  padding: 2px var(--sp-2);
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-2);
  box-shadow: var(--control-lift);
  cursor: pointer;
}

.fx-chip:hover {
  box-shadow: var(--control-lift-hover);
}

.fx-chip-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.fx-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.fx-hint {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.fx-spacer {
  flex: 1 1 auto;
}

.fx-btn {
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-2);
  box-shadow: var(--control-lift);
  cursor: pointer;
}

.fx-btn:hover {
  box-shadow: var(--control-lift-hover);
}

.fx-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.fx-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
