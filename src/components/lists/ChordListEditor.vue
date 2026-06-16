<script setup lang="ts">
import { computed, ref } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  CHORD_PITCH_CLASS_NAMES,
  CHORD_QUALITY_CHOICES,
  type EditorChordSymbol,
  formatChordName,
} from '@/project/chords';
import { clearProjectChords, detectChordsForClip, setProjectChords } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { barLengthPpq, formatBarBeat, parseBarBeat } from './bar-beat';

/** Pitch-class options for the root / slash-bass pickers (value = pitch class). */
const PITCH_CLASS_OPTIONS = CHORD_PITCH_CLASS_NAMES.map((name, pc) => ({
  value: pc,
  label: name,
}));

/** Slash-bass options: "no bass" sentinel (-1) plus the pitch classes. */
const BASS_OPTIONS = [{ value: -1, label: '—' }, ...PITCH_CLASS_OPTIONS];

/** Chord-quality options. */
const QUALITY_OPTIONS = CHORD_QUALITY_CHOICES.map((choice) => ({
  value: choice.quality,
  label: choice.label,
}));

/**
 * Chord-track editor: one row per chord symbol on the project's annotation
 * stream (bars.beats position + root/quality/optional slash bass). The stream
 * has no per-symbol ids, so every edit rebuilds the whole list and commits it
 * through {@link setProjectChords} (one undoable entry per change).
 *
 * "Detect from clip" estimates chords from the active MIDI clip's notes (app
 * -side music theory, not the engine's audio detector) and merges them in;
 * "Add at playhead" inserts a one-bar C major at the transport position.
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to add chords at 1.1 instead. */
  positionPpq?: () => number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const errorMessage = ref('');

/** Active clip id when it is a MIDI clip, else -1 (detection source). */
const detectClipId = computed(() => {
  const clip = store.clips.find((c) => c.id === store.clipId);
  if (!clip || (clip.kind ?? 'midi') !== 'midi') return -1;
  return clip.id;
});

/** Bar length in PPQ at a position, from the active time signature. */
function barLengthAt(ppq: number): number {
  let signature = { numerator: 4, denominator: 4 };
  for (const candidate of store.timeSignatures) {
    if (candidate.startPpq > ppq) break;
    signature = candidate;
  }
  return barLengthPpq(signature);
}

/** Commits a chord list mutated at one index (drop the entry when null). */
function commitAt(index: number, next: EditorChordSymbol | null): void {
  const list = store.chords.map((chord) => ({ ...chord }));
  if (next === null) list.splice(index, 1);
  else list[index] = next;
  setProjectChords(list);
}

function positionText(chord: EditorChordSymbol): string {
  return formatBarBeat(chord.startPpq, store.timeSignatures);
}

/** Commits an edited position, keeping the region length and reverting bad input. */
function onPositionChange(index: number, chord: EditorChordSymbol, event: Event): void {
  const input = event.target as HTMLInputElement;
  const ppq = parseBarBeat(input.value, store.timeSignatures);
  if (ppq === null) {
    errorMessage.value = formatMessage(t.value.shell.lists.chords.invalidPosition, {
      position: input.value,
    });
    input.value = positionText(chord);
    return;
  }
  errorMessage.value = '';
  if (ppq === chord.startPpq) {
    input.value = positionText(chord);
    return;
  }
  const length = Math.max(barLengthAt(ppq), chord.endPpq - chord.startPpq);
  commitAt(index, { ...chord, startPpq: ppq, endPpq: ppq + length });
}

function onRootChange(index: number, chord: EditorChordSymbol, value: number): void {
  commitAt(index, { ...chord, rootPc: value });
}

function onQualityChange(index: number, chord: EditorChordSymbol, value: number): void {
  commitAt(index, { ...chord, quality: value });
}

/** A bass select value of -1 clears the slash bass. */
function onBassChange(index: number, chord: EditorChordSymbol, value: number): void {
  const next = { ...chord };
  if (value < 0 || value === chord.rootPc) delete next.bassPc;
  else next.bassPc = value;
  commitAt(index, next);
}

function onDelete(index: number): void {
  commitAt(index, null);
}

function onSeek(chord: EditorChordSymbol): void {
  emit('seek', chord.startPpq);
}

/** Inserts a one-bar C major at the playhead (or 1.1 without a getter). */
function addAtPlayhead(): void {
  const ppq = Math.max(0, props.positionPpq?.() ?? 0);
  const length = barLengthAt(ppq);
  setProjectChords([
    ...store.chords,
    { startPpq: ppq, endPpq: ppq + length, rootPc: 0, quality: 0 },
  ]);
}

