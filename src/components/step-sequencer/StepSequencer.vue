<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { confirmDialog } from '@/composables/useDialogs';
import { applyNoteEdits } from '@/project/commands';
import { unfreezeTrack } from '@/project/freeze';
import { audibleMidiSourceWindow } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  bakePattern,
  isEmptyPlan,
  patternFromNotes,
  planNoteReplacement,
  trimBakedNotesToWindow,
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
import { patternLengthPpq } from '@/ui/step-sequencer/timing';
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
const { t } = useI18n();

/** The editable pattern (replaced wholesale by every pure operation). */
const pattern = ref<StepPattern>(createDrumPattern());
interface PatternHistoryEntry {
  pattern: StepPattern;
  rootPitch: number;
}

const undoStack = ref<PatternHistoryEntry[]>([]);
const redoStack = ref<PatternHistoryEntry[]>([]);
const MAX_PATTERN_HISTORY = 100;

function snapshot(value: StepPattern): StepPattern {
  return JSON.parse(JSON.stringify(value)) as StepPattern;
}

function setPattern(next: StepPattern, previousRootPitch = rootPitch.value): void {
  undoStack.value = [
    ...undoStack.value.slice(-(MAX_PATTERN_HISTORY - 1)),
    { pattern: snapshot(pattern.value), rootPitch: previousRootPitch },
  ];
  redoStack.value = [];
  pattern.value = next;
}

function undoPattern(): void {
  const previous = undoStack.value.at(-1);
  if (!previous) return;
  redoStack.value = [
    ...redoStack.value,
    { pattern: snapshot(pattern.value), rootPitch: rootPitch.value },
  ];
  undoStack.value = undoStack.value.slice(0, -1);
  pattern.value = previous.pattern;
  rootPitch.value = previous.rootPitch;
}

function redoPattern(): void {
  const next = redoStack.value.at(-1);
  if (!next) return;
  undoStack.value = [
    ...undoStack.value,
    { pattern: snapshot(pattern.value), rootPitch: rootPitch.value },
  ];
  redoStack.value = redoStack.value.slice(0, -1);
  pattern.value = next.pattern;
  rootPitch.value = next.rootPitch;
}

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

/** Severity of the current status message, driving its tokenised color. */
const statusType = ref<'info' | 'warning' | 'error'>('info');

/** How Apply resolves a pattern whose span exceeds the audible clip window. */
type OverflowPolicy = 'resize' | 'loop' | 'trim';
const overflowPolicy = ref<OverflowPolicy>('trim');

const activeClip = computed(() => store.clips.find((clip) => clip.id === store.clipId) ?? null);

/** True when the active clip exists and holds MIDI content. */
const canTargetClip = computed(() => {
  const clip = activeClip.value;
  return clip !== null && clipKind(clip) === 'midi';
});

/** Frozen content remains available to Pull, but Apply cannot mutate it. */
const contentReadOnly = computed(() => {
  const clip = activeClip.value;
  return (
    clip !== null && store.tracks.find((track) => track.id === clip.trackId)?.frozen !== undefined
  );
});
const canApplyToClip = computed(() => canTargetClip.value && !contentReadOnly.value);

const selectedRowSteps = computed(() => pattern.value.rows[selectedRow.value]?.steps ?? []);
const selectedRowMuted = computed(() => pattern.value.rows[selectedRow.value]?.muted === true);

/** Row mode choices for the mode picker. */
const MODE_OPTIONS = computed<ReadonlyArray<{ value: SequencerMode; label: string }>>(() => [
  { value: 'drum', label: t.value.shell.stepSequencer.modes.drums },
  { value: 'pitch', label: t.value.shell.stepSequencer.modes.pitch },
]);

/** Pattern-length choices, numeric to match the parsed step count. */
const stepCountOptions = computed(() =>
  STEP_COUNTS.map((count) => ({ value: count, label: String(count) })),
);

/** Step-resolution choices. */
const resolutionOptions = computed(() =>
  STEP_RESOLUTIONS.map((resolution) => ({ value: resolution, label: resolution })),
);

const overflowPolicyOptions = computed<ReadonlyArray<{ value: OverflowPolicy; label: string }>>(
  () => [
    { value: 'resize', label: t.value.shell.stepSequencer.overflow.resize },
    { value: 'loop', label: t.value.shell.stepSequencer.overflow.loop },
    { value: 'trim', label: t.value.shell.stepSequencer.overflow.trim },
  ],
);

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
  setPattern(next);
  selectedRow.value = 0;
  status.value = '';
  statusType.value = 'info';
}

