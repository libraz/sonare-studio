import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChordListEditor from '@/components/lists/ChordListEditor.vue';
import { chordCombinationKey } from '@/compose/chord-quality';
import { CHORD_QUALITY_CHOICES, formatChordName, sanitizeChordSymbols } from '@/project/chords';
import { addNote, clearHistory, setProjectChords } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { editorSymbolForQuality, LIBCANTUS_QUALITIES } from './helpers/chord-qualities';
import { chooseOption, openOptionLabels } from './helpers/select-menu';

/**
 * The chord-track quality picker offers a curated subset of the chords the app
 * can hold, so a chord it did not author -- detected from a clip, imported,
 * reharmonized -- routinely matches no entry. These tests pin that such a chord
 * still reads as itself on the trigger, and that the combination key a row is
 * matched on does not depend on how the chord's tone lists happen to be spelled.
 */

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A row's quality trigger value node (the row's selects run root / quality / bass). */
function qualityValue(wrapper: VueWrapper, row = 0) {
  return wrapper.findAll('tbody tr')[row].findAll('.cell-select .select-value')[1];
}

/** The label showing on a row's quality trigger. */
function qualityLabel(wrapper: VueWrapper, row = 0): string {
  return qualityValue(wrapper, row).text();
}

/** The chord name printed in a row's Name column. */
function nameLabel(wrapper: VueWrapper, row = 0): string {
  return wrapper.findAll('tbody tr')[row].find('.cell-name').text();
}

/** Opens a row's quality picker (the second select in the row). */
async function openQualityMenu(wrapper: VueWrapper, row = 0): Promise<void> {
  await wrapper
    .findAll('tbody tr')
    [row].findAll('.cell-select .select-trigger')[1]
    .trigger('click');
  await flushPromises();
}

describe('chordCombinationKey', () => {
  it('keys a compound, duplicated or unsorted tone list as its normalized form', () => {
    expect(chordCombinationKey(6, [14])).toBe(chordCombinationKey(6, [2]));
    expect(chordCombinationKey(1, [11, 2])).toBe(chordCombinationKey(1, [2, 11, 2]));
    expect(chordCombinationKey(1, [11, 2])).toBe('1:2,11');
    expect(chordCombinationKey(4, [], [7, 4, 7])).toBe('4:/4,7');
  });

  it('drops root-valued and already-intrinsic extensions', () => {
    expect(chordCombinationKey(0, [12])).toBe('0:');
    expect(chordCombinationKey(4, [7, 10])).toBe('4:');
  });

  it('drops omissions naming the root or a tone the quality does not sound', () => {
    expect(chordCombinationKey(0, undefined, [0])).toBe('0:');
    expect(chordCombinationKey(0, undefined, [6])).toBe('0:');
    expect(chordCombinationKey(0, undefined, [4])).toBe('0:/4');
  });

  // The libcantus bridge emits some qualities with unsorted extensions, and a
  // chord only passes through sanitizeChordSymbols on its way into the project.
  // Both spellings have to key alike, or the picker would match one and not the
  // other.
  it.each(LIBCANTUS_QUALITIES)('keys %s the same before and after sanitizing', (quality) => {
    const raw = editorSymbolForQuality(quality);
    const [sanitized] = sanitizeChordSymbols([raw]);
    expect(chordCombinationKey(raw.quality, raw.extensions, raw.omissions)).toBe(
      chordCombinationKey(sanitized.quality, sanitized.extensions, sanitized.omissions),
    );
  });
});

describe('chord quality picker', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    await store.init();
  });

  // Every quality the app can receive has to be showable. A chord the curated
  // list expresses keeps that entry's label -- the quality column describes a
  // quality, the Name column names a chord, and they speak different
  // vocabularies. A chord the list cannot express falls back to naming itself.
  it.each(LIBCANTUS_QUALITIES)('shows a %s chord rather than reading unset', (quality) => {
    const symbol = editorSymbolForQuality(quality);
    setProjectChords([symbol]);
    const wrapper = mount(ChordListEditor);
    const curated = CHORD_QUALITY_CHOICES.find(
      (choice) =>
        chordCombinationKey(choice.quality, choice.extensions, choice.omissions) ===
        chordCombinationKey(symbol.quality, symbol.extensions, symbol.omissions),
    );

    expect(qualityValue(wrapper).classes()).not.toContain('is-placeholder');
    expect(qualityLabel(wrapper)).toBe(curated?.label ?? formatChordName(symbol));
    if (curated === undefined) expect(qualityLabel(wrapper)).toBe(nameLabel(wrapper));
    wrapper.unmount();
  });

  it('leads the menu with the chord itself only when no curated entry matches', async () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 6, extensions: [2] }, // Cm9
      { startPpq: 4, endPpq: 8, rootPc: 0, quality: 0 }, // C
    ]);
    const wrapper = mount(ChordListEditor);
    const curated = CHORD_QUALITY_CHOICES.map((choice) => choice.label);

    await openQualityMenu(wrapper);
    expect(openOptionLabels()).toEqual(['Cm9', ...curated]);
    await chooseOption('Cm9');

    // Picking the chord's own entry is a no-op: it is already the row's chord.
    expect(store.chords[0]).toMatchObject({ quality: 6, extensions: [2] });

    await openQualityMenu(wrapper, 1);
    expect(openOptionLabels()).toEqual(curated);
    wrapper.unmount();
  });

  it('still commits a curated entry over a chord it cannot express', async () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 6, extensions: [2] }]);
    const wrapper = mount(ChordListEditor);
    await openQualityMenu(wrapper);
    await chooseOption('Minor 7');

    expect(store.chords[0]).toMatchObject({ quality: 6 });
    expect(store.chords[0].extensions).toBeUndefined();
    expect(qualityLabel(wrapper)).toBe('Minor 7');
    wrapper.unmount();
  });

  // Detection reads harmony straight off the notes, so it produces chords well
  // outside the curated list; the row it writes has to read as that chord.
  it('shows a detected extended chord rather than an unset picker', async () => {
    for (const pitch of [60, 63, 67, 70, 74]) {
      addNote({ pitch, startPpq: 0, durationPpq: 4 });
    }
    const wrapper = mount(ChordListEditor);
    const detect = wrapper.findAll('button').find((b) => b.text() === 'Detect from clip');
    await detect?.trigger('click');
    await flushPromises();

    expect(store.chords[0]).toMatchObject({ rootPc: 0, quality: 6, extensions: [2] });
    expect(nameLabel(wrapper)).toBe('Cm9');
    expect(qualityValue(wrapper).classes()).not.toContain('is-placeholder');
    expect(qualityLabel(wrapper)).toBe('Cm9');
    wrapper.unmount();
  });
});
