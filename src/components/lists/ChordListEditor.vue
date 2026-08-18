<script setup lang="ts">
import { chordToRoman, type ProgStyle } from '@libraz/libcantus';
import { computed, ref, watch } from 'vue';
import ProgressionPresetPicker from '@/components/compose/ProgressionPresetPicker.vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { confirmDialog } from '@/composables/useDialogs';
import { useNoteNames } from '@/composables/useNoteNames';
import { editorChordToChord } from '@/compose/chord-io';
import { effectiveKeyScale } from '@/compose/key';
import { detectProgressionGroups, type PatternGroup } from '@/compose/progression-groups';
import { reharmCandidatesFor } from '@/compose/reharm';
import {
  canTonicizeWithSecondaryDominant,
  secondaryDominantLabel,
} from '@/compose/secondary-dominant';
import { CHORD_QUALITY_CHOICES, type EditorChordSymbol, formatChordName } from '@/project/chords';
import {
  arrangementMelodyPitchClasses,
  clearProjectChords,
  detectChordsForClip,
  detectChordsFromAudioClip,
  estimateChordsFromArrangement,
  generateProgressionCommand,
  insertSecondaryDominantBefore,
  reharmonizeChord,
  setProjectChords,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import { barLengthPpq, formatBarBeat, fractionalBarsBetween, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';

/** Chord-quality options. */
const QUALITY_OPTIONS = CHORD_QUALITY_CHOICES.map((choice) => ({
  value: qualityChoiceKey(choice),
  label: choice.label,
}));

/** Stable select-menu key for a quality and its optional color tones. */
function qualityChoiceKey(choice: { quality: number; extensions?: ReadonlyArray<number> }): string {
  return `${choice.quality}:${choice.extensions?.join(',') ?? ''}`;
}

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
const { pitchClassNames, system: noteNameSystem } = useNoteNames();

/** Pitch-class options for the root / slash-bass pickers (value = pitch class). */
const PITCH_CLASS_OPTIONS = computed(() =>
  pitchClassNames.value.map((name, pc) => ({ value: pc, label: name })),
);

/** Slash-bass options: "no bass" sentinel (-1) plus the pitch classes. */
const BASS_OPTIONS = computed(() => [{ value: -1, label: '—' }, ...PITCH_CLASS_OPTIONS.value]);

const errorMessage = ref('');
/** True while an audio-clip detection is awaiting the engine. */
const isDetecting = ref(false);
/** True while an arrangement-wide progression estimate is running. */
const isEstimating = ref(false);

/** Confidence below which an estimated chord row is shown as tentative. */
const LOW_CONFIDENCE = 0.55;

/**
 * Confidence in [0, 1] for chords produced by the last progression estimate,
 * keyed by start PPQ. Populated by {@link estimateProgression}; cleared on any
 * manual edit so hand-entered chords are never dimmed.
 */
const estimateConfidence = ref(new Map<number, number>());

/** True when a chord row is a low-confidence estimate that should read faintly. */
function isTentative(chord: EditorChordSymbol): boolean {
  const confidence = estimateConfidence.value.get(chord.startPpq);
  return confidence !== undefined && confidence < LOW_CONFIDENCE;
}

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
  estimateConfidence.value = new Map();
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

function qualityChoiceKeyFor(chord: EditorChordSymbol): string {
  return qualityChoiceKey(chord);
}

function onQualityChange(index: number, chord: EditorChordSymbol, value: string): void {
  const choice = CHORD_QUALITY_CHOICES.find((candidate) => qualityChoiceKey(candidate) === value);
  if (choice === undefined) return;
  const next: EditorChordSymbol = { ...chord, quality: choice.quality };
  if (choice.extensions === undefined || choice.extensions.length === 0) delete next.extensions;
  else next.extensions = [...choice.extensions];
  commitAt(index, next);
}

/** A bass select value of -1 clears the slash bass. */
function onBassChange(index: number, chord: EditorChordSymbol, value: number): void {
  const next = { ...chord };
  if (value < 0 || value === chord.rootPc) delete next.bassPc;
  else next.bassPc = value;
  commitAt(index, next);
}

function onDelete(index: number): void {
  if (reharmIndex.value === index) reharmIndex.value = null;
  commitAt(index, null);
}

/** Tooltip naming the secondary dominant that would be inserted before a chord. */
function insertDominantTooltip(chord: EditorChordSymbol): string {
  const label = secondaryDominantLabel(chord, effectiveKeyScale(store.scaleHighlight));
  return formatMessage(t.value.shell.lists.chords.insertDominantTitle, { label });
}

/** Inserts the secondary dominant of a chord before it (see {@link insertSecondaryDominantBefore}). */
function onInsertDominant(index: number): void {
  if (!canTonicizeWithSecondaryDominant(store.chords[index])) return;
  estimateConfidence.value = new Map();
  reharmIndex.value = null;
  const inserted = insertSecondaryDominantBefore(index);
  errorMessage.value = inserted ? '' : t.value.shell.lists.chords.insertDominantTooShort;
}

/** Whether a key is set; roman numerals and reharmonization need one to be meaningful. */
const keySet = computed(() => store.scaleHighlight.enabled);
const chordKeyFifths = computed(() => keyFifthsForScaleHighlight(store.scaleHighlight));

/** Formats symbols with the same accidental convention as the score. */
function chordName(chord: EditorChordSymbol): string {
  return formatChordName(chord, chordKeyFifths.value, noteNameSystem.value);
}

/**
 * Roman-numeral degree label for a chord in the prevailing key, or blank when no
 * key is set — a degree read against the silent C-major fallback would be wrong.
 */
function romanFor(chord: EditorChordSymbol): string {
  if (!keySet.value) return '';
  return chordToRoman(editorChordToChord(chord), effectiveKeyScale(store.scaleHighlight));
}

/** Repeating-pattern groups detected in the current chord track (see {@link detectProgressionGroups}). */
const patternGroups = computed(() => detectProgressionGroups(store.chords));

/** Group start indices collapsed to their first repeat. */
const collapsedGroups = ref(new Set<number>());

function toggleGroupCollapse(startIndex: number): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(startIndex)) next.delete(startIndex);
  else next.add(startIndex);
  collapsedGroups.value = next;
}

