<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import {
  CHORD_PITCH_CLASS_NAMES,
  CHORD_QUALITY_CHOICES,
  type EditorChordSymbol,
  formatChordName,
} from '@/project/chords';
import {
  clearProjectChords,
  detectChordsForClip,
  detectChordsFromAudioClip,
  setProjectChords,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { barLengthPpq, formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';

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
 * "Detect from clip" fills the track from the active clip: a MIDI clip uses
 * app-side music theory over its notes, while an audio clip runs libsonare's
 * audio chord detector over its source window. "Add at playhead" inserts a
 * one-bar C major at the transport position.
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
/** True while an audio-clip detection is awaiting the engine. */
const isDetecting = ref(false);

/**
 * The active clip's detection kind: 'midi' for MIDI clips, 'audio' for audio
 * clips that carry an asset, or null when nothing detectable is active.
 */
const detectKind = computed<'midi' | 'audio' | null>(() => {
  const clip = store.activeClip;
  if (!clip) return null;
  const kind = clip.kind ?? 'midi';
  if (kind === 'midi') return 'midi';
  if (kind === 'audio' && clip.assetId !== undefined) return 'audio';
  return null;
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

async function detectFromClip(): Promise<void> {
  const clip = store.activeClip;
  const kind = detectKind.value;
  if (!clip || kind === null || isDetecting.value) return;
  errorMessage.value = '';
  try {
    isDetecting.value = true;
    const count =
      kind === 'audio' ? await detectChordsFromAudioClip(clip.id) : detectChordsForClip(clip.id);
    if (count === 0) {
      errorMessage.value = t.value.shell.lists.chords.noneDetected;
    }
  } catch {
    errorMessage.value = t.value.shell.lists.chords.detectFailed;
  } finally {
    isDetecting.value = false;
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
              <ListIcon name="seek" />
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
              <ListIcon name="delete" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <EmptyState v-if="store.chords.length === 0" variant="inline" :message="t.shell.lists.chords.empty" />
    <p v-if="errorMessage" class="list-error" role="alert">{{ errorMessage }}</p>
    <div class="list-actions">
      <button type="button" @click="addAtPlayhead">{{ t.shell.lists.common.addAtPlayhead }}</button>
      <button
        type="button"
        :disabled="detectKind === null || isDetecting"
        v-tooltip="t.shell.lists.chords.detectFromClipTitle"
        @click="detectFromClip"
      >
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

<style scoped src="./lists.css"></style>

<style scoped>
.chord-row:hover {
  background: var(--surface-2);
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

.list-actions {
  flex-wrap: wrap;
}

.clear-button:hover:not(:disabled) {
  color: var(--danger-text);
}
</style>
