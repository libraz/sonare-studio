<script setup lang="ts">
import {
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  type NoteArticulation,
  type NoteDynamics,
  type ScoreNoteAnnotation,
} from '@/project/annotations';
import type { NoteAnnotationUpdate } from '@/project/commands';

const props = defineProps<{
  annotation: ScoreNoteAnnotation;
  position: { x: number; y: number };
  slurArmed: boolean;
}>();

const emit = defineEmits<{
  apply: [update: NoteAnnotationUpdate];
  clear: [];
  close: [];
  slurArmedChange: [armed: boolean];
}>();

/** Display labels for the articulation palette buttons. */
const ARTICULATION_LABELS: Readonly<Record<NoteArticulation, string>> = {
  staccato: 'Stacc.',
  accent: 'Accent',
  tenuto: 'Ten.',
  marcato: 'Marc.',
};

function toggleDynamics(value: NoteDynamics): void {
  emit('apply', { dynamics: props.annotation.dynamics === value ? null : value });
}

function toggleArticulation(value: NoteArticulation): void {
  emit('apply', { articulation: props.annotation.articulation === value ? null : value });
}
</script>

<template>
  <div
    class="annotation-palette"
    role="dialog"
    aria-label="Note annotations"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
  >
    <div class="palette-row">
      <button
        v-for="d in NOTE_DYNAMICS"
        :key="d"
        type="button"
        class="palette-dynamics"
        :class="{ active: annotation.dynamics === d }"
        :aria-pressed="annotation.dynamics === d"
        @click="toggleDynamics(d)"
      >
        {{ d }}
      </button>
    </div>
    <div class="palette-row">
      <button
        v-for="a in NOTE_ARTICULATIONS"
        :key="a"
        type="button"
        :class="{ active: annotation.articulation === a }"
        :aria-pressed="annotation.articulation === a"
        @click="toggleArticulation(a)"
      >
        {{ ARTICULATION_LABELS[a] }}
      </button>
    </div>
    <div class="palette-row">
      <button
        type="button"
        :class="{ active: slurArmed }"
        :aria-pressed="slurArmed"
        title="Slur to another note: arm, then click the target note in the score"
        @click="emit('slurArmedChange', !slurArmed)"
      >
        {{ slurArmed ? 'Click target…' : 'Slur…' }}
      </button>
      <button
        v-if="annotation.slurToNoteId !== undefined"
        type="button"
        title="Remove the slur starting on this note"
        @click="emit('apply', { slurToNoteId: null })"
      >
        Unslur
      </button>
      <button type="button" title="Remove all annotations of this note" @click="emit('clear')">
        Clear
      </button>
      <button type="button" aria-label="Close annotation palette" @click="emit('close')">×</button>
    </div>
  </div>
</template>
