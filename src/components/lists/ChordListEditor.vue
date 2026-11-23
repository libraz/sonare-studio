<script setup lang="ts">
import { chordToRoman } from '@libraz/libcantus';
import { computed, ref } from 'vue';
import ProgressionPresetPicker from '@/components/compose/ProgressionPresetPicker.vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import EmptyState from '@/components/shell/EmptyState.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { editorChordToChord } from '@/compose/chord-io';
import { chordCombinationKey } from '@/compose/chord-quality';
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
  insertSecondaryDominantBefore,
  reharmonizeChord,
  setProjectChords,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { timeSignatureAt } from '@/project/time-signature';
import { clipKind } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { useChordDetection } from '@/ui/lists/use-chord-detection';
import { useChordRangeSelection } from '@/ui/lists/use-chord-range-selection';
import { barLengthPpq, formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';

/** One entry of the quality picker: its combination key and its visible label. */
interface QualityOption {
  value: string;
  label: string;
}

/** Chord-quality options offered on every row. */
const QUALITY_OPTIONS: ReadonlyArray<QualityOption> = CHORD_QUALITY_CHOICES.map((choice) => ({
  value: qualityChoiceKey(choice),
  label: choice.label,
}));

/** The combination keys the curated option list can express. */
const QUALITY_OPTION_KEYS = new Set(QUALITY_OPTIONS.map((option) => option.value));

/**
 * Stable select-menu key for a quality with its color tones and the intrinsic
 * tones it leaves silent. The omissions belong in the key: a power chord and a
 * plain major share an ordinal and differ only by the third one of them drops.
 * Both lists are normalized, so a chord that reaches the editor unsanitized keys
 * the same as the option that would produce it.
 */
function qualityChoiceKey(choice: {
  quality: number;
  extensions?: ReadonlyArray<number>;
  omissions?: ReadonlyArray<number>;
}): string {
  return chordCombinationKey(choice.quality, choice.extensions, choice.omissions);
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
const {
  isDetecting,
  isEstimating,
  detectKind,
  clearEstimate,
  isTentative,
  estimateProgression,
  detectFromClip,
} = useChordDetection(errorMessage);
const {
  selectedIndices,
  selectedChords,
  rangeStyle,
  rangePreset,
  rangeBars,
  onSelectClick,
  selectGroup,
  clearSelection,
  applyToSelection,
} = useChordRangeSelection(clearEstimate);

const listReasons = computed(() => t.value.shell.lists.reasons);
const detectBlocked = computed(() =>
  firstBlock(
    [detectKind.value === null, listReasons.value.noDetectableClip],
    [isDetecting.value, t.value.reasons.busy],
  ),
);
/** The estimate reads notes across every track, so it needs at least one MIDI clip. */
const estimateBlocked = computed(() =>
  firstBlock(
    [!store.clips.some((clip) => clipKind(clip) === 'midi'), t.value.reasons.noMidiClipInProject],
    [isEstimating.value, t.value.reasons.busy],
  ),
);
const clearBlocked = computed(() =>
  firstBlock([store.chords.length === 0, listReasons.value.noChordsToClear]),
);

/** Bar length in PPQ at a position, from the active time signature. */
function barLengthAt(ppq: number): number {
  return barLengthPpq(timeSignatureAt(store.timeSignatures, ppq));
}

/** Commits a chord list mutated at one index (drop the entry when null). */
function commitAt(index: number, next: EditorChordSymbol | null): void {
  clearEstimate();
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

function onQualityChange(index: number, chord: EditorChordSymbol, value: string): void {
  const choice = CHORD_QUALITY_CHOICES.find((candidate) => qualityChoiceKey(candidate) === value);
  if (choice === undefined) return;
  const next: EditorChordSymbol = { ...chord, quality: choice.quality };
  if (choice.extensions === undefined || choice.extensions.length === 0) delete next.extensions;
  else next.extensions = [...choice.extensions];
  if (choice.omissions === undefined || choice.omissions.length === 0) delete next.omissions;
  else next.omissions = [...choice.omissions];
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

function insertDominantBlocked(chord: EditorChordSymbol): string | null {
  return firstBlock([!canTonicizeWithSecondaryDominant(chord), listReasons.value.notTonicizable]);
}

/** Inserts the secondary dominant of a chord before it (see {@link insertSecondaryDominantBefore}). */
function onInsertDominant(index: number): void {
  if (!canTonicizeWithSecondaryDominant(store.chords[index])) return;
  clearEstimate();
  reharmIndex.value = null;
  const inserted = insertSecondaryDominantBefore(index);
  errorMessage.value = inserted ? '' : t.value.shell.lists.chords.insertDominantTooShort;
}

/** Whether a key is set; roman numerals and reharmonization need one to be meaningful. */
const keySet = computed(() => store.scaleHighlight.enabled);
const chordKeyFifths = computed(() => keyFifthsForScaleHighlight(store.scaleHighlight));
/** Substitutes are chosen relative to the key, so the palette needs the key highlight on. */
const reharmBlocked = computed(() =>
  firstBlock([!keySet.value, listReasons.value.keyHighlightOff]),
);

/** Formats symbols with the same accidental convention as the score. */
function chordName(chord: EditorChordSymbol): string {
  return formatChordName(chord, chordKeyFifths.value, noteNameSystem.value);
}

/**
 * Quality options per chord row. The curated list is a deliberate subset of a
 * chord's unbounded quality space, so a detected or imported chord often matches
 * no entry; such a row leads with a one-off entry naming its own chord, so the
 * picker reads the chord the row holds rather than looking unset, and choosing
 * that entry is a no-op. Rows whose chord is in the list share the curated
 * array, so their menus see the same options across edits.
 */
const qualityOptionsByIndex = computed<ReadonlyArray<ReadonlyArray<QualityOption>>>(() =>
  store.chords.map((chord) => {
    const key = qualityChoiceKey(chord);
    if (QUALITY_OPTION_KEYS.has(key)) return QUALITY_OPTIONS;
    return [{ value: key, label: chordName(chord) }, ...QUALITY_OPTIONS];
  }),
);

/**
 * Roman-numeral degree label for a chord in the prevailing key, or blank when no
 * key is set — a degree read against the silent C-major fallback would be wrong.
 */
function romanFor(chord: EditorChordSymbol): string {
  if (!keySet.value) return '';
  return chordToRoman(editorChordToChord(chord), effectiveKeyScale(store.scaleHighlight), {
    applied: true,
  });
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
  /** Display name, resolved once per rebuild instead of at every use in the row. */
  name: string;
  roman: string;
  position: string;
  tentative: boolean;
  qualityKey: string;
  dominantTooltip: string;
  dominantBlocked: string | null;
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
  const chordRow = (
    index: number,
    groupStartIndex: number | null,
    repeatLabel: string | null,
  ): ChordRowItem => {
    const chord = store.chords[index];
    return {
      kind: 'chord',
      index,
      chord,
      groupStartIndex,
      repeatLabel,
      name: chordName(chord),
      roman: romanFor(chord),
      position: positionText(chord),
      tentative: isTentative(chord),
      qualityKey: qualityChoiceKey(chord),
      dominantTooltip: insertDominantTooltip(chord),
      dominantBlocked: insertDominantBlocked(chord),
    };
  };
  const groupByStart = new Map(patternGroups.value.map((group) => [group.startIndex, group]));
  const items: RowItem[] = [];
  let i = 0;
  while (i < store.chords.length) {
    const group = groupByStart.get(i);
    if (!group) {
      items.push(chordRow(i, null, null));
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
      items.push(chordRow(i + k, group.startIndex, repeatLabel));
    }
    i += group.length;
  }
  return items;
});

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
  clearEstimate();
  const ppq = Math.max(0, props.positionPpq?.() ?? 0);
  const length = barLengthAt(ppq);
  setProjectChords([
    ...store.chords,
    { startPpq: ppq, endPpq: ppq + length, rootPc: 0, quality: 0 },
  ]);
}

function clearAll(): void {
  errorMessage.value = '';
  clearEstimate();
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
            tentative: item.tentative,
            'in-group': item.groupStartIndex !== null,
            selected: selectedIndices.has(item.index),
          }"
          v-tooltip="item.tentative ? t.shell.lists.chords.tentativeTitle : undefined"
        >
          <td class="cell-checkbox">
            <input
              type="checkbox"
              :checked="selectedIndices.has(item.index)"
              :aria-label="
                formatMessage(t.shell.lists.chords.selectRow, { name: item.name })
              "
              @click="onSelectClick(item.index, $event)"
            />
          </td>
          <td class="cell-seek">
            <button
              type="button"
              class="row-button"
              v-tooltip="t.shell.lists.common.seekTitle"
              :aria-label="
                formatMessage(t.shell.lists.chords.seekTo, { name: item.name })
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
                :value="item.position"
                class="cell-input cell-position"
                type="text"
                inputmode="decimal"
                :aria-label="
                  formatMessage(t.shell.lists.chords.positionOf, { name: item.name })
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
              :model-value="item.qualityKey"
              class="cell-input cell-select"
              size="sm"
              :options="qualityOptionsByIndex[item.index] ?? QUALITY_OPTIONS"
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
          <td class="cell-name">{{ item.name }}</td>
          <td class="cell-roman">{{ item.roman }}</td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              v-tooltip="{
                text: item.dominantTooltip,
                reason: item.dominantBlocked,
              }"
              :aria-label="
                formatMessage(t.shell.lists.chords.insertDominant, { name: item.name })
              "
              :disabled="!!item.dominantBlocked"
              @click="onInsertDominant(item.index)"
            >
              <ListIcon name="insertDominant" />
            </button>
            <button
              type="button"
              class="row-button"
              :class="{ active: reharmIndex === item.index }"
              :aria-expanded="reharmIndex === item.index"
              v-tooltip="{ text: t.shell.lists.chords.reharmonizeTitle, reason: reharmBlocked }"
              :disabled="!!reharmBlocked && reharmIndex !== item.index"
              :aria-label="
                formatMessage(t.shell.lists.chords.reharmonize, { name: item.name })
              "
              @click="toggleReharm(item.index)"
            >
              <ListIcon name="reharm" />
            </button>
            <button
              type="button"
              class="row-button"
              v-tooltip="t.shell.lists.common.deleteTitle"
              :aria-label="
                formatMessage(t.shell.lists.chords.delete, { name: item.name })
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
        :disabled="!!detectBlocked"
        v-tooltip="{ text: t.shell.lists.chords.detectFromClipTitle, reason: detectBlocked }"
        @click="detectFromClip"
      >
        {{ t.shell.lists.chords.detectFromClip }}
      </button>
      <button
        type="button"
        :disabled="!!estimateBlocked"
        v-tooltip="{ text: t.shell.lists.chords.estimateFromNotesTitle, reason: estimateBlocked }"
        @click="estimateProgression"
      >
        {{ t.shell.lists.chords.estimateFromNotes }}
      </button>
      <button
        type="button"
        class="clear-button"
        :disabled="!!clearBlocked"
        v-tooltip="{ text: t.shell.lists.chords.clearTitle, reason: clearBlocked }"
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

/* The candidate palette drops in under its chord row. */
.reharm-row > td > * {
  animation: view-enter var(--dur-2) var(--ease-out);
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
  /* Opacity only: the preset picker inside anchors floating menus. */
  animation: fade-once var(--dur-2) var(--ease-out);
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
