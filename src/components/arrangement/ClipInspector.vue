<script setup lang="ts">
import { computed } from 'vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { dbToLinear, peakDb } from '@/lib/db';
import { clampClipFadePpq } from '@/project/clip-fades';
import { setClipFades, setClipGain, setClipLoop } from '@/project/commands';
import { type EditorClip, isAudioClip } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';

/**
 * Compact inspector for the active arrangement clip: edits the clip gain,
 * fade-in / fade-out lengths and loop toggle, plus a
 * re-detect tempo action for warped audio. Every field maps to a realtime
 * engine-honored property (clip gain and fades are applied when the clip is
 * scheduled), so edits here are audible on the next play, not cosmetic.
 *
 * The bar hides itself when no clip is active. Both audio and MIDI clip fades
 * shape the rendered audio.
 */

const props = defineProps<{
  /** The active clip, or null when nothing is selected. */
  clip: EditorClip | null;
  /** True when the owning track plays a frozen render and content is read-only. */
  frozen?: boolean;
}>();

const emit = defineEmits<{
  /** Request a tempo re-analysis of the clip's audio asset. */
  redetectTempo: [clipId: number];
  /** Requests that the owning track return to editable live content. */
  unfreeze: [trackId: number];
}>();

const { t } = useI18n();

/** Lowest gain shown before the field reads as silence ("-inf"). */
const GAIN_FLOOR_DB = -60;

/** True for audio clips, which carry a source tempo. */
const isAudio = computed(() => props.clip !== null && isAudioClip(props.clip));

/** Every field edits the clip, so a frozen track blocks them all. */
const editBlocked = computed(() =>
  firstBlock([props.frozen === true, t.value.reasons.trackFrozen]),
);
const redetectBlocked = computed(() =>
  firstBlock(editBlocked.value, [
    props.clip?.assetId === undefined,
    t.value.shell.arrangement.clipInspector.noMedia,
  ]),
);

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
  const currentIn = props.clip.fadeInPpq ?? 0;
  const currentOut = props.clip.fadeOutPpq ?? 0;
  const fadeIn =
    which === 'in' ? clampClipFadePpq(beats, props.clip.lengthPpq, currentOut) : currentIn;
  const fadeOut =
    which === 'out' ? clampClipFadePpq(beats, props.clip.lengthPpq, currentIn) : currentOut;
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
    <span :key="props.clip.id" class="ci-name" v-tooltip="props.clip.name">{{ props.clip.name }}</span>

    <button
      v-if="props.frozen"
      type="button"
      class="ci-unfreeze"
      v-tooltip="t.shell.arrangement.trackHeader.unfreezeTitle"
      @click="emit('unfreeze', props.clip.trackId)"
    >
      {{ t.shell.arrangement.trackHeader.unfreeze }}
    </button>

    <span class="ci-sep" aria-hidden="true" />

    <label class="ci-field">
      <span class="ci-label">{{ t.shell.arrangement.clipInspector.gain }}</span>
      <input
        class="ci-num"
        type="number"
        step="0.5"
        :value="gainDb === '-inf' ? GAIN_FLOOR_DB : gainDb"
        :disabled="!!editBlocked"
        :aria-label="t.shell.arrangement.clipInspector.gainAria"
        v-tooltip="{ text: t.shell.arrangement.clipInspector.gainTitle, reason: editBlocked }"
        @change="onGainInput"
      />
      <span class="ci-unit">dB</span>
    </label>

    <span class="ci-sep" aria-hidden="true" />

    <label class="ci-field">
      <span class="ci-label">{{ t.shell.arrangement.clipInspector.fadeIn }}</span>
      <input
        class="ci-num"
        type="number"
        min="0"
        step="0.25"
        :value="fadeBeats(props.clip.fadeInPpq)"
        :disabled="!!editBlocked"
        :aria-label="t.shell.arrangement.clipInspector.fadeInAria"
        v-tooltip="{ text: t.shell.arrangement.clipInspector.fadeInTitle, reason: editBlocked }"
        @change="onFadeInput('in', $event)"
      />
      <span class="ci-unit">{{ t.shell.arrangement.clipInspector.beats }}</span>
    </label>
    <label class="ci-field">
      <span class="ci-label">{{ t.shell.arrangement.clipInspector.fadeOut }}</span>
      <input
        class="ci-num"
        type="number"
        min="0"
        step="0.25"
        :value="fadeBeats(props.clip.fadeOutPpq)"
        :disabled="!!editBlocked"
        :aria-label="t.shell.arrangement.clipInspector.fadeOutAria"
        v-tooltip="{ text: t.shell.arrangement.clipInspector.fadeOutTitle, reason: editBlocked }"
        @change="onFadeInput('out', $event)"
      />
      <span class="ci-unit">{{ t.shell.arrangement.clipInspector.beats }}</span>
    </label>

    <span class="ci-sep" aria-hidden="true" />

    <ToggleButton
      class="ci-loop"
      size="sm"
      :model-value="props.clip.loopEnabled"
      :label="t.shell.arrangement.clipInspector.loop"
      :aria-label="t.shell.arrangement.clipInspector.loopAria"
      :title="t.shell.arrangement.clipInspector.loopTitle"
      :reason="editBlocked"
      @update:model-value="onLoopToggle"
    />

    <button
      v-if="isAudio"
      type="button"
      class="ci-redetect"
      v-tooltip="{ text: t.shell.arrangement.clipInspector.redetectTitle, reason: redetectBlocked }"
      :disabled="!!redetectBlocked"
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
  /* Re-keyed per clip: the name fades in to mark the inspector retargeting. */
  animation: ci-name-in var(--dur-2) var(--ease-out);
}

@keyframes ci-name-in {
  from {
    opacity: 0;
  }
}

.ci-field {
  display: inline-flex;
  align-items: baseline;
  gap: var(--sp-2);
  color: var(--text-3);
}

.ci-num {
  box-sizing: border-box;
  width: 4rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ci-num:disabled {
  opacity: 0.55;
}

/* Fixed width keeps "dB" and "beats" fields the same size, so values line up. */
.ci-unit {
  min-width: 2.6em;
  color: var(--text-4);
}

.ci-sep {
  align-self: stretch;
  width: 1px;
  margin: 2px 0;
  background: var(--border);
}

.ci-loop {
  flex: 0 0 auto;
}

.ci-redetect {
  /* Compact face matching the inspector density; lift comes from the button baseline. */
  margin-left: auto;
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  padding: 2px var(--sp-3);
  border-radius: var(--radius-sm);
}
</style>
