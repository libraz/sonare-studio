<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { addNote, deleteNotes, updateNotes } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import {
  bakePattern,
  isEmptyPlan,
  patternFromNotes,
  planNoteReplacement,
} from '@/ui/step-sequencer/bake';
import { euclideanRhythm } from '@/ui/step-sequencer/euclid';
import { STEP_PARAM_KINDS, type StepParamKind } from '@/ui/step-sequencer/param-lane';
import {
  clearedRow,
  createDrumPattern,
  createPitchPattern,
  type SequencerMode,
  STEP_COUNTS,
  STEP_RESOLUTIONS,
  type StepCount,
  type StepPattern,
  type StepResolution,
  shiftedRow,
  withRowFill,
  withRowMuted,
  withStep,
  withStepCount,
  withSwing,
} from '@/ui/step-sequencer/pattern';
import { jitterVelocities, sparseFill } from '@/ui/step-sequencer/randomize';
import StepGrid from './StepGrid.vue';
import StepParamLane from './StepParamLane.vue';

/**
 * Step sequencer / drum editor. The pattern (rows, steps, resolution, swing,
 * seed) is session-local component state; MIDI notes are generated output:
 * "Apply to clip" bakes the pattern and replaces the active MIDI clip's
 * notes through the project commands, "Pull from clip" snaps existing notes
 * back onto the grid. Pattern edits themselves never touch the project, so
 * only Apply shows up in the undo history.
 */

const emit = defineEmits<{
  /** Fired after a successful Apply with the number of baked notes. */
  applied: [noteCount: number];
  /** Fired after Pull with the number of notes captured into the pattern. */
  pulled: [noteCount: number];
}>();

const store = useProjectStore();

/** The editable pattern (replaced wholesale by every pure operation). */
const pattern = ref<StepPattern>(createDrumPattern());

/** Row whose parameters are edited in the lane and targeted by row ops. */
const selectedRow = ref(0);

/** Active parameter lane tab. */
const paramTab = ref<StepParamKind>('velocity');

/** Root pitch for pitch-mode rows (lowest of the chromatic octave). */
const rootPitch = ref(48);

/** Euclidean fill popover state. */
const euclidOpen = ref(false);
const euclidPulses = ref(4);
const euclidRotation = ref(0);

/** Randomize controls (seed lives on the pattern). */
const jitterAmount = ref(12);
const fillDensity = ref(25);

/** One-line status / error feedback under the toolbar. */
const status = ref('');

const activeClip = computed(() => store.clips.find((clip) => clip.id === store.clipId) ?? null);

/** True when the active clip exists and holds MIDI content. */
const canTargetClip = computed(() => {
  const clip = activeClip.value;
  return clip !== null && clipKind(clip) === 'midi';
});

const selectedRowSteps = computed(() => pattern.value.rows[selectedRow.value]?.steps ?? []);
const selectedRowMuted = computed(() => pattern.value.rows[selectedRow.value]?.muted === true);

// Keep the selected row valid when rows are rebuilt (mode switch / pull).
watch(
  () => pattern.value.rows.length,
  (count) => {
    if (selectedRow.value >= count) selectedRow.value = Math.max(0, count - 1);
  },
);

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// --- Toolbar handlers -------------------------------------------------------

function setMode(mode: SequencerMode): void {
  if (mode === pattern.value.mode) return;
  const { stepCount, resolution, swing, seed } = pattern.value;
  const next =
    mode === 'drum'
      ? createDrumPattern(stepCount, resolution)
      : createPitchPattern(rootPitch.value, stepCount, resolution);
  next.swing = swing;
  next.seed = seed;
  pattern.value = next;
  selectedRow.value = 0;
  status.value = '';
}

function onRootPitchChange(event: Event): void {
  const value = clampInt(Number((event.target as HTMLInputElement).value), 0, 115, 48);
  rootPitch.value = value;
  if (pattern.value.mode === 'pitch') {
    const { stepCount, resolution, swing, seed } = pattern.value;
    const next = createPitchPattern(value, stepCount, resolution);
    next.swing = swing;
    next.seed = seed;
    pattern.value = next;
  }
}

function onStepCountChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  if ((STEP_COUNTS as ReadonlyArray<number>).includes(value)) {
    pattern.value = withStepCount(pattern.value, value as StepCount);
  }
}

function onResolutionChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as StepResolution;
  if (STEP_RESOLUTIONS.includes(value)) {
    pattern.value = { ...pattern.value, resolution: value };
  }
}

function onSwingChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  pattern.value = withSwing(pattern.value, Number.isFinite(value) ? value : 0);
}

function onSeedChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  pattern.value = { ...pattern.value, seed: Number.isFinite(value) ? Math.trunc(value) : 1 };
}

// --- Grid / lane handlers ---------------------------------------------------

function onSetStep(rowIndex: number, stepIndex: number, active: boolean): void {
  const current = pattern.value.rows[rowIndex]?.steps[stepIndex];
  if (!current || current.active === active) return;
  pattern.value = withStep(pattern.value, rowIndex, stepIndex, { active });
}

function onSetParamValue(stepIndex: number, value: number): void {
  const patch =
    paramTab.value === 'velocity'
      ? { velocity: value }
      : paramTab.value === 'gate'
        ? { gate: value }
        : { offset: value };
  pattern.value = withStep(pattern.value, selectedRow.value, stepIndex, patch);
}

// --- Row operations ---------------------------------------------------------

function toggleRowMute(): void {
  pattern.value = withRowMuted(pattern.value, selectedRow.value, !selectedRowMuted.value);
}

function clearSelectedRow(): void {
  pattern.value = clearedRow(pattern.value, selectedRow.value);
}

function shiftSelectedRow(delta: number): void {
  pattern.value = shiftedRow(pattern.value, selectedRow.value, delta);
}

function applyEuclid(): void {
  const pulses = clampInt(euclidPulses.value, 0, pattern.value.stepCount, 0);
  const rotation = clampInt(euclidRotation.value, -64, 64, 0);
  const flags = euclideanRhythm(pulses, pattern.value.stepCount, rotation);
  pattern.value = withRowFill(pattern.value, selectedRow.value, flags);
  euclidOpen.value = false;
}

// --- Randomize ---------------------------------------------------------------

function applyJitter(): void {
  pattern.value = jitterVelocities(pattern.value, {
    seed: pattern.value.seed,
    amount: clampInt(jitterAmount.value, 0, 64, 12),
  });
}

function applyFill(): void {
  pattern.value = sparseFill(pattern.value, {
    seed: pattern.value.seed,
    density: clampInt(fillDensity.value, 0, 100, 25) / 100,
  });
}

// --- Bake / unbake -----------------------------------------------------------

function applyToClip(): void {
  const clip = activeClip.value;
  if (!clip || !canTargetClip.value) {
    status.value = 'No active MIDI clip to apply to.';
    return;
  }
  const baked = bakePattern(pattern.value, { basePpq: clip.sourceOffsetPpq });
  const plan = planNoteReplacement(store.notes, baked);
  if (isEmptyPlan(plan)) {
    status.value = 'Clip already matches the pattern.';
    return;
  }
  try {
    if (plan.updates.length > 0) updateNotes(plan.updates);
    if (plan.deleteIds.length > 0) deleteNotes(plan.deleteIds);
    for (const note of plan.additions) addNote(note);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
    return;
  }
  status.value = `Applied ${baked.length} notes to "${clip.name}".`;
  emit('applied', baked.length);
}

function pullFromClip(): void {
  const clip = activeClip.value;
  if (!clip || !canTargetClip.value) {
    status.value = 'No active MIDI clip to pull from.';
    return;
  }
  const result = patternFromNotes(store.notes, pattern.value, clip.sourceOffsetPpq);
  pattern.value = result.pattern;
  const captured = store.notes.length - result.droppedNotes;
  status.value =
    result.droppedNotes > 0
      ? `Pulled ${captured} notes (${result.droppedNotes} off-grid notes dropped).`
      : `Pulled ${captured} notes from "${clip.name}".`;
  emit('pulled', captured);
}

