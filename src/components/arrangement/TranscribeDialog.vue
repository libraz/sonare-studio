<script setup lang="ts">
import { type ComponentPublicInstance, computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import { ensureWasm } from '@/lib/wasm';
import { setActiveClip, transcribeAudioClipToMidi } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { isAudioClip } from '@/project/types';
import { useI18n } from '@/ui/i18n';

type TuningMode = 'concert' | 'auto';
/** Shortest kept note as a `1/n` division; 'auto' keeps the library default. */
type ShortestNote = 'auto' | 8 | 16 | 32;

const SHORTEST_NOTES: readonly ShortestNote[] = ['auto', 8, 16, 32];

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
const tidy = ref(false);
const detectedReference = ref('');
const busy = ref(false);
const error = ref('');
const controller = ref<AbortController | null>(null);
const modeButtons: Record<'melody' | 'polyphonic', HTMLButtonElement | null> = {
  melody: null,
  polyphonic: null,
};
const tuningButtons: Record<TuningMode, HTMLButtonElement | null> = {
  concert: null,
  auto: null,
};
const shortestButtons = new Map<ShortestNote, HTMLButtonElement>();
const tidyButtons: Record<'off' | 'on', HTMLButtonElement | null> = { off: null, on: null };

const copy = computed(() => t.value.shell.arrangement.transcribe);
const clip = computed(() =>
  props.clipId === null ? null : (store.clips.find((entry) => entry.id === props.clipId) ?? null),
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
    tidy.value = false;
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

function onModeKeydown(event: KeyboardEvent, current: 'melody' | 'polyphonic'): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = event.key === 'ArrowLeft' ? 'melody' : 'polyphonic';
  if (next !== current) {
    chooseMode(next);
    if (mode.value === next) void nextTick(() => modeButtons[next]?.focus());
  }
}

function setModeButton(
  name: 'melody' | 'polyphonic',
  element: Element | ComponentPublicInstance | null,
): void {
  modeButtons[name] = element instanceof HTMLButtonElement ? element : null;
}

function chooseTuning(next: TuningMode): void {
  if (busy.value) return;
  tuningMode.value = next;
  detectedReference.value = '';
  error.value = '';
}

function onTuningKeydown(event: KeyboardEvent, current: TuningMode): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = event.key === 'ArrowLeft' ? 'concert' : 'auto';
  if (next !== current) {
    chooseTuning(next);
    if (tuningMode.value === next) void nextTick(() => tuningButtons[next]?.focus());
  }
}

function setTuningButton(
  name: TuningMode,
  element: Element | ComponentPublicInstance | null,
): void {
  tuningButtons[name] = element instanceof HTMLButtonElement ? element : null;
}

function chooseShortest(next: ShortestNote): void {
  if (busy.value) return;
  shortestNote.value = next;
  error.value = '';
}

function onShortestKeydown(event: KeyboardEvent, current: ShortestNote): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const index = SHORTEST_NOTES.indexOf(current) + (event.key === 'ArrowLeft' ? -1 : 1);
  const next = SHORTEST_NOTES[Math.min(SHORTEST_NOTES.length - 1, Math.max(0, index))];
  if (next !== current) {
    chooseShortest(next);
    if (shortestNote.value === next) void nextTick(() => shortestButtons.get(next)?.focus());
  }
}

function setShortestButton(
  name: ShortestNote,
  element: Element | ComponentPublicInstance | null,
): void {
  if (element instanceof HTMLButtonElement) shortestButtons.set(name, element);
  else shortestButtons.delete(name);
}

function chooseTidy(next: boolean): void {
  if (busy.value) return;
  tidy.value = next;
  error.value = '';
}

function onTidyKeydown(event: KeyboardEvent, current: boolean): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = event.key === 'ArrowRight';
  if (next !== current) {
    chooseTidy(next);
    if (tidy.value === next) void nextTick(() => tidyButtons[next ? 'on' : 'off']?.focus());
  }
}

function setTidyButton(
  name: 'off' | 'on',
  element: Element | ComponentPublicInstance | null,
): void {
  tidyButtons[name] = element instanceof HTMLButtonElement ? element : null;
}

function shortestLabel(note: ShortestNote): string {
  return note === 'auto' ? copy.value.shortestAuto : `1/${note}`;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}

