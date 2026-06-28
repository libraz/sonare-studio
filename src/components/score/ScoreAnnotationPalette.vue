<script setup lang="ts">
import {
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  type NoteArticulation,
  type NoteDynamics,
  type ScoreNoteAnnotation,
} from '@/project/annotations';
import type { NoteAnnotationUpdate } from '@/project/commands';
import { useI18n } from '@/ui/i18n';

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

const { t } = useI18n();

function articulationLabel(value: NoteArticulation): string {
  return t.value.shell.score.annotations[value];
}

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
    :aria-label="t.shell.score.annotations.label"
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
        {{ articulationLabel(a) }}
      </button>
    </div>
    <div class="palette-row">
      <button
        type="button"
        :class="{ active: slurArmed }"
        :aria-pressed="slurArmed"
        :title="t.shell.score.annotations.slurTitle"
        @click="emit('slurArmedChange', !slurArmed)"
      >
        {{ slurArmed ? t.shell.score.annotations.slurArmed : t.shell.score.annotations.slur }}
      </button>
      <button
        v-if="annotation.slurToNoteId !== undefined"
        type="button"
        :title="t.shell.score.annotations.unslurTitle"
        @click="emit('apply', { slurToNoteId: null })"
      >
        {{ t.shell.score.annotations.unslur }}
      </button>
      <button type="button" :title="t.shell.score.annotations.clearTitle" @click="emit('clear')">
        {{ t.shell.score.annotations.clear }}
      </button>
      <button
        type="button"
        class="palette-close"
        :aria-label="t.shell.score.annotations.close"
        @click="emit('close')"
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path
            d="M4 4l6 6M10 4l-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
