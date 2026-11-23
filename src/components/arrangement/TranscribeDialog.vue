<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import { confirmDialog } from '@/composables/useDialogs';
import { describeError, isAbortError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { setActiveClip, transcribeAudioClipToMidi } from '@/project/commands';
import { MAX_TRACK_LANES } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { isAudioClip } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';

type TuningMode = 'concert' | 'auto';
/** Shortest kept note as a `1/n` division; 'auto' keeps the library default. */
type ShortestNote = 'auto' | 8 | 16 | 32;

const SHORTEST_NOTES: readonly ShortestNote[] = ['auto', 8, 16, 32];
/** Most notes one polyphonic frame keeps; 'auto' keeps the library default. */
type MaxVoices = 'auto' | 2 | 4 | 6;

const MAX_VOICES: readonly MaxVoices[] = ['auto', 2, 4, 6];

const props = defineProps<{
  open: boolean;
  clipId: number | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const store = useProjectStore();
const { t } = useI18n();
const mode = ref<'melody' | 'polyphonic'>('melody');
const tuningMode = ref<TuningMode>('concert');
const shortestNote = ref<ShortestNote>('auto');
const maxVoices = ref<MaxVoices>('auto');
const tidy = ref(false);
const matchTempo = ref(false);
const detectedReference = ref('');
const busy = ref(false);
const error = ref('');
const controller = ref<AbortController | null>(null);

const copy = computed(() => t.value.shell.arrangement.transcribe);
const clip = computed(() =>
  props.clipId === null ? null : (store.clips.find((entry) => entry.id === props.clipId) ?? null),
);
/** A warped clip already plays at the project tempo, so there is nothing to match. */
const clipWarped = computed(() => {
  const current = clip.value;
  return current !== null && isAudioClip(current) && current.warp?.enabled === true;
});
/** Every choice is frozen while a transcription runs. */
const runningBlocked = computed(() => firstBlock([busy.value, copy.value.reasons.running]));
/** A note-count limit only applies to polyphonic reading. */
const voicesBlocked = computed(() =>
  firstBlock(runningBlocked.value, [
    mode.value !== 'polyphonic',
    copy.value.reasons.polyphonicOnly,
  ]),
);
const matchTempoBlocked = computed(() =>
  firstBlock(runningBlocked.value, [clipWarped.value, copy.value.reasons.clipWarped]),
);
const runBlocked = computed(() => {
  const current = clip.value;
  return firstBlock(
    runningBlocked.value,
    [current === null || !isAudioClip(current), t.value.reasons.noAudioClip],
    [
      store.tracks.length >= MAX_TRACK_LANES,
      formatMessage(t.value.reasons.trackLimit, { limit: MAX_TRACK_LANES }),
    ],
  );
});
/** Other material whose timing a new project tempo would move. */
const otherContent = computed(() =>
  store.clips.some(
    (entry) => entry.id !== props.clipId && (isAudioClip(entry) || (entry.notes?.length ?? 0) > 0),
  ),
);
const clipRevision = computed(() => {
  const current = clip.value;
  if (!current || !isAudioClip(current)) return null;
  return JSON.stringify({
    id: current.id,
    trackId: current.trackId,
    name: current.name,
    assetId: current.assetId,
    startPpq: current.startPpq,
    lengthPpq: current.lengthPpq,
    sourceOffsetPpq: current.sourceOffsetPpq,
    loopEnabled: current.loopEnabled,
    loopLengthPpq: current.loopLengthPpq,
    fadeInPpq: current.fadeInPpq,
    fadeOutPpq: current.fadeOutPpq,
    takes: current.takes,
    compSegments: current.compSegments,
    warp: current.warp,
  });
});

watch(
  () => props.open,
  (open) => {
    if (!open) {
      abort();
      return;
    }
    mode.value = 'melody';
    tuningMode.value = 'concert';
    shortestNote.value = 'auto';
    maxVoices.value = 'auto';
    tidy.value = false;
    matchTempo.value = false;
    detectedReference.value = '';
    busy.value = false;
    error.value = '';
    controller.value = null;
  },
);

watch(
  () => [props.clipId, store.documentGeneration, clipRevision.value] as const,
  ([clipId, generation, revision], [previousClipId, previousGeneration, previousRevision]) => {
    if (
      busy.value &&
      (clipId !== previousClipId ||
        generation !== previousGeneration ||
        revision !== previousRevision)
    ) {
      abort();
    }
  },
);

function abort(): void {
  controller.value?.abort();
  controller.value = null;
  busy.value = false;
}

function close(): void {
  if (busy.value) abort();
  emit('close');
}

function chooseMode(next: 'melody' | 'polyphonic'): void {
  if (busy.value) return;
  mode.value = next;
  error.value = '';
}

function chooseTuning(next: TuningMode): void {
  if (busy.value) return;
  tuningMode.value = next;
  detectedReference.value = '';
  error.value = '';
}

function chooseShortest(next: ShortestNote): void {
  if (busy.value) return;
  shortestNote.value = next;
  error.value = '';
}

function chooseVoices(next: MaxVoices): void {
  if (voicesBlocked.value) return;
  maxVoices.value = next;
  error.value = '';
}

function voicesTitle(voices: MaxVoices): string {
  return voices === 'auto'
    ? copy.value.voicesAutoTitle
    : formatMessage(copy.value.voicesTitle, { n: voices });
}

function chooseTidy(next: boolean): void {
  if (busy.value) return;
  tidy.value = next;
  error.value = '';
}

function chooseTempo(next: boolean): void {
  if (runningBlocked.value || (next && matchTempoBlocked.value)) return;
  matchTempo.value = next;
  error.value = '';
}

function shortestLabel(note: ShortestNote): string {
  return note === 'auto' ? copy.value.shortestAuto : `1/${note}`;
}

function shortestTitle(note: ShortestNote): string {
  return note === 'auto'
    ? copy.value.shortestAutoTitle
    : formatMessage(copy.value.shortestTitle, { n: note });
}

async function run(): Promise<void> {
  const id = props.clipId;
  if (id === null || runBlocked.value) return;
  const match = matchTempo.value && !clipWarped.value;
  if (match && otherContent.value) {
    const confirmed = await confirmDialog({
      title: copy.value.tempoConfirmTitle,
      message: copy.value.tempoConfirmMessage,
      confirmLabel: copy.value.tempoConfirmAction,
    });
    if (!confirmed || busy.value) return;
  }
  error.value = '';
  detectedReference.value = '';
  busy.value = true;
  const currentController = new AbortController();
  controller.value = currentController;
  try {
    const detect = tuningMode.value === 'auto';
    const polyphonic = mode.value === 'polyphonic';
    let measured: number | undefined;
    const outcome = await transcribeAudioClipToMidi(id, {
      polyphonic,
      signal: currentController.signal,
      ...(shortestNote.value !== 'auto' ? { minNoteDivision: shortestNote.value } : {}),
      ...(polyphonic && maxVoices.value !== 'auto' ? { maxPolyphony: maxVoices.value } : {}),
      tidy: tidy.value,
      matchTempo: match,
      ...(detect
        ? {
            referenceHz: 'auto' as const,
            onTuning: (tuning: number) => {
              measured = tuning;
            },
          }
        : {}),
    });
    if (currentController.signal.aborted) return;
    if (!outcome.created) {
      error.value = copy.value.refused[outcome.reason];
      return;
    }
    setActiveClip(outcome.clipId);
    if (detect && measured !== undefined) {
      // Stay open so the measured reference can be read.
      const wasm = await ensureWasm();
      if (currentController.signal.aborted) return;
      const hz = wasm.tuningToReferenceHz(measured, 440);
      detectedReference.value = formatMessage(copy.value.detectedReference, { hz: hz.toFixed(1) });
      return;
    }
    emit('close');
  } catch (value) {
    if (!currentController.signal.aborted && !isAbortError(value)) {
      error.value = describeError(value, t.value.notices.errors);
    }
  } finally {
    if (controller.value === currentController) {
      controller.value = null;
      busy.value = false;
    }
  }
}

onBeforeUnmount(abort);
</script>

<template>
  <AppModal
    :open="props.open"
    size="md"
    :aria-label="copy.title"
    @close="close"
  >
    <template #title>{{ copy.title }}</template>

    <div class="transcribe-fields">
      <p class="transcribe-description">{{ copy.description }}</p>

      <div class="transcribe-mode" role="radiogroup" v-radiogroup :aria-label="copy.modeLabel">
        <button
          type="button"
          class="transcribe-mode-option"
          :class="{ active: mode === 'melody' }"
          role="radio"
          :aria-checked="mode === 'melody'"
          :disabled="!!runningBlocked"
          v-tooltip="{ reason: runningBlocked }"
          @click="chooseMode('melody')"
        >
          <span class="transcribe-mode-label">{{ copy.melody }}</span>
          <span class="transcribe-mode-description">{{ copy.melodyDescription }}</span>
        </button>
        <button
          type="button"
          class="transcribe-mode-option"
          :class="{ active: mode === 'polyphonic' }"
          role="radio"
          :aria-checked="mode === 'polyphonic'"
          :disabled="!!runningBlocked"
          v-tooltip="{ reason: runningBlocked }"
          @click="chooseMode('polyphonic')"
        >
          <span class="transcribe-mode-label">{{ copy.polyphonic }}</span>
          <span class="transcribe-mode-description">{{ copy.polyphonicDescription }}</span>
        </button>
      </div>

      <div class="transcribe-setting transcribe-tuning">
        <span class="transcribe-setting-label">{{ copy.tuningLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" v-radiogroup :aria-label="copy.tuningLabel">
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tuningMode === 'concert' }"
            role="radio"
            :aria-checked="tuningMode === 'concert'"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: copy.tuningConcertTitle, reason: runningBlocked }"
            @click="chooseTuning('concert')"
          >
            {{ copy.tuningConcert }}
          </button>
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tuningMode === 'auto' }"
            role="radio"
            :aria-checked="tuningMode === 'auto'"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: copy.tuningAutoTitle, reason: runningBlocked }"
            @click="chooseTuning('auto')"
          >
            {{ copy.tuningAuto }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-shortest">
        <span class="transcribe-setting-label">{{ copy.shortestLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" v-radiogroup :aria-label="copy.shortestLabel">
          <button
            v-for="note in SHORTEST_NOTES"
            :key="note"
            type="button"
            class="transcribe-setting-option"
            :class="{ active: shortestNote === note }"
            role="radio"
            :aria-checked="shortestNote === note"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: shortestTitle(note), reason: runningBlocked }"
            @click="chooseShortest(note)"
          >
            {{ shortestLabel(note) }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-voices">
        <span class="transcribe-setting-label">{{ copy.voicesLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" v-radiogroup :aria-label="copy.voicesLabel">
          <button
            v-for="voices in MAX_VOICES"
            :key="voices"
            type="button"
            class="transcribe-setting-option"
            :class="{ active: mode === 'polyphonic' && maxVoices === voices }"
            role="radio"
            :aria-checked="mode === 'polyphonic' && maxVoices === voices"
            :disabled="!!voicesBlocked"
            v-tooltip="{ text: voicesTitle(voices), reason: voicesBlocked }"
            @click="chooseVoices(voices)"
          >
            {{ voices === 'auto' ? copy.voicesAuto : voices }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-tempo">
        <span class="transcribe-setting-label">{{ copy.tempoLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" v-radiogroup :aria-label="copy.tempoLabel">
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: !matchTempo }"
            role="radio"
            :aria-checked="!matchTempo"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: copy.tempoKeepTitle, reason: runningBlocked }"
            @click="chooseTempo(false)"
          >
            {{ copy.tempoKeep }}
          </button>
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: matchTempo }"
            role="radio"
            :aria-checked="matchTempo"
            :disabled="!!matchTempoBlocked"
            v-tooltip="{ text: copy.tempoMatchTitle, reason: matchTempoBlocked }"
            @click="chooseTempo(true)"
          >
            {{ copy.tempoMatch }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-tidy">
        <span class="transcribe-setting-label">{{ copy.tidyLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" v-radiogroup :aria-label="copy.tidyLabel">
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: !tidy }"
            role="radio"
            :aria-checked="!tidy"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: copy.tidyOffTitle, reason: runningBlocked }"
            @click="chooseTidy(false)"
          >
            {{ copy.tidyOff }}
          </button>
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tidy }"
            role="radio"
            :aria-checked="tidy"
            :disabled="!!runningBlocked"
            v-tooltip="{ text: copy.tidyOnTitle, reason: runningBlocked }"
            @click="chooseTidy(true)"
          >
            {{ copy.tidyOn }}
          </button>
        </div>
      </div>

      <div class="transcribe-status">
        <BusyIndicator v-if="busy" :label="copy.transcribing" />
        <p v-else-if="detectedReference" class="transcribe-result" role="status">
          {{ detectedReference }}
        </p>
        <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      </div>
    </div>

    <template #actions>
      <button v-if="detectedReference" type="button" class="primary" @click="close">
        {{ t.common.close }}
      </button>
      <template v-else>
        <button type="button" @click="close">
          {{ busy ? t.common.cancel : t.common.close }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="!!runBlocked"
          v-tooltip="{ reason: runBlocked }"
          @click="run"
        >
          {{ busy ? copy.transcribing : copy.run }}
        </button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.transcribe-fields {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 22rem;
  min-height: 16rem;
}

.transcribe-description,
.transcribe-result,
.dialog-error {
  margin: 0;
  font-size: var(--fs-sm);
}

.transcribe-description {
  color: var(--text-3);
}

/* Pinned to the bottom with a reserved line, so busy/result/error swaps never
 * resize the dialog. */
.transcribe-status {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: auto;
  min-block-size: 1.5rem;
}

.transcribe-result,
.dialog-error {
  animation: view-enter var(--dur-2) var(--ease-out);
}

.transcribe-mode {
  display: flex;
  gap: var(--sp-2);
  width: 100%;
}

.transcribe-setting {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.transcribe-setting-label {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.transcribe-setting-options {
  display: flex;
  gap: var(--sp-2);
  width: 100%;
}

.transcribe-setting-option {
  flex: 1 1 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: none;
  transition:
    background-color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    opacity var(--dur-1) var(--ease-out);
}

.transcribe-setting-option:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-1);
}

.transcribe-setting-option.active {
  color: var(--text-1);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.transcribe-setting-option:disabled {
  cursor: default;
  opacity: 0.56;
}

.transcribe-result {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.transcribe-mode-option {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  min-height: 6rem;
  padding: var(--sp-3);
  text-align: left;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: none;
  transition:
    background-color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    opacity var(--dur-1) var(--ease-out);
}

.transcribe-mode-option:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-1);
}

.transcribe-mode-option.active {
  color: var(--text-1);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
}

.transcribe-mode-option:disabled {
  cursor: default;
  opacity: 0.56;
}

.transcribe-mode-label {
  font-weight: var(--fw-semibold);
}

.transcribe-mode-description {
  color: var(--text-3);
  font-size: var(--fs-2xs);
  line-height: 1.4;
}

.dialog-error {
  color: var(--danger-text);
}
</style>