defineExpose({ pattern, selectedRow, applyToClip, pullFromClip });
</script>

<template>
  <div class="step-sequencer">
    <div class="seq-toolbar">
      <div class="tool-group">
        <select
          class="tool-select"
          :value="pattern.mode"
          aria-label="Row mode"
          @change="setMode(($event.target as HTMLSelectElement).value as SequencerMode)"
        >
          <option value="drum">Drums</option>
          <option value="pitch">Pitch</option>
        </select>
        <input
          v-if="pattern.mode === 'pitch'"
          class="tool-number"
          type="number"
          min="0"
          max="115"
          :value="rootPitch"
          aria-label="Root pitch"
          @change="onRootPitchChange"
        />
      </div>
      <div class="tool-group">
        <label class="tool-label">Steps</label>
        <select
          class="tool-select"
          :value="String(pattern.stepCount)"
          aria-label="Pattern length"
          @change="onStepCountChange"
        >
          <option v-for="count in STEP_COUNTS" :key="count" :value="String(count)">
            {{ count }}
          </option>
        </select>
        <select
          class="tool-select"
          :value="pattern.resolution"
          aria-label="Step resolution"
          @change="onResolutionChange"
        >
          <option v-for="resolution in STEP_RESOLUTIONS" :key="resolution" :value="resolution">
            {{ resolution }}
          </option>
        </select>
        <label class="tool-label">Swing</label>
        <input
          class="tool-number"
          type="number"
          min="0"
          max="100"
          :value="pattern.swing"
          aria-label="Swing percent"
          @change="onSwingChange"
        />
      </div>
      <div class="tool-group">
        <button type="button" class="tool-button" data-test="row-mute" @click="toggleRowMute">
          {{ selectedRowMuted ? 'Unmute' : 'Mute' }}
        </button>
        <button type="button" class="tool-button" data-test="row-clear" @click="clearSelectedRow">
          Clear
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="row-shift-left"
          aria-label="Shift row left"
          @click="shiftSelectedRow(-1)"
        >
          ◀
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="row-shift-right"
          aria-label="Shift row right"
          @click="shiftSelectedRow(1)"
        >
          ▶
        </button>
        <div class="euclid-anchor">
          <button
            type="button"
            class="tool-button"
            data-test="euclid-toggle"
            @click="euclidOpen = !euclidOpen"
          >
            Euclid
          </button>
          <div v-if="euclidOpen" class="euclid-popover">
            <label class="tool-label">
              Pulses
              <input
                v-model.number="euclidPulses"
                class="tool-number"
                type="number"
                min="0"
                :max="pattern.stepCount"
              />
            </label>
            <label class="tool-label">
              Rotate
              <input
                v-model.number="euclidRotation"
                class="tool-number"
                type="number"
                min="-64"
                max="64"
              />
            </label>
            <button type="button" class="tool-button" data-test="euclid-apply" @click="applyEuclid">
              Fill row
            </button>
          </div>
        </div>
      </div>
      <div class="tool-group">
        <label class="tool-label">Seed</label>
        <input
          class="tool-number"
          type="number"
          :value="pattern.seed"
          aria-label="Random seed"
          @change="onSeedChange"
        />
        <input
          v-model.number="jitterAmount"
          class="tool-number"
          type="number"
          min="0"
          max="64"
          aria-label="Velocity jitter amount"
        />
        <button type="button" class="tool-button" data-test="jitter" @click="applyJitter">
          Jitter
        </button>
        <input
          v-model.number="fillDensity"
          class="tool-number"
          type="number"
          min="0"
          max="100"
          aria-label="Fill density percent"
        />
        <button type="button" class="tool-button" data-test="fill" @click="applyFill">
          Fill
        </button>
      </div>
      <div class="tool-group tool-group-apply">
        <button
          type="button"
          class="tool-button tool-button-primary"
          data-test="apply"
          :disabled="!canTargetClip"
          @click="applyToClip"
        >
          Apply to clip
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="pull"
          :disabled="!canTargetClip"
          @click="pullFromClip"
        >
          Pull from clip
        </button>
      </div>
    </div>
    <p v-if="status" class="seq-status" data-test="status">{{ status }}</p>
    <StepGrid
      :pattern="pattern"
      :selected-row="selectedRow"
      @set-step="onSetStep"
      @select-row="selectedRow = $event"
    />
    <div class="param-tabs">
      <button
        v-for="kind in STEP_PARAM_KINDS"
        :key="kind"
        type="button"
        class="param-tab"
        :class="{ 'param-tab-active': paramTab === kind }"
        :data-test="`param-tab-${kind}`"
        @click="paramTab = kind"
      >
        {{ kind === 'velocity' ? 'VEL' : kind === 'gate' ? 'GATE' : 'OFS' }}
      </button>
      <span class="param-row-name">{{ pattern.rows[selectedRow]?.name ?? '' }}</span>
    </div>
    <div class="param-lane-row">
      <div class="param-lane-spacer" />
      <StepParamLane
        class="param-lane-cell"
        :steps="selectedRowSteps"
        :param="paramTab"
        @set-value="onSetParamValue"
      />
    </div>
  </div>