/** A chord row, optionally tagged with the group it belongs to and its repeat position. */
interface ChordRowItem {
  kind: 'chord';
  index: number;
  chord: EditorChordSymbol;
  groupStartIndex: number | null;
  repeatLabel: string | null;
}

/** A collapsible header row introducing a detected repeating pattern. */
interface GroupHeaderRowItem {
  kind: 'group-header';
  group: PatternGroup;
}

type RowItem = ChordRowItem | GroupHeaderRowItem;

/**
 * The list's row sequence: chord rows interleaved with collapsible group
 * headers for detected repeating patterns. Collapsing a group hides every
 * repeat after the first.
 */
const rowItems = computed<RowItem[]>(() => {
  const groupByStart = new Map(patternGroups.value.map((group) => [group.startIndex, group]));
  const items: RowItem[] = [];
  let i = 0;
  while (i < store.chords.length) {
    const group = groupByStart.get(i);
    if (!group) {
      items.push({
        kind: 'chord',
        index: i,
        chord: store.chords[i],
        groupStartIndex: null,
        repeatLabel: null,
      });
      i += 1;
      continue;
    }
    items.push({ kind: 'group-header', group });
    const collapsed = collapsedGroups.value.has(group.startIndex);
    const visible = collapsed ? group.period : group.length;
    for (let k = 0; k < visible; k++) {
      const isFullRepeat = k < group.repeatCount * group.period;
      const repeatLabel =
        isFullRepeat && k % group.period === 0
          ? formatMessage(t.value.shell.lists.chords.repeatOf, {
              n: Math.floor(k / group.period) + 1,
              count: group.repeatCount,
            })
          : null;
      items.push({
        kind: 'chord',
        index: i + k,
        chord: store.chords[i + k],
        groupStartIndex: group.startIndex,
        repeatLabel,
      });
    }
    i += group.length;
  }
  return items;
});

