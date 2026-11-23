/**
 * Range selection for the chord list editor: the picked chord indices, the
 * span they cover and the style/preset/bars used to regenerate that span.
 */

import type { ProgStyle } from '@libraz/libcantus';
import { computed, ref, watch } from 'vue';
import { fractionalBarsBetween } from '@/components/lists/bar-beat';
import type { PatternGroup } from '@/compose/progression-groups';
import { maxOf, minOf } from '@/lib/math';
import type { EditorChordSymbol } from '@/project/chords';
import { generateProgressionCommand } from '@/project/commands';
import { partSeed } from '@/project/generation';
import { useProjectStore } from '@/project/store';

/**
 * Creates the range-selection state for the chord list editor.
 * `onRegenerate` runs just before a range is regenerated.
 */
export function useChordRangeSelection(onRegenerate: () => void) {
  const store = useProjectStore();

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

  // The selection holds row indices, so a chord added or removed elsewhere would
  // shift it onto other rows; respelling a chord in place keeps the rows.
  watch(
    () => store.chords.map((chord) => `${chord.startPpq}:${chord.endPpq}`).join('|'),
    clearSelection,
  );

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
    const startPpq = minOf(selectedChords.value.map((c) => c.startPpq));
    const endPpq = maxOf(selectedChords.value.map((c) => c.endPpq));
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
    onRegenerate();
    generateProgressionCommand({
      style: rangeStyle.value,
      presetId: rangePreset.value || undefined,
      bars: Math.max(1, Math.round(rangeBars.value)),
      // Addressed by where the range starts, so regenerating one range does not
      // hand it the material another range already got.
      seed: partSeed(store.generationSeed, 'progression', 'range', range.startPpq),
      mode: 'range',
      startPpq: range.startPpq,
    });
    clearSelection();
  }

  return {
    selectedIndices,
    selectedChords,
    selectionRangePpq,
    rangeStyle,
    rangePreset,
    rangeBars,
    onSelectClick,
    selectGroup,
    clearSelection,
    applyToSelection,
  };
}