function onRootPitchChange(event: Event): void {
  const value = clampInt(Number((event.target as HTMLInputElement).value), 0, 115, 48);
  const previousRootPitch = rootPitch.value;
  rootPitch.value = value;
  if (pattern.value.mode === 'pitch') {
    const { stepCount, resolution, swing, seed } = pattern.value;
    const next = createPitchPattern(value, stepCount, resolution);
    next.swing = swing;
    next.seed = seed;
    setPattern(next, previousRootPitch);
  }
}

function onStepCountChange(value: StepCount): void {
  if ((STEP_COUNTS as ReadonlyArray<number>).includes(value)) {
    setPattern(withStepCount(pattern.value, value));
  }
}

function onResolutionChange(value: StepResolution): void {
  if (STEP_RESOLUTIONS.includes(value)) {
    setPattern({ ...pattern.value, resolution: value });
  }
}

function onSwingChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  setPattern(withSwing(pattern.value, Number.isFinite(value) ? value : 0));
}

function onSeedChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  setPattern({ ...pattern.value, seed: Number.isFinite(value) ? Math.trunc(value) : 1 });
}

// --- Grid / lane handlers ---------------------------------------------------

function onSetStep(rowIndex: number, stepIndex: number, active: boolean): void {
  const current = pattern.value.rows[rowIndex]?.steps[stepIndex];
  if (!current || current.active === active) return;
  setPattern(withStep(pattern.value, rowIndex, stepIndex, { active }));
}

function onSetStepVelocity(rowIndex: number, stepIndex: number, velocity: number): void {
  const current = pattern.value.rows[rowIndex]?.steps[stepIndex];
  if (!current) return;
  const next = Math.min(127, Math.max(1, Math.round(velocity)));
  if (current.velocity !== next) {
    setPattern(withStep(pattern.value, rowIndex, stepIndex, { velocity: next }));
  }
}

function onSetParamValue(stepIndex: number, value: number): void {
  const patch =
    paramTab.value === 'velocity'
      ? { velocity: value }
      : paramTab.value === 'gate'
        ? { gate: value }
        : { offset: value };
  setPattern(withStep(pattern.value, selectedRow.value, stepIndex, patch));
}

// --- Row operations ---------------------------------------------------------

function toggleRowMute(): void {
  setPattern(withRowMuted(pattern.value, selectedRow.value, !selectedRowMuted.value));
}

function clearSelectedRow(): void {
  setPattern(clearedRow(pattern.value, selectedRow.value));
}

function shiftSelectedRow(delta: number): void {
  setPattern(shiftedRow(pattern.value, selectedRow.value, delta));
}

function applyEuclid(): void {
  const pulses = clampInt(euclidPulses.value, 0, pattern.value.stepCount, 0);
  const rotation = clampInt(euclidRotation.value, -64, 64, 0);
  const flags = euclideanRhythm(pulses, pattern.value.stepCount, rotation);
  setPattern(withRowFill(pattern.value, selectedRow.value, flags));
  euclidOpen.value = false;
}

// --- Randomize ---------------------------------------------------------------

function applyJitter(): void {
  const current = pattern.value;
  const next = jitterVelocities(current, {
    seed: current.seed,
    amount: clampInt(jitterAmount.value, 0, 64, 12),
  });
  // jitterVelocities consumes exactly one mulberry32 value per grid cell.
  // Continue from that point so repeated clicks produce fresh deviations while
  // remaining deterministic from the seed input.
  const draws = current.rows.reduce((count, row) => count + row.steps.length, 0);
  next.seed = (Math.trunc(current.seed) + Math.imul(draws, 0x6d2b79f5)) >>> 0;
  setPattern(next);
}

function applyFill(): void {
  setPattern(
    sparseFill(pattern.value, {
      seed: pattern.value.seed,
      density: clampInt(fillDensity.value, 0, 100, 25) / 100,
    }),
  );
}

// --- Bake / unbake -----------------------------------------------------------

