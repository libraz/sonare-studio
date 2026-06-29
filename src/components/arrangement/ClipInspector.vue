<script setup lang="ts">
import { computed } from 'vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { dbToLinear, peakDb } from '@/lib/db';
import { setClipFades, setClipGain, setClipLoop } from '@/project/commands';
import { type EditorClip, isAudioClip } from '@/project/types';
import { useI18n } from '@/ui/i18n';

/**
 * Compact inspector for the active arrangement clip: edits the clip gain,
 * fade-in / fade-out lengths (audio clips only) and loop toggle, plus a
 * re-detect tempo action for warped audio. Every field maps to a realtime
 * engine-honored property (clip gain and fades are applied when the clip is
 * scheduled), so edits here are audible on the next play, not cosmetic.
 *
 * The bar hides itself when no clip is active; fade fields appear only for
 * audio clips, where the engine renders fades.
 */

const props = defineProps<{
  /** The active clip, or null when nothing is selected. */
  clip: EditorClip | null;
}>();

const emit = defineEmits<{
  /** Request a tempo re-analysis of the clip's audio asset. */
  redetectTempo: [clipId: number];
}>();

const { t } = useI18n();

/** Lowest gain shown before the field reads as silence ("-inf"). */
const GAIN_FLOOR_DB = -60;

/** True for audio clips, which carry fades and a source tempo. */
const isAudio = computed(() => props.clip !== null && isAudioClip(props.clip));

/** The clip gain expressed in dB ('-inf' below the floor). */
const gainDb = computed<string>(() => {
  const gain = props.clip?.gain ?? 1;
  if (gain <= 0) return '-inf';
  const db = peakDb(gain);
  return db <= GAIN_FLOOR_DB ? '-inf' : db.toFixed(1);
});

/** Quarter-note units carry one beat per unit, so fades read directly in beats. */
function fadeBeats(ppq: number | undefined): number {
  return ppq ?? 0;
}

function onGainInput(event: Event): void {
  if (!props.clip) return;
  const db = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(db)) return;
  // At or below the floor the clip is silenced (linear gain 0), matching how a
  // fader bottoms out to -inf.
  setClipGain(props.clip.id, db <= GAIN_FLOOR_DB ? 0 : dbToLinear(db));
}

function onFadeInput(which: 'in' | 'out', event: Event): void {
  if (!props.clip) return;
  const beats = Math.max(0, Number((event.target as HTMLInputElement).value));
  if (!Number.isFinite(beats)) return;
  const limit = Math.max(0, props.clip.lengthPpq);
  const length = Math.min(beats, limit);
  const fadeIn = which === 'in' ? length : props.clip.fadeInPpq;
  const fadeOut = which === 'out' ? length : props.clip.fadeOutPpq;
  setClipFades(props.clip.id, fadeIn, fadeOut);
}

function onLoopToggle(): void {
  if (!props.clip) return;
  setClipLoop(props.clip.id, !props.clip.loopEnabled);
}
</script>

<template>
  <Transition name="fade">
  <div v-if="props.clip" class="clip-inspector" :aria-label="t.shell.arrangement.clipInspector.label">
    <span class="ci-name" v-tooltip="props.clip.name">{{ props.clip.name }}</span>

    <label class="ci-field">
      {{ t.shell.arrangement.clipInspector.gain }}
      <input
        class="ci-num"
        type="number"
        step="0.5"
        :value="gainDb === '-inf' ? GAIN_FLOOR_DB : gainDb"
        :aria-label="t.shell.arrangement.clipInspector.gainAria"
        @change="onGainInput"
      />
      <span class="ci-unit">dB</span>
    </label>

    <template v-if="isAudio">
      <label class="ci-field">
        {{ t.shell.arrangement.clipInspector.fadeIn }}
        <input
          class="ci-num"
          type="number"
          min="0"
          step="0.25"
          :value="fadeBeats(props.clip.fadeInPpq)"
          :aria-label="t.shell.arrangement.clipInspector.fadeInAria"
          @change="onFadeInput('in', $event)"
        />
        <span class="ci-unit">{{ t.shell.arrangement.clipInspector.beats }}</span>
      </label>
      <label class="ci-field">
        {{ t.shell.arrangement.clipInspector.fadeOut }}
        <input
          class="ci-num"
          type="number"
          min="0"
          step="0.25"
          :value="fadeBeats(props.clip.fadeOutPpq)"
          :aria-label="t.shell.arrangement.clipInspector.fadeOutAria"
          @change="onFadeInput('out', $event)"
        />
        <span class="ci-unit">{{ t.shell.arrangement.clipInspector.beats }}</span>
      </label>
    </template>

    <ToggleButton
      class="ci-loop"
      size="sm"
      :model-value="props.clip.loopEnabled"
      :label="t.shell.arrangement.clipInspector.loop"
      :aria-label="t.shell.arrangement.clipInspector.loopAria"
      @update:model-value="onLoopToggle"
    />

    <button
      v-if="isAudio"
      type="button"
      class="ci-redetect"
      v-tooltip="t.shell.arrangement.clipInspector.redetectTitle"
      @click="emit('redetectTempo', props.clip.id)"
    >
      {{ t.shell.arrangement.clipInspector.redetect }}
    </button>
  </div>
  </Transition>
</template>

<style scoped>
.clip-inspector {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex: 0 0 auto;
  padding: var(--sp-2) var(--sp-4);
  background: var(--surface-2);
  border-top: 1px solid var(--border-strong);
  color: var(--text-2);
  font: var(--fs-sm)/1.2 var(--font-sans);
  overflow-x: auto;
  white-space: nowrap;
}

.ci-name {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ci-field {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--text-3);
}

.ci-num {
  width: 4.5rem;
  font-variant-numeric: tabular-nums;
}

.ci-unit {
  color: var(--text-4);
}

.ci-loop {
  flex: 0 0 auto;
}

.ci-redetect {
  /* Compact face matching the inspector density; lift comes from the button baseline. */
  margin-left: auto;
  font: var(--fw-semibold) 10px var(--font-sans);
  padding: 2px var(--sp-3);
  border-radius: var(--radius-sm);
}
</style>