async function run(): Promise<void> {
  const id = props.clipId;
  if (id === null || busy.value) return;
  error.value = '';
  detectedReference.value = '';
  busy.value = true;
  const currentController = new AbortController();
  controller.value = currentController;
  try {
    const detect = tuningMode.value === 'auto';
    let measured: number | undefined;
    const newClipId = await transcribeAudioClipToMidi(id, {
      polyphonic: mode.value === 'polyphonic',
      signal: currentController.signal,
      ...(shortestNote.value !== 'auto' ? { minNoteDivision: shortestNote.value } : {}),
      tidy: tidy.value,
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
    if (newClipId < 0) {
      error.value = copy.value.noNotes;
      return;
    }
    setActiveClip(newClipId);
    if (detect && measured !== undefined) {
      // Stay open so the measured reference can be read.
      const wasm = await ensureWasm();
      if (currentController.signal.aborted) return;
      const hz = wasm.tuningToReferenceHz(measured, 440);
      detectedReference.value = copy.value.detectedReference.replace('{hz}', hz.toFixed(1));
      return;
    }
    emit('close');
  } catch (value) {
    if (!currentController.signal.aborted && !isAbortError(value)) {
      error.value = value instanceof Error ? value.message : String(value);
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

      <div class="transcribe-mode" role="radiogroup" :aria-label="copy.modeLabel">
        <button
          type="button"
          class="transcribe-mode-option"
          :class="{ active: mode === 'melody' }"
          role="radio"
          :aria-checked="mode === 'melody'"
          :tabindex="mode === 'melody' ? 0 : -1"
          :ref="(element) => setModeButton('melody', element)"
          :disabled="busy"
          @click="chooseMode('melody')"
          @keydown="onModeKeydown($event, 'melody')"
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
          :tabindex="mode === 'polyphonic' ? 0 : -1"
          :ref="(element) => setModeButton('polyphonic', element)"
          :disabled="busy"
          @click="chooseMode('polyphonic')"
          @keydown="onModeKeydown($event, 'polyphonic')"
        >
          <span class="transcribe-mode-label">{{ copy.polyphonic }}</span>
          <span class="transcribe-mode-description">{{ copy.polyphonicDescription }}</span>
        </button>
      </div>

      <div class="transcribe-setting transcribe-tuning">
        <span class="transcribe-setting-label">{{ copy.tuningLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" :aria-label="copy.tuningLabel">
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tuningMode === 'concert' }"
            role="radio"
            :aria-checked="tuningMode === 'concert'"
            :tabindex="tuningMode === 'concert' ? 0 : -1"
            :ref="(element) => setTuningButton('concert', element)"
            :disabled="busy"
            @click="chooseTuning('concert')"
            @keydown="onTuningKeydown($event, 'concert')"
          >
            {{ copy.tuningConcert }}
          </button>
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tuningMode === 'auto' }"
            role="radio"
            :aria-checked="tuningMode === 'auto'"
            :tabindex="tuningMode === 'auto' ? 0 : -1"
            :ref="(element) => setTuningButton('auto', element)"
            :disabled="busy"
            @click="chooseTuning('auto')"
            @keydown="onTuningKeydown($event, 'auto')"
          >
            {{ copy.tuningAuto }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-shortest">
        <span class="transcribe-setting-label">{{ copy.shortestLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" :aria-label="copy.shortestLabel">
          <button
            v-for="note in SHORTEST_NOTES"
            :key="note"
            type="button"
            class="transcribe-setting-option"
            :class="{ active: shortestNote === note }"
            role="radio"
            :aria-checked="shortestNote === note"
            :tabindex="shortestNote === note ? 0 : -1"
            :ref="(element) => setShortestButton(note, element)"
            :disabled="busy"
            :title="note === 'auto' ? copy.shortestAutoTitle : undefined"
            @click="chooseShortest(note)"
            @keydown="onShortestKeydown($event, note)"
          >
            {{ shortestLabel(note) }}
          </button>
        </div>
      </div>

      <div class="transcribe-setting transcribe-tidy">
        <span class="transcribe-setting-label">{{ copy.tidyLabel }}</span>
        <div class="transcribe-setting-options" role="radiogroup" :aria-label="copy.tidyLabel">
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: !tidy }"
            role="radio"
            :aria-checked="!tidy"
            :tabindex="tidy ? -1 : 0"
            :ref="(element) => setTidyButton('off', element)"
            :disabled="busy"
            @click="chooseTidy(false)"
            @keydown="onTidyKeydown($event, false)"
          >
            {{ copy.tidyOff }}
          </button>
          <button
            type="button"
            class="transcribe-setting-option"
            :class="{ active: tidy }"
            role="radio"
            :aria-checked="tidy"
            :tabindex="tidy ? 0 : -1"
            :ref="(element) => setTidyButton('on', element)"
            :disabled="busy"
            :title="copy.tidyOnTitle"
            @click="chooseTidy(true)"
            @keydown="onTidyKeydown($event, true)"
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
        {{ copy.close }}
      </button>
      <template v-else>
        <button type="button" @click="close">
          {{ busy ? copy.cancel : copy.close }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="busy || clip === null || !isAudioClip(clip)"
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