async function applyToClip(): Promise<void> {
  const clip = activeClip.value;
  if (!clip || !canTargetClip.value) {
    status.value = t.value.shell.stepSequencer.status.noActiveApply;
    statusType.value = 'warning';
    return;
  }
  if (contentReadOnly.value) {
    status.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
    statusType.value = 'warning';
    return;
  }
  const spanPpq = patternLengthPpq(pattern.value.stepCount, pattern.value.resolution);
  const sourceWindow = audibleMidiSourceWindow(clip);
  const overflows = spanPpq > sourceWindow.lengthPpq + 1e-9;
  let baked = bakePattern(pattern.value, { basePpq: clip.sourceOffsetPpq });
  let clipWindow: Parameters<typeof applyNoteEdits>[0]['clipWindow'];
  if (overflows) {
    const policyLabel = overflowPolicyOptions.value.find(
      (option) => option.value === overflowPolicy.value,
    )?.label;
    const proceed = await confirmDialog({
      title: t.value.shell.stepSequencer.overflow.confirmTitle,
      message: formatMessage(t.value.shell.stepSequencer.overflow.confirmMessage, {
        pattern: spanPpq,
        clip: sourceWindow.lengthPpq,
        policy: policyLabel ?? overflowPolicy.value,
      }),
      confirmLabel: t.value.shell.stepSequencer.overflow.confirmApply,
    });
    if (!proceed) {
      status.value = t.value.shell.stepSequencer.overflow.cancelled;
      statusType.value = 'warning';
      return;
    }
    if (overflowPolicy.value === 'resize') {
      clipWindow = {
        lengthPpq: Math.max(clip.lengthPpq, spanPpq),
        loopEnabled: false,
      };
    } else {
      baked = trimBakedNotesToWindow(baked, sourceWindow.startPpq, sourceWindow.lengthPpq);
      if (overflowPolicy.value === 'loop') {
        clipWindow = {
          lengthPpq: Math.max(clip.lengthPpq, spanPpq),
          loopEnabled: true,
          loopLengthPpq: sourceWindow.lengthPpq,
        };
      }
    }
  }
  const plan = {
    ...planNoteReplacement(store.notes, baked),
    ...(clipWindow ? { clipWindow } : {}),
  };
  if (plan.deleteIds.length > 0) {
    const proceed = await confirmDialog({
      title: t.value.shell.stepSequencer.replace.confirmTitle,
      message: formatMessage(t.value.shell.stepSequencer.replace.confirmMessage, {
        count: plan.deleteIds.length,
      }),
      confirmLabel: t.value.shell.stepSequencer.replace.confirmApply,
    });
    if (!proceed) {
      status.value = t.value.shell.stepSequencer.replace.cancelled;
      statusType.value = 'warning';
      return;
    }
  }
  if (isEmptyPlan(plan) && !clipWindow) {
    status.value = t.value.shell.stepSequencer.status.alreadyMatches;
    statusType.value = 'info';
    return;
  }
  try {
    applyNoteEdits(plan);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
    statusType.value = 'error';
    return;
  }
  status.value = formatMessage(t.value.shell.stepSequencer.status.applied, {
    count: baked.length,
    name: clip.name,
  });
  statusType.value = 'info';
  emit('applied', baked.length);
}

function pullFromClip(): void {
  const clip = activeClip.value;
  if (!clip || !canTargetClip.value) {
    status.value = t.value.shell.stepSequencer.status.noActivePull;
    statusType.value = 'warning';
    return;
  }
  let result: ReturnType<typeof patternFromNotes>;
  try {
    result = patternFromNotes(store.notes, pattern.value, clip.sourceOffsetPpq);
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err);
    statusType.value = 'error';
    return;
  }
  setPattern(result.pattern);
  const captured = store.notes.length - result.droppedNotes;
  if (result.droppedNotes > 0) {
    status.value = formatMessage(t.value.shell.stepSequencer.status.pulledDropped, {
      count: captured,
      dropped: result.droppedNotes,
    });
    statusType.value = 'warning';
  } else {
    status.value = formatMessage(t.value.shell.stepSequencer.status.pulled, {
      count: captured,
      name: clip.name,
    });
    statusType.value = 'info';
  }
  emit('pulled', captured);
}

defineExpose({
  pattern,
  selectedRow,
  overflowPolicy,
  applyToClip,
  pullFromClip,
  undoPattern,
  redoPattern,
});
</script>