/**
 * Range selection for progression-level replacement: chord indices the user
 * has picked, either by clicking checkboxes (shift-click extends from the
 * last-clicked index) or via a group header's "select this pattern" action.
 */
const selectedIndices = ref<Set<number>>(new Set());
const selectionAnchor = ref<number | null>(null);

/** Toggles or range-extends the selection from a row checkbox click. */
function onSelectClick(index: number, event: MouseEvent): void {
  const next = new Set(selectedIndices.value);
  if (event.shiftKey && selectionAnchor.value !== null) {
    const [lo, hi] =
      selectionAnchor.value <= index
        ? [selectionAnchor.value, index]
        : [index, selectionAnchor.value];
    for (let i = lo; i <= hi; i++) next.add(i);
  } else {
    if (next.has(index)) next.delete(index);
    else next.add(index);
    selectionAnchor.value = index;
  }
  selectedIndices.value = next;
}

/** Selects every chord in a detected group, including any collapsed repeats. */
function selectGroup(group: PatternGroup): void {
  const next = new Set<number>();
  for (let i = group.startIndex; i < group.startIndex + group.length; i++) next.add(i);
  selectedIndices.value = next;
  selectionAnchor.value = group.startIndex;
}

function clearSelection(): void {
  selectedIndices.value = new Set();
  selectionAnchor.value = null;
}

/** The selected chords in track order. */
const selectedChords = computed(() =>
  [...selectedIndices.value]
    .sort((a, b) => a - b)
    .map((i) => store.chords[i])
    .filter((chord): chord is EditorChordSymbol => chord !== undefined),
);

/** PPQ span covering every selected chord (regeneration replaces this whole span). */
const selectionRangePpq = computed(() => {
  if (selectedChords.value.length === 0) return null;
  const startPpq = Math.min(...selectedChords.value.map((c) => c.startPpq));
  const endPpq = Math.max(...selectedChords.value.map((c) => c.endPpq));
  return { startPpq, endPpq };
});

const rangeStyle = ref<ProgStyle>('idol');
const rangePreset = ref('');
const rangeBars = ref(4);

// Re-seed the bar count from the selection's own width whenever it changes,
// so the field starts at a sensible value but stays user-editable afterward.
// Uses the active meter (not a fixed 4 beats/bar) so 3/4, 6/8, etc. seed right.
watch(selectionRangePpq, (range) => {
  if (range) {
    rangeBars.value = Math.max(
      1,
      Math.round(fractionalBarsBetween(range.startPpq, range.endPpq, store.timeSignatures)),
    );
  }
});

/** Regenerates the selected range with the chosen style/preset, then clears the selection. */
function applyToSelection(): void {
  const range = selectionRangePpq.value;
  if (!range) return;
  estimateConfidence.value = new Map();
  generateProgressionCommand({
    style: rangeStyle.value,
    presetId: rangePreset.value || undefined,
    bars: Math.max(1, Math.round(rangeBars.value)),
    seed: 0,
    mode: 'range',
    startPpq: range.startPpq,
  });
  clearSelection();
}

/** Index of the chord whose reharmonization palette is open, or null. */
const reharmIndex = ref<number | null>(null);

/**
 * Substitute candidates for the chord whose palette is currently open. Empty
 * without a key: substitutes are chosen relative to the key, so offering
 * C-major-based ones under an unset key would mislead (see {@link keySet}).
 */
const reharmCandidates = computed(() => {
  const index = reharmIndex.value;
  if (index === null || !keySet.value) return [];
  const chord = store.chords[index];
  if (!chord) return [];
  // Constrain to substitutes that keep the melody sounding over this chord as a
  // chord tone; without this the "safe" palette can create clashes under a
  // sustained melody note.
  const melodyPcs = arrangementMelodyPitchClasses(chord.startPpq, chord.endPpq);
  return reharmCandidatesFor(
    chord,
    effectiveKeyScale(store.scaleHighlight),
    melodyPcs.length > 0 ? melodyPcs : undefined,
  );
});

/** Opens (or closes) the reharmonization palette for a chord row. */
function toggleReharm(index: number): void {
  reharmIndex.value = reharmIndex.value === index ? null : index;
}

