<script setup lang="ts">
import {
  NOTE_ARTICULATIONS,
  NOTE_DYNAMICS,
  NOTE_HAIRPINS,
  NOTE_LINE_SPANS,
  NOTE_ORNAMENTS,
  type NoteArticulation,
  type NoteDynamics,
  type NoteHairpin,
  type NoteLineSpan,
  type NoteOrnament,
  type ScoreNoteAnnotation,
  scoreAnnotationLineSpans,
} from '@/project/annotations';
import type { NoteAnnotationUpdate } from '@/project/commands';
import { useI18n } from '@/ui/i18n';

const props = defineProps<{
  annotation: ScoreNoteAnnotation;
  position: { x: number; y: number };
  slurArmed: boolean;
  hairpinArmed: NoteHairpin | null;
  lineSpanArmed: NoteLineSpan | null;
}>();

const emit = defineEmits<{
  apply: [update: NoteAnnotationUpdate];
  clear: [];
  close: [];
  slurArmedChange: [armed: boolean];
  hairpinArmedChange: [hairpin: NoteHairpin | null];
  lineSpanArmedChange: [lineSpan: NoteLineSpan | null];
}>();

const { t } = useI18n();
const GLISSANDO_LINE_TYPES = ['solid', 'dashed', 'dotted', 'wavy'] as const;

function articulationLabel(value: NoteArticulation): string {
  return t.value.shell.score.annotations[value];
}

function ornamentLabel(value: NoteOrnament): string {
  return t.value.shell.score.annotations[value];
}

function hairpinLabel(value: NoteHairpin): string {
  return t.value.shell.score.annotations[value];
}

function lineSpanLabel(value: NoteLineSpan): string {
  return t.value.shell.score.annotations[value];
}

function hasLineSpan(value: NoteLineSpan): boolean {
  return scoreAnnotationLineSpans(props.annotation).some((span) => span.lineSpan === value);
}

function toggleDynamics(value: NoteDynamics): void {
  emit('apply', { dynamics: props.annotation.dynamics === value ? null : value });
}

function toggleArticulation(value: NoteArticulation): void {
  emit('apply', { articulation: props.annotation.articulation === value ? null : value });
}

function toggleOrnament(value: NoteOrnament): void {
  emit('apply', { ornament: props.annotation.ornament === value ? null : value });
}

function onGlissandoTextChange(event: Event): void {
  emit('apply', { glissandoText: (event.target as HTMLInputElement).value });
}

function toggleStaffOverride(value: 1 | 2): void {
  emit('apply', { staffOverride: props.annotation.staffOverride === value ? null : value });
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
        v-for="o in NOTE_ORNAMENTS"
        :key="o"
        type="button"
        :class="{ active: annotation.ornament === o }"
        :aria-pressed="annotation.ornament === o"
        @click="toggleOrnament(o)"
      >
        {{ ornamentLabel(o) }}
      </button>
    </div>
    <div class="palette-row">
      <button
        v-for="h in NOTE_HAIRPINS"
        :key="h"
        type="button"
        :class="{ active: hairpinArmed === h || annotation.hairpin === h }"
        :aria-pressed="hairpinArmed === h || annotation.hairpin === h"
        v-tooltip="t.shell.score.annotations.hairpinTitle"
        @click="emit('hairpinArmedChange', hairpinArmed === h ? null : h)"
      >
        {{ hairpinArmed === h ? t.shell.score.annotations.hairpinArmed : hairpinLabel(h) }}
      </button>
      <button
        v-if="annotation.hairpinToNoteId !== undefined"
        type="button"
        v-tooltip="t.shell.score.annotations.unhairpinTitle"
        @click="emit('apply', { hairpin: null })"
      >
        {{ t.shell.score.annotations.unhairpin }}
      </button>
    </div>
    <div class="palette-row">
      <button
        v-for="s in NOTE_LINE_SPANS"
        :key="s"
        type="button"
        :class="{ active: lineSpanArmed === s || hasLineSpan(s) }"
        :aria-pressed="lineSpanArmed === s || hasLineSpan(s)"
        v-tooltip="t.shell.score.annotations.lineSpanTitle"
        @click="emit('lineSpanArmedChange', lineSpanArmed === s ? null : s)"
      >
        {{ lineSpanArmed === s ? t.shell.score.annotations.lineSpanArmed : lineSpanLabel(s) }}
      </button>
      <button
        v-if="scoreAnnotationLineSpans(annotation).length > 0"
        type="button"
        v-tooltip="t.shell.score.annotations.unlineSpanTitle"
        @click="emit('apply', { lineSpan: null })"
      >
        {{ t.shell.score.annotations.unlineSpan }}
      </button>
    </div>
    <div v-if="annotation.lineSpan === 'pedal'" class="palette-row">
      <button
        type="button"
        :class="{ active: annotation.pedalStyle !== 'sign' }"
        :aria-pressed="annotation.pedalStyle !== 'sign'"
        @click="emit('apply', { pedalStyle: 'line' })"
      >
        {{ t.shell.score.annotations.pedalLine }}
      </button>
      <button
        type="button"
        :class="{ active: annotation.pedalStyle === 'sign' }"
        :aria-pressed="annotation.pedalStyle === 'sign'"
        @click="emit('apply', { pedalStyle: 'sign' })"
      >
        {{ t.shell.score.annotations.pedalSign }}
      </button>
    </div>
    <div v-if="annotation.lineSpan === 'glissando'" class="palette-row">
      <button
        v-for="lineType in GLISSANDO_LINE_TYPES"
        :key="lineType"
        type="button"
        :class="{ active: (annotation.glissandoLineType ?? 'solid') === lineType }"
        :aria-pressed="(annotation.glissandoLineType ?? 'solid') === lineType"
        @click="emit('apply', { glissandoLineType: lineType })"
      >
        {{ t.shell.score.annotations.glissandoLineTypes[lineType] }}
      </button>
      <input
        class="palette-text"
        type="text"
        :value="annotation.glissandoText ?? ''"
        :placeholder="t.shell.score.annotations.glissandoText"
        :aria-label="t.shell.score.annotations.glissandoText"
        @change="onGlissandoTextChange"
      />
    </div>
    <div class="palette-row">
      <button
        type="button"
        :class="{ active: annotation.staffOverride === 1 }"
        :aria-pressed="annotation.staffOverride === 1"
        v-tooltip="t.shell.score.annotations.staffUpperTitle"
        @click="toggleStaffOverride(1)"
      >
        {{ t.shell.score.annotations.staffUpper }}
      </button>
      <button
        type="button"
        :class="{ active: annotation.staffOverride === 2 }"
        :aria-pressed="annotation.staffOverride === 2"
        v-tooltip="t.shell.score.annotations.staffLowerTitle"
        @click="toggleStaffOverride(2)"
      >
        {{ t.shell.score.annotations.staffLower }}
      </button>
    </div>
    <div class="palette-row">
      <button
        type="button"
        :class="{ active: slurArmed }"
        :aria-pressed="slurArmed"
        v-tooltip="t.shell.score.annotations.slurTitle"
        @click="emit('slurArmedChange', !slurArmed)"
      >
        {{ slurArmed ? t.shell.score.annotations.slurArmed : t.shell.score.annotations.slur }}
      </button>
      <button
        v-if="annotation.slurToNoteId !== undefined"
        type="button"
        v-tooltip="t.shell.score.annotations.unslurTitle"
        @click="emit('apply', { slurToNoteId: null })"
      >
        {{ t.shell.score.annotations.unslur }}
      </button>
      <button type="button" v-tooltip="t.shell.score.annotations.clearTitle" @click="emit('clear')">
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