<template>
  <div class="step-sequencer">
    <div class="seq-toolbar">
      <div class="tool-group">
        <button
          type="button"
          class="tool-button"
          data-test="pattern-undo"
          :disabled="undoStack.length === 0"
          @click="undoPattern"
        >
          {{ t.shortcuts.actions['edit.undo'] }}
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="pattern-redo"
          :disabled="redoStack.length === 0"
          @click="redoPattern"
        >
          {{ t.shortcuts.actions['edit.redo'] }}
        </button>
      </div>
      <div class="tool-group">
        <SelectMenu
          class="tool-select"
          :model-value="pattern.mode"
          :options="MODE_OPTIONS"
          :aria-label="t.shell.stepSequencer.rowMode"
          size="sm"
          @change="setMode"
        />
        <input
          v-if="pattern.mode === 'pitch'"
          class="tool-number"
          type="number"
          min="0"
          max="115"
          :value="rootPitch"
          :aria-label="t.shell.stepSequencer.rootPitch"
          @change="onRootPitchChange"
        />
      </div>
      <div class="tool-group">
        <label class="tool-label">{{ t.shell.stepSequencer.steps }}</label>
        <SelectMenu
          class="tool-select"
          :model-value="pattern.stepCount"
          :options="stepCountOptions"
          :aria-label="t.shell.stepSequencer.patternLength"
          size="sm"
          @change="onStepCountChange"
        />
        <SelectMenu
          class="tool-select"
          :model-value="pattern.resolution"
          :options="resolutionOptions"
          :aria-label="t.shell.stepSequencer.stepResolution"
          size="sm"
          @change="onResolutionChange"
        />
        <label class="tool-label">{{ t.shell.stepSequencer.swing }}</label>
        <input
          class="tool-number"
          type="number"
          min="0"
          max="100"
          :value="pattern.swing"
          :aria-label="t.shell.stepSequencer.swingPercent"
          @change="onSwingChange"
        />
      </div>
      <div class="tool-group">
        <button type="button" class="tool-button" data-test="row-mute" @click="toggleRowMute">
          {{ selectedRowMuted ? t.shell.stepSequencer.unmute : t.shell.stepSequencer.mute }}
        </button>
        <button type="button" class="tool-button" data-test="row-clear" @click="clearSelectedRow">
          {{ t.shell.stepSequencer.clear }}
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="row-shift-left"
          :aria-label="t.shell.stepSequencer.shiftLeft"
          @click="shiftSelectedRow(-1)"
        >
          <svg class="tool-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="row-shift-right"
          :aria-label="t.shell.stepSequencer.shiftRight"
          @click="shiftSelectedRow(1)"
        >
          <svg class="tool-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
        <div class="euclid-anchor">
          <button
            type="button"
            class="tool-button"
            data-test="euclid-toggle"
            @click="euclidOpen = !euclidOpen"
          >
            {{ t.shell.stepSequencer.euclid }}
          </button>
          <Transition name="pop">
          <div v-if="euclidOpen" class="euclid-popover">
            <label class="tool-label">
              {{ t.shell.stepSequencer.pulses }}
              <input
                v-model.number="euclidPulses"
                class="tool-number"
                type="number"
                min="0"
                :max="pattern.stepCount"
              />
            </label>
            <label class="tool-label">
              {{ t.shell.stepSequencer.rotate }}
              <input
                v-model.number="euclidRotation"
                class="tool-number"
                type="number"
                min="-64"
                max="64"
              />
            </label>
            <button type="button" class="tool-button" data-test="euclid-apply" @click="applyEuclid">
              {{ t.shell.stepSequencer.fillRow }}
            </button>
          </div>
          </Transition>
        </div>
      </div>
      <div class="tool-group">
        <label class="tool-label">{{ t.shell.stepSequencer.seed }}</label>
        <input
          class="tool-number"
          type="number"
          :value="pattern.seed"
          :aria-label="t.shell.stepSequencer.randomSeed"
          @change="onSeedChange"
        />
        <input
          v-model.number="jitterAmount"
          class="tool-number"
          type="number"
          min="0"
          max="64"
          :aria-label="t.shell.stepSequencer.velocityJitter"
        />
        <button type="button" class="tool-button" data-test="jitter" @click="applyJitter">
          {{ t.shell.stepSequencer.jitter }}
        </button>
        <input
          v-model.number="fillDensity"
          class="tool-number"
          type="number"
          min="0"
          max="100"
          :aria-label="t.shell.stepSequencer.fillDensity"
        />
        <button type="button" class="tool-button" data-test="fill" @click="applyFill">
          {{ t.shell.stepSequencer.fill }}
        </button>
      </div>
      <div class="tool-group tool-group-apply">
        <SelectMenu
          v-model="overflowPolicy"
          class="tool-select"
          :options="overflowPolicyOptions"
          :aria-label="t.shell.stepSequencer.overflow.policy"
          size="sm"
        />
        <button
          type="button"
          class="tool-button primary"
          data-test="apply"
          :disabled="!canApplyToClip"
          @click="applyToClip"
        >
          {{ t.shell.stepSequencer.applyToClip }}
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="pull"
          :disabled="!canTargetClip"
          @click="pullFromClip"
        >
          {{ t.shell.stepSequencer.pullFromClip }}
        </button>
      </div>
    </div>
    <div v-if="contentReadOnly" class="seq-readonly" role="status" data-test="readonly">
      <span>{{ t.shell.arrangement.trackHeader.unfreezeTitle }}</span>
      <button type="button" @click="unfreezeTrack(store.activeTrackId)">
        {{ t.shell.arrangement.trackHeader.unfreeze }}
      </button>
    </div>
    <p
      v-if="status"
      class="seq-status"
      :class="`seq-status-${statusType}`"
      data-test="status"
    >
      {{ status }}
    </p>
    <StepGrid
      :pattern="pattern"
      :selected-row="selectedRow"
      @set-step="onSetStep"
      @set-velocity="onSetStepVelocity"
      @select-row="selectedRow = $event"
    />
    <div v-tablist class="param-tabs" role="tablist">
      <button
        v-for="kind in STEP_PARAM_KINDS"
        :key="kind"
        type="button"
        role="tab"
        class="param-tab"
        :class="{ 'param-tab-active': paramTab === kind }"
        :aria-selected="paramTab === kind"
        :data-test="`param-tab-${kind}`"
        @click="paramTab = kind"
      >
        {{ t.shell.stepSequencer.params[kind] }}
      </button>
      <span class="param-row-name">{{ pattern.rows[selectedRow]?.name ?? '' }}</span>
    </div>
    <div class="param-lane-row">
      <div class="param-lane-spacer" />
      <StepParamLane
        class="param-lane-cell"
        :steps="selectedRowSteps"
        :param="paramTab"
        :param-label="t.shell.stepSequencer.accessibility.paramNames[paramTab]"
        :step-label="t.shell.stepSequencer.accessibility.stepNumber"
        @set-value="onSetParamValue"
      />
    </div>
  </div>