function detectFromClip(): void {
  if (detectClipId.value < 0) return;
  errorMessage.value = '';
  const count = detectChordsForClip(detectClipId.value);
  if (count === 0) {
    errorMessage.value = t.value.shell.lists.chords.noneDetected;
  }
}

function clearAll(): void {
  errorMessage.value = '';
  clearProjectChords();
}
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.seek }}</span></th>
          <th scope="col">{{ t.shell.lists.columns.position }}</th>
          <th scope="col">{{ t.shell.lists.columns.root }}</th>
          <th scope="col">{{ t.shell.lists.columns.quality }}</th>
          <th scope="col">{{ t.shell.lists.columns.bass }}</th>
          <th scope="col">{{ t.shell.lists.columns.chord }}</th>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.actions }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(chord, index) in store.chords" :key="index" class="chord-row">
          <td class="cell-seek">
            <button
              type="button"
              class="row-button"
              :aria-label="
                formatMessage(t.shell.lists.chords.seekTo, { name: formatChordName(chord) })
              "
              @click="onSeek(chord)"
            >
              ▶
            </button>
          </td>
          <td>
            <input
              :value="positionText(chord)"
              class="cell-input cell-position"
              type="text"
              inputmode="decimal"
              :aria-label="
                formatMessage(t.shell.lists.chords.positionOf, { name: formatChordName(chord) })
              "
              @change="onPositionChange(index, chord, $event)"
            />
          </td>
          <td>
            <SelectMenu
              :model-value="chord.rootPc"
              class="cell-input cell-select"
              size="sm"
              :options="PITCH_CLASS_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.rootOf, { row: index + 1 })"
              @change="onRootChange(index, chord, $event)"
            />
          </td>
          <td>
            <SelectMenu
              :model-value="chord.quality"
              class="cell-input cell-select"
              size="sm"
              :options="QUALITY_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.qualityOf, { row: index + 1 })"
              @change="onQualityChange(index, chord, $event)"
            />
          </td>
          <td>
            <SelectMenu
              :model-value="chord.bassPc ?? -1"
              class="cell-input cell-select"
              size="sm"
              :options="BASS_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.bassOf, { row: index + 1 })"
              @change="onBassChange(index, chord, $event)"
            />
          </td>
          <td class="cell-name">{{ formatChordName(chord) }}</td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="
                formatMessage(t.shell.lists.chords.delete, { name: formatChordName(chord) })
              "
              @click="onDelete(index)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="store.chords.length === 0" class="list-empty">{{ t.shell.lists.chords.empty }}</p>
    <p v-if="errorMessage" class="list-error" role="alert">{{ errorMessage }}</p>
    <div class="list-actions">
      <button type="button" @click="addAtPlayhead">{{ t.shell.lists.common.addAtPlayhead }}</button>
      <button type="button" :disabled="detectClipId < 0" @click="detectFromClip">
        {{ t.shell.lists.chords.detectFromClip }}
      </button>
      <button
        type="button"
        class="clear-button"
        :disabled="store.chords.length === 0"
        @click="clearAll"
      >
        {{ t.shell.lists.common.clear }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  font-size: var(--fs-sm);
  color: var(--text-2);
  overflow: auto;
  min-height: 0;
}

.list-table {
  border-collapse: collapse;
  width: 100%;
}

.list-table th {
  text-align: left;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-bottom: 1px solid var(--border);
}

.list-table td {
  padding: 0.12rem 0.4rem 0.12rem 0;
}

.chord-row:hover {
  background: var(--surface-2);
}

/* Layout applies to both native inputs and SelectMenu wrappers sharing this class. */
.cell-input {
  width: 100%;
  box-sizing: border-box;
}

/* The sunken field face is only for real inputs; SelectMenu carries its own face. */
input.cell-input {
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0.15rem 0.3rem;
  box-shadow: var(--control-edge), var(--inset-well);
  transition: box-shadow var(--dur-1) var(--ease-out);
}

input.cell-input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.cell-position {
  width: 5rem;
}

.cell-select {
  width: 4.5rem;
}

.cell-name {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.cell-seek {
  width: 1.6rem;
}

.cell-actions {
  width: 1.6rem;
  text-align: right;
}

.row-button {
  background: none;
  border: none;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: var(--fs-xs);
  transition: color var(--dur-1) var(--ease-out);
}

.row-button:hover {
  color: var(--text-1);
}

.cell-actions .row-button:hover {
  color: var(--danger);
}

.list-empty {
  margin: 0;
  color: var(--text-3);
}

.list-error {
  margin: 0;
  background: var(--danger-surface);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
  padding: 0.25rem 0.5rem;
}

.list-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.clear-button:hover:not(:disabled) {
  color: var(--danger-text);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