/** Replaces the open chord with the chosen substitute and closes the palette. */
function applyReharm(candidate: (typeof reharmCandidates.value)[number]): void {
  const index = reharmIndex.value;
  if (index === null) return;
  reharmonizeChord(index, candidate);
  reharmIndex.value = null;
}

function onSeek(chord: EditorChordSymbol): void {
  emit('seek', chord.startPpq);
}

/** Inserts a one-bar C major at the playhead (or 1.1 without a getter). */
function addAtPlayhead(): void {
  estimateConfidence.value = new Map();
  const ppq = Math.max(0, props.positionPpq?.() ?? 0);
  const length = barLengthAt(ppq);
  setProjectChords([
    ...store.chords,
    { startPpq: ppq, endPpq: ppq + length, rootPc: 0, quality: 0 },
  ]);
}

/**
 * Infers a chord progression from the notes across all tracks and writes it to
 * the chord track. Confirms first when the project already has chords (the
 * estimate replaces them), and dims low-confidence rows afterwards.
 */
async function estimateProgression(): Promise<void> {
  if (isEstimating.value) return;
  errorMessage.value = '';
  if (store.chords.length > 0) {
    const proceed = await confirmDialog({
      title: t.value.shell.lists.chords.estimateReplaceTitle,
      message: formatMessage(t.value.shell.lists.chords.estimateReplaceConfirm, {
        count: store.chords.length,
      }),
      confirmLabel: t.value.shell.lists.chords.estimateReplaceOk,
    });
    if (!proceed) return;
  }
  try {
    isEstimating.value = true;
    const summary = estimateChordsFromArrangement();
    if (summary.count === 0) {
      errorMessage.value = t.value.shell.lists.chords.noneEstimated;
      estimateConfidence.value = new Map();
      return;
    }
    estimateConfidence.value = new Map(summary.confidenceByStartPpq);
  } finally {
    isEstimating.value = false;
  }
}

