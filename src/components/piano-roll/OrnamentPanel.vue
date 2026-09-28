<script setup lang="ts">
import { computed, ref } from 'vue';
import { timeSignatureAtPpq } from '@/compose/meter';
import { ORNAMENT_MARKS, type OrnamentMark, planOrnaments } from '@/compose/ornaments';
import { ornamentClipNotes } from '@/project/commands';
import { partSeed } from '@/project/generation';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Decoration popover for the active MIDI clip: marks its notes with a playing
 * technique the score engraves and an expression map can key-switch.
 *
 * Which notes are eligible follows from the technique and the meter, so a
 * setting that reads well on one passage marks nothing on another — a walking
 * bass has weak positions for ghosts, a whole-note melody does not. The panel
 * therefore plans the pass on every change and shows the count it would write,
 * which is free because the plan writes nothing. Apply is the only destructive
 * step, and it only adds annotations: no note, onset or duration is touched.
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
const store = useProjectStore();

const mark = ref<OrnamentMark>('ghost');
const amount = ref(0.5);

/**
 * Addressed by the clip, so re-running the pass on the same clip decorates the
 * same notes while two clips of the same material do not get the same reading.
 */
const seed = computed(() => partSeed(store.generationSeed, 'ornament', props.clipId));

const clip = computed(() => store.clips.find((entry) => entry.id === props.clipId));

/** What Apply would write, recomputed as the controls move. */
const plan = computed(() => {
  const target = clip.value;
  if (target === undefined) return { marks: [], candidateCount: 0 };
  const marked = new Set(
    Object.entries(store.scoreAnnotations[props.clipId] ?? {})
      .filter(([, annotation]) => annotation.articulation !== undefined)
      .map(([noteId]) => Number(noteId)),
  );
  return planOrnaments(target.notes, {
    mark: mark.value,
    amount: amount.value,
    ts: timeSignatureAtPpq(store.timeSignatures, target.startPpq),
    bpm: store.tempoBpm,
    seed: seed.value,
    keep: marked,
  });
});

const previewSummary = computed(() => {
  const labels = t.value.shell.pianoRoll.ornament;
  if (plan.value.marks.length === 0) return labels.previewNone;
  return formatMessage(labels.preview, {
    marked: plan.value.marks.length,
    total: plan.value.candidateCount,
  });
});

function markLabel(value: OrnamentMark): string {
  return t.value.shell.score.annotations[value];
}

/** Writes the planned marks and closes the panel. */
function apply(): void {
  if (plan.value.marks.length === 0) return;
  ornamentClipNotes(props.clipId, {
    mark: mark.value,
    amount: amount.value,
    bpm: store.tempoBpm,
    seed: seed.value,
  });
  emit('close');
}
</script>

<template>
  <div class="ornament-panel" role="dialog" :aria-label="t.shell.pianoRoll.ornament.label">
    <header class="orn-head">
      <h2 class="orn-title">{{ t.shell.pianoRoll.ornament.title }}</h2>
      <button
        type="button"
        class="orn-close"
        :aria-label="t.shell.pianoRoll.ornament.close"
        @click="emit('close')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <div class="orn-body">
      <div class="orn-preview" aria-live="polite">{{ previewSummary }}</div>
      <div class="orn-marks" role="group" :aria-label="t.shell.pianoRoll.ornament.markGroup">
        <button
          v-for="option in ORNAMENT_MARKS"
          :key="option"
          type="button"
          class="orn-segment"
          :class="{ 'orn-segment-active': mark === option }"
          :aria-pressed="mark === option"
          @click="mark = option"
        >
          {{ markLabel(option) }}
        </button>
      </div>
      <div class="orn-row">
        <label class="orn-label" for="orn-amount">
          {{ t.shell.pianoRoll.ornament.amount }}
        </label>
        <input id="orn-amount" v-model.number="amount" type="range" min="0" max="1" step="0.05" />
        <output class="orn-value">{{ Math.round(amount * 100) }}%</output>
      </div>
    </div>

    <footer class="orn-foot">
      <span class="orn-hint">{{ t.shell.pianoRoll.ornament.hint }}</span>
      <span class="orn-spacer" />
      <button
        type="button"
        class="orn-btn orn-btn-primary"
        :disabled="plan.marks.length === 0"
        @click="apply"
      >
        {{ t.shell.pianoRoll.ornament.apply }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.ornament-panel {
  position: absolute;
  top: calc(100% + var(--sp-2));
  right: var(--sp-3);
  z-index: 40;
  width: 320px;
  max-height: min(480px, calc(100vh - 100px));
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--surface-floating);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-hairline), var(--shadow-pop);
  font-family: var(--font-sans);
  color: var(--text-2);
}

@media (max-height: 900px) {
  .ornament-panel {
    top: auto;
    bottom: calc(100% + var(--sp-2));
    max-height: min(220px, calc(100vh - 100px));
  }
}

.orn-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
}

.orn-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.orn-close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  line-height: 1;
  cursor: pointer;
  padding: var(--sp-1);
  transition: color var(--dur-1) var(--ease-out);
}

.orn-close:hover {
  color: var(--text-1);
}

.orn-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3);
}

.orn-preview {
  padding: var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* A primary picker: every technique gets the same width whatever its label
 * runs to, so the row reads as one control rather than five sized by wording. */
.orn-marks {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-1);
}

/* Inherits the controls.css raised-face baseline; only the compact metrics and
 * surface tint differ from the canonical button. */
.orn-segment {
  min-width: 0;
  padding: 2px var(--sp-1);
  font-size: var(--fs-xs);
  white-space: nowrap;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
}

.orn-segment-active {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: var(--raise-hi), var(--shadow-1);
}

.orn-row {
  display: grid;
  grid-template-columns: 4.5rem 1fr 3rem;
  align-items: center;
  gap: var(--sp-2);
}

.orn-label {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.orn-row input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.orn-value {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text-3);
}

.orn-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.orn-hint {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.orn-spacer {
  flex: 1 1 auto;
}

.orn-btn {
  padding: 2px var(--sp-2);
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
}

.orn-btn-primary {
  background: var(--accent);
  color: var(--accent-text);
}

.orn-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
