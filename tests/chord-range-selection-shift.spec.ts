import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { EditorChordSymbol } from '@/project/chords';
import { useProjectStore } from '@/project/store';
import { useChordRangeSelection } from '@/ui/lists/use-chord-range-selection';

vi.mock('@/project/commands', () => ({ generateProgressionCommand: vi.fn() }));

const chord = (startPpq: number, rootPc: number): EditorChordSymbol =>
  ({ startPpq, endPpq: startPpq + 4, rootPc, quality: 0 }) as EditorChordSymbol;

describe('chord range selection', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.chords = [chord(0, 0), chord(4, 5), chord(8, 7)];
  });

  it('drops a selection whose rows moved when a chord is removed', async () => {
    const selection = useChordRangeSelection(() => undefined);
    selection.onSelectClick(1, new MouseEvent('click'));
    expect(selection.selectionRangePpq.value).toEqual({ startPpq: 4, endPpq: 8 });

    store.chords = [chord(4, 5), chord(8, 7)];
    await nextTick();

    expect(selection.selectedChords.value).toEqual([]);
    expect(selection.selectionRangePpq.value).toBeNull();
  });

  it('keeps the selection when a selected chord is respelled in place', async () => {
    const selection = useChordRangeSelection(() => undefined);
    selection.onSelectClick(1, new MouseEvent('click'));

    store.chords = [chord(0, 0), chord(4, 2), chord(8, 7)];
    await nextTick();

    expect(selection.selectionRangePpq.value).toEqual({ startPpq: 4, endPpq: 8 });
  });
});