async function detectFromClip(): Promise<void> {
  const clip = store.activeClip;
  const kind = detectKind.value;
  if (!clip || kind === null || isDetecting.value) return;
  errorMessage.value = '';
  estimateConfidence.value = new Map();
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
  estimateConfidence.value = new Map();
  clearProjectChords();
}
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.chords.selectColumn }}</span></th>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.seek }}</span></th>
          <th scope="col">{{ t.shell.lists.columns.position }}</th>
          <th scope="col">{{ t.shell.lists.columns.root }}</th>
          <th scope="col">{{ t.shell.lists.columns.quality }}</th>
          <th scope="col">{{ t.shell.lists.columns.bass }}</th>
          <th scope="col">{{ t.shell.lists.columns.chord }}</th>
          <th scope="col">{{ t.shell.lists.columns.degree }}</th>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.actions }}</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="item in rowItems" :key="item.kind === 'group-header' ? `group-${item.group.startIndex}` : `chord-${item.index}`">
        <tr v-if="item.kind === 'group-header'" class="group-header-row">
          <td colspan="9">
            <button
              type="button"
              class="group-toggle"
              :aria-expanded="!collapsedGroups.has(item.group.startIndex)"
              :aria-label="
                collapsedGroups.has(item.group.startIndex)
                  ? t.shell.lists.chords.expandPattern
                  : t.shell.lists.chords.collapsePattern
              "
              @click="toggleGroupCollapse(item.group.startIndex)"
            >
              <svg
                class="group-chevron"
                :class="{ 'is-open': !collapsedGroups.has(item.group.startIndex) }"
                viewBox="0 0 8 8"
                width="8"
                height="8"
                aria-hidden="true"
              >
                <path d="M2 1l4 3-4 3z" fill="currentColor" />
              </svg>
              <span class="group-label">
                {{ formatMessage(t.shell.lists.chords.patternGroup, { count: item.group.repeatCount }) }}
              </span>
              <span v-if="item.group.partialTrailingRepeat" class="group-partial">
                {{ t.shell.lists.chords.patternGroupPartial }}
              </span>
            </button>
            <button type="button" class="group-select" @click="selectGroup(item.group)">
              {{ t.shell.lists.chords.selectGroup }}
            </button>
          </td>
        </tr>
        <template v-else>
        <tr
          class="chord-row"
          :class="{
            tentative: isTentative(item.chord),
            'in-group': item.groupStartIndex !== null,
            selected: selectedIndices.has(item.index),
          }"
          v-tooltip="isTentative(item.chord) ? t.shell.lists.chords.tentativeTitle : undefined"
        >
          <td class="cell-checkbox">
            <input
              type="checkbox"
              :checked="selectedIndices.has(item.index)"
              :aria-label="
                formatMessage(t.shell.lists.chords.selectRow, { name: chordName(item.chord) })
              "
              @click="onSelectClick(item.index, $event)"
            />
          </td>
          <td class="cell-seek">
            <button
              type="button"
              class="row-button"
              :aria-label="
                formatMessage(t.shell.lists.chords.seekTo, { name: chordName(item.chord) })
              "
              @click="onSeek(item.chord)"
            >
              <ListIcon name="seek" />
            </button>
          </td>
          <td>
            <div class="cell-position-wrap">
              <span v-if="item.repeatLabel" class="repeat-badge">{{ item.repeatLabel }}</span>
              <input
                :value="positionText(item.chord)"
                class="cell-input cell-position"
                type="text"
                inputmode="decimal"
                :aria-label="
                  formatMessage(t.shell.lists.chords.positionOf, { name: chordName(item.chord) })
                "
                @change="onPositionChange(item.index, item.chord, $event)"
              />
            </div>
          </td>
          <td>
            <SelectMenu
              :model-value="item.chord.rootPc"
              class="cell-input cell-select"
              size="sm"
              :options="PITCH_CLASS_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.rootOf, { row: item.index + 1 })"
              @change="onRootChange(item.index, item.chord, $event)"
            />
          </td>
          <td>
            <SelectMenu
              :model-value="qualityChoiceKeyFor(item.chord)"
              class="cell-input cell-select"
              size="sm"
              :options="QUALITY_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.qualityOf, { row: item.index + 1 })"
              @change="onQualityChange(item.index, item.chord, $event)"
            />
          </td>
          <td>
            <SelectMenu
              :model-value="item.chord.bassPc ?? -1"
              class="cell-input cell-select"
              size="sm"
              :options="BASS_OPTIONS"
              :aria-label="formatMessage(t.shell.lists.chords.bassOf, { row: item.index + 1 })"
              @change="onBassChange(item.index, item.chord, $event)"
            />
          </td>
          <td class="cell-name">{{ chordName(item.chord) }}</td>
          <td class="cell-roman">{{ romanFor(item.chord) }}</td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              v-tooltip="insertDominantTooltip(item.chord)"
              :aria-label="
                formatMessage(t.shell.lists.chords.insertDominant, { name: chordName(item.chord) })
              "
              :disabled="!canTonicizeWithSecondaryDominant(item.chord)"
              @click="onInsertDominant(item.index)"
            >
              <ListIcon name="insertDominant" />
            </button>
            <button
              type="button"
              class="row-button"
              :class="{ active: reharmIndex === item.index }"
              :aria-expanded="reharmIndex === item.index"
              v-tooltip="t.shell.lists.chords.reharmonizeTitle"
              :aria-label="
                formatMessage(t.shell.lists.chords.reharmonize, { name: chordName(item.chord) })
              "
              @click="toggleReharm(item.index)"
            >
              <ListIcon name="reharm" />
            </button>
            <button
              type="button"
              class="row-button"
              :aria-label="
                formatMessage(t.shell.lists.chords.delete, { name: chordName(item.chord) })
              "
              @click="onDelete(item.index)"
            >
              <ListIcon name="delete" />
            </button>
          </td>
        </tr>
        <tr v-if="reharmIndex === item.index" class="reharm-row">
          <td colspan="9">
            <p v-if="!keySet" class="reharm-empty">{{ t.shell.lists.chords.reharmKeyRequired }}</p>
            <div v-else-if="reharmCandidates.length > 0" class="reharm-palette">
              <button
                v-for="candidate in reharmCandidates"
                :key="`${candidate.kind}:${candidate.symbol.rootPc}:${candidate.symbol.quality}`"
                type="button"
                class="reharm-option"
                :aria-label="
                  formatMessage(t.shell.lists.chords.applyReharm, {
                    name: chordName(candidate.symbol),
                  })
                "
                @click="applyReharm(candidate)"
              >
                <span class="reharm-name">{{ chordName(candidate.symbol) }}</span>
                <span v-if="candidate.roman" class="reharm-roman">{{ candidate.roman }}</span>
                <span class="reharm-kind">{{ t.shell.lists.chords.reharmKinds[candidate.kind] }}</span>
              </button>
            </div>
            <p v-else class="reharm-empty">{{ t.shell.lists.chords.reharmNone }}</p>
          </td>
        </tr>
        </template>
        </template>
      </tbody>
    </table>
    <div v-if="selectedChords.length > 0" class="selection-toolbar">
      <p class="selection-summary">
        {{ formatMessage(t.shell.lists.chords.selectionSummary, { count: selectedChords.length }) }}
      </p>
      <ProgressionPresetPicker
        v-model:style="rangeStyle"
        v-model:preset-id="rangePreset"
        :key-scale="effectiveKeyScale(store.scaleHighlight)"
      />
      <label class="number-field">
        <span class="field-label">{{ t.shell.lists.chords.selectionBars }}</span>
        <input v-model.number="rangeBars" type="number" min="1" max="64" step="1" />
      </label>
      <div class="selection-actions">
        <button type="button" @click="clearSelection">{{ t.shell.lists.chords.clearSelection }}</button>
        <button type="button" class="primary" @click="applyToSelection">
          {{ t.shell.lists.chords.applySelection }}
        </button>
      </div>
    </div>
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
        :disabled="isEstimating"
        v-tooltip="t.shell.lists.chords.estimateFromNotesTitle"
        @click="estimateProgression"
      >
        {{ t.shell.lists.chords.estimateFromNotes }}
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

