<script setup lang="ts">
import { deriveSeed } from '@libraz/libcantus';
import { computed, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { confirmDialog } from '@/composables/useDialogs';
import { useGestureTransaction } from '@/composables/useGestureTransaction';
import { describeError } from '@/lib/errors';
import { clampInt } from '@/lib/math';
import { cloneJson } from '@/project/clone-json';
import { applyNoteEdits } from '@/project/commands';
import { unfreezeTrack } from '@/project/freeze';
import { audibleMidiSourceWindow, midiTimelinePpqToSource } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
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
  clampVelocity,
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
import { patternLengthPpq, stepIndexAtPpq } from '@/ui/step-sequencer/timing';
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

const props = defineProps<{
  /** True while the transport is rolling. */
  isPlaying?: boolean;
  /** Reactive transport position getter, in timeline PPQ. */
  positionPpq?: () => number;
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

function pushHistory(entry: PatternHistoryEntry): void {
  undoStack.value = [...undoStack.value.slice(-(MAX_PATTERN_HISTORY - 1)), entry];
  redoStack.value = [];
}

/** A pointer drag or paint stroke records one history entry, however many cells it writes. */
const gesture = useGestureTransaction<PatternHistoryEntry>({ commit: pushHistory });

function beginPointerGesture(): void {
  gesture.begin({ pattern: cloneJson(pattern.value), rootPitch: rootPitch.value });
}

function setPattern(next: StepPattern, previousRootPitch = rootPitch.value): void {
  if (gesture.active) {
    gesture.markDirty();
  } else {
    pushHistory({ pattern: cloneJson(pattern.value), rootPitch: previousRootPitch });
  }
  pattern.value = next;
}

function undoPattern(): void {
  const previous = undoStack.value.at(-1);
  if (!previous) return;
  redoStack.value = [
    ...redoStack.value,
    { pattern: cloneJson(pattern.value), rootPitch: rootPitch.value },
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
    { pattern: cloneJson(pattern.value), rootPitch: rootPitch.value },
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

/**
 * Step under the playhead while the transport rolls through the active clip.
 * Reads the position every frame but only changes value per step, so the grid
 * re-renders at step rate.
 */
const playingStep = computed<number | null>(() => {
  const clip = store.activeClip;
  if (!props.isPlaying || !props.positionPpq || !clip || clipKind(clip) !== 'midi') return null;
  const sourcePpq = midiTimelinePpqToSource(clip, props.positionPpq());
  if (sourcePpq === null) return null;
  const { stepCount, resolution } = pattern.value;
  return stepIndexAtPpq(sourcePpq, clip.sourceOffsetPpq, stepCount, resolution);
});

/** True when the active clip exists and holds MIDI content. */
const canTargetClip = computed(() => {
  const clip = store.activeClip;
  return clip !== null && clipKind(clip) === 'midi';
});

/** Frozen content remains available to Pull, but Apply cannot mutate it. */
const contentReadOnly = computed(() => {
  const clip = store.activeClip;
  return (
    clip !== null && store.tracks.find((track) => track.id === clip.trackId)?.frozen !== undefined
  );
});
const pullBlocked = computed(() => firstBlock([!canTargetClip.value, t.value.reasons.noMidiClip]));
const applyBlocked = computed(() =>
  firstBlock(pullBlocked.value, [contentReadOnly.value, t.value.reasons.trackFrozen]),
);
const undoBlocked = computed(() =>
  firstBlock([undoStack.value.length === 0, t.value.reasons.nothingToUndo]),
);
const redoBlocked = computed(() =>
  firstBlock([redoStack.value.length === 0, t.value.reasons.nothingToRedo]),
);

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
  const next = clampVelocity(velocity);
  if (current.velocity !== next) {
    setPattern(withStep(pattern.value, rowIndex, stepIndex, { velocity: next }));
  }
}

function onSetParamValue(stepIndex: number, value: number): void {
  const current = pattern.value.rows[selectedRow.value]?.steps[stepIndex];
  if (!current || current[paramTab.value] === value) return;
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
  // A cell's deviation depends only on the seed and the cell, so a repeated
  // click needs a new seed to give a fresh result. Deriving it from the current
  // one keeps the whole run of clicks reproducible from the seed first entered.
  next.seed = deriveSeed(Math.trunc(current.seed) >>> 0, 'jitter');
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
  const clip = store.activeClip;
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
      confirmLabel: t.value.common.apply,
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
  if (isEmptyPlan(plan) && !clipWindow) {
    status.value = t.value.shell.stepSequencer.status.alreadyMatches;
    statusType.value = 'info';
    return;
  }
  try {
    applyNoteEdits(plan);
  } catch (err) {
    status.value = describeError(err, t.value.notices.errors);
    statusType.value = 'error';
    return;
  }
  status.value = formatMessage(t.value.shell.stepSequencer.status.applied, {
    count: baked.length,
    name: clip.name,
  });
  statusType.value = 'info';
}

function pullFromClip(): void {
  const clip = store.activeClip;
  if (!clip || !canTargetClip.value) {
    status.value = t.value.shell.stepSequencer.status.noActivePull;
    statusType.value = 'warning';
    return;
  }
  let result: ReturnType<typeof patternFromNotes>;
  try {
    result = patternFromNotes(store.notes, pattern.value, clip.sourceOffsetPpq);
  } catch (err) {
    status.value = describeError(err, t.value.notices.errors);
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
  <div
    class="step-sequencer"
    @pointerdown.capture="beginPointerGesture"
    @pointerup="gesture.end()"
    @pointercancel="gesture.end()"
  >
    <div class="seq-toolbar">
      <div class="tool-group">
        <button
          type="button"
          class="tool-button"
          data-test="pattern-undo"
          :disabled="!!undoBlocked"
          v-tooltip="{ text: t.shell.stepSequencer.undoTitle, reason: undoBlocked }"
          @click="undoPattern"
        >
          {{ t.shortcuts.actions['edit.undo'] }}
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="pattern-redo"
          :disabled="!!redoBlocked"
          v-tooltip="{ text: t.shell.stepSequencer.redoTitle, reason: redoBlocked }"
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
          :title="t.shell.stepSequencer.rowModeTitle"
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
          v-tooltip="t.shell.stepSequencer.rootPitchTitle"
          @change="onRootPitchChange"
        />
        <span class="tool-label">{{ t.shell.stepSequencer.steps }}</span>
        <SelectMenu
          class="tool-select"
          :model-value="pattern.stepCount"
          :options="stepCountOptions"
          :aria-label="t.shell.stepSequencer.patternLength"
          :title="t.shell.stepSequencer.patternLengthTitle"
          size="sm"
          @change="onStepCountChange"
        />
        <SelectMenu
          class="tool-select"
          :model-value="pattern.resolution"
          :options="resolutionOptions"
          :aria-label="t.shell.stepSequencer.stepResolution"
          :title="t.shell.stepSequencer.stepResolutionTitle"
          size="sm"
          @change="onResolutionChange"
        />
        <label class="tool-label" v-tooltip="t.shell.stepSequencer.swingTitle">
          {{ t.shell.stepSequencer.swing }}
          <input
            class="tool-number"
            type="number"
            min="0"
            max="100"
            :value="pattern.swing"
            :aria-label="t.shell.stepSequencer.swingPercent"
            @change="onSwingChange"
          />
        </label>
      </div>
      <div class="tool-group">
        <ToggleButton
          :model-value="selectedRowMuted"
          size="sm"
          data-test="row-mute"
          :label="t.shell.stepSequencer.mute"
          :title="t.shell.stepSequencer.muteTitle"
          @update:model-value="toggleRowMute"
        />
        <button
          type="button"
          class="tool-button"
          data-test="row-clear"
          v-tooltip="t.shell.stepSequencer.clearTitle"
          @click="clearSelectedRow"
        >
          {{ t.shell.stepSequencer.clear }}
        </button>
        <button
          type="button"
          class="tool-button tool-icon"
          data-test="row-shift-left"
          :aria-label="t.shell.stepSequencer.shiftLeft"
          v-tooltip="t.shell.stepSequencer.shiftLeft"
          @click="shiftSelectedRow(-1)"
        >
          <svg class="tool-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <button
          type="button"
          class="tool-button tool-icon"
          data-test="row-shift-right"
          :aria-label="t.shell.stepSequencer.shiftRight"
          v-tooltip="t.shell.stepSequencer.shiftRight"
          @click="shiftSelectedRow(1)"
        >
          <svg class="tool-glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
        <div class="euclid-anchor">
          <button
            type="button"
            class="tool-menu"
            :class="{ 'is-open': euclidOpen }"
            data-test="euclid-toggle"
            aria-haspopup="dialog"
            :aria-expanded="euclidOpen"
            v-tooltip="t.shell.stepSequencer.euclidTitle"
            @click="euclidOpen = !euclidOpen"
          >
            {{ t.shell.stepSequencer.euclid }}
            <svg class="tool-caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
              <path d="M2 3.5l3 3 3-3" />
            </svg>
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
        <label class="tool-label" v-tooltip="t.shell.stepSequencer.seedTitle">
          {{ t.shell.stepSequencer.seed }}
          <input
            class="tool-number"
            type="number"
            :value="pattern.seed"
            :aria-label="t.shell.stepSequencer.randomSeed"
            @change="onSeedChange"
          />
        </label>
        <span class="tool-pair">
          <input
            v-model.number="jitterAmount"
            class="tool-number tool-number-short"
            type="number"
            min="0"
            max="64"
            :aria-label="t.shell.stepSequencer.velocityJitter"
            v-tooltip="t.shell.stepSequencer.velocityJitter"
          />
          <button
            type="button"
            class="tool-button"
            data-test="jitter"
            v-tooltip="t.shell.stepSequencer.jitterTitle"
            @click="applyJitter"
          >
            {{ t.shell.stepSequencer.jitter }}
          </button>
        </span>
        <span class="tool-pair">
          <input
            v-model.number="fillDensity"
            class="tool-number tool-number-short"
            type="number"
            min="0"
            max="100"
            :aria-label="t.shell.stepSequencer.fillDensity"
            v-tooltip="t.shell.stepSequencer.fillDensity"
          />
          <button
            type="button"
            class="tool-button"
            data-test="fill"
            v-tooltip="t.shell.stepSequencer.fillTitle"
            @click="applyFill"
          >
            {{ t.shell.stepSequencer.fill }}
          </button>
        </span>
      </div>
      <div class="tool-group tool-group-apply">
        <SelectMenu
          v-model="overflowPolicy"
          class="tool-select"
          :options="overflowPolicyOptions"
          :aria-label="t.shell.stepSequencer.overflow.policy"
          :title="t.shell.stepSequencer.overflow.policyTitle"
          size="sm"
        />
        <button
          type="button"
          class="tool-button primary"
          data-test="apply"
          :disabled="!!applyBlocked"
          v-tooltip="{ text: t.shell.stepSequencer.applyToClipTitle, reason: applyBlocked }"
          @click="applyToClip"
        >
          {{ t.shell.stepSequencer.applyToClip }}
        </button>
        <button
          type="button"
          class="tool-button"
          data-test="pull"
          :disabled="!!pullBlocked"
          v-tooltip="{ text: t.shell.stepSequencer.pullFromClipTitle, reason: pullBlocked }"
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
      :playing-step="playingStep"
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
        v-tooltip="t.shell.stepSequencer.accessibility.paramNames[kind]"
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

.tool-group + .tool-group {
  padding-left: var(--sp-5);
  box-shadow: inset 1px 0 0 var(--border);
}

.tool-group-apply {
  margin-left: auto;
}

/* A number field and the action that consumes it read as one unit. */
.tool-pair {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
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
  box-shadow: var(--field-edge), var(--inset-well);
  width: 3.5rem;
}

.tool-number-short {
  width: 2.75rem;
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
  box-shadow: inset 0 0 0 1px var(--border);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-1) var(--ease-out);
}

.tool-button:hover:not(:disabled) {
  background: var(--surface-4);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.tool-button:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Popover trigger: borderless like a toggle, with a caret; lit while open. */
.tool-menu {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  font: inherit;
  white-space: nowrap;
}

.tool-menu.is-open {
  background: var(--surface-selection);
  color: var(--accent);
}

.tool-caret {
  width: 8px;
  height: 8px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.6;
}

.tool-icon {
  padding-inline: var(--sp-2);
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
  animation: view-enter var(--dur-2) var(--ease-out);
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
  transition: color var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
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