</template>

<style scoped>
.step-sequencer {
  display: flex;
  flex-direction: column;
  width: 100%;
  background: #101216;
  color: #c8cdd6;
  font: 12px/1.4 system-ui, sans-serif;
}

.seq-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  padding: 0.3rem 0.5rem;
  background: #14161b;
  border-bottom: 1px solid rgba(0, 0, 0, 0.4);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.tool-group-apply {
  margin-left: auto;
}

.tool-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: #9aa1ad;
  white-space: nowrap;
}

.tool-select,
.tool-number {
  background: #1c1f26;
  color: #e2e6ed;
  border: 1px solid #3a4150;
  border-radius: 3px;
  padding: 0.1rem 0.25rem;
  font: inherit;
}

.tool-number {
  width: 3.5rem;
}

.tool-button {
  padding: 0.15rem 0.5rem;
  border: 1px solid #3a4150;
  border-radius: 3px;
  background: #1c1f26;
  color: #c8cdd6;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.tool-button:hover:not(:disabled) {
  background: #242936;
}

.tool-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.tool-button-primary {
  border-color: #2f5b9e;
  background: #1f3253;
  color: #dbe7fb;
}

.euclid-anchor {
  position: relative;
}

.euclid-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem;
  background: #181a20;
  border: 1px solid #3a4150;
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.seq-status {
  margin: 0;
  padding: 0.2rem 0.5rem;
  color: #9aa1ad;
  background: #12141a;
  border-bottom: 1px solid rgba(0, 0, 0, 0.4);
}

.param-tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  background: #14161b;
  border-top: 1px solid rgba(0, 0, 0, 0.4);
}

.param-tab {
  padding: 0.1rem 0.45rem;
  border: 1px solid transparent;
  border-radius: 9999px;
  background: transparent;
  color: #9aa1ad;
  font: 600 10px system-ui, sans-serif;
  letter-spacing: 0.08em;
  cursor: pointer;
}

.param-tab-active {
  border-color: #3a4150;
  background: #1c1f26;
  color: #e2e6ed;
}

.param-row-name {
  margin-left: auto;
  color: #5b6270;
  font-size: 10px;
}

.param-lane-row {
  display: flex;
  gap: 4px;
  padding: 0 4px 4px;
  background: #101216;
}

.param-lane-spacer {
  flex: none;
  width: 110px;
}

.param-lane-cell {
  flex: 1;
  min-width: 0;
}
</style>