</template>

<style scoped>
.step-sequencer {
  /* Single source of truth for the grid/lane alignment contract: the row-label
     gutter width and the minimum cell width are shared with StepGrid and
     StepParamLane (custom properties inherit into their scoped styles). */
  --seq-row-label-w: 110px;
  --seq-cell-min: 8px;
  display: flex;
  flex-direction: column;
  width: 100%;
  background: var(--surface-1);
  color: var(--text-2);
  font: var(--fs-sm)/1.4 var(--font-sans);
}

.seq-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-2) var(--sp-4);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: var(--raise-hi);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.tool-group-apply {
  margin-left: auto;
}

.tool-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--text-3);
  white-space: nowrap;
}

.tool-number {
  background: var(--surface-inset);
  color: var(--text-1);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
  font-variant-numeric: tabular-nums;
  box-shadow: var(--control-edge), var(--inset-well);
  width: 3.5rem;
}

.tool-number:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.tool-select {
  width: auto;
}

.tool-button {
  padding: var(--sp-1) var(--sp-4);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-2);
  font: inherit;
  box-shadow: var(--control-lift);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-out);
}

.tool-button:hover:not(:disabled) {
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.tool-button:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Crisp inline chevron for the row-shift buttons; inherits the label color. */
.tool-glyph {
  display: block;
  width: 0.9em;
  height: 0.9em;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.euclid-anchor {
  position: relative;
}

.euclid-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  /* Grow from the trigger's lower-left, where the popover is anchored. */
  transform-origin: top left;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-hairline), var(--shadow-pop);
}

.seq-status {
  margin: 0;
  padding: 0.2rem 0.5rem;
  color: var(--text-3);
  background: var(--surface-inset);
  border-bottom: 1px solid var(--border-strong);
}

/* Neutral information keeps the muted toolbar color. */
.seq-status-info {
  color: var(--text-3);
}

/* Recoverable conditions (no clip, dropped notes) read as a warning tint. */
.seq-status-warning {
  color: var(--warning-text);
  background: var(--warning-surface);
}

/* Failed bakes read as an error tint. */
.seq-status-error {
  color: var(--danger-text);
  background: var(--danger-surface);
}

.param-tabs {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  background: var(--surface-2);
  border-top: 1px solid var(--border-strong);
}

.param-tab {
  padding: var(--sp-1) var(--sp-4);
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: color var(--dur-1) var(--ease-out);
}

.param-tab:hover {
  color: var(--text-1);
}

/* Active = accent underline, matching the canonical tab focus indicator. */
.param-tab-active {
  color: var(--accent);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.param-row-name {
  margin-left: auto;
  color: var(--text-4);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
}

.param-lane-row {
  display: flex;
  gap: 4px;
  padding: 0 4px 4px;
  background: var(--surface-1);
}

.param-lane-spacer {
  flex: none;
  width: var(--seq-row-label-w);
}

.param-lane-cell {
  flex: 1;
  min-width: 0;
}
</style>
