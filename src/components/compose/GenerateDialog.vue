<script setup lang="ts">
import type { ProgStyle } from '@libraz/libcantus';
import { computed, ref } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import { generateProgressionCommand } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

/**
 * Chord-progression generator dialog. Collects the generation options and runs
 * {@link generateProgressionCommand} (one undoable edit), then dismisses. The
 * dialog never mutates the store directly beyond that command call.
 */

const props = defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
}>();

const emit = defineEmits<{
  /** The dialog was dismissed (cancel, Escape, overlay, or after generating). */
  close: [];
}>();

const store = useProjectStore();
const { t } = useI18n();

const g = computed(() => t.value.shell.generate.dialog);

const STYLES: ReadonlyArray<{
  id: ProgStyle;
  labelKey: 'styleMinimal' | 'styleDance' | 'styleIdol' | 'styleRock';
}> = [
  { id: 'minimal', labelKey: 'styleMinimal' },
  { id: 'dance', labelKey: 'styleDance' },
  { id: 'idol', labelKey: 'styleIdol' },
  { id: 'rock', labelKey: 'styleRock' },
];

const style = ref<ProgStyle>('idol');
const bars = ref(4);
const seed = ref(0);
const reharmonize = ref(false);
const mode = ref<'replace' | 'append'>('replace');
const error = ref<string | null>(null);

/** Append is only meaningful when a chord track already exists. */
const canAppend = computed(() => store.chords.length > 0);

function onCancel(): void {
  emit('close');
}

function onGenerate(): void {
  error.value = null;
  const barCount = Math.round(bars.value);
  if (!Number.isFinite(barCount) || barCount <= 0) {
    error.value = 'Bars must be a positive number.';
    return;
  }
  try {
    generateProgressionCommand({
      style: style.value,
      bars: barCount,
      seed: Math.round(seed.value) || 0,
      reharmonize: reharmonize.value,
      mode: canAppend.value ? mode.value : 'replace',
    });
    emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    onGenerate();
  }
}
</script>

<template>
  <AppModal
    :open="props.open"
    size="sm"
    :aria-label="g.title"
    @close="onCancel"
    @keydown="onKeydown"
  >
    <template #title>{{ g.title }}</template>

    <div class="generate-fields">
      <span class="field-label">{{ g.style }}</span>
      <div class="segmented" role="radiogroup" :aria-label="g.style">
        <button
          v-for="option in STYLES"
          :key="option.id"
          type="button"
          class="segment"
          :class="{ active: style === option.id }"
          role="radio"
          :aria-checked="style === option.id"
          @click="style = option.id"
        >
          {{ g[option.labelKey] }}
        </button>
      </div>

      <div class="number-row">
        <label class="number-field">
          <span class="field-label">{{ g.bars }}</span>
          <input v-model.number="bars" type="number" min="1" max="64" step="1" class="bars-input" />
        </label>
        <label class="number-field">
          <span class="field-label">{{ g.seed }}</span>
          <input v-model.number="seed" type="number" step="1" class="seed-input" />
        </label>
      </div>

      <label class="check-label">
        <input v-model="reharmonize" type="checkbox" class="reharmonize-input" />
        {{ g.reharmonize }}
      </label>

      <template v-if="canAppend">
        <span class="field-label">{{ g.mode }}</span>
        <div class="segmented" role="radiogroup" :aria-label="g.mode">
          <button
            type="button"
            class="segment"
            :class="{ active: mode === 'replace' }"
            role="radio"
            :aria-checked="mode === 'replace'"
            @click="mode = 'replace'"
          >
            {{ g.modeReplace }}
          </button>
          <button
            type="button"
            class="segment"
            :class="{ active: mode === 'append' }"
            role="radio"
            :aria-checked="mode === 'append'"
            @click="mode = 'append'"
          >
            {{ g.modeAppend }}
          </button>
        </div>
      </template>

      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <button type="button" @click="onCancel">{{ g.cancel }}</button>
      <button type="button" class="primary generate-confirm" @click="onGenerate">
        {{ g.generate }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.generate-fields {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-width: 20rem;
}

.field-label {
  font-size: 0.78rem;
  color: var(--text-muted, #9aa1ad);
}

.segmented {
  display: flex;
  gap: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  overflow: hidden;
}

.segment {
  flex: 1 1 0;
  padding: 0.4rem 0.5rem;
  background: transparent;
  border: none;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text, #cdd2da);
  font-size: 0.82rem;
  cursor: pointer;
}

.segment:last-child {
  border-right: none;
}

.segment.active {
  background: rgba(79, 168, 232, 0.22);
  color: #f3f5f9;
}

.number-row {
  display: flex;
  gap: 0.75rem;
}

.number-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1 1 0;
}

.number-field input {
  width: 100%;
  box-sizing: border-box;
}

.check-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.dialog-error {
  color: #ef4444;
  font-size: 0.8rem;
  margin: 0;
}
</style>