.chord-row.tentative {
  opacity: 0.55;
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

.cell-roman {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cell-position-wrap {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.repeat-badge {
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.chord-row.in-group {
  border-left: 2px solid var(--border-strong);
}

.group-header-row > td {
  padding: var(--sp-1) var(--sp-3);
  border-top: 1px solid var(--border);
}

.group-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.group-toggle:hover {
  color: var(--text-1);
}

.group-chevron {
  transition: transform var(--dur-1) var(--ease-out);
}

.group-chevron.is-open {
  transform: rotate(90deg);
}

.group-partial {
  color: var(--text-3);
  font-weight: var(--fw-normal);
}

.list-actions {
  flex-wrap: wrap;
}

.clear-button:hover:not(:disabled) {
  color: var(--danger-text);
}

.row-button.active {
  color: var(--accent-text);
}

.reharm-row > td {
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
}

.reharm-palette {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.reharm-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  min-width: 6rem;
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  cursor: pointer;
  text-align: left;
}

.reharm-option:hover {
  border-color: var(--accent);
  background: var(--surface-3);
}

.reharm-name {
  color: var(--text-1);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.reharm-roman {
  color: var(--text-2);
  font-size: var(--fs-sm);
}

.reharm-kind {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.reharm-empty {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
}

.cell-checkbox {
  width: 1.4rem;
}

.chord-row.selected {
  background: var(--accent-soft);
}

.group-select {
  margin-left: var(--sp-3);
  padding: 0;
  background: none;
  border: none;
  box-shadow: none;
  color: var(--accent);
  font-size: var(--fs-xs);
  cursor: pointer;
}

.group-select:hover {
  text-decoration: underline;
}

.selection-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sp-5);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface-2);
  border-radius: var(--radius-md);
}

.selection-summary {
  flex-basis: 100%;
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.number-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.number-field input {
  width: 6rem;
  box-sizing: border-box;
}

.selection-actions {
  display: flex;
  gap: var(--sp-3);
}
</style>
